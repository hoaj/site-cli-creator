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

/** Every field name a schema declares, at any depth (objects, arrays, tuples, sets, unions, intersections, record values, and the wrappers `unwrap` sees through). */
export function declaredNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (s: unknown, depth: number): void => {
    if (depth > 32 || s === undefined || s === null) return;
    const inner = unwrap(s);
    if (seen.has(inner)) return;
    seen.add(inner);
    const def = defOf(inner);
    if (!def) return;
    const next = (child: unknown) => walk(child, depth + 1);
    switch (def.type) {
      case "object":
        for (const [key, child] of Object.entries(def.shape ?? {})) {
          names.add(key);
          next(child);
        }
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
  return names;
}

/** `a.b[0].c` or a JSON pointer `/data/attributes/a` → segments: a name, or `[]` for an index. */
function pathSegments(raw: string): string[] {
  if (raw.startsWith("/")) return raw.split("/").slice(1).map((part) => (/^\d+$/.test(part) ? "[]" : part.replace(/~1/g, "/").replace(/~0/g, "~")));
  return [...raw.matchAll(/\[(\d*)\]|([^.[\]]+)/g)].map((m) => (m[2] === undefined ? "[]" : m[2]));
}

/**
 * Segments → a Fingerprint path. Every named segment must be declared, else the whole path is `{}` (it may be the site's data).
 * A JSON:API pointer's leading `data`/`attributes`/`relationships` wrap the Contract's variables and are dropped when not declared.
 */
function rejectedPath(segments: readonly (string | number)[], declared: ReadonlySet<string>, pointer = false): string {
  let segs = segments.map((s) => (typeof s === "number" ? "[]" : s));
  if (pointer) while (segs.length > 1 && ["data", "attributes", "relationships"].includes(segs[0]) && !declared.has(segs[0])) segs = segs.slice(1);
  if (segs.every((s) => s === "[]")) return "";
  if (!segs.every((s) => s === "[]" || declared.has(s))) return "{}";
  let out = "";
  for (const s of segs) out += s === "[]" ? "[]" : (out ? "." : "") + s;
  return out;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The fields a REST 400/422 body says it rejected, as Fingerprint paths. Never reads a message (it can quote the values sent).
 * Shapes: `{ errors: { <field>: … } }`, `{ fieldErrors: { <field>: … } }`, `{ errors: [{ field | path | source.pointer }] }`.
 * A named segment that `variables` does not declare is the site's data: the path is written `{}`. Sorted, deduped, at most `limit`.
 */
export function rejectedFields(body: unknown, variables: unknown, limit = 20): string[] {
  if (!isPlain(body)) return [];
  const declared = declaredNames(variables);
  const found = new Set<string>();
  const add = (path: string): void => {
    if (path) found.add(path);
  };
  for (const o of [body.errors, body.fieldErrors]) if (isPlain(o)) for (const key of Object.keys(o)) add(rejectedPath(pathSegments(key), declared));
  if (Array.isArray(body.errors)) {
    for (const e of body.errors) {
      if (!isPlain(e)) continue;
      if (typeof e.field === "string") add(rejectedPath(pathSegments(e.field), declared));
      else if (typeof e.path === "string") add(rejectedPath(pathSegments(e.path), declared));
      else if (Array.isArray(e.path)) add(rejectedPath(e.path.filter((s): s is string | number => typeof s === "string" || typeof s === "number"), declared));
      else if (isPlain(e.source) && typeof e.source.pointer === "string") add(rejectedPath(pathSegments(e.source.pointer), declared, true));
    }
  }
  return [...found].sort().slice(0, limit);
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
