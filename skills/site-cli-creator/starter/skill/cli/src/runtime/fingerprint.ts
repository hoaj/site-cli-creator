// Identity of a failure across all users, so the Feedback skill can deduplicate reports.
// Drift:  plugin:skill:operation:breakType:path:code   (array indices written [], record and
//         map keys written {} because they are the site's data, e.g. an email or a phone number;
//         REST params in the operation written {param}, so the only colons are separators:
//         shop:shop:GET /api/invoices/{id}:http::404)
// Bug:    plugin:skill:bug:<command-with-dashes>:<ErrorName>:<frame>
//         <frame> = first stack frame inside src/, as relative/path.ts#function, no line/col.
import type { DiffEntry } from "./envelope";

export type BreakType = "zod" | "graphql" | "http" | "auth" | "input-rejected" | "request" | "trigger" | "html";
type Names = { plugin: string; skill: string };

export function driftFingerprint(site: Names, operation: string, breakType: BreakType, path = "", code = ""): string {
  return [site.plugin, site.skill, operationSegment(operation), breakType, path, code].join(":");
}

/** `GET /api/invoices/:id` → `GET /api/invoices/{id}`; GraphQL names pass through. */
export function operationSegment(operation: string): string {
  return operation.replace(/:([A-Za-z_$][\w$]*)/g, "{$1}");
}

/** Zod 4's internal definition of a schema, or undefined for anything else. */
function defOf(schema: unknown): any {
  return (schema as { _zod?: { def?: unknown } } | null | undefined)?._zod?.def;
}

/** The schema behind wrappers that do not change where a key sits (optional, nullable, default, pipe, lazy…). */
export function unwrap(schema: unknown): unknown {
  for (let i = 0; i < 32; i++) {
    const def = defOf(schema);
    if (!def) return schema;
    if (["optional", "nullable", "default", "prefault", "catch", "readonly", "nonoptional", "success"].includes(def.type)) schema = def.innerType;
    else if (def.type === "pipe") schema = def.in;
    else if (def.type === "lazy") schema = def.getter();
    else return schema;
  }
  return schema;
}

/** The schema at one key, and whether the key is a declared field name (true) or the site's data (false). */
function step(schema: unknown, key: string): { schema: unknown; declared: boolean } {
  const s = unwrap(schema);
  const def = defOf(s);
  if (!def) return { schema: undefined, declared: !isDataKey(key) };
  switch (def.type) {
    case "object":
      return key in def.shape ? { schema: def.shape[key], declared: true } : { schema: def.catchall, declared: false };
    case "record":
    case "map":
      return { schema: def.valueType, declared: false };
    case "union":
      for (const option of def.options ?? []) {
        const hit = step(option, key);
        if (hit.declared) return hit;
      }
      return { schema: undefined, declared: false };
    case "intersection": {
      const left = step(def.left, key);
      return left.declared ? left : step(def.right, key);
    }
    default:
      return { schema: undefined, declared: !isDataKey(key) };
  }
}

/** The schema at one array index. */
function stepIndex(schema: unknown, index: number): unknown {
  const def = defOf(unwrap(schema));
  if (def?.type === "array") return def.element;
  if (def?.type === "tuple") return def.items?.[index] ?? def.rest;
  return undefined;
}

/** Without a schema to tell: a key that is not a plain identifier, or that looks like an id, email, phone or name, is data. */
function isDataKey(key: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) return true;
  return key.length > 48 || key.replace(/\D/g, "").length >= 4;
}

/**
 * `["data","list",0,"status"]` → `data.list[].status`. With the schema the path was checked
 * against, a key that is not a declared field (a z.record or z.map key, an unknown key) is the
 * site's data, such as an email or a phone number, and is written `{}`, like an index is `[]`.
 * Without a schema, keys that do not look like field names are written `{}`.
 */
export function fieldPath(path: readonly PropertyKey[], schema?: unknown): string {
  let out = "";
  let current: unknown = schema;
  for (const seg of path) {
    if (typeof seg === "number") {
      out += "[]";
      current = stepIndex(current, seg);
      continue;
    }
    const key = String(seg);
    const next = schema === undefined ? { schema: undefined, declared: !isDataKey(key) } : step(current, key);
    out += (out ? "." : "") + (next.declared ? key : "{}");
    current = next.schema;
  }
  return out;
}

/** Every schema reachable from `schema`, each seen through its wrappers, at any depth (objects, arrays, tuples, sets, unions, intersections, record values). */
function reachable(schema: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  const walk = (s: unknown, depth: number): void => {
    if (depth > 32 || s === undefined || s === null) return;
    const inner = unwrap(s);
    if (seen.has(inner)) return;
    seen.add(inner);
    out.push(inner);
    const def = defOf(inner);
    if (!def) return;
    const next = (child: unknown) => walk(child, depth + 1);
    switch (def.type) {
      case "object":
        for (const child of Object.values(def.shape ?? {})) next(child);
        next(def.catchall);
        break;
      case "array":
        next(def.element);
        break;
      case "tuple":
        for (const item of def.items ?? []) next(item);
        next(def.rest);
        break;
      case "union":
        for (const option of def.options ?? []) next(option);
        break;
      case "intersection":
        next(def.left);
        next(def.right);
        break;
      case "record":
      case "map":
      case "set":
        next(def.valueType);
        break;
    }
  };
  walk(schema, 0);
  return out;
}

/** Every field name a schema declares, at any depth (through objects, arrays, optional, nullable, default, unions and similar wrappers). */
export function declaredNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  for (const s of reachable(schema)) {
    const def = defOf(s);
    if (def?.type === "object") for (const key of Object.keys(def.shape ?? {})) names.add(key);
  }
  return names;
}

/** A schema with its unions and intersections opened: the object, array and other schemas it can be. */
function alternatives(schema: unknown, depth = 0): unknown[] {
  const s = unwrap(schema);
  const def = defOf(s);
  if (!def || depth > 32) return [];
  if (def.type === "union") return (def.options ?? []).flatMap((o: unknown) => alternatives(o, depth + 1));
  if (def.type === "intersection") return [...alternatives(def.left, depth + 1), ...alternatives(def.right, depth + 1)];
  return [s];
}

/** Whether the names (and `[]` indices) lead from the root, or from any nested object, through declared fields. A record key is site data and stops it. */
function resolves(segs: readonly string[], variables: unknown): boolean {
  let frontier = reachable(variables);
  for (const seg of segs) {
    const next = new Set<unknown>();
    for (const s of frontier) {
      for (const alt of alternatives(s)) {
        const def = defOf(alt);
        if (seg === "[]") {
          if (def?.type === "array") next.add(def.element);
          else if (def?.type === "tuple") for (const item of [...(def.items ?? []), def.rest]) if (item) next.add(item);
        } else if (def?.type === "object" && Object.hasOwn(def.shape ?? {}, seg)) next.add(def.shape[seg]);
      }
    }
    if (next.size === 0) return false;
    frontier = [...next];
  }
  return true;
}

/** `a.b[0].c`, `a.0.c`, or a JSON pointer `/data/attributes/a` → segments: a name, or `[]` for an index. */
function pathSegments(raw: string): string[] {
  if (raw.startsWith("/")) return raw.split("/").slice(1).map((part) => (/^\d+$/.test(part) ? "[]" : part.replace(/~1/g, "/").replace(/~0/g, "~")));
  return [...raw.matchAll(/\[(\d*)\]|([^.[\]]+)/g)].map((m) => (m[2] === undefined || /^\d+$/.test(m[2]) ? "[]" : m[2]));
}

/** Whether a path's names are declared: a bare single name anywhere, everything else by position through the Contract. */
function declaredPath(segs: readonly string[], variables: unknown, declared: ReadonlySet<string>): boolean {
  if (!segs.some((s) => s !== "[]")) return false;
  return segs.length === 1 ? declared.has(segs[0]) : resolves(segs, variables);
}

/** Segments → a Fingerprint path, or "" when there is nothing to report. What is not declared is the site's data and is written `{}`. */
function rejectedPath(segs: readonly string[], variables: unknown, declared: ReadonlySet<string>): string {
  if (!segs.some((s) => s !== "[]")) return "";
  return declaredPath(segs, variables, declared) ? formatPath(segs) : "{}";
}

function formatPath(segs: readonly string[]): string {
  let out = "";
  for (const s of segs) out += s === "[]" ? "[]" : (out ? "." : "") + s;
  return out;
}

/**
 * A JSON:API pointer without its wrapper: `/data[/i]/attributes|relationships/…` (a relationship's trailing `data[/i][/id]` too) and
 * `/data[/i]/id|type` are not in the Contract's variables. The wrapper stays only when the pointer resolves through the variables as it is.
 * `/data` and `/data/<i>` name no field.
 */
function stripJsonApi(segs: string[], variables: unknown): string[] {
  if (segs[0] !== "data" || resolves(segs, variables)) return segs;
  let rest = segs.slice(1);
  if (rest[0] === "[]") rest = rest.slice(1);
  const kind = rest[0];
  if (rest.length === 0) return [];
  if ((kind === "id" || kind === "type") && rest.length === 1) return rest;
  if (kind !== "attributes" && kind !== "relationships") return segs;
  rest = rest.slice(1);
  if (kind === "relationships") {
    const i = rest.indexOf("data");
    if (i > 0) {
      const tail = rest.slice(i + 1).filter((s) => s !== "[]");
      if (tail.length === 0 || (tail.length === 1 && tail[0] === "id")) rest = rest.slice(0, i);
    }
  }
  return rest;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Keys of an error object that are the envelope, not a field. */
const ENVELOPE = new Set(["message", "code", "status", "title", "detail", "type", "error", "formErrors", "fieldErrors", "requestId", "request_id", "traceId", "trace_id", "timestamp", "reason", "errorCode"]);

/** A value that says something: a non-empty string or array, or an object holding something. `""`, `[]`, `{}` and objects of only those name nothing. */
function usable(value: unknown): boolean {
  if (typeof value === "string") return value !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (isPlain(value)) return Object.values(value).some(usable);
  return false;
}

/** `{}` (the site's data) sorts after every named field, so the first entry is a named field whenever there is one. */
const byPath = (a: string, b: string): number => Number(a === "{}") - Number(b === "{}") || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The fields a REST 400/422 body says it rejected, as Fingerprint paths. Never reads a message (it can quote the values sent).
 * When the body does not clearly name a field it names none: blaming a wrong field is worse than naming none.
 * Shapes: `{ errors: { <field>: … } }`, `{ errors: { fieldErrors: { … } } }`, `{ fieldErrors: { … } }`,
 * `{ errors: [{ field | path | source.pointer }] }` (per item, the first of these that gives a path).
 * Rules (SPEC §10): an entry with an empty value names nothing; an `errors` object holding an envelope key (`message`, `code`, …) that
 * `variables` does not declare is an error envelope, where only declared non-envelope keys count; a key that is itself a declared
 * name is used whole (`filter[status]`); a plain-object value is descended (at most 8 levels) to the children that resolve through the
 * variables. A name `variables` does not declare is the site's data and is written `{}`. Sorted with `{}` last and deduped; past `limit`
 * the `{}` entry is kept and the rest is counted in `omitted`.
 */
export function rejectedFields(body: unknown, variables: unknown, limit = 20): { fields: string[]; omitted: number } {
  if (!isPlain(body)) return { fields: [], omitted: 0 };
  const declared = declaredNames(variables);
  const found = new Set<string>();
  const add = (path: string): void => {
    if (path) found.add(path);
  };
  const segsOf = (raw: string): string[] => (declared.has(raw) ? [raw] : pathSegments(raw));
  const descend = (base: readonly string[], value: Record<string, unknown>, depth: number): string[] => {
    const out: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      if (!usable(child)) continue;
      const segs = [...base, ...segsOf(key)];
      if (!resolves(segs, variables)) continue;
      const deeper = isPlain(child) && depth < 8 ? descend(segs, child, depth + 1) : [];
      if (deeper.length > 0) out.push(...deeper);
      else out.push(formatPath(segs));
    }
    return out;
  };
  const fromKeys = (o: unknown, isErrors: boolean): void => {
    if (!isPlain(o)) return;
    const keys = Object.keys(o);
    const envelope = isErrors && keys.some((k) => ENVELOPE.has(k) && !declared.has(k));
    for (const key of keys) {
      const value = o[key];
      if (!usable(value) || (envelope && ENVELOPE.has(key))) continue;
      const segs = segsOf(key);
      const path = rejectedPath(segs, variables, declared);
      if (path === "" || (envelope && path === "{}")) continue;
      const children = path !== "{}" && isPlain(value) ? descend(segs, value, 1) : [];
      if (children.length > 0) for (const c of children) add(c);
      else add(path);
    }
  };
  const errors = body.errors;
  if (isPlain(errors) && isPlain(errors.fieldErrors)) fromKeys(errors.fieldErrors, false);
  else fromKeys(errors, true);
  fromKeys(body.fieldErrors, false);
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (!isPlain(e)) continue;
      const tries: (() => string)[] = [
        () => (typeof e.field === "string" ? rejectedPath(segsOf(e.field), variables, declared) : ""),
        () => {
          if (typeof e.path === "string") {
            const segs = pathSegments(e.path);
            // A route (`/orders/1`) is no field: a leading slash counts only when it resolves through the Contract.
            if (e.path.startsWith("/") && !resolves(segs, variables)) return "";
            return rejectedPath(segs, variables, declared);
          }
          if (Array.isArray(e.path)) {
            const segs = e.path.filter((s): s is string | number => typeof s === "string" || typeof s === "number").map((s) => (typeof s === "number" || /^\d+$/.test(s) ? "[]" : s));
            return rejectedPath(segs, variables, declared);
          }
          return "";
        },
        () => (isPlain(e.source) && typeof e.source.pointer === "string" ? rejectedPath(stripJsonApi(pathSegments(e.source.pointer), variables), variables, declared) : ""),
      ];
      for (const attempt of tries) {
        const path = attempt();
        if (path) {
          add(path);
          break;
        }
      }
    }
  }
  const all = [...found].sort(byPath);
  if (all.length <= limit) return { fields: all, omitted: 0 };
  const named = all.filter((p) => p !== "{}");
  const fields = found.has("{}") ? [...named.slice(0, limit - 1), "{}"] : named.slice(0, limit);
  return { fields, omitted: all.length - fields.length };
}

/** The type name of a value, the only thing about a site's response we ever report. */
export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: any = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[seg as any];
  }
  return cur;
}

type Issue = { code: string; path: readonly PropertyKey[]; expected?: unknown };

/** Zod issues → diff entries without values, one per distinct path + code. Pass the schema so record keys stay out. */
export function zodDiff(issues: readonly Issue[], input: unknown, schema?: unknown, limit = 20): DiffEntry[] {
  const seen = new Set<string>();
  const out: DiffEntry[] = [];
  for (const issue of issues) {
    const path = fieldPath(issue.path, schema);
    const key = `${path}:${issue.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: DiffEntry = { path, code: issue.code };
    if (typeof issue.expected === "string") entry.expected = issue.expected;
    entry.received = typeName(valueAt(input, issue.path));
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

type Frame = { fn: string; file: string; line?: string; col?: string };

// Bun: "    at render (/abs/src/commands/x.ts:1:43)", "    at /abs/src/main.ts:3:17",
// "    at async run (src/main.ts:2:4)". Compiled binaries with a source map print src/ paths.
const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?)(?::(\d+))?(?::(\d+))?\)?\s*$/;

function parseFrames(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    if (!/^\s*at\s/.test(line)) continue;
    const m = FRAME.exec(line);
    if (!m) continue;
    const fn = (m[1] ?? "").replace(/^async\s+/, "").trim();
    frames.push({ fn: fn && fn !== "<anonymous>" ? fn : "anonymous", file: m[2], line: m[3], col: m[4] });
  }
  return frames;
}

/** Path relative to the plugin's src/, or undefined for frames outside it (node_modules, native). */
export function srcRelative(file: string): string | undefined {
  const norm = file.replace(/\\/g, "/");
  if (norm.includes("/node_modules/") || norm.startsWith("node_modules/")) return undefined;
  const m = /(?:^|\/)src\/(?!.*(?:^|\/)src\/)(.+)$/.exec(norm);
  return m ? m[1] : undefined;
}

export function bugFrame(stack: string | undefined): string {
  for (const f of parseFrames(stack ?? "")) {
    const rel = srcRelative(f.file);
    if (rel) return `${rel}#${f.fn}`;
  }
  return "unknown";
}

export function errorName(e: unknown): string {
  if (e instanceof Error) return e.name || e.constructor?.name || "Error";
  return "NonError";
}

export function bugKey(site: Names, command: string, e: unknown): string {
  const stack = e instanceof Error ? e.stack : undefined;
  return [site.plugin, site.skill, "bug", command.trim().replace(/\s+/g, "-") || "unknown", errorName(e), bugFrame(stack)].join(":");
}

/** Frames only, src/-relative, never the error message (it may hold values). */
export function redactStack(e: unknown, limit = 15): string[] {
  const stack = e instanceof Error ? e.stack : undefined;
  const out: string[] = [];
  for (const f of parseFrames(stack ?? "")) {
    const rel = srcRelative(f.file);
    const norm = f.file.replace(/\\/g, "/");
    const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(norm)?.[1];
    if (rel) out.push(`${rel}${f.line ? `:${f.line}` : ""}${f.col ? `:${f.col}` : ""}#${f.fn}`);
    else if (pkg) out.push(`node_modules/${pkg}#${f.fn}`);
    if (out.length >= limit) break;
  }
  return out;
}
