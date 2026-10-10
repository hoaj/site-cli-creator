#!/usr/bin/env bun
// bun tools/new.ts --dir <path> --plugin <name> --repo <owner/name>
//   --description "<text>" --maintainer <login> [--no-labels] [--skip-checks]
// Scaffolds a plugin from starter/plugin and starter/feedback (SPEC §2 new). Before writing
// anything it checks the maintainer requirements (SPEC §13); --skip-checks is for tests and CI.
// STARTER_DIR overrides the Starter code location (tests only).

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFlags, requireKebab } from "./lib/args";
import { buildManifests, buildMarketplaces, INITIAL_VERSION, MANIFESTS, MARKETPLACES, writeJson } from "./lib/manifests";
import { fail, progress, runTool } from "./lib/output";
import { generatorVersion, starterDir } from "./lib/paths";
import { assertWritableDir, requireDir, setSkillMdVersion } from "./lib/scaffold";
import { systemProbe, unmetRequirements } from "./lib/requirements";
import { assertNoTokens, copyTemplate, type Tokens } from "./lib/template";

const USAGE =
  'bun tools/new.ts --dir <path> --plugin <name> --repo <owner/name> --description "<text>" --maintainer <login> [--no-labels] [--skip-checks]';

const LABELS = [
  { name: "feature", color: "a2eeef", description: "A Task the plugin can't do yet (filed by the Feedback skill)" },
  { name: "unverified", color: "fbca04", description: "Fix made from the issue's diff; the maintainer's account can't reach the Task" },
  { name: "needs-account", color: "d4c5f9", description: "The maintainer's account can't perform this Task" },
];

function fallbackReadme(t: Required<Pick<Tokens, "PLUGIN" | "REPO" | "DESCRIPTION" | "MAINTAINER">>): string {
  return `# ${t.PLUGIN}

${t.DESCRIPTION}

Generated with site-cli-creator. Maintainer: @${t.MAINTAINER}.

Problems and feature requests go to [${t.REPO}](https://github.com/${t.REPO}/issues) through the \`${t.PLUGIN}-feedback\` skill.
`;
}

function createLabels(repo: string): { created: string[]; failed?: string } {
  const created: string[] = [];
  for (const label of LABELS) {
    const args = ["gh", "label", "create", label.name, "--repo", repo, "--force", "--color", label.color, "--description", label.description];
    let proc: { success: boolean; exitCode: number | null; stderr: Buffer };
    try {
      proc = Bun.spawnSync(args, { stdout: "ignore", stderr: "pipe" });
    } catch (error) {
      // gh is not installed. The files are already written, so report it like any other gh failure.
      return { created, failed: `gh label create ${label.name}: ${(error as Error).message}` };
    }
    if (!proc.success) {
      return { created, failed: `gh label create ${label.name}: ${proc.stderr.toString().trim() || `exit ${proc.exitCode}`}` };
    }
    created.push(label.name);
  }
  return { created };
}

await runTool(async () => {
  const { values } = parseFlags(
    process.argv.slice(2),
    {
      dir: { type: "string", required: true },
      plugin: { type: "string", required: true },
      repo: { type: "string", required: true },
      description: { type: "string", required: true },
      maintainer: { type: "string", required: true },
      "no-labels": { type: "boolean" },
      "skip-checks": { type: "boolean" },
    },
    USAGE,
  );
  const plugin = requireKebab("plugin", values.plugin);
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo)) fail(`--repo must be owner/name, got "${values.repo}"`);
  const owner = values.repo.split("/")[0] as string;
  const dir = resolve(values.dir);
  const starter = starterDir();
  const pluginStarter = requireDir(join(starter, "plugin"), "starter/plugin");
  const feedbackStarter = requireDir(join(starter, "feedback"), "starter/feedback");
  assertWritableDir(dir);
  if (!values["skip-checks"]) {
    progress("checking maintainer requirements (Bun, Chrome, gh, admin on the repo)");
    const unmet = unmetRequirements(values.repo, systemProbe());
    if (unmet.length > 0) {
      fail(`${unmet.length} maintainer requirement(s) not met, nothing was written:\n- ${unmet.map((u) => u.message).join("\n- ")}`, { unmet });
    }
  }

  const generatedWith = generatorVersion();
  const tokens: Tokens = {
    PLUGIN: plugin,
    REPO: values.repo,
    OWNER: owner,
    DESCRIPTION: values.description,
    MAINTAINER: values.maintainer,
    GENERATOR_VERSION: generatedWith,
  };

  const files = copyTemplate(pluginStarter, dir, tokens);
  const feedbackRel = join("skills", `${plugin}-feedback`);
  files.push(...copyTemplate(feedbackStarter, join(dir, feedbackRel), tokens).map((f) => join(feedbackRel, f)));
  const feedbackSkillMd = join(dir, feedbackRel, "SKILL.md");
  if (existsSync(feedbackSkillMd)) setSkillMdVersion(feedbackSkillMd, INITIAL_VERSION);

  const manifests = buildManifests({ plugin, repo: values.repo, description: values.description, maintainer: values.maintainer });
  for (const [key, rel] of Object.entries(MANIFESTS)) {
    writeJson(join(dir, rel), manifests[key as keyof typeof MANIFESTS]);
    files.push(rel);
  }
  const marketplaces = buildMarketplaces({ plugin, repo: values.repo, description: values.description, maintainer: values.maintainer });
  for (const [key, rel] of Object.entries(MARKETPLACES)) {
    writeJson(join(dir, rel), marketplaces[key as keyof typeof MARKETPLACES]);
    files.push(rel);
  }
  writeJson(join(dir, "generated.json"), { generatedWith, maintainer: values.maintainer });
  files.push("generated.json");
  if (!existsSync(join(dir, "README.md"))) {
    writeFileSync(
      join(dir, "README.md"),
      fallbackReadme({ PLUGIN: plugin, REPO: values.repo, DESCRIPTION: values.description, MAINTAINER: values.maintainer }),
    );
    files.push("README.md");
  }
  assertNoTokens(dir);

  let labels: { created: string[]; failed?: string } | "skipped" = "skipped";
  if (!values["no-labels"]) {
    progress(`creating labels on ${values.repo}`);
    labels = createLabels(values.repo);
  }
  return {
    dir,
    plugin,
    repo: values.repo,
    version: INITIAL_VERSION,
    generatedWith,
    labels,
    files: [...new Set(files)].sort(),
    next: `bun tools/add-skill.ts --dir ${dir} --skill <name> --origin <url> --auth login|none`,
  };
});
