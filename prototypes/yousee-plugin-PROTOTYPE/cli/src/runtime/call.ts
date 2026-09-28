// FIXED TEMPLATE FILE. PROTOTYPE.
// One call = fetch with the cached session, then deterministic classification.
// PROTO_SCENARIO=ok|drift|gqlerror|session|network fakes the site so the
// envelope and exit codes can be seen without a YouSee login.
import { site } from "../site";
import type { Operation } from "./operation";
import { Failure, note } from "./result";
import { loadSession, refreshSession } from "./session";
import { fake } from "./fake";

export async function call(op: Operation, vars: unknown) {
  const v = op.variables.safeParse(vars);
  if (!v.success) throw new Failure("input", `${op.name}: ${v.error.issues[0].path.join(".")} ${v.error.issues[0].message}`);

  let res = await send(op, v.data, await loadSession());
  if (res.status === 401 || res.status === 403) {
    note("session expired, refreshing from Chrome profile");
    res = await send(op, v.data, await refreshSession());          // headless, then headed login
    if (res.status === 401 || res.status === 403)
      throw drift(op, "auth", "", "401/403 right after a fresh login");
  }
  if (res.status === 404 || res.status === 405) throw drift(op, "http", String(res.status), `HTTP ${res.status}`);
  if (res.status >= 500) throw new Failure("network", `${site.origin} isn't responding (${res.status})`);

  const body = res.body as any;
  if (op.graphql && body?.errors?.length) {
    const e = body.errors[0];
    if (e.extensions?.code === "GRAPHQL_VALIDATION_FAILED") throw drift(op, "graphql", e.path?.join(".") ?? "", e.message);
    if (e.extensions?.code === "BAD_USER_INPUT") throw drift(op, "input-rejected", e.path?.join(".") ?? "", e.message);
  }
  const r = op.response.safeParse(body);
  if (!r.success) {
    // Array indices become [] so the same break on any row has one Fingerprint.
    const p = (path: (string | number)[]) => path.map((s) => (typeof s === "number" ? "[]" : s)).join(".").replace(/\.\[\]/g, "[]");
    const i = r.error.issues[0];
    throw drift(op, "zod", `${p(i.path)}:${i.code}`, i.message, r.error.issues.map(({ path, code, message }) => ({ path: p(path), code, message })));
  }
  return r.data;
}

const drift = (op: Operation, breakType: string, path: string, message: string, diff?: unknown) =>
  new Failure("drift", `${op.name}: ${message}`, [site.plugin, op.name, breakType, path].filter(Boolean).join(":"), diff);

async function send(op: Operation, vars: unknown, session: { bearer: string; cookie: string }) {
  if (process.env.PROTO_SCENARIO) return fake(op, process.env.PROTO_SCENARIO);
  const url = op.graphql ? site.origin + site.graphql : site.origin + op.rest!.path;
  try {
    const r = await fetch(url, {
      method: op.graphql ? "POST" : op.rest!.method,
      headers: { authorization: session.bearer, cookie: session.cookie, "content-type": "application/json" },
      body: op.graphql ? JSON.stringify({ operationName: op.name, query: op.graphql, variables: vars }) : undefined,
      redirect: "manual",
    });
    if (r.status >= 300 && r.status < 400) return { status: 401, body: null }; // redirect to login
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    throw new Failure("network", `${site.origin} isn't responding (${(e as Error).message})`);
  }
}
