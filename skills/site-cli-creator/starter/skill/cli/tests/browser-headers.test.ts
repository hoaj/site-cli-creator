// Plain fetch looks like the user's own browser by default (#111): the user-agent of the Chrome
// installed here and an accept-language, each only when the request has none of its own.
import { afterAll, describe, expect, test } from "bun:test";
import { acceptLanguage, browserUserAgent, withBrowserHeaders } from "../src/runtime/browser-headers";

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

  test("changes nothing else: method, body, other headers, redirect mode", async () => {
    const res = await wrapped(server.url.href, { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded", "x-one": "1" }, redirect: "manual" });
    expect(res.status).toBe(200);
    expect(last().get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(last().get("x-one")).toBe("1");
  });
});
