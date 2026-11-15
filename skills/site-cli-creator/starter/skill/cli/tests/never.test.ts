// site.never: requests the CLI must never send (#101). The matcher, and every place a request leaves.
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Client } from "../src/runtime/call";
import { check, triggerVerdict, type Captured } from "../src/runtime/check";
import { defineCommand } from "../src/runtime/command";
import { ContractError, DryRun } from "../src/runtime/envelope";
import { help } from "../src/runtime/help";
import { forbiddenOperation, forbiddenRequest, neverInSource, neverProblems, NeverSent, neverRuleLabel, stripNeverList } from "../src/runtime/never";
import { defineOperation } from "../src/runtime/operation";
import { loadSession, saveSession, stateDir } from "../src/runtime/session";
import { siteProblems, type NeverRule } from "../src/runtime/site";
import { run, type App } from "../src/main";
import { fakeFetch, getOrder, json, loginSite, makeDeps, makeSite, ORIGIN, renameOrder, tempHome } from "./helpers";

const NEVER: NeverRule[] = [
  { method: "POST", path: "/api/order/place*", why: "Placing an order: the user always pays" },
  { path: "/api/account/*/delete", why: "Deleting the account" },
  { graphql: "PlaceOrder", why: "Placing an order: the user always pays" },
];

const placeOrder = defineOperation({
  name: "POST /api/order/place",
  effect: "write",
  rest: { method: "POST", path: "/api/order/place", body: () => ({}) },
  variables: z.object({}),
  response: z.unknown(),
});

const deleteAccount = defineOperation({
  name: "DELETE /api/account/:id/delete",
  effect: "write",
  rest: { method: "DELETE", path: "/api/account/:id/delete" },
  variables: z.object({ id: z.string() }),
  response: z.unknown(),
});

const gqlPlace = defineOperation({
  name: "checkout",
  effect: "write",
  graphql: "mutation PlaceOrder { placeOrder { id } }",
  variables: z.object({}),
  response: z.unknown(),
});

/** A REST Operation whose path template only reaches a forbidden path through a variable: the runtime refuses that call. */
const anyOrderAction = defineOperation({
  name: "POST /api/order/:action",
  effect: "write",
  rest: { method: "POST", path: "/api/order/:action" },
  variables: z.object({ action: z.string() }),
  response: z.unknown(),
});

const homes: Array<() => void> = [];
afterEach(() => homes.splice(0).forEach((c) => c()));
const home = () => {
  const h = tempHome();
  homes.push(h.cleanup);
  return h.dir;
};

describe("matching", () => {
  const site = makeSite({ never: NEVER });

  test("a request matches by method and path glob, case-insensitively, with or without a trailing slash", () => {
    const r = (method: string, url: string, body?: string) => forbiddenRequest(site, { method, url, body })?.why;
    expect(r("POST", `${ORIGIN}/api/order/place`)).toBe("Placing an order: the user always pays");
    expect(r("post", `${ORIGIN}/API/Order/PlaceNow?x=1`)).toBe("Placing an order: the user always pays");
    expect(r("POST", `${ORIGIN}/api/order/place/`)).toBe("Placing an order: the user always pays");
    expect(r("POST", `${ORIGIN}//api/order/%70lace`)).toBe("Placing an order: the user always pays");
    expect(r("GET", `${ORIGIN}/api/order/place`)).toBeUndefined();
    expect(r("POST", `${ORIGIN}/api/order/cart`)).toBeUndefined();
    // No method on the rule: every method.
    expect(r("GET", `${ORIGIN}/api/account/42/delete`)).toBe("Deleting the account");
    expect(r("DELETE", `${ORIGIN}/api/account/42/delete`)).toBe("Deleting the account");
    expect(r("DELETE", `${ORIGIN}/api/account/42/delete/now`)).toBeUndefined();
  });

  test("a GraphQL rule matches the operationName or any definition the document holds, batches and GET queries too", () => {
    const r = (body: unknown, url = `${ORIGIN}/graphql`) => forbiddenRequest(site, { method: "POST", url, body: JSON.stringify(body) })?.why;
    expect(r({ operationName: "PlaceOrder", query: "mutation PlaceOrder { x }" })).toBeDefined();
    expect(r({ operationName: "placeorder" })).toBeDefined();
    expect(r({ operationName: "harmless", query: "query harmless { x }\nmutation PlaceOrder { y }" })).toBeDefined();
    expect(r([{ operationName: "a", query: "query a { x }" }, { operationName: "PlaceOrder", query: "mutation PlaceOrder { y }" }])).toBeDefined();
    expect(r({ operationName: "getCart", query: "query getCart { cart { placeOrderAllowed } }" })).toBeUndefined();
    expect(forbiddenRequest(site, { method: "GET", url: `${ORIGIN}/graphql?operationName=PlaceOrder&query=x` })).toBeDefined();
    expect(forbiddenRequest(site, { method: "POST", url: `${ORIGIN}/graphql`, body: "not json" })).toBeUndefined();
  });

  test("an Operation matches by its declared request: REST template either way round, GraphQL by name or definition", () => {
    expect(forbiddenOperation(site, placeOrder)?.why).toBe("Placing an order: the user always pays");
    expect(forbiddenOperation(site, deleteAccount)?.why).toBe("Deleting the account");
    expect(forbiddenOperation(site, gqlPlace)?.why).toBe("Placing an order: the user always pays");
    // Only a variable makes it forbidden: left to the runtime, so a read of /api/order/:id is no match.
    expect(forbiddenOperation(site, anyOrderAction)).toBeUndefined();
    const readAny = defineOperation({ name: "GET /api/account/:id", effect: "read", rest: { method: "GET", path: "/api/account/:id" }, variables: z.object({ id: z.string() }), response: z.unknown() });
    expect(forbiddenOperation(makeSite({ never: [{ path: "/api/account/*", why: "w" }] }), readAny)?.why).toBe("w");
    expect(forbiddenOperation(makeSite({ never: [{ path: "/api/account/close*", why: "w" }] }), readAny)).toBeUndefined();
    expect(forbiddenOperation(site, getOrder)).toBeUndefined();
    expect(forbiddenOperation(site, renameOrder)).toBeUndefined();
    // A REST rule on the GraphQL endpoint covers every GraphQL Operation.
    expect(forbiddenOperation(makeSite({ never: [{ method: "POST", path: "/graphql", why: "no GraphQL writes" }] }), gqlPlace)?.why).toBe("no GraphQL writes");
  });

  test("neverProblems names each forbidden Operation, its rule and the reason", () => {
    expect(neverProblems(site, [getOrder, placeOrder, gqlPlace])).toEqual([
      "POST /api/order/place matches site.never POST /api/order/place* (Placing an order: the user always pays)",
      "checkout matches site.never GraphQL PlaceOrder (Placing an order: the user always pays)",
    ]);
    expect(neverProblems(makeSite(), [placeOrder])).toEqual([]);
    expect(NEVER.map(neverRuleLabel)).toEqual(["POST /api/order/place*", "/api/account/*/delete", "GraphQL PlaceOrder"]);
  });

  test("neverInSource finds a forbidden path or GraphQL name in source text, not a longer word or path, nor a path only another method uses", () => {
    const files = [
      { path: "src/commands/order-place.ts", text: 'await fetch(`${origin}/api/order/placeNow`, { method: "POST" });' },
      { path: "src/operations/del.ts", text: 'rest: { method: "DELETE", path: "/api/account/:id/delete" }' },
      { path: "src/lib/gql.ts", text: "const q = `mutation PlaceOrder { placeOrder { id } }`;" },
      { path: "src/operations/fine.ts", text: 'path: "/api/order/cart", other: "/api/account/:id/deleted", graphql: "query PlaceOrderStatus { x }"' },
      // The POST rule's path, read with GET: no match.
      { path: "src/operations/status.ts", text: 'rest: { method: "GET", path: "/api/order/place/status" }' },
    ];
    expect(neverInSource(site, files)).toEqual([
      "src/commands/order-place.ts names POST /api/order/place* (Placing an order: the user always pays)",
      "src/operations/del.ts names /api/account/*/delete (Deleting the account)",
      "src/lib/gql.ts names GraphQL PlaceOrder (Placing an order: the user always pays)",
    ]);
  });

  test("siteProblems refuses a malformed never list", () => {
    const p = (never: unknown) => siteProblems(makeSite({ never: never as NeverRule[] }));
    expect(p(NEVER)).toEqual([]);
    expect(p("nope")).toEqual(["never must be a list of { method?, path, why } or { graphql, why }"]);
    expect(p([{ path: "/x" }])).toEqual(["never[0] needs a why: what the request does and why the CLI never sends it"]);
    expect(p([{ path: "api/x", why: "w" }])).toEqual(["never[0].path must start with /"]);
    expect(p([{ method: "SEND", path: "/x", why: "w" }])).toEqual(["never[0].method must be GET, POST, PUT, PATCH or DELETE"]);
    expect(p([{ graphql: "Place Order", why: "w" }])).toEqual(["never[0].graphql must be a GraphQL operation name"]);
    expect(p([{ graphql: "P", path: "/x", why: "w" }])).toEqual(["never[0] takes a path or a graphql name, not both"]);
    expect(p([{ graphql: "P", method: "POST", why: "w" }])).toEqual(["never[0].method goes only with a path: a graphql entry matches every request that carries the name"]);
    expect(p([{ why: "w" }])).toEqual(["never[0] needs a path or a graphql name"]);
  });
});

describe("the runtime refuses before anything leaves", () => {
  const site = makeSite({ never: NEVER });

  test("call refuses a forbidden write before its dry run, and with --confirm sends nothing", async () => {
    for (const confirm of [false, true]) {
      const f = fakeFetch(() => json({}));
      const { deps } = makeDeps(f.fetch, home());
      const c = new Client(site, deps, { confirm });
      const e = (await c.call(placeOrder, {}).catch((x) => x)) as Error;
      expect(e).toBeInstanceOf(NeverSent);
      expect(e).toBeInstanceOf(ContractError);
      expect(e).not.toBeInstanceOf(DryRun);
      expect(e.message).toBe("POST /api/order/place is a request site.never forbids (POST /api/order/place*: Placing an order: the user always pays), so nothing was sent.");
      expect(f.calls).toEqual([]);
    }
  });

  test("call refuses a template that only reaches the forbidden path through a variable, and a GraphQL read under another name", async () => {
    const f = fakeFetch(() => json({}));
    const { deps } = makeDeps(f.fetch, home());
    const c = new Client(site, deps, { confirm: true });
    expect(await c.call(anyOrderAction, { action: "place" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    const sneaky = defineOperation({ name: "getCart", effect: "read", graphql: "mutation PlaceOrder { x }", variables: z.object({}), response: z.unknown() });
    expect(await c.call(sneaky, {}).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(f.calls).toEqual([]);
  });

  test("a redirect to a forbidden path is not followed", async () => {
    const f = fakeFetch((req) => (new URL(req.url).pathname === "/api/orders/1" ? new Response(null, { status: 307, headers: { location: "/api/order/place" } }) : json({ id: "1", total: 1 })));
    const { deps } = makeDeps(f.fetch, home());
    // The 307 keeps the GET, so the rule names no method.
    const c = new Client(makeSite({ never: [{ path: "/api/order/place", why: "Placing an order" }] }), deps, { confirm: true });
    expect(await c.call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(f.calls.map((r) => new URL(r.url).pathname)).toEqual(["/api/orders/1"]);
  });

  test("site hooks' ctx.fetch refuses a forbidden request (postLogin, bootstrap)", async () => {
    const f = fakeFetch(() => json({}));
    const s = loginSite({
      never: NEVER,
      login: { startUrl: `${ORIGIN}/account`, hosts: [], tokenRequest: "/graphql", postLogin: async (ctx) => (await ctx.fetch(`${ctx.origin}/api/order/place`, { method: "POST" }), {}) },
    });
    const { deps } = makeDeps(f.fetch, home(), [{ authorization: "Bearer t" }]);
    const c = new Client(s, deps, { confirm: true });
    expect(await c.call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(f.calls).toEqual([]);

    const b = makeSite({ never: NEVER, bootstrap: async (ctx) => (await ctx.fetch(new Request(`${ctx.origin}/graphql`, { method: "POST", body: JSON.stringify({ operationName: "PlaceOrder" }) })), { headers: {} }) });
    const c3 = new Client(b, makeDeps(f.fetch, home()).deps);
    expect(await c3.call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(f.calls).toEqual([]);
  });

  test("login.refresh.renew cannot send a forbidden request, and the refresh record is kept (nothing left)", async () => {
    const f = fakeFetch((req) => (new URL(req.url).pathname === "/api/orders/1" ? json({}, 401) : json({})));
    const s = loginSite({
      never: [{ path: "/oauth/revoke", why: "Revoking every sign-in" }],
      login: {
        startUrl: `${ORIGIN}/account`,
        hosts: [],
        tokenRequest: "/graphql",
        refresh: { renew: async (ctx) => (await ctx.fetch(`${ctx.origin}/oauth/revoke`, { method: "POST" }), { headers: {} }) },
      },
    });
    const h = home();
    const { deps } = makeDeps(f.fetch, h);
    saveSession(stateDir(s, deps.env), { headers: { authorization: "Bearer old" }, ids: {}, refresh: { token: "rt" } });
    const c = new Client(s, deps, { confirm: true });
    expect(await c.call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(f.calls.map((r) => new URL(r.url).pathname)).toEqual(["/api/orders/1"]);
    expect(loadSession(stateDir(s, deps.env))?.refresh).toEqual({ token: "rt" });
  });

  test("a sessionProbe on a forbidden path is refused, not read as signed out", async () => {
    const f = fakeFetch(() => json({ id: "1", total: 1 }));
    const s = loginSite({ never: [{ path: "/api/me", why: "w" }], login: { startUrl: `${ORIGIN}/account`, hosts: [], tokenRequest: "/graphql", sessionProbe: "/api/me" } });
    const { deps, loginCalls } = makeDeps(f.fetch, home());
    saveSession(stateDir(s, deps.env), { headers: { authorization: "Bearer t" }, ids: {} });
    const c = new Client(s, deps, { confirm: true });
    expect(await c.call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(loginCalls).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  test("a command that sends a forbidden request exits 1 (bug) with its own next step; nothing is sent", async () => {
    const f = fakeFetch(() => json({}));
    const placeCmd = defineCommand({ name: "order place", summary: "Place the order", args: z.object({}), uses: [placeOrder], run: async (_a, ctx) => ctx.call(placeOrder, {}) });
    const app: App = { site, operations: [placeOrder], commands: [placeCmd], deps: { ...makeDeps(f.fetch, home()).deps } };
    for (const argv of [["order", "place"], ["order", "place", "--confirm"]]) {
      const r = await run(argv, app);
      expect(r.code).toBe(1);
      const err = (r.output as any).error;
      expect(err.kind).toBe("bug");
      expect(err.message).toContain("site.never forbids (POST /api/order/place*: Placing an order: the user always pays)");
      expect(err.fingerprint).toStartWith("acme:shop:bug:order-place:NeverSent:");
      expect(err.next).toBe(
        "Stop: the shop CLI never sends this request (Placing an order: the user always pays). Tell the user to do it on the site themselves. Do not work around it with raw calls, curl or the browser. A command that tries it is a bug: offer to file it through the acme-feedback skill, passing this whole envelope, and file it only if the user says yes.",
      );
    }
    expect(f.calls).toEqual([]);
  });

  test("help lists the never list", () => {
    expect(help(site, []).never).toEqual([
      { request: "POST /api/order/place*", why: "Placing an order: the user always pays" },
      { request: "/api/account/*/delete", why: "Deleting the account" },
      { request: "GraphQL PlaceOrder", why: "Placing an order: the user always pays" },
    ]);
    expect(help(makeSite(), []).never).toBeUndefined();
  });
});

describe("check", () => {
  const site = makeSite({ never: NEVER });

  test("check refuses a registry holding a forbidden Operation before it calls anything, writes included", async () => {
    const f = fakeFetch(() => json({ id: "1", total: 1 }));
    const c = new Client(site, makeDeps(f.fetch, home()).deps);
    const e = await check(c, [getOrder, placeOrder], {}).catch((x) => x);
    expect(e).toBeInstanceOf(ContractError);
    expect(e.message).toBe("check: site.never forbids Operations in the registry: POST /api/order/place matches site.never POST /api/order/place* (Placing an order: the user always pays)");
    expect(f.calls).toEqual([]);
  });

  test("a trigger's request that site.never forbids is aborted whatever else would let it through, and reported", async () => {
    const s = makeSite({ never: [...NEVER, { path: "/checkout*", why: "Opening checkout" }], readOnlyRequests: ["/api/order/place"] });
    const req = (method: string, path: string, body?: unknown): Captured => ({ method, url: new URL(`${ORIGIN}${path}`), body, contentType: "application/json" });
    const v = (r: Captured) => triggerVerdict(s, renameOrder, [renameOrder], [], ORIGIN, r);
    expect(v(req("POST", "/api/order/place"))).toBe("never");
    expect(v(req("GET", "/checkout/step-1"))).toBe("never");
    expect(v(req("POST", "/graphql", { operationName: "PlaceOrder", query: "query PlaceOrder { x }" }))).toBe("never");
    expect(v(req("PATCH", "/api/orders/5", { name: "x" }))).toBe("target");
    expect(v(req("GET", "/orders"))).toBe("pass");

    const checker = async (_w: unknown, _r: unknown, _d: unknown, warn?: (m: string) => void) => {
      warn?.("PATCH /api/orders/:orderId's trigger sent a request site.never forbids (POST /api/order/place*: Placing an order: the user always pays); it was aborted");
      return new Map([[renameOrder.name, null]]);
    };
    const write = defineOperation({ ...renameOrder, trigger: async () => {} });
    const c = new Client(s, makeDeps(fakeFetch(() => json({})).fetch, home()).deps);
    const r = await check(c, [write], { writes: true }, checker as never);
    expect(r.ok).toBe(false);
    expect(r.warnings).toEqual(["PATCH /api/orders/:orderId's trigger sent a request site.never forbids (POST /api/order/place*: Placing an order: the user always pays); it was aborted"]);
  });
});

describe("review round 1", () => {
  const site = makeSite({ never: NEVER });

  test("a hook's ctx.fetch checks every redirect hop, and still follows one to an allowed path", async () => {
    const f = fakeFetch((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/start") return new Response(null, { status: 307, headers: { location: "/api/order/place" } });
      if (path === "/api/go") return new Response(null, { status: 302, headers: { location: "/api/ok" } });
      return json({ ok: true });
    });
    const s = loginSite({
      never: NEVER,
      login: { startUrl: `${ORIGIN}/account`, hosts: [], tokenRequest: "/graphql", postLogin: async (ctx) => (await ctx.fetch(`${ctx.origin}/api/start`, { method: "POST", body: "{}" }), {}) },
    });
    const c = new Client(s, makeDeps(f.fetch, home(), [{ authorization: "Bearer t" }]).deps, { confirm: true });
    expect(await c.call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(f.calls.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["POST /api/start"]);

    f.calls.length = 0;
    let answer: unknown;
    const followed = loginSite({
      never: NEVER,
      login: { startUrl: `${ORIGIN}/account`, hosts: [], tokenRequest: "/graphql", postLogin: async (ctx) => ((answer = await (await ctx.fetch(`${ctx.origin}/api/go`, { method: "POST", body: "{}" })).json()), {}) },
    });
    const c2 = new Client(followed, makeDeps(f.fetch, home(), [{ authorization: "Bearer t" }]).deps, { confirm: true });
    await c2.call(getOrder, { orderId: "1" }).catch(() => {});
    expect(answer).toEqual({ ok: true });
    // A 302 after a POST goes on as a GET without the body, as fetch does.
    expect(f.calls.slice(0, 2).map((r) => `${r.method} ${new URL(r.url).pathname} ${JSON.stringify(r.body) ?? ""}`.trim())).toEqual(["POST /api/go {}", "GET /api/ok"]);
  });

  test("a GraphQL rule reads a form-urlencoded body and a raw GraphQL body too, and guardFetch reads FormData and Blob bodies", async () => {
    const r = (body: string) => forbiddenRequest(site, { method: "POST", url: `${ORIGIN}/graphql`, body })?.why;
    expect(r(new URLSearchParams({ operationName: "PlaceOrder" }).toString())).toBeDefined();
    expect(r(new URLSearchParams({ query: "mutation PlaceOrder { x }" }).toString())).toBeDefined();
    expect(r("mutation PlaceOrder { placeOrder { id } }")).toBeDefined();
    expect(r("query getCart { cart { id } }")).toBeUndefined();

    const f = fakeFetch(() => json({}));
    const form = new FormData();
    form.set("operationName", "PlaceOrder");
    const b = makeSite({ never: NEVER, bootstrap: async (ctx) => (await ctx.fetch(`${ctx.origin}/graphql`, { method: "POST", body: form }), { headers: {} }) });
    expect(await new Client(b, makeDeps(f.fetch, home()).deps).call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    const blob = makeSite({ never: NEVER, bootstrap: async (ctx) => (await ctx.fetch(`${ctx.origin}/graphql`, { method: "POST", body: new Blob(['{"operationName":"PlaceOrder"}']) }), { headers: {} }) });
    expect(await new Client(blob, makeDeps(f.fetch, home()).deps).call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(f.calls).toEqual([]);
  });

  test("check keeps the Drift it found when a later read's built request is one site.never forbids", async () => {
    const drifting = defineOperation({ name: "GET /api/a", effect: "read", rest: { method: "GET", path: "/api/a" }, variables: z.object({}), response: z.object({ x: z.number() }) });
    const forbiddenRead = defineOperation({
      name: "GET /api/orders/:orderId",
      effect: "read",
      rest: { method: "GET", path: "/api/orders/:orderId" },
      variables: z.object({ orderId: z.string() }),
      response: z.unknown(),
      needs: { orderId: { value: "secret" } },
    });
    const s = makeSite({ never: [{ path: "/api/orders/secret", why: "w" }] });
    const f = fakeFetch(() => json({ x: "not a number" }));
    const e = await check(new Client(s, makeDeps(f.fetch, home()).deps), [drifting, forbiddenRead], {}).catch((x) => x);
    expect(e.kind).toBe("drift");
    expect(e.drifts.map((d: { operation: string }) => d.operation)).toEqual(["GET /api/a"]);
    expect(e.message).toContain("1 other Operation(s) could not be checked (never)");
    expect(f.calls.map((r) => new URL(r.url).pathname)).toEqual(["/api/a"]);
    // Without Drift, the refusal is the bug it is.
    const alone = await check(new Client(s, makeDeps(f.fetch, home()).deps), [forbiddenRead], {}).catch((x) => x);
    expect(alone).toBeInstanceOf(NeverSent);
  });

  test("neverInSource flags only what the runtime forbids: no longer path, no GraphQL name outside a GraphQL context", () => {
    const cart = makeSite({ never: [{ method: "DELETE", path: "/api/cart", why: "Emptying the cart" }, { graphql: "Checkout", why: "Checking out" }, { graphql: "PlaceOrder", why: "Placing an order" }] });
    const scan = (text: string) => neverInSource(cart, [{ path: "f.ts", text }]);
    expect(scan('rest: { method: "GET", path: "/api/cart/items" }; const m = "DELETE";')).toEqual([]);
    expect(scan('fetch("/api/cart", { method: "DELETE" })')).toEqual(["f.ts names DELETE /api/cart (Emptying the cart)"]);
    expect(scan('fetch(`/api/cart/`, { method: "DELETE" })')).toEqual(["f.ts names DELETE /api/cart (Emptying the cart)"]);
    expect(scan('fetch("/api/cart?all=1", { method: "DELETE" })')).toEqual(["f.ts names DELETE /api/cart (Emptying the cart)"]);
    expect(scan('rest: { method: "GET", path: "/api/checkout/summary" }')).toEqual([]);
    expect(scan("response: z.object({ placeOrder: z.boolean() }) // placeOrder flag")).toEqual([]);
    expect(scan("graphql: `mutation PlaceOrder { placeOrder { id } }`")).toEqual(["f.ts names GraphQL PlaceOrder (Placing an order)"]);
    expect(scan('body: { operationName: "Checkout" }')).toEqual(["f.ts names GraphQL Checkout (Checking out)"]);
  });

  test("renew: another ContractError still falls back to Chrome; a hook that swallows the refusal still ends in NeverSent, the record kept", async () => {
    const f = fakeFetch((req) => (new URL(req.url).pathname === "/api/orders/1" && req.headers.authorization === "Bearer old" ? json({}, 401) : json({ id: "1", total: 1 })));
    type Refresh = NonNullable<NonNullable<Parameters<typeof loginSite>[0]>["login"]>["refresh"];
    const withRenew = (refresh: Refresh) =>
      loginSite({ never: [{ path: "/oauth/revoke", why: "Revoking every sign-in" }], login: { startUrl: `${ORIGIN}/account`, hosts: [], tokenRequest: "/graphql", refresh } });

    const broken = withRenew({
      renew: async () => {
        throw new ContractError("renew: no variable for :id");
      },
    });
    const h1 = makeDeps(f.fetch, home(), [{ authorization: "Bearer new" }]);
    saveSession(stateDir(broken, h1.deps.env), { headers: { authorization: "Bearer old" }, ids: {}, refresh: { token: "rt" } });
    expect(await new Client(broken, h1.deps, { confirm: true }).call(getOrder, { orderId: "1" })).toEqual({ id: "1", total: 1 });
    expect(h1.loginCalls).toEqual([true]);

    const swallowing = withRenew({
      renew: async (ctx) => {
        try {
          await ctx.fetch(`${ctx.origin}/oauth/revoke`, { method: "POST" });
        } catch {
          return null;
        }
        return { headers: {} };
      },
    });
    const h2 = makeDeps(f.fetch, home());
    saveSession(stateDir(swallowing, h2.deps.env), { headers: { authorization: "Bearer old" }, ids: {}, refresh: { token: "rt" } });
    expect(await new Client(swallowing, h2.deps, { confirm: true }).call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(loadSession(stateDir(swallowing, h2.deps.env))?.refresh).toEqual({ token: "rt" });
    expect(h2.loginCalls).toEqual([]);
  });

  test("review 2: a redirect off the site's domain drops the session's headers; a redirect to a GET drops the body's headers", async () => {
    const f = fakeFetch((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/away") return new Response(null, { status: 302, headers: { location: "https://cdn.other.test/file" } });
      if (u.pathname === "/api/sub") return new Response(null, { status: 307, headers: { location: "https://api.shop.example.test/x" } });
      if (u.pathname === "/api/see") return new Response(null, { status: 303, headers: { location: "/api/seen" } });
      return json({});
    });
    const s = makeSite({
      never: NEVER,
      bootstrap: async (ctx) => {
        const headers = { authorization: "Bearer secret", cookie: "sid=1", "content-type": "application/json" };
        await ctx.fetch(`${ctx.origin}/api/away`, { headers });
        await ctx.fetch(`${ctx.origin}/api/sub`, { method: "POST", headers, body: "{}" });
        await ctx.fetch(`${ctx.origin}/api/see`, { method: "POST", headers, body: "{}" });
        return { headers: {} };
      },
    });
    await new Client(s, makeDeps(f.fetch, home()).deps).call(getOrder, { orderId: "1" }).catch(() => {});
    const hop = (host: string, path: string) => f.calls.find((r) => new URL(r.url).host === host && new URL(r.url).pathname === path)!;
    expect(hop("cdn.other.test", "/file").headers.authorization).toBeUndefined();
    expect(hop("cdn.other.test", "/file").headers.cookie).toBeUndefined();
    // Another host of the site's own domain keeps them, as a 307 keeps the body.
    expect(hop("api.shop.example.test", "/x").headers.authorization).toBe("Bearer secret");
    expect(hop("api.shop.example.test", "/x").body).toEqual({});
    const seen = hop("shop.example.test", "/api/seen");
    expect(seen.method).toBe("GET");
    expect(seen.headers["content-type"]).toBeUndefined();
    expect(seen.headers.authorization).toBe("Bearer secret");
  });

  test("review 2: a hook that catches a refused ctx.call or ctx.fetch still ends in NeverSent: renew keeps the record, postLogin saves nothing", async () => {
    const tokenOp = defineOperation({ name: "POST /oauth/revoke", effect: "read", rest: { method: "POST", path: "/oauth/revoke" }, variables: z.object({}), response: z.unknown() });
    const f = fakeFetch((req) => (req.headers.authorization === "Bearer old" ? json({}, 401) : json({ id: "1", total: 1 })));
    const s = loginSite({
      never: [{ path: "/oauth/revoke", why: "Revoking every sign-in" }],
      login: {
        startUrl: `${ORIGIN}/account`,
        hosts: [],
        tokenRequest: "/graphql",
        refresh: { renew: async (ctx) => ctx.call(tokenOp, {}).then(() => ({ headers: {} }), () => null) },
      },
    });
    const h = makeDeps(f.fetch, home());
    saveSession(stateDir(s, h.deps.env), { headers: { authorization: "Bearer old" }, ids: {}, refresh: { token: "rt" } });
    expect(await new Client(s, h.deps, { confirm: true }).call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(loadSession(stateDir(s, h.deps.env))?.refresh).toEqual({ token: "rt" });

    const p = loginSite({
      never: NEVER,
      login: {
        startUrl: `${ORIGIN}/account`,
        hosts: [],
        tokenRequest: "/graphql",
        postLogin: async (ctx): Promise<Record<string, string>> => {
          const id = await ctx.fetch(`${ctx.origin}/api/order/place`, { method: "POST" }).then(() => "C-1", () => undefined);
          return id ? { customerId: id } : {};
        },
      },
    });
    const h2 = makeDeps(f.fetch, home(), [{ authorization: "Bearer t" }]);
    expect(await new Client(p, h2.deps, { confirm: true }).call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(loadSession(stateDir(p, h2.deps.env))).toBeNull();
  });

  test("review 2: neverInSource anchors a path at its start, finds the method next to it, and matches GraphQL names case-insensitively", () => {
    const s = makeSite({ never: [{ method: "DELETE", path: "/cart", why: "Emptying the cart" }, { method: "POST", path: "/api/cart", why: "Changing the cart" }, { graphql: "PlaceOrder", why: "Placing an order" }] });
    const scan = (text: string) => neverInSource(s, [{ path: "f.ts", text }]);
    // /cart is not /api/cart, though "DELETE" is in the file.
    expect(scan('rest: { method: "DELETE", path: "/api/cart/item" }; const read = "/api/cart";')).toEqual([]);
    // A full URL or an origin in a template names the path all the same.
    expect(scan('fetch("https://shop.example/cart", { method: "DELETE" })')).toEqual(["f.ts names DELETE /cart (Emptying the cart)"]);
    expect(scan("fetch(`${ctx.origin}/cart`, { method: 'DELETE' })")).toEqual(["f.ts names DELETE /cart (Emptying the cart)"]);
    // A GET of /api/cart and a POST elsewhere in the same file are no POST /api/cart.
    const hooks = `accounts: async (ctx) => (await ctx.fetch(ctx.origin + "/api/cart")).json(),
      // … many lines later, an unrelated sign-in call …
      ${"x".repeat(300)}
      renew: async (ctx) => ctx.fetch(ctx.origin + "/oauth/token", { method: "POST" }),`;
    expect(scan(hooks)).toEqual([]);
    expect(scan('ctx.fetch(ctx.origin + "/api/cart", { method: "POST", body })')).toEqual(["f.ts names POST /api/cart (Changing the cart)"]);
    expect(scan('rest: { method: "POST", path: "/api/cart" }')).toEqual(["f.ts names POST /api/cart (Changing the cart)"]);
    expect(scan("const q = `mutation placeOrder { placeOrder { id } }`;")).toEqual(["f.ts names GraphQL PlaceOrder (Placing an order)"]);
  });

  test("review 2: a path rule holding a query string or fragment is refused, since only the path is matched", () => {
    expect(siteProblems(makeSite({ never: [{ method: "POST", path: "/api/cart?action=checkout", why: "Paying" }] }))).toEqual([
      "never[0].path is a URL path only: no ? or # (the query string and fragment are never matched)",
    ]);
  });

  test("review 2: check's own refusal gets the plain bug next, not the user's 'do it on the site'", async () => {
    const forbiddenRead = defineOperation({
      name: "GET /api/orders/:orderId",
      effect: "read",
      rest: { method: "GET", path: "/api/orders/:orderId" },
      variables: z.object({ orderId: z.string() }),
      response: z.unknown(),
      needs: { orderId: { value: "secret" } },
    });
    const app: App = { site: makeSite({ never: [{ path: "/api/orders/secret", why: "w" }] }), operations: [forbiddenRead], commands: [], deps: makeDeps(fakeFetch(() => json({})).fetch, home()).deps };
    const r = await run(["check"], app);
    expect(r.code).toBe(1);
    expect((r.output as any).error.next).toStartWith("Tell the user this is a bug in the shop CLI.");
  });

  test("review 2: check --writes reports a trigger that only hit a site.never request as that, not as Drift", async () => {
    const write = defineOperation({ ...renameOrder, trigger: async () => {} });
    const checker = async (_w: unknown, _r: unknown, _d: unknown, warn?: (m: string) => void) => {
      warn?.("PATCH /api/orders/:orderId's trigger sent a request site.never forbids (POST /api/order/place*: Placing an order: the user always pays); it was aborted.");
      return new Map([[write.name, "never" as const]]);
    };
    const c = new Client(site, makeDeps(fakeFetch(() => json({})).fetch, home()).deps);
    // A bug in the plugin's trigger, like a read whose request is refused (review 3): exit 1, the warning in the message.
    const e = await check(c, [write], { writes: true }, checker as never).catch((x) => x);
    expect(e).toBeInstanceOf(ContractError);
    expect(e.message).toBe(
      "check: a trigger reached only requests site.never forbids: PATCH /api/orders/:orderId's trigger sent a request site.never forbids (POST /api/order/place*: Placing an order: the user always pays); it was aborted.",
    );
  });

  test("review 3: a write whose body cannot be built still gives its dry run, with or without a never list", async () => {
    const throwing = defineOperation({
      name: "POST /api/notes",
      effect: "write",
      rest: { method: "POST", path: "/api/notes", body: (v: { text?: string }) => ({ text: v.text!.trim() }) },
      variables: z.object({ text: z.string().optional() }),
      response: z.unknown(),
    });
    for (const never of [[], NEVER]) {
      const c = new Client(makeSite({ never }), makeDeps(fakeFetch(() => json({})).fetch, home()).deps);
      expect(await c.call(throwing, {}).catch((x) => x)).toBeInstanceOf(DryRun);
    }
  });

  test("review 3: guardFetch's redirects behave as fetch's: redirected and url set, too many hops throw, a Request's signal kept", async () => {
    const signals: unknown[] = [];
    const loop = fakeFetch((req) => {
      const n = Number(new URL(req.url).searchParams.get("n") ?? "0");
      return new Response(null, { status: 302, headers: { location: `/api/loop?n=${n + 1}` } });
    });
    const ok = async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      const url = input instanceof Request ? input.url : String(input);
      return new URL(url).pathname === "/api/go" ? new Response(null, { status: 302, headers: { location: "/api/ok" } }) : json({ ok: true });
    };
    let res: Response | undefined;
    let tooMany: unknown;
    const s = makeSite({
      never: NEVER,
      bootstrap: async (ctx) => {
        const abort = new AbortController();
        res = await ctx.fetch(new Request(`${ctx.origin}/api/go`, { signal: abort.signal }));
        return { headers: {} };
      },
    });
    await new Client(s, makeDeps(ok, home()).deps).call(getOrder, { orderId: "1" }).catch(() => {});
    expect(res!.redirected).toBe(true);
    expect(res!.url).toBe(`${ORIGIN}/api/ok`);
    // [0] the Request itself (its signal rides on it), [1] the redirect hop, then getOrder's own call.
    expect(signals[1]).toBeInstanceOf(AbortSignal);

    const looping = makeSite({ never: NEVER, bootstrap: async (ctx) => ((tooMany = await ctx.fetch(`${ctx.origin}/api/loop`).catch((x) => x)), { headers: {} }) });
    await new Client(looping, makeDeps(loop.fetch, home()).deps).call(getOrder, { orderId: "1" }).catch(() => {});
    expect(tooMany).toBeInstanceOf(TypeError);
  });

  test("review 3: a command that catches a refused ctx.call still exits 1 with NeverSent", async () => {
    const f = fakeFetch(() => json({}));
    const sneaky = defineCommand({
      name: "order try",
      summary: "Try to place the order",
      args: z.object({}),
      uses: [placeOrder],
      run: async (_a, ctx) => ctx.call(placeOrder, {}).then(() => "placed", () => "fell back"),
    });
    const app: App = { site, operations: [placeOrder], commands: [sneaky], deps: makeDeps(f.fetch, home()).deps };
    const r = await run(["order", "try", "--confirm"], app);
    expect(r.code).toBe(1);
    expect((r.output as any).error.fingerprint).toStartWith("acme:shop:bug:order-try:NeverSent:");
    expect(f.calls).toEqual([]);
  });

  test("review 3: an encoded ../ in a variable does not walk past a rule; a multipart GraphQL request's operations field is read", async () => {
    expect(forbiddenRequest(site, { method: "POST", url: `${ORIGIN}/api/items/x%2F..%2F..%2Forder%2Fplace` })?.why).toBe("Placing an order: the user always pays");
    expect(forbiddenRequest(site, { method: "POST", url: `${ORIGIN}/api/items/./x/../../order/placeNow` })?.why).toBe("Placing an order: the user always pays");
    expect(forbiddenRequest(site, { method: "POST", url: `${ORIGIN}/api/items/x%2F..%2Fcart` })).toBeUndefined();

    const f = fakeFetch(() => json({}));
    const form = new FormData();
    form.set("operations", JSON.stringify({ operationName: "PlaceOrder", query: "mutation PlaceOrder($f: Upload) { x }", variables: {} }));
    form.set("map", "{}");
    const b = makeSite({ never: NEVER, bootstrap: async (ctx) => (await ctx.fetch(`${ctx.origin}/graphql`, { method: "POST", body: form }), { headers: {} }) });
    expect(await new Client(b, makeDeps(f.fetch, home()).deps).call(getOrder, { orderId: "1" }).catch((x) => x)).toBeInstanceOf(NeverSent);
    expect(f.calls).toEqual([]);
  });

  test("review 3: a graphql entry with a method is told to drop the method", () => {
    expect(siteProblems(makeSite({ never: [{ graphql: "PlaceOrder", method: "POST", why: "w" } as unknown as NeverRule] }))).toEqual([
      "never[0].method goes only with a path: a graphql entry matches every request that carries the name",
    ]);
  });

  test("stripNeverList removes the never list from site.ts text, so the CI scan reads the hooks and not the list", () => {
    const text = `export default defineSite({\n  origin: "x",\n  never: [\n    { method: "POST", path: "/api/order/place*", why: "Placing an order: [the user] pays" },\n  ],\n  postLogin: async (ctx) => ctx.fetch("/api/order/place", { method: "POST" }),\n});\n`;
    const stripped = stripNeverList(text);
    expect(stripped).not.toContain("why:");
    expect(stripped).toContain('postLogin: async (ctx) => ctx.fetch("/api/order/place", { method: "POST" })');
    expect(neverInSource(site, [{ path: "src/site.ts", text: stripped }])).toEqual(["src/site.ts names POST /api/order/place* (Placing an order: the user always pays)"]);
    expect(stripNeverList("export default { never: [] };")).toBe("export default {  };");
  });
});
