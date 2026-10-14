// bun run version-check [base-ref] [--root <dir>]
// Fails unless this branch's plugin version is above the base branch's (default origin/main),
// so two merged PRs never release the same number. Passes when the base has no manifest yet.
// Needs the base ref locally: check out with fetch-depth: 0.
import { join } from "node:path";
import { compareVersions, readPin, SOURCE, sourceVersion } from "./versions";

type Git = (args: string[], cwd: string) => { code: number; stdout: string; stderr: string };

const git: Git = (args, cwd) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

export type CheckResult = { ok: boolean; message: string };

export function versionCheck(root: string, base: string, run: Git = git): CheckResult {
  const head = sourceVersion(root);
  if (run(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], root).code !== 0) {
    return { ok: false, message: `base ref ${base} not found: fetch it first (actions/checkout with fetch-depth: 0)` };
  }
  const shown = run(["show", `${base}:${SOURCE}`], root);
  if (shown.code !== 0) return { ok: true, message: `${base} has no ${SOURCE}: version ${head} is the first` };
  const baseVersion = readPin(shown.stdout, "json");
  if (baseVersion === null) return { ok: true, message: `${base}'s ${SOURCE} has no version: version ${head} is the first` };
  if (compareVersions(head, baseVersion) > 0) {
    return { ok: true, message: `version ${head} is above ${base}'s ${baseVersion}` };
  }
  return {
    ok: false,
    message:
      `version ${head} is not above ${base}'s ${baseVersion}: ` +
      "rebase on main, then run `bun run bump <patch|minor|major>` again",
  };
}

export function main(argv: string[]): number {
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag >= 0 ? argv[rootFlag + 1]! : join(import.meta.dir, "..");
  const base = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--root") ?? "origin/main";
  try {
    const result = versionCheck(root, base);
    (result.ok ? console.log : console.error)(`version-check: ${result.message}`);
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(`version-check: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
