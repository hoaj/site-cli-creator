#!/usr/bin/env bun
// bun tools/new.ts --dir <path> | --into <repo root> --plugin <name> --repo <owner/name>
//   --description "<text>" --maintainer <login> [--no-labels] [--skip-checks]
// Scaffolds a plugin from starter/plugin, starter/feedback and starter/deploy (SPEC §2 new):
// --dir: the plugin is the root of its own repo, which is its own marketplace.
// --into: the plugin goes to plugins/<plugin> of a repo that holds other plugins and one
// marketplace; it gets an entry in each root marketplace file and workflows named after it.
// Before writing anything it checks the maintainer requirements (SPEC §13); --skip-checks is for
// tests and CI. STARTER_DIR overrides the Starter code location (tests only).

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseFlags, requireKebab } from "./lib/args";
import {
  appendPluginEntry,
  buildManifests,
  buildMarketplaces,
  INITIAL_VERSION,
  MANIFESTS,
  MARKETPLACES,
  marketplaceEntry,
  writeJson,
  type PluginInfo,
} from "./lib/manifests";
import { fail, progress, runTool } from "./lib/output";
import { generatorVersion, starterDir, toolCommand } from "./lib/paths";
import { assertWritableDir, requireDir, setSkillMdVersion } from "./lib/scaffold";
import { systemProbe, unmetRequirements } from "./lib/requirements";
import { assertNoTokens, copyTemplate, layoutTokens, type Layout, type Tokens } from "./lib/template";

const USAGE =
  'bun tools/new.ts --dir <path> | --into <repo root> --plugin <name> --repo <owner/name> --description "<text>" --maintainer <login> [--no-labels] [--skip-checks]';

const WORKFLOWS = ".github/workflows";

type Label = { name: string; color: string; description: string };

const LABELS: Label[] = [
  { name: "feature", color: "a2eeef", description: "A Task the plugin can't do yet (filed by the Feedback skill)" },
  { name: "drift", color: "d93f0b", description: "The site changed away from a Contract (filed by the Feedback skill; fixed by fix)" },
  { name: "bug", color: "b60205", description: "A bug in the plugin's own code (filed by the Feedback skill; fixed by fix)" },
  { name: "unverified", color: "fbca04", description: "Fix made from the issue's diff; the maintainer's account can't reach the Task" },
  { name: "needs-account", color: "d4c5f9", description: "The maintainer's account can't perform this Task" },
];

/** In a shared repo the Feedback skill also files every issue with a label named after the plugin. */
const pluginLabel = (plugin: string): Label => ({ name: plugin, color: "c5def5", description: `Issues about the ${plugin} plugin` });

function fallbackReadme(info: PluginInfo): string {
  return `# ${info.plugin}

${info.description}

Generated with site-cli-creator. Maintainer: @${info.maintainer}.

Problems and feature requests go to [${info.repo}](https://github.com/${info.repo}/issues) through the \`${info.plugin}-feedback\` skill.
`;
}

/** The gh command that creates one label; also printed for the maintainer to rerun. */
function labelArgs(repo: string, label: Label): string[] {
  return ["gh", "label", "create", label.name, "--repo", repo, "--force", "--color", label.color, "--description", label.description];
}

const shellWord = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

function createLabels(repo: string, labels: Label[]): { created: string[]; failed?: string } {
  const created: string[] = [];
  for (const label of labels) {
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

/**
 * --into: what the shared repo must look like before anything is written. Returns the root
 * marketplace files (relative paths) the plugin will be listed in, and the marketplace's name.
 */
function checkSharedRoot(root: string, plugin: string): { markets: (keyof typeof MARKETPLACES)[]; marketplace: string } {
  if (!existsSync(root) || !statSync(root).isDirectory()) fail(`--into ${root} is not a folder: clone the shared repo first`);
  const markets = (Object.keys(MARKETPLACES) as (keyof typeof MARKETPLACES)[]).filter((k) => existsSync(join(root, MARKETPLACES[k])));
  if (markets.length === 0) {
    fail(
      `${root} has no marketplace file (${Object.values(MARKETPLACES).join(", ")}): --into adds a plugin to a repo that is a marketplace. ` +
        "For a plugin in its own repo, use --dir.",
    );
  }
  let marketplace = "";
  for (const k of markets) {
    const path = join(root, MARKETPLACES[k]);
    let parsed: { name?: unknown; plugins?: unknown };
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      fail(`not valid JSON: ${path}`);
    }
    if (!Array.isArray(parsed.plugins)) fail(`${path} has no "plugins" list`);
    if (parsed.plugins.some((p) => (p as { name?: unknown })?.name === plugin)) fail(`${MARKETPLACES[k]} already lists a plugin named ${plugin}`);
    if (!marketplace && typeof parsed.name === "string") marketplace = parsed.name;
  }
  const { PLUGIN_DIR, PREFIX } = layoutTokens("shared", plugin);
  for (const rel of [PLUGIN_DIR, `${WORKFLOWS}/${PREFIX}ci.yml`, `${WORKFLOWS}/${PREFIX}release.yml`]) {
    if (existsSync(join(root, rel))) fail(`${join(root, rel)} already exists: pick another plugin name, or remove it first`);
  }
  if (!marketplace) fail(`no marketplace file in ${root} has a "name"`);
  return { markets, marketplace };
}

await runTool(async () => {
  const { values } = parseFlags(
    process.argv.slice(2),
    {
      dir: { type: "string", help: "a plugin in its own repo: the repo's local folder (empty, or only .git)" },
      into: { type: "string", help: "a plugin in a shared repo: the local root of a repo that is a marketplace; the plugin goes to plugins/<plugin>" },
      plugin: { type: "string", required: true, help: "plugin name, kebab-case" },
      repo: { type: "string", required: true, help: "GitHub owner/name of the plugin repo (with --into, the shared repo)" },
      description: { type: "string", required: true, help: "one line: what agents can do with the plugin (quote it)" },
      maintainer: { type: "string", required: true, help: "GitHub login of the maintainer (gh api user -q .login)" },
      "no-labels": { type: "boolean", help: "do not create the repo labels (tests only)" },
      "skip-checks": { type: "boolean", help: "skip the maintainer requirement checks (tests and CI only)" },
    },
    USAGE,
  );
  if (!values.dir === !values.into) fail(`pass either --dir (a plugin in its own repo) or --into (a shared marketplace repo)\nusage: ${USAGE}`);
  const plugin = requireKebab("plugin", values.plugin);
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo)) fail(`--repo must be owner/name, got "${values.repo}"`);
  const owner = values.repo.split("/")[0] as string;
  const layout: Layout = values.into ? "shared" : "standalone";
  const { PREFIX, PLUGIN_DIR } = layoutTokens(layout, plugin);
  const root = resolve((values.into ?? values.dir) as string);
  const dir = join(root, PLUGIN_DIR);
  const starter = starterDir();
  const pluginStarter = requireDir(join(starter, "plugin"), "starter/plugin");
  const feedbackStarter = requireDir(join(starter, "feedback"), "starter/feedback");
  const deployStarter = requireDir(join(starter, "deploy"), "starter/deploy");
  const shared = layout === "shared" ? checkSharedRoot(root, plugin) : null;
  if (!shared) assertWritableDir(dir);
  if (!values["skip-checks"]) {
    progress("checking maintainer requirements (Bun, Chrome, gh, admin on the repo)");
    const unmet = unmetRequirements(values.repo, systemProbe());
    if (unmet.length > 0) {
      fail(`${unmet.length} maintainer requirement(s) not met, nothing was written:\n- ${unmet.map((u) => u.message).join("\n- ")}`, { unmet });
    }
  }

  const generatedWith = generatorVersion();
  const tagPrefix = `${PREFIX}v`;
  const tokens: Tokens = {
    PLUGIN: plugin,
    REPO: values.repo,
    OWNER: owner,
    DESCRIPTION: values.description,
    MAINTAINER: values.maintainer,
    GENERATOR_VERSION: generatedWith,
    PREFIX,
    PLUGIN_DIR,
    MARKETPLACE: shared?.marketplace ?? plugin,
  };
  // Every path below is relative to the repo root, which is the plugin's root when it has its own repo.
  const inPlugin = (rel: string) => relative(root, join(dir, rel));
  const files = copyTemplate(pluginStarter, dir, tokens, { layout, skip: (rel) => rel === WORKFLOWS }).map(inPlugin);
  const workflowStarter = join(pluginStarter, WORKFLOWS);
  if (existsSync(workflowStarter)) {
    files.push(...copyTemplate(workflowStarter, join(root, WORKFLOWS), tokens, { layout }).map((f) => join(WORKFLOWS, f)));
  }
  for (const [starterSkill, suffix] of [[feedbackStarter, "feedback"], [deployStarter, "deploy"]] as const) {
    const rel = join("skills", `${plugin}-${suffix}`);
    files.push(...copyTemplate(starterSkill, join(dir, rel), tokens, { layout }).map((f) => inPlugin(join(rel, f))));
    const skillMd = join(dir, rel, "SKILL.md");
    if (existsSync(skillMd)) setSkillMdVersion(skillMd, INITIAL_VERSION);
  }

  const info: PluginInfo = { plugin, repo: values.repo, description: values.description, maintainer: values.maintainer, pluginDir: PLUGIN_DIR };
  const manifests: Record<string, unknown> = buildManifests(info);
  for (const [key, rel] of Object.entries(MANIFESTS)) {
    writeJson(join(dir, rel), manifests[key]);
    files.push(inPlugin(rel));
  }
  if (shared) {
    // The shared repo's marketplace lists the plugin; the plugin has no marketplace of its own.
    for (const k of shared.markets) {
      const path = join(root, MARKETPLACES[k]);
      writeFileSync(path, appendPluginEntry(readFileSync(path, "utf8"), marketplaceEntry(k, { ...info, pluginDir: PLUGIN_DIR })));
      files.push(MARKETPLACES[k]);
    }
  } else {
    const marketplaces: Record<string, unknown> = buildMarketplaces(info);
    for (const [key, rel] of Object.entries(MARKETPLACES)) {
      writeJson(join(dir, rel), marketplaces[key]);
      files.push(rel);
    }
  }
  // pluginDir and tagPrefix tell add-skill, fix and the release steps where the plugin sits and how its tags read.
  writeJson(join(dir, "generated.json"), { generatedWith, maintainer: values.maintainer, pluginDir: PLUGIN_DIR, tagPrefix });
  files.push(inPlugin("generated.json"));
  if (!existsSync(join(dir, "README.md"))) {
    writeFileSync(join(dir, "README.md"), fallbackReadme(info));
    files.push(inPlugin("README.md"));
  }
  assertNoTokens(root, files);

  const next = `${toolCommand("add-skill")} --dir ${dir} --skill <name> --origin <url> --auth login|none`;
  const labelSet = shared ? [...LABELS, pluginLabel(plugin)] : LABELS;
  let labels: { created: string[]; failed?: string } | "skipped" = "skipped";
  if (!values["no-labels"]) {
    progress(`creating labels on ${values.repo}`);
    labels = createLabels(values.repo, labelSet);
    if (labels.failed) {
      // The loop needs these labels (the Feedback skill files with `feature`, `drift` and `bug`, and
      // in a shared repo `<plugin>`; fix uses `unverified`, add-task `needs-account`), so this is a
      // failure; the files are kept.
      const created = labels.created;
      const retry = labelSet.filter((l) => !created.includes(l.name)).map((l) => labelArgs(values.repo, l).map(shellWord).join(" "));
      fail(
        `the plugin's files were written to ${dir}, but creating the repo labels failed (${labels.failed}). ` +
          "Run the commands in `retry` until they succeed, then go on with add-skill; do not run new.ts again.",
        { dir, labels, retry, next },
      );
    }
  }
  return {
    dir,
    ...(shared ? { root, marketplaces: shared.markets.map((k) => MARKETPLACES[k]) } : {}),
    plugin,
    repo: values.repo,
    version: INITIAL_VERSION,
    tagPrefix,
    generatedWith,
    labels,
    files: [...new Set(files)].sort(),
    next,
  };
});
