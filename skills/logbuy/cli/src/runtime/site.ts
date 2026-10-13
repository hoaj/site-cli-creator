// The site config every CLI skill declares in src/site.ts.
import type { Call } from "./command";
import type { Account } from "./envelope";

export type Auth = "login" | "none";
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What postLogin, bootstrap and accounts get. Ids are chain-root ids, never personal data. */
export type SiteCtx = {
  fetch: Fetch;
  origin: string;
  headers: Record<string, string>;
  ids: Record<string, string>;
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
  timeoutMs?: number;
  /** Derives chain-root ids after login. Returns ids to store, never personal data. */
  postLogin?: (ctx: SiteCtx) => Promise<Record<string, string>>;
};

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
  const ro = site.readOnlyRequests;
  if (ro !== undefined && (!Array.isArray(ro) || ro.some((p) => !(typeof p === "string" && p !== "") && !(p instanceof RegExp)))) {
    out.push("readOnlyRequests must be a list of non-empty URL path substrings or RegExps");
  }
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

export function isLoginHost(site: Site, url: string): boolean {
  try {
    const { host, hostname } = new URL(url);
    return (site.login?.hosts ?? []).some((h) => host === h || hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
