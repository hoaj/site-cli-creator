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
