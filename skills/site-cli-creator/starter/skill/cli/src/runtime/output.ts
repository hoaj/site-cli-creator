// A command's `output` schema: what the command prints, checked against its own result so a
// mapping that stops holding (a renamed field that now prints null or 0) is Drift, not a wrong
// answer. The result is only checked, never replaced: what prints is the command's own value.
import { z } from "zod";
import type { Command } from "./command";
import { ContractError, Failure } from "./envelope";
import { driftFingerprint, unwrap, zodDiff } from "./fingerprint";

type Names = { plugin: string; skill: string };

/**
 * Throws a ContractError when the schema cannot be advertised as JSON Schema (a transform, a date,
 * a custom type): an output schema says what is printed, so it must describe the value as it is.
 * The message is the runtime's own and names no value.
 */
export function assertOutputSchema(command: Pick<Command, "name" | "output">): void {
  if (!command.output) return;
  try {
    z.toJSONSchema(command.output, { io: "output" });
  } catch (e) {
    throw new ContractError(
      `${command.name}: its output schema cannot be written as JSON Schema (${(e as Error).message}). An output schema describes what the command prints, so it takes no transform, date or custom type: print the value the way the schema says, and convert in run().`,
    );
  }
}

/**
 * Checks the value a command is about to print. A failure is Drift of breakType "output": the
 * Fingerprint and `diff` hold field paths and Zod issue codes only, never a value or a Zod message.
 */
export function checkOutput(site: Names, command: Pick<Command, "name" | "output">, value: unknown): void {
  if (!command.output) return;
  assertOutputSchema(command);
  const parsed = command.output.safeParse(value);
  if (parsed.success) return;
  const diff = zodDiff(parsed.error.issues, value, command.output);
  const first = diff[0] ?? { path: "", code: "" };
  throw new Failure("drift", `${command.name}: the output no longer matches the command's output schema at ${first.path || "(root)"} (${first.code}).`, {
    fingerprint: driftFingerprint(site, command.name, "output", first.path, first.code),
    diff,
  });
}

/** What a write command prints without --confirm (main.ts failed()): the schema of that dry run. */
const DRY_RUN_SCHEMA = {
  type: "object",
  properties: { dryRun: { const: true }, would: { type: "object", properties: { operation: { type: "string" }, variables: {} }, required: ["operation"] } },
  required: ["dryRun", "would"],
} as const;

/**
 * The command's output as the JSON Schema of an MCP tool's `outputSchema`, or undefined when there
 * is none or its root is no object (MCP needs `type: "object"`; the result then prints as before).
 * `io: "input"` leaves out `additionalProperties: false`: the printed value may carry keys the
 * schema does not name, and a strict client validates structuredContent against this. A write
 * command may also print its dry run, so its schema admits that too.
 */
export function outputJsonSchema(command: Pick<Command, "name" | "output">, write: boolean): Record<string, unknown> | undefined {
  if (!command.output) return undefined;
  assertOutputSchema(command);
  const { $schema: _, ...json } = z.toJSONSchema(command.output, { io: "input" }) as Record<string, unknown>;
  if (json.type !== "object") return undefined;
  return write ? { type: "object", anyOf: [json, DRY_RUN_SCHEMA] } : json;
}

const KEEPS_SHAPE = ["optional", "nullable", "default", "prefault", "catch", "readonly", "nonoptional", "success"];

/** A schema as a compact shape for `help`: `{id: string, rows: [{name: string|null}]}`. */
export function outputShape(schema: unknown, depth = 0): string {
  if (depth > 12) return "any";
  const def = (schema as { _zod?: { def?: any } } | undefined)?._zod?.def;
  if (!def) return "any";
  const next = (s: unknown) => outputShape(s, depth + 1);
  switch (def.type) {
    case "string": return "string";
    case "number": case "int": return "number";
    case "boolean": return "boolean";
    case "bigint": return "number";
    case "null": return "null";
    case "undefined": case "void": return "undefined";
    case "literal": return (def.values as unknown[]).map((v) => JSON.stringify(v)).join("|");
    case "enum": return Object.values(def.entries).map((v) => JSON.stringify(v)).join("|");
    case "array": return `[${next(def.element)}]`;
    case "tuple": return `[${(def.items as unknown[]).map(next).join(", ")}]`;
    case "record": case "map": return `{[key]: ${next(def.valueType)}}`;
    case "union": return unique((def.options as unknown[]).map(next)).join("|");
    case "intersection": return `${next(def.left)} & ${next(def.right)}`;
    case "optional": return `${next(def.innerType)}|undefined`;
    case "nullable": return `${next(def.innerType)}|null`;
    case "object": {
      const fields = Object.entries(def.shape as Record<string, any>).map(([key, field]) => {
        const optional = field?._zod?.optin === "optional" || field?._zod?.optin === "defaulted";
        return `${key}${optional ? "?" : ""}: ${next(optional ? unwrapOptional(field) : field)}`;
      });
      return `{${fields.join(", ")}}`;
    }
    default:
      return KEEPS_SHAPE.includes(def.type) ? next(def.innerType) : def.type === "pipe" ? next(def.in) : def.type === "lazy" ? next(unwrap(schema)) : "any";
  }
}

/** A key's own schema without the optional wrapper that the `?` already says. */
function unwrapOptional(field: any): unknown {
  const def = field?._zod?.def;
  return def && (def.type === "optional" || def.type === "default") ? def.innerType : field;
}

const unique = (xs: string[]) => [...new Set(xs)];
