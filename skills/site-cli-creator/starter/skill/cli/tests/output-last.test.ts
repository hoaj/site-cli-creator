// Output schemas, review 3 (#96): no site value in an error, a budgeted walk, partial GraphQL success,
// any thrown value after a write, z.success(), refusal before sign-in, root optional.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { mcpServer, mcpTools, run } from "../src/main";
import { defineCommand } from "../src/runtime/command";
import { ContractError } from "../src/runtime/envelope";
import { defineOperation } from "../src/runtime/operation";
import { assertOutputSchema, outputJsonSchema } from "../src/runtime/output";
import { fakeFetch, json, loginSite, makeApp, makeDeps, makeSite, tempHome, type Recorded } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

const err = (o: unknown) => (o as { error: Record<string, any> }).error;
const PREFIX = "The write was sent and the site answered with success, so it may have taken effect. Check on the site before running it again.";

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
  response: z.object({ data: z.object({ addThing: z.object({ id: z.number() }).nullable() }).nullable() }),
});

const appOf = (commands: ReturnType<typeof defineCommand>[], handler: (req: Recorded) => Response = () => json({ ok: true }), operations: any[] = [renameItem, gqlWrite], site = makeSite()) => {
  const f = fakeFetch(handler);
  const d = makeDeps(f.fetch, home.dir);
  return { f, d, app: makeApp(site, d.deps, { commands, operations }) };
};
const quiet = (name: string, output: z.ZodType, result: () => unknown) => defineCommand({ name, summary: "x", args: z.object({}), uses: [], output, run: async () => result() as never });

describe("no site value in an error", () => {
  test("a refinement that throws with the value in its message gives a bug naming the command and the error's name only", async () => {
    const SECRET = "tok_planted_{not-json";
    const schema = z.object({ a: z.string().refine((s) => !!JSON.parse(s)) });
    const { app } = appOf([quiet("item show", schema, () => ({ a: SECRET }))]);
    const r = await run(["item", "show"], app);
    expect(r.code).toBe(1);
    expect(err(r.output).message).toContain("item show");
    expect(err(r.output).message).toContain("SyntaxError");
    expect(err(r.output).message).not.toMatch(/async|promise/i);
    expect(JSON.stringify(r.output)).not.toContain("tok_planted");
    const server = mcpServer(appOf([quiet("item show", schema, () => ({ a: SECRET }))]).app);
    const m: any = ((await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "item_show", arguments: {} } })) as any).result;
    expect(JSON.stringify(m)).not.toContain("tok_planted");
  });
});

describe("what is said about a sent write", () => {
  const writeThen = (then: () => unknown) =>
    defineCommand({ name: "item rename", summary: "x", args: z.object({ name: z.string() }), uses: [renameItem], output: z.object({ ok: z.boolean() }), run: async ({ name }, { call }) => { await call(renameItem, { id: "I1", name }); return then() as never; } });

  test("the prefix claims only a success answer that may have taken effect", async () => {
    const r = await run(["--confirm", "item", "rename", "--name", "N"], appOf([writeThen(() => (undefined as any).boom)]).app);
    expect(err(r.output).writeSent).toBe(true);
    expect(err(r.output).next).toStartWith(PREFIX);
    expect(err(r.output).next).not.toContain("accepted");
  });

  test("any thrown value after the write is marked, a string included, on the CLI and over MCP", async () => {
    const throwsString = writeThen(() => {
      throw "unexpected state";
    });
    const cli = await run(["--confirm", "item", "rename", "--name", "N"], appOf([throwsString]).app);
    expect(cli.code).toBe(1);
    expect(err(cli.output).kind).toBe("bug");
    expect(err(cli.output).writeSent).toBe(true);
    expect(err(cli.output).next).toStartWith(PREFIX);
    const server = mcpServer(appOf([throwsString]).app);
    const m: any = ((await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "item_rename", arguments: { name: "N", confirm: true } } })) as any).result;
    const e = JSON.parse(m.content[0].text).error;
    expect(e.writeSent).toBe(true);
    expect(e.next).toStartWith(PREFIX);
  });
});

describe("GraphQL partial success", () => {
  const gql = defineCommand({
    name: "thing add",
    summary: "x",
    args: z.object({}),
    uses: [gqlWrite],
    output: z.object({ ok: z.string() }),
    run: async (_a, { call }) => {
      await call(gqlWrite, { name: "n" });
      return { ok: true } as never;
    },
  });
  const exec = (body: unknown) => run(["--confirm", "thing", "add"], appOf([gql], () => json(body)).app);

  test("errors next to a data object with a non-null root field: the write may have taken effect", async () => {
    const r = await exec({ data: { addThing: { id: 7 } }, errors: [{ message: "partial", extensions: { code: "SOMETHING" } }] });
    expect(r.code).not.toBe(0);
    expect(err(r.output).writeSent).toBe(true);
  });

  test("errors with data null, or only null root fields, stay unmarked", async () => {
    for (const body of [
      { data: null, errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }] },
      { data: { addThing: null }, errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }] },
    ]) {
      const r = await exec(body);
      expect(r.code).not.toBe(0);
      expect(err(r.output).writeSent).toBeUndefined();
    }
  });
});

describe("a recursive factory cannot hang", () => {
  const make = (): z.ZodType => z.object({ left: z.array(z.lazy(make)), right: z.array(z.lazy(make)) });

  test("assertOutputSchema throws a ContractError naming the command, fast", () => {
    const t = Date.now();
    expect(() => assertOutputSchema({ name: "item show", output: make() })).toThrow(/item show.*(too large|without end)/);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  test("check, a command and mcpTools all finish, the tool is listed without outputSchema", async () => {
    const t = Date.now();
    const cmd = quiet("item show", make(), () => ({ left: [], right: [] }));
    const { app } = appOf([cmd]);
    expect((await run(["check"], app)).code).toBe(1);
    expect((await run(["item", "show"], app)).code).toBe(1);
    expect(outputJsonSchema({ name: "item show", output: make() })).toBeUndefined();
    const tool = mcpTools(app).tools.find((x) => x.name === "item_show")!;
    expect(tool.outputSchema).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(8000);
  });

  test("a normal memoized recursive schema stays valid", () => {
    type Tree = { name: string; children: Tree[] };
    const tree: z.ZodType<Tree> = z.object({ name: z.string().min(1), children: z.array(z.lazy(() => tree)) });
    expect(() => assertOutputSchema({ name: "item show", output: tree })).not.toThrow();
  });
});

describe("small refusals", () => {
  test("z.success() is refused", () => {
    expect(() => assertOutputSchema({ name: "item show", output: z.object({ a: z.success(z.string()) }) })).toThrow(ContractError);
  });

  test("a root optional advertises no outputSchema", () => {
    expect(outputJsonSchema({ name: "item show", output: z.object({ a: z.string() }).optional() })).toBeUndefined();
    expect(outputJsonSchema({ name: "item show", output: z.object({ a: z.string() }) })).toBeDefined();
  });

  test("a bad schema is refused before any sign-in or account step", async () => {
    const bad = quiet("item show", z.object({ a: z.string().trim() }), () => ({ a: "x" }));
    const { app, d, f } = appOf([bad], () => json({}), [], loginSite());
    const r = await run(["item", "show"], app);
    expect(r.code).toBe(1);
    expect(err(r.output).kind).toBe("bug");
    expect(d.loginCalls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });
});
