// transport "browser" (SPEC §7): every request leaves from a tab of the user's Chrome open on the
// origin, so the site sees Chrome's own TLS, headers and cookies, including those its scripts set.
// browserTransport().fetch stands in for fetch in Deps: the Client builds, classifies and parses
// exactly as with plain fetch. One Chrome per run, opened on the first request; close() ends it
// (main at the end of a run, the Client before a sign-in, which needs the same profile).
import { existsSync } from "node:fs";
import type { BrowserContext, Page, Response as PlaywrightResponse } from "playwright-core";
import { Failure } from "./envelope";
import { closeContext, launch, launchInMemory } from "./login";
import { ensureProfileDir, loadSession, stateDir } from "./session";
import { effectiveOrigin, isTest, type Env, type Fetch, type Site } from "./site";

export type BrowserTransport = { fetch: Fetch; close(): Promise<void> };

const PAGE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** How long a redirect's response event may trail the page's answer. */
const REDIRECT_EVENT_MS = 2_000;
/** Headers Chrome sets itself and a page may not; the cookie jar supplies cookies. */
const BROWSER_OWNED = /^(cookie2?|host|origin|referer|user-agent|content-length|connection|keep-alive|accept-encoding|accept-charset|te|trailer|transfer-encoding|upgrade|via|expect|date|dnt|proxy-.*|sec-.*)$/i;
const NULL_BODY = new Set([101, 204, 205, 304]);

type PageAnswer = { redirect: true } | { status: number; headers: [string, string][]; body: string } | { error: string };

/** A transport failure the Client reports as network after its retries, like a refused connection. */
const transportError = (code: string) => Object.assign(new Error(`browser request failed: ${code}`), { code: `browser-${code}` });

export function browserTransport(site: Site, options: { env: Env; note(message: string): void }): BrowserTransport {
  const { env } = options;
  const origin = effectiveOrigin(site, env);
  let context: BrowserContext | null = null;
  let opening: Promise<Page> | null = null;

  async function close(): Promise<void> {
    const c = context;
    context = null;
    opening = null;
    if (c) await closeContext(c);
  }

  async function open(cookieHeader: string | undefined): Promise<Page> {
    const headless = !site.browserWindow || isTest(env);
    // A login's sign-in lives in the CLI's own profile. Otherwise (auth none, or a sign-in carried
    // over with login --from-profile, kept in memory) this Chrome keeps nothing on disk.
    const fromProfile = loadSession(stateDir(site, env))?.fromProfile;
    const own = site.auth === "login" && !(fromProfile && existsSync(fromProfile));
    context = own
      ? await launch(site, ensureProfileDir(site, env), headless, env, { blockServiceWorkers: true })
      : await launchInMemory(site, headless, env, undefined, { blockServiceWorkers: true });
    await seedCookies(context, `${origin}/`, cookieHeader);
    const page = context.pages()[0] ?? (await context.newPage());
    options.note(`opening ${origin} in Chrome${headless ? " (headless)" : ""}; requests go from that tab`);
    await page.goto(`${origin}/`, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS });
    if (new URL(page.url()).origin !== new URL(origin).origin) {
      // The front page led elsewhere (a login host): fetch still needs a page on the origin, so this
      // one is answered locally and reaches no one.
      await page.route(`${origin}/`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title></title>" }), { times: 1 });
      await page.goto(`${origin}/`, { timeout: PAGE_TIMEOUT_MS });
    }
    return page;
  }

  const fetch: Fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input)).href;
    const sent = new Headers(init.headers);
    let page: Page;
    try {
      opening ??= open(sent.get("cookie") ?? undefined);
      page = await opening;
    } catch (e) {
      await close();
      if (e instanceof Failure) throw e; // Chrome is missing
      throw transportError("page");
    }
    if (context) await seedCookies(context, url, sent.get("cookie") ?? undefined);
    const headers: Record<string, string> = {};
    sent.forEach((v, k) => {
      if (!BROWSER_OWNED.test(k)) headers[k] = v;
    });
    const body = typeof init.body === "string" ? init.body : undefined;

    let redirect: { status: number; location: string } | undefined;
    const seen = (r: PlaywrightResponse) => {
      const location = r.headers().location;
      if (r.url() === url && r.status() >= 300 && r.status() < 400 && location) redirect = { status: r.status(), location };
    };
    page.on("response", seen);
    let answer: PageAnswer;
    try {
      answer = await page.evaluate(
        async ({ url, method, headers, body, timeout }) => {
          try {
            const r = await globalThis.fetch(url, { method, headers, body, credentials: "include", redirect: "manual", signal: AbortSignal.timeout(timeout) });
            if (r.type === "opaqueredirect") return { redirect: true as const };
            const pairs: [string, string][] = [];
            r.headers.forEach((v, k) => pairs.push([k, v]));
            return { status: r.status, headers: pairs, body: await r.text() };
          } catch (e) {
            return { error: e instanceof Error ? e.name : "error" };
          }
        },
        { url, method: init.method ?? "GET", headers, body, timeout: REQUEST_TIMEOUT_MS },
      );
      if ("redirect" in answer && !redirect) {
        await page.waitForEvent("response", { predicate: (r) => r.url() === url && r.status() >= 300 && r.status() < 400, timeout: REDIRECT_EVENT_MS }).catch(() => {});
      }
    } catch {
      await close(); // the tab is gone (crashed, closed): the next request opens a new one
      throw transportError("tab");
    } finally {
      page.off("response", seen);
    }
    if ("error" in answer) throw transportError(answer.error);
    if ("redirect" in answer) {
      // Chrome hides a manual redirect from the page; its status and Location come from Playwright.
      if (!redirect) throw transportError("redirect");
      return new Response(null, { status: redirect.status, headers: { location: redirect.location } });
    }
    return new Response(NULL_BODY.has(answer.status) ? null : answer.body, { status: answer.status, headers: answer.headers });
  };

  return { fetch, close };
}

/**
 * Cookies a request carries in its cookie header (a session's) that the jar lacks for its URL: a
 * Session uploaded or carried over with login --from-profile has them only there. A cookie the jar
 * already holds wins, since the site may have renewed it.
 */
async function seedCookies(context: BrowserContext, url: string, header: string | undefined): Promise<void> {
  if (!header) return;
  const held = new Set((await context.cookies(url)).map((c) => c.name));
  const missing = header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq > 0 ? { name: part.slice(0, eq), value: part.slice(eq + 1) } : null;
    })
    .filter((c): c is { name: string; value: string } => c !== null && !held.has(c.name));
  if (missing.length) await context.addCookies(missing.map((c) => ({ ...c, url })));
}
