// Sign-in through the user's Chrome on the tool-owned profile (SPEC §7). Headed for `login`,
// headless for the silent refresh. Under SITE_CLI_TEST=1 the headed sign-in runs headless too.
import { existsSync } from "node:fs";
import type { BrowserContext, Cookie, Request } from "playwright-core";
import { chromeLaunchOptions, chromeNotFound, findChrome } from "./chrome";
import { ContractError, Failure, ProfileUnavailable } from "./envelope";
import { ensureProfileDir } from "./session";
import { effectiveOrigin, isLoginHost, isTest, loginHostName, onSiteDomain, rebase, siteDomain, tokenMatches, type Env, type Site } from "./site";

const REFRESH_TIMEOUT_MS = 30_000;
/** How long a headless refresh may sit on a login host before it counts as logged out (SSO hops pass through). */
const LOGIN_HOST_GRACE_MS = 5_000;

export type LoginOptions = {
  headless: boolean;
  env?: Env;
  note?: (m: string) => void;
  /**
   * Another Chrome profile that is already signed in (the Capture tool's): its cookies for the
   * site's hosts and the login hosts seed this sign-in, in memory only, so the user signs in once.
   * The sign-in then runs in a Chrome context that keeps nothing on disk, not in the CLI's profile.
   */
  fromProfile?: string;
};

/**
 * Whether a cookie, by its domain, belongs to the site: what `login --from-profile` carries over.
 * The hosts are the ones the runtime and the Capture tool treat as the site's: a host on the
 * origin's domain (`api.example.com` for `www.example.com`, as the Capture records it), a login
 * host or its subdomain (isLoginHost), or a parent domain of either (`.example.com`).
 */
export function siteCookie(site: Site, cookieDomain: string, env: Env = process.env): boolean {
  const cookieHost = cookieDomain.replace(/^\./, "").toLowerCase();
  const origin = effectiveOrigin(site, env);
  const domain = siteDomain(origin);
  if (onSiteDomain(domain, cookieHost) || isLoginHost(site, `http://${cookieHost}`)) return true;
  const hosts = [new URL(origin).hostname, ...(site.login?.hosts ?? []).map(loginHostName)];
  return hosts.some((h) => onSiteDomain(cookieHost, h));
}

/** What another Chrome profile holds for the site, in Playwright's storageState form. */
export type ProfileState = { cookies: Cookie[]; origins: { origin: string; localStorage: { name: string; value: string }[] }[] };

/**
 * What another Chrome profile holds for the site, read with Playwright and kept in memory: never
 * written, never logged. `cookies`: those for the site origin and its login hosts. Chrome keeps only
 * persistent cookies between runs, so a sign-in held in session cookies does not carry over.
 * `origins`: with `localStorage`, the origin's localStorage (where many frontends cache their
 * token), read on a page whose every request is answered locally, so nothing reaches the site.
 */
export async function profileState(site: Site, dir: string, env: Env = process.env, options: { localStorage?: boolean } = {}): Promise<ProfileState> {
  if (!existsSync(dir)) throw new ProfileUnavailable(`--from-profile: no such Chrome profile dir: ${dir}`);
  let context: BrowserContext;
  try {
    context = await launch(site, dir, true, env);
  } catch (error) {
    if (error instanceof Failure) throw error;
    const why = String((error as Error)?.message ?? error).split("\n")[0];
    throw new ProfileUnavailable(`--from-profile: could not open ${dir} (${why}). If a Capture is still running on it, end it first.`);
  }
  try {
    const cookies = (await context.cookies()).filter((c) => siteCookie(site, c.domain, env));
    if (!options.localStorage) return { cookies, origins: [] };
    const origin = new URL(effectiveOrigin(site, env)).origin;
    await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
    const page = await context.newPage();
    try {
      await page.goto(origin);
      const localStorage = await page.evaluate(() => Object.entries(window.localStorage).map(([name, value]) => ({ name, value })));
      return { cookies, origins: localStorage.length ? [{ origin, localStorage }] : [] };
    } finally {
      await page.close().catch(() => {});
      await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
  }
}

export function chromeMissing(site: Site, env: Env = process.env): Failure | null {
  const chrome = findChrome(env);
  if (chrome.path) return null;
  const kind = site.auth === "login" ? "session" : "input";
  return new Failure(kind, chromeNotFound(chrome));
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
 * Chrome with no user-data dir of the CLI's own (an incognito-style context) holding `state` (from
 * profileState()): another profile's sign-in, in memory only, gone when it closes. Close it with
 * closeContext(), which closes the browser too.
 */
export async function launchInMemory(site: Site, headless: boolean, env: Env = process.env, state?: ProfileState): Promise<BrowserContext> {
  const missing = chromeMissing(site, env);
  if (missing) throw missing;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ ...chromeLaunchOptions(findChrome(env)), headless });
  try {
    return await browser.newContext({ baseURL: effectiveOrigin(site, env), viewport: headless ? { width: 1280, height: 900 } : null, storageState: state });
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/** Closes a context from launch() or launchInMemory(), and the browser launchInMemory() started. */
export async function closeContext(context: BrowserContext): Promise<void> {
  await context.close().catch(() => {});
  await context.browser()?.close().catch(() => {});
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
  const seed = options.fromProfile ? (await profileState(site, options.fromProfile, env)).cookies : [];
  if (options.fromProfile) {
    if (seed.length === 0) return null;
    options.note?.(`signing in with ${seed.length} cookie(s) from ${options.fromProfile} (kept in memory)`);
  }
  // Seeded cookies stay in memory: the sign-in runs in a context with no profile on disk.
  const context = seed.length
    ? await launchInMemory(site, headless, env, { cookies: seed, origins: [] })
    : await launch(site, ensureProfileDir(site, env), headless, env);
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
    await closeContext(context);
  }
}
