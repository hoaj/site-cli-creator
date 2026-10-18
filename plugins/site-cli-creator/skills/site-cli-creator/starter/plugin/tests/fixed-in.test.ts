import { describe, expect, test } from "bun:test";
import { issueRefs, labelFixedIssues, previousTag } from "../scripts/fixed-in";

describe("issueRefs", () => {
  test("finds GitHub closing keywords, case-insensitive, deduplicated", () => {
    const body = "Fixes #12\ncloses #7, and Resolves: #12\nFIXED #3\nSee #99. Prefix#5 fixes#6 refs #8";
    expect(issueRefs(body)).toEqual([12, 7, 3]);
  });

  test("ignores plain mentions", () => {
    expect(issueRefs("Related to #4, follow-up of #5")).toEqual([]);
  });
});

describe("previousTag", () => {
  const tags = ["v0.1.0", "v0.2.0", "v0.10.0", "v0.9.1", "latest", "v1.0.0-rc1"];
  test("is the highest version below the tag, compared numerically", () => {
    expect(previousTag(tags, "v0.11.0")).toBe("v0.10.0");
    expect(previousTag(tags, "v0.10.0")).toBe("v0.9.1");
  });
  test("is null for the first release", () => {
    expect(previousTag(["v0.1.0"], "v0.1.0")).toBeNull();
  });
  test("with a prefix, is the highest tag below it with the same prefix", () => {
    const mixed = ["v0.9.0", "logbuy-v0.2.0", "logbuy-v0.10.0", "other-v0.9.9", "logbuy-v0.9.1", "logbuy-latest"];
    expect(previousTag(mixed, "logbuy-v0.11.0")).toBe("logbuy-v0.10.0");
    expect(previousTag(mixed, "logbuy-v0.10.0")).toBe("logbuy-v0.9.1");
    expect(previousTag(mixed, "logbuy-v0.2.0")).toBeNull();
    expect(previousTag(mixed, "v1.0.0")).toBe("v0.9.0");
  });
  test("rejects a non-version tag", () => {
    expect(() => previousTag(tags, "latest")).toThrow("not a vX.Y.Z tag");
    expect(() => previousTag(tags, "logbuy-latest")).toThrow("not a vX.Y.Z tag");
  });
});

type Issue = { pull_request?: unknown; labels: { name: string }[] };

function fakeGh(opts: { tags: string; commits: Record<string, unknown[]>; issues: Record<number, Issue> }) {
  const calls: string[][] = [];
  const run = async (cmd: string[]) => {
    calls.push(cmd);
    const [tool, a, b] = cmd;
    if (tool === "git" && a === "tag") return opts.tags;
    if (tool === "git" && a === "rev-list") return Object.keys(opts.commits).join("\n") + "\n";
    if (tool === "gh" && a === "api") {
      const commit = /commits\/(\w+)\/pulls$/.exec(b!);
      if (commit) return JSON.stringify(opts.commits[commit[1]!]);
      const issue = /issues\/(\d+)$/.exec(b!);
      if (issue) return JSON.stringify(opts.issues[Number(issue[1])]);
    }
    if (tool === "gh") return "";
    throw new Error(`unexpected ${cmd.join(" ")}`);
  };
  return { run, calls };
}

const pr = (number: number, body: string, extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  body,
  merged_at: "2026-10-01T00:00:00Z",
  base: { ref: "main" },
  ...extra,
});

describe("labelFixedIssues", () => {
  test("labels and comments every issue the released PRs closed", async () => {
    const { run, calls } = fakeGh({
      tags: "v0.1.0\nv0.2.0\n",
      commits: {
        aaa: [pr(10, "Fixes #1\nCloses #2")],
        bbb: [pr(11, "fixes #2"), pr(12, "Fixes #5", { base: { ref: "other" } })],
        ccc: [pr(13, "Fixes #6", { merged_at: null })],
        ddd: [pr(14, "Fixes #3"), pr(15, "Fixes #4")],
      },
      issues: {
        1: { labels: [] },
        2: { labels: [{ name: "drift" }] },
        3: { labels: [{ name: "fixed-in:v0.2.0" }] },
        4: { pull_request: {}, labels: [] },
      },
    });
    const labelled = await labelFixedIssues({ tag: "v0.2.0", repo: "acme/demo", branch: "main" }, run, () => {});
    expect(labelled).toEqual([1, 2]);
    expect(calls).toContainEqual(["git", "rev-list", "--first-parent", "v0.1.0..v0.2.0"]);
    expect(calls).toContainEqual([
      "gh", "label", "create", "fixed-in:v0.2.0", "--repo", "acme/demo", "--force",
      "--color", "0e8a16", "--description", "Fixed in release v0.2.0",
    ]);
    const edits = calls.filter((c) => c[1] === "issue" && c[2] === "edit");
    expect(edits).toEqual([
      ["gh", "issue", "edit", "1", "--repo", "acme/demo", "--add-label", "fixed-in:v0.2.0"],
      ["gh", "issue", "edit", "2", "--repo", "acme/demo", "--add-label", "fixed-in:v0.2.0"],
    ]);
    const comments = calls.filter((c) => c[1] === "issue" && c[2] === "comment");
    expect(comments.map((c) => c[3])).toEqual(["1", "2"]);
    expect(comments[0]!.at(-1)).toContain("https://github.com/acme/demo/releases/tag/v0.2.0");
  });

  test("skips a reference to a missing issue and reports other failures after the rest", async () => {
    const { run: base, calls } = fakeGh({
      tags: "v0.1.0\nv0.2.0\n",
      commits: { aaa: [pr(10, "Fixes #1\nFixes #404\nFixes #2\nFixes #3")] },
      issues: { 1: { labels: [] }, 2: { labels: [] }, 3: { labels: [] } },
    });
    const run = async (cmd: string[]) => {
      if (cmd[2] === "repos/acme/demo/issues/404") {
        throw new Error("gh api repos/acme/demo/issues/404 failed (1): gh: Not Found (HTTP 404)");
      }
      if (cmd[2] === "edit" && cmd[3] === "2") throw new Error("gh issue edit failed (1): HTTP 403");
      return base(cmd);
    };
    const lines: string[] = [];
    const result = labelFixedIssues({ tag: "v0.2.0", repo: "acme/demo", branch: "main" }, run, (l) => lines.push(l));
    await expect(result).rejects.toThrow("could not label #2: gh issue edit failed (1): HTTP 403");
    expect(lines).toContain("::warning::fixed-in: #404 is not an issue in acme/demo, skipped");
    expect(lines).toContain("fixed-in: labelled #1 #3");
    expect(calls.filter((c) => c[2] === "comment").map((c) => c[3])).toEqual(["1", "3"]);
  });

  test("first release walks all history and creates no label when nothing was fixed", async () => {
    const { run, calls } = fakeGh({ tags: "v0.1.0\n", commits: { aaa: [pr(1, "Initial")] }, issues: {} });
    expect(await labelFixedIssues({ tag: "v0.1.0", repo: "acme/demo", branch: "main" }, run, () => {})).toEqual([]);
    expect(calls).toContainEqual(["git", "rev-list", "--first-parent", "v0.1.0"]);
    expect(calls.some((c) => c[1] === "label")).toBe(false);
  });

  test("a plugin in a folder of a shared repo: its own prefixed tags, only commits that changed the folder", async () => {
    const { run, calls } = fakeGh({
      tags: "logbuy-v0.3.1\nlogbuy-v0.4.0\n",
      commits: { aaa: [pr(20, "Fixes #9")] },
      issues: { 9: { labels: [] } },
    });
    const opts = { tag: "logbuy-v0.4.0", repo: "acme/skills", branch: "main", dir: "plugins/logbuy" };
    expect(await labelFixedIssues(opts, run, () => {})).toEqual([9]);
    expect(calls).toContainEqual(["git", "tag", "--list", "logbuy-v*"]);
    expect(calls).toContainEqual(["git", "rev-list", "--first-parent", "logbuy-v0.3.1..logbuy-v0.4.0", "--", "plugins/logbuy"]);
    expect(calls).toContainEqual(["gh", "issue", "edit", "9", "--repo", "acme/skills", "--add-label", "fixed-in:logbuy-v0.4.0"]);
  });

  test("--dir . (a plugin at its repo's root, as its own release workflow passes it) walks every commit", async () => {
    const { run, calls } = fakeGh({ tags: "v0.1.0\nv0.2.0\n", commits: { aaa: [pr(1, "Fixes #1")] }, issues: { 1: { labels: [] } } });
    expect(await labelFixedIssues({ tag: "v0.2.0", repo: "acme/demo", branch: "main", dir: "." }, run, () => {})).toEqual([1]);
    expect(calls).toContainEqual(["git", "tag", "--list", "v*"]);
    expect(calls).toContainEqual(["git", "rev-list", "--first-parent", "v0.1.0..v0.2.0"]);
  });
});
