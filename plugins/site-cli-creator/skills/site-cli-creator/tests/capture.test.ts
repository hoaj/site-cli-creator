import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { SKILL_ROOT } from "../tools/lib/paths";

const CAPTURE = join(SKILL_ROOT, "tools", "capture.ts");
const CHROME = process.env.SITE_CLI_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const hasChrome = process.platform !== "darwin" || existsSync(CHROME);

// Personal data the tiny site serves and receives; none of it may reach any output.
const SECRETS = ["jens.hansen@example.dk", "010190-1234", "Jens Hansen", "Vestergade 12", "99812345", "349.75", "s3cr3t-bearer-token", "tok_live_abcdef"];
const CUSTOMER_ID = "99812345";

let server: Server<unknown>;
let work: string;
let writesReceived: string[] = [];

const PAGE = `<!doctype html><html><body>
<button id="rest-write">save</button><button id="gql-write">note</button>
<script>
const auth = { authorization: "Bearer s3cr3t-bearer-token", "content-type": "application/json" };
async function load() {
  await fetch("/api/customers/${CUSTOMER_ID}/profile?email=jens.hansen%40example.dk", { headers: auth });
  await fetch("/graphql", { method: "POST", headers: { ...auth, "x-apollo-operation-name": "getCustomer" }, body: JSON.stringify({
    operationName: "getCustomer",
    query: 'query getCustomer($id: ID!) { getCustomer(id: $id, hint: "Jens Hansen") { id email cpr balance } }',
    variables: { id: "${CUSTOMER_ID}", token: "tok_live_abcdef" },
  }) });
  await fetch("http://localhost:" + location.port + "/api/elsewhere").catch(() => {});
  window.loaded = true;
}
document.getElementById("rest-write").onclick = () =>
  fetch("/api/notes", { method: "POST", headers: auth, body: JSON.stringify({ text: "Vestergade 12", owner: "jens.hansen@example.dk" }) })
    .then(() => (window.restDone = "sent"), () => (window.restDone = "blocked"));
document.getElementById("gql-write").onclick = () =>
  fetch("/graphql", { method: "POST", headers: auth, body: JSON.stringify({
    operationName: "addNote",
    query: "mutation addNote($text: String!) { addNote(text: $text) { id } }",
    variables: { text: "010190-1234" },
  }) }).then(() => (window.gqlDone = "sent"), () => (window.gqlDone = "blocked"));
load();
</script></body></html>`;

// A frontend that must sign in first: its token and post-login POSTs have to go
// through in a read Task, or the Task's data never loads.
const SIGNED_IN_PAGE = `<!doctype html><html><body><script>
async function load() {
  const t = await fetch("/oauth/token", { method: "POST" });
  if (!t.ok) return (window.loaded = "no token");
  const { access_token } = await t.json();
  const h = { authorization: "Bearer " + access_token, "content-type": "application/json" };
  const p = await fetch("/api/session/post-login", { method: "POST", headers: h, body: JSON.stringify({ email: "jens.hansen@example.dk" }) });
  if (!p.ok) return (window.loaded = "no post-login");
  await fetch("/graphql", { method: "POST", headers: h, body: JSON.stringify({
    operationName: "signInUser", query: "mutation signInUser { signInUser { ok } }",
  }) });
  await fetch("/api/quotes", { method: "POST", headers: h, body: "{}" }).catch(() => {});
  const r = await fetch("/api/customers/${CUSTOMER_ID}/profile", { headers: h });
  window.loaded = r.ok ? "yes" : "no profile";
}
load();
</script></body></html>`;

// A page that fires writes on its own while loading (YouSee's createQuote), a persisted
// (hash-only) GraphQL mutation and a write to another host, before the user's own write.
const SIDE_EFFECT_PAGE = `<!doctype html><html><body>
<button id="save">save</button>
<script>
async function load() {
  const h = { "content-type": "application/json" };
  await fetch("/graphql", { method: "POST", headers: h, body: JSON.stringify({ operationName: "createQuote", query: "mutation createQuote { createQuote { id } }" }) }).catch(() => {});
  await fetch("/graphql", { method: "POST", headers: h, body: JSON.stringify({ operationName: "cancelSubscription", extensions: { persistedQuery: { version: 1, sha256Hash: "abc" } } }) }).catch(() => {});
  await fetch("http://localhost:" + location.port + "/api/cart", { method: "POST", headers: h, body: "{}" }).catch(() => {});
  window.loaded = true;
}
document.getElementById("save").onclick = () =>
  fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: "dark" }) })
    .then(() => (window.saved = "sent"), () => (window.saved = "blocked"));
load();
</script></body></html>`;

// A REST search whose URL parameter is called `query` (#33): the typed word is a value.
const SEARCH_WORD = "Fjordkaffe";
const SEARCH_PAGE = `<!doctype html><html><body><script>
fetch("/api/search/suppliers?query=${SEARCH_WORD}&limit=25&sortBy=BestMatch").then(() => (window.loaded = true));
</script></body></html>`;

// A Task whose button opens another site in a new window (#34): closing the Task window must end the Capture.
const POPUP_PAGE = `<!doctype html><html><body><a id="shop" href="http://localhost:PORT/shop" target="_blank">shop</a><script>
fetch("/api/customers/${CUSTOMER_ID}/profile").then(() => (window.loaded = true));
</script></body></html>`;

// A Next.js App Router page (#36): a server action (POST to the page with `next-action`) and an RSC
// stream (`?_rsc=`, text/x-component), next to the plain JSON route that holds the data.
const NEXT_PAGE = `<!doctype html><html><body><script>
async function load() {
  await fetch("/partner/4711?_rsc=1x2y3", { headers: { rsc: "1" } });
  await fetch("/partner/4711", { method: "POST", headers: { "next-action": "7f3a9c", accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body: '["4711"]' }).catch(() => {});
  await fetch("/api/partners/4711");
  window.loaded = true;
}
load();
</script></body></html>`;

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "set-cookie": "sid=s3cr3t-bearer-token" },
  });
}

const SCRIPT = `export default async (page) => {
  await page.waitForFunction(() => window.loaded === true);
  await page.click("#rest-write");
  await page.waitForFunction(() => !!window.restDone);
  await page.click("#gql-write");
  await page.waitForFunction(() => !!window.gqlDone);
};
`;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "capture-test-"));
  writeFileSync(join(work, "script.ts"), SCRIPT);
  writeFileSync(join(work, "broken.ts"), "export default async () => { throw new Error('nope'); };\n");
  writeFileSync(join(work, "signed-in.ts"), "export default async (page) => {\n  await page.waitForFunction(() => !!window.loaded);\n  const state = await page.evaluate(() => window.loaded);\n  if (state !== 'yes') throw new Error('page did not load: ' + state);\n};\n");
  // Opens the shop in a second window, closes the Task window, then never finishes on its own.
  writeFileSync(join(work, "popup.ts"), "export default async (page) => {\n  await page.waitForFunction(() => window.loaded === true);\n  const popup = page.context().waitForEvent('page');\n  await page.click('#shop');\n  await (await popup).waitForLoadState();\n  await page.close();\n  await new Promise(() => {});\n};\n");
  writeFileSync(join(work, "noop.ts"), "export default async () => {};\n");
  writeFileSync(join(work, "loaded.ts"), "export default async (page) => {\n  await page.waitForFunction(() => window.loaded === true);\n};\n");
  writeFileSync(join(work, "side-effect.ts"), "export default async (page) => {\n  await page.waitForFunction(() => window.loaded === true);\n  await page.click('#save');\n  await page.waitForFunction(() => !!window.saved);\n};\n");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/signed-in") return new Response(SIGNED_IN_PAGE, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/popup") return new Response(POPUP_PAGE.replace("PORT", String(server.port)), { headers: { "content-type": "text/html" } });
      if (url.pathname === "/shop") return new Response("<!doctype html><title>shop</title>", { headers: { "content-type": "text/html" } });
      if (url.pathname === "/next") return new Response(NEXT_PAGE, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/partner/4711" && req.method === "POST") {
        writesReceived.push("server action");
        return new Response('0:["$@1"]', { headers: { "content-type": "text/x-component" } });
      }
      if (url.pathname === "/partner/4711") return new Response('0:{"P":null}', { headers: { "content-type": "text/x-component" } });
      if (url.pathname === "/api/partners/4711") return json({ id: "4711", name: "Shop" });
      if (url.pathname === "/search") return new Response(SEARCH_PAGE, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/api/search/suppliers") return json({ items: [{ name: `${SEARCH_WORD} ApS`, id: CUSTOMER_ID }] });
      if (url.pathname === "/side-effect") return new Response(SIDE_EFFECT_PAGE, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/api/settings" && req.method === "POST") {
        writesReceived.push("POST /api/settings");
        return json({ theme: "dark" });
      }
      if (url.pathname === "/api/cart" && req.method === "POST") {
        writesReceived.push(`POST ${url.host}/api/cart`);
        return json({ ok: true });
      }
      if (url.pathname === "/oauth/token" && req.method === "POST") return json({ access_token: "s3cr3t-bearer-token", token_type: "Bearer" });
      if (url.pathname === "/api/session/post-login" && req.method === "POST") {
        return json({ personalInfo: { customerId: CUSTOMER_ID, cpr: "010190-1234", email: "jens.hansen@example.dk" } });
      }
      if (url.pathname === "/api/quotes" && req.method === "POST") {
        writesReceived.push("POST /api/quotes");
        return json({ id: "q-1" }, { status: 201 });
      }
      if (url.pathname === `/api/customers/${CUSTOMER_ID}/profile`) {
        return json({ id: CUSTOMER_ID, name: "Jens Hansen", email: "jens.hansen@example.dk", cpr: "010190-1234", address: { street: "Vestergade 12" }, balance: 349.75, tags: [], closedAt: null });
      }
      if (url.pathname === "/api/notes" && req.method === "POST") {
        writesReceived.push("POST /api/notes");
        return json({ note: { id: "n-1", text: "Vestergade 12" } }, { status: 201 });
      }
      if (url.pathname === "/graphql") {
        const body = (await req.json()) as { operationName: string };
        if (body.operationName === "signInUser") return json({ data: { signInUser: { ok: true } } });
        if (body.operationName === "createQuote" || body.operationName === "cancelSubscription") {
          writesReceived.push(body.operationName);
          return json({ data: { [body.operationName]: { id: "q" } } });
        }
        if (body.operationName === "addNote") {
          writesReceived.push("addNote");
          return json({ data: { addNote: { id: "n-2" } } });
        }
        return json({ data: { getCustomer: { id: CUSTOMER_ID, email: "jens.hansen@example.dk", cpr: "010190-1234", balance: 349.75 } } });
      }
      return json({ elsewhere: "jens.hansen@example.dk" });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  rmSync(work, { recursive: true, force: true });
});

async function capture(skill: string, extra: string[], path = "/") {
  mkdirSync(skill, { recursive: true });
  const proc = Bun.spawn(
    [process.execPath, CAPTURE, "--skill-dir", skill, "--task", "profile-show", "--url", `http://127.0.0.1:${server.port}${path}`, "--profile", join(work, "profile"), "--headless", ...extra],
    { env: { ...process.env, ...(existsSync(CHROME) ? { SITE_CLI_CHROME: CHROME } : {}) }, stdout: "pipe", stderr: "pipe", timeout: 90_000 },
  );
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const dir = join(skill, "captures", "profile-show");
  const files = existsSync(dir) ? readdirSync(dir).sort() : [];
  const everything = [stdout, ...files.map((f) => readFileSync(join(dir, f), "utf8"))].join("\n");
  return { code: proc.exitCode, out: JSON.parse(stdout), stderr, dir, files, everything };
}

function assertNoValues(text: string) {
  for (const secret of SECRETS) expect(text, `leaked ${secret}`).not.toContain(secret);
}

describe.skipIf(!hasChrome)("capture.ts against a local site", () => {
  test("read Task: shapes only, writes aborted, other hosts ignored", async () => {
    writesReceived = [];
    const r = await capture(join(work, "read-skill"), ["--script", join(work, "script.ts")]);
    expect(r.code, r.stderr).toBe(0);
    assertNoValues(r.everything);
    expect(writesReceived).toEqual([]);
    expect(r.out.stoppedBy).toBe("script finished");
    expect(r.out.operations).toEqual([
      { operation: "GET /", effect: "read", navigation: true, file: "GET-root.shape.json", aborted: 0 },
      { operation: "GET /api/customers/:id/profile", effect: "read", file: "GET-api-customers-id-profile.shape.json", aborted: 0 },
      { operation: "getCustomer", effect: "read", file: "getCustomer.shape.json", aborted: 0 },
      { operation: "POST /api/notes", effect: "write", file: "POST-api-notes.shape.json", aborted: 1 },
      { operation: "addNote", effect: "write", file: "addNote.shape.json", aborted: 1 },
    ]);
    expect(r.files).toEqual([
      "GET-api-customers-id-profile.shape.json",
      "GET-root.shape.json",
      "POST-api-notes.shape.json",
      "addNote.shape.json",
      "getCustomer.shape.json",
      "index.json",
    ]);

    const index = JSON.parse(readFileSync(join(r.dir, "index.json"), "utf8"));
    expect(index).toMatchObject({ task: "profile-show", startPath: "/", write: false });
    expect(index.operations.map((o: { operation: string }) => o.operation)).toEqual(r.out.operations.map((o: { operation: string }) => o.operation));

    const profile = JSON.parse(readFileSync(join(r.dir, "GET-api-customers-id-profile.shape.json"), "utf8"));
    expect(profile.request.query).toEqual({ type: "object", fields: { email: { type: "string" } } });
    expect(profile.request.headers.authorization).toBeNull();
    expect(profile.request.headers["content-type"]).toBe("application/json");
    expect(profile.responses[0].status).toBe(200);
    expect(profile.responses[0].body.shape.fields).toMatchObject({
      id: { type: "string" },
      balance: { type: "number" },
      tags: { type: "array" },
      closedAt: { type: "null" },
      address: { type: "object", fields: { street: { type: "string" } } },
    });

    const gql = JSON.parse(readFileSync(join(r.dir, "getCustomer.shape.json"), "utf8"));
    expect(gql.kind).toBe("graphql");
    expect(gql.graphql.query).toBe('query getCustomer($id: ID!) { getCustomer(id: $id, hint: "") { id email cpr balance } }');
    expect(gql.request.headers["x-apollo-operation-name"]).toBe("getCustomer");
    expect(gql.request.variables).toEqual({ type: "object", fields: { id: { type: "string", format: "numeric" }, token: { type: "string" } } });

    const note = JSON.parse(readFileSync(join(r.dir, "POST-api-notes.shape.json"), "utf8"));
    expect(note.responses).toEqual([]);
    expect(note.request.body.shape).toEqual({ type: "object", fields: { text: { type: "string" }, owner: { type: "string" } } });
  }, 120_000);

  test("--write lets exactly the first write through and records its response shape", async () => {
    writesReceived = [];
    const skill = join(work, "write-skill");
    mkdirSync(join(skill, "captures", "profile-show"), { recursive: true });
    writeFileSync(join(skill, "captures", "profile-show", "stale-op.shape.json"), "{}");
    const r = await capture(skill, ["--script", join(work, "script.ts"), "--write"]);
    expect(r.code, r.stderr).toBe(0);
    assertNoValues(r.everything);
    expect(writesReceived).toEqual(["POST /api/notes"]);
    expect(r.files).not.toContain("stale-op.shape.json");
    const note = JSON.parse(readFileSync(join(r.dir, "POST-api-notes.shape.json"), "utf8"));
    expect(note.aborted).toBe(0);
    expect(note.responses).toEqual([
      {
        status: 201,
        contentType: "application/json",
        headers: expect.objectContaining({ "access-control-allow-origin": null, "content-type": "application/json" }),
        setCookies: ["sid"],
        body: { kind: "json", shape: { type: "object", fields: { note: { type: "object", fields: { id: { type: "string" }, text: { type: "string" } } } } } },
      },
    ]);
    expect(r.out.wrote).toBe("POST /api/notes");
    const add = JSON.parse(readFileSync(join(r.dir, "addNote.shape.json"), "utf8"));
    expect(add.aborted).toBe(1);
  }, 120_000);

  test("read Task on a site that signs in: token and post-login steps go through, other writes do not", async () => {
    writesReceived = [];
    const r = await capture(join(work, "signed-in-skill"), ["--script", join(work, "signed-in.ts")], "/signed-in");
    expect(r.code, JSON.stringify(r.out) + r.stderr).toBe(0);
    assertNoValues(r.everything);
    expect(writesReceived).toEqual([]);
    expect(r.out.operations).toEqual([
      { operation: "GET /signed-in", effect: "read", navigation: true, file: "GET-signed-in.shape.json", aborted: 0 },
      { operation: "POST /oauth/token", effect: "write", loginFlow: true, file: "POST-oauth-token.shape.json", aborted: 0 },
      { operation: "POST /api/session/post-login", effect: "write", loginFlow: true, file: "POST-api-session-post-login.shape.json", aborted: 0 },
      { operation: "signInUser", effect: "write", loginFlow: true, file: "signInUser.shape.json", aborted: 0 },
      { operation: "POST /api/quotes", effect: "write", file: "POST-api-quotes.shape.json", aborted: 1 },
      { operation: "GET /api/customers/:id/profile", effect: "read", file: "GET-api-customers-id-profile.shape.json", aborted: 0 },
    ]);
    const postLogin = JSON.parse(readFileSync(join(r.dir, "POST-api-session-post-login.shape.json"), "utf8"));
    expect(postLogin.responses[0].body.shape.fields.personalInfo.fields).toEqual({
      customerId: { type: "string", format: "numeric" },
      cpr: { type: "string" },
      email: { type: "string" },
    });
    const index = JSON.parse(readFileSync(join(r.dir, "index.json"), "utf8"));
    expect(index.operations.filter((o: { loginFlow?: boolean }) => o.loginFlow).length).toBe(3);
    // postLogin needs the bearer's claim names; the Capture has them, never their values.
    const profile = JSON.parse(readFileSync(join(r.dir, "GET-api-customers-id-profile.shape.json"), "utf8"));
    expect(profile.request.headers.authorization).toBeNull();
  }, 120_000);

  test("--write: writes the page fires while loading, a persisted mutation and a write to another host are aborted; the user's click goes through", async () => {
    writesReceived = [];
    const r = await capture(join(work, "side-effect-skill"), ["--script", join(work, "side-effect.ts"), "--write"], "/side-effect");
    expect(r.code, JSON.stringify(r.out) + r.stderr).toBe(0);
    expect(writesReceived).toEqual(["POST /api/settings"]);
    expect(r.out.wrote).toBe("POST /api/settings");
    const byName = Object.fromEntries((r.out.operations as { operation: string }[]).map((o) => [o.operation, o]));
    expect(byName.createQuote).toMatchObject({ effect: "write", aborted: 1 });
    expect(byName.cancelSubscription).toMatchObject({ effect: "write", effectUnknown: true, aborted: 1 });
    expect(byName["POST /api/settings"]).toMatchObject({ effect: "write", aborted: 0 });
    expect(r.out.blockedElsewhere).toEqual([expect.stringMatching(/^POST localhost\/api\/cart$/)]);
    expect(r.out.hints.join(" ")).toContain("--allow-read");
  }, 120_000);

  test("read Task: a persisted query named with --allow-read goes through; other writes do not", async () => {
    writesReceived = [];
    const r = await capture(join(work, "allow-read-skill"), ["--script", join(work, "loaded.ts"), "--allow-read", "cancelSubscription"], "/side-effect");
    expect(r.code, JSON.stringify(r.out) + r.stderr).toBe(0);
    expect(writesReceived).toEqual(["cancelSubscription"]);
    const op = (r.out.operations as { operation: string }[]).find((o) => o.operation === "cancelSubscription");
    expect(op).toMatchObject({ allowedRead: true, aborted: 0 });
  }, 120_000);

  test("a REST GET with ?query=<word>: one REST Operation, the word in no file, and draft-contract keeps `query` (#33)", async () => {
    const r = await capture(join(work, "search-skill"), ["--script", join(work, "loaded.ts")], "/search");
    expect(r.code, JSON.stringify(r.out) + r.stderr).toBe(0);
    expect(r.everything).not.toContain(SEARCH_WORD);
    expect(r.out.operations.map((o: { operation: string }) => o.operation)).toEqual(["GET /search", "GET /api/search/suppliers"]);
    const kinds = r.files.filter((f) => f.endsWith(".shape.json")).map((f) => JSON.parse(readFileSync(join(r.dir, f), "utf8")).kind);
    expect(kinds).not.toContain("graphql");
    const shape = join(r.dir, "GET-api-search-suppliers.shape.json");
    expect(JSON.parse(readFileSync(shape, "utf8")).request.query.fields).toEqual({ query: { type: "string" }, limit: { type: "string" }, sortBy: { type: "string" } });
    const draft = Bun.spawnSync([process.execPath, join(SKILL_ROOT, "tools", "draft-contract.ts"), shape], { stdout: "pipe", stderr: "pipe" });
    const source = JSON.parse(draft.stdout.toString()).source as string;
    expect(source).toContain('query: (v) => ({ query: v["query"], limit: v["limit"], sortBy: v["sortBy"] })');
    expect(source).toContain("    query: z.string(),");
    expect(source).not.toContain(SEARCH_WORD);
  }, 120_000);

  test("closing the Task window ends the Capture although a popup on another origin is still open (#34)", async () => {
    const r = await capture(join(work, "popup-skill"), ["--script", join(work, "popup.ts")], "/popup");
    expect(r.code, JSON.stringify(r.out) + r.stderr).toBe(0);
    expect(r.out.stoppedBy).toBe("task window closed");
    expect(r.out.closedWindows).toBe(1);
    expect(r.out.operations.map((o: { operation: string }) => o.operation)).toContain("GET /api/customers/:id/profile");
    expect(r.files).toContain("index.json");
  }, 120_000);

  test("SIGTERM is a clean stop that still writes the Capture, with a periodic hint while waiting (#34)", async () => {
    const skill = join(work, "signal-skill");
    mkdirSync(skill, { recursive: true });
    const proc = Bun.spawn(
      [process.execPath, CAPTURE, "--skill-dir", skill, "--task", "profile-show", "--url", `http://127.0.0.1:${server.port}/popup`, "--profile", join(work, "profile"), "--headless"],
      {
        env: { ...process.env, SITE_CLI_CAPTURE_HINT_MS: "300", ...(existsSync(CHROME) ? { SITE_CLI_CHROME: CHROME } : {}) },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90_000,
      },
    );
    const stderrChunks: string[] = [];
    const reader = (async () => {
      const stream = proc.stderr.getReader();
      for (let chunk = await stream.read(); !chunk.done; chunk = await stream.read()) stderrChunks.push(new TextDecoder().decode(chunk.value));
    })();
    const deadline = Date.now() + 60_000;
    while (!stderrChunks.join("").includes("still recording") && Date.now() < deadline) await Bun.sleep(100);
    proc.kill("SIGTERM");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    await reader;
    const stderr = stderrChunks.join("");
    expect(proc.exitCode, stdout + stderr).toBe(0);
    expect(stderr).toContain("still recording: 1 window open");
    expect(stderr).toContain(`kill -INT ${proc.pid}`);
    const out = JSON.parse(stdout);
    expect(out.stoppedBy).toBe("SIGTERM");
    expect(existsSync(join(skill, "captures", "profile-show", "index.json"))).toBe(true);
  }, 120_000);

  test("Next.js: a server action is aborted with an immediate hint and flagged; the RSC stream is marked rsc (#36)", async () => {
    writesReceived = [];
    const r = await capture(join(work, "next-skill"), ["--script", join(work, "loaded.ts")], "/next");
    expect(r.code, JSON.stringify(r.out) + r.stderr).toBe(0);
    expect(writesReceived).toEqual([]);
    expect(r.stderr).toContain("server action aborted (POST /partner/:id): if the page breaks, capture again with --allow-read /partner/:id");
    const byName = Object.fromEntries((r.out.operations as { operation: string }[]).map((o) => [o.operation, o]));
    expect(byName["POST /partner/:id"]).toMatchObject({ effect: "write", effectUnknown: true, serverAction: true, aborted: 1 });
    expect(byName["GET /partner/:id"]).toMatchObject({ effect: "read", rsc: true });
    expect(byName["GET /api/partners/:id"]).not.toHaveProperty("rsc");
    const index = JSON.parse(readFileSync(join(r.dir, "index.json"), "utf8"));
    expect(index.operations.find((o: { operation: string }) => o.operation === "POST /partner/:id")).toMatchObject({ serverAction: true, effectUnknown: true });
    expect(index.operations.find((o: { operation: string }) => o.operation === "GET /partner/:id")).toMatchObject({ rsc: true });
    expect(r.out.hints.join(" ")).toContain("Next.js");
  }, 120_000);

  test("nothing recorded: an error, and the previous Capture is left alone", async () => {
    const skill = join(work, "empty-skill");
    const dir = join(skill, "captures", "profile-show");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kept.shape.json"), "{}");
    const r = await capture(skill, ["--script", join(work, "noop.ts"), "--origin", "https://nothing.example"]);
    expect(r.code).toBe(1);
    expect(r.out.error.message).toContain("no calls to https://nothing.example were recorded");
    expect(r.files).toEqual(["kept.shape.json"]);
  }, 120_000);

  test("a failing --script still writes shapes, then reports the failure as JSON", async () => {
    const r = await capture(join(work, "broken-skill"), ["--script", join(work, "broken.ts")]);
    expect(r.code).toBe(1);
    expect(r.out.error.message).toContain("--script failed: nope");
    expect(r.files).toContain("index.json");
    assertNoValues(r.everything);
  }, 120_000);
});

describe("capture.ts flags", () => {
  test("bad input is a JSON error before Chrome starts", () => {
    const run = (args: string[]) => {
      const p = Bun.spawnSync([process.execPath, CAPTURE, ...args], { stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: JSON.parse(p.stdout.toString()) };
    };
    expect(run(["--task", "x", "--url", "https://a.example"]).out.error.message).toContain("missing --skill-dir");
    expect(run(["--skill-dir", work, "--task", "Bad Task", "--url", "https://a.example"]).out.error.message).toContain("kebab-case");
    expect(run(["--skill-dir", work, "--task", "x", "--url", "nope"]).out.error.message).toContain("--url must be a URL");
    expect(run(["--skill-dir", work, "--task", "x", "--url", "https://a.example", "--script", join(work, "missing.ts")]).code).toBe(1);
    writeFileSync(join(work, "unparsable.ts"), 'export default async (page) => { await page.click("a" b"); };\n');
    const unparsable = run(["--skill-dir", work, "--task", "x", "--url", "https://a.example", "--script", join(work, "unparsable.ts")]);
    expect(unparsable.code).toBe(1);
    expect(unparsable.out.error.message).toMatch(/could not load --script .*unparsable\.ts: .*errors building.*; Expected "\)" but found "b"/);
    expect(run(["--skill-dir", work, "--task", "x", "--url", "https://a.example", "--write-op", "addNote"]).out.error.message).toContain("--write-op needs --write");
  });

  test("--help documents every flag and the --script contract, exit 0", () => {
    const p = Bun.spawnSync([process.execPath, CAPTURE, "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    const out = JSON.parse(p.stdout.toString());
    expect(Object.keys(out.flags)).toEqual(["--skill-dir", "--task", "--url", "--write", "--write-op", "--allow-read", "--script", "--profile", "--headless", "--origin", "--login-host"]);
    expect(out.notes.join(" ")).toContain("export default async (page)");
  });
});
