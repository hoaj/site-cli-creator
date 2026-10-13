import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bump, collectPins, compareVersions, mismatches, nextVersion, writePin } from "../scripts/versions";

const BUMP = join(import.meta.dir, "..", "scripts", "bump.ts");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function manifest(version: string, skills: unknown) {
  return `${JSON.stringify(
    { name: "demo", description: "d", version, author: { name: "a" }, repository: "https://x", skills },
    null,
    2,
  )}\n`;
}

/** A plugin with two CLI skills and a Feedback skill, every pin at `version`. */
function fixture(version = "0.1.0"): string {
  const root = mkdtempSync(join(tmpdir(), "bump-"));
  roots.push(root);
  const files: Record<string, string> = {
    ".claude-plugin/plugin.json": manifest(version, ["./skills/shop", "./skills/bank", "./skills/demo-feedback"]),
    ".cursor-plugin/plugin.json": manifest(version, ["./skills/shop"]),
    ".codex-plugin/plugin.json": manifest(version, "./skills/"),
    ".github/plugin/plugin.json": manifest(version, ["./skills/shop"]),
    "skills/demo-feedback/SKILL.md": `---\nname: demo-feedback\ndescription: x\n---\n<!-- version: ${version} -->\n\n# feedback\n`,
  };
  for (const skill of ["shop", "bank"]) {
    files[`skills/${skill}/SKILL.md`] =
      `---\nname: ${skill}\ndescription: y\n---\n<!-- version: ${version} -->\n\n# ${skill}\n\nSee version: 9.9.9 docs.\n`;
    files[`skills/${skill}/cli/package.json`] =
      `{\n  "name": "demo-${skill}-cli",\n  "version": "${version}",\n  "private": true,\n  "dependencies": {\n    "playwright-core": "1.63.0",\n    "zod": "^4.6.5"\n  }\n}\n`;
    files[`skills/${skill}/cli/src/site.ts`] =
      `import { defineSite } from "./runtime/site";\nexport default defineSite({\n  plugin: "demo",\n  skill: "${skill}",\n  version: "${version}",\n  generatedWith: "0.1.0",\n  auth: "none",\n});\n`;
  }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

describe("versions", () => {
  test("nextVersion", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
    expect(() => nextVersion("1.2", "patch")).toThrow("not a X.Y.Z version");
  });

  test("compareVersions is numeric, not lexical", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
  });

  test("collects every pin: 4 manifests, each SKILL.md, each cli package.json and site.ts", () => {
    const pins = collectPins(fixture());
    expect(pins.map((p) => p.file)).toEqual([
      ".claude-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".github/plugin/plugin.json",
      "skills/bank/SKILL.md",
      "skills/bank/cli/package.json",
      "skills/bank/cli/src/site.ts",
      "skills/demo-feedback/SKILL.md",
      "skills/shop/SKILL.md",
      "skills/shop/cli/package.json",
      "skills/shop/cli/src/site.ts",
    ]);
    expect(pins.every((p) => p.version === "0.1.0")).toBe(true);
  });

  test("an in-sync plugin has no mismatches", () => {
    expect(mismatches(fixture())).toEqual([]);
  });

  test.each([
    ["skills/shop/SKILL.md", "<!-- version: 0.1.0 -->", "<!-- version: 0.1.1 -->", "0.1.1"],
    ["skills/bank/cli/src/site.ts", 'version: "0.1.0"', 'version: "0.2.0"', "0.2.0"],
    ["skills/shop/cli/package.json", '"version": "0.1.0"', '"version": "1.0.0"', "1.0.0"],
    [".github/plugin/plugin.json", '"version": "0.1.0"', '"version": "0.0.9"', "0.0.9"],
  ])("detects a differing pin in %s", (file, from, to, found) => {
    const root = fixture();
    writeFileSync(join(root, file), read(root, file).replace(from, to));
    expect(mismatches(root)).toEqual([{ file, found, expected: "0.1.0" }]);
  });

  test("detects missing pins", () => {
    const root = fixture();
    unlinkSync(join(root, ".cursor-plugin/plugin.json"));
    writeFileSync(join(root, "skills/bank/SKILL.md"), "---\nname: bank\n---\n# bank\n");
    mkdirSync(join(root, "skills/new"));
    expect(mismatches(root).map((m) => [m.file, m.found])).toEqual([
      [".cursor-plugin/plugin.json", null],
      ["skills/bank/SKILL.md", null],
      ["skills/new/SKILL.md", null],
    ]);
  });

  test("writePin changes only the version", () => {
    const md = "<!-- version: 0.1.0 (kept outside frontmatter) -->\n";
    expect(writePin(md, "skill-md", "0.2.0")).toBe("<!-- version: 0.2.0 (kept outside frontmatter) -->\n");
    expect(() => writePin("# no pin\n", "skill-md", "0.2.0")).toThrow("no version pin");
  });
});

describe("bump", () => {
  test.each([
    ["patch", "0.1.1"],
    ["minor", "0.2.0"],
    ["major", "1.0.0"],
  ] as const)("%s rewrites every pin to %s and nothing else", (level, to) => {
    const root = fixture();
    const before = Object.fromEntries(collectPins(root).map((p) => [p.file, read(root, p.file)]));
    const result = bump(root, level);
    expect(result.from).toBe("0.1.0");
    expect(result.to).toBe(to);
    expect(result.files).toHaveLength(11);
    expect(mismatches(root)).toEqual([]);
    for (const [file, text] of Object.entries(before)) {
      expect(read(root, file)).toBe(
        file.endsWith("SKILL.md")
          ? text.replace("<!-- version: 0.1.0", `<!-- version: ${to}`)
          : file.endsWith("site.ts")
            ? text.replace('version: "0.1.0"', `version: "${to}"`)
            : text.replace('"version": "0.1.0"', `"version": "${to}"`),
      );
    }
    expect(read(root, "skills/shop/cli/package.json")).toContain('"playwright-core": "1.63.0"');
  });

  test("heals a drifted pin to the manifest's next version", () => {
    const root = fixture("1.4.2");
    const file = "skills/bank/cli/src/site.ts";
    writeFileSync(join(root, file), read(root, file).replace('"1.4.2"', '"1.0.0"'));
    expect(bump(root, "patch").to).toBe("1.4.3");
    expect(mismatches(root)).toEqual([]);
  });

  test("writes nothing when a pin is missing", () => {
    const root = fixture();
    writeFileSync(join(root, "skills/bank/SKILL.md"), "# no version comment\n");
    expect(() => bump(root, "minor")).toThrow("skills/bank/SKILL.md: no version pin to rewrite");
    expect(read(root, ".claude-plugin/plugin.json")).toContain('"version": "0.1.0"');
  });

  test("CLI prints the result as JSON", () => {
    const root = fixture();
    const p = Bun.spawnSync([process.execPath, BUMP, "minor", "--root", root]);
    expect(p.exitCode).toBe(0);
    const out = JSON.parse(p.stdout.toString());
    expect(out.from).toBe("0.1.0");
    expect(out.to).toBe("0.2.0");
  });

  test("CLI rejects an unknown level", () => {
    const p = Bun.spawnSync([process.execPath, BUMP, "huge", "--root", fixture()]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("usage: bun run bump <patch|minor|major>");
  });
});
