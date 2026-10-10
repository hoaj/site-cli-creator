import { describe, expect, test } from "bun:test";
import { markStalePrs, STATUS_CONTEXT } from "../scripts/stale-prs";

const manifest = (version: string) => Buffer.from(JSON.stringify({ name: "p", version })).toString("base64");

function fakeGh(pulls: { number: number; headRefOid: string; version?: string }[]) {
  const calls: string[][] = [];
  const run = async (cmd: string[]) => {
    calls.push(cmd);
    if (cmd[1] === "pr" && cmd[2] === "list") return JSON.stringify(pulls.map(({ number, headRefOid }) => ({ number, headRefOid })));
    const contents = /contents\/\.claude-plugin\/plugin\.json\?ref=(\w+)$/.exec(cmd[2] ?? "");
    if (contents) {
      const pr = pulls.find((p) => p.headRefOid === contents[1]);
      if (!pr?.version) throw new Error("HTTP 404");
      return `${manifest(pr.version)}\n`;
    }
    if (cmd[2] === "--method") return "{}";
    throw new Error(`unexpected ${cmd.join(" ")}`);
  };
  return { run, calls };
}

describe("markStalePrs", () => {
  test("a PR whose version is not above main's gets a failing status on its head; the others are left alone", async () => {
    const gh = fakeGh([
      { number: 7, headRefOid: "aaa", version: "0.1.1" }, // collided with the PR that just merged
      { number: 8, headRefOid: "bbb", version: "0.2.0" }, // still above
      { number: 9, headRefOid: "ccc", version: "0.1.0" }, // below
      { number: 10, headRefOid: "ddd" }, // no manifest at its head
    ]);
    const stale = await markStalePrs({ repo: "acme/p", base: "main", mainVersion: "0.1.1" }, gh.run, () => {});
    expect(stale).toEqual([7, 9]);
    const statuses = gh.calls.filter((c) => c[2] === "--method");
    expect(statuses.map((c) => c[4])).toEqual(["repos/acme/p/statuses/aaa", "repos/acme/p/statuses/ccc"]);
    expect(statuses[0]).toContain("state=failure");
    expect(statuses[0]).toContain(`context=${STATUS_CONTEXT}`);
    expect(statuses[0]!.find((a) => a.startsWith("description="))).toBe("description=version 0.1.1 is not above main's 0.1.1: rebase on main and bump again");
  });

  test("no open PRs: nothing to do", async () => {
    const gh = fakeGh([]);
    expect(await markStalePrs({ repo: "acme/p", base: "main", mainVersion: "1.0.0" }, gh.run, () => {})).toEqual([]);
    expect(gh.calls).toHaveLength(1);
  });
});
