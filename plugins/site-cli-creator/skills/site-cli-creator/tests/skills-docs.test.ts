// Structural tests for the agent-facing skills, manifests and marketplace wiring.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// tests/ → skills/site-cli-creator → skills → plugins/site-cli-creator → plugins → repo root
const PLUGIN = resolve(import.meta.dir, "../../..");
const REPO = resolve(PLUGIN, "../..");
// The hoaj/skills wiring (bankmcp parity, repo marketplaces, README, workflow) needs the whole
// repo; a copy of just this plugin runs everything else. CI always checks out the whole repo.
const IN_REPO = existsSync(join(REPO, ".github/workflows/site-cli-creator.yml")) && existsSync(join(REPO, "plugins/bankmcp"));
const REPO_REASON = IN_REPO ? "" : " (skipped: not inside the hoaj/skills checkout)";
if (!IN_REPO && process.env.GITHUB_ACTIONS) throw new Error(`expected the hoaj/skills checkout above ${PLUGIN}`);
const GEN = join(PLUGIN, "skills/site-cli-creator");
const TOKENS = new Set(["__PLUGIN__", "__SKILL__", "__REPO__", "__OWNER__", "__DESCRIPTION__", "__MAINTAINER__", "__GENERATOR_VERSION__", "__ORIGIN__", "__AUTH__"]);

const read = (p: string) => readFileSync(p, "utf8");

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter");
  return Object.fromEntries(m[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
}

function links(md: string): string[] {
  return [...md.matchAll(/\]\(([^)#]+\.md)\)/g)].map((m) => m[1]!).filter((l) => !l.startsWith("http"));
}

describe("manifests", () => {
  const paths = [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", ".github/plugin/plugin.json"];
  const manifests = paths.map((p) => JSON.parse(read(join(PLUGIN, p))));

  test("version 0.2.1, both skills exist", () => {
    manifests.forEach((m) => {
      expect(m.name).toBe("site-cli-creator");
      expect(m.version).toBe("0.2.1");
      expect(m.skills).toEqual(["./skills/site-cli-creator", "./skills/site-cli-creator-feedback"]);
      for (const s of m.skills) expect(existsSync(join(PLUGIN, s, "SKILL.md"))).toBe(true);
    });
  });

  test.skipIf(!IN_REPO)(`same fields as bankmcp${REPO_REASON}`, () => {
    const bank = paths.map((p) => JSON.parse(read(join(REPO, "plugins/bankmcp", p))));
    manifests.forEach((m, i) => expect(Object.keys(m).sort()).toEqual(Object.keys(bank[i]).sort()));
  });

  test.skipIf(!IN_REPO)(`marketplaces list the plugin with the manifest's description${REPO_REASON}`, () => {
    for (const p of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json", ".github/plugin/marketplace.json"]) {
      const mk = JSON.parse(read(join(REPO, p)));
      const entry = mk.plugins.find((x: { name: string }) => x.name === "site-cli-creator");
      expect(entry).toEqual({ name: "site-cli-creator", source: "./plugins/site-cli-creator", description: manifests[0].description });
      expect(mk.metadata.version).toBe("1.3.1");
    }
    expect(read(join(REPO, "README.md"))).toContain("[site-cli-creator](./plugins/site-cli-creator)");
  });
});

describe("skills", () => {
  const skills = {
    generator: join(GEN, "SKILL.md"),
    generatorFeedback: join(PLUGIN, "skills/site-cli-creator-feedback/SKILL.md"),
    starterSkill: join(GEN, "starter/skill/SKILL.md"),
    starterFeedback: join(GEN, "starter/feedback/SKILL.md"),
  };

  test("frontmatter holds only name and description", () => {
    for (const p of Object.values(skills)) {
      const fm = frontmatter(read(p));
      expect(Object.keys(fm).sort()).toEqual(["description", "name"]);
      expect(fm.description!.length).toBeLessThanOrEqual(1024);
    }
  });

  test("generator SKILL.md stays short and every linked reference exists", () => {
    const md = read(skills.generator);
    expect(md.split("\n").length).toBeLessThanOrEqual(150);
    for (const f of ["new", "add-skill", "add-task", "fix", "contracts"]) expect(md).toContain(`reference/${f}.md`);
    for (const p of [skills.generator, ...["new", "add-skill", "add-task", "fix", "contracts"].map((f) => join(GEN, "reference", `${f}.md`))]) {
      for (const l of links(read(p))) expect(existsSync(resolve(dirname(p), l))).toBe(true);
    }
  });

  test("tool commands in the generator SKILL.md match the architecture", () => {
    const md = read(skills.generator);
    for (const t of ["new.ts --dir", "add-skill.ts --dir", "capture.ts --skill-dir", "draft-contract.ts", "regen.ts --skill-dir"]) expect(md).toContain(t);
  });

  test("starter skill SKILL.md follows SPEC §8", () => {
    const md = read(skills.starterSkill);
    const lines = md.trimEnd().split("\n").length;
    expect(lines).toBeGreaterThanOrEqual(45);
    expect(lines).toBeLessThanOrEqual(60);
    expect(md).toMatch(/^---\n[\s\S]*?\n---\n<!-- version: 0\.1\.0 -->\n/);
    const start = md.indexOf("<!-- commands:start -->");
    const end = md.indexOf("<!-- commands:end -->");
    expect(start).toBeGreaterThan(md.indexOf("## Commands"));
    expect(end).toBeGreaterThan(start);
    const fails = md.slice(md.indexOf("## When it fails"), md.indexOf("## When NOT to use"));
    for (const code of ["| 1 | bug", "| 2 | input", "| 3 | drift", "| 4 | session", "| 5 | network"]) expect(fails).toContain(code);
    for (const s of ["bash <this skill's folder>/install.sh", "Git Bash", "--account <id>", "__PLUGIN__-feedback", "check", "never work around Drift"]) expect(fails).toContain(s);
    expect(md).toContain("## When NOT to use");
  });

  test("starter feedback SKILL.md follows SPEC §10", () => {
    const md = read(skills.starterFeedback);
    expect(md).toMatch(/^---\n[\s\S]*?\n---\n<!-- version: 0\.1\.0 -->\n/);
    expect(frontmatter(md).name).toBe("__PLUGIN__-feedback");
    for (const s of ["fixed-in", "on its way", "bug: <bug key>", "feature: <skill>: <Task in plain words>", "/issues/new", "Drift is no exception", "gh issue create --repo __REPO__"]) expect(md).toContain(s);
  });

  test("generator feedback files on hoaj/skills with the site-cli-creator label", () => {
    const md = read(skills.generatorFeedback);
    expect(md).toContain("gh issue create --repo hoaj/skills --label site-cli-creator");
    expect(md).toContain("gh label create site-cli-creator");
    expect(md).toContain("https://github.com/hoaj/skills/issues/new?labels=site-cli-creator");
  });

  test("starter files use only known placeholder tokens", () => {
    for (const p of [skills.starterSkill, skills.starterFeedback, join(GEN, "starter/plugin/README.md")]) {
      for (const [t] of read(p).matchAll(/__[A-Z_]+__/g)) expect(TOKENS.has(t)).toBe(true);
    }
  });
});

// Every `bun <gen>/tools/<tool>.ts ...` line in the guidance uses only flags that tool's USAGE declares.
describe("guidance matches the tools' interfaces", () => {
  const docs = [join(GEN, "SKILL.md"), ...["new", "add-skill", "add-task", "fix", "contracts"].map((f) => join(GEN, "reference", `${f}.md`))];
  const usage = (tool: string) => {
    const src = read(join(GEN, "tools", `${tool}.ts`));
    const m = src.match(/const USAGE =\s*["'`](.*)["'`];/);
    if (!m) throw new Error(`${tool}.ts has no USAGE`);
    return m[1]!;
  };

  test("tool flags", () => {
    let seen = 0;
    for (const p of docs) {
      for (const [, tool, rest] of read(p).matchAll(/bun <gen>\/tools\/([\w-]+)\.ts([^\n]*)/g)) {
        const u = usage(tool!);
        for (const [flag] of rest!.split(/\s#\s/)[0]!.matchAll(/--[a-z][a-z-]*/g)) {
          // --help is every tool's (tools/lib/args.ts), not in each USAGE.
          expect({ doc: p, tool, flag, ok: flag === "--help" || u.includes(`${flag} `) || u.includes(`${flag}]`) || u.endsWith(flag) }).toMatchObject({ ok: true });
        }
        seen++;
      }
    }
    expect(seen).toBeGreaterThanOrEqual(10);
  });

  test("plugin commands the guidance runs exist in the Starter code", () => {
    const pkg = JSON.parse(read(join(GEN, "starter/plugin/package.json")));
    expect(pkg.scripts.bump).toBeDefined();
    expect(pkg.scripts.test).toBeDefined();
    const main = read(join(GEN, "starter/skill/cli/src/main.ts"));
    for (const b of ["login", "check", "doctor", "version", "help"]) expect(main).toContain(`"${b}"`);
    expect(read(join(GEN, "starter/skill/cli/src/runtime/check.ts"))).toContain("writes");
  });

  test("every fixture example in contracts.md exists", () => {
    const md = read(join(GEN, "reference/contracts.md"));
    const files = [...md.matchAll(/`((?:login|none)\/[\w/.-]+\.ts)`/g)].map((m) => m[1]!);
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) expect({ f, exists: existsSync(join(GEN, "fixtures/expected", f)) }).toEqual({ f, exists: true });
  });
});

describe("SPEC behaviours in the skills", () => {
  test("starter feedback passes the key to gh byte for byte: a Fingerprint with $ survives the shell", () => {
    const md = read(join(GEN, "starter/feedback/SKILL.md"));
    expect(md).not.toContain('"\\"<key>\\" in:title"');
    expect(md).not.toContain('--title "<title>"');
    const block = md.slice(md.indexOf("key=$(cat <<'EOF'"), md.indexOf("```", md.indexOf("key=$(cat <<'EOF'")));
    const key = "shop:shop:listItems:zod:data.$values[].$type:invalid_type";
    // Run the documented snippet with gh replaced by printf, as the agent's bash would.
    const script = block.replace("<key>", key).replace(/^gh issue list .*$/m, `printf '%s' "$key"`);
    const p = Bun.spawnSync(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
    expect(p.stdout.toString()).toBe(key);
    expect(md).toContain('--title "$title"');
    expect(md).toContain("first row that fits");
  });

  test("starter feedback dedups by exact title and covers all five outcomes", () => {
    const md = read(join(GEN, "starter/feedback/SKILL.md"));
    expect(md).toContain("exactly the title");
    for (const s of ["open issue", "closed, `fixed-in` newer", "closed, no `fixed-in` label", "links the closed one", "| none | create an issue"]) expect(md).toContain(s);
    expect(md).toContain("--label feature");
    // Drift and bugs carry their own labels, so the queue filters with one click; dedup stays by title.
    expect(md).toMatch(/\| drift \| the Fingerprint, exactly \| `drift` \|/);
    expect(md).toMatch(/\| bug \| `bug: <bug key>` \| `bug` \|/);
    expect(md).toContain("--label <label>");
    expect(md).toContain("labels=<label>");
    expect(md).toContain("one issue per entry");
    expect(md).not.toMatch(/version and OS from `<skill> version`/);
  });

  test("generator covers the maintainer rules of SPEC §13", () => {
    const md = read(join(GEN, "SKILL.md"));
    for (const s of ["unverified", "needs-account", "check --op", "## Maintainer handover", "generated.json", "ADMIN"]) expect(md).toContain(s);
    const fix = read(join(GEN, "reference/fix.md"));
    for (const s of ["--label unverified", "gh pr checks", "gh pr merge", "Fixes #<n>", "site-cli-creator-feedback"]) expect(fix).toContain(s);
    for (const s of ["gh issue list --repo <owner/name> --state open --label drift", "gh issue list --repo <owner/name> --state open --label bug"]) expect(fix).toContain(s);
    for (const s of ["`drift`", "`bug`"]) expect(read(join(GEN, "reference/new.md"))).toContain(s);
  });

  test("the guidance documents what dogfooding agents had to read source for", () => {
    const addTask = read(join(GEN, "reference/add-task.md"));
    for (const s of ["--script <file.ts> --headless", "default export gets the Playwright `page`", "--write-op", "--allow-read", "blockedElsewhere", "bun run typecheck", "One page, several Tasks"]) expect(addTask).toContain(s);
    expect(addTask).not.toContain("bunx");
    const contracts = read(join(GEN, "reference/contracts.md"));
    for (const s of ["## Runtime facts", "about:blank", "inputFailure", "bearerClaims", "setCookies", "**File names.**", "every** load of the start page", "don't say either in `summary`"]) expect(contracts).toContain(s);
    const fix = read(join(GEN, "reference/fix.md"));
    for (const s of ["SITE_CLI_NONINTERACTIVE=1", "A field whose type changed", "grep -l", "version-check origin/main"]) expect(fix).toContain(s);
    expect(read(join(GEN, "reference/new.md"))).toContain("retry");
    expect(read(join(GEN, "SKILL.md"))).toContain("bun build.ts bun-<os>-<arch> ../bin/<skill>");
    const pkg = JSON.parse(read(join(GEN, "starter/skill/cli/package.json")));
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit -p .");
  });

  test("fix mode re-captures first, then signs the CLI in from the Capture profile, so the maintainer signs in once (cold read)", () => {
    const fix = read(join(GEN, "reference/fix.md"));
    const drift = fix.slice(fix.indexOf("## 2a. Drift"), fix.indexOf("### Unverified"));
    expect(drift).toContain("login --from-profile ~/.site-cli-creator/profile");
    expect(drift.indexOf("tools/capture.ts")).toBeGreaterThan(-1);
    expect(drift.indexOf("tools/capture.ts")).toBeLessThan(drift.indexOf("login --from-profile"));
    const md = read(join(GEN, "SKILL.md"));
    const line = md.split("\n").find((l) => l.startsWith("- Drift:")) ?? "";
    expect(line).toContain("login --from-profile");
    expect(line.indexOf("re-capture")).toBeLessThan(line.indexOf("login --from-profile"));
  });

  test("contracts.md's needs constants fit the variables draft-contract drafts (REST query values are strings) (cold read)", () => {
    const contracts = read(join(GEN, "reference/contracts.md"));
    expect(contracts).toContain('limit: { value: "1" }');
    expect(contracts).not.toMatch(/^needs: .*\{ value: \d/m);
    expect(contracts).toContain("A constant must fit its variable's schema");
    for (const s of ["no needs entry for", "does not fit variables"]) expect(contracts).toContain(s);
  });

  test("session row says auth none never exits 4", () => {
    expect(read(join(GEN, "starter/skill/SKILL.md"))).toMatch(/\| 4 \| session \|.*only skills with `login`/);
  });
});

describe.skipIf(!IN_REPO)(`generator CI workflow${REPO_REASON}`, () => {
  const wf = IN_REPO ? read(join(REPO, ".github/workflows/site-cli-creator.yml")) : "";
  test("the test job type-checks the generator and the Starter CLI before testing", () => {
    const job = wf.slice(wf.indexOf("  test:"), wf.indexOf("  smoke:"));
    expect(job.match(/bun x tsc --noEmit -p \./g)?.length).toBe(2);
    expect(job).toContain("working-directory: ${{ env.SKILL_DIR }}/starter/skill/cli");
    expect(job.indexOf("tsc")).toBeLessThan(job.indexOf("run: bun test"));
    expect(existsSync(join(PLUGIN, "tsconfig.json"))).toBe(true);
  });

  test("builds and runs all five targets", () => {
    for (const t of ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "windows-x64"]) expect(wf).toContain(`target: ${t}`);
    expect(wf).toContain('bun build.ts "bun-${{ matrix.target }}"');
  });
  test("run-smoke covers help, version, fetch, Chrome launch and route.abort (SPEC §9)", () => {
    const run = wf.slice(wf.indexOf("  run-smoke:"));
    for (const s of ["run help.json help", "run version.json version", `fixtures/site/server.ts" --auth none --port 4310`, "run selftest.json selftest --url", "run show.json subscription show", "run check.json check --writes", "codesign --force --sign -", "Unblock-File", "google-chrome-stable_current_arm64.deb", "test ! -e node_modules"]) {
      expect(run).toContain(s);
    }
    expect(wf).toContain("--origin http://127.0.0.1:4310");
  });
});

// Scaffold with the real tools, copy the fixture, regen: the generated SKILL.md is complete and in range.
describe("generated SKILL.md files", () => {
  test("filled, version-pinned and 45-60 lines after regen", () => {
    const { mkdtempSync, rmSync, symlinkSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "docs-e2e-"));
    try {
      const run = (args: string[]) => {
        const p = Bun.spawnSync([process.execPath, ...args], { stdout: "pipe", stderr: "pipe" });
        if (!p.success) throw new Error(`${args.join(" ")}: ${p.stderr.toString()}`);
        return JSON.parse(p.stdout.toString());
      };
      const plugin = join(dir, "p");
      run([join(GEN, "tools/new.ts"), "--dir", plugin, "--plugin", "shop", "--repo", "acme/shop-plugin", "--description", "Shop things.", "--maintainer", "acme", "--no-labels", "--skip-checks"]);
      run([join(GEN, "tools/add-skill.ts"), "--dir", plugin, "--skill", "shop", "--origin", "http://127.0.0.1:4310", "--auth", "none"]);
      const skill = join(plugin, "skills/shop");
      symlinkSync(join(PLUGIN, "node_modules"), join(skill, "cli/node_modules"));
      const { copyExpected } = require(join(GEN, "fixtures/expected/copy.ts"));
      copyExpected("none", join(skill, "cli/src"), { plugin: "shop", skill: "shop", repo: "acme/shop-plugin", generatorVersion: "0.1.0", origin: "http://127.0.0.1:4310" });
      run([join(GEN, "tools/regen.ts"), "--skill-dir", skill]);

      const md = read(join(skill, "SKILL.md"));
      expect(md).not.toMatch(/__[A-Z_]+__/);
      expect(md).toContain("<!-- version: 0.1.0 -->");
      const table = md.slice(md.indexOf("<!-- commands:start -->"), md.indexOf("<!-- commands:end -->"));
      for (const c of ["subscription show", "invoice list", "invoice show", "note add"]) expect(table).toContain(`shop ${c}`);
      expect(table).toMatch(/note add.*\*\*Write\.\*\*/);
      const lines = md.trimEnd().split("\n").length;
      expect(lines).toBeGreaterThanOrEqual(45);
      expect(lines).toBeLessThanOrEqual(60);

      const fb = read(join(plugin, "skills/shop-feedback/SKILL.md"));
      expect(fb).not.toMatch(/__[A-Z_]+__/);
      expect(fb).toContain("gh issue create --repo acme/shop-plugin");
      const readme = read(join(plugin, "README.md"));
      expect(readme).not.toMatch(/__[A-Z_]+__/);
      expect(readme).toContain("@acme");
      // Install commands name the marketplace the repo carries (marketplace name = plugin name).
      expect(readme).toContain("/plugin install shop@shop");
      for (const f of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json", ".github/plugin/marketplace.json"]) {
        expect(JSON.parse(read(join(plugin, f))).name).toBe("shop");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
