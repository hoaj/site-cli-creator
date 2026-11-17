// Plain fetch looks like the user's own browser by default (#111): the user-agent of the Chrome
// installed here and an accept-language, each only when the request has none of its own.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardFetch } from "../src/runtime/never";
import { makeSite } from "./helpers";
import { acceptLanguage, browserUserAgent, installedChromeVersion, withBrowserHeaders, withSiteHeaders } from "../src/runtime/browser-headers";

const seen: Headers[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    seen.push(req.headers);
    return new Response("ok");
  },
});
afterAll(() => server.stop(true));
const last = () => seen.at(-1)!;

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("browserUserAgent", () => {
  test("Chrome's reduced user-agent for each OS: the installed major version, 0.0.0 after it", () => {
    expect(browserUserAgent("141.0.7390.55", "darwin")).toBe(MAC);
    expect(browserUserAgent("141.0.7390.55", "win32")).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");
    expect(browserUserAgent("141.0.7390.55", "linux")).toBe("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");
  });
  test("never says Bun, and names a Chrome even when none is installed", () => {
    expect(browserUserAgent(undefined, "linux")).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  });
});

describe("acceptLanguage", () => {
  test("the user's locale first, then its language, then English", () => {
    expect(acceptLanguage("da-DK")).toBe("da-DK,da;q=0.9,en;q=0.8");
    expect(acceptLanguage("en-US")).toBe("en-US,en;q=0.9");
    expect(acceptLanguage("en")).toBe("en;q=0.9");
    expect(acceptLanguage(undefined)).toBe("en-US,en;q=0.9");
    // A browser sends language[-region]: a Unicode extension or a script subtag is cut (review).
    expect(acceptLanguage("da-DK-u-ca-gregory")).toBe("da-DK,da;q=0.9,en;q=0.8");
    expect(acceptLanguage("en-US-u-hc-h23")).toBe("en-US,en;q=0.9");
    expect(acceptLanguage("zh-Hant-TW")).toBe("zh-TW,zh;q=0.9,en;q=0.8");
  });
});

describe("withBrowserHeaders", () => {
  const wrapped = withBrowserHeaders((input, init) => fetch(input, init), { userAgent: () => MAC, acceptLanguage: () => "da-DK,da;q=0.9,en;q=0.8" });

  test("adds the user-agent and accept-language a request lacks", async () => {
    await wrapped(server.url.href);
    expect(last().get("user-agent")).toBe(MAC);
    expect(last().get("accept-language")).toBe("da-DK,da;q=0.9,en;q=0.8");
  });

  test("keeps the request's own, in any case, from a plain object, Headers or a Request", async () => {
    await wrapped(server.url.href, { headers: { "User-Agent": "mine/1", "Accept-Language": "fr" } });
    expect(last().get("user-agent")).toBe("mine/1");
    expect(last().get("accept-language")).toBe("fr");
    await wrapped(server.url.href, { headers: new Headers({ "user-agent": "mine/2" }) });
    expect(last().get("user-agent")).toBe("mine/2");
    expect(last().get("accept-language")).toBe("da-DK,da;q=0.9,en;q=0.8");
    await wrapped(new Request(server.url.href, { headers: { "user-agent": "mine/3", accept: "application/json" } }));
    expect(last().get("user-agent")).toBe("mine/3");
    expect(last().get("accept")).toBe("application/json");
  });

  test("reads the user-agent and accept-language only for a request that lacks them", async () => {
    let asked = 0;
    const lazy = withBrowserHeaders((input, init) => fetch(input, init), { userAgent: () => (asked++, MAC), acceptLanguage: () => (asked++, "fr") });
    await lazy(server.url.href, { headers: { "user-agent": "a", "accept-language": "b" } });
    expect(asked).toBe(0);
    await lazy(server.url.href, { headers: { "user-agent": "a" } });
    expect(asked).toBe(1);
  });

  test("changes nothing else: method, body, other headers, redirect mode", async () => {
    const res = await wrapped(server.url.href, { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded", "x-one": "1" }, redirect: "manual" });
    expect(res.status).toBe(200);
    expect(last().get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(last().get("x-one")).toBe("1");
  });
});

describe("installedChromeVersion", () => {
  const dir = mkdtempSync(join(tmpdir(), "chrome-version-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("macOS: the app's Info.plist", () => {
    const app = join(dir, "Google Chrome.app", "Contents");
    mkdirSync(join(app, "MacOS"), { recursive: true });
    writeFileSync(join(app, "MacOS", "Google Chrome"), "");
    writeFileSync(join(app, "Info.plist"), "<dict><key>CFBundleShortVersionString</key>\n\t<string>141.0.7390.55</string></dict>");
    expect(installedChromeVersion({ SITE_CLI_CHROME: join(app, "MacOS", "Google Chrome") }, "darwin")).toBe("141.0.7390.55");
  });

  test("Windows: the highest version folder beside chrome.exe", () => {
    const app = join(dir, "win");
    for (const v of ["9.0.1.2", "141.0.7390.55", "141.0.7390.9"]) mkdirSync(join(app, v), { recursive: true });
    writeFileSync(join(app, "chrome.exe"), "");
    expect(installedChromeVersion({ SITE_CLI_CHROME: join(app, "chrome.exe") }, "win32")).toBe("141.0.7390.55");
  });

  test.skipIf(process.platform === "win32")("Linux: what `chrome --version` prints", () => {
    const bin = join(dir, "chrome");
    writeFileSync(bin, "#!/bin/sh\necho 'Google Chrome 141.0.7390.55 '\n");
    chmodSync(bin, 0o755);
    expect(installedChromeVersion({ SITE_CLI_CHROME: bin }, "linux")).toBe("141.0.7390.55");
  });

  test("undefined when Chrome is missing or says nothing useful", () => {
    expect(installedChromeVersion({ SITE_CLI_CHROME: join(dir, "nope") }, "linux")).toBeUndefined();
    const bin = join(dir, "mute");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    if (process.platform !== "win32") expect(installedChromeVersion({ SITE_CLI_CHROME: bin }, "linux")).toBeUndefined();
  });
});

describe("withSiteHeaders", () => {
  const origin = server.url.origin;
  const wrapped = withSiteHeaders((input, init) => fetch(input, init), { "x-requested-with": "XMLHttpRequest", referer: `${origin}/` }, origin);

  test("adds the site's headers to its origin, from a string, a relative path or a Request; the request's own win", async () => {
    await wrapped(server.url.href);
    expect(last().get("x-requested-with")).toBe("XMLHttpRequest");
    await wrapped(new Request(server.url.href, { headers: { referer: "mine" } }));
    expect(last().get("referer")).toBe("mine");
    expect(last().get("x-requested-with")).toBe("XMLHttpRequest");
    await wrapped(server.url.href, { headers: { "X-Requested-With": "own" } });
    expect(last().get("x-requested-with")).toBe("own");
  });

  test("a fetch the guard already wrapped stays guarded as it is, so a Client built on another's deps does not guard twice (review)", () => {
    const site = makeSite({ never: [{ method: "DELETE", path: "/account", why: "test" }] });
    const guarded = guardFetch(site, (input, init) => fetch(input, init));
    const wrapped = withSiteHeaders(guarded, { "x-requested-with": "XMLHttpRequest" }, server.url.origin);
    expect(guardFetch(site, wrapped)).toBe(wrapped);
  });

  test("a malformed call rejects, as fetch does, instead of throwing before a .catch can see it (review 3)", async () => {
    await expect(wrapped("http://[bad")).rejects.toBeDefined();
    const ua = withBrowserHeaders(() => Promise.resolve(new Response("ok")), { userAgent: () => { throw new Error("boom"); }, acceptLanguage: () => "en" });
    await expect(ua(server.url.href)).rejects.toThrow("boom");
  });

  test("never to another origin", async () => {
    const other = Bun.serve({ port: 0, fetch: (req) => (seen.push(req.headers), new Response("ok")) });
    try {
      await wrapped(other.url.href);
      expect(last().get("x-requested-with")).toBeNull();
    } finally {
      other.stop(true);
    }
  });
});
