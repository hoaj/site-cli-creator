// `check` (SPEC §10): calls every read Operation live in chain order and validates it against
// its Contract. With --writes (or --op <write>) it also drives each write's trigger(page) in
// headless Chrome, intercepts the write request, compares its shape and aborts it. Never writes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Request as PwRequest, Route } from "playwright-core";
import type { Client } from "./call";
import { ContractError, Failure, type DriftEntry } from "./envelope";
import { driftFingerprint, errorName, operationSegment, zodDiff } from "./fingerprint";
import { closeContext, launch, launchInMemory, profileState } from "./login";
import { isConstantNeed, isPickNeed, isSessionNeed, neverCheckable, neverCheckedWarning } from "./needs";
import type { Operation } from "./operation";
import { ensureStateDir, profileDir, stateDir } from "./session";
import { effectiveOrigin, isLoginHost, tokenMatches, type Site } from "./site";

export type CheckRow = { operation: string; effect: "read" | "write"; status: "ok" | "skipped" | "failed"; reason?: string };
/** `warnings`: read Operations that can never be checked (a required variable nothing in `needs` supplies). */
/** `ok` is false when `warnings` lists an Operation check could not cover; the exit stays 0 (no Drift). */
export type CheckResult = { ok: boolean; operations: CheckRow[]; warnings?: string[] };
export type CheckOptions = { op?: string; writes?: boolean; account?: string };
/**
 * Checks write Operations; returns one entry per Operation, null when its request still matches.
 * `reads` are the registry's read Operations: requests matching them may pass while a trigger runs.
 * `declaredWrites` are all the registry's write Operations: they are always aborted (triggerVerdict).
 */
export type WriteChecker = (writes: Operation[], reads: Operation[], declaredWrites?: Operation[]) => Promise<Map<string, DriftEntry | null>>;

/** Operations ordered so every Operation comes after the ones it `needs`; ties keep registry order. */
export function chainOrder(ops: Operation[]): Operation[] {
  const byName = new Map(ops.map((o) => [o.name, o]));
  const deps = (op: Operation) =>
    Object.values(op.needs ?? {}).flatMap((n) => {
      if (!isPickNeed(n)) return [];
      if (!byName.has(n.from)) throw new ContractError(`${op.name} needs ${n.from}, which is not in the registry`);
      return [n.from];
    });
  const out: Operation[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (op: Operation) => {
    const s = state.get(op.name);
    if (s === "done") return;
    if (s === "visiting") throw new ContractError(`needs form a cycle at ${op.name}`);
    state.set(op.name, "visiting");
    for (const d of deps(op)) visit(byName.get(d)!);
    state.set(op.name, "done");
    out.push(op);
  };
  for (const op of ops) visit(op);
  return out;
}

/** The Operation named by --op plus every Operation its chain needs. */
export function withChain(ops: Operation[], name: string): Operation[] {
  const byName = new Map(ops.map((o) => [o.name, o]));
  // The Fingerprint writes REST params as {param}; accept that form too.
  const target = byName.get(name) ?? ops.find((o) => operationSegment(o.name) === name);
  if (!target) throw new Failure("input", `No Operation named "${name}". Operations: ${ops.map((o) => o.name).join(", ")}.`);
  const keep = new Set<string>();
  const add = (op: Operation) => {
    if (keep.has(op.name)) return;
    keep.add(op.name);
    for (const n of Object.values(op.needs ?? {})) if (isPickNeed(n) && byName.has(n.from)) add(byName.get(n.from)!);
  };
  add(target);
  return ops.filter((o) => keep.has(o.name));
}

export async function check(client: Client, operations: Operation[], options: CheckOptions, checkWrites?: WriteChecker): Promise<CheckResult> {
  const selected = chainOrder(options.op ? withChain(operations, options.op) : operations);
  const rows: CheckRow[] = [];
  const warnings: string[] = [];
  const drifts: DriftEntry[] = [];
  const results = new Map<string, unknown>();
  const unavailable = new Set<string>();
  const writes: Operation[] = [];
  let account: Promise<string | undefined> | undefined;
  /** The first network, session or input failure: reported only when nothing drifted. */
  let stopped: Failure | undefined;

  for (const op of selected) {
    if (stopped?.kind === "session") {
      // Signed out and the sign-in did not complete: no other Operation can be reached.
      rows.push({ operation: op.name, effect: op.effect, status: "skipped", reason: "session" });
      continue;
    }
    if (op.effect === "write") {
      if (options.writes || (options.op !== undefined && (options.op === op.name || options.op === operationSegment(op.name)))) writes.push(op);
      else rows.push({ operation: op.name, effect: "write", status: "skipped", reason: "run check --writes" });
      continue;
    }
    const skip = (reason: string) => {
      unavailable.add(op.name);
      rows.push({ operation: op.name, effect: "read", status: "skipped", reason });
    };
    try {
      const vars: Record<string, unknown> = {};
      let missing: string | undefined;
      for (const [key, need] of Object.entries(op.needs ?? {})) {
        if (isConstantNeed(need)) {
          vars[key] = need.value;
        } else if (isSessionNeed(need)) {
          if (need.key === "account") vars[key] = await (account ??= client.resolveAccount(options.account));
          else vars[key] = (await client.ensureSession()).ids[need.key];
        } else if (unavailable.has(need.from)) {
          missing = `needs ${need.from}`;
          break;
        } else {
          vars[key] = need.pick(results.get(need.from));
        }
        if (!isConstantNeed(need) && (vars[key] === undefined || vars[key] === null)) {
          missing = `no value for ${key}`;
          break;
        }
      }
      if (missing) {
        skip(missing);
        continue;
      }
      const parsed = op.variables.safeParse(vars);
      if (!parsed.success) {
        const never = neverCheckable(op);
        if (never) {
          skip(`never checkable: ${never.why}`);
          warnings.push(neverCheckedWarning(op.name, never));
        } else skip("needs input the chain does not supply");
        continue;
      }
      results.set(op.name, await client.call(op, vars));
      rows.push({ operation: op.name, effect: "read", status: "ok" });
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      unavailable.add(op.name);
      if (e.kind === "drift") drifts.push({ operation: op.name, fingerprint: e.fingerprint ?? "", diff: e.diff ?? [] });
      else {
        // A Drift found earlier must still be reported (SPEC §10), so a network, session or input
        // failure marks this Operation and check goes on; it decides the exit only if nothing drifted.
        stopped ??= e;
        rows.push({ operation: op.name, effect: "read", status: "failed", reason: e.kind });
      }
    }
  }

  const withTrigger = writes.filter((op) => op.trigger);
  for (const op of writes) if (!op.trigger) rows.push({ operation: op.name, effect: "write", status: "skipped", reason: "no trigger" });
  if (withTrigger.length > 0 && stopped?.kind !== "session") {
    const reads = operations.filter((op) => op.effect === "read");
    const declaredWrites = operations.filter((op) => op.effect === "write");
    try {
      const outcome = await (checkWrites ?? chromeWriteChecker(client.site, client.deps.env, client.fromProfile()))(withTrigger, reads, declaredWrites);
      for (const op of withTrigger) {
        const d = outcome.get(op.name);
        if (d) drifts.push(d);
        else rows.push({ operation: op.name, effect: "write", status: "ok" });
      }
    } catch (e) {
      if (!(e instanceof Failure) || (drifts.length === 0 && !stopped)) throw e;
      stopped ??= e;
      for (const op of withTrigger) rows.push({ operation: op.name, effect: "write", status: "failed", reason: e.kind });
    }
  }

  if (drifts.length > 0) {
    const others = rows.filter((r) => r.status === "failed");
    const also = others.length ? ` ${others.length} other Operation(s) could not be checked (${[...new Set(others.map((r) => r.reason))].join(", ")}).` : "";
    throw new Failure("drift", `check: ${drifts.length} Operation(s) drifted: ${drifts.map((d) => d.operation).join(", ")}.${also}`, { drifts });
  }
  if (stopped) throw stopped;
  return { ok: warnings.length === 0, operations: rows, ...(warnings.length ? { warnings } : {}) };
}

// ---- write checks in Chrome ----

export type Captured = { method: string; url: URL; body: unknown; contentType?: string };

const mediaType = (contentType: string | undefined) => (contentType ?? "").split(";")[0]!.trim().toLowerCase();

/** The encoding a content-type names: "form", "json", or undefined when it says neither. */
function bodyEncoding(contentType: string | undefined): "json" | "form" | undefined {
  const type = mediaType(contentType);
  if (type === "application/x-www-form-urlencoded") return "form";
  if (type === "application/json" || /^application\/[\w.+-]*\+json$/.test(type)) return "json";
  return undefined;
}

/**
 * A captured request body, read by its content-type: a form body becomes an object of its fields
 * (the last value of a repeated key), anything else is JSON when it parses and text when not.
 */
export function parseCaptured(text: string | null, contentType?: string): unknown {
  if (!text) return undefined;
  if (bodyEncoding(contentType) === "form") return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---- GraphQL documents (mirrors tools/lib/graphql.ts describeQuery; the runtime never imports tools) ----

type GraphqlType = "query" | "mutation" | "subscription";

/** String literals, block strings and comments removed: a mutation word inside them is no definition. */
const stripNoise = (query: string) => query.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, "");

/** Every operation definition at brace depth 0 (fields named `mutation` inside a selection don't count). */
function topLevelDefinitions(code: string): { type: GraphqlType; name: string | null }[] {
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

/**
 * The operation one GraphQL document runs: the definition its operationName selects, else its only
 * definition (or the `{ … }` shorthand query). `type` is "unknown" whenever that is not certain:
 * no query text (a persisted query sent as a hash), several definitions and no operationName, an
 * operationName the text does not define, or text that is no GraphQL. `name` is the operationName
 * when one was sent.
 */
export function graphqlOperation(doc: unknown): { type: GraphqlType | "unknown"; name: string | null } {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { type: "unknown", name: null };
  const d = doc as { operationName?: unknown; query?: unknown };
  const requested = typeof d.operationName === "string" && d.operationName !== "" ? d.operationName : null;
  if (typeof d.query !== "string") return { type: "unknown", name: requested };
  const code = stripNoise(d.query);
  const defs = topLevelDefinitions(code);
  if (requested) return defs.find((def) => def.name === requested) ?? { type: "unknown", name: requested };
  if (defs.length === 1) return defs[0]!;
  if (defs.length === 0 && code.trim().startsWith("{")) return { type: "query", name: null };
  return { type: "unknown", name: null };
}

const graphqlDocs = (body: unknown): unknown[] => (Array.isArray(body) ? body : [body]);

/** A document that carries query text or a persisted-query hash. */
const looksGraphql = (doc: unknown) =>
  !!doc &&
  typeof doc === "object" &&
  (typeof (doc as any).query === "string" || (typeof (doc as any).extensions === "object" && (doc as any).extensions !== null && "persistedQuery" in (doc as any).extensions));

/** A POST to the site's GraphQL endpoint, or a JSON body that is a GraphQL document (batch) wherever it goes. */
function isGraphqlRequest(site: Site, origin: string, req: Captured): boolean {
  if (site.graphqlPath && req.url.origin === new URL(origin).origin && req.url.pathname === site.graphqlPath) return true;
  return bodyEncoding(req.contentType) !== "form" && graphqlDocs(req.body).some(looksGraphql);
}

/**
 * Whether a GraphQL request certainly changes no data: every document in it runs a query, or is
 * named by its operationName as a declared read Operation (effect is declared, never inferred). A
 * mutation anywhere it may run, a persisted hash that is no declared read, or anything unclear is
 * a possible write.
 */
function graphqlReadOnly(site: Site, reads: Operation[], origin: string, req: Captured): boolean {
  const docs = graphqlDocs(req.body);
  const onSite = req.url.origin === new URL(origin).origin;
  return (
    docs.length > 0 &&
    docs.every((doc) => {
      const op = graphqlOperation(doc);
      if (op.type === "query") return true;
      return onSite && op.name !== null && reads.some((r) => r.graphql !== undefined && r.name === op.name);
    })
  );
}

export type TriggerVerdict = "target" | "pass" | "abort";

/**
 * What happens to one request while a write's trigger(page) runs:
 * - the write under check is captured and aborted ("target");
 * - GET/HEAD/OPTIONS pass, and so do non-GET requests to a login host;
 * - a GraphQL request (a POST to site.graphqlPath, or a GraphQL document sent anywhere) is decided
 *   by its documents alone: it passes only when every document runs a query or is a declared read
 *   Operation (graphqlReadOnly). No URL rule (tokenRequest, readOnlyRequests) lets one through, so a
 *   mutation after a fragment or another definition, or a persisted mutation sent as a hash, never
 *   reaches the site;
 * - other non-GET requests pass when they are a declared read Operation, match the login's
 *   tokenRequest or site.readOnlyRequests;
 * - every other request, and every other declared write Operation, is aborted.
 */
export function triggerVerdict(site: Site, target: Operation, writes: Operation[], reads: Operation[], origin: string, req: Captured): TriggerVerdict {
  if (matchesOperation(site, target, origin, req)) return "target";
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return "pass";
  if (writes.some((w) => w !== target && matchesOperation(site, w, origin, req))) return "abort";
  const url = req.url.href;
  if (isLoginHost(site, url)) return "pass";
  if (isGraphqlRequest(site, origin, req)) return graphqlReadOnly(site, reads, origin, req) ? "pass" : "abort";
  if (isDeclaredRead(site, reads, origin, req)) return "pass";
  if (site.auth === "login" && site.login?.tokenRequest !== undefined && tokenMatches(site.login.tokenRequest, url)) return "pass";
  if (isReadOnlyRequest(site, url)) return "pass";
  return "abort";
}

/** site.readOnlyRequests: a string matches as a substring of the URL path, a RegExp is tested against the whole URL. */
export function isReadOnlyRequest(site: Site, url: string): boolean {
  const list = site.readOnlyRequests ?? [];
  if (list.length === 0) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return list.some((p) => (typeof p === "string" ? pathname.includes(p) : new RegExp(p.source, p.flags.replace("g", "")).test(url)));
}

function restPattern(path: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = path
    .split(/((?<=\/):[A-Za-z_]\w*)/)
    .map((part) => {
      if (/^:[A-Za-z_]\w*$/.test(part)) {
        keys.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return { re: new RegExp(`^${src}/?$`), keys };
}

/** Whether a request is this Operation's: REST by method + path pattern, GraphQL by the operation it runs (operationName, else its only definition). */
export function matchesOperation(site: Site, op: Operation, origin: string, req: Captured): boolean {
  if (req.url.origin !== new URL(origin).origin) return false;
  if (op.graphql !== undefined) {
    if (req.method !== "POST" || req.url.pathname !== site.graphqlPath) return false;
    return graphqlDocs(req.body).some((d) => graphqlOperation(d).name === op.name);
  }
  return !!op.rest && req.method === op.rest.method && restPattern(op.rest.path).re.test(req.url.pathname);
}

/**
 * A request every part of which is a declared read Operation (a GraphQL batch only if every
 * document in it is). Such requests pass, so pages that load data through POST still render.
 */
export function isDeclaredRead(site: Site, reads: Operation[], origin: string, req: Captured): boolean {
  if (req.url.origin !== new URL(origin).origin) return false;
  if (site.graphqlPath && req.method === "POST" && req.url.pathname === site.graphqlPath) {
    const docs = Array.isArray(req.body) ? req.body : [req.body];
    const gql = reads.filter((op) => op.graphql !== undefined);
    return docs.length > 0 && docs.every((d) => gql.some((op) => matchesOperation(site, op, origin, { ...req, body: d })));
  }
  return reads.some((op) => op.rest !== undefined && matchesOperation(site, op, origin, req));
}

/**
 * The variables a captured request carries: GraphQL `variables`, or for REST the path params, the
 * query string and the body's fields (JSON or form), all at the top level. A body that is no object
 * (a JSON array or scalar, or text) is the one variable `body`. draft-contract drafts REST Contracts
 * in the same convention (reference/contracts.md).
 */
export function capturedVariables(op: Operation, req: Captured): unknown {
  if (op.graphql !== undefined) {
    const docs = Array.isArray(req.body) ? req.body : [req.body];
    const doc: any = docs.find((d: any) => d?.operationName === op.name) ?? docs[0];
    return doc?.variables ?? {};
  }
  const { re, keys } = restPattern(op.rest!.path);
  const m = re.exec(req.url.pathname);
  const vars: Record<string, unknown> = {};
  keys.forEach((k, i) => (vars[k] = decodeURIComponent(m?.[i + 1] ?? "")));
  for (const [k, v] of req.url.searchParams) vars[k] = v;
  const body = req.body;
  if (body && typeof body === "object" && !Array.isArray(body)) Object.assign(vars, body);
  else if (body !== undefined) vars.body = body;
  return vars;
}

/**
 * The locator a failed trigger step waited for, from Playwright's error ("waiting for
 * getByLabel('Ny note')"): code from the Contract, not user data. Made safe for a Fingerprint
 * segment (no colons, one line, at most 80 characters); "" when the error names none.
 */
export function triggerStep(error: unknown): string {
  const message = (error instanceof Error ? error.message : "").replace(/\x1b\[[0-9;]*m/g, "");
  const waited = /waiting for (.+?)\s*$/m.exec(message)?.[1] ?? "";
  return waited
    .replace(/\s+to be (?:visible|enabled|attached|stable|editable|hidden)\b.*$/, "")
    .replace(/:/g, "=")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function compareWrite(site: Site, op: Operation, req: Captured | undefined, triggerError?: unknown): DriftEntry | null {
  const fp = (breakType: "trigger" | "request", path: string, code: string) => driftFingerprint(site, op.name, breakType, path, code);
  if (triggerError !== undefined && !req) {
    const code = errorName(triggerError);
    const path = triggerStep(triggerError);
    return { operation: op.name, fingerprint: fp("trigger", path, code), diff: [{ path, code }] };
  }
  if (!req) return { operation: op.name, fingerprint: fp("trigger", "", "no_request"), diff: [{ path: "", code: "no_request" }] };
  if (op.rest?.body) {
    // The body's encoding is part of the request's shape: a site that now expects JSON instead of a
    // form post (or the reverse) would reject what the CLI sends. Type names only, never values.
    const expected = op.rest.bodyType ?? "json";
    const received = bodyEncoding(req.contentType);
    if (received !== undefined && received !== expected) {
      return { operation: op.name, fingerprint: fp("request", "", "body_type"), diff: [{ path: "", code: "body_type", expected, received }] };
    }
  }
  const vars = capturedVariables(op, req);
  const parsed = op.variables.safeParse(vars);
  if (parsed.success) return null;
  const diff = zodDiff(parsed.error.issues, vars, op.variables);
  return { operation: op.name, fingerprint: fp("request", diff[0]?.path ?? "", diff[0]?.code ?? ""), diff };
}

const REQUEST_WAIT_MS = 5_000;
const ACTION_TIMEOUT_MS = 15_000;

/**
 * Runs triggers in headless Chrome: for auth "none" a temporary profile, deleted afterwards; for a
 * login, the CLI's own profile, or with `fromProfile` (the profile `login --from-profile` used,
 * Client.fromProfile()) a context with no profile on disk holding that profile's cookies and the
 * origin's localStorage, as the CLI's own profile would hold them, so a sign-in carried over from a
 * Capture needs no second sign-in and nothing is written.
 */
export function chromeWriteChecker(site: Site, env = process.env, fromProfile?: string): WriteChecker {
  return async (writes, reads, declaredWrites = writes) => {
    const out = new Map<string, DriftEntry | null>();
    const seeded = site.auth === "login" && fromProfile !== undefined;
    const temp = site.auth === "none" ? mkdtempSync(join(tmpdir(), `${site.skill}-check-`)) : undefined;
    const profile = temp ?? profileDir(ensureStateDir(stateDir(site, env)));
    let context: BrowserContext | undefined;
    try {
      if (seeded) context = await launchInMemory(site, true, env, await profileState(site, fromProfile, env, { localStorage: true }));
      else {
        if (!temp) ensureStateDir(profile);
        context = await launch(site, profile, true, env);
      }
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      const origin = effectiveOrigin(site, env);
      const signIn = seeded ? `the sign-in carried over from ${fromProfile}` : "the CLI's Chrome profile";
      for (const op of writes) out.set(op.name, await checkOne(site, context, op, declaredWrites, reads, origin, signIn));
    } finally {
      if (context) await closeContext(context);
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
    return out;
  };
}

async function checkOne(
  site: Site,
  context: BrowserContext,
  op: Operation,
  writes: Operation[],
  reads: Operation[],
  origin: string,
  signIn: string,
): Promise<DriftEntry | null> {
  let captured: Captured | undefined;
  let signedOut = false;
  const handler = async (route: Route) => {
    const req = route.request();
    const contentType = (await req.allHeaders())["content-type"];
    const c: Captured = { method: req.method(), url: new URL(req.url()), body: parseCaptured(req.postData(), contentType), contentType };
    const verdict = triggerVerdict(site, op, writes, reads, origin, c);
    if (verdict === "target") captured ??= c;
    return verdict === "pass" ? route.continue() : route.abort();
  };
  await context.route("**/*", handler);
  const page = await context.newPage();
  page.on("framenavigated", (frame) => {
    if (!frame.parentFrame() && site.auth === "login" && isLoginHost(site, frame.url())) signedOut = true;
  });
  let triggerError: unknown;
  try {
    await op.trigger!(page);
  } catch (e) {
    triggerError = e;
  }
  for (let waited = 0; !captured && triggerError === undefined && waited < REQUEST_WAIT_MS; waited += 100) await Bun.sleep(100);
  await page.close().catch(() => {});
  await context.unroute("**/*", handler);
  if (!captured && signedOut) {
    throw new Failure("session", `${signIn[0]!.toUpperCase()}${signIn.slice(1)} is signed out of ${site.origin}, so ${op.name} could not be checked.`);
  }
  return compareWrite(site, op, captured, triggerError);
}
