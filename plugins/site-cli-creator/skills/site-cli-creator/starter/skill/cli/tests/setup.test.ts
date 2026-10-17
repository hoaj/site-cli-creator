// The Setup page and the Session upload (remote mode): the Owner gives the server a Session, behind
// the Owner password on every action, over real HTTP against an in-test server and a fake site.
// Every response body and log line is collected, and no test ends while one holds a Session value.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { checkSession, mcpTools, type App } from "../src/main";
import { BUILTIN_FLAGS } from "../src/runtime/help";
import { remoteConfig } from "../src/runtime/remote-config";
import { serveHttp } from "../src/runtime/remote";
import { persistenceWarning, readStatus, statusFile } from "../src/runtime/setup";
import { sessionFile } from "../src/runtime/session";
import { CLAUDE_CB, authorizePage, fakeFetch, getCustomer, getOrder, happySite, listProducts, json, loginSite, makeApp, makeDeps, makeSite, pkce, postLogin, register, renameOrder, tempHome, token, withFreePort, type Recorded } from "./helpers";

const PW = "correct horse battery";
const GOOD = "GOOD-SESSION-VALUE";
const OTHER = "OTHER-SESSION-VALUE";
const goodSession = { headers: { cookie: `sid=${GOOD}` }, ids: { customerId: "C-1" } };

let home: ReturnType<typeof tempHome>;
const servers: Array<{ close(): Promise<void> }> = [];
/** Every response body and every log line of a test: none may hold a Session value. */
let seen: string[] = [];
beforeEach(() => {
  home = tempHome();
  seen = [];
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  const all = seen.join("\n");
  expect(all.includes(GOOD)).toBe(false);
  expect(all.includes(OTHER)).toBe(false);
  home.cleanup();
});

/** The site accepts only the good Session's cookie; otherwise it behaves like happySite. */
const sessionSite = (req: Recorded) => (req.headers.cookie === `sid=${GOOD}` ? happySite(req) : json({ message: "signed out" }, 401));

type Start = { site?: ReturnType<typeof makeSite>; env?: Record<string, string>; extra?: Partial<App> };

const start = (opts: Start = {}) => withFreePort((port) => startOn(port, opts));

async function startOn(port: number, opts: Start) {
  const state: { handler: (req: Recorded) => Response | Promise<Response> } = { handler: sessionSite };
  const f = fakeFetch((req) => state.handler(req));
  const d = makeDeps(f.fetch, home.dir);
  const app = makeApp(opts.site ?? loginSite(), d.deps, opts.extra);
  const config = remoteConfig({ OWNER_PASSWORD: PW, PUBLIC_URL: `http://127.0.0.1:${port}` }, { port });
  const notes: string[] = [];
  const server = await serveHttp({
    ...mcpTools(app, { remote: true }),
    site: app.site,
    config,
    dir: home.dir,
    host: "127.0.0.1",
    env: opts.env,
    note: (m) => {
      notes.push(m);
      seen.push(m);
    },
    checkSession: (candidate) => checkSession(app, candidate),
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${port}`, app, state, calls: f.calls, loginCalls: d.loginCalls, notes, server };
}

/** A request whose whole body is kept for the leak check. */
async function req(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  seen.push(text);
  return { status: res.status, headers: res.headers, text };
}

type Upload = { password?: string; text?: string; file?: string };

function upload(base: string, o: Upload) {
  const form = new FormData();
  form.set("password", o.password ?? PW);
  if (o.text !== undefined) form.set("session_text", o.text);
  if (o.file !== undefined) form.set("session_file", new File([o.file], "session.json", { type: "application/json" }));
  return req(`${base}/setup/session`, { method: "POST", body: form });
}

const action = (base: string, path: "delete" | "signout", password = PW) =>
  req(`${base}/setup/${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) });

const sessionJson = (s: object = goodSession) => JSON.stringify(s);
const stored = () => readFileSync(sessionFile(home.dir), "utf8");

// --- the Server sign-in, as a client like claude.ai does it ---

async function signIn(base: string) {
  const client = await (await register(base)).json();
  const { verifier, challenge } = pkce();
  const page = await (await authorizePage(base, client.client_id, challenge)).text();
  const requestId = page.match(/name="request" value="([^"]+)"/)![1]!;
  const done = await (await postLogin(base, requestId, PW)).text();
  const raw = done.match(/http-equiv="refresh" content="0;url=([^"]+)"/)![1]!;
  const code = new URL(raw.replaceAll("&amp;", "&")).searchParams.get("code")!;
  const res = await token(base, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CLAUDE_CB, resource: `${base}/mcp` });
  expect(res.status).toBe(200);
  return (await res.json()).access_token as string;
}

let rpcId = 1;
function mcp(base: string, accessToken: string, method: string, params?: unknown) {
  return req(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, ...(params !== undefined && { params }) }),
  });
}

async function toolCall(base: string, accessToken: string, name: string, args: object = {}) {
  const r = await mcp(base, accessToken, "tools/call", { name, arguments: args });
  return JSON.parse(r.text).result as { content: Array<{ text: string }>; isError?: boolean };
}
const textOf = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);

describe("the Setup page", () => {
  test("shows the site and a missing Session without a password, is not cached, and has the three forms", async () => {
    const { base } = await start();
    const r = await req(`${base}/setup`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(r.text).toContain("shop.example.test");
    expect(r.text).toContain("Session: missing");
    expect(r.text).not.toContain("<script");
    const actions = [...r.text.matchAll(/<form [^>]*action="([^"]+)"/g)].map((m) => m[1]);
    expect(actions).toEqual(["/setup/session", "/setup/delete", "/setup/signout"]);
    expect(r.text).toContain('enctype="multipart/form-data"');
    expect(r.text).toContain('name="session_file"');
    expect(r.text).toContain('name="session_text"');
    expect(r.text).toContain("shop login");
  });

  test("the root redirects to /setup, the log and the --http help name it, and the page's CSS wins", async () => {
    const { base, notes } = await start();
    const root = await fetch(`${base}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/setup");
    expect(notes.some((n) => n.includes("listening") && n.includes(`${base}/setup`))).toBe(true);
    expect(BUILTIN_FLAGS.mcp!.find((f) => f.name === "--http")!.description).toContain("/setup");
    const html = (await req(`${base}/setup`)).text;
    expect(html.indexOf(".wrap{max-width:560px}")).toBeGreaterThan(html.indexOf(".wrap{max-width:460px"));
  });

  test("a site that needs no sign-in has no upload form, and an upload is refused", async () => {
    const { base } = await start({ site: makeSite() });
    const page = await req(`${base}/setup`);
    expect(page.text).toContain("needs no sign-in");
    expect(page.text).not.toContain("session_file");
    expect(page.text).not.toContain("/setup/session");
    expect(page.text).toContain("/setup/signout");
    const r = await upload(base, { text: sessionJson() });
    expect(r.status).toBe(400);
    expect(existsSync(sessionFile(home.dir))).toBe(false);
  });

  test("warns when no volume is attached on Railway", async () => {
    const { base } = await start({ env: { RAILWAY_ENVIRONMENT: "production" } });
    expect((await req(`${base}/setup`)).text).toContain("No volume is attached");
    const calm = await start({ env: {} });
    expect((await req(`${calm.base}/setup`)).text).not.toContain("volume");
  });
});

describe("persistenceWarning", () => {
  test("names a missing volume, a state dir outside it, and says nothing otherwise", () => {
    expect(persistenceWarning({ RAILWAY_ENVIRONMENT: "production" }, "/data")).toContain("No volume is attached");
    const outside = persistenceWarning({ RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: "/data" }, "/root/.acme");
    expect(outside).toContain("/root/.acme");
    expect(outside).toContain("/data");
    expect(persistenceWarning({ RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: "/data" }, "/data/state")).toBeNull();
    expect(persistenceWarning({ RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: "/data" }, "/data")).toBeNull();
    expect(persistenceWarning({}, "/anywhere")).toBeNull();
  });

  test("any Railway variable marks the host, and the texts say what to do", () => {
    for (const name of ["RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID"]) {
      expect(persistenceWarning({ [name]: "x" }, "/root/.acme")).toContain("No volume is attached");
    }
    expect(persistenceWarning({ RAILWAY_PROJECT_ID: "p" }, "/root/.acme")).toContain("keep this server's state dir (/root/.acme) on it");
    expect(persistenceWarning({ RAILWAY_PROJECT_ID: "p", RAILWAY_VOLUME_MOUNT_PATH: "/data" }, "/root/.acme")).toContain("Point HOME (or the state dir) at the volume");
  });
});

describe("the Session upload", () => {
  test("a wrong password is 401 and stores nothing; five wrong ones lock the address", async () => {
    const { base, notes } = await start();
    const first = await upload(base, { password: "nope nope nope", file: sessionJson() });
    expect(first.status).toBe(401);
    expect(first.text).toContain("Wrong password");
    expect(existsSync(sessionFile(home.dir))).toBe(false);
    for (let i = 0; i < 4; i++) expect((await upload(base, { password: "nope nope nope", file: sessionJson() })).status).toBe(401);
    const locked = await upload(base, { file: sessionJson() });
    expect(locked.status).toBe(401);
    expect(locked.text).toContain("Too many attempts");
    expect(existsSync(sessionFile(home.dir))).toBe(false);
    expect(notes.some((n) => n.includes("failed Setup page password"))).toBe(true);
  });

  test("the other Setup page actions share that lockout", async () => {
    const { base } = await start();
    for (let i = 0; i < 5; i++) await action(base, "signout", "nope nope nope");
    expect((await action(base, "signout")).text).toContain("Too many attempts");
  });

  test("a working Session as a file is stored 0600, checked, and used by the tools", async () => {
    const { base } = await start();
    const token = await signIn(base);
    const r = await upload(base, { file: sessionJson() });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Session stored and checked");
    if (process.platform !== "win32") expect(statSync(sessionFile(home.dir)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(stored())).toMatchObject({ headers: { cookie: `sid=${GOOD}` }, ids: { customerId: "C-1" } });
    const status = readStatus(home.dir);
    expect(status.state).toBe("valid");
    expect(status.uploadedAt).toBeDefined();
    expect((await req(`${base}/setup`)).text).toContain("Session: valid");
    const result = await toolCall(base, token, "products_show", { all: true });
    expect(result.isError).toBeUndefined();
    expect(textOf(result).products).toHaveLength(2);
  });

  test("the same through the text field; the file wins when both are given; extra keys are dropped", async () => {
    const { base } = await start();
    const r = await upload(base, { text: sessionJson({ ...goodSession, fromProfile: "/home/owner/chrome", extra: 1 }) });
    expect(r.status).toBe(200);
    const saved = JSON.parse(stored());
    expect(saved.fromProfile).toBeUndefined();
    expect(saved.extra).toBeUndefined();
    expect(saved.headers.cookie).toBe(`sid=${GOOD}`);
    expect((await upload(base, { file: sessionJson(), text: "not json at all" })).status).toBe(200);
  });

  test("bad input is rejected and an earlier working Session is kept", async () => {
    const { base } = await start();
    expect((await upload(base, { file: sessionJson() })).status).toBe(200);
    const before = stored();
    const cases: Array<[Upload, number, string]> = [
      [{ text: "{not json" }, 400, "not a session.json"],
      [{ text: JSON.stringify({ headers: "x", ids: {} }) }, 400, "not a session.json"],
      [{ text: JSON.stringify({ headers: { cookie: 1 }, ids: {} }) }, 400, "not a session.json"],
      [{}, 400, "Choose session.json"],
      [{ file: "", text: "  " }, 400, "Choose session.json"],
      [{ file: JSON.stringify({ ...goodSession, ids: { customerId: "x".repeat(70_000) } }) }, 413, "larger than 64 KB"],
    ];
    for (const [body, status, message] of cases) {
      const r = await upload(base, body);
      expect([r.status, r.text.includes(message)]).toEqual([status, true]);
      expect(stored()).toBe(before);
    }
    const huge = await upload(base, { file: "x".repeat(300_000) });
    expect(huge.status).toBe(413);
    expect(huge.headers.get("connection")).toBe("close");
    expect(stored()).toBe(before);
    expect(readStatus(home.dir).state).toBe("valid");
  });

  test("a Session the site refuses is rejected and the old one is kept", async () => {
    const { base } = await start();
    await upload(base, { file: sessionJson() });
    const before = stored();
    const r = await upload(base, { file: sessionJson({ headers: { cookie: `sid=${OTHER}` }, ids: { customerId: "C-1" } }) });
    expect(r.status).toBe(400);
    expect(r.text).toContain("did not accept");
    expect(stored()).toBe(before);
    expect(readStatus(home.dir).state).toBe("valid");
  });

  test("a site that answers 500 is 'not responding', and the old Session is kept", async () => {
    const { base, state } = await start();
    await upload(base, { file: sessionJson() });
    const before = stored();
    state.handler = () => json({ message: "boom" }, 500);
    const r = await upload(base, { file: sessionJson() });
    expect(r.status).toBe(400);
    expect(r.text).toContain("not responding");
    expect(stored()).toBe(before);
  });

  test("a Session without what the reads need, or without headers, never replaces a working one", async () => {
    const { base } = await start();
    await upload(base, { file: sessionJson() });
    const before = stored();
    const noIds = await upload(base, { file: sessionJson({ headers: { cookie: `sid=${GOOD}` }, ids: {} }) });
    expect(noIds.status).toBe(400);
    expect(noIds.text).toContain("lacks what the site&#39;s reads need");
    const noHeaders = await upload(base, { file: sessionJson({ headers: {}, ids: { customerId: "C-1" } }) });
    expect(noHeaders.status).toBe(400);
    expect(noHeaders.text).toContain("no sign-in (no headers)");
    expect((await upload(base, { file: sessionJson({ headers: {}, ids: {} }) })).status).toBe(400);
    expect(stored()).toBe(before);
    expect(readStatus(home.dir).state).toBe("valid");
  });

  test("reads that all need input: the Session is stored as unchecked, and the Owner is told", async () => {
    const { base } = await start({ extra: { operations: [getOrder] } });
    const r = await upload(base, { file: sessionJson() });
    expect(r.status).toBe(200);
    expect(r.text).toContain("not checked");
    expect(existsSync(sessionFile(home.dir))).toBe(true);
    const status = readStatus(home.dir);
    expect(status.state).toBe("unchecked");
    expect(status.uploadedAt).toBeDefined();
    expect(status.checkedAt).toBeUndefined();
    expect((await req(`${base}/setup`)).text).toContain("Session: unchecked");
  });

  test("a delete fired during a slow check waits its turn: the Session ends deleted", async () => {
    const { base, state } = await start();
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    state.handler = async (r) => {
      entered();
      await gate;
      return sessionSite(r);
    };
    const uploading = upload(base, { file: sessionJson() });
    await inside;
    const deleting = action(base, "delete");
    await Bun.sleep(150);
    release();
    expect((await uploading).status).toBe(200);
    expect((await deleting).status).toBe(200);
    expect(existsSync(sessionFile(home.dir))).toBe(false);
    expect(existsSync(statusFile(home.dir))).toBe(false);
    expect(readStatus(home.dir).state).toBe("missing");
  });

  test("the files are private and no temporary file is left behind", async () => {
    const { base } = await start();
    await signIn(base);
    await upload(base, { file: sessionJson() });
    if (process.platform !== "win32") {
      for (const file of [sessionFile(home.dir), statusFile(home.dir), `${home.dir}/oauth.json`]) expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(home.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a chunked upload (no Content-Length) works, and one over 256 KB is 413", async () => {
    const { base } = await start();
    const chunked = async (o: Upload) => {
      const form = new FormData();
      form.set("password", o.password ?? PW);
      if (o.file !== undefined) form.set("session_file", new File([o.file], "session.json"));
      const whole = new Response(form);
      const type = whole.headers.get("content-type")!;
      const bytes = new Uint8Array(await whole.arrayBuffer());
      const half = Math.floor(bytes.length / 2);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes.slice(0, half));
          c.enqueue(bytes.slice(half));
          c.close();
        },
      });
      return req(`${base}/setup/session`, { method: "POST", headers: { "content-type": type }, body, duplex: "half" } as RequestInit);
    };
    const ok = await chunked({ file: sessionJson() });
    expect(ok.status).toBe(200);
    expect(readStatus(home.dir).state).toBe("valid");
    const big = await chunked({ file: "x".repeat(300_000) });
    expect(big.status).toBe(413);
    expect(big.headers.get("connection")).toBe("close");
  });

  test("a refused first upload leaves no Session and no status behind", async () => {
    const { base } = await start();
    const r = await upload(base, { file: sessionJson({ headers: { cookie: `sid=${OTHER}` }, ids: { customerId: "C-1" } }) });
    expect(r.status).toBe(400);
    expect(existsSync(sessionFile(home.dir))).toBe(false);
    expect(readStatus(home.dir).state).toBe("missing");
  });
});

describe("delete and sign out", () => {
  test("delete removes the Session; a tool then fails with session and points at /setup", async () => {
    const { base } = await start();
    const token = await signIn(base);
    await upload(base, { file: sessionJson() });
    expect((await action(base, "delete", "nope nope nope")).status).toBe(401);
    expect(existsSync(sessionFile(home.dir))).toBe(true);
    const r = await action(base, "delete");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Session deleted");
    expect(existsSync(sessionFile(home.dir))).toBe(false);
    expect(readStatus(home.dir).state).toBe("missing");
    const result = await toolCall(base, token, "products_show");
    expect(result.isError).toBe(true);
    const error = textOf(result).error;
    expect(error.kind).toBe("session");
    expect(error.next).toContain(`${base}/setup`);
    expect(error.next).not.toContain("login tool");
  });

  test("sign out every client revokes the tokens already issued", async () => {
    const { base } = await start();
    const token = await signIn(base);
    expect((await mcp(base, token, "tools/list")).status).toBe(200);
    expect((await action(base, "signout", "nope nope nope")).status).toBe(401);
    expect((await mcp(base, token, "tools/list")).status).toBe(200);
    const r = await action(base, "signout");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Every client is signed out");
    expect((await mcp(base, token, "tools/list")).status).toBe(401);
  });
});

describe("remote tools", () => {
  test("remote mode lists no login and its check has no writes; local mode keeps both", async () => {
    const app = makeApp(loginSite(), makeDeps(fakeFetch(happySite).fetch, home.dir).deps);
    const remote = mcpTools(app, { remote: true });
    expect(remote.tools.map((t) => t.name)).not.toContain("login");
    expect(Object.keys(remote.tools.find((t) => t.name === "check")!.schema.shape)).toEqual(["op", "account"]);
    expect(remote.info.instructions).toContain("Setup page");
    const local = mcpTools(app);
    expect(local.tools.map((t) => t.name)).toContain("login");
    expect(Object.keys(local.tools.find((t) => t.name === "check")!.schema.shape)).toContain("writes");
    expect(local.info.instructions).not.toContain("Setup page");

    const { base } = await start();
    const list = JSON.parse((await mcp(base, await signIn(base), "tools/list")).text);
    expect(list.result.tools.map((t: any) => t.name)).not.toContain("login");
  });

  test("a tool call that fails with session marks the Session expired, with the reason", async () => {
    const { base, state, loginCalls } = await start();
    const token = await signIn(base);
    await upload(base, { file: sessionJson() });
    state.handler = () => json({ message: "signed out" }, 401);
    const result = await toolCall(base, token, "products_show");
    const error = textOf(result).error;
    expect(error.kind).toBe("session");
    expect(error.message).toContain("does not open Chrome");
    expect(error.next).toContain(`${base}/setup`);
    expect(loginCalls).toEqual([]);
    const status = readStatus(home.dir);
    expect(status.state).toBe("expired");
    expect(status.uploadedAt).toBeDefined();
    const page = await req(`${base}/setup`);
    expect(page.text).toContain("Session: expired");
    expect(page.text).toContain("has expired");
  });

  test("a call that succeeds after an expired mark marks the Session valid again", async () => {
    const { base, state } = await start();
    const token = await signIn(base);
    await upload(base, { file: sessionJson() });
    const uploadedAt = readStatus(home.dir).uploadedAt;
    state.handler = () => json({ message: "signed out" }, 401);
    expect(textOf(await toolCall(base, token, "products_show")).error.kind).toBe("session");
    expect(readStatus(home.dir).state).toBe("expired");
    state.handler = sessionSite;
    expect((await toolCall(base, token, "products_show")).isError).toBeUndefined();
    const status = readStatus(home.dir);
    expect(status).toMatchObject({ state: "valid", uploadedAt });
    expect(status.checkedAt).toBeDefined();
    expect((await req(`${base}/setup`)).text).toContain("Session: valid");
  });

  test("remote check refuses a write Operation (it needs Chrome); local check does not", async () => {
    let writeChecks = 0;
    const app = makeApp(loginSite(), makeDeps(fakeFetch(sessionSite).fetch, home.dir).deps, {
      checkWrites: async () => (writeChecks++, new Map()),
    });
    const remote = mcpTools(app, { remote: true }).tools.find((t) => t.name === "check")!;
    const { output, code } = await remote.call({ op: renameOrder.name });
    expect(code).toBe(2);
    expect((output as any).error.kind).toBe("input");
    expect((output as any).error.message).toContain("needs Chrome");
    expect(writeChecks).toBe(0);
    expect(remote.description).not.toContain("writes");
    expect(mcpTools(app).tools.find((t) => t.name === "check")!.description).toContain("writes: true");
  });

  test("remote mode lists no doctor; local mode keeps it", () => {
    const app = makeApp(loginSite(), makeDeps(fakeFetch(happySite).fetch, home.dir).deps);
    expect(mcpTools(app, { remote: true }).tools.map((t) => t.name)).not.toContain("doctor");
    expect(mcpTools(app).tools.map((t) => t.name)).toContain("doctor");
  });
});

describe("checkSession", () => {
  const candidate = { ...goodSession, savedAt: "2026-01-01T00:00:00.000Z" };
  const appWith = (handler: (r: Recorded) => Response, extra: Parameters<typeof makeApp>[2] = {}) =>
    makeApp(loginSite(), makeDeps(fakeFetch(handler).fetch, home.dir).deps, extra);

  test("a working Session: ok, with the reads that were tried, and nothing is saved", async () => {
    expect(await checkSession(appWith(sessionSite), candidate)).toEqual({ ok: true, tried: 2 });
    expect(existsSync(sessionFile(home.dir))).toBe(false);
  });

  test("the site refusing the Session says so and names `<skill> login`", async () => {
    const r = await checkSession(appWith(() => json({}, 401)), candidate);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/did not accept this Session.*shop login/);
  });

  test("a site that does not answer is a network reason", async () => {
    expect(await checkSession(appWith(() => json({}, 503)), candidate)).toEqual({ ok: false, reason: "the site is not responding right now; try again later" });
  });

  test("another Drift says the site changed and points at `<skill> check`", async () => {
    const r = await checkSession(appWith((req) => (new URL(req.url).pathname === "/graphql" ? json({ message: "gone" }, 404) : json({}))), candidate);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Drift.*shop check/);
  });

  test("several accounts: check ends in input naming them, and one account is tried", async () => {
    const forAccount = { ...getCustomer, needs: { customerId: { from: "session" as const, key: "account" } } };
    const site = loginSite({ accounts: async () => [{ id: "A1" }, { id: "A2" }] });
    const app = makeApp(site, makeDeps(fakeFetch(sessionSite).fetch, home.dir).deps, { operations: [forAccount, listProducts] });
    expect(await checkSession(app, candidate)).toEqual({ ok: true, tried: 2 });
  });

  test("nothing to try is not a refusal: no read Operation, or reads that all need input", async () => {
    expect(await checkSession(appWith(sessionSite, { operations: [renameOrder] }), candidate)).toEqual({ ok: true, tried: 0 });
    expect(await checkSession(appWith(sessionSite, { operations: [getOrder] }), candidate)).toEqual({ ok: true, tried: 0 });
  });

  test("reads that need a value the Session lacks are a refusal, not nothing to try", async () => {
    const r = await checkSession(appWith(sessionSite), { headers: { cookie: `sid=${GOOD}` }, ids: {}, savedAt: "2026-01-01T00:00:00.000Z" });
    expect(r).toEqual({ ok: false, reason: "this session.json lacks what the site's reads need; upload the file `shop login` wrote" });
  });

  test("a Drift at a field named auth is a changed site, not a refused Session", async () => {
    const odd = { ...getCustomer, response: z.object({ auth: z.string() }) };
    const r = await checkSession(appWith(sessionSite, { operations: [odd] }), candidate);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/Drift/);
      expect(r.reason).not.toContain("did not accept");
    }
  });
});
