// bun scripts/stale-prs.ts [--repo <owner/name>] [--base main] [--dir <plugin folder in the repo>]
// Run by the CI workflow on every push to main. A PR's green "version above main" check was
// computed against the main it was opened on; once main moves, the same version may no longer be
// above it. For every open PR into the base branch whose plugin version is not above main's (now),
// this posts a failing commit status on the PR's head, so the PR goes red (SPEC §9 "A stale PR
// goes red"), `gh pr checks` fails and nothing merges it until it is rebased and bumped again.
// In a repo that holds other plugins too (--dir plugins/shop), only the PRs that change a file in
// the plugin's folder carry a version to compare; the others are left alone. --dir . (or none)
// is a plugin at the repo's root.
import { join } from "node:path";
import { flag, pluginDir, spawn, type Run } from "./run";
import { compareVersions, readPin, SOURCE, sourceVersion } from "./versions";

export const STATUS_CONTEXT = "version above main";

type Pull = { number: number; headRefOid: string; files?: { path: string }[] };

/** The plugin version a commit carries, or null when it has no readable manifest. */
async function versionAt(run: Run, repo: string, manifest: string, sha: string): Promise<string | null> {
  try {
    const content = await run(["gh", "api", `repos/${repo}/contents/${manifest}?ref=${sha}`, "--jq", ".content"]);
    return readPin(Buffer.from(content.trim(), "base64").toString("utf8"), "json");
  } catch {
    return null;
  }
}

/** Marks every open PR whose version is not above `mainVersion`; returns their numbers. */
export async function markStalePrs(
  opts: { repo: string; base: string; mainVersion: string; dir?: string },
  run: Run,
  log: (line: string) => void = console.error,
): Promise<number[]> {
  const { repo, base, mainVersion } = opts;
  const dir = pluginDir(opts.dir);
  const manifest = dir ? `${dir}/${SOURCE}` : SOURCE;
  const pulls = JSON.parse(
    await run([
      "gh", "pr", "list", "--repo", repo, "--base", base, "--state", "open", "--limit", "200",
      "--json", dir ? "number,headRefOid,files" : "number,headRefOid",
    ]),
  ) as Pull[];
  const stale: number[] = [];
  for (const pr of pulls) {
    if (dir && !(pr.files ?? []).some((f) => f.path.startsWith(`${dir}/`))) continue;
    const version = await versionAt(run, repo, manifest, pr.headRefOid);
    if (version === null) {
      log(`stale-prs: #${pr.number} has no readable ${manifest}, skipped`);
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

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const repo = flag(argv, "--repo") ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("usage: bun scripts/stale-prs.ts [--repo <owner/name>] [--base main] [--dir <plugin folder in the repo>]");
    process.exit(2);
  }
  try {
    const mainVersion = sourceVersion(join(import.meta.dir, ".."));
    await markStalePrs({ repo, base: flag(argv, "--base") ?? "main", mainVersion, dir: flag(argv, "--dir") }, spawn);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
