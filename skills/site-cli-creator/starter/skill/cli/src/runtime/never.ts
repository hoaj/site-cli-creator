// site.never: requests this CLI must never send, whatever a command, a Contract or --confirm says
// (SPEC §6). The runtime refuses a matching request before it leaves (call, every fetch the Client
// makes, the hooks' ctx.fetch), check refuses a registry holding one and aborts it in a trigger,
// regen refuses the Contract, and tests/never-sent.test.ts fails the plugin's CI.
import { ContractError, type Surface } from "./envelope";
import { stripNoise, topLevelDefinitions } from "./graphql";
import type { Method, Operation } from "./operation";
import type { Fetch, NeverRule, Site } from "./site";

const METHODS: string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"] satisfies Method[];
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** Problems with site.never, for siteProblems. */
export function neverListProblems(list: unknown): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ["never must be a list of { method?, path, why } or { graphql, why }"];
  const out: string[] = [];
  list.forEach((raw, i) => {
    const at = `never[${i}]`;
    if (!raw || typeof raw !== "object") return out.push(`${at} must be { method?, path, why } or { graphql, why }`);
    const r = raw as Record<string, unknown>;
    if (typeof r.why !== "string" || r.why.trim() === "") out.push(`${at} needs a why: what the request does and why the CLI never sends it`);
    const hasPath = r.path !== undefined;
    const hasGraphql = r.graphql !== undefined;
    if (!hasPath && !hasGraphql) return out.push(`${at} needs a path or a graphql name`);
    if (hasPath === hasGraphql || (hasGraphql && r.method !== undefined)) return out.push(`${at} takes a path or a graphql name, not both`);
    if (hasPath && !(typeof r.path === "string" && r.path.startsWith("/"))) out.push(`${at}.path must start with /`);
    if (r.method !== undefined && !(typeof r.method === "string" && METHODS.includes(r.method))) out.push(`${at}.method must be GET, POST, PUT, PATCH or DELETE`);
    if (hasGraphql && !(typeof r.graphql === "string" && GRAPHQL_NAME.test(r.graphql))) out.push(`${at}.graphql must be a GraphQL operation name`);
  });
  return out;
}

/** How a rule is named in messages, help and SKILL.md: `POST /api/order/place*`, `/api/x` (any method), `GraphQL PlaceOrder`. */
export function neverRuleLabel(rule: NeverRule): string {
  if (rule.graphql !== undefined) return `GraphQL ${rule.graphql}`;
  return rule.method ? `${rule.method} ${rule.path}` : rule.path!;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const globs = new Map<string, RegExp>();

/** A path glob as a RegExp over a whole path: `*` is any run of characters, `/` included; case-insensitive. Compiled once. */
function globRe(path: string): RegExp {
  let re = globs.get(path);
  if (!re) {
    re = new RegExp(`^${path.replace(/\/+$/, "").split("*").map(escape).join(".*")}/?$`, "i");
    globs.set(path, re);
  }
  return re;
}

/** A request path as the site would read it: percent-escapes decoded, repeated slashes collapsed. */
function normalPath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {}
  return p.replace(/\/{2,}/g, "/");
}

const methodMatches = (rule: NeverRule, method: string) => !rule.method || rule.method === method.toUpperCase();
const nameMatches = (rule: NeverRule, names: string[]) => rule.graphql !== undefined && names.some((n) => n.toLowerCase() === rule.graphql!.toLowerCase());

/** The operation names a GraphQL document carries: its operationName and every definition in its query. */
function graphqlNames(doc: unknown): string[] {
  if (!doc || typeof doc !== "object") return [];
  const d = doc as { operationName?: unknown; query?: unknown };
  const names: string[] = [];
  if (typeof d.operationName === "string") names.push(d.operationName);
  if (typeof d.query === "string") for (const def of topLevelDefinitions(stripNoise(d.query))) if (def.name) names.push(def.name);
  return names;
}

const rules = (site: Site): NeverRule[] => (Array.isArray(site.never) ? site.never : []);

/** The operation names a request body carries: JSON (a document or a batch), else a form's fields or a raw GraphQL document. */
function bodyNames(body: string): string[] {
  try {
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap(graphqlNames);
  } catch {
    const form = new URLSearchParams(body);
    return [...graphqlNames({ operationName: form.get("operationName") ?? undefined, query: form.get("query") ?? undefined }), ...graphqlNames({ query: body })];
  }
}

/**
 * The rule a request breaks, if any: a path rule by method and path (on any host), a GraphQL rule by
 * any operation name the request carries (a JSON body or batch, a form body, a raw GraphQL body, or a
 * GET's query string).
 */
export function forbiddenRequest(site: Site, req: { method: string; url: string; body?: string }): NeverRule | undefined {
  const list = rules(site);
  if (list.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return undefined;
  }
  const path = normalPath(url.pathname);
  const names: string[] = [];
  const op = url.searchParams.get("operationName");
  if (op) names.push(op);
  const query = url.searchParams.get("query");
  if (query) names.push(...graphqlNames({ query }));
  if (req.body) names.push(...bodyNames(req.body));
  return list.find((r) => (r.path !== undefined ? methodMatches(r, req.method) && globRe(r.path).test(path) : nameMatches(r, names)));
}

/**
 * The rule an Operation's declared request breaks, if any. A REST template matches when the rule's
 * glob covers the template as written (`/api/orders/*` covers `/api/orders/:id`). A template that only
 * some variables fill to a forbidden path (`/api/order/:step` with step "place") is left to the
 * runtime, which checks the request it builds: refusing it here would refuse every read of
 * `/api/order/:id` as well. A GraphQL Operation is a POST to site.graphqlPath carrying its name and
 * every definition in its query.
 */
export function forbiddenOperation(site: Site, op: Operation): NeverRule | undefined {
  const list = rules(site);
  if (op.graphql !== undefined) {
    const names = [op.name, ...graphqlNames({ query: op.graphql })];
    const path = site.graphqlPath ?? "/graphql";
    return list.find((r) => (r.path !== undefined ? methodMatches(r, "POST") && globRe(r.path).test(path) : nameMatches(r, names)));
  }
  if (!op.rest) return undefined;
  const { method, path } = op.rest;
  return list.find((r) => r.path !== undefined && methodMatches(r, method) && globRe(r.path).test(path));
}

const describeRule = (rule: NeverRule) => `${neverRuleLabel(rule)} (${rule.why})`;

/** One line per Operation whose declared request site.never forbids. */
export function neverProblems(site: Site, operations: Operation[]): string[] {
  return operations.flatMap((op) => {
    const rule = forbiddenOperation(site, op);
    return rule ? [`${op.name} matches site.never ${describeRule(rule)}`] : [];
  });
}

/** What may follow a path in source for it to be the whole path: an optional `/`, then a quote, space, `?`, `#` or the end. */
const PATH_END = "(?=/?(?:[\\s\"'`?#),;]|$))";

/**
 * One line per source file that names a request site.never forbids, as the runtime would match it:
 * - a path glob (its `*` spans any run of characters that is no space or quote, so `:id` and `${id}`
 *   match), case-insensitive, ending where the path ends (`/api/cart` is not `/api/cart/items`). A
 *   rule with a method counts only in a file that also holds that method as a quoted string
 *   ("DELETE"), so a read of the same path (GET /api/cart beside DELETE /api/cart) is no match;
 * - a GraphQL name where GraphQL names one: after `query`, `mutation` or `subscription`, or quoted
 *   (an operationName). A field or a path holding the same word is no match.
 */
export function neverInSource(site: Site, files: { path: string; text: string }[]): string[] {
  const res = rules(site).map((rule) => {
    if (rule.path === undefined) {
      const name = escape(rule.graphql!);
      return { rule, re: new RegExp(`\\b(?:query|mutation|subscription)\\s+${name}(?![\\w$])|["'\`]${name}["'\`]`), method: undefined };
    }
    const src = `${rule.path.replace(/\/+$/, "").split("*").map(escape).join("[^\\s\"'`]*")}${PATH_END}`;
    const method = rule.method ? new RegExp(`["'\`]${rule.method}["'\`]`, "i") : undefined;
    return { rule, re: new RegExp(src, "i"), method };
  });
  return files.flatMap((f) =>
    res.filter(({ re, method }) => re.test(f.text) && (!method || method.test(f.text))).map(({ rule }) => `${f.path} names ${describeRule(rule)}`),
  );
}

/**
 * A request site.never forbids, refused before it left. A bug in the plugin (a Contract or a command
 * that should not exist), so main reports it with exit 1; its message names only the rule.
 */
export class NeverSent extends ContractError {
  readonly rule: NeverRule;
  constructor(rule: NeverRule, what = "A request") {
    super(`${what} is a request site.never forbids (${neverRuleLabel(rule)}: ${rule.why}), so nothing was sent.`);
    this.name = "NeverSent";
    this.rule = rule;
  }
}

/** Throws NeverSent when site.never forbids this request. */
export function refuseNever(site: Site, req: { method: string; url: string; body?: string }, what?: string): void {
  const rule = forbiddenRequest(site, req);
  if (rule) throw new NeverSent(rule, what);
}

/** A request body as text, for matching: strings, forms, FormData's text fields, Blobs and buffers. A stream is not read. */
async function bodyText(body: RequestInit["body"], request: Request | undefined): Promise<string | undefined> {
  if (body === undefined || body === null) return request ? request.clone().text().catch(() => undefined) : undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) {
    const fields: [string, string][] = [];
    body.forEach((v, k) => typeof v === "string" && fields.push([k, v]));
    return new URLSearchParams(fields).toString();
  }
  if (body instanceof Blob) return body.text();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  return undefined;
}

const MAX_HOPS = 20;

/**
 * A fetch that refuses what site.never forbids (the hooks' ctx.fetch, login.refresh.renew). Redirects
 * are followed by hand, as fetch would follow them (303, and 301/302 after a non-GET, go on as a GET
 * without a body), so every hop is checked before it is sent; a caller's own `redirect: "manual"` or
 * "error" is kept. `onRefuse` hears of each refusal, even one the caller then catches.
 */
export function guardFetch(site: Site, fetch: Fetch, onRefuse?: (refused: NeverSent) => void): Fetch {
  if (rules(site).length === 0) return fetch;
  const refuse = (req: { method: string; url: string; body?: string }) => {
    const rule = forbiddenRequest(site, req);
    if (!rule) return;
    const refused = new NeverSent(rule);
    onRefuse?.(refused);
    throw refused;
  };
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    let method = (init.method ?? request?.method ?? "GET").toUpperCase();
    let url = request ? request.url : String(input);
    let text = await bodyText(init.body, request);
    refuse({ method, url, body: text });
    if (init.redirect === "manual" || init.redirect === "error") return fetch(input, init);
    let body: RequestInit["body"] = init.body ?? text;
    const headers = init.headers ?? request?.headers;
    let res = await fetch(input, { ...init, redirect: "manual" });
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) return res;
      const next = new URL(location, url).href;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
        if (method !== "HEAD") method = "GET";
        body = undefined;
        text = undefined;
      }
      refuse({ method, url: next, body: text });
      url = next;
      res = await fetch(url, { ...init, method, headers, body, redirect: "manual" });
    }
    return res;
  };
}

/** The `next` of a NeverSent envelope: the user does this on the site; a command that tried it is a bug. */
export function neverNext(rule: NeverRule, site: { plugin: string; skill: string }, surface: Surface): string {
  const kind = surface === "mcp" ? "MCP server" : "CLI";
  const workaround = surface === "mcp" ? "other tools, raw calls or the browser" : "raw calls, curl or the browser";
  const tried = surface === "mcp" ? "A tool that tries it" : "A command that tries it";
  return `Stop: the ${site.skill} ${kind} never sends this request (${rule.why}). Tell the user to do it on the site themselves. Do not work around it with ${workaround}. ${tried} is a bug: offer to file it through the ${site.plugin}-feedback skill, passing this whole envelope, and file it only if the user says yes.`;
}

/**
 * site.ts's text without its `never: [ … ]` list (and the comma after it), so a scan of the hooks
 * does not find the list itself. Brackets inside strings and comments are skipped.
 */
export function stripNeverList(text: string): string {
  const start = /\bnever\s*:\s*\[/.exec(text);
  if (!start) return text;
  let depth = 0;
  for (let i = start.index + start[0].length - 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) return text;
      i++;
    } else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) {
      const end = text[i + 1] === "," ? i + 2 : i + 1;
      return text.slice(0, start.index) + text.slice(end);
    }
  }
  return text;
}

/** site.never for `help` and the MCP instructions: each rule's label and reason. */
export function neverList(site: Site): { request: string; why: string }[] {
  return rules(site).map((r) => ({ request: neverRuleLabel(r), why: r.why }));
}
