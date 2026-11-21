// A command's `output` schema (#96): checked against the command's result before it is printed, as
// Drift of breakType "output" when it fails, listed by `help` and advertised as MCP outputSchema.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { mcpServer, run } from "../src/main";
import { defineCommand } from "../src/runtime/command";
import { ContractError } from "../src/runtime/envelope";
import { assertOutputSchema } from "../src/runtime/output";
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

  test("an output schema with a transform is refused with a clear message (a bug, exit 1) when its command runs", async () => {
    const { output, code } = await run(["item", "show"], app(itemShow(z.object({ id: z.string().transform((s) => s.length) }))));
    expect(code).toBe(1);
    expect(err(output).message).toMatch(/item show.*output.*transform|item show.*output.*conver/i);
  });

  test("a result of undefined is skipped when the schema accepts undefined, else checked as the printed null", async () => {
    const none = (output: z.ZodType) => defineCommand({ name: "item none", summary: "x", args: z.object({}), uses: [], output, run: async () => undefined });
    const ok = await run(["item", "none"], makeApp(makeSite(), makeDeps(fakeFetch(site).fetch, home.dir).deps, { commands: [none(z.undefined())] }));
    expect(ok.code).toBe(0);
    const bad = await run(["item", "none"], makeApp(makeSite(), makeDeps(fakeFetch(site).fetch, home.dir).deps, { commands: [none(z.object({ a: z.string() }))] }));
    expect(bad.code).toBe(3);
    expect(err(bad.output).fingerprint).toBe("acme:shop:item none:output::invalid_type");
  });
});

describe("one bad schema does not break the rest of the CLI", () => {
  const bad = z.object({ id: z.string().transform((s) => s.length) });

  test("help, <command> --help and the other commands work; only the broken command fails, as a bug naming it", async () => {
    const a = () => app(itemShow(bad), itemList);
    const help = await run(["help"], a());
    expect(help.code).toBe(0);
    expect((help.output as any).commands[1].output).toBe("[{id: string}]");
    expect((await run(["item", "list", "--help"], a())).code).toBe(0);
    expect((await run(["version"], a())).code).toBe(0);
    expect((await run(["item", "list"], a())).code).toBe(0);
    const broken = await run(["item", "show"], a());
    expect(broken.code).toBe(1);
    expect(err(broken.output).message).toContain("item show");
  });

  test("check refuses it before any Operation runs, so authoring catches it", async () => {
    const f = fakeFetch(site);
    const r = await run(["check"], makeApp(makeSite(), makeDeps(f.fetch, home.dir).deps, { commands: [itemShow(bad)], operations: [getItem] }));
    expect(r.code).toBe(1);
    expect(err(r.output).message).toContain("item show");
    expect(f.calls).toHaveLength(0);
  });
});

describe("a write that was sent is never reported as if it failed", () => {
  const drifting = () => itemRename(z.object({ renamed: z.literal(true), name: z.number() }));

  test("CLI: output Drift after a sent write carries writeSent and a next that says not to run it again", async () => {
    const f = fakeFetch(site);
    const a = makeApp(makeSite(), makeDeps(f.fetch, home.dir).deps, { commands: [drifting()], operations: [getItem, renameItem] });
    const { output, code } = await run(["--confirm", "item", "rename", "--name", "N"], a);
    expect(code).toBe(3);
    expect(err(output).writeSent).toBe(true);
    expect(err(output).fingerprint).toBe("acme:shop:item rename:output:name:invalid_type");
    expect(err(output).next).toMatch(/^The write was sent and the site answered with success, so it may have taken effect\. Check on the site before running it again\./);
    expect(err(output).next).toContain("Check on the site");
    expect(f.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  test("a read's output Drift has no writeSent, and neither has a dry run", async () => {
    item = { id: "I1" };
    expect(err((await run(["item", "show"], app(itemShow(SHOW)))).output).writeSent).toBeUndefined();
  });

  test("MCP: the same, with a tool-worded next", async () => {
    const server = mcpServer(app(drifting()));
    const r: any = ((await server.handle({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "item_rename", arguments: { name: "N", confirm: true } } })) as any).result;
    expect(r.isError).toBe(true);
    const e = JSON.parse(r.content[0].text).error;
    expect(e.kind).toBe("drift");
    expect(e.writeSent).toBe(true);
    expect(e.next).toMatch(/^The write was sent and the site answered with success, so it may have taken effect\. Check on the site before running it again\./);
    expect(e.next).toContain("MCP server");
  });
});

describe("schemas that would change the value are refused", () => {
  const refused: [string, z.ZodType][] = [
    ["catch", z.object({ a: z.string().catch("x") })],
    ["default", z.object({ a: z.string().default("x") })],
    ["prefault", z.object({ a: z.string().prefault("x") })],
    ["transform", z.object({ a: z.string().transform((s) => s.length) })],
    ["preprocess", z.object({ a: z.preprocess((x) => x, z.string()) })],
    ["pipe", z.object({ a: z.string().pipe(z.string()) })],
    ["coerce number", z.object({ a: z.coerce.number() })],
    ["coerce string", z.object({ a: z.coerce.string() })],
    ["coerce boolean", z.object({ a: z.coerce.boolean() })],
    ["trim (overwrite)", z.object({ a: z.string().trim() })],
    ["toLowerCase (overwrite)", z.object({ a: z.string().toLowerCase() })],
    ["in an array", z.array(z.object({ a: z.string().default("x") }))],
    ["in a tuple item", z.tuple([z.string().catch("x")])],
    ["in a tuple rest", z.tuple([z.string()], z.string().catch("x"))],
    ["in a union", z.union([z.string(), z.object({ a: z.string().default("x") })])],
    ["in an intersection", z.intersection(z.object({ a: z.string() }), z.object({ b: z.string().default("x") }))],
    ["in a record", z.record(z.string(), z.string().default("x"))],
    ["in a map", z.map(z.string(), z.string().default("x"))],
    ["in a set", z.set(z.string().trim())],
    ["in a catchall", z.object({ a: z.string() }).catchall(z.string().default("x"))],
    ["under optional", z.object({ a: z.string().default("x").optional() })],
    ["under nullable", z.object({ a: z.string().trim().nullable() })],
    ["under readonly", z.object({ a: z.string().trim().readonly() })],
    ["under nonoptional", z.object({ a: z.string().trim().optional().pipe(z.string()).nonoptional() })],
    ["under lazy", z.object({ a: z.lazy(() => z.string().default("x")) })],
  ];
  for (const [name, schema] of refused) {
    test(`${name}`, () => {
      expect(() => assertOutputSchema({ name: "item show", output: schema })).toThrow(ContractError);
      expect(() => assertOutputSchema({ name: "item show", output: schema })).toThrow(/item show/);
    });
  }

  test("refinements and plain wrappers stay allowed, and a recursive schema terminates", () => {
    type Tree = { name: string; children: Tree[] };
    const tree: z.ZodType<Tree> = z.object({ name: z.string().min(1), children: z.array(z.lazy(() => tree)) });
    for (const schema of [SHOW, z.object({ a: z.number().positive(), b: z.string().refine((s) => s !== "x"), c: z.string().nullable().optional() }), tree]) {
      expect(() => assertOutputSchema({ name: "item show", output: schema })).not.toThrow();
    }
  });

  test("the message says conversions and fallbacks belong in run()", () => {
    expect(() => assertOutputSchema({ name: "item show", output: z.object({ a: z.string().default("x") }) })).toThrow(/run\(\)/);
  });
});

describe("a schema that cannot be written as JSON Schema does not crash the server", () => {
  const broken: [string, z.ZodType][] = [
    ["date piped to any", z.date().pipe(z.any())],
    ["custom piped to a string", z.custom(() => true).pipe(z.string())],
    ["a date", z.object({ when: z.date() })],
    ["a custom type", z.object({ x: z.custom(() => true) })],
  ];
  for (const [name, schema] of broken) {
    test(`${name}: mcp starts, the tool has no outputSchema, calling it is the bug envelope`, async () => {
      const server = mcpServer(app(itemShow(schema)));
      const res: any = await server.handle({ jsonrpc: "2.0", id: 91, method: "tools/list" });
      const tool = res.result.tools.find((t: any) => t.name === "item_show");
      expect(tool).toBeDefined();
      expect("outputSchema" in tool).toBe(false);
      const r: any = ((await server.handle({ jsonrpc: "2.0", id: 92, method: "tools/call", params: { name: "item_show", arguments: {} } })) as any).result;
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text).error.kind).toBe("bug");
    });
  }
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

  test("a write tool advertises no outputSchema: its dry run and result are sent as before, the result still checked", async () => {
    const server = mcpServer(app(itemRename(z.object({ renamed: z.literal(true), name: z.string() }))));
    expect("outputSchema" in (await listed(server)).item_rename).toBe(false);
    const dry = await call(server, "tools/call", { name: "item_rename", arguments: { name: "N" } });
    expect(dry.isError).toBeUndefined();
    expect(text(dry).dryRun).toBe(true);
    expect(dry.structuredContent).toEqual(text(dry));
    const sent = await call(server, "tools/call", { name: "item_rename", arguments: { name: "N", confirm: true } });
    expect(sent.structuredContent).toEqual({ renamed: true, name: "N" });
  });

  test("a tool without an output schema keeps its structuredContent as before", async () => {
    const r = await call(mcpServer(app(itemShow(undefined))), "tools/call", { name: "item_show", arguments: {} });
    expect(r.structuredContent).toEqual(text(r));
  });
});
