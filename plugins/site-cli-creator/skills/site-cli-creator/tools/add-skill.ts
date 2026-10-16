#!/usr/bin/env bun
// bun tools/add-skill.ts --dir <plugin> --skill <name> --origin <url> --auth login|none
// Scaffolds skills/<skill>/ from starter/skill (SPEC §2 add-skill).
// STARTER_DIR overrides the Starter code location (tests only).

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFlags, requireKebab } from "./lib/args";
import { addSkillToManifests, MANIFESTS, readJson } from "./lib/manifests";
import { fail, runTool } from "./lib/output";
import { generatorVersion, starterDir, toolCommand } from "./lib/paths";
import {
  parseOrigin,
  repoFromManifest,
  requireDir,
  setPackageVersion,
  setSiteVersion,
  setSkillMdVersion,
} from "./lib/scaffold";
import { assertNoTokens, copyTemplate, type Tokens } from "./lib/template";

const USAGE = "bun tools/add-skill.ts --dir <plugin> --skill <name> --origin <url> --auth login|none";

type PluginManifest = { name?: unknown; version?: unknown; repository?: unknown; description?: unknown };

await runTool(async () => {
  const { values } = parseFlags(
    process.argv.slice(2),
    {
      dir: { type: "string", required: true, help: "the plugin's root folder" },
      skill: { type: "string", required: true, help: "CLI skill name, kebab-case" },
      origin: { type: "string", required: true, help: "scheme + host the frontend calls, no path (https://www.example.com)" },
      auth: { type: "string", required: true, help: "login (the Tasks need the user signed in) or none" },
    },
    USAGE,
  );
  const skill = requireKebab("skill", values.skill);
  if (values.auth !== "login" && values.auth !== "none") fail(`--auth must be login or none, got "${values.auth}"`);
  const origin = parseOrigin(values.origin);
  const pluginDir = requireDir(resolve(values.dir), "plugin dir");

  const manifest = readJson<PluginManifest>(join(pluginDir, MANIFESTS.claude));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    fail(`${MANIFESTS.claude} needs name and version`);
  }
  const plugin = manifest.name;
  const version = manifest.version;
  if (skill === `${plugin}-feedback`) fail(`"${skill}" is the plugin's Feedback skill`);
  if (skill === `${plugin}-deploy`) fail(`"${skill}" is the plugin's Deploy skill`);
  const repo = repoFromManifest(manifest.repository);
  const generated = existsSync(join(pluginDir, "generated.json"))
    ? readJson<{ maintainer?: unknown; generatedWith?: unknown }>(join(pluginDir, "generated.json"))
    : {};

  const skillDir = join(pluginDir, "skills", skill);
  if (existsSync(skillDir)) fail(`${skillDir} already exists`);
  const skillStarter = requireDir(join(starterDir(), "skill"), "starter/skill");

  const tokens: Tokens = {
    PLUGIN: plugin,
    SKILL: skill,
    REPO: repo,
    OWNER: repo.split("/")[0] as string,
    DESCRIPTION: typeof manifest.description === "string" ? manifest.description : "",
    MAINTAINER: typeof generated.maintainer === "string" ? generated.maintainer : (repo.split("/")[0] as string),
    // The version the plugin was created with (SPEC §5), not this generator's, when they differ.
    GENERATOR_VERSION: typeof generated.generatedWith === "string" ? generated.generatedWith : generatorVersion(),
    ORIGIN: origin,
    AUTH: values.auth,
  };
  const files = copyTemplate(skillStarter, skillDir, tokens);

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
  assertNoTokens(skillDir);
  const manifests = addSkillToManifests(pluginDir, skill);

  return {
    skillDir,
    plugin,
    skill,
    origin,
    auth: values.auth,
    version,
    files: files.sort(),
    manifests,
    next: `${toolCommand("capture")} --skill-dir ${skillDir} --task <slug> --url <start>`,
  };
});
