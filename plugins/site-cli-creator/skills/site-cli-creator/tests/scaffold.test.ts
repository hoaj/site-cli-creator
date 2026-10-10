import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generatorVersion, SKILL_ROOT } from "../tools/lib/paths";
import { chromePaths, unmetRequirements, versionAtLeast, type Gh, type Probe } from "../tools/lib/requirements";
import { findTokens } from "../tools/lib/template";

const NEW = join(SKILL_ROOT, "tools", "new.ts");
const ADD_SKILL = join(SKILL_ROOT, "tools", "add-skill.ts");
const REAL_STARTER = join(SKILL_ROOT, "starter");

let work: string;
let fakeStarter: string;

function write(path: string, content: string | Buffer, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode) chmodSync(path, mode);
}

/** A minimal Starter code tree with every kind of placeholder, in contents and paths. */
function makeFakeStarter(root: string) {
  write(join(root, "plugin", "README.md"), "# __PLUGIN__\n\n__DESCRIPTION__\n\nMaintainer: @__MAINTAINER__ (repo __REPO__, owner __OWNER__), generator __GENERATOR_VERSION__.\n");
  write(join(root, "plugin", "package.json"), JSON.stringify({ name: "__PLUGIN__-plugin", private: true }, null, 2));
  write(join(root, "plugin", ".gitignore"), "node_modules/\n");
  write(join(root, "plugin", "scripts", "bump.ts"), 'console.log("__PLUGIN__");\n');
  write(join(root, "plugin", "docs", "__PLUGIN__-notes.md"), "notes for __REPO__\n");
  write(join(root, "plugin", "assets", "logo.bin"), Buffer.from([0, 95, 95, 80, 76, 85, 71, 73, 78, 95, 95, 0]));
  write(join(root, "plugin", "node_modules", "junk", "index.js"), "__PLUGIN__");
  write(
    join(root, "feedback", "SKILL.md"),
    "---\nname: __PLUGIN__-feedback\ndescription: Files issues on __REPO__.\n---\n<!-- version: 9.9.9 -->\n\n# __PLUGIN__ feedback\n",
  );
  write(
    join(root, "skill", "SKILL.md"),
    "---\nname: __SKILL__\ndescription: CLI for __ORIGIN__.\n---\n<!-- version: 9.9.9 -->\n\n# __SKILL__\n\n## Commands\n\n<!-- commands:start -->\n<!-- commands:end -->\n",
  );
  write(join(root, "skill", "install.sh"), "#!/usr/bin/env bash\necho __SKILL__ from __REPO__\n", 0o755);
  write(join(root, "skill", "cli", "package.json"), JSON.stringify({ name: "__PLUGIN__-__SKILL__-cli", version: "9.9.9" }, null, 2));
  write(
    join(root, "skill", "cli", "src", "site.ts"),
    'export default {\n  plugin: "__PLUGIN__",\n  skill: "__SKILL__",\n  repo: "__REPO__",\n  version: "9.9.9",\n  generatedWith: "__GENERATOR_VERSION__",\n  origin: "__ORIGIN__",\n  auth: "__AUTH__",\n  needsChrome: false,\n};\n',
  );
  write(join(root, "skill", "cli", "src", "main.ts"), "// __SKILL__ main\n");
  write(join(root, "skill", "cli", "src", "operations", ".gitkeep"), "");
}

type Result = { code: number; out: any; stderr: string };

function run(tool: string, args: string[], env: Record<string, string> = {}): Result {
  const proc = Bun.spawnSync([process.execPath, tool, ...args], {
    env: { ...process.env, STARTER_DIR: fakeStarter, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  let out: unknown;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error(`not one JSON document on stdout:\n${stdout}\n${proc.stderr.toString()}`);
  }
  return { code: proc.exitCode ?? -1, out, stderr: proc.stderr.toString() };
}

// --skip-checks: the maintainer requirements are tested on their own below.
const newArgs = (dir: string, extra: string[] = [], checks = false) => [
  "--dir", dir, "--plugin", "shop", "--repo", "acme/shop-plugin", "--description", "Shop & billing, \"quoted\"", "--maintainer", "octo",
  ...(checks ? [] : ["--skip-checks"]), ...extra,
];

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "scaffold-test-"));
  fakeStarter = join(work, "starter");
  makeFakeStarter(fakeStarter);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("new.ts", () => {
  test("writes manifests, generated.json, README and the Feedback skill", () => {
    const dir = join(work, "plugin-a");
    const r = run(NEW, newArgs(dir, ["--no-labels"]));
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ plugin: "shop", repo: "acme/shop-plugin", version: "0.1.0", labels: "skipped" });

    const claude = readJson(join(dir, ".claude-plugin/plugin.json"));
    expect(claude).toEqual({
      name: "shop",
      description: 'Shop & billing, "quoted"',
      version: "0.1.0",
      author: { name: "octo" },
      homepage: "https://github.com/acme/shop-plugin",
      repository: "https://github.com/acme/shop-plugin",
      keywords: ["shop"],
      skills: ["./skills/shop-feedback"],
    });
    expect(readJson(join(dir, ".cursor-plugin/plugin.json"))).toEqual(claude);
    expect(readJson(join(dir, ".codex-plugin/plugin.json"))).toEqual({ ...claude, skills: "./skills/" });
    const { homepage: _, ...copilot } = claude;
    expect(readJson(join(dir, ".github/plugin/plugin.json"))).toEqual(copilot);

    // The repo is its own marketplace, named after the plugin, listing it at "./".
    const listing = {
      name: "shop",
      owner: { name: "octo" },
      metadata: { description: 'Shop & billing, "quoted"' },
      plugins: [{ name: "shop", source: "./", description: 'Shop & billing, "quoted"' }],
    };
    for (const f of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json", ".github/plugin/marketplace.json"]) {
      expect(readJson(join(dir, f)), f).toEqual(listing);
      expect(r.out.files).toContain(f);
    }
    expect(readJson(join(dir, ".agents/plugins/marketplace.json"))).toEqual({
      name: "shop",
      interface: { displayName: "shop" },
      plugins: [{ name: "shop", source: { source: "local", path: "./" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
    });

    expect(readJson(join(dir, "generated.json"))).toEqual({ generatedWith: generatorVersion(), maintainer: "octo" });
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("Maintainer: @octo (repo acme/shop-plugin, owner acme)");
    const feedback = readFileSync(join(dir, "skills/shop-feedback/SKILL.md"), "utf8");
    expect(feedback).toContain("name: shop-feedback");
    expect(feedback).toContain("<!-- version: 0.1.0 -->");
    expect(readFileSync(join(dir, "docs/shop-notes.md"), "utf8")).toBe("notes for acme/shop-plugin\n");
    expect(readFileSync(join(dir, "assets/logo.bin"))).toEqual(readFileSync(join(fakeStarter, "plugin/assets/logo.bin")));
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    expect(findTokens(dir).filter((t) => !t.file.startsWith("assets/"))).toEqual([]);
  });

  test("refuses a non-empty dir, accepts a fresh clone holding only .git", () => {
    const busy = join(work, "busy");
    write(join(busy, "keep.txt"), "x");
    const r = run(NEW, newArgs(busy, ["--no-labels"]));
    expect(r.code).toBe(1);
    expect(r.out.error.message).toContain("non-empty");
    expect(readFileSync(join(busy, "keep.txt"), "utf8")).toBe("x");

    const clone = join(work, "clone");
    mkdirSync(join(clone, ".git"), { recursive: true });
    expect(run(NEW, newArgs(clone, ["--no-labels"])).code).toBe(0);
  });

  test("validates flags", () => {
    expect(run(NEW, ["--dir", join(work, "x")]).out.error.message).toContain("missing --plugin");
    expect(run(NEW, newArgs(join(work, "x"), ["--no-labels"]).map((a) => (a === "shop" ? "Shop_Plugin" : a))).out.error.message).toContain("kebab-case");
    expect(run(NEW, newArgs(join(work, "x"), ["--no-labels"]).map((a) => (a === "acme/shop-plugin" ? "nope" : a))).out.error.message).toContain("owner/name");
    expect(run(NEW, [...newArgs(join(work, "x")), "--bogus"]).out.error.message).toContain("bogus");
    const unquoted = run(NEW, ["--dir", join(work, "x"), "--plugin", "shop", "--repo", "a/b", "--description", "Shop", "billing", "--maintainer", "m", "--no-labels", "--skip-checks"]);
    expect(unquoted.code).toBe(1);
    expect(unquoted.out.error.message).toContain('unexpected argument "billing"');
    expect(existsSync(join(work, "x"))).toBe(false);
    expect(run(NEW, newArgs(join(work, "x"), ["--no-labels"]), { STARTER_DIR: join(work, "missing") }).out.error.message).toContain("starter/plugin");
  });

  test("creates the three labels with gh, and reports a gh failure", () => {
    const bin = join(work, "gh-bin");
    const log = join(work, "gh.log");
    write(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\n[ -n "$GH_FAIL" ] && { echo "HTTP 403" >&2; exit 1; }\nexit 0\n`, 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const ok = run(NEW, newArgs(join(work, "plugin-labels")), env);
    expect(ok.code).toBe(0);
    expect(ok.out.labels).toEqual({ created: ["feature", "unverified", "needs-account"] });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(3);
    for (const [i, name] of ["feature", "unverified", "needs-account"].entries()) {
      expect(calls[i]).toStartWith(`label create ${name} --repo acme/shop-plugin --force`);
    }
    const failed = run(NEW, newArgs(join(work, "plugin-labels-fail")), { ...env, GH_FAIL: "1" });
    expect(failed.out.labels.created).toEqual([]);
    expect(failed.out.labels.failed).toContain("HTTP 403");
    expect(failed.code).toBe(0);

    // No gh at all: the plugin is still written and new exits 0, reporting the labels it could not make.
    const noGh = join(work, "no-gh-bin");
    mkdirSync(noGh, { recursive: true });
    const missing = run(NEW, newArgs(join(work, "plugin-no-gh")), { PATH: noGh });
    expect(missing.code).toBe(0);
    expect(missing.out.labels.created).toEqual([]);
    expect(missing.out.labels.failed).toContain("gh label create feature");
    expect(existsSync(join(work, "plugin-no-gh", "generated.json"))).toBe(true);
  });
});

describe("maintainer requirements (SPEC §13)", () => {
  const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const probe = (over: Partial<Probe> = {}, gh: Record<string, ReturnType<Gh>> = {}): Probe => ({
    bunVersion: "1.4.3",
    platform: "darwin",
    env: {},
    exists: (p) => p === CHROME,
    gh: (args) => gh[args.slice(0, 2).join(" ")] ?? { ok: true, stdout: "true\n", stderr: "" },
    ...over,
  });
  const names = (p: Probe) => unmetRequirements("acme/shop-plugin", p).map((u) => u.requirement);

  test("all met", () => {
    expect(unmetRequirements("acme/shop-plugin", probe())).toEqual([]);
  });

  test("every unmet requirement is listed, not just the first", () => {
    const p = probe({ bunVersion: "1.3.9", exists: () => false }, { "auth status": { ok: false, stdout: "", stderr: "not logged in" } });
    const unmet = unmetRequirements("acme/shop-plugin", p);
    expect(unmet.map((u) => u.requirement)).toEqual(["bun", "chrome", "gh-auth", "repo-admin"]);
    expect(unmet[0]!.message).toContain("1.4.0");
    expect(unmet[2]!.message).toContain("gh auth login");
  });

  test("gh missing, repo missing, no admin", () => {
    expect(names(probe({ gh: () => "missing" }))).toEqual(["gh", "repo-admin"]);
    const missing = unmetRequirements("acme/shop-plugin", probe({}, { "api repos/acme/shop-plugin": { ok: false, stdout: "", stderr: "gh: Not Found (HTTP 404)" } }));
    expect(missing).toHaveLength(1);
    expect(missing[0]!.message).toContain("gh repo create acme/shop-plugin --private");
    expect(names(probe({}, { "api repos/acme/shop-plugin": { ok: true, stdout: "false\n", stderr: "" } }))).toEqual(["repo-admin"]);
  });

  test("versions and Chrome paths", () => {
    expect(versionAtLeast("1.4.0", "1.4.0")).toBe(true);
    expect(versionAtLeast("1.10.0", "1.4.0")).toBe(true);
    expect(versionAtLeast("1.3.12", "1.4.0")).toBe(false);
    expect(versionAtLeast("2.0.0-canary.1", "1.4.0")).toBe(true);
    expect(chromePaths("linux", {})).toEqual(["/opt/google/chrome/chrome"]);
    expect(chromePaths("linux", { SITE_CLI_CHROME: "/x/chrome" })).toEqual(["/x/chrome"]);
    expect(chromePaths("win32", { PROGRAMFILES: "C:\\Program Files" })).toEqual(["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]);
  });

  test("new.ts checks before writing anything and fails with every unmet requirement as JSON", () => {
    const bin = join(work, "req-gh-bin");
    write(
      join(bin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "auth status") [ -n "$GH_LOGGED_OUT" ] && exit 1; exit 0 ;;
  "api repos/acme/shop-plugin") [ -n "$GH_NO_REPO" ] && { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }; echo "\${GH_ADMIN:-true}"; exit 0 ;;
esac
exit 0
`,
      0o755,
    );
    const chrome = join(work, "fake-chrome");
    write(chrome, "", 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}`, SITE_CLI_CHROME: chrome };

    const dir = join(work, "plugin-checked");
    const ok = run(NEW, newArgs(dir, ["--no-labels"], true), env);
    expect(ok.code).toBe(0);
    expect(existsSync(join(dir, "generated.json"))).toBe(true);

    const blocked = join(work, "plugin-blocked");
    const r = run(NEW, newArgs(blocked, ["--no-labels"], true), { ...env, SITE_CLI_CHROME: join(work, "no-chrome"), GH_NO_REPO: "1" });
    expect(r.code).toBe(1);
    expect(r.out.error.unmet.map((u: { requirement: string }) => u.requirement)).toEqual(["chrome", "repo-admin"]);
    expect(r.out.error.message).toContain("nothing was written");
    expect(r.out.error.message).toContain("gh repo create acme/shop-plugin");
    expect(existsSync(blocked)).toBe(false);

    const loggedOut = run(NEW, newArgs(blocked, ["--no-labels"], true), { ...env, GH_LOGGED_OUT: "1" });
    expect(loggedOut.out.error.unmet.map((u: { requirement: string }) => u.requirement)).toEqual(["gh-auth", "repo-admin"]);
    const notAdmin = run(NEW, newArgs(blocked, ["--no-labels"], true), { ...env, GH_ADMIN: "false" });
    expect(notAdmin.out.error.unmet.map((u: { requirement: string }) => u.requirement)).toEqual(["repo-admin"]);
    expect(existsSync(blocked)).toBe(false);
  });
});

describe("add-skill.ts", () => {
  let plugin: string;
  beforeAll(() => {
    plugin = join(work, "plugin-b");
    expect(run(NEW, newArgs(plugin, ["--no-labels"])).code).toBe(0);
  });

  test("copies starter/skill, fills placeholders and version pins, lists the skill", () => {
    const r = run(ADD_SKILL, ["--dir", plugin, "--skill", "shop-web", "--origin", "https://www.shop.example/some/page", "--auth", "login"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ plugin: "shop", skill: "shop-web", origin: "https://www.shop.example", auth: "login", version: "0.1.0" });
    expect(r.out.manifests.sort()).toEqual([".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", ".github/plugin/plugin.json"]);

    const skill = join(plugin, "skills", "shop-web");
    const site = readFileSync(join(skill, "cli/src/site.ts"), "utf8");
    expect(site).toContain('plugin: "shop"');
    expect(site).toContain('skill: "shop-web"');
    expect(site).toContain('repo: "acme/shop-plugin"');
    expect(site).toContain('version: "0.1.0"');
    expect(site).toContain(`generatedWith: "${generatorVersion()}"`);
    expect(site).toContain('origin: "https://www.shop.example"');
    expect(site).toContain('auth: "login"');
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toContain("<!-- version: 0.1.0 -->");
    expect(readJson(join(skill, "cli/package.json"))).toEqual({ name: "shop-shop-web-cli", version: "0.1.0" });
    expect(statSync(join(skill, "install.sh")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(skill, ".gitignore"), "utf8")).toBe("bin/\n");
    expect(existsSync(join(skill, "cli/src/operations/.gitkeep"))).toBe(true);
    expect(findTokens(skill)).toEqual([]);

    expect(readJson(join(plugin, ".claude-plugin/plugin.json")).skills).toEqual(["./skills/shop-feedback", "./skills/shop-web"]);
    expect(readJson(join(plugin, ".github/plugin/plugin.json")).skills).toEqual(["./skills/shop-feedback", "./skills/shop-web"]);
    expect(readJson(join(plugin, ".codex-plugin/plugin.json")).skills).toBe("./skills/");
  });

  test("takes the version from the plugin manifest", () => {
    const manifest = join(plugin, ".claude-plugin/plugin.json");
    writeFileSync(manifest, JSON.stringify({ ...readJson(manifest), version: "0.4.2" }));
    expect(run(ADD_SKILL, ["--dir", plugin, "--skill", "shop-api", "--origin", "http://127.0.0.1:8080", "--auth", "none"]).code).toBe(0);
    const site = readFileSync(join(plugin, "skills/shop-api/cli/src/site.ts"), "utf8");
    expect(site).toContain('version: "0.4.2"');
    expect(site).toContain('origin: "http://127.0.0.1:8080"');
    expect(site).toContain('auth: "none"');
  });

  test("refuses bad input and existing skills", () => {
    const base = ["--dir", plugin, "--origin", "https://www.shop.example", "--auth", "none"];
    expect(run(ADD_SKILL, [...base, "--skill", "shop-web"]).out.error.message).toContain("already exists");
    expect(run(ADD_SKILL, [...base, "--skill", "shop-feedback"]).out.error.message).toContain("Feedback skill");
    expect(run(ADD_SKILL, ["--dir", plugin, "--skill", "x", "--origin", "https://a.example", "--auth", "maybe"]).out.error.message).toContain("login or none");
    expect(run(ADD_SKILL, ["--dir", plugin, "--skill", "x", "--origin", "not a url", "--auth", "none"]).out.error.message).toContain("--origin");
    expect(run(ADD_SKILL, ["--dir", join(work, "nowhere"), "--skill", "x", "--origin", "https://a.example", "--auth", "none"]).code).toBe(1);
  });
});

const realStarterReady = ["plugin/package.json", "feedback/SKILL.md", "skill/SKILL.md", "skill/cli/src/site.ts", "skill/cli/src/main.ts"].every(
  (f) => existsSync(join(REAL_STARTER, f)),
);

describe.skipIf(!realStarterReady)("against the real Starter code", () => {
  test("new + add-skill produce the ARCHITECTURE §3 layout with no placeholders left", () => {
    const dir = join(work, "real");
    const env = { STARTER_DIR: REAL_STARTER };
    const created = run(NEW, newArgs(dir, ["--no-labels"]), env);
    expect(created.code).toBe(0);
    const added = run(ADD_SKILL, ["--dir", dir, "--skill", "shop", "--origin", "https://www.shop.example", "--auth", "login"], env);
    expect(added.code).toBe(0);
    for (const f of [
      ".claude-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".github/plugin/plugin.json",
      ".github/workflows/release.yml",
      ".github/workflows/ci.yml",
      "package.json",
      "scripts/bump.ts",
      "scripts/version-check.ts",
      "tests/version-sync.test.ts",
      "generated.json",
      "README.md",
      ".gitignore",
      "skills/shop-feedback/SKILL.md",
      "skills/shop/SKILL.md",
      "skills/shop/install.sh",
      "skills/shop/.gitignore",
      "skills/shop/cli/package.json",
      "skills/shop/cli/tsconfig.json",
      "skills/shop/cli/build.ts",
      "skills/shop/cli/src/main.ts",
      "skills/shop/cli/src/site.ts",
      "skills/shop/cli/src/runtime/operation.ts",
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(findTokens(dir)).toEqual([]);
  });

  test("the generated skill's runtime tests pass once the placeholders are filled", () => {
    const cli = join(work, "real", "skills", "shop", "cli");
    symlinkSync(join(SKILL_ROOT, "..", "..", "node_modules"), join(cli, "node_modules"));
    const proc = Bun.spawnSync([process.execPath, "test", "tests/main.test.ts", "tests/site.test.ts"], { cwd: cli, stdout: "pipe", stderr: "pipe" });
    const out = proc.stderr.toString().replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain(" 0 fail");
    expect(out).toMatch(/ 2 skip/); // the unfilled-site.ts cases skip themselves in a generated plugin
    expect(proc.exitCode).toBe(0);
  }, 60_000);

  test("the generated plugin's version-sync test passes", () => {
    const dir = join(work, "real");
    const proc = Bun.spawnSync([process.execPath, "test", "tests/version-sync.test.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(proc.stderr.toString()).toContain(" 0 fail");
    expect(proc.exitCode).toBe(0);
  });
});
