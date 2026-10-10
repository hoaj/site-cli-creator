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
import { launch } from "./login";
import type { Operation } from "./operation";
import { ensureStateDir, profileDir, stateDir } from "./session";
import { effectiveOrigin, isLoginHost, tokenMatches, type Site } from "./site";

export type CheckRow = { operation: string; effect: "read" | "write"; status: "ok" | "skipped"; reason?: string };
export type CheckResult = { ok: true; operations: CheckRow[] };
export type CheckOptions = { op?: string; writes?: boolean; account?: string };
/**
 * Checks write Operations; returns one entry per Operation, null when its request still matches.
 * `reads` are the registry's read Operations: requests matching them may pass while a trigger runs.
 * `declaredWrites` are all the registry's write Operations: they are always aborted (triggerVerdict).
 */
export type WriteChecker = (writes: Operation[], reads: Operation[], declaredWrites?: Operation[]) => Promise<Map<string, DriftEntry | null>>;

const isSessionNeed = (n: object): n is { from: "session"; key: string } => "key" in n;

/** Operations ordered so every Operation comes after the ones it `needs`; ties keep registry order. */
export function chainOrder(ops: Operation[]): Operation[] {
  const byName = new Map(ops.map((o) => [o.name, o]));
  const deps = (op: Operation) =>
    Object.values(op.needs ?? {}).flatMap((n) => {
      if (isSessionNeed(n)) return [];
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
    for (const n of Object.values(op.needs ?? {})) if (!isSessionNeed(n) && byName.has(n.from)) add(byName.get(n.from)!);
  };
  add(target);
  return ops.filter((o) => keep.has(o.name));
}

export async function check(client: Client, operations: Operation[], options: CheckOptions, checkWrites?: WriteChecker): Promise<CheckResult> {
  const selected = chainOrder(options.op ? withChain(operations, options.op) : operations);
  const rows: CheckRow[] = [];
  const drifts: DriftEntry[] = [];
  const results = new Map<string, unknown>();
  const unavailable = new Set<string>();
  const writes: Operation[] = [];
  let account: Promise<string | undefined> | undefined;

  for (const op of selected) {
    if (op.effect === "write") {
      if (options.writes || (options.op !== undefined && (options.op === op.name || options.op === operationSegment(op.name)))) writes.push(op);
      else rows.push({ operation: op.name, effect: "write", status: "skipped", reason: "run check --writes" });
      continue;
    }
    const skip = (reason: string) => {
      unavailable.add(op.name);
      rows.push({ operation: op.name, effect: "read", status: "skipped", reason });
    };
    const vars: Record<string, unknown> = {};
    let missing: string | undefined;
    for (const [key, need] of Object.entries(op.needs ?? {})) {
      if (isSessionNeed(need)) {
        if (need.key === "account") vars[key] = await (account ??= client.resolveAccount(options.account));
        else vars[key] = (await client.ensureSession()).ids[need.key];
      } else if (unavailable.has(need.from)) {
        missing = `needs ${need.from}`;
        break;
      } else {
        vars[key] = need.pick(results.get(need.from));
      }
      if (vars[key] === undefined || vars[key] === null) {
        missing = `no value for ${key}`;
        break;
      }
    }
    if (missing) {
      skip(missing);
      continue;
    }
    if (!op.variables.safeParse(vars).success) {
      skip("needs input the chain does not supply");
      continue;
    }
    try {
      results.set(op.name, await client.call(op, vars));
      rows.push({ operation: op.name, effect: "read", status: "ok" });
    } catch (e) {
      if (!(e instanceof Failure) || e.kind !== "drift") throw e;
      unavailable.add(op.name);
      drifts.push({ operation: op.name, fingerprint: e.fingerprint ?? "", diff: e.diff ?? [] });
    }
  }

  const withTrigger = writes.filter((op) => op.trigger);
  for (const op of writes) if (!op.trigger) rows.push({ operation: op.name, effect: "write", status: "skipped", reason: "no trigger" });
  if (withTrigger.length > 0) {
    const reads = operations.filter((op) => op.effect === "read");
    const declaredWrites = operations.filter((op) => op.effect === "write");
    const outcome = await (checkWrites ?? chromeWriteChecker(client.site, client.deps.env))(withTrigger, reads, declaredWrites);
    for (const op of withTrigger) {
      const d = outcome.get(op.name);
      if (d) drifts.push(d);
      else rows.push({ operation: op.name, effect: "write", status: "ok" });
    }
  }

  if (drifts.length > 0) {
    throw new Failure("drift", `check: ${drifts.length} Operation(s) drifted: ${drifts.map((d) => d.operation).join(", ")}.`, { drifts });
  }
  return { ok: true, operations: rows };
}

// ---- write checks in Chrome ----

export type Captured = { method: string; url: URL; body: unknown };

function parseJson(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const isMutation = (q: unknown) => typeof q === "string" && /^\s*(#[^\n]*\n\s*)*mutation\b/.test(q);

const isGraphqlQuery = (body: unknown) => {
  const docs = Array.isArray(body) ? body : [body];
  return docs.length > 0 && docs.every((d) => d && typeof d === "object" && typeof (d as any).query === "string" && !isMutation((d as any).query));
};

const hasMutation = (body: unknown) =>
  (Array.isArray(body) ? body : [body]).some((d) => d && typeof d === "object" && isMutation((d as any).query));

export type TriggerVerdict = "target" | "pass" | "abort";

/**
 * What happens to one request while a write's trigger(page) runs:
 * - the write under check is captured and aborted ("target");
 * - GET/HEAD/OPTIONS pass, and so do non-GET requests to a login host, declared read Operations,
 *   the login's tokenRequest, site.readOnlyRequests and GraphQL documents whose query text is
 *   no mutation;
 * - every other request is aborted, so an undeclared write never reaches the site. A declared
 *   write Operation, and a GraphQL mutation that is not a declared read, is aborted even when
 *   tokenRequest or readOnlyRequests matches its URL.
 */
export function triggerVerdict(site: Site, target: Operation, writes: Operation[], reads: Operation[], origin: string, req: Captured): TriggerVerdict {
  if (matchesOperation(site, target, origin, req)) return "target";
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return "pass";
  if (writes.some((w) => w !== target && matchesOperation(site, w, origin, req))) return "abort";
  const url = req.url.href;
  if (isLoginHost(site, url)) return "pass";
  if (isDeclaredRead(site, reads, origin, req)) return "pass";
  // A GraphQL mutation that is not a declared read never passes on a URL rule: tokenRequest or
  // readOnlyRequests may well name the GraphQL endpoint itself.
  if (hasMutation(req.body)) return "abort";
  if (site.auth === "login" && site.login?.tokenRequest !== undefined && tokenMatches(site.login.tokenRequest, url)) return "pass";
  if (isReadOnlyRequest(site, url)) return "pass";
  if (isGraphqlQuery(req.body)) return "pass";
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

/** Whether a request is this Operation's: REST by method + path pattern, GraphQL by operationName. */
export function matchesOperation(site: Site, op: Operation, origin: string, req: Captured): boolean {
  if (req.url.origin !== new URL(origin).origin) return false;
  if (op.graphql !== undefined) {
    if (req.method !== "POST" || req.url.pathname !== site.graphqlPath) return false;
    const docs = Array.isArray(req.body) ? req.body : [req.body];
    return docs.some((d: any) => d?.operationName === op.name || new RegExp(`^\\s*(mutation|query)\\s+${op.name}\\b`).test(d?.query ?? ""));
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

/** The variables a captured request carries: GraphQL `variables`, or REST path params + query + JSON body fields. */
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

export function compareWrite(site: Site, op: Operation, req: Captured | undefined, triggerError?: unknown): DriftEntry | null {
  const fp = (breakType: "trigger" | "request", path: string, code: string) => driftFingerprint(site, op.name, breakType, path, code);
  if (triggerError !== undefined && !req) {
    const code = errorName(triggerError);
    return { operation: op.name, fingerprint: fp("trigger", "", code), diff: [{ path: "", code }] };
  }
  if (!req) return { operation: op.name, fingerprint: fp("trigger", "", "no_request"), diff: [{ path: "", code: "no_request" }] };
  const vars = capturedVariables(op, req);
  const parsed = op.variables.safeParse(vars);
  if (parsed.success) return null;
  const diff = zodDiff(parsed.error.issues, vars);
  return { operation: op.name, fingerprint: fp("request", diff[0]?.path ?? "", diff[0]?.code ?? ""), diff };
}

const REQUEST_WAIT_MS = 5_000;
const ACTION_TIMEOUT_MS = 15_000;

export function chromeWriteChecker(site: Site, env = process.env): WriteChecker {
  return async (writes, reads, declaredWrites = writes) => {
    const out = new Map<string, DriftEntry | null>();
    const temp = site.auth === "none" ? mkdtempSync(join(tmpdir(), `${site.skill}-check-`)) : undefined;
    const profile = temp ?? profileDir(ensureStateDir(stateDir(site, env)));
    if (!temp) ensureStateDir(profile);
    let context: BrowserContext | undefined;
    try {
      context = await launch(site, profile, true, env);
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      const origin = effectiveOrigin(site, env);
      for (const op of writes) out.set(op.name, await checkOne(site, context, op, declaredWrites, reads, origin));
    } finally {
      await context?.close().catch(() => {});
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
): Promise<DriftEntry | null> {
  let captured: Captured | undefined;
  let signedOut = false;
  const handler = async (route: Route) => {
    const req = route.request();
    const c: Captured = { method: req.method(), url: new URL(req.url()), body: parseJson(req.postData()) };
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
    throw new Failure("session", `The Chrome profile is signed out of ${site.origin}, so ${op.name} could not be checked.`);
  }
  return compareWrite(site, op, captured, triggerError);
}
