import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { bugFrame, bugKey, declaredNames, driftFingerprint, rejectedFields, fieldPath, operationSegment, redactStack, srcRelative, typeName, zodDiff } from "../src/runtime/fingerprint";

const site = { plugin: "yousee", skill: "yousee" };

describe("drift Fingerprint", () => {
  test("plugin:skill:operation:breakType:path:code with [] indices", () => {
    expect(driftFingerprint(site, "listFtpdProducts", "zod", fieldPath(["data", "listFtpdProducts", 3, "status"]), "invalid_type")).toBe(
      "yousee:yousee:listFtpdProducts:zod:data.listFtpdProducts[].status:invalid_type",
    );
  });

  test("REST params are written {param}, so the only colons are separators", () => {
    expect(driftFingerprint({ plugin: "shop", skill: "shop" }, "GET /api/invoices/:id", "http", "", "404")).toBe("shop:shop:GET /api/invoices/{id}:http::404");
    expect(operationSegment("PATCH /api/customers/:customerId/notes/:noteId")).toBe("PATCH /api/customers/{customerId}/notes/{noteId}");
    expect(operationSegment("listFtpdProducts")).toBe("listFtpdProducts");
    expect(driftFingerprint(site, "GET /api/a/:id/b", "zod", "x", "invalid_type").split(":")).toHaveLength(6);
  });

  test("empty path and code stay as empty segments", () => {
    expect(driftFingerprint(site, "op", "http", "", "404")).toBe("yousee:yousee:op:http::404");
    expect(driftFingerprint(site, "op", "trigger")).toBe("yousee:yousee:op:trigger::");
  });

  test("fieldPath handles leading, nested and root indices", () => {
    expect(fieldPath([])).toBe("");
    expect(fieldPath([0, "id"])).toBe("[].id");
    expect(fieldPath(["a", 1, 2, "b"])).toBe("a[][].b");
  });

  test("zodDiff reports type names, dedups rows, never values", () => {
    const schema = z.object({ data: z.object({ list: z.array(z.object({ status: z.string(), kind: z.enum(["a", "b"]) })) }) });
    const input = { data: { list: [{ status: { secret: "CPR-1234" }, kind: "zz-secret" }, { status: 5, kind: "a" }] } };
    const diff = zodDiff(schema.safeParse(input).error!.issues, input);
    expect(diff).toEqual([
      { path: "data.list[].status", code: "invalid_type", expected: "string", received: "object" },
      { path: "data.list[].kind", code: "invalid_value", received: "string" },
    ]);
    expect(JSON.stringify(diff)).not.toContain("secret");
  });

  test("typeName", () => {
    expect([null, [], {}, "", 1, true, undefined].map(typeName)).toEqual(["null", "array", "object", "string", "number", "boolean", "undefined"]);
  });
});

describe("bug key", () => {
  const stack = [
    "TypeError: undefined is not an object (evaluating 'p.price.value')",
    "    at map (native:1:11)",
    "    at parse (/Users/x/plugin/skills/s/cli/node_modules/zod/src/v4/core/parse.ts:10:3)",
    "    at async render (/Users/x/src/plugin/skills/s/cli/src/commands/subscription-show.ts:12:5)",
    "    at run (/Users/x/src/plugin/skills/s/cli/src/main.ts:80:7)",
  ].join("\n");

  test("first frame inside src/, relative, no line or column", () => {
    expect(bugFrame(stack)).toBe("commands/subscription-show.ts#render");
  });

  test("source-mapped binary frames (src/… relative) and Windows paths", () => {
    expect(bugFrame("E\n    at render (src/commands/a-b.ts:1:43)")).toBe("commands/a-b.ts#render");
    expect(bugFrame("E\n    at C:\\p\\cli\\src\\runtime\\call.ts:3:1")).toBe("runtime/call.ts#anonymous");
    expect(bugFrame("E\n    at x (/$bunfs/root/shop:1:1)")).toBe("unknown");
  });

  test("format plugin:skill:bug:<command-with-dashes>:<ErrorName>:<frame>", () => {
    const e = new TypeError("boom 12345");
    e.stack = stack;
    expect(bugKey(site, "subscription show", e)).toBe("yousee:yousee:bug:subscription-show:TypeError:commands/subscription-show.ts#render");
    expect(bugKey(site, "check", "a string")).toBe("yousee:yousee:bug:check:NonError:unknown");
  });

  test("a real error thrown inside src/ is keyed to its function", () => {
    let caught: unknown;
    try {
      fieldPath(null as any);
    } catch (e) {
      caught = e;
    }
    expect(bugKey(site, "x y", caught)).toBe("yousee:yousee:bug:x-y:TypeError:runtime/fingerprint.ts#fieldPath");
  });

  test("redacted stack: src/ frames with positions, packages by name, no message", () => {
    const e = new Error("secret value 999");
    e.stack = stack;
    const out = redactStack(e);
    expect(out).toEqual(["node_modules/zod#parse", "commands/subscription-show.ts:12:5#render", "main.ts:80:7#run"]);
    expect(JSON.stringify(out)).not.toContain("999");
  });

  test("srcRelative ignores node_modules and uses the last src/", () => {
    expect(srcRelative("/a/src/b/src/main.ts")).toBe("main.ts");
    expect(srcRelative("/a/node_modules/x/src/y.ts")).toBeUndefined();
  });
});

describe("record keys are the site's data", () => {
  const { z } = require("zod") as typeof import("zod");
  const schema = z.object({
    byNumber: z.record(z.string(), z.object({ status: z.string() })),
    data: z.object({ people: z.record(z.string(), z.object({ age: z.number() })).optional() }),
    tags: z.map(z.string(), z.number()),
  });

  test("a z.record or z.map key is written {}, like an index is []", () => {
    const body = { byNumber: { "+4522334455": { status: 1 } }, data: { people: { "jane.doe@example.com": { age: "secret-41" } } }, tags: new Map() };
    const diff = zodDiff(schema.safeParse(body).error!.issues, body, schema);
    expect(diff.map((d) => d.path)).toEqual(["byNumber.{}.status", "data.people.{}.age"]);
    const text = JSON.stringify(diff);
    for (const v of ["4522334455", "jane.doe", "example.com", "secret-41"]) expect(text).not.toContain(v);
  });

  test("declared keys stay, through optional, nullable, unions and arrays", () => {
    const s = z.object({ list: z.array(z.union([z.object({ a: z.string() }), z.object({ b: z.number() })])).nullable() });
    expect(fieldPath(["list", 3, "b"], s)).toBe("list[].b");
    expect(fieldPath(["list", 0, "zz"], s)).toBe("list[].{}");
    expect(fieldPath(["$type", "$values", 0], z.object({ $type: z.object({ $values: z.array(z.string()) }) }))).toBe("$type.$values[]");
  });

  test("without a schema, keys that do not look like field names are written {}", () => {
    expect(fieldPath(["data", "jens.hansen@example.dk", "x"])).toBe("data.{}.x");
    expect(fieldPath(["byId", "99812345", "ok"])).toBe("byId.{}.ok");
    expect(fieldPath(["data", "listFtpdProducts", 0, "status"])).toBe("data.listFtpdProducts[].status");
  });
});

describe("declaredNames", () => {
  test("collects names at any depth through wrappers, unions and arrays", () => {
    const schema = z.object({ a: z.string().optional(), b: z.array(z.object({ c: z.number().nullable() })), d: z.union([z.object({ e: z.string() }), z.object({ f: z.string() })]).default({ e: "x" }), g: z.record(z.string(), z.object({ h: z.string() })) });
    expect([...declaredNames(schema)].sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(declaredNames(undefined).size).toBe(0);
  });
});

describe("rejectedFields", () => {
  const flat = z.object({ orderId: z.string(), name: z.string() });
  const fields = (body: unknown, schema: unknown = flat) => rejectedFields(body, schema).fields;

  test("a wrapped fieldErrors (a flattened Zod error) is read, not the wrapper's keys", () => {
    expect(fields({ errors: { formErrors: ["bad"], fieldErrors: { name: ["Kim Secret is too short"] } } })).toEqual(["name"]);
  });

  test("only keys whose value is a string, array or object count; envelope keys only when declared", () => {
    expect(fields({ errors: { name: 5, orderId: true, other: null } })).toEqual([]);
    expect(fields({ errors: { message: "x", code: "E1", status: 400, title: "t", detail: "d", type: "t", error: "e" } })).toEqual([]);
    expect(fields({ errors: { title: "x", name: "y" } })).toEqual(["name"]);
    expect(fields({ errors: { message: "can't be blank" } }, z.object({ message: z.string() }))).toEqual(["message"]);
  });

  test("all-digit segments are indices, in dotted strings and in array paths", () => {
    const lines = z.object({ lines: z.array(z.object({ sku: z.string() })) });
    expect(fields({ errors: [{ field: "lines.0.sku" }] }, lines)).toEqual(["lines[].sku"]);
    expect(fields({ errors: [{ path: ["lines", "0", "sku"] }] }, lines)).toEqual(["lines[].sku"]);
    expect(fields({ errors: [{ path: ["lines", 12, "sku"] }] }, lines)).toEqual(["lines[].sku"]);
    expect(fields({ errors: { "lines.3.sku": "x" } }, lines)).toEqual(["lines[].sku"]);
  });

  test("JSON:API pointers lose their wrapper unless data is declared", () => {
    const v = z.object({ name: z.string(), customer: z.string() });
    expect(fields({ errors: [{ source: { pointer: "/data/attributes/name" } }] }, v)).toEqual(["name"]);
    expect(fields({ errors: [{ source: { pointer: "/data/0/attributes/name" } }] }, v)).toEqual(["name"]);
    expect(fields({ errors: [{ source: { pointer: "/data/relationships/customer/data/id" } }] }, v)).toEqual(["customer"]);
    expect(fields({ errors: [{ source: { pointer: "/data/relationships/customer/data" } }] }, v)).toEqual(["customer"]);
    expect(fields({ errors: [{ source: { pointer: "/data/relationships/customer/data/0/id" } }] }, v)).toEqual(["customer"]);
    expect(fields({ errors: [{ source: { pointer: "/data/attributes/nobody@example.test" } }] }, v)).toEqual(["{}"]);
  });

  test("a route in path is no field", () => {
    expect(fields({ errors: [{ path: "/api/orders/123" }] })).toEqual([]);
    expect(fields({ errors: [{ path: "/name" }] })).toEqual(["name"]);
  });

  test("per item the first source that gives a path wins", () => {
    expect(fields({ errors: [{ field: 5, path: ["name"] }] })).toEqual(["name"]);
    expect(fields({ errors: [{ path: "/api/x", source: { pointer: "/data/attributes/name" } }] })).toEqual(["name"]);
    expect(fields({ errors: [{ field: "nobody@example.test", path: "name" }] })).toEqual(["{}"]);
  });

  test("a single name matches at any depth; several names must resolve by position", () => {
    const nested = z.object({ fields: z.object({ assignee: z.object({ id: z.string() }) }) });
    expect(fields({ errors: { assignee: "x" } }, nested)).toEqual(["assignee"]);
    expect(fields({ errors: { "assignee.id": "x" } }, nested)).toEqual(["assignee.id"]);
    expect(fields({ errors: { "fields.assignee.id": "x" } }, nested)).toEqual(["fields.assignee.id"]);
    const parts = z.object({ shipping: z.object({ name: z.string() }), billing: z.object({ street: z.string() }) });
    expect(fields({ errors: { "billing.name": "x" } }, parts)).toEqual(["{}"]);
    expect(fields({ errors: { "shipping.name": "x" } }, parts)).toEqual(["shipping.name"]);
    expect(fields({ errors: { name: "x" } }, parts)).toEqual(["name"]);
  });

  test("a record key is site data, through unions and wrappers too", () => {
    const v = z.object({ byId: z.record(z.string(), z.object({ qty: z.number() })), pick: z.union([z.object({ a: z.object({ b: z.string() }) }), z.string()]).optional() });
    expect(fields({ errors: { "byId.99812345.qty": "x" } }, v)).toEqual(["{}"]);
    expect(fields({ errors: { "pick.a.b": "x" } }, v)).toEqual(["pick.a.b"]);
  });

  test("past the cap {} is kept and the rest is counted", () => {
    const names = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    const schema = z.object(Object.fromEntries(names.map((n) => [n, z.string()])));
    const errors = Object.fromEntries(names.map((n) => [n, "x"]));
    const plain = rejectedFields({ errors }, schema);
    expect(plain.fields).toHaveLength(20);
    expect(plain.omitted).toBe(5);
    const withData = rejectedFields({ errors: { ...errors, "kim@example.test": "x" } }, schema);
    expect(withData.fields).toHaveLength(20);
    expect(withData.fields).toContain("{}");
    expect(withData.omitted).toBe(6);
  });
});

describe("rejectedFields, review 2", () => {
  const flat = z.object({ orderId: z.string(), name: z.string() });
  const nameOnly = z.object({ name: z.string() });
  const typed = z.object({ type: z.string(), name: z.string() });
  const both = z.object({ title: z.string(), message: z.string() });
  const withMessage = z.object({ message: z.string(), name: z.string() });
  const metaData = z.object({ name: z.string(), meta: z.object({ data: z.string() }) });
  const dotted = z.object({ "filter[status]": z.string(), "page.size": z.number() });
  const addr = z.object({ address: z.object({ street: z.string(), zip: z.string() }), name: z.string() });
  const orders = z.object({ orders: z.string() });
  const rec = z.object({ byId: z.record(z.string(), z.string()) });
  const ids = z.object({ id: z.string(), type: z.string(), name: z.string() });
  const letters = z.object({ "ønske": z.string(), name: z.string() });
  const rel = z.object({ customer: z.string() });

  const cases: [string, unknown, unknown, string[]][] = [
    // 1. empty values name nothing
    ["empty string, array, object", { errors: { name: "", orderId: [], other: {}, deep: { a: "", b: [] } } }, flat, []],
    ["an empty entry next to a real one", { errors: { address: [], name: ["invalid"] } }, flat, ["name"]],
    ["empty fieldErrors entries", { fieldErrors: { name: [], orderId: "" } }, flat, []],
    ["wrapped formErrors empty, fieldErrors set", { errors: { formErrors: [], fieldErrors: { name: ["x"] } } }, flat, ["name"]],
    // 2. envelope mode
    ["declared type with message undeclared is an envelope", { errors: { type: "validation_error", message: "Bad" } }, typed, []],
    ["message and requestId", { errors: { message: "Bad", requestId: "x" } }, flat, []],
    ["a declared message is a field, not an envelope", { errors: { message: "Bad", name: "x" } }, withMessage, ["message", "name"]],
    ["envelope with a declared field, message undeclared", { errors: { message: "Bad", name: "x" } }, nameOnly, ["name"]],
    ["both envelope keys declared", { errors: { title: "blank", message: "blank" } }, both, ["message", "title"]],
    ["new envelope keys", { errors: { traceId: "t", trace_id: "t", request_id: "r", timestamp: "now", reason: "r", errorCode: "E", name: "x" } }, nameOnly, ["name"]],
    ["an envelope drops undeclared keys too", { errors: { message: "Bad", "kim@example.test": "x" } }, flat, []],
    ["fieldErrors keys are fields, envelope or not", { fieldErrors: { message: ["x"], name: ["y"] } }, nameOnly, ["name", "{}"]],
    // 3. only a bare single name matches at any depth
    ["a route that is not in the Contract", { errors: [{ path: "/orders/123" }] }, orders, []],
    ["a record key", { errors: { "byId.99812345": "x" } }, rec, ["{}"]],
    ["a name plus an index on a string", { errors: [{ path: ["name", 0] }] }, flat, ["{}"]],
    // 4. JSON:API resource pointers
    ["/data", { errors: [{ source: { pointer: "/data" } }] }, ids, []],
    ["/data/0", { errors: [{ source: { pointer: "/data/0" } }] }, ids, []],
    ["/data/id", { errors: [{ source: { pointer: "/data/id" } }] }, ids, ["id"]],
    ["/data/0/type", { errors: [{ source: { pointer: "/data/0/type" } }] }, ids, ["type"]],
    ["/data/id undeclared", { errors: [{ source: { pointer: "/data/id" } }] }, nameOnly, ["{}"]],
    ["relationship", { errors: [{ source: { pointer: "/data/relationships/customer/data/id" } }] }, rel, ["customer"]],
    // 5. the data guard resolves by position
    ["data declared deeper does not keep the wrapper", { errors: [{ source: { pointer: "/data/attributes/name" } }] }, metaData, ["name"]],
    ["data declared at the root keeps it", { errors: [{ source: { pointer: "/data/name" } }] }, z.object({ data: z.object({ name: z.string() }) }), ["data.name"]],
    // 6. declared names with dots or brackets
    ["a declared name with brackets", { errors: { "filter[status]": ["x"] } }, dotted, ["filter[status]"]],
    ["a declared name with a dot", { fieldErrors: { "page.size": ["x"] } }, dotted, ["page.size"]],
    ["a declared field string with a dot", { errors: [{ field: "page.size" }] }, dotted, ["page.size"]],
    // 7. {} sorts last
    ["{} after a non-ASCII name", { errors: { "ønske": "x", "kim@example.test": "y" } }, letters, ["ønske", "{}"]],
    ["{} last among ASCII names", { errors: { zed: "x", "kim@example.test": "y", name: "z" } }, z.object({ zed: z.string(), name: z.string() }), ["name", "zed", "{}"]],
    // 8. nested field errors
    ["children of a declared object", { errors: { address: { street: ["bad"], zip: ["bad"] } } }, addr, ["address.street", "address.zip"]],
    ["no child resolves: keep the parent", { errors: { name: { message: "x", kind: "y" } } }, flat, ["name"]],
    ["an undeclared parent is not descended", { errors: { "kim@example.test": { street: ["bad"] } } }, addr, ["{}"]],
    ["some children resolve", { errors: { address: { street: ["bad"], other: ["bad"] } } }, addr, ["address.street"]],
  ];

  for (const [label, body, schema, expected] of cases) {
    test(label, () => {
      const out = rejectedFields(body, schema);
      expect(out.fields).toEqual(expected);
      expect(out.omitted).toBe(0);
      // Nothing but declared names and {} may come out: planted values and undeclared keys never do.
      const text = JSON.stringify(out);
      for (const planted of ["Bad", "kim@example.test", "validation_error", "99812345", "invalid", "bad"]) expect(text).not.toContain(planted);
    });
  }

  test("the cap keeps {} last", () => {
    const names = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    const schema = z.object(Object.fromEntries(names.map((n) => [n, z.string()])));
    const out = rejectedFields({ errors: { ...Object.fromEntries(names.map((n) => [n, "x"])), "kim@example.test": "x" } }, schema);
    expect(out.fields).toHaveLength(20);
    expect(out.fields[19]).toBe("{}");
    expect(out.fields[0]).toBe("f00");
  });

  test("nesting is followed at most 8 levels", () => {
    let schema: z.ZodType = z.string();
    for (let i = 0; i < 12; i++) schema = z.object({ n: schema });
    let body: unknown = ["bad"];
    for (let i = 0; i < 12; i++) body = { n: body };
    const out = rejectedFields({ errors: body }, schema);
    expect(out.fields).toHaveLength(1);
    expect(out.fields[0].split(".").length).toBeLessThanOrEqual(9);
  });
});

describe("rejectedFields, review 3", () => {
  const flat = z.object({ name: z.string() });
  const nameOf = (body: unknown, schema: unknown = flat) => rejectedFields(body, schema).fields;

  test("a recursive lazy schema neither hangs nor loses fields", () => {
    const node: z.ZodType = z.lazy(() => z.object({ field: z.string(), left: node.optional(), right: node.optional() }));
    const filter: z.ZodType = z.lazy(() => z.object({ and: z.array(filter).optional(), or: z.array(filter).optional(), not: filter.optional(), column: z.string().optional() }));
    const started = performance.now();
    expect(nameOf({ errors: { field: "x", "left.right.field": "y", "left.left.left.left.nobody@example.test": "z" } }, node)).toEqual(["field", "left.right.field", "{}"]);
    expect(nameOf({ errors: { column: "x", "and.0.or.1.not.column": "y" } }, filter)).toEqual(["and[].or[].not.column", "column"]);
    expect(declaredNames(node).size).toBe(3);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a schema with endless distinct lazies is cut off by the budget", () => {
    const endless = (n: number): z.ZodType => z.lazy(() => z.object({ name: z.string(), a: endless(n + 1), b: endless(n + 1) }));
    // lazy() makes a fresh object per call when its getter builds one, but _zod.innerType is memoized per lazy: the tree is still infinite.
    const started = performance.now();
    expect(nameOf({ errors: { name: "x", "a.b.a.b.a.b.name": "y" } }, endless(0)).length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a nested per-field error object is the parent's, not a set of children", () => {
    const customer = z.object({ customer: z.object({ name: z.string() }) });
    expect(nameOf({ errors: { customer: { name: "ValidatorError", message: "Path `name` is required.", kind: "required", path: "customer" } } }, customer)).toEqual(["customer"]);
    const address = z.object({ address: z.object({ code: z.string(), street: z.string(), zip: z.string() }) });
    expect(nameOf({ errors: { address: { code: "required", message: "bad" } } }, address)).toEqual(["address"]);
    expect(nameOf({ errors: { address: { street: ["bad"], zip: ["bad"] } } }, address)).toEqual(["address.street", "address.zip"]);
  });

  test("a string path keeps a declared name whole", () => {
    const dotted = z.object({ "filter[status]": z.string(), "page.size": z.number() });
    expect(nameOf({ errors: [{ path: "filter[status]" }] }, dotted)).toEqual(["filter[status]"]);
    expect(nameOf({ errors: [{ path: "page.size" }] }, dotted)).toEqual(["page.size"]);
  });

  test("arrays of nothing name nothing", () => {
    expect(nameOf({ errors: { lines: [{}, {}], name: ["bad"] } })).toEqual(["name"]);
    expect(nameOf({ errors: { name: [""] } })).toEqual([]);
    expect(nameOf({ errors: { name: [null] } })).toEqual([]);
    expect(nameOf({ errors: { name: [[], {}] } })).toEqual([]);
  });

  test("z.preprocess is seen through, and zodDiff paths still hold", () => {
    const pre = z.preprocess((v) => v, z.object({ name: z.string() }));
    expect(nameOf({ errors: { name: "x", "kim@example.test": "y" } }, pre)).toEqual(["name", "{}"]);
    expect(declaredNames(pre).has("name")).toBe(true);
    expect(fieldPath(["name"], pre)).toBe("name");
    expect(fieldPath(["kim@example.test"], pre)).toBe("{}");
    const parsed = pre.safeParse({ name: 1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(zodDiff(parsed.error.issues, { name: 1 }, pre).map((d) => d.path)).toEqual(["name"]);
    // A transform after a schema still follows the schema before it.
    const post = z.object({ name: z.string() }).transform((v) => v);
    expect(fieldPath(["name"], post)).toBe("name");
  });

  test("a pointer with an empty segment names nothing", () => {
    const v = z.object({ name: z.string(), data: z.string() });
    for (const pointer of ["/", "/data/", "/data/attributes/", "//name", "/data//name"]) expect(nameOf({ errors: [{ source: { pointer } }] }, v)).toEqual([]);
  });

  test("a relationship named data", () => {
    expect(nameOf({ errors: [{ source: { pointer: "/data/relationships/data/data/id" } }] }, z.object({ data: z.string() }))).toEqual(["data"]);
    expect(nameOf({ errors: [{ source: { pointer: "/data/relationships/data/data" } }] }, z.object({ data: z.string() }))).toEqual(["data"]);
  });

  test("a body nested 200,000 deep names nothing and does not throw", () => {
    let body: unknown = "bad";
    for (let i = 0; i < 200_000; i++) body = { name: body };
    expect(nameOf({ errors: body })).toEqual([]);
    expect(nameOf({ errors: { name: body } })).toEqual([]);
    let arr: unknown = "bad";
    for (let i = 0; i < 200_000; i++) arr = [arr];
    expect(nameOf({ errors: { name: arr } })).toEqual([]);
  });
});
