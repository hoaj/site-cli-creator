// bun scripts/fixed-in.ts <tag> [--repo <owner/name>] [--branch main] [--dir <plugin folder in the repo>]
// Run by the release workflow after the release and its binaries are published. For every PR
// merged into the branch between the previous release tag and <tag>, it finds "Fixes #n" /
// "Closes #n" in the PR text and gives each issue the label fixed-in:<tag> plus a short comment,
// so the Feedback skill can tell users which version fixed their report. Safe to rerun.
// In a repo that holds other plugins too, tags carry the plugin's name (shop-v0.3.1): the
// previous tag is the one with the same prefix, and with --dir plugins/shop only the commits that
// changed the plugin's folder count. --dir . (or none) is the whole repo.
import { flag, pluginDir, spawn, type Run } from "./run";
import { compareVersions } from "./versions";

const KEYWORD_REF = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

export function issueRefs(text: string): number[] {
  return [...new Set([...text.matchAll(KEYWORD_REF)].map((m) => Number(m[1])))];
}

/** The prefix of a `<prefix>vX.Y.Z` tag: "" for v0.3.1, "shop-" for shop-v0.3.1. */
export function tagPrefix(tag: string): string {
  const m = /^(.*?)v\d+\.\d+\.\d+$/.exec(tag);
  if (!m) throw new Error(`not a vX.Y.Z tag: ${tag}`);
  return m[1]!;
}

/** The highest tag with the same prefix below `tag`, or null for the first release. */
export function previousTag(tags: string[], tag: string): string | null {
  const prefix = tagPrefix(tag);
  const version = (t: string) =>
    t.startsWith(prefix) && /^v\d+\.\d+\.\d+$/.test(t.slice(prefix.length)) ? t.slice(prefix.length + 1) : null;
  const current = version(tag)!;
  const older = tags
    .map((t) => ({ t, v: version(t) }))
    .filter((x): x is { t: string; v: string } => x.v !== null && compareVersions(x.v, current) < 0)
    .sort((a, b) => compareVersions(b.v, a.v));
  return older[0]?.t ?? null;
}

type Pull = { number: number; title: string; body: string | null; merged_at: string | null; base: { ref: string } };

export async function labelFixedIssues(
  opts: { tag: string; repo: string; branch: string; dir?: string },
  run: Run,
  log: (line: string) => void = console.error,
): Promise<number[]> {
  const { tag, repo, branch } = opts;
  const tags = (await run(["git", "tag", "--list", `${tagPrefix(tag)}v*`])).split("\n").filter(Boolean);
  const prev = previousTag(tags, tag);
  const range = prev ? `${prev}..${tag}` : tag;
  const dir = pluginDir(opts.dir);
  const commits = (await run(["git", "rev-list", "--first-parent", range, ...(dir ? ["--", dir] : [])])).split("\n").filter(Boolean);

  // One gh api call per commit: up to 8 at a time, read back in commit order.
  const found: Pull[][] = [];
  for (let i = 0; i < commits.length; i += 8) {
    const batch = commits.slice(i, i + 8).map((sha) => run(["gh", "api", `repos/${repo}/commits/${sha}/pulls`]));
    for (const raw of await Promise.all(batch)) found.push(JSON.parse(raw) as Pull[]);
  }
  const pulls = new Map<number, Pull>();
  for (const pr of found.flat()) if (pr.merged_at && pr.base.ref === branch) pulls.set(pr.number, pr);
  const issues = [...new Set([...pulls.values()].flatMap((pr) => issueRefs(`${pr.title}\n${pr.body ?? ""}`)))];
  log(`fixed-in: ${pulls.size} PR(s) since ${prev ?? "the first commit"}, ${issues.length} issue(s)`);
  if (issues.length === 0) return [];

  const label = `fixed-in:${tag}`;
  await run([
    "gh", "label", "create", label, "--repo", repo, "--force",
    "--color", "0e8a16", "--description", `Fixed in release ${tag}`,
  ]);

  const labelled: number[] = [];
  const failed: string[] = [];
  for (const n of issues) {
    try {
      const issue = JSON.parse(await run(["gh", "api", `repos/${repo}/issues/${n}`])) as {
        pull_request?: unknown;
        labels: { name: string }[];
      };
      if (issue.pull_request || issue.labels.some((l) => l.name === label)) continue;
      await run(["gh", "issue", "edit", String(n), "--repo", repo, "--add-label", label]);
      await run([
        "gh", "issue", "comment", String(n), "--repo", repo, "--body",
        `Fixed in ${tag}: https://github.com/${repo}/releases/tag/${tag}. Update the plugin to get the fix.`,
      ]);
      labelled.push(n);
    } catch (err) {
      const message = (err as Error).message;
      // A PR that says "Fixes #n" for an issue that does not exist must not block the others.
      if (/HTTP 404/.test(message)) log(`::warning::fixed-in: #${n} is not an issue in ${repo}, skipped`);
      else failed.push(`#${n}: ${message}`);
    }
  }
  log(`fixed-in: labelled ${labelled.map((n) => `#${n}`).join(" ") || "nothing new"}`);
  // Every other issue was still handled; the rerun skips those already labelled.
  if (failed.length > 0) throw new Error(`fixed-in: could not label ${failed.join("; ")}`);
  return labelled;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const tag = argv[0];
  const repo = flag(argv, "--repo") ?? process.env.GITHUB_REPOSITORY;
  if (!tag || !repo) {
    console.error("usage: bun scripts/fixed-in.ts <[prefix]vX.Y.Z> [--repo <owner/name>] [--branch main] [--dir <plugin folder in the repo>]");
    process.exit(2);
  }
  try {
    await labelFixedIssues({ tag, repo, branch: flag(argv, "--branch") ?? "main", dir: flag(argv, "--dir") }, spawn);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
