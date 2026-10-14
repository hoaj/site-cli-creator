// Shapes describe JSON by type only. Nothing in a Shape is ever taken from a
// value: strings become {type:"string"}, and object keys that look like data
// (ids, emails, numbers) collapse into a "record" so they can't leak either.

/** What every observed string looked like, never the string: digits only, an ISO date, an ISO date-time. */
export type StringFormat = "numeric" | "date" | "datetime";

export type Shape =
  | { type: "string"; format?: StringFormat }
  | { type: "number" | "boolean" | "null" }
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

// `jens.hansen`, `mette.larsen`: a dot between letters, unless it ends in a file extension.
const DOTTED_NAME = /[A-Za-z]\.[A-Za-z]/;
const FILE_EXTENSION = /\.(?:m?js|css|html?|json|xml|txt|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|map|php|aspx?|jsp|cgi|pdf|csv|ics)$/i;

export function isDottedName(text: string): boolean {
  return DOTTED_NAME.test(text) && !FILE_EXTENSION.test(text);
}

/** A URL path segment that carries data rather than naming a resource. */
export function isIdLike(segment: string): boolean {
  if (segment === "") return false;
  if (isDottedName(segment)) return true;
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
  return key.length > 48 || digitCount(key) >= 4 || UUID.test(key) || isDottedName(key);
}

/** The format class of a string (never the string): numeric (`"399.00"`), ISO date, ISO date-time. */
export function stringFormat(value: string): StringFormat | undefined {
  if (/^-?\d+(?:[.,]\d+)?$/.test(value)) return "numeric";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return "datetime";
  return undefined;
}

export function safeDecode(segment: string): string {
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
    case "string": {
      const format = stringFormat(value as string);
      return format ? { type: "string", format } : { type: "string" };
    }
    case "number":
    case "bigint":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
  }
  if (Array.isArray(value)) {
    const items = mergeAll(value.map((el) => shapeOf(el, depth + 1)));
    return items ? { type: "array", items } : { type: "array" };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([k]) => isValueLikeKey(k))) {
      const values = mergeAll(entries.map(([, v]) => shapeOf(v, depth + 1)));
      return values ? { type: "record", values } : { type: "record" };
    }
    const fields: Record<string, Shape> = {};
    for (const [k, v] of entries) fields[k] = shapeOf(v, depth + 1);
    return { type: "object", fields };
  }
  return { type: "null" };
}

/** mergeShapes when both are there, else whichever is. */
export function mergeOptional(a?: Shape, b?: Shape): Shape | undefined {
  return a && b ? mergeShapes(a, b) : (a ?? b);
}

/** Every observation joined into one, or undefined for none. */
function mergeAll(shapes: Shape[]): Shape | undefined {
  return shapes.reduce<Shape | undefined>(mergeOptional, undefined);
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
    case "string": {
      // A format holds only while every observation has it.
      const format = a.format !== undefined && a.format === (b as typeof a).format ? a.format : undefined;
      return format ? { type: "string", format } : { type: "string" };
    }
    default:
      return a;
  }
}

/** The same shape with every string format class dropped. */
export function withoutFormats(shape: Shape): Shape {
  switch (shape.type) {
    case "string":
      return { type: "string" };
    case "array":
      return shape.items ? { type: "array", items: withoutFormats(shape.items) } : shape;
    case "record":
      return shape.values ? { type: "record", values: withoutFormats(shape.values) } : shape;
    case "object":
      return { ...shape, fields: Object.fromEntries(Object.entries(shape.fields).map(([k, v]) => [k, withoutFormats(v)])) };
    case "union":
      return { type: "union", anyOf: shape.anyOf.map(withoutFormats) };
    default:
      return shape;
  }
}

function toRecord(o: Extract<Shape, { type: "object" }>): Shape {
  const values = mergeAll(Object.values(o.fields));
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

/** `parsed`: parseJson() of the same body, when the caller already ran it. */
export function bodyShape(body: Buffer | string | null | undefined, contentType?: string | null, parsed?: ReturnType<typeof parseJson>): BodyShape {
  if (body === null || body === undefined || body.length === 0) return { kind: "empty" };
  const type = mediaType(contentType) ?? "";
  if (type.startsWith("multipart/")) return { kind: "multipart" };
  const text = typeof body === "string" ? body : body.toString("utf8");
  if (type === "application/x-www-form-urlencoded") {
    // Form bodies are sign-in forms as often as not: no format class (a numeric PIN stays a plain string).
    return { kind: "form", shape: withoutFormats(shapeOf(Object.fromEntries(new URLSearchParams(text)))) };
  }
  const looksJson = type.includes("json") || /^\s*[[{]/.test(text);
  if (looksJson) {
    const json = parsed ?? parseJson(text);
    if (json.ok) return { kind: "json", shape: shapeOf(json.value) };
  }
  if (type.includes("html")) return { kind: "html" };
  if (type.startsWith("text/") || type.includes("xml") || type.includes("javascript")) return { kind: "text" };
  if (typeof body !== "string" && body.subarray(0, 4000).includes(0)) return { kind: "binary" };
  return type === "" ? { kind: "text" } : { kind: "binary" };
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
