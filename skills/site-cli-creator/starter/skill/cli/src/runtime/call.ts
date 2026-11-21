// One call = validate variables, send with the cached session, classify the outcome (SPEC §10).
//
// | condition                                              | kind                                 |
// | variables fail Zod                                     | input, nothing sent                  |
// | site.never forbids the request (any hop, any hook)     | bug (NeverSent), nothing sent        |
// | transport error, 5xx, 429 (after retries)              | network                              |
// | GraphQL data null + server error code (after retries)  | network (INTERNAL*, SERVICE_UNAVAILABLE) |
// | login: 401/403/redirect to a login host                | renew (login.refresh), else sign in again; retry; still → drift auth |
// | login: redirect to a login.paths entry, or a 2xx HTML answer showing login.signedOutSelector | as a login-host redirect; still after the sign-in → session |
// | login: sessionProbe not 2xx (5xx/429 aside), once a run before the first call | sign in again before sending |
// | login: sign-in doesn't complete                        | session                              |
// | none: 401/403                                          | rerun bootstrap, retry; still → drift auth |
// | 404/405                                                | drift http (code = status)           |
// | GraphQL validation error                               | drift graphql                        |
// | 400/422 or GraphQL input error                         | drift input-rejected                 |
// | other non-2xx                                          | drift http                           |
// | html: no HTML where expected, a container gone, bad inline JSON | drift html (path, not_html/no_match/invalid_json) |
// | response (or the values html.fields picked) fails Zod  | drift zod (path, Zod issue code)     |
// | anything else thrown                                   | bug (caught in main)                 |
//
// transport "browser" changes only how a request is sent (deps.fetch from runtime/transport.ts);
// the table holds as it is.
import { existsSync } from "node:fs";
import type { Call } from "./command";
import { ContractError, DryRun, Failure, ProfileUnavailable, type Account, type DiffEntry, type Surface } from "./envelope";
import { extractHtml, htmlMatches, isHtmlType, type HtmlContract } from "./html";
import { driftFingerprint, errorName, fieldPath, zodDiff, type BreakType } from "./fingerprint";
import { withSiteHeaders } from "./browser-headers";
import { forbiddenOperation, forbiddenRequest, guardFetch, NeverSent } from "./never";
import type { Operation } from "./operation";
import { loadSession, saveSession, stateDir, withRenewLock, type Session } from "./session";
import { decodeJwt, effectiveOrigin, isLoginHost, isLoginPath, nonInteractive, onSiteDomain, siteDomain, type Env, type Fetch, type NeverRule, type RefreshConfig, type Site, type SiteCtx } from "./site";

/** `fromProfile`: seed the sign-in from another Chrome profile's cookies (`login --from-profile`). */
export type SignInOptions = {
  fromProfile?: string;
  /**
   * A silent re-sign-in of the same profile (the refresh after an expired session): a sign-in that
   * sees no token exchange keeps login.refresh's record when the ids match. An explicit `login`
   * never does, so after it the computer holds no token it may share with a remote server.
   */
  keepRefresh?: boolean;
};

/**
 * A finished sign-in: the captured authorization + cookie headers, and what login.refresh.keep kept.
 * `exchanged`: a login.refresh.from exchange happened but keep kept nothing from it; that exchange
 * may have rotated the old token, so the old record is not kept either.
 */
export type SignedIn = { headers: Record<string, string>; refresh?: Record<string, string>; exchanged?: boolean };

export type Deps = {
  fetch: Fetch;
  env: Env;
  /**
   * Plain fetch for login.refresh.renew, which must reach the token endpoint without transport
   * "browser"'s Chrome. Defaults to `fetch`.
   */
  plainFetch?: Fetch;
  /** transport "browser": the cookies Chrome holds for the origin, by name (SiteCtx.cookies). */
  cookies?(cookieHeader?: string): Promise<Record<string, string>>;
  /** Opens Chrome on the login profile; null when sign-in didn't complete (headless: the profile is logged out). */
  login(headless: boolean, options?: SignInOptions): Promise<SignedIn | null>;
  /**
   * Closes the Chrome that transport "browser" sends requests from, if one is open; the next request
   * opens it again. Called before anything else opens Chrome on the CLI's profile (a sign-in,
   * `check --writes`), and at the end of a run.
   */
  release?(): Promise<void>;
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
  /**
   * false: an auth failure is Drift at once, with no sign-in or bootstrap rerun. "renew": only
   * login.refresh may renew it, in memory (the Setup page's check of an uploaded Session).
   */
  reauth?: boolean | "renew";
  /**
   * "mcp": a tool call of the MCP server. It never opens a headed sign-in (no saved session: session
   * at once, without Chrome; the headless refresh failed: session), and its messages name tool
   * arguments instead of CLI flags.
   */
  surface?: Surface;
  /** The refusals site.never made, shared with the Clients siteCtx makes for hooks (internal). */
  refusals?: Refusals;
};

/** How many requests site.never refused in this run, and the last one: a hook that catches one still fails with it. */
type Refusals = { count: number; last?: NeverSent };

export type Request = { method: string; url: string; headers: Record<string, string>; body?: string };
/**
 * `bytes` and `contentType`: the raw answer, for an HTML Operation, which decodes its page by the page's own charset
 * (`decodeBody`) and reads an HTML text that happens to parse as JSON as HTML.
 * `blocked`: the bot protection that refused the request (blockSignal), when one did.
 */
type Response_ = { status: number; body: unknown; bytes?: Uint8Array; contentType?: string; loginRedirect?: boolean; signedOut?: "path" | "selector"; offsite?: boolean; blocked?: string };

/** What a browser asks for when it loads a page. */
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** The headers an Operation's request goes with: accept, then the session's, then what the Operation fixes. */
function requestHeaders(op: Operation, session: Record<string, string>, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [k, v] of Object.entries(session)) headers[k.toLowerCase()] = v;
  // An HTML Operation asks for the page; one whose HTML comes inside JSON (html.from) asks for JSON.
  if (op.html && !op.html.from) headers.accept = HTML_ACCEPT;
  if (contentType !== undefined) headers["content-type"] = contentType;
  return headers;
}

export function buildRequest(op: Operation, vars: unknown, base: { origin: string; graphqlPath?: string; headers: Record<string, string> }): Request {
  const headers = requestHeaders(op, base.headers);
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
    for (const item of Array.isArray(val) ? val : [val]) {
      if (item !== undefined && item !== null) url.searchParams.append(k, String(item));
    }
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

/** A request built without the session's headers, with them added as buildRequest adds them (requestHeaders). */
function withSessionHeaders(op: Operation, req: Request, session: Record<string, string>): Request {
  return { ...req, headers: requestHeaders(op, session, req.headers["content-type"]) };
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

/** An answer's text as JSON when it parses, else the text; undefined when empty. */
function parsedBody(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const BOMS: [number[], string][] = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0xfe, 0xff], "utf-16be"],
  [[0xff, 0xfe], "utf-16le"],
];

/** A decoder for `label`, or null when TextDecoder does not know it. */
function decoderFor(label: string | undefined): TextDecoder | null {
  if (!label) return null;
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

/**
 * The charset an HTML page's own `<meta charset>` or `<meta http-equiv="Content-Type">` names in its first 2 KB,
 * leaving out comments and scripts (a `charset=` there is not the page's). A meta naming UTF-16 means UTF-8 (a page
 * in UTF-16 could not have been read this far as ASCII), and x-user-defined means windows-1252, as the HTML standard says.
 */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("windows-1252")
    .decode(bytes.subarray(0, 2048))
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  // Only a meta's charset attribute, or the content of an http-equiv="Content-Type" meta, names it (a description
  // that mentions "charset=" does not); the first meta that names one wins, as in a browser's prescan.
  let label: string | undefined;
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(/([\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g)) attrs.set(m[1]!.toLowerCase(), m[2]!.replace(/^["']|["']$/g, ""));
    const named = attrs.get("charset") ?? (attrs.get("http-equiv")?.toLowerCase() === "content-type" ? /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(attrs.get("content") ?? "")?.[1] : undefined);
    const known = named && htmlLabel(named.trim().toLowerCase());
    if (known && decoderFor(known)) {
      label = known;
      break;
    }
  }
  return label;
}

/** A label as an HTML page means it: UTF-16 means UTF-8 (the page was read this far as ASCII), x-user-defined windows-1252. */
function htmlLabel(label: string): string {
  if (/^utf-16(?:be|le)?$/.test(label)) return "utf-8";
  if (label === "x-user-defined") return "windows-1252";
  return label;
}

/** The encoding an XML declaration names (`<?xml version="1.0" encoding="ISO-8859-1"?>`), at the very start. */
function xmlEncoding(bytes: Uint8Array): string | undefined {
  const start = new TextDecoder("windows-1252").decode(bytes.subarray(0, 256));
  return /^<\?xml\b[^>]*?\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(start)?.[1];
}

/**
 * An HTML Operation's page, decoded in the order a browser uses (#108):
 * 1. a byte-order mark (UTF-8, UTF-16), which also is not part of the text;
 * 2. the content-type's `charset`, when TextDecoder knows it;
 * 3. for XML (or no content-type), an XML declaration's `encoding`;
 * 4. for HTML (or no content-type), the page's own meta (`metaCharset`);
 * 5. for HTML with no declaration at all, UTF-8 unless its non-ASCII bytes are mostly no UTF-8 (`mostlyUtf8`), then
 *    windows-1252, as Chrome settles on for a Western page; anything else is UTF-8.
 * A JSON answer never comes here: readBody reads it as UTF-8 (as fetch().json() does), whatever its label.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null | undefined): string {
  for (const [bom, encoding] of BOMS) if (bom.every((b, i) => bytes[i] === b)) return new TextDecoder(encoding).decode(bytes);
  const type = (contentType ?? "").toLowerCase();
  const declared = /charset\s*=\s*["']?\s*([\w.:-]+)/.exec(type)?.[1];
  const fromHeader = decoderFor(declared);
  if (fromHeader) return fromHeader.decode(bytes);
  // An XML (or XHTML) answer names its encoding in its declaration.
  const fromXml = /xml/.test(type) || type === "" ? decoderFor(xmlEncoding(bytes)) : null;
  if (fromXml) return fromXml.decode(bytes);
  if (!/html/.test(type) && type !== "") return new TextDecoder("utf-8").decode(bytes);
  const fromMeta = decoderFor(metaCharset(bytes));
  if (fromMeta) return fromMeta.decode(bytes);
  return new TextDecoder(mostlyUtf8(bytes) ? "utf-8" : "windows-1252").decode(bytes);
}

/**
 * Whether bytes with no declared charset are UTF-8: no byte beyond ASCII, or at least as many valid multi-byte
 * sequences than invalid bytes (a tie is windows-1252, which keeps every byte). One stray byte in a UTF-8 page keeps it UTF-8; a Latin-1 page, whose `æ` and `ø` are
 * single bytes no valid sequence starts with, is windows-1252.
 */
function mostlyUtf8(bytes: Uint8Array): boolean {
  let valid = 0;
  let invalid = 0;
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    if (b < 0x80) {
      i++;
      continue;
    }
    const length = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let ok = length > 0 && i + length <= bytes.length;
    for (let k = 1; ok && k < length; k++) ok = (bytes[i + k]! & 0xc0) === 0x80;
    if (ok) {
      valid++;
      i += length;
    } else {
      invalid++;
      i++;
    }
  }
  return invalid === 0 || valid > invalid;
}

/** The answer as fetch reads it (UTF-8, so a JSON API reads as its frontend's fetch().json() does), and its bytes. */
async function readBody(r: Response): Promise<{ body: unknown; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await r.arrayBuffer());
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!text.trim()) return { body: undefined, bytes };
  try {
    return { body: JSON.parse(text), bytes };
  } catch {
    return { body: text, bytes };
  }
}

/** A header's value whatever its name's case. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}

/** The URL a fetch input goes to, a relative one resolved against the site's origin. */
function requestUrl(input: Parameters<Fetch>[0], origin: string): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as globalThis.Request).url;
  return new URL(url, origin).href;
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
  /** True once this run asked login.sessionProbe whether the saved session is still signed in. */
  private probed = false;
  /** True once this run tried login.refresh.renew: a further refusal goes to Chrome. */
  private renewTried = false;
  /** The bot protection that refused renew's request: reported if no Chrome sign-in gets past it. */
  private renewBlocked: string | undefined;
  /** True once this run renewed the session (login.refresh, or another run's renewal taken over). */
  renewed = false;
  /** True once this Client signed in with Chrome. */
  private signedInHere = false;
  private session: Session | null;
  private readonly reauthAllowed: boolean;
  /** reauth "renew": login.refresh only, never a sign-in. */
  private readonly renewOnly: boolean;
  private readonly surface: Surface;
  private persisted: boolean;
  /** The account list fetched in this run, labels included. Only the ids are saved (SPEC §7). */
  private fetchedAccounts?: Account[];
  private readonly refusals: Refusals;

  constructor(site: Site, deps: Deps, options: ClientOptions = {}) {
    this.site = site;
    this.refusals = options.refusals ?? { count: 0 };
    // Every request this Client makes goes through one site.never guard: Operations (each redirect
    // hop of fetchFollowing), the hooks' ctx.fetch and login.refresh.renew's plain fetch.
    const note = (e: NeverSent) => this.noteRefusal(e);
    const origin = effectiveOrigin(site, deps.env);
    // The site's own headers (site.headers) go to its origin on every request, hooks' too.
    const withOwn = (f: Fetch) => guardFetch(site, withSiteHeaders(f, site.headers, origin), note, origin);
    this.deps = { ...deps, fetch: withOwn(deps.fetch), plainFetch: withOwn(deps.plainFetch ?? deps.fetch) };
    this.confirm = options.confirm ?? false;
    this.session = options.session ?? null;
    this.persisted = !options.session;
    this.reauthAllowed = options.reauth === undefined || options.reauth === true;
    this.renewOnly = options.reauth === "renew";
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

  private noteRefusal(e: NeverSent): void {
    this.refusals.count++;
    this.refusals.last = e;
  }

  /**
   * Runs a site hook or a command's run: a request site.never refused while it ran fails it, even
   * when the code caught that refusal (a fallback must never hide what the user has to do).
   */
  async withRefusals<T>(run: () => Promise<T>): Promise<T> {
    const before = this.refusals.count;
    let out: T;
    try {
      out = await run();
    } catch (e) {
      throw this.refusals.count > before ? this.refusals.last! : e;
    }
    if (this.refusals.count > before) throw this.refusals.last!;
    return out;
  }

  /** A context for site hooks. `live`: calls go through this client (with reauth); otherwise through a fixed session. */
  siteCtx(session: Session, live: boolean, base?: Fetch): SiteCtx {
    const caller = live ? this : new Client(this.site, this.deps, { session, reauth: false, confirm: true, refusals: this.refusals });
    // ctx.cookies(): what this hook's ctx.fetch answers set, over Chrome's jar under transport
    // "browser" (asked only when the hook uses the Operations' fetch, never for renew's plain one).
    const set = new Map<string, string>();
    const send = base ?? this.deps.fetch;
    const chrome = base ? undefined : this.deps.cookies;
    const domain = siteDomain(this.origin);
    const fetch: Fetch = async (input, init) => {
      const res = await send(input, init);
      // A hook's request (bootstrap's first one, renew's) meets a bot wall as often as an Operation:
      // the same block, never a bug in the hook. Read as the Operations read an answer.
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      const text = location ? undefined : await res.clone().text().catch(() => undefined);
      const blocked = location
        ? blockHost(new URL(location, requestUrl(input, this.origin)))
        : blockSignal(res.status, res.headers, text === undefined ? undefined : parsedBody(text));
      if (blocked) throw this.blockedFailure("site.ts", blocked);
      // Only the site's own cookies: a hook may call another host (an identity provider).
      if (onSiteDomain(domain, new URL(requestUrl(input, this.origin)).hostname)) for (const [name, value] of setCookiePairs(res.headers)) set.set(name, value);
      return res;
    };
    return {
      fetch,
      // Chrome opens with the session's cookies, as for the Operations; a Failure (no Chrome) passes on.
      cookies: async () => ({ ...(chrome ? await chrome(headerValue(session.headers, "cookie")) : {}), ...Object.fromEntries(set) }),
      origin: this.origin,
      headers: { ...session.headers },
      ids: { ...session.ids },
      refresh: { ...session.refresh },
      decodeJwt,
      call: caller.call,
    };
  }

  /** Signs in with Chrome, runs postLogin and saves the session. Null if sign-in didn't complete. */
  async signIn(headless: boolean, options?: SignInOptions): Promise<Session | null> {
    // transport "browser": its Chrome holds the old session's cookies, so it closes around the sign-in
    // and the next request opens one with the new session.
    await this.deps.release?.();
    const signedIn = await this.deps.login(headless, options);
    if (!signedIn) return null;
    const { headers } = signedIn;
    const draft: Session = { headers, ids: {}, ...(signedIn.refresh && { refresh: signedIn.refresh }), savedAt: new Date().toISOString() };
    let raw: Record<string, unknown> | undefined;
    try {
      const postLogin = this.site.login?.postLogin;
      raw = postLogin ? await this.withRefusals(() => postLogin(this.siteCtx(draft, false))) : {};
    } finally {
      await this.deps.release?.();
    }
    const ids: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw ?? {})) if (v !== undefined && v !== null) ids[k] = String(v);
    // A silent re-sign-in that saw no token exchange at all (the frontend reused its cached token)
    // keeps the refresh record it had, but only for the same login: the same ids and the same profile,
    // never another login's token. Read as saved now, after postLogin: another run may have rotated it.
    const previous = loadSession(this.dir) ?? this.session;
    const keepOld = !!options?.keepRefresh && !signedIn.exchanged && !!previous && sameLogin(previous, ids) && previous.fromProfile === options?.fromProfile;
    const refresh = signedIn.refresh ?? (keepOld ? previous!.refresh : undefined);
    this.session = saveSession(this.dir, { headers, ids, ...(refresh && { refresh }), ...(options?.fromProfile && { fromProfile: options.fromProfile }) });
    this.persisted = true;
    this.fresh = true;
    this.signedInHere = true;
    return this.session;
  }

  /**
   * login.refresh: trades the kept refresh token for a new session with plain fetch, once per run,
   * before Chrome is tried (SPEC §7). True when it did; the new headers and a rotated refresh record
   * are saved, the ids kept.
   * - One run at a time renews (renew.lock in the state dir); a run that waited for another one, or
   *   finds a newer session.json, uses that session instead, so a rotated token is never sent twice.
   * - Conservative: only a clear answer keeps or drops nothing by guesswork. New headers are used; a
   *   refusal (null) drops the record. Any other failure whose request may have reached the site (a
   *   timeout, a reset, a thrown 5xx, an answer that no longer parses) drops it too, since the site
   *   may have rotated it. Only a request that never left (connection refused, DNS) is tried again.
   */
  private async renew(): Promise<boolean> {
    const refresh = this.site.auth === "login" ? this.site.login?.refresh : undefined;
    const current = this.peek();
    if (!refresh || !current || this.renewTried) return false;
    this.renewTried = true;
    if (!this.persisted) return this.trade(refresh, current); // the Setup page's check: in memory, its own copy
    const done = await withRenewLock(this.dir, () => this.tradeUnlessDone(refresh, current), (ms) => this.deps.sleep(ms));
    if (done !== "busy") return done;
    const disk = this.onDisk(current);
    if (disk.kind === "renewed") return this.adopt(disk.session, true);
    this.deps.note(
      disk.kind === "dropped"
        ? "another run found the refresh token spent; signing in with Chrome instead"
        : "another run is still renewing the sign-in; signing in with Chrome instead",
    );
    return false;
  }

  /**
   * Under the lock: another run's renewal wins, a dropped token is not sent, and a newer refresh
   * record another run saved is the one traded; otherwise this run's own.
   */
  private async tradeUnlessDone(refresh: RefreshConfig, current: Session): Promise<boolean> {
    const disk = this.onDisk(current);
    if (disk.kind === "renewed") return this.adopt(disk.session, true);
    if (disk.kind === "dropped") return false; // another run found the token spent: Chrome next, nothing sent
    return this.trade(refresh, disk.kind === "rotated" ? disk.session : current);
  }

  /** One renew call (under the lock when the session is saved): see renew(). */
  private async trade(refresh: RefreshConfig, current: Session): Promise<boolean> {
    if (refresh.from !== undefined && Object.keys(current.refresh ?? {}).length === 0) return false; // nothing kept to trade
    this.deps.note(`renewing the sign-in to ${this.site.origin} with its refresh token`);
    let renewed: Awaited<ReturnType<typeof refresh.renew>>;
    // A refusal is remembered even when renew catches it: nothing left, so the record stays.
    const before = this.refusals.count;
    const refused = () => (this.refusals.count > before ? this.refusals.last : undefined);
    const plain = this.deps.plainFetch ?? this.deps.fetch;
    for (let attempt = 0; ; attempt++) {
      // Plain fetch, never transport "browser"'s Chrome; bounded, and cancelled when time runs out,
      // so no request is left open after the lock is released.
      const abort = new AbortController();
      const fetch: Fetch = (input, init) => plain(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal });
      try {
        renewed = await withTimeout(refresh.renew(this.siteCtx(current, false, fetch)), RENEW_TIMEOUT_MS, () => abort.abort());
        break;
      } catch (e) {
        if (e instanceof NeverSent) throw e; // refused, uncaught: nothing left, the record stays
        const caught = refused();
        if (caught) {
          // renew caught a refusal, then failed otherwise: what else it sent may have rotated the token.
          // A bot wall's refusal never took the token either, so it stays then too.
          if (!neverSent(e) && !(e instanceof Failure && e.details.blocked)) this.dropRefresh(current);
          throw caught;
        }
        // A bot wall refused the token request: the site never took the token, which stays, and
        // Chrome signs in instead (a real browser may pass where a plain request was refused).
        if (e instanceof Failure && e.details.blocked) {
          this.renewBlocked = e.details.blocked;
          this.deps.note(`renewing the sign-in was refused as automated traffic (bot protection: ${e.details.blocked}); signing in with Chrome instead`);
          return false;
        }
        // The error's name only: its message may carry what the site sent.
        const name = errorName(e);
        if (neverSent(e) && attempt < this.deps.retryDelays.length) {
          this.deps.note(`renewing the sign-in failed (${name}), trying again`);
          await this.deps.sleep(this.deps.retryDelays[attempt]!);
          continue;
        }
        if (neverSent(e)) {
          this.deps.note(`renewing the sign-in failed (${name}); signing in with Chrome instead`);
          return false; // never reached the site: the record stays good
        }
        // It may have reached the site, which may have rotated the token: dropped, never sent again
        // by this run or a later one (a spent token can revoke its whole family).
        this.deps.note(`renewing the sign-in failed (${name}); the refresh token may be spent, so it is dropped; signing in with Chrome instead`);
        this.dropRefresh(current);
        return false;
      }
    }
    const refusal = refused();
    if (refusal) {
      // renew caught a refusal: a renewal it still made is kept (the old token may be spent), then the bug is reported.
      if (renewed?.headers) await this.adopt({ ...current, headers: renewed.headers, ...(renewed.refresh && { refresh: renewed.refresh }), savedAt: new Date().toISOString() });
      throw refusal;
    }
    if (!renewed?.headers) {
      // Refused: perhaps because another run spent the token meanwhile. Its session wins, and a
      // session.json another run already changed is left as it is.
      const disk = this.onDisk(current);
      if (disk.kind === "renewed") return this.adopt(disk.session, true);
      if (disk.kind === "same") this.dropRefresh(current);
      return false;
    }
    return this.adopt({ ...current, headers: renewed.headers, ...(renewed.refresh && { refresh: renewed.refresh }), savedAt: new Date().toISOString() });
  }

  /** Forgets a refresh record that is spent or may be: it is never sent again. */
  private dropRefresh(current: Session): void {
    if (!current.refresh) return;
    const { refresh: _spent, ...rest } = current;
    this.session = this.persisted ? saveSession(this.dir, rest) : rest;
  }

  /**
   * session.json against `current`, as read when this run started:
   * - "renewed": another run saved other headers (use them);
   * - "dropped": the same headers and no refresh record (another run found the token spent: send nothing);
   * - "rotated": the same headers and another, non-empty refresh record (trade that one);
   * - "same": nothing changed.
   * Except for "same", this run takes the saved session as its own.
   */
  private onDisk(current: Session): { kind: "renewed" | "dropped" | "rotated"; session: Session } | { kind: "same" } {
    const saved = this.persisted ? loadSession(this.dir) : null;
    if (!saved) return { kind: "same" };
    if (JSON.stringify(saved.headers) !== JSON.stringify(current.headers)) {
      this.deps.note("another run renewed the sign-in; using its session");
      return { kind: "renewed", session: saved };
    }
    if (JSON.stringify(saved.refresh ?? {}) === JSON.stringify(current.refresh ?? {})) return { kind: "same" };
    this.session = saved;
    return { kind: Object.keys(saved.refresh ?? {}).length === 0 ? "dropped" : "rotated", session: saved };
  }

  /**
   * Uses a renewed session from now on: saved (unless it was read from session.json, which already
   * holds it), and transport "browser"'s Chrome reopened with it.
   */
  private async adopt(next: Session, fromDisk = false): Promise<true> {
    this.session = this.persisted && !fromDisk ? saveSession(this.dir, next) : next;
    this.renewed = true;
    await this.deps.release?.();
    return true;
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
      const seeded = await this.signIn(true, { fromProfile: from, keepRefresh: true }).catch((e) => {
        if (e instanceof ProfileUnavailable) return null; // that profile is busy (a Capture runs on it)
        throw e;
      });
      if (seeded) return seeded;
    }
    this.deps.note("signing in again from the Chrome profile (headless)");
    const refreshed = await this.signIn(true, { keepRefresh: true });
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
    const s = await this.signIn(false, { keepRefresh: true });
    if (!s) throw new Failure("session", `Sign-in to ${this.site.origin} did not complete.`);
    return s;
  }

  private async bootstrap(): Promise<Session> {
    // transport "browser": a fresh tab, so ctx.cookies() is what the site sets now, not the old jar.
    await this.deps.release?.();
    const empty: Session = { headers: {}, ids: {}, savedAt: new Date().toISOString() };
    const r = await this.withRefusals(() => this.site.bootstrap!(this.siteCtx(empty, false)));
    this.session = saveSession(this.dir, { headers: r.headers ?? {}, ids: r.ids ?? {} });
    this.persisted = true;
    this.fresh = true;
    return this.session;
  }

  /**
   * Some sites (Jira Cloud) serve an expired session as an anonymous user: 200 with nothing in it,
   * or 404, never 401. Ask login.sessionProbe once per run, before the first Operation, and sign in
   * again (or fail with kind session) when it says signed out. A renew is asked about again, since
   * such a site would serve a renewal that did not sign in as anonymous too. Skipped right after a
   * sign-in, and when this client may not sign in (reauth false).
   */
  private async probeSession(): Promise<void> {
    const probe = this.site.auth === "login" ? this.site.login?.sessionProbe : undefined;
    if (!probe || this.probed || this.fresh || (!this.reauthAllowed && !this.renewOnly)) return;
    this.probed = true;
    const url = new URL(probe, this.origin);
    if (url.origin !== new URL(this.origin).origin) return; // the session's headers stay on the site (siteProblems refuses this)
    const first = await this.askProbe(url);
    if (first !== "signed-out") return;
    this.deps.note(`the saved sign-in to ${this.site.origin} has expired (${probe} says signed out)`);
    if ((await this.renew()) && (await this.askProbe(url)) !== "signed-out") return;
    // No sign-in here (the Setup page's check): an upload that is still signed out is refused.
    if (this.renewOnly) throw this.renewWall() ?? new Failure("session", `The session for ${this.site.origin} is signed out (${probe}).`);
    await this.signInAfterRenew();
  }

  /** A renew refused by a bot wall, as the failure to report when nothing got past it. */
  private renewWall(): Failure | undefined {
    return this.renewBlocked ? this.blockedFailure("login.refresh.renew", this.renewBlocked) : undefined;
  }

  /** Chrome's sign-in after renew failed; when that does not complete either, a wall renew met is the cause. */
  private async signInAfterRenew(): Promise<Session> {
    try {
      return await this.signInOrFail();
    } catch (e) {
      if (e instanceof Failure && e.kind === "session") throw this.renewWall() ?? e;
      throw e;
    }
  }

  /** login.sessionProbe with the current session: "signed-out", or undefined (signed in, or the site is struggling). */
  private async askProbe(url: URL): Promise<"signed-out" | undefined> {
    const headers: Record<string, string> = { accept: "application/json" };
    for (const [k, v] of Object.entries(this.session?.headers ?? {})) headers[k.toLowerCase()] = v;
    let res: Response_;
    try {
      res = await this.fetchFollowing({ method: "GET", url: url.toString(), headers });
    } catch (e) {
      if (e instanceof NeverSent) throw e; // site.never forbids the probe
      return undefined; // network trouble: the Operation itself reports it
    }
    if (res.blocked) return undefined; // a bot wall, not a sign-out: the Operation reports it
    if (res.status >= 200 && res.status < 300 && !res.loginRedirect && !res.offsite) return undefined;
    if (res.status >= 500 || res.status === 429) return undefined; // the site is struggling, not signed out
    return "signed-out";
  }

  /**
   * The site refused the request as automated traffic (SPEC §10): network, never Drift, since
   * nothing in the site changed that a Contract describes. `blocked` names the bot protection.
   */
  private blockedFailure(what: Operation | string, blocked: string): Failure {
    const how = this.site.transport === "browser" ? ", even from Chrome" : "";
    const name = typeof what === "string" ? what : what.name;
    return new Failure("network", `${name}: the site refused the request as automated traffic${how} (bot protection: ${blocked}).`, { blocked });
  }

  /**
   * After a 401/403: renew with the refresh token, else sign in again (login), or rerun bootstrap
   * (none). False when there is nothing left to try, so the refusal is Drift.
   */
  private async reauthenticate(): Promise<boolean> {
    if (this.fresh) return false;
    if (this.renewOnly) return this.renew();
    if (!this.reauthAllowed) return false;
    if (this.site.auth === "login") {
      if (await this.renew()) return true;
      await this.signInAfterRenew();
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
    // Before the dry run too: a request the CLI never sends is no dry run to confirm.
    const built = this.prebuild(op, v.data);
    const never = forbiddenOperation(this.site, op) ?? built?.rule;
    if (never) {
      const refused = new NeverSent(never, op.name);
      this.noteRefusal(refused);
      throw refused;
    }
    if (op.effect === "write" && !this.confirm) throw new DryRun(op.name, v.data);
    await this.ensureSession();
    await this.probeSession();
    // A write answered with the site's own sign-in page (login.paths, login.signedOutSelector) is never sent again, whichever
    // answer it is (the first, or the resend after a renew): a POST's redirect to /login or a 200 form cannot be told from a
    // success that landed there, so it may have taken effect.
    const neverResend = (r: Response_): Response_ => {
      if (r.signedOut && op.effect !== "read") {
        const how = r.signedOut === "path" ? "a redirect to its sign-in page" : "its sign-in form";
        throw new Failure("session", `${op.name}: the site answered with ${how}. The write may have taken effect, and it was not sent again: check on the site before running it again.`);
      }
      return r;
    };
    let res = neverResend(await this.send(op, v.data, built?.req));
    // Renew, then sign in (or rerun bootstrap): each at most once a run, so this ends. A bot wall
    // is no sign-out: no sign-in gets past it, so none is spent on it.
    while (!res.blocked && this.isAuthFailure(op, res) && (await this.reauthenticate())) res = neverResend(await this.send(op, v.data, built?.req));
    if (res.blocked) throw this.blockedFailure(op, res.blocked);
    if (this.isAuthFailure(op, res)) {
      // Renew met a bot wall and no Chrome sign-in followed (the Setup page's check): the wall, not Drift.
      if (!this.signedInHere) {
        const wall = this.renewWall();
        if (wall) throw wall;
      }
      // The site's own sign-in page (login.paths, login.signedOutSelector) after the one sign-in a run is allowed: the
      // sign-in did not take, which is a session failure, not a change of the site away from a Contract.
      if (res.signedOut) {
        const how = res.signedOut === "path" ? "a redirect to its sign-in page" : "its sign-in form";
        const after = this.signedInHere ? "a fresh sign-in" : this.renewed ? "renewing the sign-in" : "a check of the saved sign-in";
        throw new Failure("session", `${op.name}: the site still answers with ${how} after ${after}.`);
      }
      const after =
        this.site.auth === "login"
          ? this.signedInHere ? "a fresh sign-in" : this.renewed ? "renewing the sign-in" : "a check of the saved sign-in"
          : this.site.bootstrap ? "rerunning bootstrap" : "a call without login";
      throw this.drift(op, "auth", "", res.loginRedirect ? "redirect" : String(res.status), `the site refused the request (HTTP ${res.status}) after ${after}`);
    }
    return this.classify(op, res);
  }) as Call;

  /**
   * With a never list: the request this Operation sends with these variables (built once, the
   * session's headers added by send) and the rule it breaks, if any. Undefined without a list, or
   * when it cannot be built: its dry run or send() reports that, as without a list.
   */
  private prebuild(op: Operation, vars: unknown): { req: Request; rule?: NeverRule } | undefined {
    if (!Array.isArray(this.site.never) || this.site.never.length === 0) return undefined;
    try {
      const req = buildRequest(op, vars, { origin: this.origin, graphqlPath: this.site.graphqlPath, headers: {} });
      return { req, rule: forbiddenRequest(this.site, req) };
    } catch {
      return undefined;
    }
  }

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
    const accounts = this.site.accounts;
    const raw = await this.withRefusals(() => accounts(this.siteCtx(s, true)));
    const list: Account[] = raw.map((a) => (typeof a === "string" ? { id: a } : { id: String(a.id), ...(a.label ? { label: String(a.label) } : {}) }));
    this.fetchedAccounts = list;
    // The accounts go onto session.json as it is now when it is the same login: another run may have
    // renewed it since, and its rotated refresh token must not be overwritten with a spent one.
    const loaded = this.session ?? s;
    const onDisk = this.persisted ? loadSession(this.dir) : null;
    const current = onDisk && sameLogin(onDisk, loaded.ids) && onDisk.fromProfile === loaded.fromProfile ? onDisk : loaded;
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

  private async send(op: Operation, vars: unknown, prebuilt?: Request): Promise<Response_> {
    const session = this.session ?? (await this.ensureSession());
    const req = prebuilt ? withSessionHeaders(op, prebuilt, session.headers) : buildRequest(op, vars, { origin: this.origin, graphqlPath: this.site.graphqlPath, headers: session.headers });
    const delays = this.deps.retryDelays;
    for (let attempt = 0; ; attempt++) {
      let res: Response_ | undefined;
      let transport: string | undefined;
      try {
        res = await this.fetchFollowing(req);
      } catch (e) {
        if (e instanceof Failure || e instanceof NeverSent) throw e; // no Chrome to send from (transport "browser"), or site.never
        transport = (e as { code?: string })?.code || (e as Error)?.name || "error";
      }
      if (res?.blocked) return res; // a bot wall answers the same way again: call() reports it
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
      // deps.fetch is site.never's guard: every hop is checked, a redirect may lead to a forbidden path.
      const r = await this.deps.fetch(url, { method, headers: req.headers, body, redirect: "manual" });
      const location = r.headers.get("location");
      if (r.status < 300 || r.status >= 400 || !location) {
        const { body, bytes } = await readBody(r);
        const blocked = blockSignal(r.status, r.headers, body);
        const contentType = r.headers.get("content-type") ?? undefined;
        // login.signedOutSelector: a 2xx that renders the sign-in form in place. An HTML answer only, never a JSON one.
        if (!blocked && this.signedOutPage(r.status, contentType, bytes)) return { status: r.status, body, bytes, contentType, loginRedirect: true, signedOut: "selector" };
        return { status: r.status, body, bytes, contentType, ...(blocked && { blocked }) };
      }
      const next = new URL(location, url);
      const blocked = blockHost(next);
      if (blocked) return { status: r.status, body: undefined, blocked };
      if (this.site.auth === "login" && isLoginHost(this.site, next.toString())) return { status: r.status, body: undefined, loginRedirect: true };
      // login.paths: the site's own sign-in page. `next` is resolved, so a relative Location counts too.
      if (this.site.auth === "login" && isLoginPath(this.site, next, this.origin)) return { status: r.status, body: undefined, loginRedirect: true, signedOut: "path" };
      if (next.origin !== new URL(url).origin) return { status: r.status, body: undefined, offsite: true };
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
      }
      url = next.toString();
    }
    return { status: 310, body: undefined, offsite: true };
  }

  /** Whether a 2xx HTML answer shows login.signedOutSelector's element. */
  private signedOutPage(status: number, contentType: string | undefined, bytes: Uint8Array): boolean {
    const selector = this.site.auth === "login" ? this.site.login?.signedOutSelector : undefined;
    if (!selector || status < 200 || status >= 300 || !isHtmlType(contentType)) return false;
    return htmlMatches(decodeBody(bytes, contentType), selector);
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
    const picked = op.html ? this.pickHtml(op, op.html, res) : body;
    const parsed = op.response.safeParse(picked);
    if (parsed.success) return parsed.data;
    const diff = zodDiff(parsed.error.issues, picked, op.response);
    const first = diff[0] ?? { path: "", code: "" };
    return this.fail(op, "zod", first.path, first.code, `the response no longer matches the Contract at ${first.path || "(root)"} (${first.code})`, diff);
  }

  /** The values html.fields picks from the page (or from the HTML html.from finds in a JSON answer); a changed layout is Drift. */
  private pickHtml(op: Operation, html: HtmlContract, res: Response_): Record<string, unknown> {
    const out = extractHtml(this.htmlOf(op, html, res), html.fields);
    if (out.ok) return out.value;
    const why = out.code === "no_match" ? `the page no longer has the element html.fields looks for at ${out.path}` : `the inline JSON at ${out.path} no longer parses`;
    return this.fail(op, "html", out.path, out.code, why, [{ path: out.path, code: out.code }]);
  }

  /** The HTML an HTML Operation reads: what html.from finds in the JSON, or the answer's own text; else Drift. */
  private htmlOf(op: Operation, html: HtmlContract, res: Response_): string {
    if (html.from) {
      let found: unknown;
      try {
        found = html.from(res.body);
      } catch {
        found = undefined;
      }
      if (typeof found !== "string") return this.fail(op, "html", "from", "not_html", "the answer no longer carries HTML where html.from looks");
      return found;
    }
    // An answer that is not JSON by its content-type is the text it is (`3` is a fragment, not a number), decoded by the
    // page's own charset (#108).
    const jsonType = /json/i.test(res.contentType ?? "");
    if (res.bytes !== undefined && !jsonType && (res.contentType !== undefined || typeof res.body === "string")) return decodeBody(res.bytes, res.contentType);
    if (res.body === undefined) return ""; // an empty answer (a fragment endpoint with no results): an empty fragment
    if (typeof res.body === "string") return res.body; // a JSON string of HTML, unescaped by JSON.parse
    return this.fail(op, "html", "", "not_html", "the site no longer answers this request with HTML (JSON)");
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

/**
 * Markers in an answer that is not JSON (readBody gave text) that only a bot protection's challenge
 * or block page carries, at any status (a challenge can come as 200). Not what vendors put on every
 * page of a site they protect (Cloudflare's challenge-platform script, Imperva's _Incapsula_Resource,
 * PerimeterX's client script, DataDome's x-datadome header). Matched, never kept: only the vendor
 * name leaves blockSignal. First match wins.
 */
const BLOCK_PAGES: [RegExp, string][] = [
  [/_cf_chl_opt|<title>Just a moment\.\.\.<\/title>|Attention Required! \| Cloudflare/i, "cloudflare"],
  [/captcha-delivery\.com/i, "datadome"],
  [/px-captcha|_pxCaptcha/i, "perimeterx"],
  [/Incapsula incident/i, "imperva"],
  // Akamai's Access Denied page writes them as HTML entities.
  // Its reference has four parts (#18.5b3c1002.1700000000.1a2b3c): an ordinary "Reference #2.1" is no block.
  [/errors(?:\.|&#46;)edgesuite(?:\.|&#46;)net|Reference(?: |&#32;)(?:#|&#35;)\d+(?:(?:\.|&#46;)[0-9a-f]+){3}\b/i, "akamai"],
];
/** A refusal of an API call as JSON (DataDome's captcha url, PerimeterX's block script), never data. */
const BLOCK_JSON: [RegExp, string][] = [
  [/captcha-delivery\.com/i, "datadome"],
  [/"blockScript"\s*:/, "perimeterx"],
];
/**
 * A captcha or "checking your browser" wall: only as a refusal, and never a page with a password
 * field, since a sign-in page carries a captcha too.
 */
const CAPTCHA_WALL = /g-recaptcha|h-captcha|hcaptcha\.com|recaptcha\/api|checking your browser/i;
const SIGN_IN_FORM = /type\s*=\s*["']?password/i;
const REFUSALS = new Set([403, 429, 503]);
/** How much of an answer is searched for a block: a block page is small, a site's data may not be. */
const BLOCK_SCAN_CHARS = 100_000;
/** Hosts a bot protection redirects a refused request to. */
const BLOCK_HOSTS: [RegExp, string][] = [
  [/(?:^|\.)captcha-delivery\.com$/i, "datadome"],
  [/(?:^|\.)challenges\.cloudflare\.com$/i, "cloudflare"],
  [/(?:^|\.)(?:px-cloud\.net|perimeterx\.net)$/i, "perimeterx"],
];

/**
 * The bot protection that refused a request, or undefined (SPEC §10): Cloudflare's `cf-mitigated`
 * header (set on a challenge only); a block page's markers in an answer that is not JSON, at any
 * status; a JSON refusal's markers; a captcha wall as a refusal on a page with no sign-in form.
 */
export function blockSignal(status: number, headers: Headers, body: unknown): string | undefined {
  if (headers.has("cf-mitigated")) return "cloudflare";
  if (body !== null && typeof body === "object") {
    if (status < 400) return undefined;
    const text = JSON.stringify(body).slice(0, BLOCK_SCAN_CHARS);
    return BLOCK_JSON.find(([marker]) => marker.test(text))?.[1];
  }
  if (typeof body !== "string") return undefined;
  const page = body.slice(0, BLOCK_SCAN_CHARS);
  const vendor = BLOCK_PAGES.find(([marker]) => marker.test(page))?.[1];
  if (vendor) return vendor;
  return REFUSALS.has(status) && CAPTCHA_WALL.test(page) && !SIGN_IN_FORM.test(page) ? "captcha" : undefined;
}

/** The bot protection a redirect leads to, by its host, or undefined. */
export function blockHost(location: URL): string | undefined {
  return BLOCK_HOSTS.find(([host]) => host.test(location.hostname))?.[1];
}

/** The name=value pairs of a response's Set-Cookie headers (SiteCtx.cookies). */
export function setCookiePairs(headers: Headers): [string, string][] {
  const out: [string, string][] = [];
  for (const c of headers.getSetCookie?.() ?? []) {
    const pair = c.split(";")[0]!;
    const eq = pair.indexOf("=");
    if (eq > 0) out.push([pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()]);
  }
  return out;
}

/** Error codes of a request that never reached the site (Bun's fetch, Node's): safe to send again. */
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ConnectionRefused", "FailedToOpenSocket"]);

function neverSent(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" && NEVER_SENT.has(code);
}

/** Ids in key order, so two sessions' ids compare equal whatever order postLogin returned them in. */
function sortedIds(ids: Record<string, string>): [string, string][] {
  return Object.entries(ids).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Whether a saved session has these chain-root ids (empty equals empty). */
function sameLogin(saved: Session, ids: Record<string, string>): boolean {
  return JSON.stringify(sortedIds(saved.ids)) === JSON.stringify(sortedIds(ids));
}

/** How long one renew call may take; well under renew.lock's 60 s staleness. */
const RENEW_TIMEOUT_MS = 30_000;

/** `work`, or a TimeoutError after `ms`: the request may have reached the site, so it is not sent again. */
async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout(); // cancel the request itself, not only the wait for it
      reject(Object.assign(new Error("renew took too long"), { name: "TimeoutError" }));
    }, ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
