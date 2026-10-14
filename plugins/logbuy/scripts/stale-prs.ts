// bun scripts/stale-prs.ts [--repo <owner/name>] [--base main]
// Run by ci.yml on every push to main. A PR's green "version above main" check was computed
// against the main it was opened on; once main moves, the same version may no longer be above
// it. For every open PR into the base branch whose plugin version is not above main's (now),
// this posts a failing commit status on the PR's head, so the PR goes red (SPEC §9 "A stale PR
// goes red"), `gh pr checks` fails and nothing merges it until it is rebased and bumped again.
import { join } from "node:path";
import { compareVersions, readPin, SOURCE, sourceVersion } from "./versions";

export type Run = (cmd: string[]) => Promise<string>;

export const STATUS_CONTEXT = "version above main";

type Pull = { number: number; headRefOid: string };

/** The plugin version a commit carries, or null when it has no readable manifest. */
async function versionAt(run: Run, repo: string, sha: string): Promise<string | null> {
  try {
    const content = await run(["gh", "api", `repos/${repo}/contents/${SOURCE}?ref=${sha}`, "--jq", ".content"]);
    return readPin(Buffer.from(content.trim(), "base64").toString("utf8"), "json");
  } catch {
    return null;
  }
}

/** Marks every open PR whose version is not above `mainVersion`; returns their numbers. */
export async function markStalePrs(
  opts: { repo: string; base: string; mainVersion: string },
  run: Run,
  log: (line: string) => void = console.error,
): Promise<number[]> {
  const { repo, base, mainVersion } = opts;
  const pulls = JSON.parse(
    await run(["gh", "pr", "list", "--repo", repo, "--base", base, "--state", "open", "--limit", "200", "--json", "number,headRefOid"]),
  ) as Pull[];
  const stale: number[] = [];
  for (const pr of pulls) {
    const version = await versionAt(run, repo, pr.headRefOid);
    if (version === null) {
      log(`stale-prs: #${pr.number} has no readable ${SOURCE}, skipped`);
      continue;
    }
    if (compareVersions(version, mainVersion) > 0) continue;
    await run([
      "gh", "api", "--method", "POST", `repos/${repo}/statuses/${pr.headRefOid}`,
      "-f", "state=failure",
      "-f", `context=${STATUS_CONTEXT}`,
      "-f", `description=version ${version} is not above ${base}'s ${mainVersion}: rebase on ${base} and bump again`,
    ]);
    stale.push(pr.number);
  }
  log(`stale-prs: ${base} is at ${mainVersion}; marked ${stale.map((n) => `#${n}`).join(" ") || "no PR"} stale`);
  return stale;
}

const spawn: Run = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${code}): ${err.trim()}`);
  return out;
};

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const repo = flag(argv, "--repo") ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("usage: bun scripts/stale-prs.ts [--repo <owner/name>] [--base main]");
    process.exit(2);
  }
  try {
    const mainVersion = sourceVersion(join(import.meta.dir, ".."));
    await markStalePrs({ repo, base: flag(argv, "--base") ?? "main", mainVersion }, spawn);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
