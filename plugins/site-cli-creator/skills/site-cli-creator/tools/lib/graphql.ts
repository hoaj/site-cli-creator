import { stripNoise, topLevelDefinitions, type GraphqlType } from "../../starter/skill/cli/src/runtime/graphql";
import { parseJson, shapeOf, type Shape } from "./shape";

export type GraphqlOperationType = GraphqlType;

export type GraphqlCall = {
  operationName: string | null;
  operationType: GraphqlOperationType;
  /** Query text with string literals, long number literals and comments redacted. */
  query: string | null;
  /** Persisted queries send a hash instead of the text. */
  persisted: boolean;
  variables?: Shape;
};

/** The comment redactQuery puts first when it replaced number literals, so the agent restores real ones. */
export const NUMBERS_REDACTED = "# number literals were redacted to 0: write the real ones (or variables) back";

/**
 * Queries are code, so their text is kept. Literals inside them can still be
 * data (`customer(id: "1234", zip: 2100)`), so string literals, every number
 * literal and comments are replaced. Numbers inside names (`$id2`) stay.
 */
export function redactQuery(query: string): string {
  let numbers = false;
  const out = query
    .replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*|(?<![\w$.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.])/g, (m) => {
      if (m.startsWith("#")) return "";
      if (m.startsWith('"')) return '""';
      if (m !== "0") numbers = true;
      return "0";
    })
    .replace(/[ \t]+$/gm, "")
    .trim();
  return numbers ? `${NUMBERS_REDACTED}\n${out}` : out;
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

/** A path that names a GraphQL endpoint: a segment such as `graphql`, `gql` or `graphql-gateway`. */
export function isGraphqlPath(path: string): boolean {
  return path.split("/").some((seg) => /^gql$|graphql/i.test(seg));
}

/**
 * Whether text is a GraphQL document: the `{ … }` shorthand, or definitions starting with
 * `query`, `mutation`, `subscription` or `fragment` and a selection set. A search word
 * (`?query=pizza`) is not, so it stays an ordinary value.
 */
export function isGraphqlDocument(text: string): boolean {
  const code = stripNoise(text).trim();
  return /^(?:\{|(?:query|mutation|subscription|fragment)\b[^{}]*\{)/.test(code) && code.endsWith("}");
}

/** Where a request goes: on a GraphQL path any `query` is a document; elsewhere it must look like one. */
export type GraphqlContext = { graphqlPath?: boolean };

function fromObject(body: Record<string, unknown>, ctx: GraphqlContext = {}): GraphqlCall | null {
  const text = typeof body.query === "string" ? body.query : null;
  const query = text !== null && (ctx.graphqlPath || isGraphqlDocument(text)) ? text : null;
  const extensions = body.extensions as { persistedQuery?: unknown } | undefined;
  const persisted =
    !query && typeof extensions === "object" && extensions !== null && typeof extensions.persistedQuery === "object" && extensions.persistedQuery !== null;
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

/**
 * GraphQL calls in a POST body: one object, or a batch array. Only a body carrying a GraphQL
 * document or `extensions.persistedQuery` counts, unless the request goes to a GraphQL path.
 */
export function graphqlFromBody(json: unknown, ctx: GraphqlContext = {}): GraphqlCall[] | null {
  const items = Array.isArray(json) ? json : [json];
  if (items.length === 0) return null;
  const calls: GraphqlCall[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) return null;
    const call = fromObject(item as Record<string, unknown>, ctx);
    if (!call) return null;
    calls.push(call);
  }
  return calls;
}

/**
 * GraphQL over GET: `?query=…&operationName=…&variables=…`. A `query` parameter on a REST path
 * that holds no GraphQL document (a search word) is an ordinary query field, so this returns null.
 */
export function graphqlFromSearch(search: URLSearchParams, ctx: GraphqlContext = {}): GraphqlCall[] | null {
  if (!search.has("query") && !search.has("extensions")) return null;
  const extensions = search.get("extensions");
  const parsedExt = extensions ? parseJson(extensions) : { ok: false as const };
  const call = fromObject({
    query: search.get("query") ?? undefined,
    operationName: search.get("operationName") ?? undefined,
    variables: search.get("variables") ?? undefined,
    extensions: parsedExt.ok ? parsedExt.value : undefined,
  }, ctx);
  return call ? [call] : null;
}
