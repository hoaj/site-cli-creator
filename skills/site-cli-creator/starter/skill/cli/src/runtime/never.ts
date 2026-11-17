// site.never: requests this CLI must never send, whatever a command, a Contract or --confirm says
// (SPEC §6). The runtime refuses a matching request before it leaves (call, every fetch the Client
// makes, the hooks' ctx.fetch), check refuses a registry holding one and aborts it in a trigger,
// regen refuses the Contract, and tests/never-sent.test.ts fails the plugin's CI.
import { ContractError, type Surface } from "./envelope";
import { stripNoise, topLevelDefinitions } from "./graphql";
import type { Method, Operation } from "./operation";
// A cycle with site.ts (it imports neverListProblems): these are used only at call time, never at load.
import { onSiteDomain, siteDomain, type Fetch, type NeverRule, type Site } from "./site";

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
    if (hasPath && hasGraphql) return out.push(`${at} takes a path or a graphql name, not both`);
    if (hasGraphql && r.method !== undefined) return out.push(`${at}.method goes only with a path: a graphql entry matches every request that carries the name`);
    if (hasPath && !(typeof r.path === "string" && r.path.startsWith("/"))) out.push(`${at}.path must start with /`);
    else if (hasPath && /[?#]/.test(r.path as string)) out.push(`${at}.path is a URL path only: no ? or # (the query string and fragment are never matched)`);
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

/**
 * A request path as a server may read it: percent-escapes decoded (an encoded `/` included), repeated
 * slashes collapsed and `.`/`..` segments resolved, so a variable holding `x/../../order/place` does
 * not walk past a rule.
 */
function normalPath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {}
  const segments: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "." && segment !== "") segments.push(segment);
  }
  return `/${segments.join("/")}${segments.length > 0 && p.endsWith("/") ? "/" : ""}`;
}

const methodMatches = (rule: NeverRule, method: string) => !rule.method || rule.method === method.toUpperCase();
const nameMatches = (rule: NeverRule, names: string[]) => rule.graphql !== undefined && names.some((n) => n.toLowerCase() === rule.graphql!.toLowerCase());

/**
 * The root fields of every mutation in a GraphQL document, aliases resolved: `placeOrder` in
 * `mutation X { done: placeOrder(cartId: $c) { id } }`. A client names its operation as it likes, so
 * a rule must also see what the mutation does. Fragment spreads at the root are not followed.
 */
function mutationRootFields(query: string): string[] {
  const code = stripNoise(query);
  const out: string[] = [];
  const token = /(\.\.\.\s*(?:on\s+)?|@)?([_A-Za-z][_0-9A-Za-z]*)(\s*:)?/y;
  let depth = 0;
  let parens = 0;
  let top = "";
  let inMutation = false;
  for (let i = 0; i < code.length; ) {
    const ch = code[i]!;
    if (ch === "(") parens++;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (parens > 0) {
      // arguments and variable definitions: no fields
    } else if (ch === "{") {
      if (depth === 0) {
        inMutation = /\bmutation\b/.test(top);
        top = "";
      }
      depth++;
    } else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) top += ch;
    else if (depth === 1 && inMutation && /[_A-Za-z.@]/.test(ch)) {
      token.lastIndex = i;
      const m = token.exec(code);
      if (m) {
        if (!m[1] && !m[3]) out.push(m[2]!); // a field; `alias:` is skipped, its field comes next
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * The names a GraphQL document carries: its operationName, every definition's name in its query, and
 * every mutation's root fields.
 */
function graphqlNames(doc: unknown): string[] {
  if (!doc || typeof doc !== "object") return [];
  const d = doc as { operationName?: unknown; query?: unknown };
  const names: string[] = [];
  if (typeof d.operationName === "string") names.push(d.operationName);
  if (typeof d.query === "string") {
    for (const def of topLevelDefinitions(stripNoise(d.query))) if (def.name) names.push(def.name);
    names.push(...mutationRootFields(d.query));
  }
  return names;
}

const rules = (site: Site): NeverRule[] => (Array.isArray(site.never) ? site.never : []);

/** The operation names a JSON text carries (a document or a batch); [] when it is no JSON. */
function jsonNames(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap(graphqlNames);
  } catch {
    return [];
  }
}

/**
 * The operation names a request body carries: JSON (a document or a batch), else a form's fields
 * (`operationName`, `query`, and a multipart request's `operations` JSON) or a raw GraphQL document.
 */
function bodyNames(body: string): string[] {
  const json = jsonNames(body);
  if (json.length > 0) return json;
  const form = new URLSearchParams(body);
  const operations = form.get("operations");
  return [
    ...graphqlNames({ operationName: form.get("operationName") ?? undefined, query: form.get("query") ?? undefined }),
    ...(operations ? jsonNames(operations) : []),
    ...graphqlNames({ query: body }),
  ];
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
  // Names are read only when a GraphQL rule needs them: most requests are no GraphQL.
  const names: string[] = [];
  if (list.some((r) => r.graphql !== undefined)) {
    const op = url.searchParams.get("operationName");
    if (op) names.push(op);
    const query = url.searchParams.get("query");
    if (query) names.push(...graphqlNames({ query }));
    if (req.body) names.push(...bodyNames(req.body));
  }
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

/**
 * The paths a source text names: every run of characters that is no space or quote and holds a path,
 * with a URL's scheme and host or a template's leading `${…}` (an origin) taken off, cut at `?` or
 * `#`. `at` is where it stands in the text. `//` (a comment) is no path.
 */
function sourcePaths(text: string): { path: string; at: number }[] {
  const out: { path: string; at: number }[] = [];
  for (const m of text.matchAll(/[^\s"'`]+/g)) {
    const token = m[0]
      .replace(/^[})]+/, "")
      .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
      .replace(/^(?:\$\{[^}]*\})+/, "");
    if (!token.startsWith("/") || token.startsWith("//")) continue;
    const path = token.split(/[?#]/)[0]!.replace(/[),;.]+$/, "").replace(/\/{2,}/g, "/");
    if (path) out.push({ path, at: m.index! });
  }
  return out;
}

const QUOTED_METHOD = /["'`](GET|POST|PUT|PATCH|DELETE)["'`]/gi;
/** How far from a path a quoted method may stand to be that request's method (a Contract's rest, a fetch's init). */
const METHOD_REACH = 200;

/** The method a path in source is sent with: the nearest quoted method within METHOD_REACH, else GET (fetch's default). */
function methodNear(text: string, at: number): string {
  let best: { method: string; distance: number } | undefined;
  for (const m of text.matchAll(QUOTED_METHOD)) {
    const distance = Math.abs(m.index! - at);
    if (distance <= METHOD_REACH && (!best || distance < best.distance)) best = { method: m[1]!.toUpperCase(), distance };
  }
  return best?.method ?? "GET";
}

/**
 * One line per source file that names a request site.never forbids, matched as the runtime would:
 * - a path rule: a path the text names (sourcePaths) that the rule's glob covers, the same anchored,
 *   case-insensitive glob the runtime uses (`*` covers `:id` and `${id}` written in a template), and
 *   for a rule with a method, sent with that method: the quoted method nearest to it, else GET. So a
 *   GET of /api/cart next to a POST /api/cart rule, or a POST of another path in the same file, is
 *   no match;
 * - a GraphQL rule: its name after `query`, `mutation` or `subscription`, or quoted (an
 *   operationName), case-insensitive. A field or a path holding the same word is no match.
 * A best effort before release: the runtime refuses every real request either way.
 */
export function neverInSource(site: Site, files: { path: string; text: string }[]): string[] {
  const list = rules(site);
  return files.flatMap((f) => {
    const paths = sourcePaths(f.text);
    return list
      .filter((rule) => {
        if (rule.path === undefined) {
          const name = escape(rule.graphql!);
          return new RegExp(`\\b(?:query|mutation|subscription)\\s+${name}(?![\\w$])|\\boperationName["']?\\s*:\\s*["'\`]${name}["'\`]`, "i").test(f.text);
        }
        const glob = globRe(rule.path);
        return paths.some((p) => glob.test(p.path) && (!rule.method || methodNear(f.text, p.at) === rule.method));
      })
      .map((rule) => `${f.path} names ${describeRule(rule)}`);
  });
}

/**
 * A request site.never forbids, refused before it left. A bug in the plugin (a Contract or a command
 * that should not exist), so main reports it with exit 1; its message names only the rule.
 */
export class NeverSent extends ContractError {
  readonly rule: NeverRule;
  /** The Operation whose own request it was; undefined for a hook's request or a redirect hop. */
  readonly operation?: string;
  constructor(rule: NeverRule, operation?: string) {
    super(`${operation ?? "A request"} is a request site.never forbids (${neverRuleLabel(rule)}: ${rule.why}), so nothing was sent.`);
    this.name = "NeverSent";
    this.rule = rule;
    this.operation = operation;
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
const GUARDED = Symbol("site.never guard");

/** Headers that describe a body: dropped when a redirect turns the request into a GET, as fetch does. */
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];


/** `to` (a fetch that only adds headers around `from`) is as guarded as `from` is, so guardFetch leaves it as it is. */
export function keepGuard(from: Fetch, to: Fetch): Fetch {
  if ((from as { [GUARDED]?: true })[GUARDED]) Object.defineProperty(to, GUARDED, { value: true });
  return to;
}

/**
 * A fetch that refuses what site.never forbids: the Client wraps every fetch it makes with it (the
 * Operations', the hooks' ctx.fetch, login.refresh.renew's). Redirects are followed by hand, as fetch
 * would follow them, so every hop is checked before it is sent:
 * - 303 (but after HEAD), and 301/302 after a POST, go on as a GET without the body or its headers;
 * - a hop to another origin goes without `authorization`, as fetch's; one off the site's domain, or
 *   from https to http, also without the cookie;
 * - a caller's own `redirect: "manual"` or "error" is kept (the Client's fetchFollowing).
 * The answer is fetch's: `redirected` and `url` set after a redirect, a TypeError after 20 hops or
 * on a 307/308 that would resend a stream body, every hop's body cancelled, the request's signal kept.
 * `onRefuse` hears of each refusal, even one the caller then catches. `origin` is the effective one
 * (its domain keeps the session's headers). A fetch already guarded is returned as it is.
 */
export function guardFetch(site: Site, fetch: Fetch, onRefuse?: (refused: NeverSent) => void, origin: string = site.origin): Fetch {
  if (rules(site).length === 0 || (fetch as { [GUARDED]?: true })[GUARDED]) return fetch;
  const refuse = (req: { method: string; url: string; body?: string }) => {
    const rule = forbiddenRequest(site, req);
    if (!rule) return;
    const refused = new NeverSent(rule);
    onRefuse?.(refused);
    throw refused;
  };
  const guarded: Fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    let method = (init.method ?? request?.method ?? "GET").toUpperCase();
    let url = request ? request.url : String(input);
    let text = await bodyText(init.body, request);
    refuse({ method, url, body: text });
    if (init.redirect === "manual" || init.redirect === "error") return fetch(input, init);
    let body: RequestInit["body"] = init.body ?? text;
    const headers = new Headers(init.headers ?? request?.headers);
    const signal = init.signal ?? request?.signal;
    const domain = siteDomain(origin);
    let res = await fetch(input, { ...init, redirect: "manual" });
    for (let hop = 0; ; hop++) {
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) {
        if (hop > 0) {
          Object.defineProperty(res, "redirected", { value: true });
          Object.defineProperty(res, "url", { value: url });
        }
        return res;
      }
      if (hop >= MAX_HOPS) throw new TypeError(`fetch followed more than ${MAX_HOPS} redirects`);
      const next = new URL(location, url);
      if ((res.status === 303 && method !== "GET" && method !== "HEAD") || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        text = undefined;
        for (const h of BODY_HEADERS) headers.delete(h);
      }
      if ((res.status === 307 || res.status === 308) && body instanceof ReadableStream) {
        throw new TypeError("fetch cannot follow a 307/308 redirect that resends a stream body");
      }
      const from = new URL(url);
      if (next.origin !== from.origin) {
        headers.delete("authorization");
        headers.delete("proxy-authorization");
        if (!onSiteDomain(domain, next.hostname) || (from.protocol === "https:" && next.protocol !== "https:")) headers.delete("cookie");
      }
      refuse({ method, url: next.href, body: text });
      await res.body?.cancel().catch(() => {});
      url = next.href;
      res = await fetch(url, { ...init, method, headers, body, signal, redirect: "manual" });
    }
  };
  Object.defineProperty(guarded, GUARDED, { value: true });
  return guarded;
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
