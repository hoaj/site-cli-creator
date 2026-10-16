// Remote mode (`mcp --http`): the Owner's Server sign-in (OAuth 2.1, one user) in front of the same
// tools as local mode, over real HTTP against an in-test server and a fake site.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { checkSession, mcpTools, run } from "../src/main";
import { remoteConfig, type RemoteConfig } from "../src/runtime/remote-config";
import { OwnerProvider, OAuthStore, hashPassword } from "../src/runtime/owner-auth";
import { serveHttp } from "../src/runtime/remote";
import { saveSession } from "../src/runtime/session";
import { fakeFetch, happySite, makeApp, makeDeps, makeSite, tempHome } from "./helpers";

const PW = "correct horse battery";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

let home: ReturnType<typeof tempHome>;
const servers: Array<{ close(): Promise<void> }> = [];
beforeEach(() => (home = tempHome()));
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  home.cleanup();
});

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

type Start = { env?: Record<string, string>; now?: () => number; port?: number };

async function startRemote(opts: Start = {}) {
  const port = opts.port ?? freePort();
  const f = fakeFetch(happySite);
  const d = makeDeps(f.fetch, home.dir);
  saveSession(home.dir, { headers: {}, ids: { customerId: "C-1" } });
  const app = makeApp(makeSite(), d.deps);
  const config = remoteConfig({ OWNER_PASSWORD: PW, PUBLIC_URL: `http://127.0.0.1:${port}`, ...opts.env }, { port });
  const notes: string[] = [];
  const server = await serveHttp({ ...mcpTools(app, { remote: true }), site: app.site, config, dir: home.dir, host: "127.0.0.1", checkSession: (c) => checkSession(app, c), note: (m) => notes.push(m), now: opts.now });
  servers.push(server);
  return { base: `http://127.0.0.1:${port}`, app, deps: d.deps, calls: f.calls, notes, server, config };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(base: string, redirect = CLAUDE_CB) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "Claude", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
}

async function authorizePage(base: string, clientId: string, challenge: string, opts: { redirect?: string; resource?: string } = {}) {
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

const requestIdOf = (html: string) => html.match(/name="request" value="([^"]+)"/)?.[1];

async function postLogin(base: string, requestId: string, password: string) {
  return fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: requestId, password }) });
}

function codeOf(html: string): { code: string; state: string | null } {
  const raw = html.match(/http-equiv="refresh" content="0;url=([^"]+)"/)?.[1];
  if (!raw) throw new Error(`no redirect in sign-in answer:\n${html}`);
  const url = new URL(raw.replaceAll("&amp;", "&"));
  return { code: url.searchParams.get("code")!, state: url.searchParams.get("state") };
}

async function token(base: string, body: Record<string, string>) {
  return fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
}

/** The whole Server sign-in, as a client like claude.ai does it. */
async function signIn(base: string, opts: { redirect?: string; password?: string } = {}) {
  const redirect = opts.redirect ?? CLAUDE_CB;
  const client = await (await register(base, redirect)).json();
  const { verifier, challenge } = pkce();
  const page = await (await authorizePage(base, client.client_id, challenge, { redirect })).text();
  const done = await (await postLogin(base, requestIdOf(page)!, opts.password ?? PW)).text();
  const { code, state } = codeOf(done);
  expect(state).toBe("st-1");
  const res = await token(base, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect, resource: `${base}/mcp` });
  expect(res.status).toBe(200);
  return { client, tokens: await res.json() };
}

let rpcId = 1;
async function mcp(base: string, accessToken: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      ...(accessToken && { authorization: `Bearer ${accessToken}` }),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, ...(params !== undefined && { params }) }),
  });
}

const textOf = (result: any) => JSON.parse(result.content[0].text);

describe("remoteConfig", () => {
  test("needs an Owner password from the environment", () => {
    expect(() => remoteConfig({ PUBLIC_URL: "https://x.example" }, {})).toThrow(/OWNER_PASSWORD/);
  });

  test("refuses a plain password shorter than 12 characters and a malformed hash", () => {
    expect(() => remoteConfig({ OWNER_PASSWORD: "short", PUBLIC_URL: "https://x.example" }, {})).toThrow(/12 characters/);
    expect(() => remoteConfig({ OWNER_PASSWORD_HASH: "md5$nope", PUBLIC_URL: "https://x.example" }, {})).toThrow(/OWNER_PASSWORD_HASH/);
  });

  test("needs a public URL: PUBLIC_URL, else Railway's domain; https except on loopback", () => {
    expect(() => remoteConfig({ OWNER_PASSWORD: PW }, {})).toThrow(/PUBLIC_URL/);
    expect(remoteConfig({ OWNER_PASSWORD: PW, RAILWAY_PUBLIC_DOMAIN: "logbuy-x.up.railway.app" }, {}).publicUrl.href).toBe("https://logbuy-x.up.railway.app/");
    expect(() => remoteConfig({ OWNER_PASSWORD: PW, PUBLIC_URL: "http://example.com" }, {})).toThrow(/https/);
    expect(remoteConfig({ OWNER_PASSWORD: PW, PUBLIC_URL: "http://127.0.0.1:9" }, {}).publicUrl.href).toBe("http://127.0.0.1:9/");
  });

  test("takes the port from --port, else PORT, else 8080, and extra redirect URIs from a variable", () => {
    const base = { OWNER_PASSWORD_HASH: hashPassword(PW), PUBLIC_URL: "https://x.example" };
    expect(remoteConfig(base, {}).port).toBe(8080);
    expect(remoteConfig({ ...base, PORT: "3000" }, {}).port).toBe(3000);
    expect(remoteConfig({ ...base, PORT: "3000" }, { port: 4000 }).port).toBe(4000);
    expect(() => remoteConfig({ ...base, PORT: "eighty" }, {})).toThrow(/PORT/);
    expect(remoteConfig({ ...base, EXTRA_REDIRECT_URIS: "cursor://anysphere.cursor-mcp/oauth/callback, https://chatgpt.com/connector_platform_oauth_redirect" }, {}).extraRedirects).toEqual([
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
    ]);
  });

  test("`mcp --http` validates the environment before serving: a problem is an input envelope", async () => {
    const d = makeDeps(fakeFetch(happySite).fetch, home.dir);
    const { output, code } = await run(["mcp", "--http"], makeApp(makeSite(), d.deps));
    expect(code).toBe(2);
    expect((output as any).error.message).toMatch(/OWNER_PASSWORD/);
    expect((output as any).error.next).toMatch(/environment variable/);
    d.deps.env = { ...d.deps.env, OWNER_PASSWORD: PW, PUBLIC_URL: "https://x.example" };
    const ok = await run(["mcp", "--http", "--port", "5000"], makeApp(makeSite(), d.deps));
    expect(ok).toMatchObject({ code: 0, serve: "mcp-http" });
    expect((ok as any).remote.port).toBe(5000);
  });
});

describe("Server sign-in over HTTP", () => {
  test("discovery metadata names this server and its /mcp resource", async () => {
    const { base } = await startRemote();
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.issuer).toBe(`${base}/`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(pr.resource).toBe(`${base}/mcp`);
    expect((await (await fetch(`${base}/healthz`)).json())).toEqual({ ok: true, version: "1.2.3" });
  });

  test("without a token, /mcp answers 401 with WWW-Authenticate pointing at the metadata", async () => {
    const { base } = await startRemote();
    const res = await mcp(base, null, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  test("a full sign-in reaches the same tools as local mode, with the CLI's results", async () => {
    const { base, app, deps } = await startRemote();
    const { tokens } = await signIn(base);
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.expires_in).toBe(3600);
    const list = await (await mcp(base, tokens.access_token, "tools/list")).json();
    expect(list.result.tools.map((t: any) => t.name)).toEqual(mcpTools(app, { remote: true }).tools.map((t) => t.name));
    const call = await (await mcp(base, tokens.access_token, "tools/call", { name: "products_show", arguments: { all: true } })).json();
    const cli = await run(["products", "show", "--all"], makeApp(makeSite(), deps));
    expect(textOf(call.result)).toEqual(cli.output as object);
  });

  test("the sign-in page names the site and the client, warns about writes, and is not cached", async () => {
    const { base } = await startRemote();
    const client = await (await register(base)).json();
    const res = await authorizePage(base, client.client_id, pkce().challenge);
    const html = await res.text();
    expect(html).toContain("Claude");
    expect(html).toContain("shop.example.test");
    expect(html).toContain("claude.ai");
    expect(html).toMatch(/change/i);
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    const login = await postLogin(base, requestIdOf(html)!, "wrong one");
    expect(login.headers.get("cache-control")).toContain("no-store");
  });

  test("with no write tools, the sign-in page says the tools only read", async () => {
    const port = freePort();
    const d = makeDeps(fakeFetch(happySite).fetch, home.dir);
    const app = { ...makeApp(makeSite(), d.deps), commands: [makeApp(makeSite(), d.deps).commands[0]!] };
    const config = remoteConfig({ OWNER_PASSWORD: PW, PUBLIC_URL: `http://127.0.0.1:${port}` }, { port });
    servers.push(await serveHttp({ ...mcpTools(app, { remote: true }), site: app.site, config, dir: home.dir, host: "127.0.0.1", checkSession: (c) => checkSession(app, c), note: () => {} }));
    const base = `http://127.0.0.1:${port}`;
    const client = await (await register(base)).json();
    const html = await (await authorizePage(base, client.client_id, pkce().challenge)).text();
    expect(html).toContain("only read");
    expect(html).not.toMatch(/change your data/);
  });

  test("refresh rotates; a reused refresh token signs that client out", async () => {
    const { base } = await startRemote();
    const { client, tokens } = await signIn(base);
    const next = await (await token(base, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id })).json();
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await mcp(base, next.access_token, "tools/list")).status).toBe(200);
    const reused = await token(base, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(reused.status).toBe(400);
    expect((await reused.json()).error).toBe("invalid_grant");
    expect((await mcp(base, next.access_token, "tools/list")).status).toBe(401);
  });

  test("revoking either token of a pair revokes both", async () => {
    const { base } = await startRemote();
    const { client, tokens } = await signIn(base);
    const res = await fetch(`${base}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokens.refresh_token, client_id: client.client_id }) });
    expect(res.status).toBe(200);
    expect((await mcp(base, tokens.access_token, "tools/list")).status).toBe(401);
  });

  test("the SDK's own client signs in and calls a tool", async () => {
    const { base } = await startRemote();
    const auth = new TestAuthProvider();
    const url = new URL(`${base}/mcp`);
    const first = new McpClient({ name: "sdk-test", version: "0" });
    await expect(first.connect(new StreamableHTTPClientTransport(url, { authProvider: auth }))).rejects.toBeInstanceOf(UnauthorizedError);
    const page = await (await fetch(auth.authorizationUrl!)).text();
    const { code } = codeOf(await (await postLogin(base, requestIdOf(page)!, PW)).text());
    const transport = new StreamableHTTPClientTransport(url, { authProvider: auth });
    await transport.finishAuth(code);
    const client = new McpClient({ name: "sdk-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: auth }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("products_show");
    const result = await client.callTool({ name: "products_show", arguments: {} });
    expect(textOf(result)).toMatchObject({ customer: "Kim Secret" });
    await client.close();
  });
});

describe("review fixes", () => {
  test("failures from other addresses never lock out an address that has not failed", async () => {
    const { base } = await startRemote({ env: { TRUST_PROXY: "1" } });
    const client = await (await register(base, "http://127.0.0.1:5555/cb")).json();
    for (let n = 0; n < 6; n++) {
      for (let i = 0; i < 5; i++) {
        const page = await (await authorizePage(base, client.client_id, pkce().challenge, { redirect: "http://127.0.0.1:5555/cb" })).text();
        await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${n}` }, body: new URLSearchParams({ request: requestIdOf(page)!, password: "wrong" }) });
      }
    }
    const { tokens } = await signIn(base); // from 127.0.0.1, which never failed
    expect((await mcp(base, tokens.access_token, "tools/list")).status).toBe(200);
  });

  test("without a proxy in front, a forged X-Forwarded-For does not dodge the lockout", async () => {
    const { base } = await startRemote();
    const client = await (await register(base)).json();
    for (let i = 0; i < 5; i++) {
      const page = await (await authorizePage(base, client.client_id, pkce().challenge)).text();
      await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${i}` }, body: new URLSearchParams({ request: requestIdOf(page)!, password: "wrong" }) });
    }
    const page = await (await authorizePage(base, client.client_id, pkce().challenge)).text();
    expect(await (await postLogin(base, requestIdOf(page)!, PW)).text()).toMatch(/Too many attempts/);
  });

  test("open sign-in pages cannot hold every client slot: a new client still registers", async () => {
    const store = new OAuthStore(home.dir);
    const provider = new OwnerProvider({ store, password: { plain: PW }, mcpUrl: new URL("https://x.example/mcp"), siteName: "s", serverName: "n", allowRedirect: () => true });
    const res: any = { status: () => res, type: () => res, set: () => res, send: () => {} };
    for (let i = 0; i < 60; i++) {
      const c = await provider.clientsStore.registerClient!({ redirect_uris: [CLAUDE_CB], client_name: `spam ${i}` } as any);
      await provider.authorize(c, { redirectUri: CLAUDE_CB, codeChallenge: "c", scopes: [] } as any, res);
    }
    const claude = await provider.clientsStore.registerClient!({ redirect_uris: [CLAUDE_CB], client_name: "Claude" } as any);
    expect(await provider.clientsStore.getClient(claude.client_id)).toBeDefined();
  });

  test("a client that has signed in stays registered after every client is signed out", async () => {
    let clock = Math.floor(Date.now() / 1000);
    const { base, server } = await startRemote({ now: () => clock });
    const { client } = await signIn(base);
    server.provider.revokeAll();
    clock += 2 * 60 * 60;
    await register(base);
    expect(server.store.data.clients[client.client_id]).toBeDefined();
  });

  test("a redirect removed from the allowlist no longer gets codes, even for a saved client", async () => {
    const port = freePort();
    const extra = "https://tool.example/cb";
    const first = await startRemote({ port, env: { EXTRA_REDIRECT_URIS: extra } });
    const client = await (await register(first.base, extra)).json();
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    const again = await startRemote({ port });
    const res = await authorizePage(again.base, client.client_id, pkce().challenge, { redirect: extra });
    expect(res.status).toBe(400);
    expect(requestIdOf(await res.text())).toBeUndefined();
  });

  test("a resource with a trailing slash is the same resource", async () => {
    const { base } = await startRemote();
    const client = await (await register(base)).json();
    const res = await authorizePage(base, client.client_id, pkce().challenge, { resource: `${base}/mcp/` });
    expect(res.status).toBe(200);
    expect(requestIdOf(await res.text())).toBeDefined();
  });

  test("a refresh cannot widen the scopes it was granted", async () => {
    const { base } = await startRemote();
    const { client, tokens } = await signIn(base);
    const res = await token(base, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, scope: "admin" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_scope");
  });

  test("a port in use and an unreadable oauth.json are input failures, not crashes", async () => {
    const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    try {
      await expect(startRemote({ port: taken.port! })).rejects.toMatchObject({ kind: "input", message: expect.stringContaining(`${taken.port}`) });
    } finally {
      taken.stop(true);
    }
    await Bun.write(join(home.dir, "oauth.json"), "{ not json");
    await expect(startRemote()).rejects.toMatchObject({ kind: "input", message: expect.stringContaining("oauth.json") });
  });

  test("`mcp --hash-password` reads the password on stdin and prints a hash remote mode accepts; a foreign hash is refused", async () => {
    const d = makeDeps(fakeFetch(happySite).fetch, home.dir);
    const app = { ...makeApp(makeSite(), d.deps), readStdin: async () => `${PW}\n` };
    const { output, code } = await run(["mcp", "--hash-password"], app);
    expect(code).toBe(0);
    const hash = (output as any).OWNER_PASSWORD_HASH as string;
    expect(remoteConfig({ OWNER_PASSWORD_HASH: hash, PUBLIC_URL: "https://x.example" }, {}).password.hash).toBe(hash);
    const short = await run(["mcp", "--hash-password"], { ...app, readStdin: async () => "short\n" });
    expect(short.code).toBe(2);
    const foreign = `scrypt$${Buffer.alloc(8).toString("base64")}$${Buffer.alloc(32).toString("base64")}`;
    expect(() => remoteConfig({ OWNER_PASSWORD_HASH: foreign, PUBLIC_URL: "https://x.example" }, {})).toThrow(/--hash-password/);
  });
});

describe("Server sign-in security", () => {
  test("a wrong password is refused, and five of them lock the address out", async () => {
    const { base, notes } = await startRemote();
    const client = await (await register(base)).json();
    for (let i = 0; i < 5; i++) {
      const page = await (await authorizePage(base, client.client_id, pkce().challenge)).text();
      const res = await postLogin(base, requestIdOf(page)!, `wrong ${i}`);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("http-equiv=\"refresh\"");
    }
    const page = await (await authorizePage(base, client.client_id, pkce().challenge)).text();
    const locked = await postLogin(base, requestIdOf(page)!, PW);
    expect(await locked.text()).toMatch(/Too many attempts/);
    expect(notes.join("\n")).not.toContain(PW);
  });

  test("an unknown or expired access token answers 401, not 400", async () => {
    let clock = Math.floor(Date.now() / 1000);
    const { base } = await startRemote({ now: () => clock });
    const unknown = await mcp(base, "not-a-token", "tools/list");
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("www-authenticate")).toContain("invalid_token");
    const { tokens } = await signIn(base);
    clock += 2 * 60 * 60;
    expect((await mcp(base, tokens.access_token, "tools/list")).status).toBe(401);
  });

  test("sign-in for another resource is refused, and a token for another resource does not work", async () => {
    const { base, server } = await startRemote();
    const client = await (await register(base)).json();
    const res = await authorizePage(base, client.client_id, pkce().challenge, { resource: "https://evil.example/mcp" });
    expect(res.status).toBe(400);
    expect(requestIdOf(await res.text())).toBeUndefined();
    const { tokens } = await signIn(base);
    server.store.update((d) => {
      for (const t of Object.values(d.tokens)) t.resource = "https://evil.example/mcp";
    });
    expect((await mcp(base, tokens.access_token, "tools/list")).status).toBe(401);
  });

  test("only claude.ai, loopback and the extra redirect URIs may register", async () => {
    const { base } = await startRemote({ env: { EXTRA_REDIRECT_URIS: "cursor://anysphere.cursor-mcp/oauth/callback" } });
    expect((await register(base, "https://chatgpt.com/connector_platform_oauth_redirect")).status).toBe(400);
    expect((await register(base, "https://claude.ai.evil.example/api/mcp/auth_callback")).status).toBe(400);
    expect((await register(base, "http://evil.example/callback")).status).toBe(400);
    expect((await register(base, "http://127.0.0.1:4567/callback")).status).toBe(201);
    expect((await register(base, "http://localhost:9999/callback")).status).toBe(201);
    expect((await register(base, "cursor://anysphere.cursor-mcp/oauth/callback")).status).toBe(201);
  });

  test("a disallowed Origin answers 403; claude.ai's or none is served", async () => {
    const { base } = await startRemote();
    const { tokens } = await signIn(base);
    expect((await mcp(base, tokens.access_token, "tools/list", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await mcp(base, tokens.access_token, "tools/list", undefined, { origin: "https://claude.ai" })).status).toBe(200);
    expect((await mcp(base, tokens.access_token, "tools/list")).status).toBe(200);
  });

  test("changing the Owner password signs every client out; the file holds no password fingerprint an attacker can test", async () => {
    const port = freePort();
    const first = await startRemote({ port });
    const { tokens } = await signIn(first.base);
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    const file = join(home.dir, "oauth.json");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(PW);
    expect(raw).not.toContain(createHash("sha256").update(PW).digest("hex"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = await startRemote({ port, env: { OWNER_PASSWORD: "another long password" } });
    expect((await mcp(again.base, tokens.access_token, "tools/list")).status).toBe(401);
    expect(again.notes.join("\n")).toMatch(/password changed/i);
  });

  test("open registration cannot evict a client that holds live tokens", async () => {
    const store = new OAuthStore(home.dir);
    const mcpUrl = new URL("https://x.example/mcp");
    const provider = new OwnerProvider({ store, password: { plain: PW }, mcpUrl, siteName: "shop.example.test", serverName: "acme-shop", allowRedirect: () => true });
    const owner = await provider.clientsStore.registerClient!({ redirect_uris: [CLAUDE_CB], client_name: "Claude" } as any);
    // Sign the Owner's client in through the provider itself: authorize, the password, the code.
    let html = "";
    const res: any = { status: () => res, type: () => res, set: () => res, send: (h: string) => void (html = h) };
    await provider.authorize(owner, { redirectUri: CLAUDE_CB, codeChallenge: "c", scopes: [], resource: mcpUrl } as any, res);
    const signedIn = provider.completeLogin(requestIdOf(html)!, PW, "203.0.113.7");
    expect("redirect" in signedIn).toBe(true);
    const code = new URL((signedIn as { redirect: string }).redirect).searchParams.get("code")!;
    await provider.exchangeAuthorizationCode(owner, code, undefined, CLAUDE_CB, mcpUrl);
    for (let i = 0; i < 80; i++) {
      try {
        await provider.clientsStore.registerClient!({ redirect_uris: [CLAUDE_CB], client_name: `spam ${i}` } as any);
      } catch {}
    }
    expect(await provider.clientsStore.getClient(owner.client_id)).toBeDefined();
    expect(Object.keys(store.data.clients).length).toBeLessThanOrEqual(50);
  });
});

/** An OAuth client provider for the SDK client that records where it was sent to sign in. */
class TestAuthProvider implements OAuthClientProvider {
  authorizationUrl?: string;
  private info?: any;
  private saved?: any;
  private verifier = "";
  get redirectUrl() { return CLAUDE_CB; }
  get clientMetadata() {
    return { redirect_uris: [CLAUDE_CB], client_name: "sdk-test", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } as any;
  }
  clientInformation() { return this.info; }
  saveClientInformation(info: any) { this.info = info; }
  tokens() { return this.saved; }
  saveTokens(tokens: any) { this.saved = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url.href; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}
