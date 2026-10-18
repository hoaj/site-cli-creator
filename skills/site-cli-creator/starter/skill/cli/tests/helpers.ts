// Fakes for driving the runtime without a site, Chrome or the user's home dir.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client, type Deps } from "../src/runtime/call";
import { defineCommand } from "../src/runtime/command";
import { defineOperation } from "../src/runtime/operation";
import { defineSite, type SiteConfig } from "../src/runtime/site";
import type { App } from "../src/main";

export const ORIGIN = "https://shop.example.test";
export const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

export function tempHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "site-cli-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeSite(overrides: Partial<SiteConfig> = {}) {
  return defineSite({
    plugin: "acme",
    skill: "shop",
    repo: "acme/acme-plugin",
    version: "1.2.3",
    generatedWith: "0.1.0",
    origin: ORIGIN,
    graphqlPath: "/graphql",
    auth: "none",
    needsChrome: false,
    ...overrides,
  });
}

export function loginSite(overrides: Partial<SiteConfig> = {}) {
  return makeSite({
    auth: "login",
    needsChrome: true,
    login: { startUrl: `${ORIGIN}/account`, hosts: ["login.example.test"], tokenRequest: "/graphql", postLogin: async () => ({ customerId: "C-1" }) },
    ...overrides,
  });
}

export type Recorded = { method: string; url: string; headers: Record<string, string>; body: any };
type Handler = (req: Recorded) => Response | Promise<Response>;

/** A fake fetch that records every request and answers from `handler`. */
export function fakeFetch(handler: Handler) {
  const calls: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const raw = typeof init?.body === "string" ? init.body : undefined;
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {}
    const rec = { method: init?.method ?? "GET", url: String(input), headers, body };
    calls.push(rec);
    return handler(rec);
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A Deps with no Chrome: `login` answers from the queue (null = sign-in didn't complete). */
export function makeDeps(fetch: Deps["fetch"], home: string, logins: Array<Record<string, string> | null> = []) {
  const loginCalls: boolean[] = [];
  const notes: string[] = [];
  const deps: Deps = {
    fetch,
    env: { SITE_CLI_HOME: home },
    login: async (headless) => {
      loginCalls.push(headless);
      return logins.length ? logins.shift()! : null;
    },
    sleep: async () => {},
    retryDelays: [0, 0],
    note: (m) => notes.push(m),
  };
  return { deps, loginCalls, notes };
}

export const client = (site: ReturnType<typeof makeSite>, deps: Deps, confirm = false) => new Client(site, deps, { confirm });

// ---- a small Contract set: getCustomer → listProducts (GraphQL), REST order read + write ----

export const getCustomer = defineOperation({
  name: "getCustomer",
  effect: "read",
  graphql: "query getCustomer($customerId: String!) { getCustomer(id: $customerId) { id name } }",
  variables: z.object({ customerId: z.string() }),
  response: z.object({ data: z.object({ getCustomer: z.object({ id: z.string(), name: z.string() }) }) }),
  needs: { customerId: { from: "session", key: "customerId" } },
});

export const listProducts = defineOperation({
  name: "listProducts",
  effect: "read",
  graphql: "query listProducts($customerId: ID!) { listProducts(customerId: $customerId) { id status } }",
  variables: z.object({ customerId: z.string() }),
  response: z.object({ data: z.object({ listProducts: z.array(z.object({ id: z.string(), status: z.string() })) }) }),
  needs: { customerId: { from: "getCustomer", pick: (r) => r.data.getCustomer.id } },
});

export const getOrder = defineOperation({
  name: "GET /api/orders/:orderId",
  effect: "read",
  rest: { method: "GET", path: "/api/orders/:orderId", query: (v) => ({ expand: v.expand ? "lines" : "none" }) },
  variables: z.object({ orderId: z.string(), expand: z.boolean().optional() }),
  response: z.object({ id: z.string(), total: z.number() }),
});

export const renameOrder = defineOperation({
  name: "PATCH /api/orders/:orderId",
  effect: "write",
  rest: { method: "PATCH", path: "/api/orders/:orderId", body: (v) => ({ name: v.name }) },
  variables: z.object({ orderId: z.string(), name: z.string().min(1) }),
  response: z.object({ ok: z.boolean() }),
});

export const productsShow = defineCommand({
  name: "products show",
  summary: "Products on the account",
  args: z.object({ all: z.boolean().default(false).describe("include inactive"), limit: z.number().int().optional() }),
  uses: [getCustomer, listProducts],
  run: async ({ all, limit }, ctx) => {
    const customerId = ctx.account ?? ctx.session.ids.customerId;
    const c = (await ctx.call(getCustomer, { customerId })).data.getCustomer;
    const products = (await ctx.call(listProducts, { customerId: c.id })).data.listProducts.filter((p) => all || p.status === "active");
    return { customer: c.name, products: products.slice(0, limit ?? products.length) };
  },
});

export const orderRename = defineCommand({
  name: "order rename",
  summary: "Rename an order",
  args: z.object({ orderId: z.string(), name: z.string() }),
  uses: [getOrder, renameOrder],
  run: async ({ orderId, name }, ctx) => {
    await ctx.call(getOrder, { orderId });
    return ctx.call(renameOrder, { orderId, name });
  },
});

export const crashCommand = defineCommand({
  name: "crash now",
  summary: "Throws a TypeError",
  args: z.object({}),
  uses: [],
  run: async () => {
    const x: any = undefined;
    return x.boom;
  },
});

export function makeApp(site: ReturnType<typeof makeSite>, deps: Deps, extra: Partial<App> = {}): App {
  return {
    site,
    operations: [listProducts, getCustomer, getOrder, renameOrder],
    commands: [productsShow, orderRename, crashCommand],
    deps,
    ...extra,
  };
}

/** The GraphQL + REST site the Contracts above describe. */
export function happySite(req: Recorded): Response {
  const url = new URL(req.url);
  if (url.pathname === "/graphql") {
    if (req.body.operationName === "getCustomer") return json({ data: { getCustomer: { id: req.body.variables.customerId, name: "Kim Secret" } } });
    if (req.body.operationName === "listProducts") return json({ data: { listProducts: [{ id: "P1", status: "active" }, { id: "P2", status: "ended" }] } });
  }
  if (url.pathname.startsWith("/api/orders/")) {
    if (req.method === "GET") return json({ id: url.pathname.split("/").pop(), total: 99 });
    if (req.method === "PATCH") return json({ ok: true });
  }
  return json({ message: "nope" }, 404);
}

// ---- remote mode (`mcp --http`): ports and the Server sign-in's building blocks ----

/** A port that was free a moment ago; another process can still take it before the caller listens. */
export function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

/**
 * Starts a server on a fresh freePort() and tries again (up to `attempts`) on a new port when the
 * start failed because the port was taken in the meantime: `start` must throw an error that names
 * it (the in-process server's "already in use", a spawned binary's stderr with EADDRINUSE).
 */
export async function withFreePort<T>(start: (port: number) => Promise<T>, attempts = 5): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await start(freePort());
    } catch (err) {
      if (n >= attempts || !/EADDRINUSE|address in use|already in use/i.test(String((err as Error)?.message ?? err))) throw err;
    }
  }
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function register(base: string, redirect = CLAUDE_CB) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "Claude", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
}

export function authorizePage(base: string, clientId: string, challenge: string, opts: { redirect?: string; resource?: string } = {}) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: opts.redirect ?? CLAUDE_CB,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: opts.resource ?? `${base}/mcp`,
  });
  return fetch(`${base}/authorize?${q}`, { redirect: "manual" });
}

export function postLogin(base: string, requestId: string, password: string) {
  return fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: requestId, password }) });
}

export function token(base: string, body: Record<string, string>) {
  return fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
}
