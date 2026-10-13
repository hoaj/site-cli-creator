// Real Chrome against a local site: sign-in capture and check --writes interception.
// Skipped where Google Chrome is not installed (or SITE_CLI_SKIP_BROWSER=1).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { chromeWriteChecker } from "../src/runtime/check";
import { chromeLaunchOptions, findChrome } from "../src/runtime/chrome";
import { chromeLogin } from "../src/runtime/login";
import { defineOperation } from "../src/runtime/operation";
import { selftest } from "../src/runtime/selftest";
import { profileDir } from "../src/runtime/session";
import { makeSite, tempHome } from "./helpers";

const skip = !findChrome().path || process.env.SITE_CLI_SKIP_BROWSER === "1";
const home = tempHome();
const received: string[] = [];
/** The GraphQL documents the site received, by operationName or "?" . */
const graphqlReceived: string[] = [];

const page = (script: string) =>
  new Response(`<!doctype html><html><body><button id="save">Save</button><script>${script}</script></body></html>`, {
    headers: { "content-type": "text/html", "set-cookie": "sid=abc; Path=/" },
  });

const loginHost = Bun.serve({ port: 0, fetch: () => new Response("<form>sign in</form>", { headers: { "content-type": "text/html" } }) });
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    received.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/account")
      return page(`fetch("/graphql", { method: "POST", headers: { authorization: "Bearer tok-1", "content-type": "application/json" }, body: JSON.stringify({ operationName: "me", query: "query me { me { id } }" }) });`);
    if (url.pathname === "/logged-out") return Response.redirect(`${loginHost.url.origin}/login`, 302);
    if (url.pathname === "/orders")
      return page(`
        document.getElementById("save").onclick = async () => {
          await fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationName: "orderPage", query: "query orderPage { x }" }) });
          fetch("/api/track", { method: "POST", body: "{}" }).catch(() => {});
          const body = location.hash === "#changed" ? { title: "New" } : { name: "New" };
          fetch("/api/orders/5", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
        };`);
    // Data loads through a persisted GraphQL query (no query text): the button appears only once it answers.
    if (url.pathname === "/loaded-orders")
      return page(`
        const save = document.getElementById("save");
        save.hidden = true;
        fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationName: "orderList", extensions: { persistedQuery: { sha256Hash: "h" } } }) })
          .then((r) => r.json()).then((j) => { if (j.data) save.hidden = false; });
        save.onclick = () => fetch("/api/orders/5", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "New" }) }).catch(() => {});`);
    // The page refreshes its token and runs a post-login step (read-only POSTs) before the button appears.
    if (url.pathname === "/refresh-orders")
      return page(`
        const save = document.getElementById("save");
        save.hidden = true;
        fetch("/api/track", { method: "POST", body: "{}" }).catch(() => {});
        Promise.all([
          fetch("/api/token", { method: "POST" }).then((r) => r.json()),
          fetch("/api/session/post-login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json()),
        ]).then(() => { save.hidden = false; });
        save.onclick = () => fetch("/api/orders/5", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "New" }) }).catch(() => {});`);
    // A service worker that answers every fetch itself: its requests must be intercepted too.
    if (url.pathname === "/sw.js")
      return new Response(
        `self.addEventListener("install", (e) => self.skipWaiting());
         self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
         self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));`,
        { headers: { "content-type": "text/javascript" } },
      );
    if (url.pathname === "/sw-orders")
      return page(`
        const ready = () => (window.swReady = true);
        navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready)
          .then(() => (navigator.serviceWorker.controller ? ready() : navigator.serviceWorker.addEventListener("controllerchange", ready)));
        document.getElementById("save").onclick = () => fetch("/api/orders/5", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "New" }) }).catch(() => {});`);
    // A form post (fetch with URLSearchParams sends application/x-www-form-urlencoded).
    if (url.pathname === "/form-orders")
      return page(`
        document.getElementById("save").onclick = () => fetch("/api/orders/5", { method: "PATCH", body: new URLSearchParams({ name: "New" }) }).catch(() => {});`);
    // Before the write, the page sends mutations a first-definition test misses: a fragment first,
    // a query first with operationName selecting the mutation, and a persisted mutation (hash only).
    if (url.pathname === "/sneaky-orders")
      return page(`
        const gql = (body) => fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
        document.getElementById("save").onclick = async () => {
          await gql({ operationName: "fragFirst", query: "fragment F on Order { id }\\nmutation fragFirst { cancelOrder { ...F } }" });
          await gql({ operationName: "selected", query: "query other { x }\\nmutation selected { cancelOrder { id } }" });
          await gql({ operationName: "hashOnly", extensions: { persistedQuery: { sha256Hash: "h" } } });
          await gql({ operationName: "plainQuery", query: "fragment F on Order { id }\\nquery plainQuery { order { ...F } }" });
          fetch("/api/orders/5", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "New" }) }).catch(() => {});
        };`);
    if (url.pathname === "/graphql") {
      if (req.method === "POST") graphqlReceived.push((await req.clone().json().catch(() => ({}))).operationName ?? "?");
      return Response.json({ data: { ok: true } });
    }
    return Response.json({ ok: true });
  },
});

afterAll(() => {
  server.stop(true);
  loginHost.stop(true);
  home.cleanup();
});

const site = () =>
  makeSite({
    origin: server.url.origin,
    auth: "login",
    needsChrome: true,
    login: { startUrl: `${server.url.origin}/account`, hosts: [loginHost.url.host], tokenRequest: "/graphql" },
  });

describe.skipIf(skip)("Chrome", () => {
  test("login captures the authorization header and cookies (SITE_CLI_TEST runs it headless)", async () => {
    const headers = await chromeLogin(site(), { headless: false, env: { SITE_CLI_TEST: "1", SITE_CLI_HOME: home.dir } });
    expect(headers).toEqual({ authorization: "Bearer tok-1", cookie: "sid=abc" });
    expect(existsSync(profileDir(home.dir))).toBe(true);
  }, 60_000);

  test("login --from-profile writes no cookie into the CLI's own profile: nothing but session.json (review)", async () => {
    const source = tempHome();
    const fresh = tempHome();
    try {
      const { chromium } = await import("playwright-core");
      const seeded = await chromium.launchPersistentContext(source.dir, { ...chromeLaunchOptions(findChrome()), headless: true });
      await seeded.addCookies([{ name: "seeded_sid", value: "seeded-value", url: server.url.origin, expires: Math.floor(Date.now() / 1000) + 3600 }]);
      await seeded.close();
      const headers = await chromeLogin(site(), { headless: true, fromProfile: source.dir, env: { SITE_CLI_HOME: fresh.dir } });
      expect(headers?.cookie).toContain("seeded_sid=seeded-value");
      const files = (dir: string): string[] =>
        existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])) : [];
      const holding = files(profileDir(fresh.dir)).filter((f) => basename(f).startsWith("Cookies") && readFileSync(f).includes("seeded_sid"));
      expect(holding).toEqual([]);
    } finally {
      source.cleanup();
      fresh.cleanup();
    }
  }, 60_000);

  test("headless refresh that lands on a login host returns null (logged out)", async () => {
    const s = site();
    s.login!.startUrl = `${server.url.origin}/logged-out`;
    expect(await chromeLogin(s, { headless: true, env: { SITE_CLI_HOME: home.dir } })).toBeNull();
  }, 60_000);

  const rename = (trigger: (p: any) => Promise<void>) =>
    defineOperation({
      name: "PATCH /api/orders/:orderId",
      effect: "write",
      rest: { method: "PATCH", path: "/api/orders/:orderId", body: (v) => ({ name: v.name }) },
      variables: z.object({ orderId: z.string(), name: z.string() }),
      response: z.object({ ok: z.boolean() }),
      trigger,
    });

  test("check --writes intercepts the write, compares its shape and aborts every write", async () => {
    received.length = 0;
    const s = makeSite({ origin: server.url.origin });
    const ok = rename(async (p) => {
      await p.goto("/orders");
      await p.click("#save");
    });
    const changed = defineOperation({ ...ok, trigger: async (p) => { await p.goto("/orders#changed"); await p.click("#save"); } });
    const missing = defineOperation({ ...ok, trigger: async (p) => { await p.goto("/orders"); await p.click("#gone", { timeout: 500 }); } });
    const checker = chromeWriteChecker(s, { SITE_CLI_HOME: home.dir });

    expect((await checker([ok], [])).get(ok.name)).toBeNull();
    const drift = (await checker([changed], [])).get(ok.name)!;
    expect(drift.fingerprint).toBe("acme:shop:PATCH /api/orders/{orderId}:request:name:invalid_type");
    expect(JSON.stringify(drift)).not.toContain("New");
    // The trigger Drift names the step that failed: the locator it waited for (Contract code, no user data).
    const gone = (await checker([missing], [])).get(ok.name)!;
    expect(gone.fingerprint).toBe("acme:shop:PATCH /api/orders/{orderId}:trigger:locator('#gone'):TimeoutError");
    expect(gone.diff).toEqual([{ path: "locator('#gone')", code: "TimeoutError" }]);

    expect(received).toContain("POST /graphql");
    expect(received.filter((r) => r.startsWith("PATCH") || r === "POST /api/track")).toEqual([]);
  }, 90_000);

  test("check --writes lets declared reads through, so a page that loads through POST still renders", async () => {
    received.length = 0;
    const s = makeSite({ origin: server.url.origin });
    const orderList = defineOperation({
      name: "orderList",
      effect: "read",
      graphql: "query orderList { orderList { id } }",
      variables: z.object({}),
      response: z.object({ data: z.unknown() }),
    });
    const op = rename(async (p) => {
      await p.goto("/loaded-orders");
      await p.click("#save", { timeout: 3_000 });
    });
    const checker = chromeWriteChecker(s, { SITE_CLI_HOME: home.dir });
    expect((await checker([op], [orderList])).get(op.name)).toBeNull();
    expect(received).toContain("POST /graphql");
    // Without the read declared, the persisted query might write, so it is aborted and the page never renders.
    expect((await checker([op], [])).get(op.name)!.fingerprint).toBe("acme:shop:PATCH /api/orders/{orderId}:trigger:locator('#save'):TimeoutError");
    expect(received.filter((r) => r.startsWith("PATCH"))).toEqual([]);
  }, 90_000);

  test("check --writes lets the tokenRequest and readOnlyRequests through, and still aborts undeclared writes", async () => {
    received.length = 0;
    const login = { startUrl: `${server.url.origin}/account`, hosts: [loginHost.url.host], tokenRequest: "/api/token" };
    const op = rename(async (p) => {
      await p.goto("/refresh-orders");
      await p.click("#save", { timeout: 3_000 });
    });
    const env = { SITE_CLI_HOME: home.dir };
    const declared = makeSite({ origin: server.url.origin, auth: "login", needsChrome: true, login, readOnlyRequests: ["/api/session/post-login"] });
    expect((await chromeWriteChecker(declared, env)([op], [])).get(op.name)).toBeNull();
    expect(received).toContain("POST /api/token");
    expect(received).toContain("POST /api/session/post-login");
    expect(received.filter((r) => r.startsWith("PATCH") || r === "POST /api/track")).toEqual([]);

    // Without readOnlyRequests the post-login POST is aborted, the page never shows the button: trigger drift.
    received.length = 0;
    const undeclared = makeSite({ origin: server.url.origin, auth: "login", needsChrome: true, login });
    expect((await chromeWriteChecker(undeclared, env)([op], [])).get(op.name)!.fingerprint).toBe("acme:shop:PATCH /api/orders/{orderId}:trigger:locator('#save'):TimeoutError");
    expect(received).not.toContain("POST /api/session/post-login");
    expect(received.filter((r) => r.startsWith("PATCH") || r === "POST /api/track")).toEqual([]);
  }, 90_000);

  test("check --writes reads a form post by its content-type: a form Contract passes, a JSON one drifts", async () => {
    received.length = 0;
    const s = makeSite({ origin: server.url.origin });
    const trigger = async (p: any) => {
      await p.goto("/form-orders");
      await p.click("#save");
    };
    const form = defineOperation({ ...rename(trigger), rest: { method: "PATCH", path: "/api/orders/:orderId", bodyType: "form", body: (v) => ({ name: v.name }) } });
    const checker = chromeWriteChecker(s, { SITE_CLI_HOME: home.dir });
    expect((await checker([form], [])).get(form.name)).toBeNull();
    const asJson = (await checker([rename(trigger)], [])).get(form.name)!;
    expect(asJson.fingerprint).toBe("acme:shop:PATCH /api/orders/{orderId}:request::body_type");
    expect(asJson.diff).toEqual([{ path: "", code: "body_type", expected: "json", received: "form" }]);
    expect(received.filter((r) => r.startsWith("PATCH"))).toEqual([]);
  }, 90_000);

  test("check --writes aborts a GraphQL mutation that is not the first definition, or sent as a hash, although tokenRequest matches /graphql", async () => {
    received.length = 0;
    graphqlReceived.length = 0;
    const op = rename(async (p) => {
      await p.goto("/sneaky-orders");
      await p.click("#save");
    });
    expect((await chromeWriteChecker(site(), { SITE_CLI_HOME: home.dir })([op], [])).get(op.name)).toBeNull();
    // Only the query got through; every mutation (and the write) was aborted.
    expect(graphqlReceived).toEqual(["plainQuery"]);
    expect(received.filter((r) => r.startsWith("PATCH"))).toEqual([]);
  }, 90_000);

  test("selftest: fetch, Chrome launch on a temp profile, and one request aborted with net::ERR_FAILED", async () => {
    received.length = 0;
    const out = await selftest({ url: `${server.url.origin}/`, chrome: true, fetch: (i, init) => fetch(i, init), env: {} });
    expect(out).toEqual({ ok: true, fetch: 200, chrome: true, abort: true });
    expect(received.filter((r) => r.includes("__selftest_abort__"))).toEqual([]);
  }, 60_000);

  test("check --writes intercepts writes a service worker sends", async () => {
    received.length = 0;
    const s = makeSite({ origin: server.url.origin });
    const op = rename(async (p) => {
      await p.goto("/sw-orders");
      await p.waitForFunction(() => (window as any).swReady === true);
      await p.click("#save");
    });
    expect((await chromeWriteChecker(s, { SITE_CLI_HOME: home.dir })([op], [])).get(op.name)).toBeNull();
    expect(received).toContain("GET /sw.js");
    expect(received.filter((r) => r.startsWith("PATCH"))).toEqual([]);
  }, 90_000);
});
