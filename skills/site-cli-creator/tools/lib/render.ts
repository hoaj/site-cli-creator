// How the Starter code becomes a plugin's files: shared by new and add-skill, which write a plugin,
// and by upgrade, which renders two Starter versions the same way to merge between them (SPEC §5).
import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fail } from "./output";
import { setPackageVersion, setSiteVersion, setSkillMdVersion } from "./scaffold";
import { copyTemplate, type Layout, type Tokens } from "./template";

export const WORKFLOWS = ".github/workflows";
/**
 * The daily drift check (SPEC §10), as Starter paths: only a plugin in its own repo gets it, since a shared repo
 * of plugins schedules its own (hoaj/plugins' drift-check.yml) and two would file every Drift twice.
 */
export const DRIFT_CHECK = { workflow: "__PREFIX__drift-check.yml", files: ["scripts/drift-check.ts", "tests/drift-check.test.ts"] };

/**
 * Copies starter/plugin into the plugin's folder `dir` and its workflows into `<root>/.github/workflows`,
 * leaving out the daily drift check in a shared repo, then the Feedback and Deploy skills into
 * `skills/<plugin>-feedback` and `skills/<plugin>-deploy` with `version` in their SKILL.md. A Starter
 * without one of those folders skips it. Returns the written paths relative to `root`.
 */
export function copyPluginStarter(starter: string, root: string, dir: string, tokens: Tokens, layout: Layout, version: string): string[] {
  const inPlugin = (rel: string) => relative(root, join(dir, rel));
  const pluginStarter = join(starter, "plugin");
  const repoSchedulesItsOwn = layout === "shared"; // a shared repo runs its own daily check: no drift-check here
  const files = copyTemplate(pluginStarter, dir, tokens, {
    layout,
    skip: (rel) => rel === WORKFLOWS || (repoSchedulesItsOwn && DRIFT_CHECK.files.includes(rel)),
  }).map(inPlugin);
  const workflowStarter = join(pluginStarter, WORKFLOWS);
  if (existsSync(workflowStarter)) {
    const skip = (rel: string) => repoSchedulesItsOwn && rel === DRIFT_CHECK.workflow;
    files.push(...copyTemplate(workflowStarter, join(root, WORKFLOWS), tokens, { layout, skip }).map((f) => join(WORKFLOWS, f)));
  }
  for (const suffix of ["feedback", "deploy"]) {
    const starterSkill = join(starter, suffix);
    if (!existsSync(starterSkill)) continue;
    const rel = join("skills", `${tokens.PLUGIN}-${suffix}`);
    files.push(...copyTemplate(starterSkill, join(dir, rel), tokens, { layout }).map((f) => inPlugin(join(rel, f))));
    const skillMd = join(dir, rel, "SKILL.md");
    if (existsSync(skillMd)) setSkillMdVersion(skillMd, version);
  }
  return files;
}

/**
 * Copies starter/skill into `skillDir` and sets the plugin `version` in its three pins (SKILL.md,
 * cli/package.json, site.ts), plus a `.gitignore` holding `bin/` when the Starter has none. Returns the
 * written paths relative to `skillDir`.
 */
export function copySkillStarter(skillStarter: string, skillDir: string, tokens: Tokens, layout: Layout, version: string): string[] {
  const files = copyTemplate(skillStarter, skillDir, tokens, { layout });
  const pins: [string, (path: string, version: string) => void][] = [
    ["SKILL.md", setSkillMdVersion],
    ["cli/package.json", setPackageVersion],
    ["cli/src/site.ts", setSiteVersion],
  ];
  for (const [rel, set] of pins) {
    const path = join(skillDir, rel);
    if (!existsSync(path)) fail(`starter/skill has no ${rel}`);
    set(path, version);
  }
  if (!existsSync(join(skillDir, ".gitignore"))) {
    writeFileSync(join(skillDir, ".gitignore"), "bin/\n");
    files.push(".gitignore");
  }
  return files;
}
