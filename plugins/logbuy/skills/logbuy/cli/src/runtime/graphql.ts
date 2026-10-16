// GraphQL document parsing, shared by check.ts and the generator's tools/lib/graphql.ts (the runtime never imports tools).

export type GraphqlType = "query" | "mutation" | "subscription";

/** String literals, block strings and comments removed: a mutation word inside them is no definition. */
export const stripNoise = (query: string) => query.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, "");

/** Every operation definition at brace depth 0 (fields named `mutation` inside a selection don't count). */
export function topLevelDefinitions(code: string): { type: GraphqlType; name: string | null }[] {
  let depth = 0;
  let top = "";
  for (const ch of code) {
    if (ch === "{" || ch === "(") {
      if (depth === 0) top += " { ";
      depth++;
    } else if (ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) top += ch;
  }
  return [...top.matchAll(/(?:^|\s)(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/g)].map((m) => ({ type: m[1] as GraphqlType, name: m[2] ?? null }));
}
