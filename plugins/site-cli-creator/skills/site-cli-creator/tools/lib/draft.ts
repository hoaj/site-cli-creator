import type { OperationShape } from "./recorder";
import { mergeBodies, type BodyShape, type Shape } from "./shape";
import { propertyKey, zodSource } from "./zod-source";

/** `GET /api/users/:id` → `getApiUsersId`; GraphQL names pass through. */
export function operationFileName(name: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(name)) return name;
  const words = name
    .replace(/:/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const joined = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  return /^[A-Za-z_$]/.test(joined) ? joined : `op${joined}`;
}

function templateLiteral(text: string): string {
  return `\`${text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
}

function successBody(op: OperationShape): BodyShape | undefined {
  let body: BodyShape | undefined;
  for (const r of op.responses) {
    if (r.status < 200 || r.status >= 300) continue;
    body = body ? mergeBodies(body, r.body) : r.body;
  }
  return body;
}

function indent(source: string, level: number): string {
  return source.replace(/\n/g, `\n${"  ".repeat(level)}`);
}

/** Renames repeated `:id` params so each is its own variable: `/a/:id/b/:id` → `/a/:id/b/:id2`. */
export function namePathParams(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const named = path
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg;
      const base = seg.slice(1) || "id";
      let name = base;
      for (let i = 2; params.includes(name); i++) name = `${base}${i}`;
      params.push(name);
      return `:${name}`;
    })
    .join("/");
  return { path: named, params };
}

function objectFields(shape: Shape | undefined): string[] {
  return shape?.type === "object" ? Object.keys(shape.fields) : [];
}

/**
 * A draft `src/operations/<name>.ts` (ARCHITECTURE §4) from one shape file.
 * It covers every field the Capture saw; the agent cuts `response` down to
 * the fields the command reads and decides nullability.
 */
export function draftOperation(
  op: OperationShape,
  opts: { name?: string; from?: string } = {},
): { name: string; source: string } {
  const name = opts.name ?? op.operation;
  const what = op.kind === "graphql" ? `GraphQL ${op.graphql?.operationType ?? "query"}` : `${op.method} ${op.path}`;
  const lines: string[] = [];
  lines.push(opts.from ? `// From ${opts.from} (${what}).` : `// From a Capture of ${what}.`);
  lines.push("// DRAFT: keep only the response fields the command reads, and decide which may be");
  lines.push("// null, because one Capture is too narrow to tell.");
  lines.push('import { z } from "zod";');
  lines.push('import { defineOperation } from "../runtime/operation";');
  lines.push("");
  lines.push("export default defineOperation({");
  lines.push(`  name: ${JSON.stringify(name)},`);
  lines.push(`  effect: ${JSON.stringify(op.effect)},`);

  if (op.kind === "graphql") {
    if (op.graphql?.query) {
      lines.push("  // The frontend's query text: trim it to the fields the command reads.");
      lines.push(`  graphql: ${templateLiteral(op.graphql.query)},`);
    } else {
      lines.push("  // The Capture saw a persisted query (hash only): write the query text here.");
      lines.push('  graphql: "",');
    }
    const variables = op.request.variables;
    const varSource = variables?.type === "object" ? zodSource(variables, 1) : "z.object({})";
    lines.push(`  variables: ${varSource},`);
  } else {
    const { path, params } = namePathParams(op.path);
    const queryKeys = objectFields(op.request.query);
    const body = op.request.body;
    const jsonBody = body && (body.kind === "json" || body.kind === "form") ? body.shape : undefined;
    const rest: string[] = [`method: ${JSON.stringify(op.method)}`, `path: ${JSON.stringify(path)}`];
    if (queryKeys.length) {
      const pairs = queryKeys.map((k) => `${propertyKey(k)}: v[${JSON.stringify(k)}]`).join(", ");
      rest.push(`query: (v) => ({ ${pairs} })`);
    }
    if (jsonBody) rest.push("body: (v) => v.body");
    lines.push(`  rest: { ${rest.join(", ")} },`);
    const varLines = [
      ...params.map((p) => `    ${propertyKey(p)}: z.string(),`),
      ...queryKeys.filter((k) => !params.includes(k)).map((k) => `    ${propertyKey(k)}: z.string(),`),
      ...(jsonBody ? [`    body: ${indent(zodSource(jsonBody, 0), 2)},`] : []),
    ];
    lines.push(varLines.length ? `  variables: z.object({\n${varLines.join("\n")}\n  }),` : "  variables: z.object({}),");
  }

  const body = successBody(op);
  if (body && (body.kind === "json" || body.kind === "form")) {
    lines.push(`  response: ${zodSource(body.shape, 1)},`);
  } else {
    const why = op.aborted >= op.seen ? "the request was aborted during the Capture" : `the response was ${body?.kind ?? "not seen"}`;
    lines.push(`  // No JSON response shape: ${why}.`);
    lines.push("  response: z.unknown(),");
  }
  if (op.loginFlow) {
    lines.push("  // The Capture let this through as a sign-in step: it usually belongs in site.ts (login.tokenRequest,");
    lines.push("  // postLogin or bootstrap) rather than here. If it stays an Operation, decide its effect yourself.");
  } else if (op.effect === "write") {
    lines.push("  // A write needs trigger(page): drive the UI up to this request so `check --writes` can intercept it.");
  }
  lines.push("});");
  return { name, source: `${lines.join("\n")}\n` };
}
