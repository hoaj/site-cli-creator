#!/usr/bin/env bun
// bun tools/new.ts --dir <path> --plugin <name> --repo <owner/name>
//   --description "<text>" --maintainer <login> [--no-labels] [--skip-checks]
// Scaffolds a plugin from starter/plugin and starter/feedback (SPEC §2 new). Before writing
// anything it checks the maintainer requirements (SPEC §13); --skip-checks is for tests and CI.
// STARTER_DIR overrides the Starter code location (tests only).

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFlags, requireKebab } from "./lib/args";
import { buildManifests, buildMarketplaces, INITIAL_VERSION, MANIFESTS, MARKETPLACES, writeJson, type PluginInfo } from "./lib/manifests";
import { fail, progress, runTool } from "./lib/output";
import { generatorVersion, starterDir, toolCommand } from "./lib/paths";
import { assertWritableDir, requireDir, setSkillMdVersion } from "./lib/scaffold";
import { systemProbe, unmetRequirements } from "./lib/requirements";
import { assertNoTokens, copyTemplate, type Tokens } from "./lib/template";

const USAGE =
  'bun tools/new.ts --dir <path> --plugin <name> --repo <owner/name> --description "<text>" --maintainer <login> [--no-labels] [--skip-checks]';

const LABELS = [
  { name: "feature", color: "a2eeef", description: "A Task the plugin can't do yet (filed by the Feedback skill)" },
  { name: "drift", color: "d93f0b", description: "The site changed away from a Contract (filed by the Feedback skill; fixed by fix)" },
  { name: "bug", color: "b60205", description: "A bug in the plugin's own code (filed by the Feedback skill; fixed by fix)" },
  { name: "unverified", color: "fbca04", description: "Fix made from the issue's diff; the maintainer's account can't reach the Task" },
  { name: "needs-account", color: "d4c5f9", description: "The maintainer's account can't perform this Task" },
];

function fallbackReadme(info: PluginInfo): string {
  return `# ${info.plugin}

${info.description}

Generated with site-cli-creator. Maintainer: @${info.maintainer}.

Problems and feature requests go to [${info.repo}](https://github.com/${info.repo}/issues) through the \`${info.plugin}-feedback\` skill.
`;
}

/** The gh command that creates one label; also printed for the maintainer to rerun. */
function labelArgs(repo: string, label: (typeof LABELS)[number]): string[] {
  return ["gh", "label", "create", label.name, "--repo", repo, "--force", "--color", label.color, "--description", label.description];
}

const shellWord = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

function createLabels(repo: string): { created: string[]; failed?: string } {
  const created: string[] = [];
  for (const label of LABELS) {
    const args = labelArgs(repo, label);
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
      dir: { type: "string", required: true, help: "local folder of the plugin repo (empty, or only .git)" },
      plugin: { type: "string", required: true, help: "plugin name, kebab-case" },
      repo: { type: "string", required: true, help: "GitHub owner/name of the plugin repo" },
      description: { type: "string", required: true, help: "one line: what agents can do with the plugin (quote it)" },
      maintainer: { type: "string", required: true, help: "GitHub login of the maintainer (gh api user -q .login)" },
      "no-labels": { type: "boolean", help: "do not create the repo labels (tests only)" },
      "skip-checks": { type: "boolean", help: "skip the maintainer requirement checks (tests and CI only)" },
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

  const info: PluginInfo = { plugin, repo: values.repo, description: values.description, maintainer: values.maintainer };
  const manifests: Record<string, unknown> = buildManifests(info);
  const marketplaces: Record<string, unknown> = buildMarketplaces(info);
  for (const [built, paths] of [[manifests, MANIFESTS], [marketplaces, MARKETPLACES]] as const) {
    for (const [key, rel] of Object.entries(paths)) {
      writeJson(join(dir, rel), built[key]);
      files.push(rel);
    }
  }
  writeJson(join(dir, "generated.json"), { generatedWith, maintainer: values.maintainer });
  files.push("generated.json");
  if (!existsSync(join(dir, "README.md"))) {
    writeFileSync(
      join(dir, "README.md"),
      fallbackReadme(info),
    );
    files.push("README.md");
  }
  assertNoTokens(dir);

  const next = `${toolCommand("add-skill")} --dir ${dir} --skill <name> --origin <url> --auth login|none`;
  let labels: { created: string[]; failed?: string } | "skipped" = "skipped";
  if (!values["no-labels"]) {
    progress(`creating labels on ${values.repo}`);
    labels = createLabels(values.repo);
    if (labels.failed) {
      // The loop needs these labels (the Feedback skill files with `feature`, `drift` and `bug`, fix
      // uses `unverified`, add-task `needs-account`), so this is a failure; the files are kept.
      const created = labels.created;
      const retry = LABELS.filter((l) => !created.includes(l.name)).map((l) => labelArgs(values.repo, l).map(shellWord).join(" "));
      fail(
        `the plugin's files were written to ${dir}, but creating the repo labels failed (${labels.failed}). ` +
          "Run the commands in `retry` until they succeed, then go on with add-skill; do not run new.ts again.",
        { dir, labels, retry, next },
      );
    }
  }
  return {
    dir,
    plugin,
    repo: values.repo,
    version: INITIAL_VERSION,
    generatedWith,
    labels,
    files: [...new Set(files)].sort(),
    next,
  };
});
