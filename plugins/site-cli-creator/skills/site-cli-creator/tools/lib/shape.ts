// Shapes describe JSON by type only. Nothing in a Shape is ever taken from a
// value: strings become {type:"string"}, and object keys that look like data
// (ids, emails, numbers) collapse into a "record" so they can't leak either.

export type Shape =
  | { type: "string" | "number" | "boolean" | "null" }
  | { type: "array"; items?: Shape }
  | { type: "object"; fields: Record<string, Shape>; optional?: string[] }
  | { type: "record"; values?: Shape }
  | { type: "union"; anyOf: Shape[] };

const MAX_DEPTH = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z_$][\w$.:-]*$/;

function digitCount(s: string): number {
  return s.replace(/\D/g, "").length;
}

/** A URL path segment that carries data rather than naming a resource. */
export function isIdLike(segment: string): boolean {
  if (segment === "") return false;
  if (/^\d+$/.test(segment) || UUID.test(segment) || segment.includes("@")) return true;
  if (/^[0-9a-f]{12,}$/i.test(segment)) return true;
  if (digitCount(segment) >= 4) return true;
  if (segment.length >= 16 && /\d/.test(segment)) return true;
  if (segment.length >= 24 && /^[\w-]+=*$/.test(segment)) return true; // base64url tokens
  return /[^\w.~-]/.test(segment); // spaces, plus signs, commas: free text
}

/** An object key that carries data (a map keyed by id, email, date…). */
export function isValueLikeKey(key: string): boolean {
  if (!IDENTIFIER.test(key)) return true;
  return key.length > 48 || digitCount(key) >= 4 || UUID.test(key);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `/customers/1234/orders/9f…` → `/customers/:id/orders/:id`. Query and fragment dropped. */
export function redactPath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  return path
    .split("/")
    .map((seg) => (isIdLike(safeDecode(seg)) ? ":id" : seg))
    .join("/");
}

export function shapeOf(value: unknown, depth = 0): Shape {
  if (value === null || value === undefined) return { type: "null" };
  if (depth > MAX_DEPTH) return { type: "object", fields: {} };
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
    case "bigint":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
  }
  if (Array.isArray(value)) {
    let items: Shape | undefined;
    for (const el of value) {
      const s = shapeOf(el, depth + 1);
      items = items ? mergeShapes(items, s) : s;
    }
    return items ? { type: "array", items } : { type: "array" };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([k]) => isValueLikeKey(k))) {
      let values: Shape | undefined;
      for (const [, v] of entries) {
        const s = shapeOf(v, depth + 1);
        values = values ? mergeShapes(values, s) : s;
      }
      return values ? { type: "record", values } : { type: "record" };
    }
    const fields: Record<string, Shape> = {};
    for (const [k, v] of entries) fields[k] = shapeOf(v, depth + 1);
    return { type: "object", fields };
  }
  return { type: "null" };
}

function mergeOptional(a?: Shape, b?: Shape): Shape | undefined {
  if (!a) return b;
  if (!b) return a;
  return mergeShapes(a, b);
}

function sameKind(a: Shape, b: Shape): boolean {
  return a.type === b.type;
}

/** Joins two observations of the same place: unions of types, optional keys for keys seen only sometimes. */
export function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.type === "union" || b.type === "union") {
    const members = [...(a.type === "union" ? a.anyOf : [a])];
    for (const m of b.type === "union" ? b.anyOf : [b]) {
      const i = members.findIndex((x) => sameKind(x, m));
      if (i === -1) members.push(m);
      else members[i] = mergeShapes(members[i] as Shape, m);
    }
    return members.length === 1 ? (members[0] as Shape) : { type: "union", anyOf: members };
  }
  if (!sameKind(a, b)) {
    if (a.type === "record" && b.type === "object") return mergeShapes(a, toRecord(b));
    if (a.type === "object" && b.type === "record") return mergeShapes(toRecord(a), b);
    return { type: "union", anyOf: [a, b] };
  }
  switch (a.type) {
    case "array": {
      const items = mergeOptional(a.items, (b as typeof a).items);
      return items ? { type: "array", items } : { type: "array" };
    }
    case "record": {
      const values = mergeOptional(a.values, (b as typeof a).values);
      return values ? { type: "record", values } : { type: "record" };
    }
    case "object": {
      const o = b as typeof a;
      const fields: Record<string, Shape> = {};
      const optional = new Set([...(a.optional ?? []), ...(o.optional ?? [])]);
      for (const key of new Set([...Object.keys(a.fields), ...Object.keys(o.fields)])) {
        const merged = mergeOptional(a.fields[key], o.fields[key]);
        if (merged) fields[key] = merged;
        if (!(key in a.fields) || !(key in o.fields)) optional.add(key);
      }
      return optional.size
        ? { type: "object", fields, optional: [...optional].sort() }
        : { type: "object", fields };
    }
    default:
      return a;
  }
}

function toRecord(o: Extract<Shape, { type: "object" }>): Shape {
  let values: Shape | undefined;
  for (const s of Object.values(o.fields)) values = values ? mergeShapes(values, s) : s;
  return values ? { type: "record", values } : { type: "record" };
}

/** What a request or response body was, by kind; only JSON and form bodies get a Shape. */
export type BodyShape =
  | { kind: "json"; shape: Shape }
  | { kind: "form"; shape: Shape }
  | { kind: "empty" | "text" | "html" | "multipart" | "binary" };

/** The media type without parameters (a multipart boundary is random, a charset is noise). */
export function mediaType(contentType: string | undefined | null): string | undefined {
  const t = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return t || undefined;
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function bodyShape(body: Buffer | string | null | undefined, contentType?: string | null): BodyShape {
  if (body === null || body === undefined || body.length === 0) return { kind: "empty" };
  const type = mediaType(contentType) ?? "";
  if (type.startsWith("multipart/")) return { kind: "multipart" };
  const text = typeof body === "string" ? body : body.toString("utf8");
  if (type === "application/x-www-form-urlencoded") {
    return { kind: "form", shape: shapeOf(Object.fromEntries(new URLSearchParams(text))) };
  }
  const looksJson = type.includes("json") || /^\s*[[{]/.test(text);
  if (looksJson) {
    const parsed = parseJson(text);
    if (parsed.ok) return { kind: "json", shape: shapeOf(parsed.value) };
  }
  if (type.includes("html")) return { kind: "html" };
  if (type.startsWith("text/") || type.includes("xml") || type.includes("javascript")) return { kind: "text" };
  if (typeof body !== "string" && body.subarray(0, 4000).includes(0)) return { kind: "binary" };
  return type === "" || type.startsWith("text/") ? { kind: "text" } : { kind: "binary" };
}

export function mergeBodies(a: BodyShape, b: BodyShape): BodyShape {
  if ((a.kind === "json" || a.kind === "form") && a.kind === b.kind) {
    return { kind: a.kind, shape: mergeShapes(a.shape, (b as typeof a).shape) };
  }
  if (a.kind === "empty") return b;
  return a;
}

/** Query parameter names only, as an object shape of strings. */
export function queryShape(search: URLSearchParams): Shape | undefined {
  const keys = [...new Set(search.keys())];
  if (keys.length === 0) return undefined;
  return shapeOf(Object.fromEntries(keys.map((k) => [k, ""])));
}
