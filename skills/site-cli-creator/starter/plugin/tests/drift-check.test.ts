import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkill, classify, discover, fileIssues, fixedIn, isolatedEnv, main, planIssues, secretName, sessionText, type Exec, type Result, type Skill } from "../scripts/drift-check";

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

  test("an open issue with the same title is reused, not filed again", () => {
    expect(planIssues(SKILL, drift, [{ number: 7, title: FP, state: "OPEN" }], undefined, [], "acme/shop-plugin")[0]!.existing).toBe(7);
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

  test("fixedIn reads a fixed-in:vX.Y.Z label", () => {
    expect(fixedIn({ number: 1, title: "", state: "CLOSED", labels: [{ name: "drift" }, { name: "fixed-in:v2.0.0" }] })).toBe("2.0.0");
    expect(fixedIn({ number: 1, title: "", state: "CLOSED", labels: [{ name: "drift" }] })).toBeNull();
  });

  test("session: a ci-session issue that says how to make a CI sign-in of its own and store it as the secret", () => {
    const [p] = planIssues(SKILL, classify(4, JSON.stringify({ error: { kind: "session" } })), [], undefined, [], "acme/shop-plugin");
    expect(p!.labels).toEqual(["ci-session"]);
    expect(p!.body).toContain('export SITE_CLI_HOME="$(mktemp -d)" && bin/shop login');
    expect(p!.body).toContain('gh secret set SESSION_SHOP_SHOP --repo acme/shop-plugin < "$SITE_CLI_HOME/session.json"');
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
