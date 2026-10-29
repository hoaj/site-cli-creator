// The classification table (SPEC §10), row by row, against a fake fetch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildRequest, Client } from "../src/runtime/call";
import { DryRun, Failure } from "../src/runtime/envelope";
import { defineOperation } from "../src/runtime/operation";
import { loadSession, saveSession } from "../src/runtime/session";
import { client, fakeFetch, getCustomer, getOrder, json, listProducts, loginSite, makeDeps, makeSite, renameOrder, tempHome } from "./helpers";

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
      if (++attempts === 1) throw new TypeError("fetch failed");
      return { headers: { ...ctx.headers, authorization: "Bearer new" }, refresh: { token: "r2" } };
    });
    await client(flaky, deps).call(getCustomer, { customerId: "C-1" });
    expect(attempts).toBe(2);
    expect(loginCalls).toEqual([]);
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
    expect(notes.join("\n")).toContain("no longer fits");
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
