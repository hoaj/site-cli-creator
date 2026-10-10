// `selftest --url <http url> [--no-chrome]`: a hidden built-in (not in `help`) for the platform
// smoke test in CI (SPEC §9): a plain fetch, then Google Chrome launched headless on a temporary
// profile with channel "chrome", one request routed and aborted (net::ERR_FAILED). Prints the
// HTTP status and true/false per step, never a response body.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeLaunchOptions, findChrome, installHint } from "./chrome";
import { Failure } from "./envelope";
import type { Env, Fetch } from "./site";

export type SelftestOptions = { url?: string; chrome: boolean; fetch: Fetch; env: Env };
export type SelftestResult = { ok: true; fetch: number; chrome?: true; abort?: true };

const ABORT_PATH = "/__selftest_abort__";

export async function selftest(options: SelftestOptions): Promise<SelftestResult> {
  const url = parseUrl(options.url);
  let status: number;
  try {
    const res = await options.fetch(url, { redirect: "manual" });
    status = res.status;
    await res.body?.cancel().catch(() => {});
  } catch (e) {
    throw new Failure("network", `selftest: fetch failed (${(e as { code?: string })?.code || (e as Error)?.name || "error"}).`);
  }
  if (!options.chrome) return { ok: true, fetch: status };

  const chrome = findChrome(options.env);
  if (!chrome.path) throw new Failure("input", `selftest: Google Chrome was not found (looked at ${chrome.checked.join(", ") || "no known path on this OS"}). ${installHint()}`);
  const profile = mkdtempSync(join(tmpdir(), "selftest-"));
  const { chromium } = await import("playwright-core");
  const context = await chromium.launchPersistentContext(profile, { ...chromeLaunchOptions(chrome), headless: true });
  try {
    const target = new URL(ABORT_PATH, url).toString();
    let routed = false;
    await context.route(`**${ABORT_PATH}`, (route) => {
      routed = true;
      return route.abort("failed");
    });
    const page = context.pages()[0] ?? (await context.newPage());
    let error = "";
    try {
      await page.goto(target, { timeout: 30_000 });
    } catch (e) {
      error = (e as Error).message;
    }
    if (!routed || !error.includes("net::ERR_FAILED")) {
      throw new Error(`selftest: the routed request was not aborted with net::ERR_FAILED (routed: ${routed})`);
    }
    return { ok: true, fetch: status, chrome: true, abort: true };
  } finally {
    await context.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

function parseUrl(raw: string | undefined): string {
  if (!raw) throw new Failure("input", "selftest needs --url <http(s) url>");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Failure("input", "selftest: --url must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Failure("input", "selftest: --url must be an http(s) URL");
  return url.toString();
}
