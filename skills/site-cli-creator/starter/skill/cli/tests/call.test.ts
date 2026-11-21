// The classification table (SPEC §10), row by row, against a fake fetch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { blockSignal, buildRequest, Client } from "../src/runtime/call";
import { DryRun, Failure } from "../src/runtime/envelope";
import { defineOperation } from "../src/runtime/operation";
import { loadSession, saveSession } from "../src/runtime/session";
import { client, fakeFetch, getCustomer, getOrder, json, listProducts, loginSite, makeDeps, makeSite, ORIGIN, renameOrder, tempHome } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

async function failure(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Failure) return e;
    throw e;
  }
  throw new Error("expected a Failure");
}

const saved = (headers: Record<string, string> = { authorization: "Bearer old" }) =>
  saveSession(home.dir, { headers, ids: { customerId: "C-1" } });

describe("request building", () => {
  test("GraphQL posts operationName, query and variables to origin + graphqlPath", () => {
    const r = buildRequest(getCustomer, { customerId: "C-1" }, { origin: "https://x.test", graphqlPath: "/gql", headers: { Authorization: "Bearer t" } });
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://x.test/gql");
    expect(r.headers.authorization).toBe("Bearer t");
    expect(r.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(r.body!)).toEqual({ operationName: "getCustomer", query: getCustomer.graphql, variables: { customerId: "C-1" } });
  });

  test("REST fills :params (encoded), adds query and JSON body", () => {
    const get = buildRequest(getOrder, { orderId: "a/b c", expand: true }, { origin: "https://x.test", headers: {} });
    expect(get.method).toBe("GET");
    expect(get.url).toBe("https://x.test/api/orders/a%2Fb%20c?expand=lines");
    expect(get.body).toBeUndefined();
    const patch = buildRequest(renameOrder, { orderId: "7", name: "New" }, { origin: "https://x.test", headers: {} });
    expect(patch.method).toBe("PATCH");
    expect(patch.url).toBe("https://x.test/api/orders/7");
    expect(JSON.parse(patch.body!)).toEqual({ name: "New" });
  });

  test("REST bodyType form: the body is form-urlencoded, not JSON", () => {
    const formRename = defineOperation({
      ...renameOrder,
      rest: { method: "PATCH", path: "/api/orders/:orderId", bodyType: "form", body: (v) => ({ name: v.name, tags: ["a", "b&c"], none: undefined }) },
    });
    const r = buildRequest(formRename, { orderId: "7", name: "New Name" }, { origin: "https://x.test", headers: {} });
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(r.body).toBe("name=New+Name&tags=a&tags=b%26c");
    expect(new URLSearchParams(r.body).get("name")).toBe("New Name");
    // JSON stays the default.
    expect(buildRequest(renameOrder, { orderId: "7", name: "N" }, { origin: "https://x.test", headers: {} }).headers["content-type"]).toBe("application/json");
    // A form body must be flat: a nested object has no form encoding.
    const nested = defineOperation({ ...formRename, rest: { ...formRename.rest!, body: () => ({ a: { b: 1 } }) } });
    expect(() => buildRequest(nested, { orderId: "7", name: "N" }, { origin: "https://x.test", headers: {} })).toThrow(/form/);
  });

  test("a form write is sent form-encoded with --confirm", async () => {
    const formRename = defineOperation({ ...renameOrder, rest: { ...renameOrder.rest!, bodyType: "form" } });
    const { fetch, calls } = fakeFetch(() => json({ ok: true }));
    await client(makeSite(), makeDeps(fetch, home.dir).deps, true).call(formRename, { orderId: "7", name: "N" });
    expect(calls[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0].body).toBe("name=N");
  });

  test("session headers are sent with every call", async () => {
    saved({ authorization: "Bearer cached", cookie: "sid=1" });
    const { fetch, calls } = fakeFetch(() => json({ data: { getCustomer: { id: "C-1", name: "n" } } }));
    await client(loginSite(), makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C-1" });
    expect(calls[0].headers.authorization).toBe("Bearer cached");
    expect(calls[0].headers.cookie).toBe("sid=1");
  });
});

describe("site.headers (#111)", () => {
  const ok = () => json({ data: { getCustomer: { id: "C-1", name: "n" } } });
  const headers = { "x-requested-with": "XMLHttpRequest", "sec-fetch-site": "same-origin", referer: `${ORIGIN}/`, accept: "never-wins" };

  test("a site's own headers go with every call to its origin; the session's and the call's own win", async () => {
    saved({ authorization: "Bearer cached", "x-requested-with": "session" });
    const { fetch, calls } = fakeFetch(ok);
    await client(loginSite({ headers }), makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C-1" });
    expect(calls[0].headers["sec-fetch-site"]).toBe("same-origin");
    expect(calls[0].headers.referer).toBe(`${ORIGIN}/`);
    expect(calls[0].headers["x-requested-with"]).toBe("session");
    expect(calls[0].headers.accept).toBe("application/json");
    expect(calls[0].headers.authorization).toBe("Bearer cached");
  });

  test("never to another host: a hook's request there carries none of them", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const site = makeSite({
      headers,
      bootstrap: async (ctx) => {
        await ctx.fetch("https://other.example.test/x");
        await ctx.fetch(`${ORIGIN}/csrf`);
        return { headers: {} };
      },
    });
    await client(site, makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C-1" }).catch(() => {});
    expect(calls[0].url).toBe("https://other.example.test/x");
    expect(calls[0].headers["x-requested-with"]).toBeUndefined();
    expect(calls[1].headers["x-requested-with"]).toBe("XMLHttpRequest");
  });
});

describe("input", () => {
  test("variables failing Zod → input, nothing sent", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: 42 } as any));
    expect(f.kind).toBe("input");
    expect(f.message).toContain("getCustomer");
    expect(calls).toHaveLength(0);
  });
});

describe("network", () => {
  test("transport error is retried, then network", async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1 secret"), { code: "ConnectionRefused" });
    });
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C-1" }));
    expect(f.kind).toBe("network");
    expect(calls).toHaveLength(3);
    expect(f.message).toContain("ConnectionRefused");
    expect(f.message).not.toContain("secret");
  });

  test("5xx is retried and recovers", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (n++ === 0 ? json({}, 503) : json({ data: { getCustomer: { id: "C-1", name: "n" } } })));
    await client(makeSite(), makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C-1" });
    expect(calls).toHaveLength(2);
  });

  test("429 → network after retries", async () => {
    const { fetch, calls } = fakeFetch(() => json({}, 429));
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C-1" }));
    expect(f.kind).toBe("network");
    expect(calls).toHaveLength(3);
  });

  test("GraphQL 200 with data null and a server-side error code → network after retries, not Drift", async () => {
    for (const code of ["INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE", "INTERNAL"]) {
      const { fetch, calls } = fakeFetch(() => json({ data: null, errors: [{ message: "db down for Kim Secret", extensions: { code } }] }));
      const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C-1" }));
      expect(f.kind).toBe("network");
      expect(f.fingerprint).toBeUndefined();
      expect(calls).toHaveLength(3);
      expect(f.message).toContain(`GraphQL ${code}`);
      expect(f.message).not.toContain("Kim");
    }
    // It is retried and recovers.
    let n = 0;
    const flaky = fakeFetch(() =>
      n++ === 0 ? json({ errors: [{ message: "x", extensions: { code: "INTERNAL_SERVER_ERROR" } }] }) : json({ data: { getCustomer: { id: "C-1", name: "n" } } }),
    );
    await client(makeSite(), makeDeps(flaky.fetch, home.dir).deps).call(getCustomer, { customerId: "C-1" });
    expect(flaky.calls).toHaveLength(2);
    // A write is not resent.
    const gqlWrite = { ...getCustomer, name: "saveCustomer", effect: "write" as const };
    const w = fakeFetch(() => json({ data: null, errors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" } }] }));
    expect((await failure(client(makeSite(), makeDeps(w.fetch, home.dir).deps, true).call(gqlWrite, { customerId: "C-1" }))).kind).toBe("network");
    expect(w.calls).toHaveLength(1);
  });

  test("GraphQL errors that are not server-side, or that come with data, stay with the classification table", async () => {
    const other = fakeFetch(() => json({ data: null, errors: [{ message: "nope", extensions: { code: "FORBIDDEN_THING" } }] }));
    const f = await failure(client(makeSite(), makeDeps(other.fetch, home.dir).deps).call(getCustomer, { customerId: "C-1" }));
    expect(f.kind).toBe("drift");
    expect(f.fingerprint).toStartWith("acme:shop:getCustomer:zod:");
    expect(other.calls).toHaveLength(1);
    const partial = fakeFetch(() => json({ data: { getCustomer: { id: "C-1", name: "n" } }, errors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" } }] }));
    await client(makeSite(), makeDeps(partial.fetch, home.dir).deps).call(getCustomer, { customerId: "C-1" });
    expect(partial.calls).toHaveLength(1);
  });

  test("a write is not resent after a 5xx, but is after a 429", async () => {
    const five = fakeFetch(() => json({}, 502));
    const f = await failure(client(makeSite(), makeDeps(five.fetch, home.dir).deps, true).call(renameOrder, { orderId: "1", name: "x" }));
    expect(f.kind).toBe("network");
    expect(five.calls).toHaveLength(1);
    const tooMany = fakeFetch(() => json({}, 429));
    await failure(client(makeSite(), makeDeps(tooMany.fetch, home.dir).deps, true).call(renameOrder, { orderId: "1", name: "x" }));
    expect(tooMany.calls).toHaveLength(3);
  });
});

describe("auth login", () => {
  test("401 → headless refresh → retry succeeds", async () => {
    saved();
    const { fetch, calls } = fakeFetch((r) => (r.headers.authorization === "Bearer new" ? json({ data: { getCustomer: { id: "C-1", name: "n" } } }) : json({}, 401)));
    const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer new", cookie: "sid=2" }]);
    const out: any = await client(loginSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(out.data.getCustomer.id).toBe("C-1");
    expect(loginCalls).toEqual([true]);
    expect(calls).toHaveLength(2);
    const s = loadSession(home.dir)!;
    expect(s.headers).toEqual({ authorization: "Bearer new", cookie: "sid=2" });
    expect(s.ids).toEqual({ customerId: "C-1" });
  });

  test("a sign-in releases the Chrome that transport browser sends from before it starts and after postLogin, so the next request opens one with the new session (#93, review)", async () => {
    saved();
    const order: string[] = [];
    const { fetch } = fakeFetch((r) => (r.headers.authorization === "Bearer new" ? json({ data: { getCustomer: { id: "C-1", name: "n" } } }) : json({}, 401)));
    const { deps } = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
    const login = deps.login;
    deps.login = (headless, options) => (order.push("login"), login(headless, options));
    deps.release = async () => void order.push("release");
    await client(loginSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(order).toEqual(["release", "login", "release"]);
  });

  test("headless refresh fails → headed login → retry", async () => {
    saved();
    const { fetch } = fakeFetch((r) => (r.headers.authorization === "Bearer new" ? json({ data: { getCustomer: { id: "C-1", name: "n" } } }) : json({}, 403)));
    const { deps, loginCalls } = makeDeps(fetch, home.dir, [null, { authorization: "Bearer new" }]);
    await client(loginSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(loginCalls).toEqual([true, false]);
  });

  test("SITE_CLI_NONINTERACTIVE=1: a failed silent refresh is session at once, no headed Chrome", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: { customerId: "C-1" } });
    const { fetch } = fakeFetch(() => json({}, 401));
    const d = makeDeps(fetch, home.dir, [null, { authorization: "Bearer new" }]);
    d.deps.env = { ...d.deps.env, SITE_CLI_NONINTERACTIVE: "1" };
    const e = await failure(client(loginSite(), d.deps).call(getCustomer, { customerId: "C-1" }));
    expect(e.kind).toBe("session");
    expect(e.message).toContain("SITE_CLI_NONINTERACTIVE=1");
    expect(d.loginCalls).toEqual([true]); // headless only
  });

  describe("sessionProbe: a site that serves an expired session as anonymous (404, never 401)", () => {
    const probeSite = () => loginSite({ login: { ...loginSite().login!, sessionProbe: "/api/me" } });
    // Signed in only with "Bearer new"; anonymous gets 401 from /api/me and 404 from everything else.
    const anonymousSite = () =>
      fakeFetch((r) => {
        const signedIn = r.headers.authorization === "Bearer new";
        if (r.url.endsWith("/api/me")) return signedIn ? json({ ok: true }) : json({}, 401);
        return signedIn ? json({ id: "1", total: 5 }) : json({}, 404);
      });

    test("probe says signed out → signs in again before the call, no Drift", async () => {
      saved();
      const { fetch, calls } = anonymousSite();
      const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
      const out: any = await client(probeSite(), deps).call(getOrder, { orderId: "1" });
      expect(out.total).toBe(5);
      expect(loginCalls).toEqual([true]);
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/me", "/api/orders/1"]);
      expect(calls[0].method).toBe("GET");
      expect(calls[0].headers.authorization).toBe("Bearer old"); // the probe carries the saved session
    });

    test("a probe redirected to a login host also counts as signed out", async () => {
      saved();
      const { fetch } = fakeFetch((r) => {
        if (r.headers.authorization === "Bearer new") return json({ id: "1", total: 5 });
        return r.url.endsWith("/api/me") ? new Response(null, { status: 302, headers: { location: "https://login.example.test/authorize" } }) : json({}, 404);
      });
      const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
      await client(probeSite(), deps).call(getOrder, { orderId: "1" });
      expect(loginCalls).toEqual([true]);
    });

    test("SITE_CLI_NONINTERACTIVE=1, or an MCP tool call: signed out is kind session (exit 4), not Drift", async () => {
      saved();
      const { fetch, calls } = anonymousSite();
      const d = makeDeps(fetch, home.dir, [null]);
      d.deps.env = { ...d.deps.env, SITE_CLI_NONINTERACTIVE: "1" };
      const e = await failure(client(probeSite(), d.deps).call(getOrder, { orderId: "1" }));
      expect(e.kind).toBe("session");
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/me"]);
      const m = makeDeps(anonymousSite().fetch, home.dir, [null]);
      const viaMcp = await failure(new Client(probeSite(), m.deps, { surface: "mcp" }).call(getOrder, { orderId: "1" }));
      expect(viaMcp.kind).toBe("session");
      expect(m.loginCalls).toEqual([true]); // headless only
    });

    test("probe says signed in → no sign-in, and it is asked once per run", async () => {
      saveSession(home.dir, { headers: { authorization: "Bearer new" }, ids: { customerId: "C-1" } });
      const { fetch, calls } = anonymousSite();
      const { deps, loginCalls } = makeDeps(fetch, home.dir);
      const c = client(probeSite(), deps);
      await c.call(getOrder, { orderId: "1" });
      await c.call(getOrder, { orderId: "2" });
      expect(loginCalls).toEqual([]);
      expect(calls.map((r) => new URL(r.url).pathname)).toEqual(["/api/me", "/api/orders/1", "/api/orders/2"]);
    });

    test("no saved session: the sign-in is fresh, so the probe is not asked", async () => {
      const { fetch, calls } = anonymousSite();
      const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
      await client(probeSite(), deps).call(getOrder, { orderId: "1" });
      expect(loginCalls).toEqual([true]);
      expect(calls.map((r) => new URL(r.url).pathname)).toEqual(["/api/orders/1"]);
    });

    test("probe answers 5xx or 429, or the connection fails → no sign-in; the call goes ahead", async () => {
      for (const answer of [() => json({}, 503), () => json({}, 429), () => Promise.reject(Object.assign(new Error("x"), { code: "ECONNRESET" }))]) {
        saveSession(home.dir, { headers: { authorization: "Bearer new" }, ids: {} });
        const { fetch, calls } = fakeFetch((r) => (r.url.endsWith("/api/me") ? answer() : json({ id: "1", total: 5 })));
        const { deps, loginCalls } = makeDeps(fetch, home.dir);
        await client(probeSite(), deps).call(getOrder, { orderId: "1" });
        expect(loginCalls).toEqual([]);
        expect(calls).toHaveLength(2);
      }
    });
  });

  test("login that doesn't complete → session", async () => {
    saved();
    const { fetch } = fakeFetch(() => json({}, 401));
    const { deps } = makeDeps(fetch, home.dir, [null, null]);
    const f = await failure(client(loginSite(), deps).call(getCustomer, { customerId: "C-1" }));
    expect(f.kind).toBe("session");
  });

  test("still 401/403 after a fresh login → drift auth", async () => {
    saved();
    const { fetch, calls } = fakeFetch(() => json({}, 401));
    const { deps } = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
    const f = await failure(client(loginSite(), deps).call(getCustomer, { customerId: "C-1" }));
    expect(f.kind).toBe("drift");
    expect(f.fingerprint).toBe("acme:shop:getCustomer:auth::401");
    expect(calls).toHaveLength(2);
  });

  test("no saved session: signs in first; a 401 right after is drift", async () => {
    const { fetch } = fakeFetch(() => json({}, 401));
    const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer fresh" }]);
    const f = await failure(client(loginSite(), deps).call(getCustomer, { customerId: "C-1" }));
    expect(loginCalls).toEqual([true]);
    expect(f.fingerprint).toBe("acme:shop:getCustomer:auth::401");
  });

  test("a redirect to a login host counts as logged out", async () => {
    saved();
    const { fetch } = fakeFetch((r) =>
      r.headers.authorization === "Bearer new"
        ? json({ data: { getCustomer: { id: "C-1", name: "n" } } })
        : new Response(null, { status: 302, headers: { location: "https://login.example.test/authorize?x=1" } }),
    );
    const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
    await client(loginSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(loginCalls).toEqual([true]);
  });

  test("GraphQL UNAUTHENTICATED counts as logged out", async () => {
    saved();
    const { fetch } = fakeFetch((r) =>
      r.headers.authorization === "Bearer new"
        ? json({ data: { getCustomer: { id: "C-1", name: "n" } } })
        : json({ errors: [{ message: "not signed in", extensions: { code: "UNAUTHENTICATED" } }], data: null }),
    );
    const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
    await client(loginSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(loginCalls).toEqual([true]);
  });

  test("postLogin gets the captured headers and its ids are saved; values are strings", async () => {
    let seen: Record<string, string> = {};
    const site = loginSite({
      login: {
        startUrl: "https://shop.example.test/",
        hosts: [],
        tokenRequest: "/graphql",
        postLogin: async (ctx) => {
          seen = ctx.headers;
          return { customerId: ctx.decodeJwt(ctx.headers.authorization).sub as string, n: 7 as unknown as string };
        },
      },
    });
    const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: "C-9" })).toString("base64url")}.y`;
    const { fetch } = fakeFetch(() => json({}));
    const { deps } = makeDeps(fetch, home.dir, [{ authorization: token }]);
    await client(site, deps).signIn(false);
    expect(seen.authorization).toBe(token);
    expect(loadSession(home.dir)!.ids).toEqual({ customerId: "C-9", n: "7" });
  });
});

describe("auth none", () => {
  test("401 → bootstrap reruns once → retry succeeds", async () => {
    let boots = 0;
    const site = makeSite({ bootstrap: async () => ({ headers: { "x-csrf": `t${++boots}` } }) });
    saveSession(home.dir, { headers: { "x-csrf": "stale" }, ids: {} });
    const { fetch } = fakeFetch((r) => (r.headers["x-csrf"] === "t1" ? json({ data: { getCustomer: { id: "C", name: "n" } } }) : json({}, 401)));
    const { deps, loginCalls } = makeDeps(fetch, home.dir);
    await client(site, deps).call(getCustomer, { customerId: "C" });
    expect(boots).toBe(1);
    expect(loginCalls).toEqual([]);
    expect(loadSession(home.dir)!.headers).toEqual({ "x-csrf": "t1" });
  });

  test("ctx.cookies() in a hook: the cookies ctx.fetch's answers set, so a bootstrap needs no Set-Cookie parsing (#95, cold read)", async () => {
    let seen: Record<string, string> = {};
    const site = makeSite({
      bootstrap: async (ctx) => {
        await ctx.fetch(`${ctx.origin}/`);
        seen = await ctx.cookies();
        return { headers: { "x-csrf": seen.csrf ?? "" } };
      },
    });
    const { fetch } = fakeFetch((r) =>
      new URL(r.url).pathname === "/"
        ? new Response("<html></html>", { headers: [["content-type", "text/html"], ["set-cookie", "csrf=t1; Path=/"], ["set-cookie", "other=x; Path=/; HttpOnly"]] })
        : json({ data: { getCustomer: { id: "C", name: "n" } } }),
    );
    await client(site, makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C" });
    expect(seen).toEqual({ csrf: "t1", other: "x" });
  });

  test("ctx.cookies() asks transport browser's Chrome with the session's cookie, and passes on a Failure (no Chrome) (review)", async () => {
    // accounts runs with the saved session (bootstrap, by design, with an empty one).
    saveSession(home.dir, { headers: { cookie: "sid=s1" }, ids: {} });
    const asked: (string | undefined)[] = [];
    const reads = loginSite({ accounts: async (ctx) => [(await ctx.cookies()).k ?? "none"] });
    const { fetch } = fakeFetch(() => json({}));
    const { deps } = makeDeps(fetch, home.dir);
    deps.cookies = async (cookie) => (asked.push(cookie), { k: "v" });
    expect(await client(reads, deps).listAccounts(true)).toEqual([{ id: "v" }]);
    expect(asked).toEqual(["sid=s1"]);
    deps.cookies = async () => {
      throw new Failure("input", "Google Chrome was not found");
    };
    const e = await failure(client(reads, deps).listAccounts(true));
    expect([e.kind, e.message]).toEqual(["input", "Google Chrome was not found"]);
  });

  test("a bootstrap rerun releases transport browser's Chrome first, so its ctx.cookies() is not the stale jar (review)", async () => {
    let boots = 0;
    const order: string[] = [];
    const site = makeSite({ bootstrap: async () => (order.push("bootstrap"), { headers: { "x-csrf": `t${++boots}` } }) });
    saveSession(home.dir, { headers: { "x-csrf": "stale" }, ids: {} });
    const { fetch } = fakeFetch((r) => (r.headers["x-csrf"] === "t1" ? json({ data: { getCustomer: { id: "C", name: "n" } } }) : json({}, 401)));
    const { deps } = makeDeps(fetch, home.dir);
    deps.release = async () => void order.push("release");
    await client(site, deps).call(getCustomer, { customerId: "C" });
    expect(order).toEqual(["release", "bootstrap"]);
  });

  test("bootstrap runs before the first call and is cached", async () => {
    let boots = 0;
    const site = makeSite({ bootstrap: async () => ({ headers: { cookie: `c${++boots}` } }) });
    const { fetch, calls } = fakeFetch(() => json({ data: { getCustomer: { id: "C", name: "n" } } }));
    const { deps } = makeDeps(fetch, home.dir);
    await client(site, deps).call(getCustomer, { customerId: "C" });
    await client(site, deps).call(getCustomer, { customerId: "C" });
    expect(boots).toBe(1);
    expect(calls.map((c) => c.headers.cookie)).toEqual(["c1", "c1"]);
  });

  test("still 403 after bootstrap → drift auth, never session", async () => {
    const site = makeSite({ bootstrap: async () => ({ headers: {} }) });
    saveSession(home.dir, { headers: {}, ids: {} });
    const { fetch } = fakeFetch(() => json({}, 403));
    const f = await failure(client(site, makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C" }));
    expect(f.kind).toBe("drift");
    expect(f.fingerprint).toBe("acme:shop:getCustomer:auth::403");
  });

  test("no bootstrap: 401 is drift at once", async () => {
    const { fetch, calls } = fakeFetch(() => json({}, 401));
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C" }));
    expect(f.kind).toBe("drift");
    expect(calls).toHaveLength(1);
  });
});

describe("drift", () => {
  test("404 and 405 on a REST path → drift http", async () => {
    for (const status of [404, 405]) {
      const { fetch } = fakeFetch(() => json({}, status));
      const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(getOrder, { orderId: "1" }));
      expect(f.kind).toBe("drift");
      expect(f.fingerprint).toBe(`acme:shop:GET /api/orders/{orderId}:http::${status}`);
    }
  });

  test("GraphQL 'Cannot query field' → drift graphql with schema coordinates", async () => {
    const { fetch } = fakeFetch(() =>
      json({ errors: [{ message: 'Cannot query field "status" on type "Product".', extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }, 400),
    );
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(listProducts, { customerId: "C" }));
    expect(f.kind).toBe("drift");
    expect(f.fingerprint).toBe("acme:shop:listProducts:graphql:Product.status:GRAPHQL_VALIDATION_FAILED");
  });

  test("GraphQL validation code without a known message → drift graphql", async () => {
    const { fetch } = fakeFetch(() => json({ errors: [{ message: "whatever", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }));
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(listProducts, { customerId: "C" }));
    expect(f.fingerprint).toBe("acme:shop:listProducts:graphql::GRAPHQL_VALIDATION_FAILED");
    expect(f.message).not.toContain("whatever");
  });

  test("GraphQL BAD_USER_INPUT → drift input-rejected, message keeps no server text", async () => {
    const { fetch } = fakeFetch(() => json({ errors: [{ message: 'Variable "$customerId" got invalid value "C-777"', extensions: { code: "BAD_USER_INPUT" } }] }));
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(listProducts, { customerId: "C" }));
    expect(f.fingerprint).toBe("acme:shop:listProducts:input-rejected::BAD_USER_INPUT");
    expect(JSON.stringify({ m: f.message, d: f.details })).not.toContain("C-777");
  });

  test("REST 400/422 → drift input-rejected", async () => {
    for (const status of [400, 422]) {
      const { fetch } = fakeFetch(() => json({ error: "bad" }, status));
      const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps, true).call(renameOrder, { orderId: "1", name: "x" }));
      expect(f.fingerprint).toBe(`acme:shop:PATCH /api/orders/{orderId}:input-rejected::${status}`);
    }
  });

  describe("REST 400/422 that names the rejected fields", () => {
    const reject = async (body: unknown, status = 400) => {
      const { fetch } = fakeFetch(() => json(body, status));
      return failure(client(makeSite(), makeDeps(fetch, home.dir).deps, true).call(renameOrder, { orderId: "1", name: "x" }));
    };
    const op = "acme:shop:PATCH /api/orders/{orderId}:input-rejected";

    test("errors object: declared fields are named, other keys are {}, messages never leak", async () => {
      const f = await reject({ errorMessages: [], errors: { name: 'Value "Kim Secret" is invalid', "kim@example.test": "x" } });
      expect(f.fingerprint).toBe(`${op}:name:400`);
      expect(f.diff).toEqual([
        { path: "name", code: "rejected" },
        { path: "{}", code: "rejected" },
      ]);
      expect(f.message).toContain("at name, {}");
      const all = JSON.stringify({ m: f.message, d: f.details, diff: f.diff, fp: f.fingerprint });
      expect(all).not.toContain("Kim Secret");
      expect(all).not.toContain("kim@example.test");
    });

    test("a wrapped fieldErrors names the field; envelope keys, numbers and a route add nothing; no text leaks", async () => {
      const f = await reject({ errors: { formErrors: ["Kim Secret"], fieldErrors: { name: ["Kim Secret is too short"] }, message: "Kim Secret", code: 7 } });
      expect(f.fingerprint).toBe(`${op}:name:400`);
      expect(f.diff).toEqual([{ path: "name", code: "rejected" }]);
      expect(JSON.stringify({ m: f.message, d: f.details, diff: f.diff, fp: f.fingerprint })).not.toContain("Kim Secret");
      for (const body of [{ errors: { message: "Kim Secret", code: "E1", status: 400 } }, { errors: { name: 5 } }, { errors: [{ path: "/api/orders/123" }] }]) {
        const g = await reject(body);
        expect(g.fingerprint).toBe(`${op}::400`);
        expect(g.diff).toEqual([]);
      }
    });

    test("a 422 works the same", async () => {
      expect((await reject({ errors: { orderId: "no" } }, 422)).fingerprint).toBe(`${op}:orderId:422`);
    });

    test("errors array with field, path (string and array) and JSON:API pointer", async () => {
      expect((await reject({ errors: [{ field: "name", message: "Kim Secret" }] })).fingerprint).toBe(`${op}:name:400`);
      expect((await reject({ errors: [{ path: "name" }] })).fingerprint).toBe(`${op}:name:400`);
      expect((await reject({ errors: [{ path: ["orderId", 0] }] })).fingerprint).toBe(`${op}:{}:400`);
      expect((await reject({ errors: [{ source: { pointer: "/data/attributes/name" } }] })).fingerprint).toBe(`${op}:name:400`);
      const mixed = await reject({ errors: [{ field: "name" }, { field: "name" }, { field: "nobody@example.test" }, { path: "name.first" }, 7, null] });
      expect(mixed.diff).toEqual([
        { path: "name", code: "rejected" },
        { path: "{}", code: "rejected" },
      ]);
    });

    test("fieldErrors object", async () => {
      const f = await reject({ fieldErrors: { name: ["too short"], other: ["x"] } });
      expect(f.fingerprint).toBe(`${op}:name:400`);
    });

    test("a nested path needs every segment declared; indices are []", async () => {
      const nested = defineOperation({ ...renameOrder, variables: z.object({ orderId: z.string(), lines: z.array(z.object({ sku: z.string() })).optional() }) });
      const { fetch } = fakeFetch(() => json({ errors: [{ path: ["lines", 3, "sku"] }, { field: "lines[2].sku" }, { field: "lines.nope" }] }, 400));
      const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps, true).call(nested, { orderId: "1" }));
      expect(f.diff).toEqual([
        { path: "lines[].sku", code: "rejected" },
        { path: "{}", code: "rejected" },
      ]);
    });

    test("at most 20 fields are reported", async () => {
      const many = defineOperation({ ...renameOrder, rest: { method: "PATCH", path: "/api/x" }, variables: z.object(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, "0")}`, z.string()]))) });
      const { fetch } = fakeFetch(() => json({ errors: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, "0")}`, "x"])) }, 400));
      const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps, true).call(many, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, "0")}`, "v"]))));
      expect(f.diff).toHaveLength(20);
      expect(f.message).toContain(" and 10 more");
    });

    test("a body with no recognizable fields stays generic", async () => {
      for (const body of [{ error: "bad" }, { errors: [] }, { errors: "bad" }, { errors: {} }, "nope", null]) {
        const f = await reject(body);
        expect(f.fingerprint).toBe(`${op}::400`);
        expect(f.diff).toEqual([]);
        expect(f.message).not.toContain(" at ");
      }
    });

    test("a GraphQL 400 is unchanged, even with an errors object", async () => {
      const { fetch } = fakeFetch(() => json({ errors: { customerId: "no" } }, 400));
      const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(listProducts, { customerId: "C" }));
      expect(f.fingerprint).toBe("acme:shop:listProducts:input-rejected::400");
      expect(f.diff).toEqual([]);
    });
  });

  test("response failing Zod → drift zod, [] indices, type names only", async () => {
    const { fetch } = fakeFetch(() => json({ data: { listProducts: [{ id: "P1", status: "active" }, { id: "P2", status: { code: "SECRET-VALUE" } }] } }));
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(listProducts, { customerId: "C" }));
    expect(f.kind).toBe("drift");
    expect(f.fingerprint).toBe("acme:shop:listProducts:zod:data.listProducts[].status:invalid_type");
    expect(f.diff).toEqual([{ path: "data.listProducts[].status", code: "invalid_type", expected: "string", received: "object" }]);
    expect(JSON.stringify({ m: f.message, d: f.details })).not.toContain("SECRET");
  });

  test("a non-JSON 200 fails the Contract at the root", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>hello Kim</html>", { status: 200 }));
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(getOrder, { orderId: "1" }));
    expect(f.fingerprint).toBe("acme:shop:GET /api/orders/{orderId}:zod::invalid_type");
    expect(f.diff![0].received).toBe("string");
  });

  test("other 4xx → drift http with the status", async () => {
    const { fetch } = fakeFetch(() => json({}, 410));
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(getOrder, { orderId: "1" }));
    expect(f.fingerprint).toBe("acme:shop:GET /api/orders/{orderId}:http::410");
  });

  test("same-origin redirects are followed; off-site ones are drift", async () => {
    const follow = fakeFetch((r) =>
      new URL(r.url).pathname === "/api/orders/1" ? new Response(null, { status: 301, headers: { location: "/api/orders/v2/1" } }) : json({ id: "1", total: 1 }),
    );
    const out: any = await client(makeSite(), makeDeps(follow.fetch, home.dir).deps).call(getOrder, { orderId: "1" });
    expect(out.total).toBe(1);
    expect(follow.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/orders/1", "/api/orders/v2/1"]);

    const away = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/x" } }));
    const f = await failure(client(makeSite(), makeDeps(away.fetch, home.dir).deps).call(getOrder, { orderId: "1" }));
    expect(f.fingerprint).toBe("acme:shop:GET /api/orders/{orderId}:http::302");
  });
});

describe("writes", () => {
  test("without --confirm a write throws DryRun after validating, and sends nothing", async () => {
    const { fetch, calls } = fakeFetch(() => json({ ok: true }));
    const c = client(makeSite(), makeDeps(fetch, home.dir).deps);
    await expect(c.call(renameOrder, { orderId: "1", name: "" })).rejects.toBeInstanceOf(Failure);
    const e = await c.call(renameOrder, { orderId: "1", name: "New" }).catch((x) => x);
    expect(e).toBeInstanceOf(DryRun);
    expect(e).toEqual(new DryRun("PATCH /api/orders/:orderId", { orderId: "1", name: "New" }));
    expect(calls).toHaveLength(0);
  });

  test("with --confirm the write is sent", async () => {
    const { fetch, calls } = fakeFetch(() => json({ ok: true }));
    expect(await client(makeSite(), makeDeps(fetch, home.dir).deps, true).call(renameOrder, { orderId: "1", name: "New" })).toEqual({ ok: true });
    expect(calls[0].method).toBe("PATCH");
  });
});

test("an Operation with neither graphql nor rest is a ContractError (bug)", async () => {
  const broken = defineOperation({ name: "broken", effect: "read", variables: z.object({}), response: z.any() });
  const { fetch } = fakeFetch(() => json({}));
  const e = await client(makeSite(), makeDeps(fetch, home.dir).deps).call(broken, {}).catch((x) => x);
  expect(e.name).toBe("ContractError");
});

describe("login.refresh: renew the session with plain fetch before Chrome (#94)", () => {
  type Renew = NonNullable<NonNullable<ReturnType<typeof loginSite>["login"]>["refresh"]>["renew"];
  /** renew turns refresh token r1 into "Bearer new" and rotates it to r2. */
  const refreshSite = (renew?: Renew) =>
    loginSite({
      login: {
        ...loginSite().login!,
        refresh: {
          renew: renew ?? (async (ctx) => (ctx.refresh.token === "r1" ? { headers: { ...ctx.headers, authorization: "Bearer new" }, refresh: { token: "r2" } } : null)),
        },
      },
    });
  /** The site accepts only `accepted`. */
  const site = (accepted = "Bearer new") =>
    fakeFetch((r) => (r.headers.authorization === accepted ? json({ data: { getCustomer: { id: "C-1", name: "n" } } }) : json({}, 401)));
  const savedWithRefresh = () => saveSession(home.dir, { headers: { authorization: "Bearer old", cookie: "sid=1" }, ids: { customerId: "C-1" }, refresh: { token: "r1" } });

  test("a 401 renews with the kept refresh token: no Chrome, the new headers and the rotated token are saved, ids kept", async () => {
    savedWithRefresh();
    const { fetch, calls } = site();
    const { deps, loginCalls } = makeDeps(fetch, home.dir);
    const out: any = await client(refreshSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(out.data.getCustomer.id).toBe("C-1");
    expect(loginCalls).toEqual([]);
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer old", "Bearer new"]);
    const s = loadSession(home.dir)!;
    expect(s.headers).toEqual({ authorization: "Bearer new", cookie: "sid=1" });
    expect(s.refresh).toEqual({ token: "r2" });
    expect(s.ids).toEqual({ customerId: "C-1" });
  });

  test("renew answers null (the refresh token no longer works): Chrome signs in as before", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: { customerId: "C-1" }, refresh: { token: "expired" } });
    const { fetch } = site("Bearer chrome");
    const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
    await client(refreshSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(loginCalls).toEqual([true]);
  });

  test("renew works but the site still refuses the new token: Chrome signs in before anything counts as Drift", async () => {
    savedWithRefresh();
    const { fetch } = site("Bearer chrome");
    const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
    const out: any = await client(refreshSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(out.data.getCustomer.id).toBe("C-1");
    expect(loginCalls).toEqual([true]);
  });

  test("renew throws: noted, and Chrome signs in", async () => {
    savedWithRefresh();
    const { fetch } = site("Bearer chrome");
    const { deps, loginCalls, notes } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
    const failing = refreshSite(async () => {
      throw new Error("token endpoint answered 500");
    });
    await client(failing, deps).call(getCustomer, { customerId: "C-1" });
    expect(loginCalls).toEqual([true]);
    expect(notes.join("\n")).toContain("renewing the sign-in failed");
  });

  test("an MCP tool call renews too, where it would never open Chrome", async () => {
    savedWithRefresh();
    const { fetch } = site();
    const { deps, loginCalls } = makeDeps(fetch, home.dir);
    const out: any = await new Client(refreshSite(), deps, { surface: "mcp" }).call(getCustomer, { customerId: "C-1" });
    expect(out.data.getCustomer.id).toBe("C-1");
    expect(loginCalls).toEqual([]);
  });

  test("a sessionProbe that says signed out renews first", async () => {
    savedWithRefresh();
    const { fetch, calls } = fakeFetch((r) => {
      const signedIn = r.headers.authorization === "Bearer new";
      if (r.url.endsWith("/api/me")) return signedIn ? json({ ok: true }) : json({}, 401);
      return signedIn ? json({ id: "1", total: 5 }) : json({}, 404);
    });
    const { deps, loginCalls } = makeDeps(fetch, home.dir);
    const s = refreshSite();
    const probed = { ...s, login: { ...s.login!, sessionProbe: "/api/me" } };
    expect(await client(probed, deps).call(getOrder, { orderId: "1" })).toEqual({ id: "1", total: 5 });
    expect(loginCalls).toEqual([]);
    expect(calls.at(-1)!.headers.authorization).toBe("Bearer new");
  });

  test("a sign-in as someone else (other ids) that captured no record drops the old one: never another login's refresh token (review)", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: { customerId: "C-1" }, refresh: { token: "r-of-C-1" } });
    const { fetch } = site();
    const { deps } = makeDeps(fetch, home.dir);
    deps.login = async () => ({ headers: { authorization: "Bearer other" } });
    const s = refreshSite();
    const other = { ...s, login: { ...s.login!, postLogin: async () => ({ customerId: "C-2" }) } };
    await client(other, deps).signIn(true);
    expect(loadSession(home.dir)).toMatchObject({ ids: { customerId: "C-2" } });
    expect(loadSession(home.dir)!.refresh).toBeUndefined();
  });

  test("after a renew the sessionProbe is asked again; still anonymous means Chrome (review)", async () => {
    savedWithRefresh();
    const { fetch } = fakeFetch((r) => {
      const signedIn = r.headers.authorization === "Bearer chrome";
      if (r.url.endsWith("/api/me")) return signedIn ? json({ ok: true }) : json({}, 401);
      return signedIn ? json({ id: "1", total: 5 }) : json({}, 404);
    });
    const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
    const s = refreshSite(); // renews to "Bearer new", which this site serves as anonymous
    const probed = { ...s, login: { ...s.login!, sessionProbe: "/api/me" } };
    expect(await client(probed, deps).call(getOrder, { orderId: "1" })).toEqual({ id: "1", total: 5 });
    expect(loginCalls).toEqual([true]);
  });

  test("a renew that throws is tried again (a token endpoint that blinked), before Chrome (review)", async () => {
    savedWithRefresh();
    const { fetch } = site();
    const { deps, loginCalls } = makeDeps(fetch, home.dir);
    let attempts = 0;
    const flaky = refreshSite(async (ctx) => {
      // The connection was refused: the request never left, so sending the token again is safe.
      if (++attempts === 1) throw Object.assign(new TypeError("Unable to connect"), { code: "ECONNREFUSED" });
      return { headers: { ...ctx.headers, authorization: "Bearer new" }, refresh: { token: "r2" } };
    });
    await client(flaky, deps).call(getCustomer, { customerId: "C-1" });
    expect(attempts).toBe(2);
    expect(loginCalls).toEqual([]);
  });

  test("a renew that failed after its request may have left (a reset connection) is not sent again in this run (review 3)", async () => {
    savedWithRefresh();
    const { fetch } = site("Bearer chrome");
    const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
    let attempts = 0;
    const reset = refreshSite(async () => {
      attempts++;
      throw Object.assign(new TypeError("The socket connection was closed unexpectedly"), { code: "ECONNRESET" });
    });
    await client(reset, deps).call(getCustomer, { customerId: "C-1" });
    expect(attempts).toBe(1);
    expect(loginCalls).toEqual([true]);
    expect(loadSession(home.dir)!.refresh).toBeUndefined(); // may be spent: never sent again (review 5)
  });

  test("two runs at once: one renews under renew.lock, the other waits and takes its session over; the token is sent once (review 3)", async () => {
    savedWithRefresh();
    const { fetch } = site();
    let sent = 0;
    const slow = refreshSite(async (ctx) => {
      sent++;
      await Bun.sleep(80);
      return { headers: { ...ctx.headers, authorization: "Bearer new" }, refresh: { token: "r2" } };
    });
    const run = () => {
      const { deps, loginCalls } = makeDeps(fetch, home.dir);
      deps.sleep = (ms) => Bun.sleep(ms);
      return { c: client(slow, deps), loginCalls };
    };
    const a = run();
    const b = run();
    const [x, y] = await Promise.all([a.c.call(getCustomer, { customerId: "C-1" }), b.c.call(getCustomer, { customerId: "C-1" })]);
    expect([x, y].map((r: any) => r.data.getCustomer.id)).toEqual(["C-1", "C-1"]);
    expect(sent).toBe(1);
    expect([...a.loginCalls, ...b.loginCalls]).toEqual([]);
    expect(existsSync(join(home.dir, "renew.lock"))).toBe(false);
  });

  test("a silent re-sign-in reads the record after postLogin: another run's rotation during it is kept, not overwritten (review 4)", async () => {
    savedWithRefresh();
    const { fetch } = site();
    const { deps } = makeDeps(fetch, home.dir);
    deps.login = async () => ({ headers: { authorization: "Bearer chrome" } });
    const s = refreshSite();
    const slow = {
      ...s,
      login: {
        ...s.login!,
        postLogin: async () => {
          // Another run renews (r1 → r2) while this sign-in's postLogin is in flight.
          saveSession(home.dir, { headers: { authorization: "Bearer new", cookie: "sid=1" }, ids: { customerId: "C-1" }, refresh: { token: "r2" } });
          return { customerId: "C-1" };
        },
      },
    };
    await client(slow, deps).signIn(true, { keepRefresh: true });
    expect(loadSession(home.dir)!.refresh).toEqual({ token: "r2" });
  });

  test("a sign-in that saw a token exchange keep could not read keeps no old record: that exchange may have rotated it (review 4)", async () => {
    savedWithRefresh();
    const { fetch } = site();
    const { deps } = makeDeps(fetch, home.dir);
    deps.login = async () => ({ headers: { authorization: "Bearer chrome" }, exchanged: true });
    await client(refreshSite(), deps).signIn(true, { keepRefresh: true });
    expect(loadSession(home.dir)!.refresh).toBeUndefined();
  });

  test("a sign-in from another profile than the saved one keeps no old record, even with equal (empty) ids (review 4)", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: {}, fromProfile: "/profiles/a", refresh: { token: "r-of-a" } });
    const { fetch } = site();
    const { deps } = makeDeps(fetch, home.dir);
    deps.login = async () => ({ headers: { authorization: "Bearer b" } });
    const s = refreshSite();
    await client({ ...s, login: { ...s.login!, postLogin: async () => ({}) } }, deps).signIn(true, { keepRefresh: true });
    expect(loadSession(home.dir)!.refresh).toBeUndefined();
  });

  test("another run that dropped the record (same headers) is noticed: the dropped token is not sent (review 4)", async () => {
    savedWithRefresh();
    const { fetch, calls } = site("Bearer chrome");
    const { deps, loginCalls, notes } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
    let renewed = 0;
    const c = client(refreshSite(async () => (renewed++, null)), deps);
    c.peek();
    saveSession(home.dir, { headers: { authorization: "Bearer old", cookie: "sid=1" }, ids: { customerId: "C-1" } }); // dropped by another run
    await c.call(getCustomer, { customerId: "C-1" });
    expect(renewed).toBe(0);
    expect(loginCalls).toEqual([true]);
    // Same expired headers: not sent again as if renewed (review 5).
    expect(calls.filter((r) => r.headers.authorization === "Bearer old")).toHaveLength(1);
    expect(notes.join("\n")).not.toContain("another run renewed");
  });

  test("any renew failure whose request may have reached the site drops the record: a $ZodError, a timeout, a 5xx thrown (review 5)", async () => {
    for (const thrown of [Object.assign(new Error("shape"), { name: "$ZodError" }), Object.assign(new Error("slow"), { name: "TimeoutError" }), new Error("token endpoint answered HTTP 502")]) {
      savedWithRefresh();
      const { fetch } = site("Bearer chrome");
      const { deps } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
      await client(refreshSite(async () => { throw thrown; }), deps).call(getCustomer, { customerId: "C-1" });
      expect(loadSession(home.dir)!.refresh).toBeUndefined();
    }
  });

  test("renew's fetch carries an AbortSignal, so a renew that runs out of time is cancelled, not left open (review 5)", async () => {
    savedWithRefresh();
    const { fetch } = site();
    const { deps } = makeDeps(fetch, home.dir);
    const signals: unknown[] = [];
    deps.plainFetch = async (_input, init) => (signals.push(init?.signal), json({}));
    const s = refreshSite(async (ctx) => {
      await ctx.fetch("https://auth.example.test/token", { method: "POST" });
      return { headers: { ...ctx.headers, authorization: "Bearer new" } };
    });
    await client(s, deps).call(getCustomer, { customerId: "C-1" });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  test("renew's ctx.fetch is plain fetch, also with transport browser: renewing needs no Chrome (review 4)", async () => {
    savedWithRefresh();
    const { fetch } = site();
    const { deps } = makeDeps(fetch, home.dir);
    const used: string[] = [];
    deps.plainFetch = async () => (used.push("plain"), json({}));
    const s = refreshSite(async (ctx) => {
      await ctx.fetch("https://auth.example.test/token");
      return { headers: { ...ctx.headers, authorization: "Bearer new" } };
    });
    await client(s, deps).call(getCustomer, { customerId: "C-1" });
    expect(used).toEqual(["plain"]);
  });

  test("a renew.lock another run holds is waited for by attempts, not wall time, then given up on (review 4)", async () => {
    savedWithRefresh();
    writeFileSync(join(home.dir, "renew.lock"), "other-run");
    const { fetch } = site("Bearer chrome");
    const { deps, loginCalls, notes } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
    const started = Date.now();
    await client(refreshSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(Date.now() - started).toBeLessThan(2_000); // the test deps' sleep is instant
    expect(loginCalls).toEqual([true]);
    expect(notes.join("\n")).toContain("still renewing");
    expect(readFileSync(join(home.dir, "renew.lock"), "utf8")).toBe("other-run"); // never removed another run's lock
  });

  test("a renew.lock left by a run that died is taken over (review 3)", async () => {
    savedWithRefresh();
    writeFileSync(join(home.dir, "renew.lock"), "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(home.dir, "renew.lock"), old, old);
    const { fetch } = site();
    const { deps, loginCalls } = makeDeps(fetch, home.dir);
    await client(refreshSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(loginCalls).toEqual([]);
    expect(loadSession(home.dir)!.refresh).toEqual({ token: "r2" });
  });

  test("another run renewed first (session.json moved on): its session is used, the spent token is not sent (review)", async () => {
    savedWithRefresh();
    const { fetch } = site();
    const { deps, loginCalls } = makeDeps(fetch, home.dir);
    let renewed = 0;
    const c = client(refreshSite(async () => (renewed++, null)), deps);
    c.peek(); // this run read the old session
    saveSession(home.dir, { headers: { authorization: "Bearer new", cookie: "sid=1" }, ids: { customerId: "C-1" }, refresh: { token: "r2" } });
    await c.call(getCustomer, { customerId: "C-1" });
    expect(renewed).toBe(0);
    expect(loginCalls).toEqual([]);
    expect(loadSession(home.dir)!.refresh).toEqual({ token: "r2" });
  });

  test("with `from` set and no record kept, renew is not tried (review)", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: { customerId: "C-1" } });
    const { fetch } = site("Bearer chrome");
    const { deps, loginCalls, notes } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
    let renewed = 0;
    const s = loginSite({ login: { ...loginSite().login!, refresh: { from: "/oauth/token", keep: () => ({}), renew: async () => (renewed++, null) } } });
    await client(s, deps).call(getCustomer, { customerId: "C-1" });
    expect(renewed).toBe(0);
    expect(loginCalls).toEqual([true]);
    expect(notes.join("\n")).not.toContain("renewing the sign-in");
  });

  test("a refused refresh token is dropped from session.json, so it is never sent again (review)", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: { customerId: "C-1" }, refresh: { token: "dead" } });
    const { fetch } = site("Bearer chrome");
    const { deps } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
    await client(refreshSite(), deps).call(getCustomer, { customerId: "C-1" });
    expect(loadSession(home.dir)!.refresh).toBeUndefined();
  });

  test("a renew closes transport browser's Chrome, so the retry carries the renewed cookies (review)", async () => {
    savedWithRefresh();
    const order: string[] = [];
    const { fetch } = site();
    const { deps } = makeDeps(fetch, home.dir);
    deps.release = async () => void order.push("release");
    await client(refreshSite(async (ctx) => (order.push("renew"), { headers: { ...ctx.headers, authorization: "Bearer new" } })), deps).call(getCustomer, { customerId: "C-1" });
    expect(order).toEqual(["renew", "release"]);
  });

  test("a sign-in saves the refresh record login captured; a silent re-sign-in that captured none keeps the old one, an explicit login does not", async () => {
    const { fetch } = site();
    const { deps } = makeDeps(fetch, home.dir);
    deps.login = async () => ({ headers: { authorization: "Bearer new" }, refresh: { token: "r0" } });
    await client(refreshSite(), deps).signIn(false);
    expect(loadSession(home.dir)!.refresh).toEqual({ token: "r0" });
    deps.login = async () => ({ headers: { authorization: "Bearer newer" } });
    await client(refreshSite(), deps).signIn(true, { keepRefresh: true });
    expect(loadSession(home.dir)).toMatchObject({ headers: { authorization: "Bearer newer" }, refresh: { token: "r0" } });
    // `login` (no keepRefresh): the computer must not keep a token it may share with a server (review 2).
    await client(refreshSite(), deps).signIn(false);
    expect(loadSession(home.dir)!.refresh).toBeUndefined();
  });

  test("a silent re-sign-in keeps the record also when postLogin returns no ids, as long as they match (review 2)", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: {}, refresh: { token: "r1" } });
    const { fetch } = site();
    const { deps } = makeDeps(fetch, home.dir);
    deps.login = async () => ({ headers: { authorization: "Bearer new" } });
    const s = refreshSite();
    await client({ ...s, login: { ...s.login!, postLogin: async () => ({}) } }, deps).signIn(true, { keepRefresh: true });
    expect(loadSession(home.dir)!.refresh).toEqual({ token: "r1" });
  });

  test("a refused renew rereads session.json: another run's renewal is taken over, never overwritten (review 2)", async () => {
    savedWithRefresh();
    const { fetch } = site();
    const { deps, loginCalls } = makeDeps(fetch, home.dir);
    const racing = refreshSite(async () => {
      // Another run renews while this one's request is in flight; this one's token is then spent.
      saveSession(home.dir, { headers: { authorization: "Bearer new", cookie: "sid=1" }, ids: { customerId: "C-1" }, refresh: { token: "r2" } });
      return null;
    });
    await client(racing, deps).call(getCustomer, { customerId: "C-1" });
    expect(loginCalls).toEqual([]);
    expect(loadSession(home.dir)).toMatchObject({ headers: { authorization: "Bearer new" }, refresh: { token: "r2" } });
  });

  test("a renew whose answer no longer parses (ZodError, SyntaxError) is not sent again: the token may already be rotated (review 2)", async () => {
    savedWithRefresh();
    const { fetch } = site("Bearer chrome");
    const { deps, loginCalls, notes } = makeDeps(fetch, home.dir, [{ authorization: "Bearer chrome" }]);
    let attempts = 0;
    const changed = refreshSite(async () => {
      attempts++;
      throw Object.assign(new Error("bad shape"), { name: "ZodError" });
    });
    await client(changed, deps).call(getCustomer, { customerId: "C-1" });
    expect(attempts).toBe(1);
    expect(loginCalls).toEqual([true]);
    expect(notes.join("\n")).toContain("so it is dropped");
    expect(loadSession(home.dir)!.refresh).toBeUndefined(); // possibly spent: never sent again, not even by a later run (review 3)
  });

  test("listAccounts never writes back a session older than another run's renewal (review 3)", async () => {
    savedWithRefresh();
    const { fetch } = site("Bearer old");
    const { deps } = makeDeps(fetch, home.dir);
    const c = client(loginSite({ accounts: async () => [{ id: "A1" }] }), deps);
    c.peek();
    saveSession(home.dir, { headers: { authorization: "Bearer new", cookie: "sid=1" }, ids: { customerId: "C-1" }, refresh: { token: "r2" } });
    await c.listAccounts();
    expect(loadSession(home.dir)).toMatchObject({ headers: { authorization: "Bearer new" }, refresh: { token: "r2" }, accounts: [{ id: "A1" }] });
  });

  test("taking over another run's session does not write session.json again (review 2)", async () => {
    savedWithRefresh();
    const { fetch } = site();
    const { deps } = makeDeps(fetch, home.dir);
    const c = client(refreshSite(async () => null), deps);
    c.peek();
    const theirs = saveSession(home.dir, { headers: { authorization: "Bearer new" }, ids: { customerId: "C-1" }, refresh: { token: "r2" }, savedAt: "2026-01-02T00:00:00.000Z" });
    await c.call(getCustomer, { customerId: "C-1" });
    expect(loadSession(home.dir)!.savedAt).toBe(theirs.savedAt);
  });
});

describe("bot block: network with `blocked`, never Drift, no sign-in spent on it (#95)", () => {
  const html = (body: string, status: number, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
  const challenge = "<!doctype html><title>Just a moment...</title><div id=cf-chl-widget>Checking your browser</div>";

  const blocked = async (answer: () => Response, site = loginSite()) => {
    saved();
    const { fetch, calls } = fakeFetch(answer);
    const { deps, loginCalls } = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
    const e = await failure(client(site, deps).call(getCustomer, { customerId: "C-1" }));
    return { e, loginCalls, calls };
  };

  test("a 403 with Cloudflare's cf-mitigated header", async () => {
    const { e, loginCalls, calls } = await blocked(() => html("<html>blocked</html>", 403, { "cf-mitigated": "challenge" }));
    expect(e.kind).toBe("network");
    expect(e.details.blocked).toBe("cloudflare");
    expect(e.message).toMatch(/getCustomer: the site refused the request as automated traffic \(bot protection: cloudflare\)/);
    expect(loginCalls).toEqual([]); // a sign-in would not get past it
    expect(calls).toHaveLength(1); // nor would a retry
  });

  test("a challenge page with no header, as 403, 503 or even 200 where JSON is expected", async () => {
    for (const status of [403, 503, 200]) {
      const { e } = await blocked(() => html(challenge, status));
      expect([status, e.kind, e.details.blocked]).toEqual([status, "network", "cloudflare"]);
    }
  });

  test("other vendors' markers: DataDome, PerimeterX, Imperva, a captcha", async () => {
    const cases: [Response, string][] = [
      [html(`<script src="https://geo.captcha-delivery.com/captcha/"></script>`, 403), "datadome"],
      [html(`<div id="px-captcha"></div>`, 403), "perimeterx"],
      [html("Request unsuccessful. Incapsula incident ID: 0-0", 403), "imperva"],
      [html(`<div class="g-recaptcha"></div>`, 403), "captcha"],
    ];
    for (const [res, vendor] of cases) expect((await blocked(() => res.clone())).e.details.blocked).toBe(vendor);
  });

  test("a plain refusal is still what it was: a JSON 403 is auth Drift after a sign-in, an HTML 404 is http Drift", async () => {
    const auth = await blocked(() => json({ error: "forbidden" }, 403));
    expect([auth.e.kind, auth.e.details.blocked]).toEqual(["drift", undefined]);
    expect(auth.loginCalls).toEqual([true]);
    const gone = await blocked(() => html("<html><h1>Not found</h1></html>", 404));
    expect([gone.e.kind, gone.e.fingerprint]).toEqual(["drift", expect.stringContaining(":http::404")]);
  });

  test("blockSignal is not fooled by ordinary pages of protected sites (review)", () => {
    const h = (o: Record<string, string> = {}) => new Headers({ "content-type": "text/html", ...o });
    // DataDome tags ordinary answers with x-datadome too: a header alone is no block.
    expect(blockSignal(401, h({ "x-datadome": "protected" }), "")).toBeUndefined();
    expect(blockSignal(404, h({ "x-datadome": "protected" }), "<html>Not found</html>")).toBeUndefined();
    // Cloudflare injects its challenge-platform script into ordinary pages.
    expect(blockSignal(404, h(), `<html><h1>Not found</h1><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></html>`)).toBeUndefined();
    // A sign-in page with a captcha on it is a sign-in page.
    expect(blockSignal(401, h(), `<form action="/login"><div class="g-recaptcha"></div></form>`)).toBeUndefined();
    expect(blockSignal(200, h(), `<form action="/login"><div class="g-recaptcha"></div></form>`)).toBeUndefined();
    // Still blocks: a captcha wall, DataDome's captcha host, Cloudflare's challenge page.
    expect(blockSignal(403, h(), `<div class="g-recaptcha"></div>`)).toBe("captcha");
    expect(blockSignal(403, h({ "x-datadome": "protected" }), `<script src="https://geo.captcha-delivery.com/c.js"></script>`)).toBe("datadome");
    expect(blockSignal(200, h(), "<title>Just a moment...</title>")).toBe("cloudflare");
    // An API call is blocked with JSON by DataDome and PerimeterX (review 2).
    expect(blockSignal(403, h(), { url: "https://geo.captcha-delivery.com/captcha/?initialCid=x" })).toBe("datadome");
    expect(blockSignal(403, h(), { appId: "PXabc", blockScript: "/abc/captcha.js", jsClientSrc: "/abc/init.js" })).toBe("perimeterx");
    expect(blockSignal(403, h(), { error: "forbidden" })).toBeUndefined();
    expect(blockSignal(200, h(), { url: "https://geo.captcha-delivery.com/captcha/" })).toBeUndefined(); // data, not a refusal
    // A sign-in page with a captcha stays a sign-in page, even as a 403 (review 2).
    expect(blockSignal(403, h(), `<form action="/login"><input type="password" name="pw"><div class="g-recaptcha"></div></form>`)).toBeUndefined();
    // Akamai writes its markers as HTML entities (review 2).
    expect(blockSignal(403, h(), "<H1>Access Denied</H1> Reference&#32;&#35;18&#46;a1b2c3d4&#46;1700000000&#46;5e6f7a8b <P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;")).toBe("akamai");
  });

  test("a hook's own request that meets the wall is a block too, never a bug; renew keeps its token (review)", async () => {
    const wall = () => html(challenge, 403);
    // bootstrap's first request
    const boot = makeSite({ bootstrap: async (ctx) => {
      const res = await ctx.fetch(`${ctx.origin}/`);
      if (!res.ok) throw new Error(`front page answered HTTP ${res.status}`);
      return { headers: {} };
    } });
    const { fetch } = fakeFetch(wall);
    const e = await failure(client(boot, makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C" }));
    expect([e.kind, e.details.blocked]).toEqual(["network", "cloudflare"]);
    // renew's request: only the token endpoint is walled, so Chrome signs in instead (review 2);
    // the refresh token, which the site never took, stays.
    saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: { customerId: "C-1" }, refresh: { token: "r1" } });
    const renewing = loginSite({ login: { ...loginSite().login!, postLogin: async () => ({ customerId: "C-1" }), refresh: { renew: async (ctx) => {
      const res = await ctx.fetch("https://auth.example.test/token");
      return res.ok ? { headers: { authorization: "Bearer new" } } : null;
    } } } });
    const site401 = fakeFetch((r) =>
      r.url.includes("auth.example.test") ? wall() : r.headers.authorization === "Bearer chrome" ? json({ data: { getCustomer: { id: "C-1", name: "n" } } }) : json({}, 401),
    );
    const d = makeDeps(site401.fetch, home.dir);
    d.deps.login = async () => ({ headers: { authorization: "Bearer chrome" } });
    const out: any = await client(renewing, d.deps).call(getCustomer, { customerId: "C-1" });
    expect(out.data.getCustomer.id).toBe("C-1");
    expect(d.notes.join("\n")).toContain("automated traffic");
  });

  test("a hook reads an answer as an Operation does: a JSON refusal is a block, an HTML page labelled JSON is read too (review 2)", async () => {
    const boot = (answer: () => Response) => {
      const site = makeSite({ bootstrap: async (ctx) => {
        const res = await ctx.fetch(`${ctx.origin}/`);
        if (!res.ok) throw new Error(`front page answered HTTP ${res.status}`);
        return { headers: {} };
      } });
      return failure(client(site, makeDeps(fakeFetch(answer).fetch, home.dir).deps).call(getCustomer, { customerId: "C" }));
    };
    const dd = await boot(() => json({ url: "https://geo.captcha-delivery.com/captcha/?initialCid=x" }, 403));
    expect([dd.kind, dd.details.blocked]).toEqual(["network", "datadome"]);
    const mislabelled = await boot(() => new Response(challenge, { status: 403, headers: { "content-type": "application/json" } }));
    expect([mislabelled.kind, mislabelled.details.blocked]).toEqual(["network", "cloudflare"]);
  });

  test("an ordinary page that mentions a reference number is no Akamai block (review 3)", () => {
    const h = () => new Headers();
    expect(blockSignal(200, h(), "<p>See Reference #2.1 in the terms</p>")).toBeUndefined();
    expect(blockSignal(200, h(), "Order Reference #12345.0")).toBeUndefined();
    expect(blockSignal(403, h(), "<H1>Access Denied</H1> Reference #18.5b3c1002.1700000000.1a2b3c")).toBe("akamai");
  });

  test("a hook's manual redirect to a captcha host is a block, not the hook's bug (review 3)", async () => {
    const site = makeSite({ bootstrap: async (ctx) => {
      const res = await ctx.fetch(`${ctx.origin}/`, { redirect: "manual" });
      if (!res.ok) throw new Error(`front page answered HTTP ${res.status}`);
      return { headers: {} };
    } });
    const { fetch } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://geo.captcha-delivery.com/captcha/?initialCid=x" } }));
    const e = await failure(client(site, makeDeps(fetch, home.dir).deps).call(getCustomer, { customerId: "C" }));
    expect([e.kind, e.details.blocked]).toEqual(["network", "datadome"]);
  });

  test("a renew refused by the wall with no Chrome sign-in after it (the Setup page's check, MCP) reports the wall, not an expired sign-in (review 3)", async () => {
    const wall = () => html(challenge, 403);
    const site = loginSite({ login: { ...loginSite().login!, refresh: { renew: async (ctx) => {
      const res = await ctx.fetch("https://auth.example.test/token");
      return res.ok ? { headers: { authorization: "Bearer new" } } : null;
    } } } });
    const answer = (r: { url: string }) => (r.url.includes("auth.example.test") ? wall() : json({}, 401));
    const session = { headers: { authorization: "Bearer old" }, ids: { customerId: "C-1" }, refresh: { token: "r1" }, savedAt: new Date().toISOString() };
    // The Setup page's check: renew only.
    const setup = await failure(new Client(site, makeDeps(fakeFetch(answer).fetch, home.dir).deps, { session, reauth: "renew" }).call(getCustomer, { customerId: "C-1" }));
    expect([setup.kind, setup.details.blocked]).toEqual(["network", "cloudflare"]);
    // MCP: the headless sign-in does not complete either.
    saveSession(home.dir, session);
    const mcp = makeDeps(fakeFetch(answer).fetch, home.dir);
    mcp.deps.login = async () => null;
    const viaMcp = await failure(new Client(site, mcp.deps, { surface: "mcp" }).call(getCustomer, { customerId: "C-1" }));
    expect([viaMcp.kind, viaMcp.details.blocked]).toEqual(["network", "cloudflare"]);
  });

  test("a block that comes as a redirect to a captcha host is a block, not offsite Drift (review 2)", async () => {
    saved();
    const { fetch } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://geo.captcha-delivery.com/captcha/?initialCid=x" } }));
    const { deps } = makeDeps(fetch, home.dir);
    const e = await failure(client(loginSite(), deps).call(getCustomer, { customerId: "C-1" }));
    expect([e.kind, e.details.blocked]).toEqual(["network", "datadome"]);
  });

  test("ctx.cookies(): the session's cookie whatever the header's case, and only cookies of the site's own hosts (review 2)", async () => {
    saveSession(home.dir, { headers: { Cookie: "sid=s1" }, ids: {} });
    const asked: (string | undefined)[] = [];
    let seen: Record<string, string> = {};
    const site = loginSite({
      accounts: async (ctx) => {
        await ctx.fetch("https://auth.example.test/x");
        await ctx.fetch(`${ctx.origin}/y`);
        seen = await ctx.cookies();
        return [];
      },
    });
    const { fetch } = fakeFetch((r) =>
      new Response("{}", { headers: [["content-type", "application/json"], ["set-cookie", r.url.includes("auth.example.test") ? "csrf=other-host" : "csrf=ours"]] }),
    );
    const { deps } = makeDeps(fetch, home.dir);
    deps.cookies = async (cookie) => (asked.push(cookie), {});
    await client(site, deps).listAccounts(true);
    expect(asked).toEqual(["sid=s1"]);
    expect(seen).toEqual({ csrf: "ours" });
  });

  test("a sessionProbe answered by a challenge is not a sign-out: no sign-in, the Operation reports the block", async () => {
    const s = loginSite({ login: { ...loginSite().login!, sessionProbe: "/api/me" } });
    const { e, loginCalls } = await blocked(() => html(challenge, 403), s);
    expect([e.kind, e.details.blocked]).toEqual(["network", "cloudflare"]);
    expect(loginCalls).toEqual([]);
  });
});
