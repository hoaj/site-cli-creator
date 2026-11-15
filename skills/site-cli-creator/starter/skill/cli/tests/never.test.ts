// site.never: requests the CLI must never send (#101). The matcher, and every place a request leaves.
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Client } from "../src/runtime/call";
import { check, triggerVerdict, type Captured } from "../src/runtime/check";
import { defineCommand } from "../src/runtime/command";
import { ContractError, DryRun } from "../src/runtime/envelope";
import { help } from "../src/runtime/help";
import { forbiddenOperation, forbiddenRequest, neverInSource, neverProblems, NeverSent, neverRuleLabel } from "../src/runtime/never";
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
    expect(p([{ graphql: "P", method: "POST", why: "w" }])).toEqual(["never[0] takes a path or a graphql name, not both"]);
    expect(p([{ why: "w" }])).toEqual(["never[0] takes a path or a graphql name, not both"]);
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
