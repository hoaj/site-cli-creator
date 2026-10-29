// transport "browser" (SPEC §7): every request leaves from a tab of the user's Chrome open on the
// origin, so the site sees Chrome's own TLS, headers and cookies, including those its scripts set.
// browserTransport().fetch stands in for fetch in Deps: the Client builds, classifies and parses
// exactly as with plain fetch, and site hooks get it as ctx.fetch. One Chrome per run, opened on the
// first request, in memory: the session (session.json) is the sign-in, as with plain fetch, and
// the CLI's profile/ stays the login's alone. close() ends it (main at the end of a run and after
// each MCP tool call, the Client around a sign-in).
import type { BrowserContext, Page, Response as PlaywrightResponse } from "playwright-core";
import { Failure } from "./envelope";
import { closeContext, launchInMemory } from "./login";
import { effectiveOrigin, isTest, type Env, type Fetch, type Site } from "./site";

export type BrowserTransport = { fetch: Fetch; close(): Promise<void> };

const PAGE_TIMEOUT_MS = 30_000;
/** How long the front page may keep loading after `load` (a challenge that reloads, late scripts). */
const SETTLE_MS = 5_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** How long a response event may trail the page's answer. */
const EVENT_MS = 2_000;
/** How often a GET is sent again when the page navigated away while it was in flight. */
const NAVIGATION_RETRIES = 2;
/** Headers Chrome sets itself and a page may not; the cookie jar supplies cookies. */
const BROWSER_OWNED = /^(cookie2?|host|origin|referer|user-agent|content-length|connection|keep-alive|accept-encoding|accept-charset|te|trailer|transfer-encoding|upgrade|via|expect|date|dnt|proxy-.*|sec-.*)$/i;
const NULL_BODY = new Set([101, 204, 205, 304]);

type PageAnswer = { redirect: true } | { status: number; url: string; headers: [string, string][]; body: string } | { error: string };

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
    context = await launchInMemory(site, headless, env, undefined, { blockServiceWorkers: true });
    await setCookies(context, origin, cookieHeader);
    const page = await context.newPage();
    options.note(`opening ${origin} in Chrome${headless ? " (headless)" : ""}; requests go from that tab`);
    await page.goto(`${origin}/`, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS });
    // A challenge page often sets its cookie and reloads after `load`: let it finish first.
    await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
    if (new URL(page.url()).origin !== new URL(origin).origin) {
      // The front page led elsewhere (a login host): fetch still needs a page on the origin, so this
      // one is answered locally and reaches no one.
      await page.route(`${origin}/`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title></title>" }), { times: 1 });
      await page.goto(`${origin}/`, { timeout: PAGE_TIMEOUT_MS });
    }
    // The session's cookies win over what the front page set, as they do with plain fetch.
    await setCookies(context, origin, cookieHeader);
    return page;
  }

  const fetch: Fetch = async (input, init = {}) => {
    const source = input instanceof Request ? input : undefined;
    const url = new URL(source ? source.url : String(input)).href;
    const sent = new Headers(source?.headers);
    new Headers(init.headers).forEach((v, k) => sent.set(k, v));
    const method = (init.method ?? source?.method ?? "GET").toUpperCase();
    const raw = init.body !== undefined ? init.body : source && method !== "GET" && method !== "HEAD" ? await source.text() : undefined;
    const body = requestBody(raw, sent);
    const redirect = init.redirect ?? "follow";

    let page: Page;
    try {
      opening ??= open(sent.get("cookie") ?? undefined);
      page = await opening;
    } catch (e) {
      await close();
      if (e instanceof Failure) throw e; // Chrome is missing
      throw transportError("page");
    }
    const headers: Record<string, string> = {};
    sent.forEach((v, k) => {
      if (!BROWSER_OWNED.test(k)) headers[k] = v;
    });

    for (let attempt = 0; ; attempt++) {
      // Chrome's view of every response: the page cannot read Set-Cookie or a manual redirect's Location.
      const seen = new Map<string, PlaywrightResponse>();
      const onResponse = (r: PlaywrightResponse) => {
        if (r.request().resourceType() === "fetch") seen.set(r.url(), r);
      };
      page.on("response", onResponse);
      let answer: PageAnswer;
      try {
        answer = await page.evaluate(
          async ({ url, method, headers, body, redirect, timeout }) => {
            try {
              const r = await globalThis.fetch(url, { method, headers, body, redirect, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(timeout) });
              if (r.type === "opaqueredirect") return { redirect: true as const };
              const pairs: [string, string][] = [];
              r.headers.forEach((v, k) => pairs.push([k, v]));
              return { status: r.status, url: r.url, headers: pairs, body: await r.text() };
            } catch (e) {
              return { error: e instanceof Error ? e.name : "error" };
            }
          },
          { url, method, headers, body, redirect, timeout: REQUEST_TIMEOUT_MS },
        );
        const finalUrl = "redirect" in answer ? url : "url" in answer ? answer.url : undefined;
        if (finalUrl && !seen.has(finalUrl)) {
          await page.waitForEvent("response", { predicate: (r) => r.url() === finalUrl, timeout: EVENT_MS }).then(onResponse, () => {});
        }
      } catch {
        page.off("response", onResponse);
        if (page.isClosed()) {
          await close(); // the tab is gone: the next request opens a new one
          throw transportError("tab");
        }
        // The page navigated while the request was in flight (a reload, a redirect of its own). A GET
        // is safe to send again once it has loaded; anything else may have reached the site.
        await page.waitForLoadState("load", { timeout: PAGE_TIMEOUT_MS }).catch(() => {});
        if ((method === "GET" || method === "HEAD") && attempt < NAVIGATION_RETRIES) continue;
        throw transportError("navigated");
      }
      page.off("response", onResponse);

      if ("error" in answer) throw transportError(answer.error);
      if ("redirect" in answer) {
        const r = seen.get(url);
        const location = r?.headers().location;
        if (!r || !location) throw transportError("redirect");
        return new Response(null, { status: r.status(), headers: { location } });
      }
      // Chrome's own headers when it reported them (Set-Cookie included), else what the page saw.
      const reported = seen.get(answer.url);
      const out = new Headers();
      if (reported) for (const h of await reported.headersArray()) out.append(h.name, h.value);
      else for (const [k, v] of answer.headers) out.append(k, v);
      return new Response(NULL_BODY.has(answer.status) ? null : answer.body, { status: answer.status, headers: out });
    }
  };

  return { fetch, close };
}

/** A body the page can send: text, or a form (URLSearchParams, typed as fetch would). */
function requestBody(raw: unknown, headers: Headers): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  if (raw instanceof URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return raw.toString();
  }
  throw new TypeError(`transport "browser" sends text and URLSearchParams bodies only`);
}

/** The cookies of a session's cookie header, set on the origin (path /), replacing any of the same name. */
async function setCookies(context: BrowserContext, origin: string, header: string | undefined): Promise<void> {
  if (!header) return;
  const cookies = header
    .split(";")
    .map((part) => part.trim())
    .map((part) => {
      const eq = part.indexOf("=");
      return eq > 0 ? { name: part.slice(0, eq), value: part.slice(eq + 1), url: `${origin}/` } : null;
    })
    .filter((c): c is { name: string; value: string; url: string } => c !== null);
  if (cookies.length) await context.addCookies(cookies);
}
