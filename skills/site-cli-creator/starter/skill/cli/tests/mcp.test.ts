// The `mcp` built-in: the same Task commands as MCP tools over stdio, through main's mcpServer().
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { mcpServer, run } from "../src/main";
import { defineCommand } from "../src/runtime/command";
import { Failure } from "../src/runtime/envelope";
import { serveStdio } from "../src/runtime/mcp";
import { saveSession } from "../src/runtime/session";
import { fakeFetch, happySite, json, loginSite, makeApp, makeDeps, makeSite, tempHome } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

let nextId = 1;
const request = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: nextId++, method, ...(params !== undefined && { params }) });

async function serverFor(site = makeSite(), handler = happySite, logins: Array<Record<string, string> | null> = []) {
  const f = fakeFetch(handler);
  const d = makeDeps(f.fetch, home.dir, logins);
  saveSession(home.dir, { headers: {}, ids: { customerId: "C-1" } });
  const server = mcpServer(makeApp(site, d.deps));
  await server.handle(request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }));
  return { server, ...f, ...d };
}

async function tools(server: ReturnType<typeof mcpServer>) {
  const res: any = await server.handle(request("tools/list"));
  return res.result.tools as any[];
}

async function callTool(server: ReturnType<typeof mcpServer>, name: string, args: Record<string, unknown> = {}) {
  const res: any = await server.handle(request("tools/call", { name, arguments: args }));
  return res.result;
}

const textOf = (result: any) => JSON.parse(result.content[0].text);

describe("initialize", () => {
  test("answers with tools capability, server info and instructions", async () => {
    const server = mcpServer(makeApp(makeSite(), makeDeps(fakeFetch(happySite).fetch, home.dir).deps));
    const res: any = await server.handle(request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    expect(res.jsonrpc).toBe("2.0");
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(res.result.serverInfo).toEqual({ name: "acme-shop", version: "1.2.3" });
    expect(res.result.instructions).toContain("confirm");
    expect(res.result.instructions).not.toContain("readOnlyHint");
    expect(res.result.instructions).toContain("next");
  });

  test("offers its own latest version when the client asks for one it does not know", async () => {
    const server = mcpServer(makeApp(makeSite(), makeDeps(fakeFetch(happySite).fetch, home.dir).deps));
    const res: any = await server.handle(request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    expect(res.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.result.protocolVersion).not.toBe("1999-01-01");
  });

  test("notifications get no answer; ping gets an empty result", async () => {
    const { server } = await serverFor();
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const pong: any = await server.handle(request("ping"));
    expect(pong.result).toEqual({});
  });
});

describe("tools/list", () => {
  test("one tool per Task, named <noun>_<verb>, plus check and doctor", async () => {
    const { server } = await serverFor();
    expect((await tools(server)).map((t) => t.name)).toEqual(["products_show", "order_rename", "crash_now", "check", "doctor"]);
  });

  test("a login skill also lists login", async () => {
    const { server } = await serverFor(loginSite());
    expect((await tools(server)).map((t) => t.name)).toContain("login");
  });

  test("the input schema comes from the command's args; confirm only on writes", async () => {
    const { server } = await serverFor();
    const [show, rename] = await tools(server);
    expect(show.description).toBe("Products on the account");
    expect(show.inputSchema.type).toBe("object");
    expect(show.inputSchema.properties.all).toMatchObject({ type: "boolean", description: "include inactive" });
    expect(show.inputSchema.properties.limit.type).toBe("integer");
    expect(show.inputSchema.properties.account.type).toBe("string");
    expect(show.inputSchema.properties.confirm).toBeUndefined();
    expect(show.inputSchema.required ?? []).not.toContain("all");
    expect(rename.inputSchema.required).toEqual(expect.arrayContaining(["orderId", "name"]));
    expect(rename.inputSchema.properties.confirm.type).toBe("boolean");
  });

  test("annotations follow the Effect of the Operations a Task uses", async () => {
    const { server } = await serverFor();
    const byName = Object.fromEntries((await tools(server)).map((t) => [t.name, t]));
    expect(byName.products_show.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(byName.order_rename.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(byName.check.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe("tools/call", () => {
  test("a read Task returns the command's result as text and structured content", async () => {
    const { server } = await serverFor();
    const result = await callTool(server, "products_show", { all: true });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toEqual({ customer: "Kim Secret", products: [{ id: "P1", status: "active" }, { id: "P2", status: "ended" }] });
    expect(result.structuredContent).toEqual(textOf(result));
  });

  test("the result matches the CLI's for the same Task", async () => {
    const { server, deps } = await serverFor();
    const cli = await run(["products", "show", "--limit", "1"], makeApp(makeSite(), deps));
    expect(textOf(await callTool(server, "products_show", { limit: 1 }))).toEqual(cli.output as object);
  });

  test("a write Task without confirm is a dry run and sends nothing", async () => {
    const { server, calls } = await serverFor();
    const result = await callTool(server, "order_rename", { orderId: "O1", name: "New" });
    expect(textOf(result)).toEqual({ dryRun: true, would: { operation: "PATCH /api/orders/:orderId", variables: { orderId: "O1", name: "New" } } });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  test("confirm: true sends the write", async () => {
    const { server, calls } = await serverFor();
    expect(textOf(await callTool(server, "order_rename", { orderId: "O1", name: "New", confirm: true }))).toEqual({ ok: true });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  test("bad arguments are an input error result, with nothing sent", async () => {
    const { server, calls } = await serverFor();
    const result = await callTool(server, "order_rename", { orderId: "O1" });
    expect(result.isError).toBe(true);
    const { error } = textOf(result);
    expect(error.kind).toBe("input");
    expect(error.message).toContain("name");
    expect(error.next).not.toContain("--");
    expect(calls).toHaveLength(0);
  });

  test("Drift is an error result whose next speaks of tools, not CLI flags", async () => {
    const { server } = await serverFor(makeSite(), (req) =>
      new URL(req.url).pathname === "/graphql" && req.body.operationName === "getCustomer"
        ? json({ data: { getCustomer: { id: "C-1", name: 42 } } })
        : happySite(req),
    );
    const result = await callTool(server, "products_show", {});
    expect(result.isError).toBe(true);
    const { error } = textOf(result);
    expect(error.kind).toBe("drift");
    expect(error.fingerprint).toBe("acme:shop:getCustomer:zod:data.getCustomer.name:invalid_type");
    expect(error.next).toContain("acme-feedback");
    expect(error.next).toContain("https://github.com/acme/acme-plugin/issues");
    expect(JSON.stringify(result)).not.toContain("42");
    expect(result.structuredContent).toEqual(textOf(result));
  });

  test("a crash is a bug result with the bug key", async () => {
    const { server } = await serverFor();
    const { error } = textOf(await callTool(server, "crash_now"));
    expect(error.kind).toBe("bug");
    expect(error.fingerprint).toStartWith("acme:shop:bug:crash-now:TypeError:");
  });

  test("an expired sign-in fails at once with session and points at the login tool, without opening Chrome", async () => {
    const site = loginSite();
    const { server, loginCalls } = await serverFor(site, () => json({}, 401), [null]);
    saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: { customerId: "C-1" } });
    const result = await callTool(server, "products_show", {});
    const { error } = textOf(result);
    expect(error.kind).toBe("session");
    expect(error.next).toContain("login tool");
    expect(error.message).not.toContain("SITE_CLI");
    expect(loginCalls).toEqual([true]);
  });

  test("the login tool opens Chrome headed and saves the session", async () => {
    const { server, loginCalls } = await serverFor(loginSite(), happySite, [{ authorization: "Bearer new" }]);
    const result = await callTool(server, "login");
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatchObject({ loggedIn: true, ids: ["customerId"] });
    expect(loginCalls).toEqual([false]);
  });

  test("with no saved sign-in, a tool fails with session at once and never launches Chrome", async () => {
    const { server, loginCalls } = await serverFor(loginSite(), happySite, [{ authorization: "Bearer x" }]);
    rmSync(join(home.dir, "session.json"));
    const { error } = textOf(await callTool(server, "products_show", {}));
    expect(error.kind).toBe("session");
    expect(error.next).toContain("login tool");
    expect(loginCalls).toEqual([]);
  });

  test("several accounts: the error names the account argument, never the --account flag", async () => {
    const site = makeSite({ accounts: async () => [{ id: "A1", label: "One" }, { id: "A2", label: "Two" }] });
    const { server } = await serverFor(site);
    const { error } = textOf(await callTool(server, "products_show", {}));
    expect(error.kind).toBe("input");
    expect(error.accounts).toHaveLength(2);
    expect(error.message).not.toContain("--account");
    expect(error.message).toContain("account argument");
    const wrong = textOf(await callTool(server, "products_show", { account: "A9" })).error;
    expect(wrong.message).not.toContain("--account");
  });

  test("login does not hold the server: an unfinished sign-in returns signingIn, and other calls are answered", async () => {
    const f = fakeFetch(happySite);
    const d = makeDeps(f.fetch, home.dir);
    const headedCalls: boolean[] = [];
    d.deps.login = async (headless) => {
      headedCalls.push(headless);
      return headless ? null : new Promise(() => {});
    };
    const server = mcpServer(makeApp(loginSite(), d.deps), { loginWaitMs: 5 });
    const first = textOf(await callTool(server, "login"));
    expect(first.signingIn).toBe(true);
    const busy = textOf(await callTool(server, "products_show", {})).error;
    expect(busy.kind).toBe("session");
    expect(busy.next).toContain("Chrome window");
    expect(textOf(await callTool(server, "login")).signingIn).toBe(true);
    expect(headedCalls).toEqual([false]);
    const pong: any = await server.handle(request("ping"));
    expect(pong.result).toEqual({});
  });

  test("a login that fails on its own (no Chrome) tells the user why instead of pointing back at login", async () => {
    const f = fakeFetch(happySite);
    const d = makeDeps(f.fetch, home.dir);
    d.deps.login = async () => {
      throw new Failure("session", "Google Chrome was not found (looked at /nowhere). Install Google Chrome.");
    };
    const server = mcpServer(makeApp(loginSite(), d.deps));
    const { error } = textOf(await callTool(server, "login"));
    expect(error.kind).toBe("session");
    expect(error.message).toContain("Google Chrome was not found");
    expect(error.next).not.toContain("Call the login tool");
    expect(error.next).toContain("Tell the user");
  });

  test("check runs as a tool", async () => {
    const { server } = await serverFor();
    const out = textOf(await callTool(server, "check", { op: "getCustomer" }));
    expect(out.operations).toBeDefined();
  });

  test("an unknown tool is a protocol error", async () => {
    const { server } = await serverFor();
    const res: any = await server.handle(request("tools/call", { name: "nope", arguments: {} }));
    expect(res.error.code).toBe(-32602);
  });
});

describe("protocol errors", () => {
  test("an unknown method is -32601", async () => {
    const { server } = await serverFor();
    const res: any = await server.handle(request("resources/list"));
    expect(res.error.code).toBe(-32601);
  });

  test("a message that is no request is -32600", async () => {
    const { server } = await serverFor();
    const res: any = await server.handle({ hello: 1 });
    expect(res).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
  });
});

describe("over stdio", () => {
  test("`mcp` answers newline-delimited JSON-RPC on stdout and nothing else", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "cli.ts"), "mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SITE_CLI_HOME: home.dir },
    });
    const lines = [
      request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      request("tools/list"),
    ];
    proc.stdin.write("not json\n" + lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const docs = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(docs).toHaveLength(3);
    expect(docs[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(docs[1].result.serverInfo.name).toBe("acme-shop");
    expect(docs[2].result.tools.map((t: any) => t.name)).toContain("big_list");
  });

  test("`mcp` takes no flags, global ones included", async () => {
    const f = fakeFetch(happySite);
    const app = makeApp(makeSite(), makeDeps(f.fetch, home.dir).deps);
    for (const argv of [["mcp", "--x"], ["mcp", "--confirm"], ["mcp", "--account", "A1"]]) {
      const { output, code } = await run(argv, app);
      expect(code, argv.join(" ")).toBe(2);
      expect((output as any).error.kind).toBe("input");
    }
  });

  test("a Task command whose noun is a built-in's name still runs from the CLI", async () => {
    const f = fakeFetch(happySite);
    const mcpList = defineCommand({ name: "mcp list", summary: "The site's MCP feature", args: z.object({}), uses: [], run: async () => ({ listed: true }) });
    const app = makeApp(makeSite(), makeDeps(f.fetch, home.dir).deps);
    const { output, code } = await run(["mcp", "list"], { ...app, commands: [...app.commands, mcpList] });
    expect(code).toBe(0);
    expect(output).toEqual({ listed: true });
  });

  test("serveStdio keeps going when a message makes the server throw, and stops quietly when output closes", async () => {
    const lines: string[] = [];
    const throwing = { handle: async () => { throw new Error("boom"); } } as unknown as ReturnType<typeof mcpServer>;
    const input = (text: string) => new Blob([text]).stream();
    await serveStdio(throwing, input(JSON.stringify(request("tools/list")) + "\n"), async (l) => void lines.push(l));
    expect(JSON.parse(lines[0]!)).toMatchObject({ error: { code: -32603 } });
    const { server } = await serverFor();
    const closed = async () => { throw Object.assign(new Error("EPIPE"), { code: "EPIPE" }); };
    await expect(serveStdio(server, input(JSON.stringify(request("ping")) + "\n" + JSON.stringify(request("ping")) + "\n"), closed)).resolves.toBeUndefined();
  });
});
