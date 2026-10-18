// One call = validate variables, send with the cached session, classify the outcome (SPEC §10).
//
// | condition                                              | kind                                 |
// | variables fail Zod                                     | input, nothing sent                  |
// | transport error, 5xx, 429 (after retries)              | network                              |
// | GraphQL data null + server error code (after retries)  | network (INTERNAL*, SERVICE_UNAVAILABLE) |
// | login: 401/403/redirect to a login host                | sign in again, retry; still → drift auth |
// | login: sign-in doesn't complete                        | session                              |
// | none: 401/403                                          | rerun bootstrap, retry; still → drift auth |
// | 404/405                                                | drift http (code = status)           |
// | GraphQL validation error                               | drift graphql                        |
// | 400/422 or GraphQL input error                         | drift input-rejected                 |
// | other non-2xx                                          | drift http                           |
// | response fails Zod                                     | drift zod (path, Zod issue code)     |
// | anything else thrown                                   | bug (caught in main)                 |
import { existsSync } from "node:fs";
import type { Call } from "./command";
import { ContractError, DryRun, Failure, ProfileUnavailable, type Account, type DiffEntry, type Surface } from "./envelope";
import { driftFingerprint, fieldPath, zodDiff, type BreakType } from "./fingerprint";
import type { Operation } from "./operation";
import { loadSession, saveSession, stateDir, type Session } from "./session";
import { decodeJwt, effectiveOrigin, isLoginHost, nonInteractive, type Env, type Fetch, type Site, type SiteCtx } from "./site";

/** `fromProfile`: seed the sign-in from another Chrome profile's cookies (`login --from-profile`). */
export type SignInOptions = { fromProfile?: string };

export type Deps = {
  fetch: Fetch;
  env: Env;
  /**
   * Opens Chrome on the login profile and returns the captured authorization + cookie headers,
   * or null when sign-in didn't complete (headless: the profile is logged out).
   */
  login(headless: boolean, options?: SignInOptions): Promise<Record<string, string> | null>;
  sleep(ms: number): Promise<void>;
  /** Delay before each retry of a network failure; its length is the retry count. */
  retryDelays: number[];
  note(message: string): void;
};

export type ClientOptions = {
  /** --confirm: write Operations are sent instead of producing a dry run. */
  confirm?: boolean;
  /** A session to use as-is (postLogin and bootstrap run on the session being built). */
  session?: Session;
  /** false: an auth failure is Drift at once, with no sign-in or bootstrap rerun. */
  reauth?: boolean;
  /**
   * "mcp": a tool call of the MCP server. It never opens a headed sign-in (no saved session: session
   * at once, without Chrome; the headless refresh failed: session), and its messages name tool
   * arguments instead of CLI flags.
   */
  surface?: Surface;
};

export type Request = { method: string; url: string; headers: Record<string, string>; body?: string };
type Response_ = { status: number; body: unknown; loginRedirect?: boolean; offsite?: boolean };

export function buildRequest(op: Operation, vars: unknown, base: { origin: string; graphqlPath?: string; headers: Record<string, string> }): Request {
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [k, v] of Object.entries(base.headers)) headers[k.toLowerCase()] = v;
  if (op.graphql !== undefined) {
    if (!base.graphqlPath) throw new ContractError(`site.graphqlPath is not set, but ${op.name} is a GraphQL Operation`);
    headers["content-type"] = "application/json";
    return {
      method: "POST",
      url: base.origin + base.graphqlPath,
      headers,
      body: JSON.stringify({ operationName: op.name, query: op.graphql, variables: vars ?? {} }),
    };
  }
  if (!op.rest) throw new ContractError(`${op.name} declares neither graphql nor rest`);
  const v = (vars ?? {}) as Record<string, unknown>;
  const path = op.rest.path.replace(/(?<=\/):([A-Za-z_]\w*)/g, (_, key: string) => {
    const value = v[key];
    if (value === undefined || value === null) throw new ContractError(`${op.name}: no variable for :${key}`);
    return encodeURIComponent(String(value));
  });
  const url = new URL(base.origin + path);
  for (const [k, val] of Object.entries(op.rest.query?.(vars) ?? {})) {
    if (val !== undefined && val !== null) url.searchParams.append(k, String(val));
  }
  let body: string | undefined;
  if (op.rest.body) {
    const value = op.rest.body(vars);
    if (op.rest.bodyType === "form") {
      body = formBody(op.name, value);
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else {
      body = JSON.stringify(value);
      headers["content-type"] = "application/json";
    }
  }
  return { method: op.rest.method, url: url.toString(), headers, body };
}

/** A form-urlencoded body from a flat object: arrays repeat their key, undefined and null are left out. */
function formBody(name: string, value: unknown): string {
  if (value instanceof URLSearchParams) return value.toString();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractError(`${name}: a form body (bodyType "form") must be an object of fields`);
  const form = new URLSearchParams();
  const add = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (typeof v === "object") throw new ContractError(`${name}: form field ${key} is an object; a form body (bodyType "form") holds only strings, numbers, booleans and arrays of them`);
    form.append(key, String(v));
  };
  for (const [key, v] of Object.entries(value)) {
    if (Array.isArray(v)) for (const item of v) add(key, item);
    else add(key, v);
  }
  return form.toString();
}

async function readBody(r: Response): Promise<unknown> {
  const text = await r.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type GqlError = { message?: unknown; extensions?: { code?: unknown } };

const VALIDATION_CODES = new Set(["GRAPHQL_VALIDATION_FAILED", "GRAPHQL_PARSE_FAILED", "VALIDATION_ERROR", "ValidationError", "InvalidSyntax"]);
const VALIDATION_MESSAGE = /^(Cannot query field|Unknown argument|Unknown type|Unknown fragment|Unknown operation|Unknown directive|Syntax Error|Variable "\$\w+" of (required )?type|Field "[^"]+" argument "[^"]+" of type|Field "[^"]+" of type "[^"]+" must have a selection|Field "[^"]+" must not have a selection|Argument "[^"]+" has invalid value)/;
const INPUT_CODES = new Set(["BAD_USER_INPUT", "BAD_REQUEST"]);

function gqlErrors(body: unknown): GqlError[] {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  return Array.isArray(errors) ? errors.filter((e) => e && typeof e === "object") : [];
}

const gqlCode = (e: GqlError) => (typeof e.extensions?.code === "string" ? e.extensions.code : "");
const gqlMessage = (e: GqlError) => (typeof e.message === "string" ? e.message : "");

/** Schema coordinates named by a validation message ("Type.field"), never values. */
function gqlPath(message: string): string {
  const field = /^Cannot query field "([^"]+)" on type "([^"]+)"/.exec(message);
  if (field) return `${field[2]}.${field[1]}`;
  const arg = /^Unknown argument "([^"]+)" on field "([^"]+)"/.exec(message);
  if (arg) return `${arg[2]}(${arg[1]})`;
  return "";
}

const SERVER_CODES = new Set(["INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE"]);

/**
 * A GraphQL answer (often HTTP 200) whose `data` is null and whose errors carry a server-side
 * code: the site failed, not the Contract, so it is network like a 5xx. Returns that code.
 */
export function gqlServerError(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const data = (body as { data?: unknown }).data;
  if (data !== null && data !== undefined) return undefined;
  const codes = gqlErrors(body).map(gqlCode);
  return codes.find((c) => SERVER_CODES.has(c) || c.startsWith("INTERNAL"));
}

const isValidation = (e: GqlError) => VALIDATION_CODES.has(gqlCode(e)) || VALIDATION_MESSAGE.test(gqlMessage(e));

export class Client {
  readonly site: Site;
  readonly deps: Deps;
  readonly confirm: boolean;
  /** True once this run signed in or bootstrapped: a further 401/403 is Drift. */
  fresh = false;
  private session: Session | null;
  private readonly reauthAllowed: boolean;
  private readonly surface: Surface;
  private persisted: boolean;
  /** The account list fetched in this run, labels included. Only the ids are saved (SPEC §7). */
  private fetchedAccounts?: Account[];

  constructor(site: Site, deps: Deps, options: ClientOptions = {}) {
    this.site = site;
    this.deps = deps;
    this.confirm = options.confirm ?? false;
    this.session = options.session ?? null;
    this.persisted = !options.session;
    this.reauthAllowed = options.reauth ?? true;
    this.surface = options.surface ?? "cli";
    if (options.reauth === false) this.fresh = true;
  }

  get origin() { return effectiveOrigin(this.site, this.deps.env); }
  get dir() { return stateDir(this.site, this.deps.env); }

  /** The current session without signing in or bootstrapping. */
  peek(): Session | null {
    if (!this.session && this.persisted) this.session = loadSession(this.dir);
    return this.session;
  }

  async ensureSession(): Promise<Session> {
    const cached = this.peek();
    if (cached) return cached;
    if (this.site.auth === "login" && this.surface === "mcp") {
      // Never signed in: nothing for a headless refresh to find, so don't spend Chrome launches on it.
      throw new Failure("session", `There is no sign-in to ${this.site.origin} yet.`);
    }
    if (this.site.auth === "login") return this.signInOrFail();
    if (this.site.bootstrap && this.reauthAllowed) return this.bootstrap();
    this.session = { headers: {}, ids: {}, savedAt: new Date().toISOString() };
    return this.session;
  }

  /** A context for site hooks. `live`: calls go through this client (with reauth); otherwise through a fixed session. */
  siteCtx(session: Session, live: boolean): SiteCtx {
    const caller = live ? this : new Client(this.site, this.deps, { session, reauth: false, confirm: true });
    return {
      fetch: this.deps.fetch,
      origin: this.origin,
      headers: { ...session.headers },
      ids: { ...session.ids },
      decodeJwt,
      call: caller.call,
    };
  }

  /** Signs in with Chrome, runs postLogin and saves the session. Null if sign-in didn't complete. */
  async signIn(headless: boolean, options?: SignInOptions): Promise<Session | null> {
    const headers = await this.deps.login(headless, options);
    if (!headers) return null;
    const draft: Session = { headers, ids: {}, savedAt: new Date().toISOString() };
    const raw = this.site.login?.postLogin ? await this.site.login.postLogin(this.siteCtx(draft, false)) : {};
    const ids: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw ?? {})) if (v !== undefined && v !== null) ids[k] = String(v);
    this.session = saveSession(this.dir, { headers, ids, ...(options?.fromProfile && { fromProfile: options.fromProfile }) });
    this.persisted = true;
    this.fresh = true;
    return this.session;
  }

  /**
   * The Chrome profile the current sign-in came from with `login --from-profile`, while it still
   * exists; undefined when the CLI's own profile holds the sign-in.
   */
  fromProfile(): string | undefined {
    const dir = this.peek()?.fromProfile;
    return dir && existsSync(dir) ? dir : undefined;
  }

  private async signInOrFail(): Promise<Session> {
    const from = this.fromProfile();
    if (from) {
      // login --from-profile left the CLI's own profile signed out: refresh from the profile it used.
      this.deps.note(`signing in again from ${from}, the profile login --from-profile used (headless, in memory)`);
      const seeded = await this.signIn(true, { fromProfile: from }).catch((e) => {
        if (e instanceof ProfileUnavailable) return null; // that profile is busy (a Capture runs on it)
        throw e;
      });
      if (seeded) return seeded;
    }
    this.deps.note("signing in again from the Chrome profile (headless)");
    const refreshed = await this.signIn(true);
    if (refreshed) return refreshed;
    if (this.surface === "mcp" || nonInteractive(this.deps.env)) {
      // No person waiting at a Chrome window (an MCP tool call, or an agent): fail now instead of waiting for a headed sign-in.
      throw new Failure(
        "session",
        this.surface === "mcp"
          ? `The saved sign-in to ${this.site.origin} has expired, and a tool call does not open Chrome to sign in.`
          : `The saved sign-in to ${this.site.origin} has expired and SITE_CLI_NONINTERACTIVE=1 is set, so Chrome was not opened.`,
      );
    }
    this.deps.note("opening Chrome: sign in there to continue");
    const s = await this.signIn(false);
    if (!s) throw new Failure("session", `Sign-in to ${this.site.origin} did not complete.`);
    return s;
  }

  private async bootstrap(): Promise<Session> {
    const empty: Session = { headers: {}, ids: {}, savedAt: new Date().toISOString() };
    const r = await this.site.bootstrap!(this.siteCtx(empty, false));
    this.session = saveSession(this.dir, { headers: r.headers ?? {}, ids: r.ids ?? {} });
    this.persisted = true;
    this.fresh = true;
    return this.session;
  }

  /** After a 401/403: sign in again (login) or rerun bootstrap (none). False when there is nothing to rerun. */
  private async reauthenticate(): Promise<boolean> {
    if (!this.reauthAllowed || this.fresh) return false;
    if (this.site.auth === "login") {
      await this.signInOrFail();
      return true;
    }
    if (!this.site.bootstrap) return false;
    this.deps.note("rerunning bootstrap");
    await this.bootstrap();
    return true;
  }

  call: Call = (async (op: Operation, vars: unknown) => {
    const v = op.variables.safeParse(vars);
    if (!v.success) {
      const issues = v.error.issues.map((i) => `${fieldPath(i.path, op.variables) || "(variables)"}: ${i.message}`).join("; ");
      throw new Failure("input", `${op.name}: ${issues}`);
    }
    if (op.effect === "write" && !this.confirm) throw new DryRun(op.name, v.data);
    await this.ensureSession();
    let res = await this.send(op, v.data);
    if (this.isAuthFailure(op, res)) {
      if (await this.reauthenticate()) res = await this.send(op, v.data);
      if (this.isAuthFailure(op, res)) {
        const after = this.site.auth === "login" ? "a fresh sign-in" : this.site.bootstrap ? "rerunning bootstrap" : "a call without login";
        throw this.drift(op, "auth", "", res.loginRedirect ? "redirect" : String(res.status), `the site refused the request (HTTP ${res.status}) after ${after}`);
      }
    }
    return this.classify(op, res);
  }) as Call;

  /**
   * The accounts under this login. A list fetched earlier is reused from session.json, ids only:
   * labels come from the site and may name a person, so they live only in this run's memory.
   * `refresh` fetches it again (an --account the cached list lacks, or labels to show the user).
   */
  async listAccounts(refresh = false): Promise<Account[]> {
    if (!this.site.accounts) return [];
    const s = await this.ensureSession();
    if (this.fetchedAccounts) return this.fetchedAccounts;
    if (!refresh && s.accounts) return s.accounts.map((a) => ({ id: String(a.id) }));
    const raw = await this.site.accounts(this.siteCtx(s, true));
    const list: Account[] = raw.map((a) => (typeof a === "string" ? { id: a } : { id: String(a.id), ...(a.label ? { label: String(a.label) } : {}) }));
    this.fetchedAccounts = list;
    const current = this.session ?? s;
    const next = { ...current, accounts: list.map((a) => ({ id: a.id })) };
    // Saved only where a session is saved anyway (login, bootstrap): an auth "none" skill without
    // bootstrap keeps nothing on disk, so a stale list can never lock it.
    this.session = this.persisted && this.savesSession() ? saveSession(this.dir, next) : next;
    return list;
  }

  private savesSession(): boolean {
    return this.site.auth === "login" || (this.site.bootstrap !== undefined && this.reauthAllowed);
  }

  /** The account a command runs for: --account (checked against the list), else the only one. */
  async resolveAccount(requested: string | undefined): Promise<string | undefined> {
    let list = await this.listAccounts();
    if (requested !== undefined) {
      // The cached list may predate an account the user added since: look again before refusing.
      if (list.length > 0 && !list.some((a) => a.id === requested)) list = await this.listAccounts(true);
      if (list.length > 0 && !list.some((a) => a.id === requested)) {
        throw new Failure("input", `${this.surface === "mcp" ? "The account argument" : "--account"} ${requested} is not one of the ${list.length} accounts under this login.`, { accounts: list });
      }
      return requested;
    }
    if (list.length > 1) list = await this.listAccounts(true); // the user picks by label
    if (list.length === 1) return list[0].id;
    if (list.length > 1) throw new Failure("input", `This login has ${list.length} accounts; pass ${this.surface === "mcp" ? "one id as the account argument" : "--account <id>"}.`, { accounts: list });
    return undefined;
  }

  private isAuthFailure(op: Operation, res: Response_): boolean {
    if (res.status === 401 || res.status === 403 || res.loginRedirect) return true;
    return op.graphql !== undefined && gqlErrors(res.body).some((e) => gqlCode(e) === "UNAUTHENTICATED");
  }

  private async send(op: Operation, vars: unknown): Promise<Response_> {
    const session = this.session ?? (await this.ensureSession());
    const req = buildRequest(op, vars, { origin: this.origin, graphqlPath: this.site.graphqlPath, headers: session.headers });
    const delays = this.deps.retryDelays;
    for (let attempt = 0; ; attempt++) {
      let res: Response_ | undefined;
      let transport: string | undefined;
      try {
        res = await this.fetchFollowing(req);
      } catch (e) {
        transport = (e as { code?: string })?.code || (e as Error)?.name || "error";
      }
      const serverError = res && op.graphql !== undefined ? gqlServerError(res.body) : undefined;
      const failed = transport !== undefined || res!.status === 429 || res!.status >= 500 || serverError !== undefined;
      if (!failed) return res!;
      // A write that may have reached the server is never resent; a 429 was refused, so it is safe.
      const retryable = op.effect === "read" || res?.status === 429;
      const why =
        transport !== undefined ? `connection failed: ${transport}` : res!.status < 500 && serverError ? `GraphQL ${serverError}` : `HTTP ${res!.status}`;
      if (!retryable || attempt >= delays.length) {
        throw new Failure("network", `${this.origin} isn't responding (${why}).`);
      }
      this.deps.note(`${op.name}: ${why}, retrying`);
      await this.deps.sleep(delays[attempt]);
    }
  }

  /** fetch with redirects followed by hand: a login-host redirect means logged out, an off-site one is reported. */
  private async fetchFollowing(req: Request): Promise<Response_> {
    let { url, method, body } = req;
    for (let hop = 0; hop < 6; hop++) {
      const r = await this.deps.fetch(url, { method, headers: req.headers, body, redirect: "manual" });
      const location = r.headers.get("location");
      if (r.status < 300 || r.status >= 400 || !location) return { status: r.status, body: await readBody(r) };
      const next = new URL(location, url);
      if (this.site.auth === "login" && isLoginHost(this.site, next.toString())) return { status: r.status, body: undefined, loginRedirect: true };
      if (next.origin !== new URL(url).origin) return { status: r.status, body: undefined, offsite: true };
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
      }
      url = next.toString();
    }
    return { status: 310, body: undefined, offsite: true };
  }

  private classify(op: Operation, res: Response_): unknown {
    const { status, body } = res;
    if (res.offsite) return this.fail(op, "http", "", String(status), `the site now redirects this request elsewhere (HTTP ${status})`);
    if (status === 404 || status === 405) return this.fail(op, "http", "", String(status), `the site no longer serves this request (HTTP ${status})`);
    if (op.graphql !== undefined) {
      const errors = gqlErrors(body);
      const invalid = errors.find(isValidation);
      if (invalid) {
        const path = gqlPath(gqlMessage(invalid));
        const code = gqlCode(invalid);
        return this.fail(op, "graphql", path, code, `the site's GraphQL schema rejected the query${path ? ` at ${path}` : ""}`, [{ path, code: code || "validation" }]);
      }
      const rejected = errors.find((e) => INPUT_CODES.has(gqlCode(e)));
      if (rejected || ((status === 400 || status === 422) && errors.length > 0)) {
        const code = (rejected && gqlCode(rejected)) || String(status);
        return this.fail(op, "input-rejected", "", code, `the site rejected variables that passed the Contract (${code})`);
      }
    }
    if (status === 400 || status === 422) return this.fail(op, "input-rejected", "", String(status), `the site rejected variables that passed the Contract (HTTP ${status})`);
    if (status < 200 || status >= 300) return this.fail(op, "http", "", String(status), `unexpected HTTP ${status}`);
    const parsed = op.response.safeParse(body);
    if (parsed.success) return parsed.data;
    const diff = zodDiff(parsed.error.issues, body, op.response);
    const first = diff[0] ?? { path: "", code: "" };
    return this.fail(op, "zod", first.path, first.code, `the response no longer matches the Contract at ${first.path || "(root)"} (${first.code})`, diff);
  }

  drift(op: Operation, breakType: BreakType, path: string, code: string, why: string, diff: DiffEntry[] = []): Failure {
    return new Failure("drift", `${op.name}: ${why}.`, {
      fingerprint: driftFingerprint(this.site, op.name, breakType, path, code),
      diff,
    });
  }

  private fail(op: Operation, breakType: BreakType, path: string, code: string, why: string, diff: DiffEntry[] = []): never {
    throw this.drift(op, breakType, path, code, why, diff);
  }
}
