// FIXED TEMPLATE FILE. PROTOTYPE.
// Built-in commands: help, login, check, report, doctor, version.
// Task commands come from src/commands/*.ts (agent-written), listed in registry.ts.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { site } from "./site";
import { commands, operations } from "./registry";
import { call } from "./runtime/call";
import { EXIT, Failure, emit, emitFailure, note } from "./runtime/result";
import { loadSession, login } from "./runtime/session";
import type { Command } from "./runtime/command";

const LAST = join(tmpdir(), `${site.plugin}-PROTOTYPE-last-error.json`); // real: ~/.yousee/last-error.json
const argv = process.argv.slice(2);

const NEXT: Record<string, string> = {
  drift: `Run \`${site.plugin} report --last\`, show the user the issue link, and stop. Do not work around it with raw calls.`,
  session: `Run \`${site.plugin} login\` (opens Chrome; the user signs in), then rerun the command.`,
  network: "The site isn't responding. Tell the user and stop; don't retry in a loop.",
  input: `Fix the flags; see \`${site.plugin} help\`.`,
};

async function fail(f: Failure): Promise<never> {
  await Bun.write(LAST, JSON.stringify({ at: new Date().toISOString(), version: site.version, argv, kind: f.kind, fingerprint: f.fingerprint, message: f.message, diff: f.diff }));
  emitFailure(f, NEXT[f.kind]);
}

function parseFlags(c: Command, rest: string[]) {
  const shape = (c.args as any).shape as Record<string, any>;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, "");
    if (!(key in shape)) throw new Failure("input", `unknown flag --${key}`);
    const isBool = shape[key]._def.innerType?._def.typeName === "ZodBoolean" || shape[key]._def.typeName === "ZodBoolean";
    out[key] = isBool ? true : rest[++i];
  }
  const r = c.args.safeParse(out);
  if (!r.success) throw new Failure("input", r.error.issues.map((i) => `--${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

const help = () => ({
  plugin: site.plugin,
  version: site.version,
  commands: [
    ...commands.map((c) => ({ name: c.name, summary: c.summary, flags: Object.keys((c.args as any).shape) })),
    { name: "login", summary: "Open Chrome to sign in (only when a command returns kind=session)" },
    { name: "check", summary: "Validate every Operation against the live site", flags: ["op"] },
    { name: "report", summary: "File the last Drift as an issue (dedup by fingerprint)", flags: ["last"] },
    { name: "doctor", summary: "Versions, state dir, Chrome path, gh auth — for reports" },
    { name: "version", summary: "Print version" },
  ],
  exitCodes: EXIT,
});

async function check(only?: string) {
  const session = await loadSession();
  const results: Record<string, unknown> = { session };
  const rows = [];
  for (const op of operations.filter((o) => !only || o.name === only)) {
    if (op.effect === "write") { rows.push({ op: op.name, effect: "write", status: "skipped", why: "PROTOTYPE: would run trigger(page), intercept and abort, compare request shape" }); continue; }
    const vars = Object.fromEntries(Object.entries(op.needs ?? {}).map(([k, n]) => [k, n.pick(results[n.from])]));
    try { results[op.name] = await call(op, vars); rows.push({ op: op.name, effect: "read", status: "ok" }); }
    catch (e) { if (!(e instanceof Failure)) throw e; rows.push({ op: op.name, effect: "read", status: e.kind, fingerprint: e.fingerprint }); if (e.kind !== "drift") break; }
  }
  const drift = rows.find((r) => r.status === "drift") as any;
  if (drift) await fail(new Failure("drift", `check: ${rows.filter((r) => r.status === "drift").length} Operation(s) drifted`, drift.fingerprint, rows));
  const other = rows.find((r) => r.status !== "ok" && r.status !== "skipped") as any;
  if (other) await fail(new Failure(other.status, `check stopped at ${other.op}`));
  return { ok: true, operations: rows };
}

async function report() {
  const f = Bun.file(LAST);
  if (!(await f.exists())) throw new Failure("input", "no failure recorded; nothing to report");
  const last = await f.json();
  if (last.kind !== "drift") throw new Failure("input", `last failure was kind=${last.kind}, only drift is reported`);
  // real: gh issue list --search fingerprint; closed + fixedIn > our version → "update"; open → +1 comment; else create.
  return {
    dryRun: true,
    fingerprint: last.fingerprint,
    wouldRun: [
      `gh issue list --repo ${site.repo} --state all --search "${last.fingerprint} in:body" --json number,state,body`,
      "open match   → gh issue comment <n> --body '+1 (version, os)'",
      "closed match, fixedIn > our version → tell user: update the plugin",
      `no match     → gh issue create --repo ${site.repo} --label drift --title "Drift: ${last.fingerprint}" --body <diff only, no values>`,
    ],
    body: { fingerprint: last.fingerprint, version: last.version, command: last.argv.join(" "), diff: last.diff },
  };
}

async function main() {
  const [a, b] = argv;
  if (!a || a === "help" || a === "-h" || a === "--help") return emit(help());
  if (a === "version" || a === "--version") return emit({ version: site.version });
  if (a === "login") return emit(await login());
  if (a === "check") return emit(await check(argv[argv.indexOf("--op") + 1] && argv.includes("--op") ? argv[argv.indexOf("--op") + 1] : undefined));
  if (a === "report") return emit(await report());
  if (a === "doctor") return emit({ version: site.version, bun: Bun.version, os: process.platform, stateDir: "~/.yousee", chrome: "<detected path>", gh: "<gh auth status>" });
  const c = commands.find((c) => c.name === `${a} ${b}`);
  if (!c) throw new Failure("input", `unknown command "${argv.join(" ")}"; see \`${site.plugin} help\``);
  note(`${c.name}: ${c.uses.map((o) => o.name).join(" → ")}`);
  return emit(await c.run(parseFlags(c, argv.slice(2)), call as any));
}

main().catch(async (e) => {
  if (e instanceof Failure) return fail(e);
  process.stdout.write(JSON.stringify({ error: { kind: "bug", message: String(e?.stack ?? e) } }) + "\n");
  process.exit(EXIT.bug);
});
