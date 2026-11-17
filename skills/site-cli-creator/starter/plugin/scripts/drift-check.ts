// bun scripts/drift-check.ts [--root .] [--repo <owner/name>] [--run-url <url>] [--dry-run]
//
// The daily drift check (.github/workflows/drift-check.yml, site-cli-creator's SPEC §10). For every CLI skill in
// skills/*: install the released binary with the skill's own install.sh, run its read-only
// `check` (never --writes: the check must not touch anyone's account), and open an issue the
// maintainer can act on:
//
//   exit 3 (drift)    one issue per Fingerprint, titled with the Fingerprint exactly, label drift:
//                     the same title the Feedback skill writes, so a user's report and the daily
//                     check never file the same Drift twice (and, like it, a closed one counts
//                     while its fix is not released yet)
//   exit 1/2 (error)  "check: <plugin>:<skill>: the daily check failed (<kind>)", label bug
//   exit 4 (session)  "ci-session: <plugin>:<skill>: …", label ci-session: the CI session expired
//   exit 5 (network)  reported in the run's summary only
//
// A skill whose site.ts says `dailyCheck: false` (the maintainer's answer when add-skill asked) is left out.
// A login skill is checked only when the secret SESSION_<PLUGIN>_<SKILL> holds its session.json
// (raw JSON or base64); the workflow passes all secrets as SECRETS_JSON. Without it the skill is
// skipped with a notice. The check's output carries shapes and type names only, never site values,
// and this script prints none of it beyond the Fingerprints and type-only diffs the issues hold.
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flag } from "./run";
import { compareVersions } from "./versions";

export type Result = "ok" | "drift" | "error" | "session" | "no-session" | "network" | "install" | "off";
/** `dailyCheck`: site.ts's answer to add-skill's question; false keeps the skill out of the daily check. */
export type Skill = { plugin: string; skill: string; dir: string; version: string; auth: "login" | "none"; dailyCheck: boolean };
export type Drift = { operation: string; fingerprint: string; diff: unknown[] };
export type Outcome = { result: Result; detail: string; drifts: Drift[]; kind?: string };
export type Issue = { number: number; title: string; state: "OPEN" | "CLOSED"; closedAt?: string; labels?: { name: string }[] };
/** `isolated`: the child sees none of this job's secrets (SECRETS_JSON, SESSION_*, GH_TOKEN, GITHUB_TOKEN). */
export type Exec = (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number; isolated?: boolean }) => { code: number; stdout: string; stderr: string };

/** Every CLI skill of the plugin: a skills/<skill>/ folder with install.sh and cli/src/site.ts (not the Feedback or Deploy skill). */
export function discover(root: string): Skill[] {
  const out: Skill[] = [];
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return out;
  for (const skill of readdirSync(skillsDir).sort()) {
    const dir = join(skillsDir, skill);
    const site = join(dir, "cli", "src", "site.ts");
    if (!existsSync(join(dir, "install.sh")) || !existsSync(site)) continue;
    const src = readFileSync(site, "utf8");
    const field = (name: string) => new RegExp(`^\\s*${name}:\\s*"([^"]+)"`, "m").exec(src)?.[1];
    out.push({
      plugin: field("plugin") ?? "__PLUGIN__",
      skill: field("skill") ?? skill,
      dir,
      version: field("version") ?? "unknown",
      auth: field("auth") === "login" ? "login" : "none",
      // Absent (a skill made before the question existed) is on.
      dailyCheck: !/^\s*dailyCheck:\s*false\b/m.test(src),
    });
  }
  return out;
}

/** The secret that holds a login skill's CI session: SESSION_<PLUGIN>_<SKILL>, upper case. */
export function secretName(s: Pick<Skill, "plugin" | "skill">): string {
  return `SESSION_${s.plugin}_${s.skill}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** session.json text from a secret holding the raw JSON or its base64. Null when it is neither. */
export function sessionText(secret: string | undefined): string | null {
  if (!secret || !secret.trim()) return null;
  const raw = secret.trim();
  if (raw.startsWith("{")) return raw;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8").trim();
    return decoded.startsWith("{") ? decoded : null;
  } catch {
    return null;
  }
}

/** The exit code realExec reports for a child its time limit killed. */
export const TIMED_OUT = 124;

/** What one `check` run means, from its exit code and its stdout (one JSON document). */
export function classify(code: number, stdout: string): Outcome {
  let doc: any = null;
  try {
    doc = JSON.parse(stdout);
  } catch {
    // a crash before the envelope: handled as an error below
  }
  const err = doc?.error;
  if (code === 0 && doc && !err) {
    const ops = Array.isArray(doc.operations) ? doc.operations : [];
    const ok = ops.filter((o: { status?: string }) => o.status === "ok").length;
    const warnings = Array.isArray(doc.warnings) ? doc.warnings.length : 0;
    return { result: "ok", detail: `${ok} Operation(s) ok${warnings ? `, ${warnings} not checkable` : ""}`, drifts: [] };
  }
  // Killed by its time limit (realExec's 124): the site hung, which is the site not answering.
  if (code === TIMED_OUT && !err) return { result: "network", detail: "check timed out", drifts: [] };
  const kind: string = err?.kind ?? (code === 3 ? "drift" : code === 4 ? "session" : code === 5 ? "network" : "bug");
  if (kind === "drift") {
    const drifts: Drift[] = (Array.isArray(err?.drifts) ? err.drifts : []).filter((d: Drift) => d?.fingerprint);
    if (drifts.length === 0 && err?.fingerprint) drifts.push({ operation: "", fingerprint: err.fingerprint, diff: err.diff ?? [] });
    // Drift with no Fingerprint to file under: an error the maintainer must see, never a silent pass.
    if (drifts.length === 0) return { result: "error", detail: `check reported drift with no Fingerprint (exit ${code})`, drifts: [], kind };
    return { result: "drift", detail: `${drifts.length} Operation(s) drifted: ${drifts.map((d) => d.operation || d.fingerprint).join(", ")}`, drifts, kind };
  }
  if (kind === "session") return { result: "session", detail: "the CI session is signed out or expired", drifts: [], kind };
  if (kind === "network") return { result: "network", detail: "the site did not answer", drifts: [], kind };
  return { result: "error", detail: `check failed (${kind}, exit ${code})`, drifts: [], kind };
}

export const errorTitle = (s: Skill, kind: string) => `check: ${s.plugin}:${s.skill}: the daily check failed (${kind})`;
export const sessionTitle = (s: Skill) => `ci-session: ${s.plugin}:${s.skill}: the daily check needs a new session`;

export type IssuePlan = { title: string; labels: string[]; body: string; existing?: number };

/** The version in a `fixed-in:vX.Y.Z` label, else null. */
export function fixedIn(issue: Issue): string | null {
  for (const { name } of issue.labels ?? []) {
    const m = /^fixed-in:v(\d+\.\d+\.\d+)$/.exec(name);
    if (m) return m[1]!;
  }
  return null;
}

/** The closed issue closed last (by `closedAt`, else the highest number). */
function lastClosed(closed: Issue[]): Issue | undefined {
  const at = (i: Issue) => Date.parse(i.closedAt ?? "") || 0;
  return [...closed].sort((a, b) => at(b) - at(a) || b.number - a.number)[0];
}

/**
 * The closed issue that already stands for this Drift, decided as the Feedback skill decides it: by the most
 * recently closed match, against the highest fixed-in label among all of them. It stands when that issue has no
 * fixed-in label (its fix is merged, not released yet), or the highest fix shipped in a version newer than the
 * one checked. Null when the fix shipped at or below that version: the Drift came back.
 */
export function pendingFix(closed: Issue[], s: Skill): Issue | null {
  const last = lastClosed(closed);
  if (!last) return null;
  if (fixedIn(last) === null) return last;
  const highest = closed.map(fixedIn).filter((v): v is string => v !== null).sort(compareVersions).at(-1)!;
  return s.version !== "unknown" && compareVersions(highest, s.version) > 0 ? last : null;
}

/** Where a skill keeps session.json on the maintainer's machine (SPEC §7). */
export function stateDir(s: Pick<Skill, "plugin" | "skill">): string {
  return s.plugin === s.skill ? `~/.${s.plugin}` : `~/.${s.plugin}-${s.skill}`;
}

/**
 * The issues an outcome calls for. `existing` is set when an issue already stands for it: an open
 * one with that exact title, or (Drift) a closed one whose fix is not released at this version yet.
 */
export function planIssues(s: Skill, o: Outcome, open: Issue[], runUrl: string | undefined, closed: Issue[], repo: string): IssuePlan[] {
  const exact = (title: string) => open.find((i) => i.title === title && i.state === "OPEN")?.number;
  const run = runUrl ? `\n\nRun: ${runUrl}` : "";
  if (o.result === "drift") {
    return o.drifts.map((d) => {
      const same = closed.filter((i) => i.title === d.fingerprint);
      const back = lastClosed(same);
      return {
        title: d.fingerprint,
        labels: ["drift"],
        existing: exact(d.fingerprint) ?? pendingFix(same, s)?.number,
        body: [
          `The daily check found Drift in \`${s.plugin}\` ${s.version}, skill \`${s.skill}\`${d.operation ? `, Operation \`${d.operation}\`` : ""}: the site changed away from the Contract.`,
          "",
          "Type-only diff (no site values):",
          "",
          "```json",
          JSON.stringify(d.diff ?? [], null, 2),
          "```",
          back ? `\nThis Drift was reported before in #${back.number} and has come back.` : "",
          "",
          "Fix it with site-cli-creator's `fix` mode. Filed by the daily drift check." + run,
        ].join("\n"),
      };
    });
  }
  if (o.result === "error") {
    const title = errorTitle(s, o.kind ?? "bug");
    return [{
      title,
      labels: ["bug"],
      existing: exact(title),
      body: `The daily \`check\` of \`${s.plugin}\` ${s.version}, skill \`${s.skill}\`, failed with kind \`${o.kind}\` instead of passing or reporting Drift. Run it locally (\`skills/${s.skill}/bin/${s.skill} check\`) to see the envelope. Filed by the daily drift check.${run}`,
    }];
  }
  if (o.result === "session") {
    const title = sessionTitle(s);
    return [{
      title,
      labels: ["ci-session"],
      existing: exact(title),
      body: [
        `The daily check of \`${s.plugin}\`, skill \`${s.skill}\`, could not sign in: its CI session expired or was signed out. Until it is renewed, the skill is not checked.`,
        "",
        "To renew it, on the maintainer's machine, sign in in a state dir of its own (a copy of your own session.json would share its refresh token with your machine, and whichever renews first spends the other's):",
        "",
        "```sh",
        `cd skills/${s.skill} && export SITE_CLI_HOME="$(mktemp -d)" && bin/${s.skill} login`,
        `gh secret set ${secretName(s)} --repo ${repo} < "$SITE_CLI_HOME/session.json" && rm -rf "$SITE_CLI_HOME"`,
        "```",
        "",
        `Then close this issue. (Your own sign-in stays in ${stateDir(s)}/.) Filed by the daily drift check.${run}`,
      ].join("\n"),
    }];
  }
  return [];
}

/** This process's env without the job's secrets, for install.sh and the CLI. */
export function isolatedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === "SECRETS_JSON" || k === "GH_TOKEN" || k === "GITHUB_TOKEN" || k.startsWith("SESSION_")) continue;
    out[k] = v;
  }
  return out;
}

const realExec: Exec = (cmd, opts = {}) => {
  const base = opts.isolated ? isolatedEnv(process.env) : process.env;
  const p = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: { ...base, ...(opts.env ?? {}) },
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    timeout: opts.timeoutMs,
  });
  // No exit code: its time limit (or a signal) killed it.
  return { code: p.exitCode ?? TIMED_OUT, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) ?? "";
}

/** Installs and checks one skill. The session, if any, lives in a temp state dir removed afterwards. */
export function checkSkill(s: Skill, secrets: Record<string, string>, exec: Exec = realExec, env: Record<string, string | undefined> = process.env): Outcome {
  if (!s.dailyCheck) return { result: "off", detail: "skipped: dailyCheck is false in site.ts", drifts: [] };
  if (s.auth === "login" && !sessionText(secrets[secretName(s)])) {
    return { result: "no-session", detail: `skipped: no ${secretName(s)} secret`, drifts: [] };
  }
  // install.sh falls back to `gh release download` for a private repo: it gets the job's read-only token, the
  // check never does.
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  const install = exec(["bash", join(s.dir, "install.sh")], { timeoutMs: 300_000, isolated: true, ...(token ? { env: { GH_TOKEN: token } } : {}) });
  if (install.code !== 0) return { result: "install", detail: lastLine(install.stderr) || "install.sh failed", drifts: [] };
  const state = mkdtempSync(join(tmpdir(), `check-${s.skill}-`));
  try {
    if (s.auth === "login") {
      writeFileSync(join(state, "session.json"), sessionText(secrets[secretName(s)])!, { mode: 0o600 });
      chmodSync(join(state, "session.json"), 0o600);
    }
    const bin = join(s.dir, "bin", process.platform === "win32" ? `${s.skill}.exe` : s.skill);
    // No one can sign in on a runner: an expired session must end as kind "session", not open Chrome.
    const r = exec([bin, "check"], { env: { SITE_CLI_HOME: state, SITE_CLI_NONINTERACTIVE: "1" }, timeoutMs: 300_000, isolated: true });
    return classify(r.code, r.stdout);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

function ghIssues(exec: Exec, repo: string, title: string): Issue[] {
  const r = exec(["gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "50", "--search", `"${title}" in:title`, "--json", "number,title,state,closedAt,labels"]);
  if (r.code !== 0) throw new Error(`gh issue list failed: ${lastLine(r.stderr)}`);
  return (JSON.parse(r.stdout) as Issue[]).filter((i) => i.title === title);
}

/** Opens the planned issues that are not open yet; returns every issue number the run stands for. */
export function fileIssues(plans: IssuePlan[], repo: string, exec: Exec, dryRun: boolean, log: (s: string) => void): number[] {
  const numbers: number[] = [];
  for (const p of plans) {
    if (p.existing) {
      numbers.push(p.existing);
      log(`  already filed: #${p.existing} ${p.title}`);
      continue;
    }
    if (dryRun) {
      log(`  would open: ${p.title} [${p.labels.join(", ")}]`);
      continue;
    }
    const args = ["gh", "issue", "create", "--repo", repo, "--title", p.title, "--body-file", "-"];
    for (const l of p.labels) args.push("--label", l);
    const r = exec(args, { stdin: p.body });
    if (r.code !== 0) throw new Error(`gh issue create failed: ${lastLine(r.stderr)}`);
    const n = Number(/\/issues\/(\d+)/.exec(r.stdout)?.[1]);
    if (n) numbers.push(n);
    log(`  opened: ${r.stdout.trim()}`);
  }
  return numbers;
}

export function main(argv: string[], exec: Exec = realExec, env: Record<string, string | undefined> = process.env): number {
  const root = flag(argv, "--root") ?? ".";
  const repo = flag(argv, "--repo") ?? env.GITHUB_REPOSITORY ?? "__REPO__";
  const runUrl = flag(argv, "--run-url");
  const dryRun = argv.includes("--dry-run");
  let secrets: Record<string, string> = {};
  try {
    secrets = JSON.parse(env.SECRETS_JSON || "{}");
  } catch {
    console.error("SECRETS_JSON is not JSON; checking without sessions");
  }
  for (const [k, v] of Object.entries(env)) if (k.startsWith("SESSION_") && v) secrets[k] = v;

  const summary: string[] = ["| Skill | Version | Result | Detail | Issues |", "|---|---|---|---|---|"];
  // A skill that could not be checked at all (no binary, a crash) or an issue that could not be filed turns
  // the run red, so the maintainer hears of it; Drift, a failing check and a session are the issues' to tell.
  let red = false;
  for (const s of discover(root)) {
    console.error(`${s.plugin}:${s.skill} ${s.version}`);
    let o: Outcome;
    try {
      o = checkSkill(s, secrets, exec, env);
    } catch (e) {
      // One skill's crash (a binary install.sh did not leave) must not stop the others.
      o = { result: "error", detail: `check could not run: ${(e as Error).message}`.slice(0, 300), drifts: [], kind: "crash" };
    }
    if (o.result === "install" || o.kind === "crash") red = true;
    console.error(`  ${o.result}: ${o.detail}`);
    // A login skill without its secret is a notice, not a failure: the run stays green.
    if (o.result === "no-session") console.log(`::notice title=${s.skill} not checked::${s.skill} is a login skill and the secret ${secretName(s)} is not set (README: Daily drift check).`);
    let issues: number[] = [];
    if (["drift", "error", "session"].includes(o.result)) {
      // A GitHub failure must not lose the run: log it, note it in the summary, go on.
      try {
        const titles = o.result === "drift" ? o.drifts.map((d) => d.fingerprint) : [o.result === "error" ? errorTitle(s, o.kind ?? "bug") : sessionTitle(s)];
        const found = titles.flatMap((t) => (dryRun ? [] : ghIssues(exec, repo, t)));
        const plans = planIssues(s, o, found.filter((i) => i.state === "OPEN"), runUrl, found.filter((i) => i.state === "CLOSED"), repo);
        issues = fileIssues(plans, repo, exec, dryRun, (l) => console.error(l));
      } catch (err) {
        console.error(`  issues not filed: ${(err as Error).message}`);
        o.detail += " (issue not filed: see the run log)";
        red = true;
      }
    }
    summary.push(`| ${s.skill} | ${s.version} | ${o.result} | ${o.detail.replaceAll("|", "\\|")} | ${issues.map((n) => `#${n}`).join(" ")} |`);
  }
  const out = env.GITHUB_STEP_SUMMARY;
  if (out) writeFileSync(out, `## Daily drift check\n\n${summary.join("\n")}\n`, { flag: "a" });
  console.error(summary.join("\n"));
  return red ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
