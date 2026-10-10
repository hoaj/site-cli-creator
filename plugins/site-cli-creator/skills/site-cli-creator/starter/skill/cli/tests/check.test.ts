// check: chain order, --op, drift aggregation, write checks (with a fake checker; the Chrome
// path is covered in browser.test.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { run } from "../src/main";
import { chainOrder, capturedVariables, check, compareWrite, isDeclaredRead, isReadOnlyRequest, matchesOperation, triggerVerdict, withChain, type WriteChecker } from "../src/runtime/check";
import { Failure } from "../src/runtime/envelope";
import { defineOperation } from "../src/runtime/operation";
import { saveSession } from "../src/runtime/session";
import { client, fakeFetch, getCustomer, getOrder, happySite, json, listProducts, loginSite, makeApp, makeDeps, makeSite, renameOrder, tempHome } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
  saveSession(home.dir, { headers: {}, ids: { customerId: "C-1" } });
});
afterEach(() => home.cleanup());

const getInvoice = defineOperation({
  name: "getInvoice",
  effect: "read",
  graphql: "query getInvoice($productId: ID!) { getInvoice(productId: $productId) { total } }",
  variables: z.object({ productId: z.string() }),
  response: z.object({ data: z.object({ getInvoice: z.object({ total: z.number() }) }) }),
  needs: { productId: { from: "listProducts", pick: (r) => r.data.listProducts[0]?.id } },
});

describe("chain order", () => {
  test("every Operation comes after what it needs; ties keep registry order", () => {
    expect(chainOrder([getInvoice, listProducts, getOrder, getCustomer]).map((o) => o.name)).toEqual([
      "getCustomer",
      "listProducts",
      "getInvoice",
      "GET /api/orders/:orderId",
    ]);
  });

  test("an unknown `from` or a cycle is a ContractError", () => {
    const a = defineOperation({ ...getInvoice, name: "a", needs: { productId: { from: "b", pick: () => "x" } } });
    const b = defineOperation({ ...getInvoice, name: "b", needs: { productId: { from: "a", pick: () => "x" } } });
    expect(() => chainOrder([a])).toThrow("not in the registry");
    expect(() => chainOrder([a, b])).toThrow("cycle");
  });

  test("--op keeps the Operation and its chain; unknown names are input", () => {
    expect(withChain([getOrder, getInvoice, listProducts, getCustomer], "getInvoice").map((o) => o.name)).toEqual(["getInvoice", "listProducts", "getCustomer"]);
    expect(() => withChain([getOrder], "nope")).toThrow(Failure);
  });
});

describe("check over reads", () => {
  test("calls reads in chain order, passing picked values and session ids", async () => {
    const { fetch, calls } = fakeFetch((r) =>
      r.body?.operationName === "getInvoice" ? json({ data: { getInvoice: { total: 1 } } }) : happySite(r),
    );
    const result = await check(client(makeSite(), makeDeps(fetch, home.dir).deps), [getInvoice, renameOrder, listProducts, getOrder, getCustomer], {});
    expect(calls.map((c) => [c.body?.operationName, c.body?.variables])).toEqual([
      ["getCustomer", { customerId: "C-1" }],
      ["listProducts", { customerId: "C-1" }],
      ["getInvoice", { productId: "P1" }],
    ]);
    expect(result).toEqual({
      ok: true,
      operations: [
        { operation: "getCustomer", effect: "read", status: "ok" },
        { operation: "listProducts", effect: "read", status: "ok" },
        { operation: "getInvoice", effect: "read", status: "ok" },
        { operation: "PATCH /api/orders/:orderId", effect: "write", status: "skipped", reason: "run check --writes" },
        { operation: "GET /api/orders/:orderId", effect: "read", status: "skipped", reason: "needs input the chain does not supply" },
      ],
    });
  });

  test("a pick with no value skips the Operation instead of failing", async () => {
    const { fetch } = fakeFetch((r) => (r.body?.operationName === "listProducts" ? json({ data: { listProducts: [] } }) : happySite(r)));
    const result = await check(client(makeSite(), makeDeps(fetch, home.dir).deps), [getCustomer, listProducts, getInvoice], {});
    expect(result.operations.at(-1)).toEqual({ operation: "getInvoice", effect: "read", status: "skipped", reason: "no value for productId" });
  });

  test("drifts are aggregated into drifts[]; dependents are skipped; others still run", async () => {
    const other = defineOperation({
      name: "getStatus",
      effect: "read",
      graphql: "query getStatus { getStatus { up } }",
      variables: z.object({}),
      response: z.object({ data: z.object({ getStatus: z.object({ up: z.boolean() }) }) }),
    });
    const { fetch, calls } = fakeFetch((r) => {
      if (r.body.operationName === "getCustomer") return json({ data: { getCustomer: { id: 5, name: "n" } } });
      if (r.body.operationName === "getStatus") return json({ errors: [{ message: 'Cannot query field "up" on type "Status".' }] });
      return happySite(r);
    });
    const e = await check(client(makeSite(), makeDeps(fetch, home.dir).deps), [getCustomer, listProducts, other], {}).catch((x) => x);
    expect(e).toBeInstanceOf(Failure);
    expect(e.kind).toBe("drift");
    expect(e.drifts).toEqual([
      { operation: "getCustomer", fingerprint: "acme:shop:getCustomer:zod:data.getCustomer.id:invalid_type", diff: [{ path: "data.getCustomer.id", code: "invalid_type", expected: "string", received: "number" }] },
      { operation: "getStatus", fingerprint: "acme:shop:getStatus:graphql:Status.up:", diff: [{ path: "Status.up", code: "validation" }] },
    ]);
    expect(calls.map((c) => c.body.operationName)).toEqual(["getCustomer", "getStatus"]);
  });

  test("a non-drift failure stops check with that kind", async () => {
    const { fetch } = fakeFetch(() => json({}, 503));
    const e = await check(client(makeSite(), makeDeps(fetch, home.dir).deps), [getCustomer, listProducts], {}).catch((x) => x);
    expect(e.kind).toBe("network");
  });

  test("a session need with key account takes --account, or the only account", async () => {
    const byAccount = defineOperation({ ...getCustomer, needs: { customerId: { from: "session", key: "account" } } });
    const twoAccounts = makeSite({ accounts: async () => [{ id: "A1" }, { id: "A2", label: "Second" }] });
    const { fetch, calls } = fakeFetch(happySite);
    await check(client(twoAccounts, makeDeps(fetch, home.dir).deps), [byAccount], { account: "A2" });
    expect(calls[0].body.variables).toEqual({ customerId: "A2" });

    const e = await check(client(twoAccounts, makeDeps(fetch, home.dir).deps), [byAccount], {}).catch((x) => x);
    expect(e).toBeInstanceOf(Failure);
    expect(e.kind).toBe("input");
    expect(e.details.accounts.map((a: any) => a.id)).toEqual(["A1", "A2"]);

    home.cleanup();
    home = tempHome();
    const one = fakeFetch(happySite);
    await check(client(makeSite({ accounts: async () => ["ONLY"] }), makeDeps(one.fetch, home.dir).deps), [byAccount], {});
    expect(one.calls[0].body.variables).toEqual({ customerId: "ONLY" });
  });

  test("check never sends a write, even with --confirm", async () => {
    const { fetch, calls } = fakeFetch(happySite);
    await check(client(makeSite(), makeDeps(fetch, home.dir).deps, true), [renameOrder], { writes: true }, async () => new Map([[renameOrder.name, null]]));
    expect(calls).toHaveLength(0);
  });
});

describe("check over writes", () => {
  const triggered = defineOperation({ ...renameOrder, trigger: async () => {} });

  test("--writes hands writes with a trigger to the checker and reports its drifts", async () => {
    const seen: string[] = [];
    const passing: string[] = [];
    const checker: WriteChecker = async (ops, reads) => {
      seen.push(...ops.map((o) => o.name));
      passing.push(...reads.map((o) => o.name));
      return new Map([[triggered.name, { operation: triggered.name, fingerprint: "acme:shop:x:request:name:invalid_type", diff: [] }]]);
    };
    const { fetch } = fakeFetch(happySite);
    const e = await check(client(makeSite(), makeDeps(fetch, home.dir).deps), [triggered, getCustomer, getOrder], { writes: true, op: triggered.name }, checker).catch((x) => x);
    expect(seen).toEqual([triggered.name]);
    // Every registry read may pass while the trigger runs, not only the --op chain.
    expect(passing).toEqual([getCustomer.name, getOrder.name]);
    expect(e.drifts.map((d: any) => d.operation)).toEqual([triggered.name]);
  });

  test("--op <write> checks it without --writes; a write without trigger is skipped", async () => {
    const checker: WriteChecker = async (ops) => new Map(ops.map((o) => [o.name, null]));
    const { fetch } = fakeFetch(happySite);
    const c = client(makeSite(), makeDeps(fetch, home.dir).deps);
    expect((await check(c, [triggered], { op: triggered.name }, checker)).operations).toEqual([{ operation: triggered.name, effect: "write", status: "ok" }]);
    // The Fingerprint's {param} form names the same Operation.
    expect((await check(c, [triggered], { op: "PATCH /api/orders/{orderId}" }, checker)).operations).toEqual([{ operation: triggered.name, effect: "write", status: "ok" }]);
    expect((await check(c, [renameOrder], { writes: true }, checker)).operations).toEqual([{ operation: renameOrder.name, effect: "write", status: "skipped", reason: "no trigger" }]);
  });

  const site = makeSite();
  const origin = "https://shop.example.test";
  const req = (method: string, url: string, body?: unknown) => ({ method, url: new URL(url), body });

  test("matchesOperation: REST by method + path pattern, GraphQL by operationName", () => {
    expect(matchesOperation(site, renameOrder, origin, req("PATCH", `${origin}/api/orders/77`))).toBe(true);
    expect(matchesOperation(site, renameOrder, origin, req("PATCH", `${origin}/api/orders/77/lines`))).toBe(false);
    expect(matchesOperation(site, renameOrder, origin, req("POST", `${origin}/api/orders/77`))).toBe(false);
    expect(matchesOperation(site, renameOrder, origin, req("PATCH", `https://other.test/api/orders/77`))).toBe(false);
    const gql = defineOperation({ ...listProducts, name: "createQuote", effect: "write" });
    expect(matchesOperation(site, gql, origin, req("POST", `${origin}/graphql`, { operationName: "createQuote", query: "mutation createQuote { x }" }))).toBe(true);
    expect(matchesOperation(site, gql, origin, req("POST", `${origin}/graphql`, { query: "mutation createQuote($a: ID) { x }" }))).toBe(true);
    expect(matchesOperation(site, gql, origin, req("POST", `${origin}/graphql`, { operationName: "other" }))).toBe(false);
  });

  test("isDeclaredRead: registry reads pass, a batch only if every document is a read", () => {
    const createQuote = { operationName: "createQuote", query: "mutation createQuote { x }" };
    const persisted = { operationName: "listProducts", extensions: { persistedQuery: { sha256Hash: "h" } } };
    const searchOrders = defineOperation({ ...getOrder, name: "POST /api/orders/search", rest: { method: "POST", path: "/api/orders/search" } });
    const reads = [getCustomer, listProducts, searchOrders];
    expect(isDeclaredRead(site, reads, origin, req("POST", `${origin}/graphql`, persisted))).toBe(true);
    expect(isDeclaredRead(site, reads, origin, req("POST", `${origin}/graphql`, [persisted, { operationName: "getCustomer" }]))).toBe(true);
    expect(isDeclaredRead(site, reads, origin, req("POST", `${origin}/graphql`, [persisted, createQuote]))).toBe(false);
    expect(isDeclaredRead(site, reads, origin, req("POST", `${origin}/graphql`, createQuote))).toBe(false);
    expect(isDeclaredRead(site, reads, origin, req("POST", `${origin}/api/orders/search`, {}))).toBe(true);
    expect(isDeclaredRead(site, reads, origin, req("PATCH", `${origin}/api/orders/search`, {}))).toBe(false);
    expect(isDeclaredRead(site, reads, origin, req("POST", `https://other.test/graphql`, persisted))).toBe(false);
  });

  test("triggerVerdict: the target is captured; login hosts, tokenRequest, reads and readOnlyRequests pass; other non-GETs abort", () => {
    const s = loginSite({ readOnlyRequests: ["/shop/api/session-management/post-login", /\/api\/token\/refresh$/] });
    const deleteOrder = defineOperation({ ...renameOrder, name: "DELETE /api/orders/:orderId", rest: { method: "DELETE", path: "/api/orders/:orderId" } });
    const writes = [renameOrder, deleteOrder];
    const reads = [getCustomer, listProducts, getOrder];
    const v = (method: string, url: string, body?: unknown) => triggerVerdict(s, renameOrder, writes, reads, origin, req(method, url, body));
    expect(v("PATCH", `${origin}/api/orders/1`, { name: "x" })).toBe("target");
    expect(v("GET", `${origin}/api/anything`)).toBe("pass");
    expect(v("POST", "https://login.example.test/oauth/token", {})).toBe("pass");
    expect(v("POST", `${origin}/graphql`, { operationName: "getCustomer", extensions: {} })).toBe("pass");
    expect(v("POST", `${origin}/graphql`, { query: "query other { x }" })).toBe("pass");
    expect(v("POST", `${origin}/shop/api/session-management/post-login`, {})).toBe("pass");
    expect(v("POST", `${origin}/api/token/refresh`, {})).toBe("pass");
    // Undeclared non-GETs never get through.
    expect(v("POST", `${origin}/api/track`, "{}")).toBe("abort");
    expect(v("POST", `${origin}/api/token/refresh/now`, {})).toBe("abort");
    expect(v("POST", `${origin}/graphql`, { operationName: "createQuote", query: "mutation createQuote { x }" })).toBe("abort");
    // A declared write is aborted even when a pass rule (here tokenRequest "/graphql") matches it.
    expect(v("DELETE", `${origin}/api/orders/1`)).toBe("abort");
    const gqlWrite = defineOperation({ ...listProducts, name: "createQuote", effect: "write" });
    expect(triggerVerdict(s, renameOrder, [renameOrder, gqlWrite], reads, origin, req("POST", `${origin}/graphql`, { operationName: "createQuote", query: "mutation createQuote { x }" }))).toBe("abort");
    // An undeclared mutation is aborted although tokenRequest ("/graphql") matches; a mutation declared as a read passes.
    expect(triggerVerdict(s, renameOrder, [renameOrder], reads, origin, req("POST", `${origin}/graphql`, { operationName: "createQuote", query: "mutation createQuote { x }" }))).toBe("abort");
    const readMutation = defineOperation({ ...listProducts, name: "createQuote" });
    expect(triggerVerdict(s, renameOrder, [renameOrder], [readMutation], origin, req("POST", `${origin}/graphql`, { operationName: "createQuote", query: "mutation createQuote { x }" }))).toBe("pass");
    expect(triggerVerdict(s, renameOrder, [renameOrder], [], origin, req("POST", `${origin}/graphql`, { operationName: "persisted", extensions: {} }))).toBe("pass");
    // tokenRequest only counts for login skills.
    expect(triggerVerdict(makeSite(), renameOrder, writes, [], origin, req("POST", `${origin}/graphql`, { operationName: "p", extensions: {} }))).toBe("abort");
  });

  test("isReadOnlyRequest: strings match the URL path, RegExps the whole URL", () => {
    const s = makeSite({ readOnlyRequests: ["/post-login", /^https:\/\/shop\.example\.test\/api\/refresh\?/g] });
    expect(isReadOnlyRequest(s, `${origin}/x/post-login`)).toBe(true);
    expect(isReadOnlyRequest(s, `${origin}/x?next=/post-login`)).toBe(false);
    expect(isReadOnlyRequest(s, `${origin}/api/refresh?a=1`)).toBe(true);
    expect(isReadOnlyRequest(s, `${origin}/api/refresh?a=1`)).toBe(true); // a /g RegExp keeps no state between calls
    expect(isReadOnlyRequest(makeSite(), `${origin}/x/post-login`)).toBe(false);
  });

  test("check passes every declared write to the checker, so --op <write> still aborts the others", async () => {
    const t = defineOperation({ ...renameOrder, trigger: async () => {} });
    const other = defineOperation({ ...renameOrder, name: "DELETE /api/orders/:orderId", rest: { method: "DELETE", path: "/api/orders/:orderId" } });
    let seen: string[] = [];
    const checker: WriteChecker = async (ops, _reads, declared) => ((seen = (declared ?? []).map((o) => o.name)), new Map(ops.map((o) => [o.name, null])));
    const c = client(makeSite(), makeDeps(fakeFetch(happySite).fetch, home.dir).deps);
    await check(c, [t, other], { op: t.name }, checker);
    expect(seen).toEqual([t.name, other.name]);
  });

  test("capturedVariables + compareWrite: request shape against variables", () => {
    const r = req("PATCH", `${origin}/api/orders/a%20b?x=1`, { name: "N" });
    expect(capturedVariables(renameOrder, r)).toEqual({ orderId: "a b", x: "1", name: "N" });
    expect(compareWrite(site, renameOrder, r)).toBeNull();
    const changed = compareWrite(site, renameOrder, req("PATCH", `${origin}/api/orders/1`, { title: "SECRET" }));
    expect(changed).toEqual({
      operation: renameOrder.name,
      fingerprint: "acme:shop:PATCH /api/orders/{orderId}:request:name:invalid_type",
      diff: [{ path: "name", code: "invalid_type", expected: "string", received: "undefined" }],
    });
    expect(JSON.stringify(changed)).not.toContain("SECRET");
  });

  test("compareWrite: trigger errors and missing requests are trigger drift", () => {
    const timeout = Object.assign(new Error("locator not found"), { name: "TimeoutError" });
    expect(compareWrite(site, renameOrder, undefined, timeout)!.fingerprint).toBe("acme:shop:PATCH /api/orders/{orderId}:trigger::TimeoutError");
    expect(compareWrite(site, renameOrder, undefined)!.fingerprint).toBe("acme:shop:PATCH /api/orders/{orderId}:trigger::no_request");
  });
});

test("check through run(): --op and drift envelope with drifts[] (exit 3)", async () => {
  const { fetch } = fakeFetch((r) => (r.body?.operationName === "listProducts" ? json({ data: { listProducts: [{ id: 1, status: "a" }] } }) : happySite(r)));
  const app = makeApp(makeSite(), makeDeps(fetch, home.dir).deps);
  const ok = await run(["check", "--op", "getCustomer"], app);
  expect(ok.code).toBe(0);
  expect((ok.output as any).operations).toEqual([{ operation: "getCustomer", effect: "read", status: "ok" }]);
  const bad = await run(["check"], app);
  expect(bad.code).toBe(3);
  const e = (bad.output as any).error;
  expect(e.kind).toBe("drift");
  expect(e.drifts).toHaveLength(1);
  expect(e.drifts[0].fingerprint).toBe("acme:shop:listProducts:zod:data.listProducts[].id:invalid_type");
  expect(e.next).toContain("acme-feedback");
  expect((await run(["check", "--op", "nope"], app)).code).toBe(2);
});
