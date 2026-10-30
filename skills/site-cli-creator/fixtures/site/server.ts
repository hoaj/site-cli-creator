// The local fixture website used by the end-to-end tests: a small "shop
// account" with a GraphQL endpoint, REST invoices, an HTML frontend, a login
// mode (session cookie + bearer, both required, sign-in on a separate login
// host) and a public mode (CSRF cookie mirrored in a header), plus switches
// that simulate Drift and outages.
//
//   bun fixtures/site/server.ts --auth login|none [--port N] [--drift <name>] [--anonymous]
//
// --anonymous (auth login): like Jira Cloud, a signed-out request is served as an anonymous user
// instead of refused (the invoice list 200 with none, one invoice 404, GraphQL 200 with data null
// and a NOT_FOUND error); GET /api/me still answers 401 without a session.
//
// Run this way, the site also takes `POST /__drift?name=<drift|none>` on its own origin, so a
// Drift can be switched on and off while every session stays signed in (as a real site's
// change keeps its users' sessions): curl -X POST "http://127.0.0.1:<port>/__drift?name=type-change"

import { checkVariables, execute, GraphQLFailure, parse, validate, type GraphQLError } from "./graphql";
import { ACCOUNT, buildSchema, INVOICES, newStore, SUBSCRIPTIONS, USER, type Note } from "./data";
import { loginOriginFor } from "./hosts";
import { accountPage, loginPage, NOTE_FORM, OAUTH_CLIENT_ID, type Auth, type NoteForm } from "./pages";

export const DRIFTS = [
  "rename-field", // listSubscriptions[].status is returned as `state`
  "type-change", // listSubscriptions[].price is returned as a string
  "remove-rest", // GET /api/invoices/:id answers 404
  "graphql-validation", // Subscription.price no longer exists in the schema
  "write-shape", // addNote takes the note as `body` instead of `text`; the frontend sends `body`
  "ui-change", // the note form's label and button are renamed, so the old trigger finds nothing
  "auth", // data APIs always answer 401
  "server-error", // data APIs answer 500
  "rate-limit", // data APIs answer 429
  "input-rejected", // calls with variables are rejected with 400 BAD_USER_INPUT
  "bot-wall", // data APIs answer 403 with an HTML challenge page unless the request comes from a browser (Sec-Fetch-Mode) and carries the cookie the front page sets in JavaScript
] as const;

export type Drift = (typeof DRIFTS)[number];

export type RequestLogEntry = { method: string; host: string; path: string; operationName?: string };

export type FixtureSite = {
  /** The site origin, http://127.0.0.1:<port>. */
  url: string;
  /** The origin of the sign-in pages (auth "login"), http://localhost:<port>. */
  loginUrl: string;
  auth: Auth;
  /** Switches the site's behaviour; null restores normal behaviour. */
  setDrift(name: Drift | null): void;
  /** Invalidates every issued bearer and refresh token while keeping login sessions: data APIs answer 401. */
  revokeTokens(): void;
  /** Invalidates every issued bearer but keeps refresh tokens, as when access tokens time out: data APIs answer 401 until one is renewed. */
  expireAccessTokens(): void;
  /** Ends every login session, bearer and remembered login-host sign-in: REST reads redirect to the login host, GraphQL answers 401. */
  revokeSessions(): void;
  /** While true, the login host refuses every new sign-in (autologin included), so a login never completes; a browser it remembers (idp_sid cookie) still passes. */
  blockSignIn(blocked: boolean): void;
  /**
   * While true (auth login), a signed-out request is served as an anonymous user, as Jira Cloud
   * does, never refused with 401 or a redirect to sign-in: the invoice list answers 200 with no
   * invoices, one invoice 404, and GraphQL 200 with data null and a NOT_FOUND error. GET /api/me
   * still answers 401 without a session.
   */
  serveAnonymous(on: boolean): void;
  /** Notes stored on the account, including ones added through addNote. */
  notes(): Note[];
  /** Every request the site received, in order (method, host, path, GraphQL operationName). */
  requests(): RequestLogEntry[];
  stop(): void;
};

const SESSION_COOKIE = "shop_sid";
const HINT_COOKIE = "shop_hint";
const CSRF_COOKIE = "csrf_token";
/** The login host's own sign-in, as an SSO host keeps one: a later visit signs in at once. */
const IDP_COOKIE = "idp_sid";
/** The bot-wall drift: a cookie only the front page's script sets, as an anti-bot script does. */
const BOT_COOKIE = "shop_bw";
const BOT_SCRIPT = `<script>document.cookie = "${BOT_COOKIE}=1; Path=/; SameSite=Lax";</script>`;
const CHALLENGE_PAGE = "<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser.</body></html>";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const html = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

const redirect = (status: 302 | 303, location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { location, ...headers } });

const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });

function readCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

const b64url = (value: string) => Buffer.from(value).toString("base64url");
const randomId = () => crypto.randomUUID().replaceAll("-", "");

/** A JWT-shaped access token. The signature is fake; the fixture only checks that it issued the token. */
function makeToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { jti: randomId(), sub: USER.personRef, account_ref: USER.accountRef, person_ref: USER.personRef, iat: now, exp: now + 3600 };
  return [b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })), b64url(JSON.stringify(claims)), b64url("fixture-signature")].join(".");
}

function noteForm(drift: Drift | null): NoteForm {
  if (drift === "write-shape") return { ...NOTE_FORM, arg: "body" };
  if (drift === "ui-change") return { ...NOTE_FORM, label: "Skriv en besked", button: "Gem" };
  return NOTE_FORM;
}

/** `control`: serve POST /__drift?name=<drift|none> (the command-line server turns it on). */
export function startFixtureSite(opts: { port?: number; auth: Auth; control?: boolean; anonymous?: boolean }): FixtureSite {
  const { auth } = opts;
  let drift: Drift | null = null;
  let anonymous = opts.anonymous ?? false;
  const store = newStore();
  const log: RequestLogEntry[] = [];
  const sessions = new Set<string>(); // login: session ids behind the session cookie
  const tokens = new Map<string, string>(); // login: bearer → session id
  const refreshTokens = new Map<string, string>(); // login: refresh token → session id; each is used once
  const codes = new Map<string, string>(); // login: one-time sign-in code → session id
  const csrfTokens = new Set<string>(); // none: issued CSRF tokens
  const idpSessions = new Set<string>(); // login: sign-ins the login host remembers (IDP_COOKIE)
  let signInBlocked = false;
  let siteUrl = "";
  let loginUrl = "";

  const sessionOf = (req: Request): string | undefined => {
    const sid = readCookies(req)[SESSION_COOKIE];
    return sid && sessions.has(sid) ? sid : undefined;
  };

  /** Login mode: the request must carry a known session cookie AND a bearer issued for that session. */
  const loggedIn = (req: Request) => {
    const sid = sessionOf(req);
    const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    return !!sid && !!bearer && tokens.get(bearer) === sid;
  };

  /** Public mode: the x-csrf-token header must equal the csrf cookie the front page issued. */
  const csrfOk = (req: Request) => {
    const cookie = readCookies(req)[CSRF_COOKIE];
    return !!cookie && csrfTokens.has(cookie) && req.headers.get("x-csrf-token") === cookie;
  };

  /**
   * Gate shared by every data API (/graphql, /api/invoices*): outage switches first, then auth.
   * Like many real sites, a signed-out REST read is redirected to sign-in, while GraphQL answers 401.
   * `asAnonymous`: the caller serves a signed-out request as an anonymous user instead (serveAnonymous).
   */
  const gate = (req: Request, rest: boolean, asAnonymous = false): Response | null => {
    if (drift === "auth") return failure(401, "UNAUTHENTICATED", "Authentication required.");
    // Like a real wall, the cookie alone is not enough (copied into a plain request it would be): the
    // request must also come from a browser, which sends Sec-Fetch-* headers a page cannot set.
    if (drift === "bot-wall" && (readCookies(req)[BOT_COOKIE] !== "1" || !req.headers.get("sec-fetch-mode"))) return html(403, CHALLENGE_PAGE);
    if (drift === "server-error") return failure(500, "INTERNAL_SERVER_ERROR", "Something went wrong.");
    if (drift === "rate-limit") return failure(429, "RATE_LIMITED", "Too many requests.");
    if (asAnonymous) return null;
    if (auth === "login" && rest && !sessionOf(req)) return redirect(302, `${loginUrl}/login`);
    if (auth === "login" && !loggedIn(req)) return failure(401, "UNAUTHENTICATED", "Authentication required.");
    if (auth === "none" && !csrfOk(req)) return failure(403, "CSRF", "Missing or invalid CSRF token.");
    return null;
  };

  const graphql = async (req: Request, entry: RequestLogEntry): Promise<Response> => {
    let body: { operationName?: unknown; query?: unknown; variables?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(400, { errors: [{ message: "Body must be JSON.", extensions: { code: "BAD_REQUEST" } }] });
    }
    const operationName = typeof body.operationName === "string" ? body.operationName : undefined;
    entry.operationName = operationName;
    // serveAnonymous: an anonymous user sees no account.
    const anon = auth === "login" && anonymous && !loggedIn(req);
    const blocked = gate(req, false, anon);
    if (blocked) return blocked;
    if (anon) return json(200, { data: null, errors: [{ message: "Not found.", extensions: { code: "NOT_FOUND" } }] });

    const errors = (status: number, list: GraphQLError[]) => json(status, { errors: list });
    if (typeof body.query !== "string") return errors(400, [{ message: "Missing query.", extensions: { code: "BAD_REQUEST" } }]);
    let ops;
    try {
      ops = parse(body.query);
    } catch (e) {
      if (e instanceof GraphQLFailure) return errors(400, [{ message: e.message, extensions: { code: e.code } }]);
      throw e;
    }
    const op = operationName ? ops.find((o) => o.name === operationName) : ops.length === 1 ? ops[0] : undefined;
    if (!op) return errors(400, [{ message: "Unknown operation.", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }]);

    const schema = buildSchema({ withoutPrice: drift === "graphql-validation", noteArg: noteForm(drift).arg });
    const invalid = validate(schema, op);
    if (invalid.length) return errors(400, invalid);

    const variables = (body.variables && typeof body.variables === "object" ? body.variables : {}) as Record<string, unknown>;
    const missing = checkVariables(op, variables);
    if (missing.length) return errors(400, missing);
    if (drift === "input-rejected" && op.variables.length) {
      const first = op.variables[0]!;
      return errors(400, [
        { message: `Variable "$${first.name}" got invalid value; Expected type "${first.type}".`, extensions: { code: "BAD_USER_INPUT" } },
      ]);
    }

    const result = await execute(schema, op, variables, { store, customerId: auth === "login" ? USER.customerId : null });
    const subs = result.data?.listSubscriptions;
    if (Array.isArray(subs)) {
      for (const s of subs as Record<string, unknown>[]) {
        if (drift === "rename-field" && "status" in s) {
          s.state = s.status;
          delete s.status;
        }
        if (drift === "type-change" && typeof s.price === "number") s.price = s.price.toFixed(2);
      }
    }
    return json(200, result);
  };

  const invoices = (req: Request, url: URL): Response => {
    // serveAnonymous: a signed-out read sees no invoices, as an anonymous user would.
    const anon = auth === "login" && anonymous && !loggedIn(req);
    const blocked = gate(req, true, anon);
    if (blocked) return blocked;
    if (drift === "input-rejected") return failure(400, "BAD_USER_INPUT", "Request parameters were rejected.");
    const id = url.pathname.match(/^\/api\/invoices\/([^/]+)$/)?.[1];
    const visible = anon ? [] : INVOICES;
    if (id !== undefined) {
      if (drift === "remove-rest") return failure(404, "NOT_FOUND", "No such route.");
      const invoice = visible.find((i) => i.id === decodeURIComponent(id));
      return invoice ? json(200, invoice) : failure(404, "NOT_FOUND", "Invoice not found.");
    }
    if (url.searchParams.get("accountId") !== ACCOUNT.id) return failure(400, "BAD_USER_INPUT", "Unknown or missing accountId.");
    return json(200, { invoices: visible.map(({ lines: _lines, ...summary }) => summary), total: visible.length });
  };

  /** Login host: a finished sign-in hands a one-time code back to the site, which turns it into a session. */
  const signedIn = (): Response => {
    const sid = randomId();
    const code = randomId();
    sessions.add(sid);
    codes.set(code, sid);
    const idp = randomId();
    idpSessions.add(idp);
    const res = redirect(303, `${siteUrl}/auth/callback?code=${code}`);
    res.headers.append("set-cookie", `${IDP_COOKIE}=${idp}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    return res;
  };

  const handleLoginHost = async (req: Request, route: string, url: URL): Promise<Response> => {
    if (route === "GET /login") {
      // Already signed in at the login host: no new sign-in is needed, so blockSignIn does not stop it.
      const idp = readCookies(req)[IDP_COOKIE];
      if (idp && idpSessions.has(idp)) return signedIn();
      if (signInBlocked) return html(200, loginPage("Log ind er midlertidigt lukket."));
      return url.searchParams.get("autologin") === "1" ? signedIn() : html(200, loginPage());
    }
    if (route === "POST /u/flow/begin") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    if (route === "POST /login") {
      if (signInBlocked) return html(503, loginPage("Log ind er midlertidigt lukket."));
      const form = await req.formData().catch(() => null);
      const ok = form?.get("username") === USER.username && form?.get("password") === USER.password;
      return ok ? signedIn() : html(401, loginPage("Forkert brugernavn eller adgangskode."));
    }
    return failure(404, "NOT_FOUND", "No such route.");
  };

  const handleSite = async (req: Request, route: string, url: URL, entry: RequestLogEntry): Promise<Response> => {
    if (route === "GET /") {
      const page = html(200, accountPage(auth, noteForm(drift)) + (drift === "bot-wall" ? BOT_SCRIPT : ""));
      if (auth === "login") return sessionOf(req) ? page : redirect(302, `${loginUrl}/login`);
      const existing = readCookies(req)[CSRF_COOKIE];
      if (existing && csrfTokens.has(existing)) return page;
      const token = randomId();
      csrfTokens.add(token);
      page.headers.set("set-cookie", `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict`);
      return page;
    }
    if (route === "GET /favicon.ico") return new Response(null, { status: 204 });
    if (route === "POST /graphql") return graphql(req, entry);
    if (req.method === "GET" && /^\/api\/invoices(\/[^/]+)?$/.test(url.pathname)) return invoices(req, url);

    if (auth === "login") {
      // Who is signed in, as a frontend asks on load: 401 without a session, also under serveAnonymous.
      if (route === "GET /api/me") return loggedIn(req) ? json(200, { signedIn: true }) : failure(401, "UNAUTHENTICATED", "Authentication required.");
      if (route === "GET /auth/callback") {
        const code = url.searchParams.get("code") ?? "";
        const sid = codes.get(code);
        codes.delete(code);
        if (!sid || !sessions.has(sid)) return redirect(302, `${loginUrl}/login`);
        const res = redirect(303, "/");
        res.headers.append("set-cookie", `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
        // Readable by the frontend, which keys its cached token to this login session.
        res.headers.append("set-cookie", `${HINT_COOKIE}=${randomId()}; Path=/; SameSite=Lax; Max-Age=86400`);
        return res;
      }
      if (route === "POST /oauth/token") {
        // JSON from the frontend, a form from an OAuth client: grant_type login_cookie (the login session's
        // cookie) or refresh_token (a refresh token, rotated: each works once, with the client id).
        const raw = await req.text();
        let body: Record<string, unknown> = {};
        try {
          body = (req.headers.get("content-type") ?? "").includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
        } catch {}
        let sid: string | undefined;
        if (body.grant_type === "refresh_token") {
          const old = String(body.refresh_token ?? "");
          sid = refreshTokens.get(old);
          if (!sid || body.client_id !== OAUTH_CLIENT_ID || !sessions.has(sid)) return json(400, { error: "invalid_grant" });
          refreshTokens.delete(old);
        } else {
          sid = sessionOf(req);
          if (!sid) return failure(401, "UNAUTHENTICATED", "No login session.");
        }
        const token = makeToken();
        tokens.set(token, sid);
        const refresh = randomId();
        refreshTokens.set(refresh, sid);
        return json(200, { access_token: token, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
      }
      if (route === "POST /api/session/post-login") {
        if (!loggedIn(req)) return failure(401, "UNAUTHENTICATED", "Authentication required.");
        const body = (await req.json().catch(() => null)) as { accountRef?: unknown; personRef?: unknown } | null;
        if (body?.accountRef !== USER.accountRef || body?.personRef !== USER.personRef)
          return failure(403, "FORBIDDEN", "Claims do not match the token.");
        return json(200, {
          personalInfo: { customerId: USER.customerId, cpr: USER.cpr, email: USER.email, phone: null },
          segments: ["residential"],
        });
      }
    }
    return failure(404, "NOT_FOUND", "No such route.");
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    if (opts.control && route === "POST /__drift" && url.origin === siteUrl) {
      const name = url.searchParams.get("name") ?? "";
      if (name !== "none" && !DRIFTS.includes(name as Drift)) return json(400, { error: `name must be none or one of ${DRIFTS.join(", ")}` });
      drift = name === "none" ? null : (name as Drift);
      return json(200, { drift });
    }
    const entry: RequestLogEntry = { method: req.method, host: url.host, path: url.pathname };
    log.push(entry);
    if (url.origin === loginUrl) return auth === "login" ? handleLoginHost(req, route, url) : failure(404, "NOT_FOUND", "No such route.");
    return handleSite(req, route, url, entry);
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      handle(req).catch((e: unknown) => {
        console.error(e);
        return failure(500, "INTERNAL_SERVER_ERROR", "Fixture site crashed.");
      }),
  });
  siteUrl = `http://127.0.0.1:${server.port}`;
  loginUrl = loginOriginFor(siteUrl);

  return {
    url: siteUrl,
    loginUrl,
    auth,
    setDrift(name) {
      if (name !== null && !DRIFTS.includes(name)) throw new Error(`unknown drift "${name}", expected one of ${DRIFTS.join(", ")}`);
      drift = name;
    },
    revokeTokens: () => {
      tokens.clear();
      refreshTokens.clear();
    },
    expireAccessTokens: () => tokens.clear(),
    revokeSessions: () => {
      sessions.clear();
      idpSessions.clear();
      tokens.clear();
      refreshTokens.clear();
      codes.clear();
    },
    blockSignIn: (blocked) => {
      signInBlocked = blocked;
    },
    serveAnonymous: (on) => {
      anonymous = on;
    },
    notes: () => structuredClone(store.notes),
    requests: () => structuredClone(log),
    stop: () => void server.stop(true),
  };
}

export { ACCOUNT, INVOICES, SUBSCRIPTIONS, USER };

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const usage = (problem: string): never => {
    console.error(
      `${problem}\nusage: bun fixtures/site/server.ts --auth login|none [--port N] [--drift ${DRIFTS.join("|")}] [--anonymous]\n` +
        "while it runs: curl -X POST '<url>/__drift?name=<drift|none>' switches Drift without signing anyone out",
    );
    process.exit(2);
  };
  const auth = flag("auth");
  if (auth !== "login" && auth !== "none") usage("--auth must be login or none");
  const port = flag("port") === undefined ? undefined : Number(flag("port"));
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) usage("--port must be a port number");
  const drift = flag("drift");
  if (drift !== undefined && !DRIFTS.includes(drift as Drift)) usage(`unknown drift "${drift}"`);
  const anonymous = args.includes("--anonymous");
  if (anonymous && auth !== "login") usage("--anonymous needs --auth login");
  const site = startFixtureSite({ auth: auth as Auth, port, control: true, anonymous });
  if (drift) site.setDrift(drift as Drift);
  console.log(JSON.stringify({ url: site.url, loginUrl: site.loginUrl, auth, drift: drift ?? null, anonymous, control: `POST ${site.url}/__drift?name=<drift|none>` }));
}
