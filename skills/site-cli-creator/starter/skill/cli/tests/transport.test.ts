// transport "browser" (#93): Operations sent from a tab of real Chrome on the site, through main's run().
// Skipped where Google Chrome is not installed (or SITE_CLI_SKIP_BROWSER=1).
import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { run, type App } from "../src/main";
import { findChrome } from "../src/runtime/chrome";
import { defineCommand } from "../src/runtime/command";
import { defineOperation } from "../src/runtime/operation";
import { saveSession, stateDir } from "../src/runtime/session";
import { makeSite, tempHome } from "./helpers";

const skip = !findChrome().path || process.env.SITE_CLI_SKIP_BROWSER === "1";
const home = tempHome();
/** What the site received: method, path, and whether the page's own cookie and the bearer came along. */
const received: { method: string; path: string; jsCookie: boolean; bearer: string | null; body: string }[] = [];
const csrf = new Set<string>();
let issued = 0;
let counted = 0;

/** A one-page site of its own (its front page behaves differently from the shared server's). */
function miniSite(front: () => Response, api: (req: Request) => Response): ReturnType<typeof Bun.serve> {
  const s = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/" ? front() : api(req)) });
  minis.push(s);
  return s;
}
const minis: ReturnType<typeof Bun.serve>[] = [];
const cookieOf = (req: Request, name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1];

const loginHost = Bun.serve({ port: 0, fetch: () => new Response("<form>sign in</form>", { headers: { "content-type": "text/html" } }) });
const server = Bun.serve({
  port: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const jsCookie = /(?:^|;\s*)js_ok=1(?:;|$)/.test(req.headers.get("cookie") ?? "");
    received.push({ method: req.method, path: url.pathname, jsCookie, bearer: req.headers.get("authorization"), body: req.method === "GET" ? "" : await req.text() });
    // The page sets a cookie in JavaScript, as anti-bot scripts do; the API refuses requests without it.
    // Each load also issues a new CSRF cookie (Set-Cookie), which a bootstrap reads.
    if (url.pathname === "/") {
      const token = `t${++issued}`;
      csrf.add(token);
      return new Response(`<!doctype html><script>document.cookie = "js_ok=1; path=/";</script>`, { headers: { "content-type": "text/html", "set-cookie": `csrf=${token}; Path=/` } });
    }
    if (url.pathname === "/account") return Response.redirect(`${loginHost.url.origin}/login`, 302);
    // An ISO-8859-1 page whose only charset is in the page (#108): its bytes, not UTF-8 text.
    if (url.pathname === "/latin1") {
      const page = '<html><head><meta http-equiv="Content-Type" content="text/html;charset=iso-8859-1"/></head><body><ul><li>København</li><li>Århus</li></ul></body></html>';
      return new Response(Uint8Array.from([...page].map((c) => c.charCodeAt(0))), { headers: { "content-type": "text/html" } });
    }
    if (!jsCookie) return new Response("blocked", { status: 403 });
    if (url.pathname === "/api/csrf") {
      const cookie = /(?:^|;\s*)csrf=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
      return cookie && csrf.has(cookie) && req.headers.get("x-csrf-token") === cookie ? Response.json({ id: "c", total: 1 }) : new Response("csrf", { status: 403 });
    }
    if (url.pathname === "/api/form") return received.at(-1)!.body === "grant=x" ? Response.json({ ok: true }) : new Response("no body", { status: 400 });
    if (url.pathname === "/api/counter") return Response.json({ id: String(++counted), total: 0 }, { headers: { "cache-control": "max-age=300" } });
    if (url.pathname === "/api/old-orders/7") return Response.redirect(`${server.url.origin}/api/orders/7`, 302);
    if (url.pathname === "/api/orders/7" && req.method === "GET") return Response.json({ id: "7", total: 5 });
    if (url.pathname === "/api/orders/7" && req.method === "PATCH") return Response.json({ ok: true });
    if (url.pathname === "/api/me") return req.headers.get("authorization") === "Bearer tok-1" ? Response.json({ id: "u-1" }) : new Response("", { status: 401 });
    if (url.pathname === "/api/private") return Response.redirect(`${loginHost.url.origin}/login?next=private`, 302);
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  server.stop(true);
  loginHost.stop(true);
  for (const s of minis) s.stop(true);
  home.cleanup();
});

const getOrder = (path: string) =>
  defineOperation({
    name: `GET ${path}`,
    effect: "read",
    rest: { method: "GET", path },
    variables: z.object({}),
    response: z.object({ id: z.string(), total: z.number() }),
  });
const renameOrder = defineOperation({
  name: "PATCH /api/orders/7",
  effect: "write",
  rest: { method: "PATCH", path: "/api/orders/7", body: (v) => ({ name: v.name }) },
  variables: z.object({ name: z.string() }),
  response: z.object({ ok: z.boolean() }),
});
const getMe = defineOperation({ name: "GET /api/me", effect: "read", rest: { method: "GET", path: "/api/me" }, variables: z.object({}), response: z.object({ id: z.string() }) });
const getPrivate = defineOperation({ name: "GET /api/private", effect: "read", rest: { method: "GET", path: "/api/private" }, variables: z.object({}), response: z.object({ id: z.string() }) });

const getTowns = defineOperation({
  name: "GET /latin1",
  effect: "read",
  rest: { method: "GET", path: "/latin1" },
  html: { fields: { towns: { css: "li", all: true } } },
  variables: z.object({}),
  response: z.object({ towns: z.array(z.string()) }),
});

const show = (name: string, op: ReturnType<typeof getOrder>) =>
  defineCommand({ name, summary: name, args: z.object({}), uses: [op], run: async (_a, ctx) => ctx.call(op, {}) });
const ops = { current: getOrder("/api/orders/7"), old: getOrder("/api/old-orders/7"), csrf: getOrder("/api/csrf"), counter: getOrder("/api/counter"), sid: getOrder("/api/sid"), ok: getOrder("/api/ok") };
const commands = [
  show("order show", ops.current),
  show("old show", ops.old),
  show("csrf show", ops.csrf),
  show("sid show", ops.sid),
  show("ok show", ops.ok),
  defineCommand({ name: "counter twice", summary: "twice", args: z.object({}), uses: [ops.counter], run: async (_a, ctx) => [await ctx.call(ops.counter, {}), await ctx.call(ops.counter, {})] }),
  defineCommand({ name: "order rename", summary: "rename", args: z.object({ name: z.string() }), uses: [renameOrder], run: async ({ name }, ctx) => ctx.call(renameOrder, { name }) }),
  defineCommand({ name: "me show", summary: "me", args: z.object({}), uses: [getMe], run: async (_a, ctx) => ctx.call(getMe, {}) }),
  defineCommand({ name: "private show", summary: "private", args: z.object({}), uses: [getPrivate], run: async (_a, ctx) => ctx.call(getPrivate, {}) }),
  defineCommand({ name: "town list", summary: "towns", args: z.object({}), uses: [getTowns], run: async (_a, ctx) => ctx.call(getTowns, {}) }),
];

let n = 0;
function app(overrides: Parameters<typeof makeSite>[0]): App {
  const site = makeSite({ skill: `shop${++n}`, origin: server.url.origin, needsChrome: true, ...overrides });
  return {
    site,
    operations: [...Object.values(ops), renameOrder, getMe, getPrivate, getTowns],
    commands,
    deps: { env: { SITE_CLI_HOME: `${home.dir}/${site.skill}`, SITE_CLI_TEST: "1", SITE_CLI_NONINTERACTIVE: "1" }, retryDelays: [], note: () => {} },
  };
}

describe.skipIf(skip)("transport browser", () => {
  test("plain fetch lacks the cookie the page sets in JavaScript, so the site's 403 is Drift", async () => {
    const { output, code } = await run(["order", "show"], app({}));
    expect(code).toBe(3);
    expect((output as any).error.fingerprint).toContain(":auth:");
  });

  test("transport browser sends the Operation from a tab on the site: the page's own cookie goes along", async () => {
    received.length = 0;
    const { output, code } = await run(["order", "show"], app({ transport: "browser" }));
    expect({ output, code }).toEqual({ output: { id: "7", total: 5 }, code: 0 });
    expect(received.find((r) => r.path === "/api/orders/7")).toMatchObject({ method: "GET", jsCookie: true });
  }, 60_000);

  test("an ISO-8859-1 page read from the tab keeps æ, ø and å: its bytes are decoded by its charset (#108)", async () => {
    // The page's Response.text() is always UTF-8, so the tab hands over the bytes instead.
    for (const transport of [undefined, "browser"] as const) {
      const { output, code } = await run(["town", "list"], app(transport ? { transport } : {}));
      expect({ output, code, transport }).toEqual({ output: { towns: ["København", "Århus"] }, code: 0, transport });
    }
  }, 60_000);

  test("a same-origin redirect is followed, as with fetch", async () => {
    const { output, code } = await run(["old", "show"], app({ transport: "browser" }));
    expect({ output, code }).toEqual({ output: { id: "7", total: 5 }, code: 0 });
  }, 60_000);

  test("a write with --confirm is sent once, with its JSON body", async () => {
    received.length = 0;
    const { output, code } = await run(["order", "rename", "--name", "New", "--confirm"], app({ transport: "browser" }));
    expect({ output, code }).toEqual({ output: { ok: true }, code: 0 });
    const patches = received.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ jsCookie: true, body: JSON.stringify({ name: "New" }) });
  }, 60_000);

  test("auth login: the session's bearer goes along; a redirect to a login host is a sign-out, and the refresh gets the profile (exit 4, not Drift or a bug)", async () => {
    const a = app({
      auth: "login",
      transport: "browser",
      login: { startUrl: `${server.url.origin}/account`, hosts: [loginHost.url.host], tokenRequest: "/api/me" },
    });
    saveSession(stateDir(a.site, a.deps!.env!), { headers: { authorization: "Bearer tok-1" }, ids: {}, savedAt: new Date().toISOString() });
    received.length = 0;
    expect(await run(["me", "show"], a)).toEqual({ output: { id: "u-1" }, code: 0 });
    expect(received.find((r) => r.path === "/api/me")).toMatchObject({ bearer: "Bearer tok-1", jsCookie: true });
    const { output, code } = await run(["private", "show"], a);
    expect((output as any).error.kind).toBe("session");
    expect(code).toBe(4);
  }, 90_000);

  test("a bootstrap's ctx.fetch reads Set-Cookie, sends a form body and follows a redirect by default, as fetch does (review)", async () => {
    const a = app({
      transport: "browser",
      bootstrap: async (ctx) => {
        const front = await ctx.fetch(`${ctx.origin}/`);
        const token = front.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("csrf="))?.slice("csrf=".length);
        if (!token) throw new Error("the front page set no csrf cookie");
        const form = await ctx.fetch(`${ctx.origin}/api/form`, { method: "POST", body: new URLSearchParams({ grant: "x" }) });
        if (form.status !== 200) throw new Error(`the form post answered ${form.status}`);
        const moved = await ctx.fetch(`${ctx.origin}/api/old-orders/7`);
        if (moved.status !== 200) throw new Error(`the redirect was not followed: ${moved.status}`);
        return { headers: { cookie: `csrf=${token}`, "x-csrf-token": token } };
      },
    });
    expect(await run(["csrf", "show"], a)).toEqual({ output: { id: "c", total: 1 }, code: 0 });
    expect(await run(["csrf", "show"], a)).toEqual({ output: { id: "c", total: 1 }, code: 0 }); // from session.json, front page loaded again
  }, 90_000);

  test("the session's cookies win over what the jar or the front page holds, as with plain fetch (review)", async () => {
    const mini = miniSite(
      () => new Response("<!doctype html><title>front</title>", { headers: { "content-type": "text/html", "set-cookie": "sid=stale; Path=/; Max-Age=3600" } }),
      (req) => Response.json({ id: cookieOf(req, "sid") ?? "none", total: 0 }),
    );
    const a = app({ origin: mini.url.origin, auth: "login", transport: "browser", login: { startUrl: `${mini.url.origin}/`, hosts: [loginHost.url.host], tokenRequest: "/api/" } });
    const dir = stateDir(a.site, a.deps!.env!);
    saveSession(dir, { headers: { cookie: "sid=A" }, ids: {} });
    expect(await run(["sid", "show"], a)).toEqual({ output: { id: "A", total: 0 }, code: 0 });
    saveSession(dir, { headers: { cookie: "sid=B" }, ids: {} });
    expect(await run(["sid", "show"], a)).toEqual({ output: { id: "B", total: 0 }, code: 0 });
  }, 90_000);

  test("Chrome's HTTP cache never answers in the site's place (review)", async () => {
    const { output, code } = await run(["counter", "twice"], app({ transport: "browser" }));
    expect(code).toBe(0);
    const [first, second] = output as { id: string }[];
    expect(first!.id).not.toBe(second!.id);
  }, 60_000);

  test("a bootstrap reads its CSRF cookie with ctx.cookies() although the tab's own page load already took it (#95, cold read)", async () => {
    // Like many sites, the front page sets the cookie only when the browser lacks it.
    const tokens = new Set<string>();
    const mini = miniSite(
      () => new Response("<!doctype html><title>front</title>", { headers: { "content-type": "text/html" } }),
      (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/start") {
          if (cookieOf(req, "csrf")) return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
          const t = `t${tokens.size + 1}`;
          tokens.add(t);
          return new Response("<!doctype html>", { headers: { "content-type": "text/html", "set-cookie": `csrf=${t}; Path=/` } });
        }
        const c = cookieOf(req, "csrf");
        return c && tokens.has(c) && req.headers.get("x-csrf-token") === c ? Response.json({ id: "ok", total: 0 }) : new Response("csrf", { status: 403 });
      },
    );
    const a = app({
      origin: mini.url.origin,
      transport: "browser",
      bootstrap: async (ctx) => {
        await ctx.fetch(`${ctx.origin}/start`); // the tab may have loaded it already
        await ctx.fetch(`${ctx.origin}/start`); // now it surely has: no Set-Cookie this time
        const token = (await ctx.cookies()).csrf;
        if (!token) throw new Error("no csrf cookie");
        return { headers: { cookie: `csrf=${token}`, "x-csrf-token": token } };
      },
    });
    expect(await run(["ok", "show"], a)).toEqual({ output: { id: "ok", total: 0 }, code: 0 });
  }, 60_000);

  test("ctx.cookies() holds a cookie the page load set on a narrower Path, as an XSRF cookie on /api (review 3)", async () => {
    const mini = miniSite(
      () => new Response("<!doctype html><title>front</title>", { headers: { "content-type": "text/html", "set-cookie": "xsrf=x1; Path=/api" } }),
      (req) => (cookieOf(req, "xsrf") === "x1" && req.headers.get("x-xsrf") === "x1" ? Response.json({ id: "ok", total: 0 }) : new Response("xsrf", { status: 403 })),
    );
    const a = app({
      origin: mini.url.origin,
      transport: "browser",
      bootstrap: async (ctx) => {
        const token = (await ctx.cookies()).xsrf;
        if (!token) throw new Error("no xsrf cookie");
        return { headers: { "x-xsrf": token } };
      },
    });
    expect(await run(["ok", "show"], a)).toEqual({ output: { id: "ok", total: 0 }, code: 0 });
  }, 60_000);

  test("ctx.cookies() on a site Chrome cannot load is a network failure, not an empty jar the hook takes for a bug (#95, review)", async () => {
    // A listener that closes every connection as it opens: Chrome gets a real dropped connection, not a port its policy
    // refuses (port 9 is on Chrome's restricted list: net::ERR_UNSAFE_PORT before any TCP attempt). The port stays held
    // while the test runs, so a parallel file cannot take it the way it could a freed one.
    const dropper = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (s) => void s.end(), data() {} } });
    try {
      const a = app({
        origin: `http://127.0.0.1:${dropper.port}`,
        transport: "browser",
        bootstrap: async (ctx) => {
          const token = (await ctx.cookies()).csrf;
          if (!token) throw new Error("no csrf cookie");
          return { headers: { cookie: `csrf=${token}` } };
        },
      });
      const r = await run(["ok", "show"], a);
      expect(r.code).toBe(5);
      expect((r.output as { error: { kind: string } }).error.kind).toBe("network");
    } finally {
      dropper.stop(true);
    }
  }, 60_000);

  test("a front page that reloads itself once its script has run is waited for (review)", async () => {
    const mini = miniSite(
      () =>
        new Response(`<!doctype html><script>if (!document.cookie.includes("ok=1")) setTimeout(() => { document.cookie = "ok=1; path=/"; location.reload(); }, 300);</script>`, {
          headers: { "content-type": "text/html" },
        }),
      (req) => (cookieOf(req, "ok") === "1" ? Response.json({ id: "ok", total: 0 }) : new Response("<title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html" } })),
    );
    expect(await run(["ok", "show"], app({ origin: mini.url.origin, transport: "browser" }))).toEqual({ output: { id: "ok", total: 0 }, code: 0 });
  }, 60_000);
});
