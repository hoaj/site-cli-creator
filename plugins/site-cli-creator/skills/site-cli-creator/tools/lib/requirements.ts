// The maintainer requirements `new` checks before it writes anything (SPEC §13): Bun >= 1.4,
// Google Chrome, a logged-in gh, and admin rights on the plugin repo. The site account
// (requirement 1) is a question the agent asks, not a check.
import { existsSync } from "node:fs";
import { findChrome } from "../../starter/skill/cli/src/runtime/chrome";

export const MIN_BUN = "1.4.0";

export type Unmet = { requirement: "bun" | "chrome" | "gh" | "gh-auth" | "repo-admin"; message: string };

export type Gh = (args: string[]) => { ok: boolean; stdout: string; stderr: string } | "missing";

export type Probe = {
  bunVersion: string;
  platform: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  gh: Gh;
};

/** `a >= b` for dotted numeric versions (pre-release suffixes ignored). */
export function versionAtLeast(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
}

export function unmetRequirements(repo: string, probe: Probe): Unmet[] {
  const unmet: Unmet[] = [];
  if (!versionAtLeast(probe.bunVersion, MIN_BUN)) {
    unmet.push({ requirement: "bun", message: `Bun ${probe.bunVersion} is too old; ${MIN_BUN} or newer is needed: bun upgrade (https://bun.sh)` });
  }
  const chrome = findChrome(probe.env, probe.platform, probe.exists);
  if (!chrome.path) {
    unmet.push({
      requirement: "chrome",
      message: `Google Chrome was not found (looked at ${chrome.checked.join(", ") || "no known path on this OS"}); install it from https://www.google.com/chrome/ (Captures and check --writes need it)`,
    });
  }
  const auth = probe.gh(["auth", "status"]);
  if (auth === "missing") {
    unmet.push({ requirement: "gh", message: "GitHub CLI (gh) is not installed: install it from https://cli.github.com, then run gh auth login" });
    unmet.push({ requirement: "repo-admin", message: `admin rights on ${repo} could not be checked without gh` });
    return unmet;
  }
  if (!auth.ok) {
    unmet.push({ requirement: "gh-auth", message: "gh is not logged in: run gh auth login" });
    unmet.push({ requirement: "repo-admin", message: `admin rights on ${repo} could not be checked until gh is logged in` });
    return unmet;
  }
  const admin = probe.gh(["api", `repos/${repo}`, "--jq", ".permissions.admin"]);
  if (admin === "missing") return unmet;
  if (!admin.ok) {
    const notFound = /404|Not Found/i.test(admin.stderr + admin.stdout);
    unmet.push({
      requirement: "repo-admin",
      message: notFound
        ? `${repo} does not exist, or this gh account cannot see it. Create it first: gh repo create ${repo} --private --clone`
        : `could not read your permissions on ${repo} (gh api repos/${repo} failed: ${firstLine(admin.stderr) || "no output"})`,
    });
  } else if (admin.stdout.trim() !== "true") {
    unmet.push({
      requirement: "repo-admin",
      message: `this gh account has no admin rights on ${repo}; labels, releases and auto-merge need them. Ask the owner for admin, or use a repo you own`,
    });
  }
  return unmet;
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

export function systemProbe(): Probe {
  return {
    bunVersion: Bun.version,
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    gh: (args) => {
      try {
        const p = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
        return { ok: p.success, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
      } catch {
        return "missing";
      }
    },
  };
}
