// Edge cases of a command's `output` schema (#96, review 2): refused before anything is sent, async
// refinements, a command that prints nothing, what actually prints, help, and writeSent.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { mcpServer, run } from "../src/main";
import { defineCommand } from "../src/runtime/command";
import { ContractError } from "../src/runtime/envelope";
import { toolResult } from "../src/runtime/mcp";
import { defineOperation } from "../src/runtime/operation";
import { assertOutputSchema, checkOutput, outputJsonSchema, outputShape } from "../src/runtime/output";
import { fakeFetch, json, makeApp, makeDeps, makeSite, tempHome, type Recorded } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

const ITEM = { id: "I1", total: 5 };
const site = (req: Recorded) => (req.method === "PATCH" ? json({ ok: true }) : json(ITEM));
const err = (o: unknown) => (o as { error: Record<string, any> }).error;
const NAMES = { plugin: "acme", skill: "shop" };

const getItem = defineOperation({
  name: "GET /api/items/:id",
  effect: "read",
  rest: { method: "GET", path: "/api/items/:id" },
  variables: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), total: z.number().optional() }),
});
const renameItem = defineOperation({
  name: "PATCH /api/items/:id",
  effect: "write",
  rest: { method: "PATCH", path: "/api/items/:id", body: (v) => ({ name: v.name }) },
  variables: z.object({ id: z.string(), name: z.string() }),
  response: z.object({ ok: z.boolean() }),
});
const gqlWrite = defineOperation({
  name: "addThing",
  effect: "write",
  graphql: "mutation addThing($name: String!) { addThing(name: $name) { id } }",
  variables: z.object({ name: z.string() }),
  response: z.object({ data: z.object({ addThing: z.object({ id: z.string() }) }) }),
});

const appOf = (commands: ReturnType<typeof defineCommand>[], handler: (req: Recorded) => Response = site, operations: any[] = [getItem, renameItem]) => {
  const f = fakeFetch(handler);
  return { f, app: makeApp(makeSite(), makeDeps(f.fetch, home.dir).deps, { commands, operations }) };
};

const rename = (output: z.ZodType) =>
  defineCommand({
    name: "item rename",
    summary: "Rename",
    args: z.object({ name: z.string() }),
    uses: [renameItem],
    output,
    run: async ({ name }, { call }) => ({ renamed: (await call(renameItem, { id: "I1", name })).ok, name }),
  });

const quiet = (name: string, output: z.ZodType, result: () => unknown) => defineCommand({ name, summary: "x", args: z.object({}), uses: [], output, run: async () => result() as never });

describe("a bad schema is refused before anything is sent", () => {
  test("a write with a value-changing output schema sends nothing and ends as the bug envelope", async () => {
    const { f, app } = appOf([rename(z.object({ renamed: z.boolean(), name: z.string().trim() }))]);
    const { output, code } = await run(["--confirm", "item", "rename", "--name", "N"], app);
    expect(code).toBe(1);
    expect(err(output).kind).toBe("bug");
    expect(err(output).message).toContain("item rename");
    expect(f.calls).toHaveLength(0);
  });

  test("a root default is refused before the undefined skip is computed", async () => {
    const { app } = appOf([quiet("item none", z.object({ a: z.string() }).default({ a: "x" }), () => undefined)]);
    const { output, code } = await run(["item", "none"], app);
    expect(code).toBe(1);
    expect(err(output).kind).toBe("bug");
  });
});

describe("async refinements and promises", () => {
  test("assertOutputSchema refuses an async refinement, at a field or the object", () => {
    for (const schema of [z.object({ a: z.string().refine(async () => true) }), z.object({ a: z.string() }).refine(async () => true)]) {
      expect(() => assertOutputSchema({ name: "item show", output: schema })).toThrow(ContractError);
    }
  });

  test("a sync function that returns a promise is a ContractError naming the command, not a raw throw", async () => {
    const schema = z.object({ a: z.string().refine((): any => Promise.resolve(true)) });
    expect(() => checkOutput(NAMES, { name: "item show", output: schema }, { a: "x" })).toThrow(ContractError);
    expect(() => checkOutput(NAMES, { name: "item show", output: schema }, { a: "x" })).toThrow(/item show/);
    const { app } = appOf([quiet("item show", schema, () => ({ a: "x" }))]);
    const r = await run(["item", "show"], app);
    expect(r.code).toBe(1);
    expect(err(r.output).message).toContain("item show");
  });
});

describe("a command that prints nothing", () => {
  test("a root z.void() or z.undefined() is valid, in check, run and MCP; nested ones stay refused", async () => {
    for (const output of [z.void(), z.undefined()]) {
      expect(() => assertOutputSchema({ name: "item none", output })).not.toThrow();
      expect(outputJsonSchema({ name: "item none", output })).toBeUndefined();
      const { app } = appOf([quiet("item none", output, () => undefined)], site, []);
      expect((await run(["check"], app)).code).toBe(0);
      expect((await run(["item", "none"], app)).code).toBe(0);
      const listed: any = await mcpServer(app).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect("outputSchema" in listed.result.tools.find((t: any) => t.name === "item_none")).toBe(false);
    }
    expect(() => assertOutputSchema({ name: "item none", output: z.object({ a: z.undefined() }) })).toThrow(ContractError);
  });
});

describe("what is checked is what prints", () => {
  const unknownField = () => quiet("item show", z.object({ a: z.unknown() }), () => ({ a: undefined }));

  test("a key whose value is undefined is missing when printed: output Drift at that key", async () => {
    const r = await run(["item", "show"], appOf([unknownField()]).app);
    expect(r.code).toBe(3);
    expect(err(r.output).fingerprint).toBe("acme:shop:item show:output:a:invalid_type");
  });

  test("through MCP: an error result, never structuredContent", async () => {
    const r: any = ((await mcpServer(appOf([unknownField()]).app).handle({ jsonrpc: "2.0", id: 93, method: "tools/call", params: { name: "item_show", arguments: {} } })) as any).result;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });

  test("a value JSON.stringify cannot serialize is checked as it is", () => {
    const circular: any = {};
    circular.self = circular;
    expect(() => checkOutput(NAMES, { name: "item show", output: z.object({ self: z.unknown() }) }, circular)).not.toThrow();
  });
});

describe("help never breaks on a shape", () => {
  test("a BigInt literal is written 1n", () => {
    expect(outputShape(z.object({ n: z.literal(1n) }))).toBe("{n: 1n}");
  });

  test("a shape that throws renders as any and help still answers", async () => {
    const boom = z.object({
      x: z.lazy(() => {
        throw new Error("boom");
      }),
    });
    const r = await run(["help"], appOf([quiet("item show", boom, () => ({}))]).app);
    expect(r.code).toBe(0);
    expect((r.output as any).commands[0].output).toBe("any");
  });
});

describe("writeSent covers every failure after an accepted write", () => {
  const PREFIX = "The write was sent and the site accepted it, so do not run it again.";
  const writeThen = (then: (call: any) => Promise<unknown>) =>
    defineCommand({
      name: "item rename",
      summary: "x",
      args: z.object({ name: z.string() }),
      uses: [renameItem, getItem],
      output: z.object({ ok: z.boolean() }),
      run: async ({ name }, { call }) => {
        await call(renameItem, { id: "I1", name });
        return then(call) as never;
      },
    });
  const exec = (handler: (req: Recorded) => Response, cmd: ReturnType<typeof writeThen>) => run(["--confirm", "item", "rename", "--name", "N"], appOf([cmd], handler).app);

  test("a later read that fails with a network error", async () => {
    const { output, code } = await exec((req) => (req.method === "PATCH" ? json({ ok: true }) : json({ message: "down" }, 503)), writeThen((call) => call(getItem, { id: "I1" })));
    expect(code).toBe(5);
    expect(err(output).writeSent).toBe(true);
    expect(err(output).next).toStartWith(PREFIX);
  });

  test("a TypeError in run after the write is a bug that says so", async () => {
    const { output, code } = await exec(site, writeThen(async () => (undefined as any).boom));
    expect(code).toBe(1);
    expect(err(output).kind).toBe("bug");
    expect(err(output).writeSent).toBe(true);
    expect(err(output).next).toStartWith(PREFIX);
  });

  test("a 2xx write whose answer fails its Contract", async () => {
    const { output, code } = await exec((req) => (req.method === "PATCH" ? json({ ok: "nope" }) : json(ITEM)), writeThen(async () => ({ ok: true })));
    expect(code).toBe(3);
    expect(err(output).fingerprint).toStartWith("acme:shop:PATCH /api/items/{id}:zod");
    expect(err(output).writeSent).toBe(true);
    expect(err(output).next).toStartWith(PREFIX);
  });

  test("through MCP, for a non-drift kind too", async () => {
    const server = mcpServer(appOf([writeThen(async () => (undefined as any).boom)]).app);
    const r: any = ((await server.handle({ jsonrpc: "2.0", id: 94, method: "tools/call", params: { name: "item_rename", arguments: { name: "N", confirm: true } } })) as any).result;
    const e = JSON.parse(r.content[0].text).error;
    expect(e.writeSent).toBe(true);
    expect(e.next).toStartWith(PREFIX);
  });

  test("a 400 write was not accepted, a GraphQL 200 with errors was not, a GraphQL 200 without errors was, and a dry run is never marked", async () => {
    const rejected = await exec((req) => (req.method === "PATCH" ? json({ message: "no" }, 400) : json(ITEM)), writeThen(async () => ({ ok: true })));
    expect(err(rejected.output).kind).toBe("drift");
    expect(err(rejected.output).writeSent).toBeUndefined();
    const gql = defineCommand({
      name: "thing add",
      summary: "x",
      args: z.object({}),
      uses: [gqlWrite],
      output: z.object({ ok: z.boolean() }),
      run: async (_a, { call }) => {
        await call(gqlWrite, { name: "n" });
        return { ok: true };
      },
    });
    const gqlApp = (body: unknown) => appOf([gql], () => json(body), [gqlWrite]).app;
    const withErrors = await run(["--confirm", "thing", "add"], gqlApp({ data: null, errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }] }));
    expect(withErrors.code).not.toBe(0);
    expect(err(withErrors.output).writeSent).toBeUndefined();
    const accepted = await run(["--confirm", "thing", "add"], gqlApp({ data: { addThing: { id: 7 } } }));
    expect(err(accepted.output).fingerprint).toContain(":zod:");
    expect(err(accepted.output).writeSent).toBe(true);
    const dry = await run(["item", "rename", "--name", "N"], appOf([writeThen(async () => ({ ok: true }))]).app);
    expect(dry.code).toBe(0);
    expect((dry.output as any).dryRun).toBe(true);
  });
});

describe("structuredContent", () => {
  test("a tool with an outputSchema never sends it for an output that did not pass", () => {
    expect(toolResult({ a: 1 }, 0, { outputSchema: {} }, false).structuredContent).toBeUndefined();
    expect(toolResult({ a: 1 }, 0, { outputSchema: {} }, true).structuredContent).toEqual({ a: 1 });
    expect(toolResult({ a: 1 }, 0).structuredContent).toEqual({ a: 1 });
  });
});
