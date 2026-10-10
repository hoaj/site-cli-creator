import { parseJson, shapeOf, type Shape } from "./shape";

export type GraphqlOperationType = "query" | "mutation" | "subscription";

export type GraphqlCall = {
  operationName: string | null;
  operationType: GraphqlOperationType;
  /** Query text with string literals, long number literals and comments redacted. */
  query: string | null;
  /** Persisted queries send a hash instead of the text. */
  persisted: boolean;
  variables?: Shape;
};

/**
 * Queries are code, so their text is kept. Literals inside them can still be
 * data (`customer(id: "1234")`), so string literals, numbers of 5+ digits and
 * comments are replaced.
 */
export function redactQuery(query: string): string {
  return query
    .replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*|\b\d{5,}\b/g, (m) => {
      if (m.startsWith("#")) return "";
      if (m.startsWith('"')) return '""';
      return "0";
    })
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function stripNoise(query: string): string {
  return query.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, "");
}

/** Operation definitions at brace depth 0 (fields named `query` inside a selection don't count). */
function topLevelDefinitions(code: string): { type: GraphqlOperationType; name: string | null }[] {
  const defs: { type: GraphqlOperationType; name: string | null }[] = [];
  let depth = 0;
  let top = "";
  for (const ch of code) {
    if (ch === "{" || ch === "(") {
      if (depth === 0) top += " { ";
      depth++;
    } else if (ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) top += ch;
  }
  for (const m of top.matchAll(/(?:^|\s)(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/g)) {
    defs.push({ type: m[1] as GraphqlOperationType, name: m[2] ?? null });
  }
  return defs;
}

/** The type and name of the operation a query document runs (the named one, else the first). */
export function describeQuery(
  query: string,
  operationName?: string | null,
): { type: GraphqlOperationType; name: string | null } {
  const defs = topLevelDefinitions(stripNoise(query));
  const named = operationName ? defs.find((d) => d.name === operationName) : undefined;
  if (named) return named;
  if (defs[0]) return defs[0];
  return { type: "query", name: null }; // shorthand `{ … }` is a query
}

function fromObject(body: Record<string, unknown>): GraphqlCall | null {
  const query = typeof body.query === "string" ? body.query : null;
  const extensions = body.extensions as { persistedQuery?: unknown } | undefined;
  const persisted = !query && typeof extensions === "object" && extensions !== null && "persistedQuery" in extensions;
  if (!query && !persisted) return null;
  const requested = typeof body.operationName === "string" ? body.operationName : null;
  const described = query ? describeQuery(query, requested) : { type: "query" as const, name: null };
  let variables = body.variables;
  if (typeof variables === "string") {
    const parsed = parseJson(variables);
    variables = parsed.ok ? parsed.value : undefined;
  }
  return {
    operationName: requested ?? described.name,
    operationType: described.type,
    query: query ? redactQuery(query) : null,
    persisted,
    ...(variables !== undefined && variables !== null ? { variables: shapeOf(variables) } : {}),
  };
}

/** GraphQL calls in a POST body: one object, or a batch array. */
export function graphqlFromBody(json: unknown): GraphqlCall[] | null {
  const items = Array.isArray(json) ? json : [json];
  if (items.length === 0) return null;
  const calls: GraphqlCall[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) return null;
    const call = fromObject(item as Record<string, unknown>);
    if (!call) return null;
    calls.push(call);
  }
  return calls;
}

/** GraphQL over GET: `?query=…&operationName=…&variables=…`. */
export function graphqlFromSearch(search: URLSearchParams): GraphqlCall[] | null {
  if (!search.has("query") && !search.has("extensions")) return null;
  const extensions = search.get("extensions");
  const parsedExt = extensions ? parseJson(extensions) : { ok: false as const };
  const call = fromObject({
    query: search.get("query") ?? undefined,
    operationName: search.get("operationName") ?? undefined,
    variables: search.get("variables") ?? undefined,
    extensions: parsedExt.ok ? parsedExt.value : undefined,
  });
  return call ? [call] : null;
}
