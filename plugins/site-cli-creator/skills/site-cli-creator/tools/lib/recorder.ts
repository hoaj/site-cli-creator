// The Capture's bookkeeping, separate from the browser so it can be tested
// with plain objects. Input is one request (and maybe its response); output
// is shapes only. Values never leave this module: bodies are reduced to
// shapes, paths are redacted, header values survive only on the allowlist.

import { graphqlFromBody, graphqlFromSearch, type GraphqlCall } from "./graphql";
import {
  bodyShape,
  mediaType,
  mergeBodies,
  mergeShapes,
  parseJson,
  queryShape,
  redactPath,
  shapeOf,
  type BodyShape,
  type Shape,
} from "./shape";

/** Header values kept verbatim: they describe the protocol, never the user. */
export const HEADER_VALUE_ALLOWLIST = new Set([
  "content-type",
  "accept",
  "x-requested-with",
  "apollo-require-preflight",
  "x-apollo-operation-name",
]);

const RECORDED_RESOURCE_TYPES = new Set(["fetch", "xhr", "document", "eventsource"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type Effect = "read" | "write";

export type RequestInfo = {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData: Buffer | null;
  resourceType: string;
};

export type ResponseInfo = {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
};

export type OperationShape = {
  operation: string;
  kind: "graphql" | "rest";
  effect: Effect;
  /** A write let through because it is part of signing in; the agent decides whether it belongs in site.ts. */
  loginFlow?: true;
  resourceType: string;
  host: string;
  method: string;
  path: string;
  graphql?: Omit<GraphqlCall, "variables">;
  request: {
    headers: Record<string, string | null>;
    query?: Shape;
    variables?: Shape;
    body?: BodyShape;
  };
  responses: { status: number; contentType?: string; body: BodyShape }[];
  seen: number;
  aborted: number;
};

type PlannedCall = { key: string; shape: OperationShape; responseIndex?: number };

export type Planned = {
  seq: number;
  calls: PlannedCall[];
  effect: Effect;
  /** Part of signing in (a login host, a token or post-login step): never aborted. */
  loginFlow: boolean;
};

function baseDomain(host: string): string {
  return host.replace(/^www\./, "");
}

// Words that mark a sign-in step. Writes carrying them are never aborted: the
// maintainer must be able to sign in, and the frontend's token and post-login
// calls (POSTs that read) must succeed before the Task's data appears.
const LOGIN_WORDS = new Set([
  "login", "logon", "signin", "signon", "sso", "saml", "saml2", "oauth", "oauth2", "openid", "oidc",
  "auth", "authorize", "authorise", "authenticate", "authentication", "token", "tokens", "session", "sessions",
]);
const LOGIN_HOST_LABELS = new Set(["id", "idp"]);

/** Whether a path, GraphQL operation name or host names a sign-in step (`/oauth/token`, `post-login`, `signIn`). */
export function isLoginFlow(text: string): boolean {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((w, i) => LOGIN_WORDS.has(w) || LOGIN_WORDS.has(w + (words[i + 1] ?? "")));
}

function isLoginHostName(host: string): boolean {
  const first = host.split(".", 1)[0] ?? "";
  return LOGIN_HOST_LABELS.has(first) || isLoginFlow(first);
}

function headerShape(headers: Record<string, string>): Record<string, string | null> {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, string | null> = {};
  for (const name of [...lower.keys()].sort()) {
    if (name.startsWith(":")) continue;
    const value = lower.get(name) as string;
    if (!HEADER_VALUE_ALLOWLIST.has(name)) out[name] = null;
    else out[name] = name === "content-type" ? (mediaType(value) ?? null) : value;
  }
  return out;
}

function mergeHeaders(a: Record<string, string | null>, b: Record<string, string | null>) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = out[k] ?? v;
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y)));
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

export class CaptureRecorder {
  private readonly originHost: string;
  private readonly domain: string;
  private readonly loginHosts: Set<string>;
  private readonly allowWrite: boolean;
  private writeUsed = false;
  private seq = 0;
  private readonly ops = new Map<string, { first: number; shape: OperationShape }>();

  constructor(opts: { origin: string; loginHosts?: string[]; allowWrite?: boolean }) {
    this.originHost = new URL(opts.origin).hostname;
    this.domain = baseDomain(this.originHost);
    this.loginHosts = new Set((opts.loginHosts ?? []).map((h) => h.toLowerCase()));
    this.allowWrite = opts.allowWrite ?? false;
  }

  isLoginHost(host: string): boolean {
    return this.loginHosts.has(host.toLowerCase());
  }

  /** The site origin's host, its parent domain and its subdomains, plus the login hosts. */
  inScope(url: string): boolean {
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      host = u.hostname.toLowerCase();
    } catch {
      return false;
    }
    return host === this.domain || host.endsWith(`.${this.domain}`) || this.isLoginHost(host);
  }

  /** Splits a request into the Operations it carries, or null when it is out of scope. */
  plan(req: RequestInfo): Planned | null {
    if (!this.inScope(req.url)) return null;
    const method = req.method.toUpperCase();
    if (!RECORDED_RESOURCE_TYPES.has(req.resourceType) && READ_METHODS.has(method)) return null;
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    const path = redactPath(url.pathname);
    const contentType = header(req.headers, "content-type");
    const headers = headerShape(req.headers);

    let gql: GraphqlCall[] | null = null;
    if (req.postData && req.postData.length > 0) {
      const parsed = parseJson(req.postData.toString("utf8"));
      if (parsed.ok) gql = graphqlFromBody(parsed.value);
    } else if (method === "GET") {
      gql = graphqlFromSearch(url.searchParams);
    }

    const base = { resourceType: req.resourceType, host, method, path };
    const outcome = () => ({ responses: [], seen: 0, aborted: 0 });
    const loginHost = this.isLoginHost(host) || isLoginHostName(host);

    if (gql) {
      const calls = gql.map((call, index): PlannedCall => {
        const { variables, ...graphql } = call;
        const name = call.operationName ?? "anonymous";
        return {
          key: `graphql ${host} ${name} ${call.operationName ? "" : (call.query ?? "")}`,
          responseIndex: gql && gql.length > 1 ? index : undefined,
          shape: {
            operation: name,
            kind: "graphql",
            effect: call.operationType === "mutation" ? "write" : "read",
            ...base,
            graphql,
            request: { headers, ...(variables ? { variables } : {}) },
            ...outcome(),
          },
        };
      });
      const writes = calls.filter((c) => c.shape.effect === "write");
      const effect: Effect = writes.length > 0 ? "write" : "read";
      const loginFlow = loginHost || (writes.length > 0 && writes.every((c) => isLoginFlow(c.shape.operation)));
      if (loginFlow) for (const c of writes) c.shape.loginFlow = true;
      return { seq: this.seq++, calls, effect, loginFlow };
    }

    const effect: Effect = READ_METHODS.has(method) ? "read" : "write";
    const query = queryShape(url.searchParams);
    const body = req.postData && req.postData.length > 0 ? bodyShape(req.postData, contentType) : undefined;
    const loginFlow = effect === "write" && (loginHost || isLoginFlow(path));
    const shape: OperationShape = {
      operation: `${method} ${path}`,
      kind: "rest",
      effect,
      ...(loginFlow ? { loginFlow: true as const } : {}),
      ...base,
      request: { headers, ...(query ? { query } : {}), ...(body ? { body } : {}) },
      ...outcome(),
    };
    return {
      seq: this.seq++,
      calls: [{ key: `rest ${host} ${method} ${path}`, shape }],
      effect,
      loginFlow,
    };
  }

  /**
   * Read Tasks abort every write. With --write the first write goes through
   * for real and later ones are aborted. Login hosts are never blocked, or the
   * maintainer could not sign in.
   */
  shouldAbort(planned: Planned): boolean {
    if (planned.effect !== "write" || planned.loginFlow) return false;
    if (this.allowWrite && !this.writeUsed) {
      this.writeUsed = true;
      return false;
    }
    return true;
  }

  record(planned: Planned, outcome: { response?: ResponseInfo; aborted?: boolean; headers?: Record<string, string> }) {
    const { response, aborted = false } = outcome;
    let splitBodies: unknown[] | null = null;
    const contentType = response ? mediaType(header(response.headers, "content-type")) : undefined;
    if (response?.body && planned.calls.some((c) => c.responseIndex !== undefined)) {
      const parsed = parseJson(response.body.toString("utf8"));
      if (parsed.ok && Array.isArray(parsed.value)) splitBodies = parsed.value;
    }
    for (const call of planned.calls) {
      const shape: OperationShape = structuredClone(call.shape);
      if (outcome.headers) shape.request.headers = headerShape(outcome.headers);
      shape.seen = 1;
      shape.aborted = aborted ? 1 : 0;
      if (response) {
        const body: BodyShape =
          splitBodies && call.responseIndex !== undefined
            ? { kind: "json", shape: shapeOf(splitBodies[call.responseIndex]) }
            : bodyShape(response.body, contentType);
        shape.responses = [{ status: response.status, ...(contentType ? { contentType } : {}), body }];
      }
      this.add(call.key, planned.seq, shape);
    }
  }

  private add(key: string, seq: number, shape: OperationShape) {
    const existing = this.ops.get(key);
    if (!existing) {
      this.ops.set(key, { first: seq, shape });
      return;
    }
    existing.first = Math.min(existing.first, seq);
    existing.shape = mergeOperation(existing.shape, shape);
  }

  /** Operations in the order the frontend first called them. */
  operations(): OperationShape[] {
    return [...this.ops.values()].sort((a, b) => a.first - b.first).map((o) => o.shape);
  }

  get originHostname(): string {
    return this.originHost;
  }
}

function mergeMaybe(a?: Shape, b?: Shape): Shape | undefined {
  return a && b ? mergeShapes(a, b) : (a ?? b);
}

function mergeOperation(a: OperationShape, b: OperationShape): OperationShape {
  const responses = [...a.responses];
  for (const r of b.responses) {
    const i = responses.findIndex((x) => x.status === r.status);
    if (i === -1) responses.push(r);
    else responses[i] = { ...responses[i]!, body: mergeBodies(responses[i]!.body, r.body) };
  }
  responses.sort((x, y) => x.status - y.status);
  const query = mergeMaybe(a.request.query, b.request.query);
  const variables = mergeMaybe(a.request.variables, b.request.variables);
  const body = a.request.body && b.request.body ? mergeBodies(a.request.body, b.request.body) : (a.request.body ?? b.request.body);
  return {
    ...a,
    effect: a.effect === "write" || b.effect === "write" ? "write" : "read",
    graphql: a.graphql && !a.graphql.query && b.graphql?.query ? b.graphql : a.graphql,
    request: {
      headers: mergeHeaders(a.request.headers, b.request.headers),
      ...(query ? { query } : {}),
      ...(variables ? { variables } : {}),
      ...(body ? { body } : {}),
    },
    responses,
    seen: a.seen + b.seen,
    aborted: a.aborted + b.aborted,
  };
}

/** File names for the shape files: the Operation name made path-safe, unique within one Capture. */
export function shapeFileNames(ops: OperationShape[], originHost: string): string[] {
  const used = new Set<string>();
  return ops.map((op) => {
    let base =
      op.kind === "graphql"
        ? op.operation
        : `${op.method}-${op.path.replace(/:id/g, "id").replace(/^\/|\/$/g, "") || "root"}`;
    if (op.host !== originHost) base = `${op.host}-${base}`;
    base = base.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "operation";
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}`;
    used.add(name.toLowerCase());
    return `${name}.shape.json`;
  });
}
