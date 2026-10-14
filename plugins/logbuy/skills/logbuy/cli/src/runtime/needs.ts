// What `check` needs to call a read Operation (SPEC §10): the kinds of `needs` entry, and the
// Operations it can never call whatever the account holds. Pure; the generator's regen.ts imports
// this file too, so `check` and regen give the same warning.
import type { Need } from "./operation";

export const isSessionNeed = (n: object): n is { from: "session"; key: string } => "key" in n;
export const isConstantNeed = (n: object): n is { value: unknown } => "value" in n && !("from" in n);
/** A need on another Operation's result (the chain). */
export const isPickNeed = (n: object): n is { from: string; pick(result: any): unknown } => "pick" in n;

const NO_ENTRY_FIX = 'Give each a `needs` entry: { from: "session", key }, { from: "<operation>", pick }, or a constant { value: <json> } that fits the variable\'s schema.';
const MISFIT_FIX = 'Change each constant to fit the variable\'s schema (a REST query variable drafted as z.string() takes { value: "1" }, not { value: 1 }).';

type Issue = { expected?: unknown };
type FieldSchema = { safeParse(value: unknown): { success: boolean; error?: { issues: Issue[] } } };

export type NeverCheckable = { why: string; fix: string };

/**
 * Why a read Operation's variables can never be built from its `needs`, whatever the account
 * holds, and what fixes it: a required variable (its schema rejects `undefined`) with no `needs`
 * entry, or a constant that its variable's schema rejects. Undefined when neither applies, or when
 * the variables are no z.object. A failure from a picked or session value depends on the
 * account's data, which another account may supply, so it is no reason here.
 */
export function neverCheckable(op: { variables?: unknown; needs?: unknown }): NeverCheckable | undefined {
  const shape = (op.variables as { shape?: Record<string, FieldSchema> } | undefined)?.shape;
  if (!shape || typeof shape !== "object") return undefined;
  const needs = typeof op.needs === "object" && op.needs !== null ? (op.needs as Record<string, Need>) : {};
  const fields = Object.entries(shape).filter(([, field]) => typeof field?.safeParse === "function");
  const missing = fields.filter(([key, field]) => !(key in needs) && !field.safeParse(undefined).success).map(([key]) => key);
  const misfits = fields.flatMap(([key, field]) => {
    const need = needs[key];
    if (!need || typeof need !== "object" || !isConstantNeed(need)) return [];
    const parsed = field.safeParse(need.value);
    if (parsed.success) return [];
    const types = [...new Set((parsed.error?.issues ?? []).map((i) => i.expected).filter((t): t is string => typeof t === "string"))];
    return [`the needs entry for ${key} does not fit variables${types.length ? ` (expected ${types.join(" or ")})` : ""}`];
  });
  const why = [...(missing.length ? [`no needs entry for ${missing.join(", ")}`] : []), ...misfits];
  const fix = [...(missing.length ? [NO_ENTRY_FIX] : []), ...(misfits.length ? [MISFIT_FIX] : [])];
  return why.length ? { why: why.join("; "), fix: fix.join(" ") } : undefined;
}

/** The warning `check` and regen.ts print for an Operation `check` can never call. */
export function neverCheckedWarning(name: string, never: NeverCheckable): string {
  return `${name} is never checked: ${never.why}. ${never.fix}`;
}
