import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkill, classify, discover, fileIssues, fixedIn, isolatedEnv, KILLED, main, planIssues, secretName, sessionText, type Exec, type Result, type Skill } from "../scripts/drift-check";

const tmp = mkdtempSync(join(tmpdir(), "drift-check-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SKILL: Skill = { plugin: "shop", skill: "shop", dir: "/x", version: "1.2.3", auth: "login", dailyCheck: true };
const FP = "shop:shop:listOrders:zod:items[].price:invalid_type";

/** A plugin root with one CLI skill, plus the Feedback and Deploy skills, which have no CLI. */
function pluginRoot(name: string, auth: "login" | "none", dailyCheck = "true"): string {
  const root = join(tmp, name);
  const skill = join(root, "skills", "shop");
  mkdirSync(join(skill, "cli", "src"), { recursive: true });
  writeFileSync(join(skill, "install.sh"), "");
  writeFileSync(join(skill, "cli", "src", "site.ts"), `export default defineSite({\n  plugin: "shop",\n  skill: "shop",\n  version: "1.2.3",\n  auth: "${auth}" as Auth,\n  needsChrome: false,\n  dailyCheck: ${dailyCheck},\n});\n`);
  for (const other of ["shop-feedback", "shop-deploy"]) mkdirSync(join(root, "skills", other), { recursive: true });
  return root;
}

test("discover finds the CLI skills in skills/*, reading plugin, skill, version and auth", () => {
  const root = pluginRoot("discover", "login");
  expect(discover(root)).toEqual([{ plugin: "shop", skill: "shop", dir: join(root, "skills", "shop"), version: "1.2.3", auth: "login", dailyCheck: true }]);
  // The maintainer's answer when add-skill asked: false keeps the skill out.
  expect(discover(pluginRoot("discover-off", "none", "false"))[0]!.dailyCheck).toBe(false);
  expect(discover(join(tmp, "nothing-here"))).toEqual([]);
});

test("secretName and sessionText", () => {
  expect(secretName({ plugin: "my-shop", skill: "my-shop" })).toBe("SESSION_MY_SHOP_MY_SHOP");
  expect(sessionText('{"headers":{}}')).toBe('{"headers":{}}');
  expect(sessionText(Buffer.from('{"headers":{}}').toString("base64"))).toBe('{"headers":{}}');
  expect(sessionText("")).toBeNull();
  expect(sessionText("not a session")).toBeNull();
});

describe("classify", () => {
  test("exit 0 is ok, counting ok Operations and warnings", () => {
    const o = classify(0, JSON.stringify({ ok: false, operations: [{ status: "ok" }, { status: "ok" }, { status: "skipped" }], warnings: ["x"] }));
    expect(o).toEqual({ result: "ok", detail: "2 Operation(s) ok, 1 not checkable", drifts: [] });
  });

  test("exit 3 is drift with every Fingerprint", () => {
    const o = classify(3, JSON.stringify({ error: { kind: "drift", message: "m", drifts: [{ operation: "listOrders", fingerprint: FP, diff: [{ path: "items[].price" }] }] } }));
    expect(o.result).toBe("drift");
    expect(o.drifts.map((d) => d.fingerprint)).toEqual([FP]);
  });

  test("a check killed by a signal is a crash; a site that blocks the runner is an error to file; a Drift entry with no Fingerprint is counted (review 2)", () => {
    expect(classify(KILLED, "")).toMatchObject({ result: "error", kind: "crash" });
    expect(classify(5, JSON.stringify({ error: { kind: "network", message: "m", blocked: "challenge page" } }))).toMatchObject({ result: "error", kind: "blocked" });
    const mixed = classify(3, JSON.stringify({ error: { kind: "drift", drifts: [{ operation: "a", fingerprint: FP, diff: [] }, { operation: "b", fingerprint: "", diff: [] }] } }));
    expect(mixed).toMatchObject({ result: "drift", unfiled: 1 });
    expect(mixed.drifts.map((d) => d.fingerprint)).toEqual([FP]);
  });

  test("a check killed by its time limit is an error to file once (a hang every day must be seen), and Drift with no Fingerprint is an error (review 1, 3)", () => {
    expect(classify(124, "")).toMatchObject({ result: "error", kind: "timeout" });
    expect(classify(3, "not json")).toMatchObject({ result: "error", kind: "drift" });
  });

  test.each([
    [4, "session", "session"],
    [5, "network", "network"],
    [1, "bug", "error"],
    [2, "input", "error"],
  ])("exit %i (%s) → %s", (code, kind, result) => {
    expect(classify(code as number, JSON.stringify({ error: { kind, message: "m" } })).result).toBe(result as Result);
  });

  test("a crash with no JSON is an error", () => {
    expect(classify(139, "Segmentation fault")).toMatchObject({ result: "error", kind: "bug" });
  });
});

describe("planIssues", () => {
  const drift = classify(3, JSON.stringify({ error: { kind: "drift", drifts: [{ operation: "listOrders", fingerprint: FP, diff: [{ path: "items[].price", expected: "number", received: "string" }] }] } }));

  test("drift: titled with the Fingerprint exactly (as the Feedback skill titles it), label drift, type-only diff in the body", () => {
    const [p] = planIssues(SKILL, drift, [], "https://run/1", [], "acme/shop-plugin");
    expect(p).toMatchObject({ title: FP, labels: ["drift"] });
    expect(p!.existing).toBeUndefined();
    expect(p!.body).toContain('"received": "string"');
    expect(p!.body).toContain("Run: https://run/1");
  });

  test("an open issue with the same title is reused, not filed again; of several, the oldest, as the Feedback skill picks (review 2)", () => {
    expect(planIssues(SKILL, drift, [{ number: 7, title: FP, state: "OPEN" }], undefined, [], "acme/shop-plugin")[0]!.existing).toBe(7);
    expect(planIssues(SKILL, drift, [{ number: 12, title: FP, state: "OPEN" }, { number: 10, title: FP, state: "OPEN" }], undefined, [], "acme/shop-plugin")[0]!.existing).toBe(10);
  });

  test("a closed one whose fix shipped at or below this version: a new issue that links it (it came back)", () => {
    const [p] = planIssues(SKILL, drift, [], undefined, [{ number: 3, title: FP, state: "CLOSED", labels: [{ name: "fixed-in:v1.2.0" }] }], "acme/shop-plugin");
    expect(p!.existing).toBeUndefined();
    expect(p!.body).toContain("reported before in #3");
  });

  test("a closed one whose fix is merged but not released (no fixed-in), or released above this version, stands for it", () => {
    expect(planIssues(SKILL, drift, [], undefined, [{ number: 3, title: FP, state: "CLOSED", labels: [] }], "acme/shop-plugin")[0]!.existing).toBe(3);
    expect(planIssues(SKILL, drift, [], undefined, [{ number: 4, title: FP, state: "CLOSED", labels: [{ name: "fixed-in:v1.3.0" }] }], "acme/shop-plugin")[0]!.existing).toBe(4);
  });

  test("several closed ones are judged as the Feedback skill does: by the most recently closed, against the highest fixed-in (review 1)", () => {
    // #3 was closed long ago without a fix (a duplicate); #7, closed last, shipped the fix in 1.2.0, the version checked: it came back.
    const closed = [
      { number: 3, title: FP, state: "CLOSED" as const, closedAt: "2026-01-01T00:00:00Z", labels: [] },
      { number: 7, title: FP, state: "CLOSED" as const, closedAt: "2026-06-01T00:00:00Z", labels: [{ name: "fixed-in:v1.2.0" }] },
    ];
    const now = Date.parse("2026-06-05T00:00:00Z");
    const [p] = planIssues(SKILL, drift, [], undefined, closed, "acme/shop-plugin", now);
    expect(p!.existing).toBeUndefined();
    expect(p!.body).toContain("reported before in #7");
    // The most recently closed one has no fixed-in yet (closed days ago): its fix is on the way, nothing new.
    const pending = [{ ...closed[1]!, labels: [] }, { ...closed[0]!, labels: [{ name: "fixed-in:v1.0.0" }] }];
    expect(planIssues(SKILL, drift, [], undefined, pending, "acme/shop-plugin", now)[0]!.existing).toBe(7);
  });

  test("a Drift issue closed long ago without a fixed-in label no longer stands for it: a new issue links it (review 3)", () => {
    const now = Date.parse("2026-11-17T00:00:00Z");
    const recent = [{ number: 7, title: FP, state: "CLOSED" as const, closedAt: "2026-11-10T00:00:00Z", labels: [] }];
    expect(planIssues(SKILL, drift, [], undefined, recent, "acme/shop-plugin", now)[0]!.existing).toBe(7);
    const old = [{ ...recent[0]!, closedAt: "2026-09-01T00:00:00Z" }];
    const [p] = planIssues(SKILL, drift, [], undefined, old, "acme/shop-plugin", now);
    expect(p!.existing).toBeUndefined();
    expect(p!.body).toContain("reported before in #7");
  });

  test("a check: or ci-session: issue closed in the last 14 days is not filed again; an older one is (review 3)", () => {
    const now = Date.parse("2026-11-17T00:00:00Z");
    const blocked = classify(5, JSON.stringify({ error: { kind: "network", blocked: "wall" } }));
    const title = "check: shop:shop: the daily check failed (blocked)";
    expect(planIssues(SKILL, blocked, [], undefined, [{ number: 5, title, state: "CLOSED", closedAt: "2026-11-12T00:00:00Z" }], "acme/shop-plugin", now)[0]!.existing).toBe(5);
    expect(planIssues(SKILL, blocked, [], undefined, [{ number: 5, title, state: "CLOSED", closedAt: "2026-10-01T00:00:00Z" }], "acme/shop-plugin", now)[0]!.existing).toBeUndefined();
  });

  test("fixedIn reads a fixed-in:vX.Y.Z label", () => {
    expect(fixedIn({ number: 1, title: "", state: "CLOSED", labels: [{ name: "drift" }, { name: "fixed-in:v2.0.0" }] })).toBe("2.0.0");
    expect(fixedIn({ number: 1, title: "", state: "CLOSED", labels: [{ name: "drift" }] })).toBeNull();
  });

  test("session: a ci-session issue that says how to make a CI sign-in of its own and store it as the secret", () => {
    const [p] = planIssues(SKILL, classify(4, JSON.stringify({ error: { kind: "session" } })), [], undefined, [], "acme/shop-plugin");
    expect(p!.labels).toEqual(["ci-session"]);
    // In a subshell, so SITE_CLI_HOME never stays set in the maintainer's shell after the dir is gone (review 2).
    expect(p!.body).toContain('(cd skills/shop && export SITE_CLI_HOME="$(mktemp -d)" && bin/shop login && gh secret set SESSION_SHOP_SHOP --repo acme/shop-plugin < "$SITE_CLI_HOME/session.json"; rm -rf "$SITE_CLI_HOME")');
  });

  test("blocked: a check: issue that says the runner is refused, so the maintainer can turn the skill's daily check off (review 2)", () => {
    const [p] = planIssues(SKILL, classify(5, JSON.stringify({ error: { kind: "network", blocked: "challenge page" } })), [], undefined, [], "acme/shop-plugin");
    expect(p).toMatchObject({ title: "check: shop:shop: the daily check failed (blocked)", labels: ["bug"] });
    expect(p!.body).toContain("dailyCheck: false");
  });

  test("ok, network, no-session and install file nothing", () => {
    for (const result of ["ok", "network", "no-session", "install", "off"] as const) {
      expect(planIssues(SKILL, { result, detail: "", drifts: [] }, [], undefined, [], "acme/shop-plugin")).toEqual([]);
    }
  });
});

describe("checkSkill", () => {
  const calls: string[][] = [];
  const exec = (answers: Record<string, { code: number; stdout?: string }>): Exec => (cmd, opts) => {
    calls.push(cmd);
    expect(opts?.isolated).toBe(true);
    if (cmd[0] === "bash") return { code: answers.install?.code ?? 0, stdout: "", stderr: "install.sh: release v9 still being built" };
    expect(opts!.env!.SITE_CLI_NONINTERACTIVE).toBe("1");
    expect(readFileSync(join(opts!.env!.SITE_CLI_HOME!, "session.json"), "utf8")).toBe('{"headers":{}}');
    return { code: answers.check!.code, stdout: answers.check!.stdout ?? "", stderr: "" };
  };

  test("a skill whose site.ts says dailyCheck: false is left out before anything runs", () => {
    calls.length = 0;
    expect(checkSkill({ ...SKILL, dailyCheck: false }, { SESSION_SHOP_SHOP: '{"headers":{}}' }, exec({}))).toMatchObject({ result: "off", detail: "skipped: dailyCheck is false in site.ts" });
    expect(calls).toEqual([]);
  });

  test("a login skill without its secret is skipped before anything is installed", () => {
    calls.length = 0;
    expect(checkSkill(SKILL, {}, exec({})).result).toBe("no-session");
    expect(calls).toEqual([]);
  });

  test("install.sh gets the job's read-only GH_TOKEN (a private repo's release needs gh); the check never does (review 1)", () => {
    const seen: { cmd: string[]; env?: Record<string, string> }[] = [];
    const tokenExec: Exec = (cmd, opts) => {
      seen.push({ cmd, env: opts?.env });
      return cmd[0] === "bash" ? { code: 0, stdout: "", stderr: "" } : { code: 0, stdout: '{"ok":true,"operations":[]}', stderr: "" };
    };
    checkSkill({ ...SKILL, auth: "none" }, {}, tokenExec, { GH_TOKEN: "ghs_job" });
    expect(seen[0]!.env?.GH_TOKEN).toBe("ghs_job");
    expect(seen[1]!.env?.GH_TOKEN).toBeUndefined();
  });

  test("a malformed session secret is not a missing one: it is named and turns the run red (review 3)", () => {
    expect(checkSkill(SKILL, { SESSION_SHOP_SHOP: "/Users/me/.shop/session.json" }, (() => ({ code: 0, stdout: "", stderr: "" })) as Exec)).toMatchObject({ result: "error", kind: "secret" });
  });

  test("ACCOUNT_<PLUGIN>_<SKILL> picks the account of a CI login with several (review 3)", () => {
    const seen: string[][] = [];
    const e: Exec = (cmd) => (seen.push(cmd), cmd[0] === "bash" ? { code: 0, stdout: "", stderr: "" } : { code: 0, stdout: '{"ok":true,"operations":[]}', stderr: "" });
    checkSkill(SKILL, { SESSION_SHOP_SHOP: '{"headers":{}}', ACCOUNT_SHOP_SHOP: "A-2" }, e);
    expect(seen.at(-1)).toEqual(["/x/bin/shop", "check", "--account", "A-2"]);
  });

  test("a failed install is recorded as install", () => {
    expect(checkSkill(SKILL, { SESSION_SHOP_SHOP: '{"headers":{}}' }, exec({ install: { code: 1 } }))).toMatchObject({ result: "install", detail: "install.sh: release v9 still being built" });
  });

  test("the session goes into a temp SITE_CLI_HOME and check runs read-only", () => {
    calls.length = 0;
    const o = checkSkill(SKILL, { SESSION_SHOP_SHOP: '{"headers":{}}' }, exec({ check: { code: 0, stdout: '{"ok":true,"operations":[]}' } }));
    expect(o.result).toBe("ok");
    expect(calls.at(-1)).toEqual(["/x/bin/shop", "check"]);
  });
});

test("isolatedEnv drops the job's secrets and keeps the rest", () => {
  expect(isolatedEnv({ PATH: "/bin", HOME: "/h", SECRETS_JSON: "{}", GH_TOKEN: "t", GITHUB_TOKEN: "t", SESSION_SHOP_SHOP: "s", X: undefined })).toEqual({ PATH: "/bin", HOME: "/h" });
});

test("fileIssues opens only what is not open yet and returns every number", () => {
  const opened: string[][] = [];
  const exec: Exec = (cmd) => {
    opened.push(cmd);
    return { code: 0, stdout: "https://github.com/acme/shop-plugin/issues/42\n", stderr: "" };
  };
  const n = fileIssues([{ title: "a", labels: ["drift"], body: "b", existing: 7 }, { title: "c", labels: ["drift"], body: "d" }], "acme/shop-plugin", exec, false, () => {});
  expect(n).toEqual([7, 42]);
  expect(opened).toEqual([["gh", "issue", "create", "--repo", "acme/shop-plugin", "--title", "c", "--body-file", "-", "--label", "drift"]]);
});

test("main: a failed install, or a skill whose check crashes, turns the run red; the other skills are still checked (review 1)", () => {
    const root = pluginRoot("main-red", "none");
    mkdirSync(join(root, "skills", "shop2", "cli", "src"), { recursive: true });
    writeFileSync(join(root, "skills", "shop2", "install.sh"), "");
    writeFileSync(join(root, "skills", "shop2", "cli", "src", "site.ts"), 'export default defineSite({\n  plugin: "shop",\n  skill: "shop2",\n  version: "1.2.3",\n  auth: "none" as Auth,\n});\n');
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const checked: string[] = [];
      const crashing: Exec = (cmd) => {
        if (cmd[0] === "bash") return { code: 0, stdout: "", stderr: "" };
        checked.push(cmd[0]!);
        if (cmd[0]!.endsWith("/shop")) throw new Error("ENOENT: no binary");
        return { code: 0, stdout: '{"ok":true,"operations":[]}', stderr: "" };
      };
      const summary = join(tmp, "summary-red.md");
      expect(main(["--root", root, "--repo", "acme/shop-plugin", "--dry-run"], crashing, { GITHUB_STEP_SUMMARY: summary })).toBe(1);
      expect(checked).toHaveLength(2);
      expect(readFileSync(summary, "utf8")).toContain("| shop | 1.2.3 | error |");
      expect(readFileSync(summary, "utf8")).toContain("| shop2 | 1.2.3 | ok |");
      const halfDrift: Exec = (cmd) =>
        cmd[0] === "bash" ? { code: 0, stdout: "", stderr: "" } : { code: 3, stdout: JSON.stringify({ error: { kind: "drift", drifts: [{ operation: "a", fingerprint: FP, diff: [] }, { operation: "b", fingerprint: "", diff: [] }] } }), stderr: "" };
      expect(main(["--root", root, "--repo", "acme/shop-plugin", "--dry-run"], halfDrift, {})).toBe(1);
      const noInstall: Exec = (cmd) => (cmd[0] === "bash" ? { code: 1, stdout: "", stderr: "no release" } : { code: 0, stdout: '{"ok":true,"operations":[]}', stderr: "" });
      expect(main(["--root", root, "--repo", "acme/shop-plugin", "--dry-run"], noInstall, {})).toBe(1);
      // A malformed session secret turns the run red too (review 3).
      const login = pluginRoot("main-bad-secret", "login");
      expect(main(["--root", login, "--repo", "acme/shop-plugin", "--dry-run"], noInstall, { SESSION_SHOP_SHOP: "not json" })).toBe(1);
    } finally {
      err.mockRestore();
    }
  });

test("main: a login skill without its secret is a notice and the run stays green; Drift opens its issue and the summary lists both", () => {
  const login = pluginRoot("main-login", "login");
  const notices: string[] = [];
  const log = spyOn(console, "log").mockImplementation((m: string) => void notices.push(m));
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const summary = join(tmp, "summary-login.md");
    expect(main(["--root", login, "--repo", "acme/shop-plugin"], () => ({ code: 1, stdout: "", stderr: "" }), { GITHUB_STEP_SUMMARY: summary })).toBe(0);
    expect(notices.join("\n")).toContain("the secret SESSION_SHOP_SHOP is not set");
    expect(readFileSync(summary, "utf8")).toContain("| shop | 1.2.3 | no-session |");

    const open = pluginRoot("main-none", "none");
    const created: string[][] = [];
    const exec: Exec = (cmd) => {
      if (cmd[0] === "bash") return { code: 0, stdout: "", stderr: "" };
      if (cmd[0] === "gh" && cmd[2] === "list") return { code: 0, stdout: "[]", stderr: "" };
      if (cmd[0] === "gh") {
        created.push(cmd);
        return { code: 0, stdout: "https://github.com/acme/shop-plugin/issues/9\n", stderr: "" };
      }
      return { code: 3, stdout: JSON.stringify({ error: { kind: "drift", drifts: [{ operation: "listOrders", fingerprint: FP, diff: [] }] } }), stderr: "" };
    };
    const summary2 = join(tmp, "summary-none.md");
    expect(main(["--root", open, "--repo", "acme/shop-plugin"], exec, { GITHUB_STEP_SUMMARY: summary2 })).toBe(0);
    expect(created.map((c) => c[c.indexOf("--title") + 1])).toEqual([FP]);
    expect(readFileSync(summary2, "utf8")).toContain("| shop | 1.2.3 | drift | 1 Operation(s) drifted: listOrders | #9 |");
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
});
