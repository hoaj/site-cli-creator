// The site config every CLI skill declares in src/site.ts.
import type { Call } from "./command";
import type { Account } from "./envelope";
import { selectorProblem } from "./html";
import { neverListProblems } from "./never";
import type { Method } from "./operation";

export type Auth = "login" | "none";
/**
 * How Operations reach the site. "fetch": from the CLI itself. "browser": from a tab of the user's
 * Chrome on the site, for a site that refuses requests that don't come from a browser (SPEC §7).
 */
export type Transport = "fetch" | "browser";
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What postLogin, bootstrap and accounts get. Ids are chain-root ids, never personal data. */
export type SiteCtx = {
  fetch: Fetch;
  origin: string;
  headers: Record<string, string>;
  ids: Record<string, string>;
  /** What login.refresh.keep kept (a refresh token, a client id); {} when nothing was. */
  refresh: Record<string, string>;
  /**
   * The cookies the site has set for this hook, by name: those ctx.fetch's answers set, and with
   * transport "browser" every cookie Chrome holds for the origin (its tab's page load may have taken
   * one already, so no answer sets it again). Read a CSRF cookie here, not from Set-Cookie.
   */
  cookies(): Promise<Record<string, string>>;
  decodeJwt(token: string): Record<string, unknown>;
  /** Performs one Operation with classification, like a command's ctx.call. */
  call: Call;
};

export type LoginConfig = {
  /** Page that leads to the site's login. */
  startUrl: string;
  /** Hosts that belong to the login flow; a redirect there means "logged out". */
  hosts: string[];
  /**
   * URL substring or RegExp. The first matching request that carries an authorization header,
   * or else the first 2xx response to a matching request, marks a finished login. For a
   * cookie-only site, pick a request that fails while signed out (such as /api/me), or a public
   * call before sign-in ends the login early.
   */
  tokenRequest: string | RegExp;
  /**
   * Path on the origin of a GET that answers 2xx only while signed in (such as /api/me). Set it
   * when the site serves an expired session as an anonymous user (200 with nothing in it, or 404)
   * instead of 401/403: the runtime sends it once per run before the first Operation, and any
   * answer other than 2xx (5xx and 429 aside) means "signed out", so it signs in again.
   */
  sessionProbe?: string;
  /**
   * Paths on the origin of the site's own sign-in page (`["/login"]`), for a site that answers an
   * expired session with a redirect to its own host instead of a login host. A redirect hop to one
   * of them (exact pathname, one trailing slash and any query or fragment ignored) means "signed
   * out", like a redirect to a host in `hosts`; so does a sessionProbe redirected there.
   */
  paths?: string[];
  /**
   * CSS selector of an element only a signed-out page has (the sign-in form, `form#login`), for a
   * site that answers an expired session with 200 and its sign-in form in place. Checked on an HTML
   * answer before `html.fields`, and on an HTML sessionProbe answer; a match means "signed out".
   * Never applied to a JSON answer.
   */
  signedOutSelector?: string;
  timeoutMs?: number;
  /** Derives chain-root ids after login. Returns ids to store, never personal data. */
  postLogin?: (ctx: SiteCtx) => Promise<Record<string, string>>;
  /**
   * Renews an expired session with plain fetch, as the site's frontend does with its refresh
   * token, before Chrome is tried (SPEC §7). Works where Chrome cannot run (remote mode).
   */
  refresh?: RefreshConfig;
};

export type RefreshConfig = {
  /**
   * URL substring or RegExp of a request the sign-in sends whose JSON answer carries the refresh
   * token (an OAuth token endpoint). Leave it out when the refresh token is a cookie the session's
   * cookie header already holds.
   */
  from?: string | RegExp;
  /**
   * Picks what renew needs from that request's body and its JSON answer (each parsed, or undefined):
   * the refresh token, a client id. Never personal data; saved in session.json as `refresh`.
   */
  keep?: (exchange: { request: unknown; response: unknown }) => Record<string, string>;
  /**
   * Trades ctx.refresh (and ctx.headers) for a new session with ctx.fetch. Returns every header to
   * send from now on, and `refresh` when the site rotated what keep kept; null when the refresh
   * token no longer works, so the CLI signs in with Chrome instead.
   */
  renew: (ctx: SiteCtx) => Promise<{ headers: Record<string, string>; refresh?: Record<string, string> } | null>;
};

/**
 * A request the CLI must never send (SPEC §6). `path` is a glob over the URL path (`*` is any run of
 * characters, `/` included; case-insensitive) with an optional `method` (else every method);
 * `graphql` is a GraphQL operation name, matched wherever a request carries it, and against every
 * mutation's root fields (case-insensitive: `PlaceOrder` also covers `mutation X { placeOrder }`). `why` says what the
 * request does and why the CLI never sends it ("Placing an order: the user always pays").
 */
export type NeverRule =
  | { method?: Method; path: string; graphql?: undefined; why: string }
  | { graphql: string; method?: undefined; path?: undefined; why: string };

export type SiteConfig = {
  plugin: string;
  skill: string;
  repo: string;
  version: string;
  generatedWith: string;
  origin: string;
  graphqlPath?: string;
  auth: Auth;
  needsChrome: boolean;
  /**
   * Whether the plugin repo's daily drift check (scripts/drift-check.ts, SPEC §10) runs this skill's read-only
   * `check`. add-skill asks and writes it; absent (a skill made before generator 0.18.0) counts as true. The CLI
   * itself never reads it.
   */
  dailyCheck?: boolean;
  /**
   * "browser" sends every Operation from a tab of Chrome open on the origin, so the site sees
   * Chrome's own TLS, headers and cookies, including those its scripts set (a bot wall's). Slower:
   * Chrome starts once per run. Leave it out (or "fetch") unless plain fetch is refused.
   */
  transport?: Transport;
  /**
   * transport "browser" only: run that Chrome as a window instead of headless, for a site that
   * refuses headless Chrome. The window opens on every run.
   */
  browserWindow?: boolean;
  /**
   * Headers sent with every request to the origin, under the session's and the Operation's own
   * (which win): what the page's own requests carry that plain fetch lacks (`x-requested-with`,
   * `sec-fetch-*`, `referer`, client hints). Never `cookie` or `authorization`: the session holds
   * those. Plain fetch already sends the user's Chrome's `user-agent` and an `accept-language`.
   */
  headers?: Record<string, string>;
  /** auth "login" only. */
  login?: LoginConfig;
  /** auth "none" only: fetches a cookie or CSRF token a public API needs; returns headers to send. */
  bootstrap?: (ctx: SiteCtx) => Promise<{ headers: Record<string, string>; ids?: Record<string, string> }>;
  /**
   * Non-GET requests the site's pages send that change no data (a token refresh, a post-login
   * call, analytics), so `check --writes` lets them through while a trigger runs. A string
   * matches as a substring of the URL path, a RegExp is tested against the whole URL. Every
   * other non-GET request is aborted during triggers. Never list a request that writes.
   */
  readOnlyRequests?: Array<string | RegExp>;
  /**
   * Requests the CLI never sends, whatever a command, a Contract or --confirm says: the runtime
   * refuses a match before it leaves (exit 1), check and regen refuse a Contract that matches, and
   * tests/never-sent.test.ts fails CI. The maintainer decides it (placing an order, paying, deleting
   * the account); regen lists it under SKILL.md's "When NOT to use".
   */
  never?: NeverRule[];
  /** Accounts under one login. [] or one account means no --account is needed. */
  accounts?: (ctx: SiteCtx) => Promise<Array<Account | string>>;
};

export type Site = SiteConfig;

export const defineSite = (site: SiteConfig): Site => site;

export type Env = Record<string, string | undefined>;

export const isTest = (env: Env = process.env) => env.SITE_CLI_TEST === "1";

/**
 * SITE_CLI_NONINTERACTIVE=1: no person can sign in in a Chrome window (a maintainer's agent,
 * a script). When the silent refresh fails, the CLI exits 4 at once instead of opening a
 * headed sign-in and waiting up to 10 minutes. `login` itself still opens Chrome.
 */
export const nonInteractive = (env: Env = process.env) => env.SITE_CLI_NONINTERACTIVE === "1";

/** The origin calls go to. Only tests may point it elsewhere (the fixture site on localhost). */
export function effectiveOrigin(site: Site, env: Env = process.env): string {
  const o = isTest(env) && env.SITE_CLI_ORIGIN ? env.SITE_CLI_ORIGIN : site.origin;
  return o.replace(/\/+$/, "");
}

/** A URL under site.origin, moved to the effective origin. */
export function rebase(url: string, site: Site, env: Env = process.env): string {
  const from = site.origin.replace(/\/+$/, "");
  const to = effectiveOrigin(site, env);
  const rest = url.slice(from.length);
  return url.startsWith(from) && /^(?:[/?#]|$)/.test(rest) ? to + rest : url;
}

/** Problems that make the config unusable; checked at startup, not in defineSite, so the starter file imports cleanly. */
export function siteProblems(site: Site): string[] {
  const out: string[] = [];
  if (site.auth !== "login" && site.auth !== "none") out.push(`auth must be "login" or "none"`);
  if (!/^https?:\/\//.test(site.origin)) out.push("origin must be an http(s) URL");
  if (site.auth === "login" && !site.login) out.push(`auth "login" needs a login block`);
  if (site.transport !== undefined && site.transport !== "fetch" && site.transport !== "browser") out.push(`transport must be "fetch" or "browser"`);
  else if (site.browserWindow && site.transport !== "browser") out.push(`browserWindow needs transport "browser"`);
  // A path only: the probe carries the session's headers, which must never go to another host.
  const probe = site.login?.sessionProbe;
  if (probe !== undefined && !(typeof probe === "string" && /^\/(?![/\\])/.test(probe))) {
    out.push("login.sessionProbe must be a path on the origin, starting with a single /");
  }
  const paths = site.login?.paths;
  if (paths !== undefined && !(Array.isArray(paths) && paths.every((p) => typeof p === "string" && /^\/(?![/\\])/.test(p)))) {
    out.push("login.paths must be a list of paths on the origin, each starting with a single /");
  }
  const sel = site.login?.signedOutSelector;
  if (sel !== undefined) {
    if (typeof sel !== "string" || sel.trim() === "") out.push("login.signedOutSelector must be a non-empty CSS selector");
    else {
      const bad = selectorProblem(sel);
      if (bad !== undefined) out.push(`login.signedOutSelector is not a CSS selector the parser reads (${bad})`);
    }
  }
  const refresh = site.login?.refresh;
  if (refresh !== undefined) {
    if (typeof refresh?.renew !== "function") out.push("login.refresh needs a renew function");
    const from = refresh?.from;
    if (from !== undefined && !(typeof from === "string" && from !== "") && !(from instanceof RegExp)) {
      out.push("login.refresh.from must be a non-empty URL path substring or a RegExp");
    } else if (from instanceof RegExp && (from.global || from.sticky)) {
      out.push("login.refresh.from must be a RegExp without the g or y flag (its test() would skip matches)");
    } else if (from !== undefined && typeof refresh.keep !== "function") out.push("login.refresh.from needs a keep function");
  }
  const h = site.headers;
  if (h !== undefined) {
    if (typeof h !== "object" || h === null || Object.getPrototypeOf(h) !== Object.prototype || Object.entries(h).some(([k, v]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || typeof v !== "string")) {
      out.push("headers must be a map of header names to string values");
    } else {
      const seen = new Set<string>();
      for (const [name, value] of Object.entries(h)) {
        const key = name.toLowerCase();
        if (key === "cookie" || key === "authorization") out.push(`headers must not set ${key}: the session holds it`);
        else if (/^(content-type|content-length|content-encoding|content-language|content-location|host|connection|keep-alive|transfer-encoding|te|upgrade|proxy-.*)$/.test(key)) out.push(`headers must not set ${key}: the request or fetch sets it`);
        if (seen.has(key)) out.push(`headers names ${key} twice (header names are not case-sensitive)`);
        seen.add(key);
        // The Fetch standard's header value: no NUL, CR or LF, and Latin-1 only (Bun strips or passes some of these silently).
        if (/[\0\r\n]|[^\x00-\xff]/.test(value)) out.push(`headers.${name} is not a value fetch can send (no line breaks, no characters beyond Latin-1)`);
      }
    }
  }
  const ro = site.readOnlyRequests;
  if (ro !== undefined && (!Array.isArray(ro) || ro.some((p) => !(typeof p === "string" && p !== "") && !(p instanceof RegExp)))) {
    out.push("readOnlyRequests must be a list of non-empty URL path substrings or RegExps");
  }
  out.push(...neverListProblems(site.never));
  return out;
}

export function decodeJwt(token: string): Record<string, unknown> {
  const part = token.replace(/^Bearer\s+/i, "").split(".")[1];
  if (!part) throw new Error("not a JWT");
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

export function tokenMatches(pattern: string | RegExp, url: string): boolean {
  return typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
}

/**
 * The site's domain: the origin's host name without `www.`. It and its subdomains are the site's
 * hosts, the ones the generator's Capture tool records (`api.example.com` for `www.example.com`).
 */
export function siteDomain(origin: string): string {
  return new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
}

/** Whether a host name is on the site's domain (siteDomain): the domain itself or a subdomain. */
export function onSiteDomain(domain: string, host: string): boolean {
  const h = host.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

/** A host name from a login host entry (`login.example.com`, `localhost:4100`, or a URL). */
export function loginHostName(entry: string): string {
  try {
    return new URL(entry.includes("://") ? entry : `http://${entry}`).hostname.toLowerCase();
  } catch {
    return entry.toLowerCase();
  }
}

export function isLoginHost(site: Site, url: string): boolean {
  try {
    const { host, hostname } = new URL(url);
    return (site.login?.hosts ?? []).some((h) => host === h || hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * A path as login.paths compares it: without its query or fragment, without a `;parameter` on the last segment
 * (`/login;jsessionid=A1`), without one trailing slash (`/login/` is `/login`; `/` stays), percent-escapes in capitals.
 */
function plainPath(path: string): string {
  let p = path.replace(/[?#].*$/s, "").replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p.replace(/;[^/]*$/, "") || "/";
}

/**
 * Whether `url` (already resolved, so a relative Location works) is on `origin` and its pathname is
 * one of login.paths: the exact path, so `/login` is not `/login-help`.
 */
export function isLoginPath(site: Site, url: URL, origin: string): boolean {
  const paths = site.login?.paths;
  if (!Array.isArray(paths) || paths.length === 0) return false;
  let on: string;
  try {
    on = new URL(origin).origin;
  } catch {
    return false;
  }
  if (url.origin !== on) return false;
  const here = plainPath(url.pathname);
  // An entry is compared as the URL parser writes it, so `/log-på` and a space match what a Location carries (`%C3%A5`, `%20`).
  return paths.some((p) => {
    try {
      return typeof p === "string" && plainPath(new URL(p, on).pathname) === here;
    } catch {
      return false;
    }
  });
}
