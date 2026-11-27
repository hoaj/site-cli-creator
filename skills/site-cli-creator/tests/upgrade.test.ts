// upgrade (SPEC §5, #118): a plugin made with an older Starter code is brought to this one by a three-way
// merge. The base Starter here is a copy of the real one with known changes; the target is the real one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { generatorVersion, SKILL_ROOT } from "../tools/lib/paths";
import { pickBase } from "../tools/lib/upgrade";

const NEW = join(SKILL_ROOT, "tools", "new.ts");
const ADD_SKILL = join(SKILL_ROOT, "tools", "add-skill.ts");
const UPGRADE = join(SKILL_ROOT, "tools", "upgrade.ts");
const REAL_STARTER = join(SKILL_ROOT, "starter");
const OLD = "0.0.1";
const LATER = "0.0.2";

let work: string;
/** --starters: <version>/ copies of past Starter code. */
let starters: string;
let base: string;
let later: string;

type Result = { code: number; out: any; stderr: string };

function run(tool: string, args: string[], starter: string): Result {
  const proc = Bun.spawnSync([process.execPath, tool, ...args], { env: { ...process.env, STARTER_DIR: starter }, stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString();
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    out = stdout;
  }
  return { code: proc.exitCode ?? -1, out, stderr: proc.stderr.toString() };
}

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (!proc.success) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

const read = (p: string) => readFileSync(p, "utf8");
const edit = (p: string, from: string, to: string) => {
  const text = read(p);
  if (!text.includes(from)) throw new Error(`${p} has no ${JSON.stringify(from)}`);
  writeFileSync(p, text.replace(from, to));
};

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** The old Starter code: the real one before the daily drift check, with a file since removed and lines since changed. */
function makeBaseStarter(dir: string) {
  cpSync(REAL_STARTER, dir, { recursive: true, filter: (src) => !src.split(sep).includes("node_modules") });
  rmSync(join(dir, "plugin/.github/workflows/__PREFIX__drift-check.yml"));
  rmSync(join(dir, "plugin/scripts/drift-check.ts"));
  rmSync(join(dir, "plugin/tests/drift-check.test.ts"));
  writeFileSync(join(dir, "plugin/scripts/legacy.ts"), "// a script the Starter code dropped later\n");
  edit(join(dir, "skill/cli/src/runtime/envelope.ts"), "// stdout carries exactly one JSON document", "// stdout carries one JSON document");
  edit(join(dir, "skill/install.sh"), "# Run it once, when the binary is missing", "# Run it when the binary is missing");
  edit(join(dir, "plugin/README.md"), "# __PLUGIN__", "# __PLUGIN__ (old heading)");
  edit(join(dir, "plugin/tests/bump.test.ts"), "import", "// old\nimport");
  edit(join(dir, "plugin/.github/workflows/__PREFIX__ci.yml"), "name: ", "# old\nname: ");
  edit(join(dir, "skill/cli/src/site.ts"), "  dailyCheck: true,", "  dailyCheck: true,\n  oldField: true,");
}

/** A plugin as new + add-skill write it from `starter`, in its own repo (dir) or in plugins/demo of a shared repo (into). */
function makePlugin(where: { dir: string } | { into: string }, starter: string): string {
  const flag = "dir" in where ? ["--dir", where.dir] : ["--into", where.into];
  const made = run(NEW, [...flag, "--plugin", "demo", "--repo", "test-owner/demo", "--description", "Demo plugin", "--maintainer", "test-owner", "--no-labels", "--skip-checks"], starter);
  if (made.code !== 0) throw new Error(`new: ${JSON.stringify(made.out)} ${made.stderr}`);
  const dir = made.out.dir as string;
  for (const [skill, auth] of [["shop", "none"], ["bank", "login"]]) {
    const added = run(ADD_SKILL, ["--dir", dir, "--skill", skill!, "--origin", `https://${skill}.example.com`, "--auth", auth!, "--daily-check", "on"], starter);
    if (added.code !== 0) throw new Error(`add-skill: ${JSON.stringify(added.out)}`);
  }
  return dir;
}

/** Marks the plugin as made with the old generator, as a plugin from before this one would be. */
function setGeneratedWith(dir: string, version: string) {
  const path = join(dir, "generated.json");
  writeFileSync(path, `${JSON.stringify({ ...JSON.parse(read(path)), generatedWith: version }, null, 2)}\n`);
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "upgrade-test-"));
  starters = join(work, "starters");
  base = join(starters, OLD);
  makeBaseStarter(base);
  // A later Starter version: the old one with the envelope.ts line already as it is now.
  later = join(starters, LATER);
  cpSync(base, later, { recursive: true });
  edit(join(later, "skill/cli/src/runtime/envelope.ts"), "// stdout carries one JSON document", "// stdout carries exactly one JSON document");
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("pickBase", () => {
  test("the version itself when the source has it, else the closest one below it, marked approximate", () => {
    const versions = ["0.9.1", "0.15.0", "0.18.0", "0.21.1"];
    expect(pickBase(versions, "0.15.0")).toEqual({ version: "0.15.0", approximate: false });
    expect(pickBase(versions, "0.17.0")).toEqual({ version: "0.15.0", approximate: true });
    expect(pickBase(versions, "0.2.1")).toBeNull();
  });
});

describe("upgrade, a plugin in its own repo", () => {
  let dir: string;
  let fresh: string;
  let result: Result;
  const siteCode: Record<string, string> = {};

  beforeAll(() => {
    dir = makePlugin({ dir: join(work, "own") }, base);
    setGeneratedWith(dir, OLD);
    // The site's own code, as the Task loop writes it.
    const shop = join(dir, "skills/shop");
    writeFileSync(join(shop, "cli/src/operations/getThing.ts"), "export default {};\n");
    writeFileSync(join(shop, "cli/src/commands/thing-show.ts"), "export default {};\n");
    mkdirSync(join(shop, "captures/thing-show"), { recursive: true });
    writeFileSync(join(shop, "captures/thing-show/index.json"), "{}\n");
    edit(join(shop, "cli/src/site.ts"), "  dailyCheck: true,", "  dailyCheck: false,");
    // The maintainer's own edits to Starter files.
    edit(join(shop, "install.sh"), "#   5. macOS: strip quarantine", "#   5. macOS (plugin edit): strip quarantine");
    edit(join(dir, "README.md"), "# demo (old heading)", "# demo, the plugin's own heading");
    rmSync(join(dir, "tests/bump.test.ts"));
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "plugin");
    for (const f of files(dir)) if (/skills\/[^/]+\/(cli\/src\/(site|registry)\.ts|cli\/src\/(operations|commands)\/|captures\/)/.test(f)) siteCode[f] = read(join(dir, f));

    result = run(UPGRADE, ["--dir", dir, "--starters", starters], REAL_STARTER);
    fresh = makePlugin({ dir: join(work, "fresh") }, REAL_STARTER);
   }, 60_000);

  test("reports what it did and records the new generatedWith", () => {
    expect(result.code).toBe(0);
    expect(result.out).toMatchObject({
      from: OLD,
      to: generatorVersion(),
      bases: { plugin: { version: OLD }, skills: { bank: { version: OLD, from: "closest" }, shop: { version: OLD, from: "closest" } } },
    });
    expect(JSON.parse(read(join(dir, "generated.json"))).generatedWith).toBe(generatorVersion());
  });

  test("a Starter file the plugin never changed is now the new Starter file, and new ones are added", () => {
    expect(result.out.added).toEqual(expect.arrayContaining([".github/workflows/drift-check.yml", "scripts/drift-check.ts", "tests/drift-check.test.ts"]));
    expect(result.out.updated).toEqual(expect.arrayContaining(["skills/shop/cli/src/runtime/envelope.ts", "skills/bank/install.sh", ".github/workflows/ci.yml"]));
    const edited = new Set(["README.md", "skills/shop/install.sh", "generated.json"]);
    let compared = 0;
    for (const f of files(fresh)) {
      if (edited.has(f) || f in siteCode || /\/cli\/src\/(site|registry)\.ts$/.test(f)) continue;
      if (f === "tests/bump.test.ts") continue;
      expect({ f, same: existsSync(join(dir, f)) && read(join(dir, f)) === read(join(fresh, f)) }).toEqual({ f, same: true });
      compared++;
    }
    expect(compared).toBeGreaterThan(100);
  });

  test("the site's own code is byte for byte as it was", () => {
    expect(Object.keys(siteCode).length).toBeGreaterThanOrEqual(7);
    for (const [f, text] of Object.entries(siteCode)) expect({ f, same: read(join(dir, f)) === text }).toEqual({ f, same: true });
    expect(read(join(dir, "skills/shop/cli/src/site.ts"))).toContain("oldField: true");
    expect(result.out.siteTemplateDiff).toContain("-  oldField: true,");
  });

  test("an edit on other lines is merged; an edit on the same lines is a conflict with markers", () => {
    expect(result.out.merged).toContain("skills/shop/install.sh");
    const install = read(join(dir, "skills/shop/install.sh"));
    expect(install).toContain("(plugin edit)");
    expect(install).toContain("# Run it once, when the binary is missing");
    expect(result.out.conflicts).toEqual(["README.md"]);
    const readme = read(join(dir, "README.md"));
    expect(readme).toContain("<<<<<<< demo\n# demo, the plugin's own heading\n||||||| starter it came from\n# demo (old heading)\n=======\n# demo\n>>>>>>> starter v");
  });

  test("a file dropped from the Starter code and one the plugin deleted are only reported", () => {
    expect(result.out.removedFromStarter).toEqual(["scripts/legacy.ts"]);
    expect(existsSync(join(dir, "scripts/legacy.ts"))).toBe(true);
    expect(result.out.deletedInPlugin).toEqual(["tests/bump.test.ts"]);
    expect(existsSync(join(dir, "tests/bump.test.ts"))).toBe(false);
    expect(result.out.workflowsChanged).toBe(true);
  });

  test("a plugin already at this version is up to date, and one with uncommitted changes is refused", () => {
    expect(run(UPGRADE, ["--dir", dir, "--starters", starters], REAL_STARTER).out).toMatchObject({ upToDate: true });
    setGeneratedWith(dir, OLD);
    const dirty = run(UPGRADE, ["--dir", dir, "--starters", starters], REAL_STARTER);
    expect(dirty.code).toBe(1);
    expect(dirty.out.error.message).toContain("uncommitted changes");
   }, 30_000);
});

describe("upgrade, a CLI skill added with a later generator", () => {
  test("its base is the version in generated.json, else the closest version, so its newer Starter lines are no conflict", () => {
    const dir = makePlugin({ dir: join(work, "late") }, base);
    const late = run(ADD_SKILL, ["--dir", dir, "--skill", "late", "--origin", "https://late.example.com", "--auth", "none", "--daily-check", "on"], later);
    expect(late.code).toBe(0);
    // The plugin was made with OLD; "late" came from LATER, with no record (an add-skill from before it kept one), "shop" with one.
    const path = join(dir, "generated.json");
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(read(path)), generatedWith: OLD, skills: { shop: OLD } }, null, 2)}\n`);
    edit(join(dir, "skills/late/cli/src/runtime/envelope.ts"), "export const EXIT", "// a plugin edit\nexport const EXIT");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "plugin");
    const result = run(UPGRADE, ["--dir", dir, "--starters", starters], REAL_STARTER);
    expect(result.code).toBe(0);
    expect(result.out.bases.skills).toMatchObject({ late: { version: LATER, from: "closest" }, shop: { version: OLD, from: "generated.json" } });
    expect(result.out.conflicts).not.toContain("skills/late/cli/src/runtime/envelope.ts");
    expect(read(join(dir, "skills/late/cli/src/runtime/envelope.ts"))).toContain("// a plugin edit\nexport const EXIT");
    expect(result.out.updated).toContain("skills/shop/cli/src/runtime/envelope.ts");
    expect(JSON.parse(read(path))).not.toHaveProperty("skills");
  }, 60_000);

  test("add-skill records the Starter version it copied when it is not the plugin's generatedWith", () => {
    const dir = makePlugin({ dir: join(work, "record") }, base);
    setGeneratedWith(dir, OLD);
    expect(run(ADD_SKILL, ["--dir", dir, "--skill", "extra", "--origin", "https://extra.example.com", "--auth", "none", "--daily-check", "on"], base).code).toBe(0);
    expect(JSON.parse(read(join(dir, "generated.json")))).toMatchObject({ generatedWith: OLD, skills: { extra: generatorVersion() } });
  }, 60_000);
});

describe("upgrade, a plugin in a shared repo", () => {
  test("merges the workflows at the repo root and never adds the daily drift check", () => {
    const root = join(work, "shared");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "hoaj", owner: { name: "test-owner" }, plugins: [] }));
    const dir = makePlugin({ into: root }, base);
    setGeneratedWith(dir, OLD);
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "shared");
    const result = run(UPGRADE, ["--dir", dir, "--starters", starters], REAL_STARTER);
    expect(result.code).toBe(0);
    expect(result.out.updated).toEqual(expect.arrayContaining([".github/workflows/demo-ci.yml", "plugins/demo/skills/shop/cli/src/runtime/envelope.ts"]));
    expect(result.out.added).toEqual([]);
    expect(existsSync(join(root, ".github/workflows/demo-drift-check.yml"))).toBe(false);
    expect(result.out.removedFromStarter).toEqual(["plugins/demo/scripts/legacy.ts"]);
   }, 60_000);
});

// The generator's CI tags its versions for upgrade; the script lives at the repo root, not in the plugin's skills/.
const VERSION_TAGS = join(SKILL_ROOT, "../../.github/scripts/version-tags.sh");

describe.skipIf(!existsSync(VERSION_TAGS))("version-tags.sh (the generator's tags for upgrade)", () => {
  test("lists each untagged version at its first commit on main's first-parent history, never a branch's own", () => {
    const repo = join(work, "tags-repo");
    mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
    const bump = (version: string, message: string) => {
      writeFileSync(join(repo, ".claude-plugin/plugin.json"), JSON.stringify({ name: "g", version }));
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", message);
      return git(repo, "rev-parse", "HEAD").trim();
    };
    git(repo, "init", "-q", "-b", "main");
    bump("0.1.0", "first");
    git(repo, "tag", "v0.1.0");
    writeFileSync(join(repo, "notes.md"), "docs only\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "docs, same version");
    git(repo, "switch", "-qc", "feature");
    bump("0.1.5", "a branch's own step");
    bump("0.2.0", "the branch's version");
    git(repo, "switch", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "feature", "-m", "merge feature");
    const merge = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "notes.md"), "later docs\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "docs, still 0.2.0");
    const proc = Bun.spawnSync(["bash", VERSION_TAGS, "main"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.stdout.toString()).toBe(`v0.2.0 ${merge}\n`);
  });
});
