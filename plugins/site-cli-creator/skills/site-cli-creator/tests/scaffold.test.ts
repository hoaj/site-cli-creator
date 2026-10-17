import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyExpected } from "../fixtures/expected/copy";
import { generatorVersion, SKILL_ROOT } from "../tools/lib/paths";
import { unmetRequirements, versionAtLeast, type Gh, type Probe } from "../tools/lib/requirements";
import { copyTemplate, findTokens } from "../tools/lib/template";

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
    join(root, "deploy", "SKILL.md"),
    "---\nname: __PLUGIN__-deploy\ndescription: Deploys a __PLUGIN__ CLI skill from __REPO__.\n---\n<!-- version: 9.9.9 -->\n\n# __PLUGIN__ deploy\n",
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
  test("writes manifests, generated.json, README, the Deploy skill and the Feedback skill", () => {
    const dir = join(work, "plugin-a");
    const r = run(NEW, newArgs(dir, ["--no-labels"]));
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ plugin: "shop", repo: "acme/shop-plugin", version: "0.1.0", labels: "skipped" });
    // `next` works from any directory: it names the tool by its absolute path.
    expect(r.out.next).toStartWith(`bun ${join(SKILL_ROOT, "tools", "add-skill.ts")} --dir ${dir}`);

    const claude = readJson(join(dir, ".claude-plugin/plugin.json"));
    expect(claude).toEqual({
      name: "shop",
      description: 'Shop & billing, "quoted"',
      version: "0.1.0",
      author: { name: "octo" },
      homepage: "https://github.com/acme/shop-plugin",
      repository: "https://github.com/acme/shop-plugin",
      keywords: ["shop"],
      skills: ["./skills/shop-deploy", "./skills/shop-feedback"],
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

    expect(readJson(join(dir, "generated.json"))).toEqual({ generatedWith: generatorVersion(), maintainer: "octo", pluginDir: ".", tagPrefix: "v" });
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("Maintainer: @octo (repo acme/shop-plugin, owner acme)");
    const feedback = readFileSync(join(dir, "skills/shop-feedback/SKILL.md"), "utf8");
    expect(feedback).toContain("name: shop-feedback");
    expect(feedback).toContain("<!-- version: 0.1.0 -->");
    const deploy = readFileSync(join(dir, "skills/shop-deploy/SKILL.md"), "utf8");
    expect(deploy).toContain("name: shop-deploy");
    expect(deploy).toContain("<!-- version: 0.1.0 -->");
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

  test("creates the five labels with gh (feature, drift, bug, unverified, needs-account); a gh failure is an error that keeps the files and says how to retry", () => {
    const bin = join(work, "gh-bin");
    const log = join(work, "gh.log");
    write(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\n[ -n "$GH_FAIL" ] && { echo "HTTP 403" >&2; exit 1; }\nexit 0\n`, 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const ok = run(NEW, newArgs(join(work, "plugin-labels")), env);
    expect(ok.code).toBe(0);
    expect(ok.out.labels).toEqual({ created: ["feature", "drift", "bug", "unverified", "needs-account"] });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(5);
    for (const [i, name] of ["feature", "drift", "bug", "unverified", "needs-account"].entries()) {
      expect(calls[i]).toStartWith(`label create ${name} --repo acme/shop-plugin --force`);
    }
    const failed = run(NEW, newArgs(join(work, "plugin-labels-fail")), { ...env, GH_FAIL: "1" });
    expect(failed.code).toBe(1);
    expect(failed.out.error.labels.created).toEqual([]);
    expect(failed.out.error.labels.failed).toContain("HTTP 403");
    expect(failed.out.error.message).toContain("files were written");
    expect(failed.out.error.retry).toHaveLength(5);
    expect(failed.out.error.retry[0]).toStartWith("gh label create feature --repo acme/shop-plugin --force");
    expect(failed.out.error.retry[0]).toContain("--description 'A Task the plugin");
    expect(failed.out.error.next).toContain("add-skill.ts --dir");
    expect(existsSync(join(work, "plugin-labels-fail", "generated.json"))).toBe(true);

    // No gh at all: the plugin is still written; new fails and lists the labels it could not make.
    const noGh = join(work, "no-gh-bin");
    mkdirSync(noGh, { recursive: true });
    const missing = run(NEW, newArgs(join(work, "plugin-no-gh")), { PATH: noGh });
    expect(missing.code).toBe(1);
    expect(missing.out.error.labels.created).toEqual([]);
    expect(missing.out.error.labels.failed).toContain("gh label create feature");
    expect(missing.out.error.retry.map((c: string) => c.split(" ")[3])).toEqual(["feature", "drift", "bug", "unverified", "needs-account"]);
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
    expect(missing[0]!.message).toContain("gh repo create acme/shop-plugin --public");
    expect(names(probe({}, { "api repos/acme/shop-plugin": { ok: true, stdout: "false\n", stderr: "" } }))).toEqual(["repo-admin"]);
  });

  test("versions and Chrome paths", () => {
    expect(versionAtLeast("1.4.0", "1.4.0")).toBe(true);
    expect(versionAtLeast("1.10.0", "1.4.0")).toBe(true);
    expect(versionAtLeast("1.3.12", "1.4.0")).toBe(false);
    expect(versionAtLeast("2.0.0-canary.1", "1.4.0")).toBe(true);
    const chromeMessage = (platform: string, env: Probe["env"]) => unmetRequirements("acme/shop-plugin", probe({ platform, env, exists: () => false }))[0]!.message;
    expect(chromeMessage("linux", {})).toContain("(looked at /opt/google/chrome/chrome)");
    expect(chromeMessage("linux", { SITE_CLI_CHROME: "/x/chrome" })).toContain("(looked at /x/chrome)");
    expect(chromeMessage("win32", { PROGRAMFILES: "C:\\Program Files" })).toContain("(looked at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe)");
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

    expect(readJson(join(plugin, ".claude-plugin/plugin.json")).skills).toEqual(["./skills/shop-deploy", "./skills/shop-feedback", "./skills/shop-web"]);
    expect(readJson(join(plugin, ".github/plugin/plugin.json")).skills).toEqual(["./skills/shop-deploy", "./skills/shop-feedback", "./skills/shop-web"]);
    expect(readJson(join(plugin, ".codex-plugin/plugin.json")).skills).toBe("./skills/");
  });

  test("generatedWith comes from generated.json (the version the plugin was created with), and next is absolute", () => {
    const generated = join(plugin, "generated.json");
    const before = readFileSync(generated, "utf8");
    writeFileSync(generated, JSON.stringify({ generatedWith: "0.0.9", maintainer: "alice" }));
    try {
      const r = run(ADD_SKILL, ["--dir", plugin, "--skill", "shop-old", "--origin", "https://old.shop.example", "--auth", "none"]);
      expect(r.code).toBe(0);
      expect(readFileSync(join(plugin, "skills/shop-old/cli/src/site.ts"), "utf8")).toContain('generatedWith: "0.0.9"');
      expect(r.out.next).toStartWith(`bun ${join(SKILL_ROOT, "tools", "capture.ts")} --skill-dir `);
    } finally {
      writeFileSync(generated, before);
      rmSync(join(plugin, "skills/shop-old"), { recursive: true, force: true });
    }
  });

  test("--help prints usage and every flag's meaning, exit 0", () => {
    for (const [tool, flags] of [[NEW, ["--dir", "--into", "--plugin", "--repo", "--description", "--maintainer", "--no-labels", "--skip-checks"]], [ADD_SKILL, ["--dir", "--skill", "--origin", "--auth"]]] as const) {
      const r = run(tool, ["--help"]);
      expect(r.code).toBe(0);
      expect(Object.keys(r.out.flags)).toEqual([...flags]);
      for (const meaning of Object.values(r.out.flags) as string[]) expect(meaning.length).toBeGreaterThan(5);
    }
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
    expect(run(ADD_SKILL, [...base, "--skill", "shop-deploy"]).out.error.message).toContain("Deploy skill");
    expect(run(ADD_SKILL, ["--dir", plugin, "--skill", "x", "--origin", "https://a.example", "--auth", "maybe"]).out.error.message).toContain("login or none");
    expect(run(ADD_SKILL, ["--dir", plugin, "--skill", "x", "--origin", "not a url", "--auth", "none"]).out.error.message).toContain("--origin");
    expect(run(ADD_SKILL, ["--dir", join(work, "nowhere"), "--skill", "x", "--origin", "https://a.example", "--auth", "none"]).code).toBe(1);
  });
});

const realStarterReady = ["plugin/package.json", "feedback/SKILL.md", "deploy/SKILL.md", "skill/SKILL.md", "skill/cli/src/site.ts", "skill/cli/src/main.ts"].every(
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
      "skills/shop-deploy/SKILL.md",
      "skills/shop-deploy/hosts/railway.md",
      "skills/shop/SKILL.md",
      "skills/shop/Dockerfile",
      "skills/shop/.dockerignore",
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
    expect(existsSync(join(dir, "skills/shop/railway.json"))).toBe(false);
    expect(findTokens(dir)).toEqual([]);
    expect(readFileSync(join(dir, "skills/shop/Dockerfile"), "utf8")).toContain("/out/shop");
    const deploy = readFileSync(join(dir, "skills/shop-deploy/SKILL.md"), "utf8");
    expect(deploy).toContain("name: shop-deploy");
    expect(deploy).toMatch(/^---\n[\s\S]*?\n---\n<!-- version: 0\.1\.0 -->\n/);
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

  // A generated plugin's own CI runs `bun test` at the plugin root. Its Starter tests must hold
  // for any generator version and any generated.json, not only the ones the generator had when
  // the test was written (cold read of 0.2.0: doctor.test.ts expected generatedWith "0.1.0").
  test("a generated plugin's full bun test passes at the plugin root and in each skill's cli (both auth modes)", () => {
    const dir = join(work, "full");
    const env = { STARTER_DIR: REAL_STARTER };
    expect(run(NEW, newArgs(dir, ["--no-labels"]), env).code).toBe(0);
    const sh = (cmd: string[], cwd: string) => {
      const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
      return { code: p.exitCode, out: (p.stdout.toString() + p.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, "") };
    };
    for (const auth of ["none", "login"] as const) {
      const skill = `shop-${auth}`;
      const origin = "http://127.0.0.1:9";
      expect(run(ADD_SKILL, ["--dir", dir, "--skill", skill, "--origin", origin, "--auth", auth], env).code).toBe(0);
      const cli = join(dir, "skills", skill, "cli");
      copyExpected(auth, join(cli, "src"), { plugin: "shop", skill, repo: "acme/shop-plugin", generatorVersion: generatorVersion(), origin });
      const install = sh([process.execPath, "install"], cli);
      expect(install.code, install.out).toBe(0);
      const regen = run(join(SKILL_ROOT, "tools", "regen.ts"), ["--skill-dir", join(dir, "skills", skill)], env);
      expect(regen.code, JSON.stringify(regen.out)).toBe(0);
    }
    const install = sh([process.execPath, "install"], dir);
    expect(install.code, install.out).toBe(0);
    // The root run covers every skill's tests; one file in one cli proves they also resolve from there.
    for (const [cwd, only] of [[dir, []], [join(dir, "skills", "shop-login", "cli"), ["tests/site.test.ts"]]] as const) {
      const tested = sh([process.execPath, "test", ...only], cwd);
      // The summary lines only: under CI, bun also prints every passing test's name ("a non-JSON 200 fails …").
      expect(tested.out, cwd).toMatch(/^ 0 fail$/m);
      expect(tested.out, cwd).not.toMatch(/^ [1-9]\d* fail$/m);
      expect(tested.code, `${cwd}\n${tested.out}`).toBe(0);
    }
  }, 900_000);
});

// A plugin added to a repo that holds several plugins and one marketplace (hoaj/plugins): the
// plugin in plugins/<plugin>/, its workflows at the repo root, tags and labels named after it.
describe.skipIf(!realStarterReady)("new.ts --into a shared marketplace repo", () => {
  const env = { STARTER_DIR: REAL_STARTER };
  const MARKETS = [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json", ".github/plugin/marketplace.json"];
  // Hand-formatted, as a maintainer writes it: new.ts must keep the formatting and the other entries.
  const market = `{
  "name": "acme",
  "owner": { "name": "Acme", "url": "https://github.com/acme" },
  "metadata": { "description": "Acme's plugins", "version": "1.0.0" },
  "plugins": [
    {
      "name": "other",
      "source": "./plugins/other",
      "description": "Another plugin.",
      "category": "shopping"
    }
  ]
}
`;
  const otherCi = "name: other-ci\non:\n  push:\n    branches: [main]\njobs: {}\n";

  function monorepo(name: string, markets = MARKETS): string {
    const root = join(work, name);
    for (const m of markets) write(join(root, m), market);
    write(join(root, "plugins/other/.claude-plugin/plugin.json"), JSON.stringify({ name: "other", version: "1.2.3" }));
    write(join(root, ".github/workflows/other-ci.yml"), otherCi);
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
  }
  const intoArgs = (root: string, extra: string[] = []) => [
    "--into", root, "--plugin", "shop", "--repo", "acme/plugins", "--description", "Shop things.", "--maintainer", "octo", "--skip-checks", ...extra,
  ];

  let root: string;
  let created: Result;
  beforeAll(() => {
    root = monorepo("mono");
    created = run(NEW, intoArgs(root, ["--no-labels"]), env);
  });

  test("writes the plugin to plugins/<plugin> with no marketplace of its own, and records the layout in generated.json", () => {
    expect(created.code, JSON.stringify(created.out)).toBe(0);
    const dir = join(root, "plugins/shop");
    expect(created.out).toMatchObject({ dir, root, plugin: "shop", repo: "acme/plugins", version: "0.1.0", tagPrefix: "shop-v" });
    expect(created.out.next).toStartWith(`bun ${join(SKILL_ROOT, "tools", "add-skill.ts")} --dir ${dir}`);
    for (const f of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "package.json", "scripts/bump.ts", "scripts/fixed-in.ts", "tests/version-sync.test.ts", "README.md", "skills/shop-feedback/SKILL.md", "skills/shop-deploy/SKILL.md"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    for (const f of [...MARKETS, ".agents/plugins/marketplace.json", ".github/workflows"]) expect(existsSync(join(dir, f)), f).toBe(false);
    expect(readJson(join(dir, "generated.json"))).toEqual({ generatedWith: generatorVersion(), maintainer: "octo", pluginDir: "plugins/shop", tagPrefix: "shop-v" });
    const claude = readJson(join(dir, ".claude-plugin/plugin.json"));
    expect(claude.homepage).toBe("https://github.com/acme/plugins/tree/main/plugins/shop");
    expect(claude.repository).toBe("https://github.com/acme/plugins");
    expect(created.out.files).toContain(".github/workflows/shop-ci.yml");
    expect(created.out.files).toContain("plugins/shop/generated.json");
    expect(findTokens(root)).toEqual([]);
  });

  test("adds one entry to each root marketplace file, keeping its formatting and the other plugins", () => {
    for (const m of MARKETS) {
      const text = readFileSync(join(root, m), "utf8");
      expect(text, m).toStartWith(market.slice(0, market.lastIndexOf("    }") + 5));
      expect(text).toContain('"owner": { "name": "Acme", "url": "https://github.com/acme" }');
      const parsed = JSON.parse(text);
      expect(parsed.name).toBe("acme");
      expect(parsed.plugins).toEqual([
        { name: "other", source: "./plugins/other", description: "Another plugin.", category: "shopping" },
        { name: "shop", source: "./plugins/shop", description: "Shop things." },
      ]);
    }
    expect(created.out.marketplaces).toEqual(MARKETS);
  });

  test("writes <plugin>-ci.yml and <plugin>-release.yml at the repo root, path-filtered to the plugin, with prefixed tags", () => {
    expect(readFileSync(join(root, ".github/workflows/other-ci.yml"), "utf8")).toBe(otherCi);
    const ci = readFileSync(join(root, ".github/workflows/shop-ci.yml"), "utf8");
    const release = readFileSync(join(root, ".github/workflows/shop-release.yml"), "utf8");
    for (const [wf, file] of [[ci, "shop-ci.yml"], [release, "shop-release.yml"]] as const) {
      expect(wf).not.toContain("#@");
      expect(wf).toContain(`name: ${file.replace(".yml", "")}\n`);
      expect(wf).toContain(`    paths:\n      - plugins/shop/**\n      - .github/workflows/${file}\n`);
      expect(wf).toContain("PLUGIN_DIR: plugins/shop\n");
      expect(wf).toContain("working-directory: plugins/shop\n");
    }
    expect(ci).toMatch(/pull_request:\n {4}paths:/);
    expect(ci).toContain('--base main --dir "$PLUGIN_DIR"');
    expect(release).toContain("TAG_PREFIX: shop-v\n");
    expect(release).toContain('tag="$TAG_PREFIX$version"');
    expect(release).toContain('--title "shop v$VERSION" "${notes[@]}" --latest=false');
    // Notes start at this plugin's previous tag, never another plugin's release in the repo.
    expect(release).toContain('grep -E "^${TAG_PREFIX}[0-9]+\\.[0-9]+\\.[0-9]+$"');
    expect(release).toContain('notes+=(--notes-start-tag "$prev")');
    expect(release).toContain('gh release edit "$TAG" --draft=false --latest=false');
    expect(release).toContain("working-directory: plugins/shop/skills/${{ matrix.skill }}/cli");
    expect(release).toContain('bun "$PLUGIN_DIR/scripts/fixed-in.ts" "$TAG" --repo "$GITHUB_REPOSITORY" --branch main --dir "$PLUGIN_DIR"');
  });

  // The green gate lints the Starter's workflows in place; this lints what the layout lines make of them.
  test.skipIf(!Bun.which("actionlint"))("actionlint passes on the generated workflows (skipped without actionlint)", () => {
    const files = ["shop-ci.yml", "shop-release.yml"].map((f) => join(root, ".github/workflows", f));
    const proc = Bun.spawnSync(["actionlint", ...files], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode, proc.stdout.toString() + proc.stderr.toString()).toBe(0);
  });

  test("the Feedback skill, README and Deploy skill name the shared repo, the plugin's label and its tags", () => {
    const dir = join(root, "plugins/shop");
    const fb = readFileSync(join(dir, "skills/shop-feedback/SKILL.md"), "utf8");
    expect(fb).not.toContain("#@");
    for (const s of ["gh issue create --repo acme/plugins --title \"$title\" --label shop --label <label>", "labels=shop,<label>", "fixed-in:shop-vX.Y.Z", "Every issue also gets the label `shop`", `--search '"feature: <skill>:" in:title'`]) {
      expect(fb).toContain(s);
    }
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).not.toContain("#@");
    for (const s of ["/plugin marketplace add acme/plugins", "/plugin install shop@acme", "`shop-v<version>`", "bash plugins/shop/skills/<skill>/install.sh", "--label shop", ".github/workflows/shop-release.yml"]) {
      expect(readme).toContain(s);
    }
    expect(readme).not.toContain("codex plugin");
    const deploy = readFileSync(join(dir, "skills/shop-deploy/SKILL.md"), "utf8");
    expect(deploy).toContain("plugins/shop/skills/<skill>/");
    expect(deploy).toContain("`shop-v<version>`");
  });

  test("add-skill reads the layout from generated.json: install.sh downloads from <plugin>-v<version>", () => {
    const dir = join(root, "plugins/shop");
    const added = run(ADD_SKILL, ["--dir", dir, "--skill", "shop", "--origin", "https://www.shop.example", "--auth", "none"], env);
    expect(added.code, JSON.stringify(added.out)).toBe(0);
    expect(readFileSync(join(dir, "skills/shop/install.sh"), "utf8")).toContain('TAG_PREFIX="shop-v"');
    expect(findTokens(root)).toEqual([]);
    // A plugin in its own repo keeps v<version>.
    const own = join(work, "own-prefix");
    expect(run(NEW, newArgs(own, ["--no-labels"]), env).code).toBe(0);
    expect(run(ADD_SKILL, ["--dir", own, "--skill", "shop", "--origin", "https://www.shop.example", "--auth", "none"], env).code).toBe(0);
    expect(readFileSync(join(own, "skills/shop/install.sh"), "utf8")).toContain('TAG_PREFIX="v"');
    expect(readJson(join(own, "generated.json"))).toMatchObject({ pluginDir: ".", tagPrefix: "v" });
  });

  test("the plugin's own script and version tests pass in its folder", () => {
    const proc = Bun.spawnSync([process.execPath, "test", "./tests"], { cwd: join(root, "plugins/shop"), stdout: "pipe", stderr: "pipe", env: cleanEnv() });
    const out = proc.stderr.toString().replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toMatch(/^ 0 fail$/m);
    expect(proc.exitCode, out).toBe(0);
  }, 60_000);

  test("creates the shared labels and one named after the plugin", () => {
    const bin = join(work, "gh-bin-into");
    const log = join(work, "gh-into.log");
    write(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, 0o755);
    const r = run(NEW, intoArgs(monorepo("mono-labels")), { ...env, PATH: `${bin}:${process.env.PATH}` });
    expect(r.code, JSON.stringify(r.out)).toBe(0);
    const names = ["feature", "drift", "bug", "unverified", "needs-account", "shop"];
    expect(r.out.labels).toEqual({ created: names });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    for (const [i, name] of names.entries()) expect(calls[i]).toStartWith(`label create ${name} --repo acme/plugins --force`);
  });

  test("refuses, writing nothing, a root without marketplace files, an existing plugin folder, workflow or marketplace entry", () => {
    const bare = join(work, "mono-bare");
    write(join(bare, "README.md"), "x");
    const noMarket = run(NEW, intoArgs(bare, ["--no-labels"]), env);
    expect(noMarket.code).toBe(1);
    expect(noMarket.out.error.message).toContain("no marketplace file");
    expect(existsSync(join(bare, "plugins"))).toBe(false);

    const cases: [string, (r: string) => void, string][] = [
      ["mono-dir", (r) => write(join(r, "plugins/shop/README.md"), "x"), "plugins/shop"],
      ["mono-wf", (r) => write(join(r, ".github/workflows/shop-release.yml"), "x"), "shop-release.yml"],
      ["mono-listed", (r) => write(join(r, ".cursor-plugin/marketplace.json"), JSON.stringify({ name: "acme", plugins: [{ name: "shop", source: "./x" }] })), "already lists"],
    ];
    for (const [name, prepare, message] of cases) {
      const r = monorepo(name);
      prepare(r);
      const out = run(NEW, intoArgs(r, ["--no-labels"]), env);
      expect(out.code, name).toBe(1);
      expect(out.out.error.message, name).toContain(message);
      expect(readFileSync(join(r, ".claude-plugin/marketplace.json"), "utf8"), name).toBe(market);
      expect(existsSync(join(r, ".github/workflows/shop-ci.yml")), name).toBe(false);
    }
    expect(run(NEW, [...intoArgs(monorepo("mono-both"), ["--no-labels"]), "--dir", join(work, "x")], env).out.error.message).toContain("pass either --dir");
    expect(run(NEW, intoArgs(monorepo("mono-neither"), ["--no-labels"]).slice(2), env).out.error.message).toContain("pass either --dir");
  });
});

/** The environment without anything a developer's shell may have set for site CLIs. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("SITE_CLI_") && k !== "STARTER_DIR") env[k] = v;
  return env;
}

// Windows smoke (2026-10-18): new.ts skips the Starter's .github/workflows by comparing with
// ".github/workflows"; Windows' "\" made it copy the workflows twice and refuse to overwrite.
describe("copyTemplate skip", () => {
  test("sees nested paths with / on every OS", () => {
    const src = mkdtempSync(join(tmpdir(), "copy-skip-src-"));
    const dest = mkdtempSync(join(tmpdir(), "copy-skip-dest-"));
    try {
      mkdirSync(join(src, ".github", "workflows"), { recursive: true });
      writeFileSync(join(src, ".github", "workflows", "ci.yml"), "x");
      writeFileSync(join(src, "README.md"), "y");
      const seen: string[] = [];
      const written = copyTemplate(src, join(dest, "out"), {}, { skip: (rel) => (seen.push(rel), rel === ".github/workflows") });
      expect(seen).toContain(".github/workflows");
      expect(seen.every((r) => !r.includes("\\"))).toBe(true);
      expect(written).toEqual(["README.md"]);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
