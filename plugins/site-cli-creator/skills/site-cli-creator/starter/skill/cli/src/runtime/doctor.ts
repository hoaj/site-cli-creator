// `doctor`: facts for a report or a support question. Never fails: every probe degrades to a
// finding. Prints the check command but doesn't run it.
import { existsSync } from "node:fs";
import { findChrome, installHint } from "./chrome";
import { osName } from "./envelope";
import { loadSession, stateDir } from "./session";
import type { Env, Site } from "./site";

export type Exec = (cmd: string[]) => Promise<{ code: number; stdout: string }>;

export const exec: Exec = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 15_000 });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  } catch {
    return { code: -1, stdout: "" };
  }
};

export type DoctorOptions = {
  env?: Env;
  exec?: Exec;
  platform?: string;
  execPath?: string;
  /** True when running as a `bun build --compile` binary. */
  compiled?: boolean;
  exists?: (path: string) => boolean;
};

/** Gatekeeper / SmartScreen leftovers on our own binary (SPEC §9). */
export async function binaryFindings(path: string, platform: string, run: Exec, exists: (p: string) => boolean): Promise<string[]> {
  const findings: string[] = [];
  if (platform === "darwin") {
    if ((await run(["xattr", "-p", "com.apple.quarantine", path])).code === 0) {
      findings.push(`quarantined: run xattr -d com.apple.quarantine "${path}"`);
    }
    const sig = await run(["codesign", "-v", path]);
    if (sig.code > 0) findings.push(`invalid signature: run codesign --force --sign - "${path}"`);
  } else if (platform === "win32") {
    let marked = false;
    try {
      marked = exists(`${path}:Zone.Identifier`);
    } catch {}
    if (marked) findings.push(`Zone.Identifier present: run powershell -NoProfile -Command Unblock-File -Path "${path}"`);
  }
  return findings;
}

export async function doctor(site: Site, options: DoctorOptions = {}) {
  const env = options.env ?? process.env;
  const probe = options.exec ?? exec;
  const run: Exec = async (cmd) => {
    try {
      return await probe(cmd);
    } catch {
      return { code: -1, stdout: "" };
    }
  };
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const dir = stateDir(site, env);

  let session: string;
  try {
    const s = loadSession(dir);
    session = s ? `saved ${s.savedAt}` : "none";
  } catch {
    session = "unreadable";
  }

  let chrome: string;
  if (!site.needsChrome && site.auth !== "login") chrome = "not needed";
  else {
    const c = findChrome(env, platform, exists);
    chrome = c.path ?? `not found (looked at ${c.checked.join(", ") || "no known path"}). ${installHint(platform)}`;
  }

  const ghVersion = await run(["gh", "--version"]);
  const gh: Record<string, unknown> = { installed: ghVersion.code === 0 };
  if (ghVersion.code === 0) {
    gh.version = /gh version (\S+)/.exec(ghVersion.stdout)?.[1] ?? "unknown";
    gh.loggedIn = (await run(["gh", "auth", "status"])).code === 0;
    if (gh.loggedIn) {
      gh.repoAccess = (await run(["gh", "repo", "view", site.repo, "--json", "name"])).code === 0;
      if (!gh.repoAccess) gh.hint = `ask ${site.repo.split("/")[0]} for access to ${site.repo}`;
    } else gh.hint = "run gh auth login";
  } else gh.hint = "install GitHub CLI (https://cli.github.com) and run gh auth login";

  let findings: string[] = [];
  if (options.compiled) {
    try {
      findings = await binaryFindings(execPath, platform, run, exists);
    } catch {
      findings = ["could not inspect the binary"];
    }
  }

  return {
    plugin: site.plugin,
    skill: site.skill,
    version: site.version,
    generatedWith: site.generatedWith,
    bun: Bun.version,
    os: osName(platform),
    auth: site.auth,
    stateDir: dir,
    session,
    chrome,
    gh,
    binary: { path: execPath, compiled: !!options.compiled, findings },
    check: `${site.skill} check`,
  };
}
