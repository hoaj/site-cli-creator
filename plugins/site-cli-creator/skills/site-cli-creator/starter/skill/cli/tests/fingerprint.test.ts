import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { bugFrame, bugKey, driftFingerprint, fieldPath, operationSegment, redactStack, srcRelative, typeName, zodDiff } from "../src/runtime/fingerprint";

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
