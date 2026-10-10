// Sign-in through the user's Chrome on the tool-owned profile (SPEC §7). Headed for `login`,
// headless for the silent refresh. Under SITE_CLI_TEST=1 the headed sign-in runs headless too.
import type { BrowserContext, Request } from "playwright-core";
import { findChrome, chromeLaunchOptions, installHint } from "./chrome";
import { ContractError, Failure } from "./envelope";
import { ensureStateDir, profileDir, stateDir } from "./session";
import { effectiveOrigin, isLoginHost, isTest, rebase, tokenMatches, type Env, type Site } from "./site";

const REFRESH_TIMEOUT_MS = 30_000;
/** How long a headless refresh may sit on a login host before it counts as logged out (SSO hops pass through). */
const LOGIN_HOST_GRACE_MS = 5_000;

export type LoginOptions = { headless: boolean; env?: Env; note?: (m: string) => void };

export function chromeMissing(site: Site, env: Env = process.env): Failure | null {
  const chrome = findChrome(env);
  if (chrome.path) return null;
  const kind = site.auth === "login" ? "session" : "input";
  return new Failure(kind, `Google Chrome was not found (looked at ${chrome.checked.join(", ") || "no known path on this OS"}). ${installHint()}`);
}

export async function launch(site: Site, userDataDir: string, headless: boolean, env: Env = process.env): Promise<BrowserContext> {
  const missing = chromeMissing(site, env);
  if (missing) throw missing;
  const { chromium } = await import("playwright-core");
  return chromium.launchPersistentContext(userDataDir, {
    ...chromeLaunchOptions(findChrome(env)),
    headless,
    baseURL: effectiveOrigin(site, env),
    viewport: headless ? { width: 1280, height: 900 } : null,
  });
}

/**
 * How long a sign-in may take: site.login.timeoutMs (10 min by default) for the headed login, at
 * most 30 s for the headless refresh. Under SITE_CLI_TEST=1, env SITE_CLI_LOGIN_TIMEOUT_MS
 * replaces site.login.timeoutMs, so tests of a sign-in that never completes don't wait 10 minutes.
 */
export function loginTimeoutMs(site: Site, headless: boolean, env: Env = process.env): number {
  const override = isTest(env) ? Number(env.SITE_CLI_LOGIN_TIMEOUT_MS) : NaN;
  const configured = Number.isFinite(override) && override > 0 ? override : site.login?.timeoutMs;
  return headless ? Math.min(REFRESH_TIMEOUT_MS, configured ?? REFRESH_TIMEOUT_MS) : configured ?? 600_000;
}

/** Returns the captured authorization + cookie headers, or null when sign-in didn't complete. */
export async function chromeLogin(site: Site, options: LoginOptions): Promise<Record<string, string> | null> {
  const env = options.env ?? process.env;
  const login = site.login;
  if (!login) throw new ContractError(`site.ts has auth "login" but no login block`);
  const headless = options.headless || isTest(env);
  const timeoutMs = loginTimeoutMs(site, options.headless, env);
  const origin = effectiveOrigin(site, env);
  const profile = ensureStateDir(profileDir(ensureStateDir(stateDir(site, env))));
  const context = await launch(site, profile, headless, env);
  try {
    const done = new Promise<Request | "logged-out" | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = (v: Request | "logged-out" | null) => {
        clearTimeout(timer);
        clearTimeout(grace);
        resolve(v);
      };
      context.on("close", () => finish(null));
      context.on("request", async (req) => {
        if (!tokenMatches(login.tokenRequest, req.url())) return;
        const headers = await req.allHeaders().catch(() => req.headers());
        if (headers.authorization) finish(req);
      });
      context.on("response", async (res) => {
        if (!tokenMatches(login.tokenRequest, res.url()) || res.status() < 200 || res.status() >= 300) return;
        const headers = await res.request().allHeaders().catch(() => res.request().headers());
        if (!headers.authorization) finish(res.request());
      });
      if (options.headless) {
        context.on("framenavigated", (frame) => {
          if (frame.parentFrame()) return;
          clearTimeout(grace);
          if (isLoginHost(site, frame.url())) grace = setTimeout(() => finish("logged-out"), LOGIN_HOST_GRACE_MS);
        });
      }
    });
    const page = context.pages()[0] ?? (await context.newPage());
    page.goto(rebase(login.startUrl, site, env)).catch(() => {});
    if (!options.headless) options.note?.(`waiting for sign-in at ${login.startUrl} (up to ${Math.round(timeoutMs / 60_000)} min)`);
    const req = await done;
    if (!req || req === "logged-out") return null;
    const sent = await req.allHeaders().catch(() => req.headers());
    const headers: Record<string, string> = {};
    if (sent.authorization) headers.authorization = sent.authorization;
    const cookies = await context.cookies([origin]).catch(() => []);
    const jar = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    if (jar) headers.cookie = jar;
    else if (sent.cookie) headers.cookie = sent.cookie;
    return headers;
  } finally {
    await context.close().catch(() => {});
  }
}
