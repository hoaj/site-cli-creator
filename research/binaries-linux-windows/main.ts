import { chromium } from "playwright-core";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELP = {
  name: "binaries-linux-windows",
  commands: { help: "print this JSON", test: "run fetch + Chrome launch + route.abort checks (default)" },
};

if (process.argv[2] === "help") {
  console.log(JSON.stringify(HELP, null, 2));
  process.exit(0);
}

const summary: Record<string, unknown> = {
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  help: HELP,
};
const errors: string[] = [];
const step = async (name: string, fn: () => Promise<unknown>) => {
  try {
    summary[name] = await fn();
  } catch (e) {
    summary[name] = { error: String((e as Error)?.stack ?? e) };
    errors.push(name);
  }
};

// Mirrors the per-OS lookup in playwright-core 1.63.0 _createChromiumChannel("chrome").
function chromeCandidates(): string[] {
  if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  if (process.platform === "linux") return ["/opt/google/chrome/chrome"];
  const e = process.env;
  return [
    e.LOCALAPPDATA,
    e.PROGRAMFILES,
    e["PROGRAMFILES(X86)"],
    e.HOMEDRIVE && `${e.HOMEDRIVE}\\Program Files`,
    e.HOMEDRIVE && `${e.HOMEDRIVE}\\Program Files (x86)`,
  ]
    .filter(Boolean)
    .map((p) => `${p}\\Google\\Chrome\\Application\\chrome.exe`);
}

await step("fetch", async () => {
  const res = await fetch("https://example.com");
  const body = await res.text();
  if (!res.ok || !body.includes("Example Domain")) throw new Error(`bad response ${res.status}`);
  return { status: res.status, bytes: body.length };
});

await step("chrome", async () => {
  const candidates = chromeCandidates();
  const found = candidates.find((p) => existsSync(p)) ?? null;
  let bundledExecutablePath: string;
  try {
    bundledExecutablePath = chromium.executablePath();
  } catch (e) {
    bundledExecutablePath = `error: ${(e as Error).message}`;
  }
  return { candidates, found, bundledExecutablePath };
});

await step("launch", async () => {
  const profile = mkdtempSync(join(tmpdir(), "bin-test-profile-"));
  const t0 = Date.now();
  const ctx = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true, timeout: 60_000 });
  try {
    const launchMs = Date.now() - t0;
    const version = ctx.browser()?.version() ?? null;
    const aborted: string[] = [];
    await ctx.route("**/*", (route) => {
      const url = route.request().url();
      if (url.includes("example.com")) {
        aborted.push(url);
        return route.abort();
      }
      return route.continue();
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.setContent("<p id=x>ok</p>");
    const text = await page.textContent("#x");
    let gotoError: string | null = null;
    try {
      await page.goto("https://example.com", { timeout: 30_000 });
    } catch (e) {
      gotoError = (e as Error).message.split("\n")[0];
    }
    if (text !== "ok") throw new Error(`setContent check failed: ${text}`);
    if (aborted.length < 1 || !gotoError?.includes("net::ERR_FAILED")) {
      throw new Error(`abort not confirmed: aborted=${aborted.length} gotoError=${gotoError}`);
    }
    return { profile, launchMs, version, aborted, gotoError };
  } finally {
    await ctx.close();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
});

summary.ok = errors.length === 0;
summary.failed = errors;
console.log(JSON.stringify(summary, null, 2));
process.exit(errors.length ? 1 : 0);
