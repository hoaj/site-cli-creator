import type { OperationShape } from "./recorder";
import { mergeBodies, type BodyShape, type Shape } from "./shape";
import { propertyKey, zodSource } from "./zod-source";

const REST_NAME = /^(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/;
/** Path segments that never name the resource: `/api/v2/…`. */
const NOISE_SEGMENT = /^(?:api|rest|v\d+|public|internal|external|gw|bff)$/i;

function capitalise(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

function singular(noun: string): string {
  if (/ies$/i.test(noun)) return noun.slice(0, -3) + "y";
  if (/(?:ss|us|is)$/i.test(noun)) return noun;
  if (/(?:ches|shes|xes|sses)$/i.test(noun)) return noun.slice(0, -2);
  return noun.endsWith("s") ? noun.slice(0, -1) : noun;
}

/**
 * The file name (without .ts) for an Operation. GraphQL names pass through. A REST
 * `METHOD /path` becomes a camelCase verb + noun from its last resource segment:
 * `GET /api/invoices` → `listInvoices`, `GET /api/invoices/:id` → `getInvoice`,
 * `POST /api/notes` → `createNote`, `PATCH /api/notes/:id` → `updateNote`. The Contract's
 * `name` stays `METHOD /path`; only the file is named this way.
 */
export function operationFileName(name: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(name)) return name;
  const rest = REST_NAME.exec(name);
  if (rest) {
    const method = rest[1]!;
    const segments = rest[2]!.split("/").filter(Boolean);
    const byId = segments.at(-1)?.startsWith(":") ?? false;
    const nouns = segments.filter((s) => !s.startsWith(":") && !NOISE_SEGMENT.test(s));
    const noun = (nouns.at(-1) ?? "root").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => (i === 0 ? w : capitalise(w))).join("");
    const plural = /[^s]s$/i.test(noun) || /ies$/i.test(noun);
    const verb =
      method === "GET" || method === "HEAD"
        ? byId || !plural
          ? "get"
          : "list"
        : method === "POST"
          ? "create"
          : method === "DELETE"
            ? "delete"
            : "update";
    const object = verb === "list" ? noun : singular(noun);
    const joined = `${verb}${capitalise(object)}`;
    if (/^[A-Za-z_$][\w$]*$/.test(joined)) return joined;
  }
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
  if (op.effectUnknown) {
    lines.push("  // A persisted query (hash only) sent by POST: nothing in the Capture says whether it writes, so it");
    lines.push("  // was treated as a write. Declare its effect from what it does to the user's data.");
  }
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
    const bodyShape = body && (body.kind === "json" || body.kind === "form") ? body.shape : undefined;
    // One convention with check --writes (capturedVariables): an object body's fields are top-level
    // variables next to path params and query; any other body is the one variable `body`.
    const bodyFields = bodyShape?.type === "object" ? bodyShape : undefined;
    const fieldKeys = bodyFields ? Object.keys(bodyFields.fields) : [];
    const optional = new Set(bodyFields?.optional ?? []);
    const urlKeys = [...params, ...queryKeys.filter((k) => !params.includes(k))];
    const rest: string[] = [`method: ${JSON.stringify(op.method)}`, `path: ${JSON.stringify(path)}`];
    if (queryKeys.length) {
      const pairs = queryKeys.map((k) => `${propertyKey(k)}: v[${JSON.stringify(k)}]`).join(", ");
      rest.push(`query: (v) => ({ ${pairs} })`);
    }
    if (bodyFields) {
      const pairs = fieldKeys.map((k) => `${propertyKey(k)}: v[${JSON.stringify(k)}]`).join(", ");
      rest.push(pairs ? `body: (v) => ({ ${pairs} })` : "body: () => ({})");
    } else if (bodyShape?.type === "record") {
      // Keyed by data (ids, dates): the keys are top-level variables too, so the body is every variable but the URL's.
      const omit = urlKeys.map((k, i) => `${JSON.stringify(k)}: _${i}, `).join("");
      rest.push(`body: ({ ${omit}...body }) => body`);
    } else if (bodyShape) rest.push("body: (v) => v.body");
    if (body?.kind === "form") rest.push('bodyType: "form"');
    const clash = fieldKeys.filter((k) => urlKeys.includes(k));
    if (clash.length) {
      lines.push(`  // ${clash.join(", ")}: in the URL and in the body. One variable carries both, and check compares the body's value.`);
    }
    lines.push(`  rest: { ${rest.join(", ")} },`);
    const varLines = [
      ...urlKeys.filter((k) => !fieldKeys.includes(k)).map((k) => `    ${propertyKey(k)}: z.string(),`),
      ...fieldKeys.map((k) => `    ${propertyKey(k)}: ${indent(zodSource(bodyFields!.fields[k], 0), 2)}${optional.has(k) ? ".optional()" : ""},`),
      ...(bodyShape && !bodyFields && bodyShape.type !== "record" ? [`    body: ${indent(zodSource(bodyShape, 0), 2)},`] : []),
    ];
    const catchall = bodyShape?.type === "record" ? `.catchall(${indent(zodSource(bodyShape.values, 0), 1)})` : "";
    lines.push(varLines.length ? `  variables: z.object({\n${varLines.join("\n")}\n  })${catchall},` : `  variables: z.object({})${catchall},`);
  }

  const body = successBody(op);
  if (body && (body.kind === "json" || body.kind === "form")) {
    lines.push(`  response: ${zodSource(body.shape, 1)},`);
  } else {
    const why = op.aborted >= op.seen ? "the request was aborted during the Capture" : `the response was ${body?.kind ?? "not seen"}`;
    lines.push(`  // No JSON response shape: ${why}.`);
    lines.push("  response: z.unknown(),");
  }
  if (op.navigation) {
    lines.push("  // A page load (a document request), not an API call: an Operation only if the page itself is the data.");
  }
  if (op.loginFlow) {
    lines.push("  // The Capture let this through as a sign-in step: it usually belongs in site.ts (login.tokenRequest,");
    lines.push("  // postLogin or bootstrap) rather than here. If it stays an Operation, decide its effect yourself.");
  } else if (op.effect === "write" && !op.effectUnknown) {
    lines.push("  // A write needs trigger(page): drive the UI up to this request so `check --writes` can intercept it.");
  }
  lines.push("});");
  return { name, source: `${lines.join("\n")}\n` };
}
