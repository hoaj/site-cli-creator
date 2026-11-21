// A command's `output` schema (#96): checked against the command's result before it is printed, as
// Drift of breakType "output" when it fails, listed by `help` and advertised as MCP outputSchema.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { mcpServer, run } from "../src/main";
import { defineCommand } from "../src/runtime/command";
import { defineOperation } from "../src/runtime/operation";
import { fakeFetch, json, makeApp, makeDeps, makeSite, tempHome, type Recorded } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

// Planted: a value that must never reach an envelope, however the schema fails.
const SECRET = "tok_planted_9f3a7c";

const getItem = defineOperation({
  name: "GET /api/items/:id",
  effect: "read",
  rest: { method: "GET", path: "/api/items/:id" },
  variables: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), total: z.number().optional(), label: z.string().optional(), rows: z.array(z.object({ name: z.string().optional() })).optional() }),
});

const renameItem = defineOperation({
  name: "PATCH /api/items/:id",
  effect: "write",
  rest: { method: "PATCH", path: "/api/items/:id", body: (v) => ({ name: v.name }) },
  variables: z.object({ id: z.string(), name: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

const ITEM = { id: "I1", total: 5, label: "shown", rows: [{ name: "a" }, { name: "b" }] };
let item: Record<string, unknown> = ITEM;
const site = (req: Recorded) => (req.method === "PATCH" ? json({ ok: true }) : json(item));
beforeEach(() => (item = ITEM));

const itemShow = (output: z.ZodType | undefined) =>
  defineCommand({
    name: "item show",
    summary: "One item",
    args: z.object({}),
    uses: [getItem],
    ...(output && { output }),
    // total falls back to 0 and label to null: what a renamed field would print.
    run: async (_a, { call }) => {
      const i = await call(getItem, { id: "I1" });
      return { id: i.id, total: i.total ?? 0, label: i.label ?? null, rows: (i.rows ?? []).map((r) => ({ name: r.name ?? null })), extra: "kept" };
    },
  });

const itemRename = (output: z.ZodType | undefined) =>
  defineCommand({
    name: "item rename",
    summary: "Rename an item",
    args: z.object({ name: z.string() }),
    uses: [renameItem],
    ...(output && { output }),
    run: async ({ name }, { call }) => ({ renamed: (await call(renameItem, { id: "I1", name })).ok, name }),
  });

const itemList = defineCommand({
  name: "item list",
  summary: "Items",
  args: z.object({}),
  uses: [getItem],
  output: z.array(z.object({ id: z.string() })),
  run: async (_a, { call }) => [{ id: (await call(getItem, { id: "I1" })).id, extra: 1 }],
});

const app = (...commands: ReturnType<typeof itemShow>[]) => makeApp(makeSite(), makeDeps(fakeFetch(site).fetch, home.dir).deps, { commands, operations: [getItem, renameItem] });

const SHOW = z.object({
  id: z.string().min(1),
  total: z.number().positive(),
  label: z.string().nullable(),
  rows: z.array(z.object({ name: z.string().nullable() })),
});
const err = (o: unknown) => (o as { error: Record<string, any> }).error;

describe("running a command with an output schema", () => {
  test("a valid result prints unchanged, extra keys included, never Zod's parsed copy", async () => {
    const { output, code } = await run(["item", "show"], app(itemShow(SHOW)));
    expect(code).toBe(0);
    expect(output).toEqual({ id: "I1", total: 5, label: "shown", rows: [{ name: "a" }, { name: "b" }], extra: "kept" });
  });

  test("a command without output behaves as before", async () => {
    item = { id: "I1" }; // total 0, label null: would fail any schema asking for more
    const { output, code } = await run(["item", "show"], app(itemShow(undefined)));
    expect(code).toBe(0);
    expect((output as any).total).toBe(0);
  });

  test("a field that disappeared and a wrong type are output Drift, with the Fingerprint and no value", async () => {
    item = { id: "I1", total: 5, label: SECRET, rows: [{ name: "a" }] };
    const wrong = z.object({ id: z.string(), total: z.number(), label: z.number(), rows: z.array(z.object({ name: z.string() })) });
    const { output, code } = await run(["item", "show"], app(itemShow(wrong)));
    expect(code).toBe(3);
    const e = err(output);
    expect(e.kind).toBe("drift");
    expect(e.fingerprint).toBe("acme:shop:item show:output:label:invalid_type");
    expect(e.diff).toEqual([{ path: "label", code: "invalid_type", expected: "number", received: "string" }]);
    expect(e.next).toContain("Stop");
    expect(JSON.stringify(output)).not.toContain(SECRET);
  });

  test("a missing field gives the path of the field; array indices are written []", async () => {
    item = { id: "I1", total: 5 }; // rows gone: the command prints [] and name null for none
    const schema = z.object({ id: z.string(), total: z.number(), label: z.string().nullable(), rows: z.array(z.object({ name: z.string() })).min(1) });
    const first = err((await run(["item", "show"], app(itemShow(schema)))).output);
    expect(first.fingerprint).toBe("acme:shop:item show:output:rows:too_small");
    item = { id: "I1", total: 5, rows: [{}] };
    const second = err((await run(["item", "show"], app(itemShow(schema)))).output);
    expect(second.fingerprint).toBe("acme:shop:item show:output:rows[].name:invalid_type");
  });

  test("a refinement failure (.positive(), .min(1)) is Drift: the |0 fallback is caught", async () => {
    item = { id: "I1", label: "x", rows: [] }; // total gone, printed as 0
    const { output, code } = await run(["item", "show"], app(itemShow(SHOW)));
    expect(code).toBe(3);
    expect(err(output).fingerprint).toBe("acme:shop:item show:output:total:too_small");
    item = { id: "", total: 1 };
    expect(err((await run(["item", "show"], app(itemShow(SHOW)))).output).fingerprint).toBe("acme:shop:item show:output:id:too_small");
  });

  test("a planted secret in the failing field is in no part of the envelope, whatever the issue", async () => {
    item = { id: SECRET, total: 5, label: SECRET, rows: [{ name: SECRET }] };
    const schemas = [
      z.object({ id: z.number() }),
      z.object({ id: z.string().regex(/^never$/) }),
      z.object({ id: z.literal("never") }),
      z.object({ id: z.enum(["never", "ever"]) }),
      z.strictObject({ id: z.string() }), // unrecognized keys: names the site's keys in Zod's message
      z.object({ id: z.string(), total: z.number(), label: z.string(), rows: z.array(z.object({ name: z.string().max(3, `too long: ${SECRET}`) })) }),
      z.union([z.object({ id: z.number() }), z.object({ id: z.boolean() })]),
    ];
    for (const schema of schemas) {
      const { output, code } = await run(["item", "show"], app(itemShow(schema)));
      expect(code).toBe(3);
      expect(JSON.stringify(output)).not.toContain(SECRET);
      expect(err(output).fingerprint).toStartWith("acme:shop:item show:output:");
    }
  });

  test("a dry run is not validated against output; --confirm validates the real result", async () => {
    const strict = z.object({ renamed: z.literal(true), name: z.string() });
    const dry = await run(["item", "rename", "--name", "N"], app(itemRename(strict)));
    expect(dry.code).toBe(0);
    expect(dry.output).toEqual({ dryRun: true, would: { operation: "PATCH /api/items/:id", variables: { id: "I1", name: "N" } } });
    const sent = await run(["--confirm", "item", "rename", "--name", "N"], app(itemRename(strict)));
    expect(sent.code).toBe(0);
    expect(sent.output).toEqual({ renamed: true, name: "N" });
    const drifted = await run(["--confirm", "item", "rename", "--name", "N"], app(itemRename(z.object({ renamed: z.literal(true), name: z.number() }))));
    expect(err(drifted.output).fingerprint).toBe("acme:shop:item rename:output:name:invalid_type");
  });

  test("an output schema with a transform is refused with a clear message (a bug, exit 1)", async () => {
    const { output, code } = await run(["item", "show"], app(itemShow(z.object({ id: z.string().transform((s) => s.length) }))));
    expect(code).toBe(1);
    expect(err(output).message).toMatch(/item show.*output.*transform/i);
    expect((await run(["help"], app(itemShow(z.object({ id: z.string().transform((s) => s.length) }))))).code).toBe(1);
  });
});

describe("help", () => {
  test("lists each command's output shape compactly; a command without one has none", async () => {
    const { output } = await run(["help"], app(itemShow(SHOW), itemRename(undefined), itemList));
    const cmds = (output as any).commands;
    expect(cmds[0].output).toBe("{id: string, total: number, label: string|null, rows: [{name: string|null}]}");
    expect(cmds[1].output).toBeUndefined();
    expect(cmds[2].output).toBe("[{id: string}]");
  });

  test("<command> --help carries it too", async () => {
    const { output } = await run(["item", "list", "--help"], app(itemList));
    expect((output as any).output).toBe("[{id: string}]");
  });
});

describe("MCP", () => {
  let nextId = 1;
  const call = async (server: ReturnType<typeof mcpServer>, method: string, params?: unknown) => ((await server.handle({ jsonrpc: "2.0", id: nextId++, method, params })) as any).result;
  const listed = async (server: ReturnType<typeof mcpServer>) => Object.fromEntries(((await call(server, "tools/list")).tools as any[]).map((t) => [t.name, t]));
  const text = (r: any) => JSON.parse(r.content[0].text);

  test("tools/list carries outputSchema for an object output, without additionalProperties: false, and omits it for an array output or none", async () => {
    const tools = await listed(mcpServer(app(itemShow(SHOW), itemList, itemRename(undefined))));
    const s = tools.item_show.outputSchema;
    expect(s.type).toBe("object");
    expect(Object.keys(s.properties)).toEqual(["id", "total", "label", "rows"]);
    expect(s.properties.id.minLength).toBe(1);
    expect(JSON.stringify(s)).not.toContain("additionalProperties");
    expect("outputSchema" in tools.item_list).toBe(false);
    expect("outputSchema" in tools.item_rename).toBe(false);
  });

  test("structuredContent validates against the advertised schema with extra keys present", async () => {
    const server = mcpServer(app(itemShow(SHOW)));
    const tool = (await listed(server)).item_show;
    const r = await call(server, "tools/call", { name: "item_show", arguments: {} });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.extra).toBe("kept");
    expect(r.structuredContent).toEqual(text(r));
    const check = z.fromJSONSchema(tool.outputSchema);
    expect(check.safeParse(r.structuredContent).success).toBe(true);
    expect(check.safeParse({ ...r.structuredContent, total: "5" }).success).toBe(false);
  });

  test("a failure is an error result with no structuredContent, and the same Drift as the CLI", async () => {
    item = { id: "I1", label: SECRET, rows: [] };
    const server = mcpServer(app(itemShow(SHOW)));
    const r = await call(server, "tools/call", { name: "item_show", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(text(r).error.kind).toBe("drift");
    expect(text(r).error.fingerprint).toBe("acme:shop:item show:output:total:too_small");
    expect(text(r).error.next).toContain("MCP server");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  test("a write's dry run is not validated, and its schema admits it so strict clients accept the result", async () => {
    const server = mcpServer(app(itemRename(z.object({ renamed: z.literal(true), name: z.string() }))));
    const tool = (await listed(server)).item_rename;
    const check = z.fromJSONSchema(tool.outputSchema);
    const dry = await call(server, "tools/call", { name: "item_rename", arguments: { name: "N" } });
    expect(dry.isError).toBeUndefined();
    expect(text(dry).dryRun).toBe(true);
    expect(check.safeParse(dry.structuredContent).success).toBe(true);
    const sent = await call(server, "tools/call", { name: "item_rename", arguments: { name: "N", confirm: true } });
    expect(sent.structuredContent).toEqual({ renamed: true, name: "N" });
    expect(check.safeParse(sent.structuredContent).success).toBe(true);
  });

  test("a tool without an output schema keeps its structuredContent as before", async () => {
    const r = await call(mcpServer(app(itemShow(undefined))), "tools/call", { name: "item_show", arguments: {} });
    expect(r.structuredContent).toEqual(text(r));
  });
});
