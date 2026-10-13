// The Capture's bookkeeping, separate from the browser so it can be tested
// with plain objects. Input is one request (and maybe its response); output
// is shapes only. Values never leave this module: bodies are reduced to
// shapes, paths are redacted, header values survive only on the allowlist.
// Values are held in memory only, to recognise them when they reappear in a
// URL path (a username, a search term), and are never written anywhere.

import { onSiteDomain, siteDomain } from "../../starter/skill/cli/src/runtime/site";
import { graphqlFromBody, graphqlFromSearch, isGraphqlPath, type GraphqlCall } from "./graphql";
import {
  bodyShape,
  mediaType,
  mergeBodies,
  mergeShapes,
  parseJson,
  queryShape,
  redactPath,
  shapeOf,
  type BodyShape,
  type Shape,
} from "./shape";

/** Header values kept verbatim: they describe the protocol, never the user. */
export const HEADER_VALUE_ALLOWLIST = new Set([
  "content-type",
  "accept",
  "x-requested-with",
  "apollo-require-preflight",
  "x-apollo-operation-name",
]);

const RECORDED_RESOURCE_TYPES = new Set(["fetch", "xhr", "document", "eventsource"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type Effect = "read" | "write";

export type RequestInfo = {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData: Buffer | null;
  resourceType: string;
};

export type ResponseInfo = {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
};

export type ResponseShape = {
  status: number;
  contentType?: string;
  /** Response header names; values only for the allowlist. Set-Cookie is listed in `setCookies` instead. */
  headers?: Record<string, string | null>;
  /** Names of the cookies the response sets, never their values: where a bootstrap's cookie comes from. */
  setCookies?: string[];
  body: BodyShape;
};

export type OperationShape = {
  operation: string;
  kind: "graphql" | "rest";
  effect: Effect;
  /** A persisted GraphQL query sent by POST with only a hash: nothing shows whether it writes, so the Capture treated it as a write. Decide its effect yourself. */
  effectUnknown?: true;
  /** Part of signing in (a login host, a token or post-login step), let through: it belongs in site.ts, not operations/. */
  loginFlow?: true;
  /** A page load (a document request), not an API call. */
  navigation?: true;
  /** Let through because --allow-read named it. */
  allowedRead?: true;
  /** A Next.js server action (a POST with a `next-action` header): an RPC into the page's server code, never an Operation. */
  serverAction?: true;
  /** A React Server Component stream (`text/x-component`, `?_rsc=`, an `rsc: 1` header): no JSON, so no Zod Contract can parse it. */
  rsc?: true;
  resourceType: string;
  host: string;
  method: string;
  path: string;
  graphql?: Omit<GraphqlCall, "variables">;
  request: {
    headers: Record<string, string | null>;
    query?: Shape;
    variables?: Shape;
    body?: BodyShape;
    /** Claim names and types of a bearer JWT in the `authorization` header (what postLogin can decode), never their values. */
    bearerClaims?: Shape;
  };
  responses: ResponseShape[];
  seen: number;
  aborted: number;
};

type PlannedCall = { key: string; shape: OperationShape; responseIndex?: number };

export type Planned = {
  seq: number;
  calls: PlannedCall[];
  effect: Effect;
  /** Part of signing in (a login host, a token or post-login step): never aborted. */
  loginFlow: boolean;
  /** Named by --allow-read: never aborted. */
  allowedRead: boolean;
  /** A Next.js server action (`next-action` header). */
  serverAction?: boolean;
  method: string;
  /** `host/path` as sent and with the path redacted, for --allow-read and --write-op matching. In memory only. */
  where: string[];
};

// ---- sign-in steps ----
//
// A read Task aborts every write, except the sign-in steps the maintainer needs before the
// Task's data appears. The exemption is narrow on purpose: a word such as "token" or
// "session" alone does not make a write a sign-in step (`DELETE /api/sessions/all`,
// `POST /api/payment-tokens` and `revokeApiToken` are real writes and are aborted).

/** Words that name signing in wherever they appear in a path or operation name. */
const SIGN_IN_WORDS = new Set([
  "login", "logon", "signin", "signon", "sso", "saml", "saml2", "oauth", "oauth2", "openid", "oidc",
  "authorize", "authorise", "authenticate", "authentication", "postlogin",
]);
/** Words of a token or session endpoint (`/api/token`, `/auth/refresh`, `refreshToken`, `createSession`). */
const STEP_WORDS = new Set(["token", "session", "sessions", "auth", "refresh", "jwt"]);
const STEP_VERBS = new Set(["create", "get", "obtain", "issue", "new", "verify", "access", "id", "start", "exchange", "renew"]);
/** Words that make a write a change to the account even inside a sign-in path. */
const NOT_SIGN_IN_WORDS = new Set([
  "logout", "logoff", "signout", "signoff", "revoke", "revocation", "delete", "remove", "cancel", "change",
  "reset", "update", "unlink", "deactivate", "disable", "preferences", "settings",
]);
/** First host labels that usually mean a sign-in host (a guess; site.ts and --login-host name them for sure). */
const LOGIN_HOST_LABELS = new Set(["id", "idp", "login", "signin", "sso", "auth", "oauth"]);

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const namesChange = (text: string) => words(text).some((w) => NOT_SIGN_IN_WORDS.has(w));

function hasSignInWord(ws: string[]): boolean {
  return ws.some((w, i) => SIGN_IN_WORDS.has(w) || SIGN_IN_WORDS.has(w + (ws[i + 1] ?? "")));
}

/** Every word is a token/session word or verb, and at least one is a token/session word. */
function isTokenStep(ws: string[]): boolean {
  return ws.length > 0 && ws.some((w) => STEP_WORDS.has(w)) && ws.every((w) => STEP_WORDS.has(w) || STEP_VERBS.has(w));
}

/**
 * Whether a write is a sign-in step, from its method and its path or GraphQL operation name:
 * `/oauth/token`, `/api/session/post-login`, `/u/login`, `signIn`, `refreshToken`, `POST /api/session`.
 * DELETE never is, and neither is anything that names a change (`logout`, `revoke`, `reset`, `…-preferences`).
 */
export function isSignInStep(method: string, pathOrName: string): boolean {
  if (method.toUpperCase() === "DELETE") return false;
  const ws = words(pathOrName);
  if (ws.some((w) => NOT_SIGN_IN_WORDS.has(w))) return false;
  if (hasSignInWord(ws)) return true;
  if (!pathOrName.includes("/")) return isTokenStep(ws); // a GraphQL operation name
  const segments = pathOrName.split("/").filter((s) => s && !s.startsWith(":"));
  if (isTokenStep(words(segments.at(-1) ?? ""))) return true;
  // `/token/refresh`, `/auth/new`: a verb under a token or session segment.
  return words(segments.at(-1) ?? "").every((w) => STEP_VERBS.has(w)) && isTokenStep(words(segments.slice(-2).join("-")));
}

/** A sign-in step sent by POST, from a path or an operation name alone. */
export function isLoginFlow(text: string): boolean {
  return isSignInStep("POST", text);
}

function isLoginHostName(host: string): boolean {
  return LOGIN_HOST_LABELS.has(host.split(".", 1)[0] ?? "");
}

/** A sign-in form on a login host: anything but a DELETE or a path that names a change. */
function isSignInForm(method: string, path: string): boolean {
  return method !== "DELETE" && !namesChange(path);
}

// ---- headers ----

function headerShape(headers: Record<string, string>, skip: (name: string) => boolean = () => false): Record<string, string | null> {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, string | null> = {};
  for (const name of [...lower.keys()].sort()) {
    if (name.startsWith(":") || skip(name)) continue;
    const value = lower.get(name) as string;
    if (!HEADER_VALUE_ALLOWLIST.has(name)) out[name] = null;
    else out[name] = name === "content-type" ? (mediaType(value) ?? null) : value;
  }
  return out;
}

function mergeHeaders(a: Record<string, string | null>, b: Record<string, string | null>) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = out[k] ?? v;
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y)));
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** Cookie names from a Set-Cookie header value (Playwright joins several with newlines). Never the values. */
export function setCookieNames(value: string | undefined): string[] {
  if (!value) return [];
  const names = value
    .split("\n")
    .map((line) => line.split(";", 1)[0]!.split("=", 1)[0]!.trim())
    .filter((n) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(n));
  return [...new Set(names)].sort();
}

/** The claim names and types of a bearer JWT, or undefined when the header holds none. Never the values. */
export function bearerClaims(authorization: string | undefined): Shape | undefined {
  const token = authorization?.match(/^Bearer\s+([\w-]+)\.([\w-]+)\.([\w-]*)$/i);
  if (!token) return undefined;
  try {
    const json = Buffer.from(token[2]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    return shapeOf(payload);
  } catch {
    return undefined;
  }
}

/** Every string value inside a JSON value (not its keys: those name fields), for recognising values in URL paths later. */
function collectStrings(value: unknown, into: (s: string) => void, depth = 0): void {
  if (depth > 32 || value === null || value === undefined) return;
  if (typeof value === "string") into(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, into, depth + 1);
  else if (typeof value === "object") for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, into, depth + 1);
}

function httpHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export type RecorderOptions = {
  origin: string;
  /** Login hosts named in site.ts or with --login-host: their requests are sign-in steps. */
  loginHosts?: string[];
  /** --write: the Task's one write goes through for real. */
  allowWrite?: boolean;
  /** --write-op: the write that may go through (a GraphQL operationName, a REST `METHOD /path` as the Capture names it, or a part of `host/path`). */
  writeOp?: string;
  /** --allow-read: requests the maintainer declares as reads (a GraphQL operationName, or a part of `host/path`). */
  allowRead?: string[];
};

export class CaptureRecorder {
  private readonly originHost: string;
  private readonly domain: string;
  private readonly loginHosts: Set<string>;
  private readonly allowWrite: boolean;
  private readonly writeOp?: string;
  private readonly allowRead: string[];
  private writeUsed = false;
  /** The user clicked, typed or submitted in the current page since it loaded. */
  private gesture = false;
  private seq = 0;
  private readonly ops = new Map<string, { first: number; shape: OperationShape }>();
  /** Values seen in bodies, variables and query strings, as sent. Memory only. */
  private readonly values = new Set<string>();
  private readonly valueWords = new Set<string>();
  /** The write that went through with --write. */
  wrote?: string;
  /** Writes aborted on hosts outside the recorded scope (`METHOD host/path`, path redacted). */
  readonly blockedElsewhere = new Set<string>();
  /**
   * Hosts other than the origin's that sign-in steps went to (host names only): what site.ts
   * `login.hosts` must list. A sign-in step there, or a page on a host named like a sign-in host.
   */
  readonly signInHosts = new Set<string>();

  constructor(opts: RecorderOptions) {
    this.originHost = new URL(opts.origin).hostname;
    this.domain = siteDomain(opts.origin);
    this.loginHosts = new Set((opts.loginHosts ?? []).map((h) => h.toLowerCase()));
    this.allowWrite = opts.allowWrite ?? false;
    this.writeOp = opts.writeOp?.trim() || undefined;
    this.allowRead = (opts.allowRead ?? []).map((p) => p.trim()).filter(Boolean);
  }

  isLoginHost(host: string): boolean {
    return this.loginHosts.has(host.toLowerCase());
  }

  /** Login hosts site.ts or --login-host named. */
  get declaredLoginHosts(): string[] {
    return [...this.loginHosts];
  }

  /** A sign-in step went to `host`: remember it unless it is the origin's own host. */
  private noteSignInHost(host: string): void {
    const h = host.toLowerCase();
    if (h !== this.originHost.toLowerCase()) this.signInHosts.add(h);
  }

  /** The site origin's host, its parent domain and its subdomains, plus the login hosts. */
  inScope(url: string): boolean {
    const host = httpHost(url);
    if (!host) return false;
    return onSiteDomain(this.domain, host) || this.isLoginHost(host);
  }

  /** A trusted click, key press or form submit in a page (capture.ts reports them). */
  noteGesture(): void {
    this.gesture = true;
  }

  /** A main-frame page load: writes the new page fires on its own come before any gesture again. */
  noteNavigation(): void {
    this.gesture = false;
  }

  private remember(text: string): void {
    const s = text.trim();
    if (s.length < 3 || s.length > 200) return;
    this.values.add(s);
    for (const w of s.split(/[\s,;|/()]+/)) if (w.length >= 3) this.valueWords.add(w);
  }

  /** Splits a request into the Operations it carries, or null when it is out of scope. */
  plan(req: RequestInfo): Planned | null {
    if (!this.inScope(req.url)) return null;
    const method = req.method.toUpperCase();
    if (!RECORDED_RESOURCE_TYPES.has(req.resourceType) && READ_METHODS.has(method)) return null;
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    const path = redactPath(url.pathname);
    const contentType = header(req.headers, "content-type");
    const headers = headerShape(req.headers);
    const claims = bearerClaims(header(req.headers, "authorization"));
    for (const v of url.searchParams.values()) this.remember(v);
    const where = [`${host}${path}`, `${host}${url.pathname}`];

    // GraphQL only on a GraphQL path or with a GraphQL document (or persisted query): a REST
    // `?query=<word>` is an ordinary query field, recorded as a type like any other.
    const graphqlPath = isGraphqlPath(url.pathname);
    let gql: GraphqlCall[] | null = null;
    if (req.postData && req.postData.length > 0) {
      const text = req.postData.toString("utf8");
      const parsed = parseJson(text);
      if (parsed.ok) {
        gql = graphqlFromBody(parsed.value, { graphqlPath });
        collectStrings(parsed.value, (s) => this.remember(s));
      } else if (mediaType(contentType) === "application/x-www-form-urlencoded") {
        for (const v of new URLSearchParams(text).values()) this.remember(v);
      }
    } else if (method === "GET") {
      gql = graphqlFromSearch(url.searchParams, { graphqlPath });
    }

    const base = { resourceType: req.resourceType, host, method, path };
    const outcome = () => ({ responses: [], seen: 0, aborted: 0 });
    const declaredLoginHost = this.isLoginHost(host);
    const guessedLoginHost = !declaredLoginHost && isLoginHostName(host);
    const request = (extra: Partial<OperationShape["request"]>) => ({ headers, ...extra, ...(claims ? { bearerClaims: claims } : {}) });

    if (gql) {
      const calls = gql.map((call, index): PlannedCall => {
        const { variables, ...graphql } = call;
        const name = call.operationName ?? "anonymous";
        // A hash-only persisted query sent by POST may be a mutation: fail safe and treat it as a write.
        const unknown = call.persisted && !call.query && method !== "GET";
        return {
          key: `graphql ${host} ${name} ${call.operationName ? "" : (call.query ?? "")}`,
          responseIndex: gql && gql.length > 1 ? index : undefined,
          shape: {
            operation: name,
            kind: "graphql",
            effect: call.operationType === "mutation" || unknown ? "write" : "read",
            ...(unknown ? { effectUnknown: true as const } : {}),
            ...base,
            graphql,
            request: request(variables ? { variables } : {}),
            ...outcome(),
          },
        };
      });
      const writes = calls.filter((c) => c.shape.effect === "write");
      const effect: Effect = writes.length > 0 ? "write" : "read";
      const allowedRead = writes.length > 0 && writes.every((c) => this.allowRead.includes(c.shape.operation));
      const loginFlow =
        !allowedRead &&
        writes.length > 0 &&
        writes.every((c) =>
          declaredLoginHost ? !namesChange(c.shape.operation) : c.shape.operation !== "anonymous" && isSignInStep(method, c.shape.operation),
        );
      if (loginFlow) for (const c of writes) c.shape.loginFlow = true;
      if (loginFlow && (declaredLoginHost || guessedLoginHost)) this.noteSignInHost(host);
      if (allowedRead) for (const c of writes) c.shape.allowedRead = true;
      return { seq: this.seq++, calls, effect, loginFlow, allowedRead, method, where };
    }

    const effect: Effect = READ_METHODS.has(method) ? "read" : "write";
    // Next.js: a server action POSTs to the page itself with a `next-action` header; nothing shows
    // whether it writes. An RSC stream is the page's render, not data.
    const serverAction = effect === "write" && header(req.headers, "next-action") !== undefined;
    const rsc = url.searchParams.has("_rsc") || header(req.headers, "rsc") === "1";
    const query = queryShape(url.searchParams);
    const body = req.postData && req.postData.length > 0 ? bodyShape(req.postData, contentType) : undefined;
    const allowedRead = effect === "write" && this.allowRead.some((p) => where.some((w) => w.includes(p)));
    const loginFlow =
      !allowedRead &&
      (declaredLoginHost
        ? isSignInForm(method, path)
        : effect === "write" &&
          (isSignInStep(method, path) || (guessedLoginHost && req.resourceType === "document" && isSignInForm(method, path))));
    const navigation = req.resourceType === "document" && effect === "read";
    // A sign-in page or form on another host: a token request on the site's own API host is not one.
    if ((loginFlow && (declaredLoginHost || guessedLoginHost || req.resourceType === "document")) || (navigation && (declaredLoginHost || guessedLoginHost))) {
      this.noteSignInHost(host);
    }
    const shape: OperationShape = {
      operation: `${method} ${path}`,
      kind: "rest",
      effect,
      ...(loginFlow ? { loginFlow: true as const } : {}),
      ...(navigation ? { navigation: true as const } : {}),
      ...(allowedRead ? { allowedRead: true as const } : {}),
      ...(serverAction ? { effectUnknown: true as const, serverAction: true as const } : {}),
      ...(rsc ? { rsc: true as const } : {}),
      ...base,
      request: request({ ...(query ? { query } : {}), ...(body ? { body } : {}) }),
      ...outcome(),
    };
    return { seq: this.seq++, calls: [{ key: `rest ${host} ${method} ${path}`, shape }], effect, loginFlow, allowedRead, serverAction, method, where };
  }

  /**
   * For a request plan() leaves out (another host, or a static asset): whether it may go
   * through. Reads always may. A write passes only when it is a sign-in step (a token request,
   * a sign-in form on a login host) or --allow-read names it; every other write is aborted, so a
   * Capture writes nowhere it does not record.
   */
  allowElsewhere(req: Pick<RequestInfo, "method" | "url" | "resourceType">): boolean {
    const method = req.method.toUpperCase();
    const host = httpHost(req.url);
    if (!host) return true;
    if (READ_METHODS.has(method)) {
      if (req.resourceType === "document" && isLoginHostName(host)) this.noteSignInHost(host);
      return true;
    }
    const raw = new URL(req.url).pathname;
    const path = redactPath(raw);
    if (this.allowRead.some((p) => `${host}${path}`.includes(p) || `${host}${raw}`.includes(p))) return true;
    if (isSignInStep(method, path) || (isLoginHostName(host) && req.resourceType === "document" && isSignInForm(method, path))) {
      this.noteSignInHost(host);
      return true;
    }
    this.blockedElsewhere.add(`${method} ${host}${path}`);
    return false;
  }

  /**
   * Read Tasks abort every write that is not a sign-in step or named by --allow-read. With
   * --write, one write goes through for real: the one --write-op names, or else the first that
   * comes after the user clicked, typed or submitted in the page, so writes a page fires on its
   * own while loading (YouSee's createQuote) are aborted. Every later write is aborted.
   */
  shouldAbort(planned: Planned): boolean {
    if (planned.effect !== "write" || planned.loginFlow || planned.allowedRead) return false;
    if (this.allowWrite && !this.writeUsed && (this.writeOp ? this.matchesWriteOp(planned) : this.gesture)) {
      this.writeUsed = true;
      this.wrote = planned.calls.filter((c) => c.shape.effect === "write").map((c) => c.shape.operation).join(", ");
      return false;
    }
    return true;
  }

  private matchesWriteOp(planned: Planned): boolean {
    const op = this.writeOp!;
    return planned.calls.some((c) => c.shape.effect === "write" && c.shape.operation === op) || planned.where.some((w) => w.includes(op));
  }

  record(planned: Planned, outcome: { response?: ResponseInfo; aborted?: boolean; headers?: Record<string, string> }) {
    const { response, aborted = false } = outcome;
    const contentType = response ? mediaType(header(response.headers, "content-type")) : undefined;
    let splitBodies: unknown[] | null = null;
    if (response?.body && response.body.length > 0) {
      const parsed = parseJson(response.body.toString("utf8"));
      if (parsed.ok) {
        collectStrings(parsed.value, (s) => this.remember(s));
        if (Array.isArray(parsed.value) && planned.calls.some((c) => c.responseIndex !== undefined)) splitBodies = parsed.value;
      }
    }
    const claims = outcome.headers ? bearerClaims(header(outcome.headers, "authorization")) : undefined;
    for (const call of planned.calls) {
      const shape: OperationShape = structuredClone(call.shape);
      if (outcome.headers) {
        shape.request.headers = headerShape(outcome.headers);
        if (claims) shape.request.bearerClaims = claims;
      }
      shape.seen = 1;
      shape.aborted = aborted ? 1 : 0;
      if (contentType === "text/x-component") shape.rsc = true;
      if (response) {
        const body: BodyShape =
          splitBodies && call.responseIndex !== undefined
            ? { kind: "json", shape: shapeOf(splitBodies[call.responseIndex]) }
            : bodyShape(response.body, contentType);
        const cookies = setCookieNames(header(response.headers, "set-cookie"));
        const headers = headerShape(response.headers, (n) => n === "set-cookie");
        shape.responses = [
          {
            status: response.status,
            ...(contentType ? { contentType } : {}),
            ...(Object.keys(headers).length ? { headers } : {}),
            ...(cookies.length ? { setCookies: cookies } : {}),
            body,
          },
        ];
      }
      this.add(call.key, planned.seq, shape);
    }
  }

  private add(key: string, seq: number, shape: OperationShape) {
    const existing = this.ops.get(key);
    if (!existing) {
      this.ops.set(key, { first: seq, shape });
      return;
    }
    existing.first = Math.min(existing.first, seq);
    existing.shape = mergeOperation(existing.shape, shape);
  }

  /**
   * A redacted path with every segment that matches a value seen in this Capture replaced by
   * `:id`: a username or a search term the page also sent or received (`/users/jens.hansen`).
   */
  redactValues(path: string): string {
    return path
      .split("/")
      .map((seg) => {
        if (!seg || seg.startsWith(":")) return seg;
        let decoded = seg;
        try {
          decoded = decodeURIComponent(seg);
        } catch {}
        if (decoded.length < 3) return seg;
        // A whole value (`jens.hansen`), or a capitalised word inside one (`Vesterbrogade` from "Vesterbrogade 1").
        if (this.values.has(decoded)) return ":id";
        if (/[A-Z]/.test(decoded) && this.valueWords.has(decoded)) return ":id";
        return seg;
      })
      .join("/");
  }

  /** Operations in the order the frontend first called them, with value-like path segments redacted. */
  operations(): OperationShape[] {
    const merged = new Map<string, { first: number; shape: OperationShape }>();
    for (const [key, { first, shape }] of this.ops) {
      let k = key;
      let s = shape;
      if (shape.kind === "rest") {
        const path = this.redactValues(shape.path);
        if (path !== shape.path) {
          s = { ...shape, path, operation: `${shape.method} ${path}` };
          k = `rest ${shape.host} ${shape.method} ${path}`;
        }
      }
      const existing = merged.get(k);
      if (!existing) merged.set(k, { first, shape: s });
      else merged.set(k, { first: Math.min(existing.first, first), shape: mergeOperation(existing.shape, s) });
    }
    return [...merged.values()].sort((a, b) => a.first - b.first).map((o) => o.shape);
  }

  get originHostname(): string {
    return this.originHost;
  }
}

function mergeMaybe(a?: Shape, b?: Shape): Shape | undefined {
  return a && b ? mergeShapes(a, b) : (a ?? b);
}

function mergeResponse(a: ResponseShape, b: ResponseShape): ResponseShape {
  const headers = a.headers && b.headers ? mergeHeaders(a.headers, b.headers) : (a.headers ?? b.headers);
  const cookies = [...new Set([...(a.setCookies ?? []), ...(b.setCookies ?? [])])].sort();
  const contentType = a.contentType ?? b.contentType;
  return {
    status: a.status,
    ...(contentType ? { contentType } : {}),
    ...(headers ? { headers } : {}),
    ...(cookies.length ? { setCookies: cookies } : {}),
    body: mergeBodies(a.body, b.body),
  };
}

/** Joins two observations of one Operation: two calls in one Capture, or the same Operation in two Captures. */
export function mergeOperation(a: OperationShape, b: OperationShape): OperationShape {
  const responses = [...a.responses];
  for (const r of b.responses) {
    const i = responses.findIndex((x) => x.status === r.status);
    if (i === -1) responses.push(r);
    else responses[i] = mergeResponse(responses[i]!, r);
  }
  responses.sort((x, y) => x.status - y.status);
  const query = mergeMaybe(a.request.query, b.request.query);
  const variables = mergeMaybe(a.request.variables, b.request.variables);
  const bearer = mergeMaybe(a.request.bearerClaims, b.request.bearerClaims);
  const body = a.request.body && b.request.body ? mergeBodies(a.request.body, b.request.body) : (a.request.body ?? b.request.body);
  const flag = (k: "loginFlow" | "navigation" | "allowedRead" | "effectUnknown" | "serverAction" | "rsc") => (a[k] || b[k] ? { [k]: true as const } : {});
  return {
    ...a,
    effect: a.effect === "write" || b.effect === "write" ? "write" : "read",
    ...flag("effectUnknown"),
    ...flag("loginFlow"),
    ...flag("navigation"),
    ...flag("allowedRead"),
    ...flag("serverAction"),
    ...flag("rsc"),
    graphql: a.graphql && !a.graphql.query && b.graphql?.query ? b.graphql : a.graphql,
    request: {
      headers: mergeHeaders(a.request.headers, b.request.headers),
      ...(query ? { query } : {}),
      ...(variables ? { variables } : {}),
      ...(body ? { body } : {}),
      ...(bearer ? { bearerClaims: bearer } : {}),
    },
    responses,
    seen: a.seen + b.seen,
    aborted: a.aborted + b.aborted,
  };
}

/** File names for the shape files: the Operation name made path-safe, unique within one Capture. */
export function shapeFileNames(ops: OperationShape[], originHost: string): string[] {
  const used = new Set<string>();
  return ops.map((op) => {
    let base =
      op.kind === "graphql"
        ? op.operation
        : `${op.method}-${op.path.replace(/:id/g, "id").replace(/^\/|\/$/g, "") || "root"}`;
    if (op.host !== originHost) base = `${op.host}-${base}`;
    base = base.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "operation";
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}`;
    used.add(name.toLowerCase());
    return `${name}.shape.json`;
  });
}
