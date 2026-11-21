// A command's `output` schema: what the command prints, checked against its own result so a
// mapping that stops holding (a renamed field that now prints null or 0) is Drift, not a wrong
// answer. The result is only checked, never replaced: what prints is the command's own value.
import { z } from "zod";
import type { Command } from "./command";
import { ContractError, Failure } from "./envelope";
import { driftFingerprint, unwrap, zodDiff } from "./fingerprint";

type Names = { plugin: string; skill: string };

/** What each kind of wrapper holds that may carry a schema: the keys to walk. */
const CHILDREN: Record<string, string[]> = {
  array: ["element"],
  tuple: ["items", "rest"],
  union: ["options"],
  intersection: ["left", "right"],
  record: ["keyType", "valueType"],
  map: ["keyType", "valueType"],
  set: ["valueType"],
  optional: ["innerType"],
  nullable: ["innerType"],
  readonly: ["innerType"],
  nonoptional: ["innerType"],
};

/** The first thing in the schema that changes the value it checks (so the schema would not describe what prints), or undefined. */
function valueChanger(schema: unknown, seen = new Set<unknown>()): string | undefined {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return undefined;
  seen.add(schema);
  const def = (schema as { _zod?: { def?: any } })._zod?.def;
  if (!def) return undefined;
  if (["catch", "default", "prefault", "transform"].includes(def.type)) return `.${def.type}()`;
  if (def.type === "pipe") return "a pipe (.pipe(), .transform() or z.preprocess())";
  if (def.coerce === true) return `z.coerce.${def.type}()`;
  const checks: any[] = def.checks ?? [];
  if (checks.some((c) => c?._zod?.def?.check === "overwrite")) return "an overwrite (.trim(), .toLowerCase() or the like)";
  if (checks.some((c) => c?._zod?.def?.fn?.constructor?.name === "AsyncFunction")) return "an async refinement (the check is synchronous: await in run(), refine on the result)";
  const inner: unknown[] = [];
  if (def.type === "object") inner.push(...Object.values(def.shape ?? {}), def.catchall);
  else if (def.type === "lazy") {
    try {
      inner.push(def.getter());
    } catch {} // a getter that throws: the JSON Schema conversion below reports it
  }
  else for (const key of CHILDREN[def.type] ?? []) inner.push(...[def[key]].flat());
  for (const child of inner) {
    const found = valueChanger(child, seen);
    if (found) return found;
  }
  return undefined;
}

/**
 * Throws a ContractError when the schema would not describe what the command prints: it changes the
 * value (a transform, pipe, preprocess, coerce, default, catch or overwrite such as .trim()), or it
 * cannot be written as JSON Schema (a date, a custom type). Refinements (.min, .positive, .refine)
 * are fine. The message is the runtime's own and names no value.
 */
export function assertOutputSchema(command: Pick<Command, "name" | "output">): void {
  if (!command.output) return;
  const changer = valueChanger(command.output);
  if (changer) {
    throw new ContractError(
      `${command.name}: its output schema uses ${changer}, which changes the value it checks. An output schema describes what the command prints, so conversions and fallbacks belong in run(): print the value the way the schema says. Refinements such as .min(1) and .positive() are fine.`,
    );
  }
  if (isRootNothing(command.output)) return; // prints nothing: a valid output, though not an MCP outputSchema
  for (const io of ["output", "input"] as const) {
    try {
      z.toJSONSchema(command.output, { io });
    } catch (e) {
      throw new ContractError(
        `${command.name}: its output schema cannot be written as JSON Schema (${(e as Error).message}). An output schema describes what the command prints, so it takes no date or custom type: print a string or number, and convert in run().`,
      );
    }
  }
}

/** A root `z.void()` or `z.undefined()`: the command prints nothing. */
const isRootNothing = (schema: unknown) => ["void", "undefined"].includes((schema as { _zod?: { def?: { type?: string } } })._zod?.def?.type ?? "");

/**
 * Checks the value a command is about to print. A failure is Drift of breakType "output": the
 * Fingerprint and `diff` hold field paths and Zod issue codes only, never a value or a Zod message.
 */
export function checkOutput(site: Names, command: Pick<Command, "name" | "output">, value: unknown): void {
  if (!command.output) return;
  assertOutputSchema(command);
  // What is checked is what prints: JSON drops a key whose value is undefined. The value itself still prints as it is.
  let printed = value;
  try {
    printed = JSON.parse(JSON.stringify(value));
  } catch {}
  let parsed: ReturnType<z.ZodType["safeParse"]>;
  try {
    parsed = command.output.safeParse(printed);
  } catch (e) {
    throw new ContractError(`${command.name}: its output schema could not be checked (${(e as Error).message}). A refinement must be synchronous: await in run() instead.`);
  }
  if (parsed.success) return;
  const diff = zodDiff(parsed.error.issues, printed, command.output);
  const first = diff[0] ?? { path: "", code: "" };
  throw new Failure("drift", `${command.name}: the output no longer matches the command's output schema at ${first.path || "(root)"} (${first.code}).`, {
    fingerprint: driftFingerprint(site, command.name, "output", first.path, first.code),
    diff,
  });
}

/**
 * The command's output as the JSON Schema of an MCP tool's `outputSchema`, or undefined when there
 * is none, its root is no object (MCP needs `type: "object"`; the result then prints as before), or
 * it cannot be written (the tool is still listed; calling it reports the bug from checkOutput).
 * `io: "input"` leaves out `additionalProperties: false`: the printed value may carry keys the
 * schema does not name, and a strict client validates structuredContent against this. A write
 * command gets none (main.ts): its dry run is not its output.
 */
export function outputJsonSchema(command: Pick<Command, "name" | "output">): Record<string, unknown> | undefined {
  if (!command.output || isRootNothing(command.output)) return undefined;
  try {
    assertOutputSchema(command);
  } catch (e) {
    if (e instanceof ContractError) return undefined;
    throw e;
  }
  const { $schema: _, ...json } = z.toJSONSchema(command.output, { io: "input" }) as Record<string, unknown>;
  return json.type === "object" ? json : undefined;
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
    case "literal": return (def.values as unknown[]).map((v) => (typeof v === "bigint" ? `${v}n` : JSON.stringify(v))).join("|");
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
