#!/usr/bin/env bun
// bun tools/upgrade.ts --dir <plugin> [--starters <folder>]
// Brings a plugin's Starter code to this generator's (SPEC §5 upgrade): renders every past Starter version
// from the one each part was copied from (the plugin's own files: generated.json's generatedWith; each CLI
// skill: its version in generated.json's `skills`, else generatedWith) and this generator's, merges each
// Starter file three ways from the past version closest to it, leaves the site's own code alone, and
// records the new generatedWith.
// Past Starter code comes from the generator's version tags on GitHub, or from --starters.
// STARTER_DIR overrides the target (tests only).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseFlags } from "./lib/args";
import { readJson, writeJson } from "./lib/manifests";
import { fail, progress, runTool } from "./lib/output";
import { GENERATOR_ROOT, generatorVersion, starterDir } from "./lib/paths";
import { repoFromManifest, requireDir } from "./lib/scaffold";
import { compareVersions, isSiteCode, localStarters, mergeStarter, pickBase, readPlugin, renderStarter, skillOf, type StarterSource } from "./lib/upgrade";

const USAGE = "bun tools/upgrade.ts --dir <plugin> [--starters <folder>]";
const OFFLINE = "or pass --starters <folder> holding a <X.Y.Z>/ copy of each version's skills/site-cli-creator/starter/";

/** The generator's own GitHub repo, where its version tags are. */
function generatorRepo(): string {
  return repoFromManifest(readJson<{ repository?: unknown }>(join(GENERATOR_ROOT, ".claude-plugin", "plugin.json")).repository);
}

function run(args: string[], cwd?: string): { ok: boolean; out: string; err: string } {
  const proc = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.success, out: proc.stdout.toString(), err: proc.stderr.toString().trim() };
}

/** The generator's version tags vX.Y.Z on GitHub; each version's Starter code is downloaded once, when first asked for. */
function githubStarters(repo: string, scratch: string): StarterSource {
  progress(`listing the version tags of ${repo}`);
  const ls = run(["git", "ls-remote", "--tags", "--refs", `https://github.com/${repo}.git`]);
  if (!ls.ok) fail(`could not list the tags of ${repo} (${ls.err || "git ls-remote failed"}), ${OFFLINE}`);
  const versions = ls.out
    .split("\n")
    .map((l) => /\trefs\/tags\/v(\d+\.\d+\.\d+)$/.exec(l)?.[1])
    .filter((v): v is string => !!v)
    .sort(compareVersions);
  const got = new Map<string, string>();
  return {
    versions,
    async get(version) {
      const known = got.get(version);
      if (known) return known;
      const url = `https://codeload.github.com/${repo}/tar.gz/refs/tags/v${version}`;
      progress(`downloading the Starter code of v${version}`);
      const res = await fetch(url);
      if (!res.ok) fail(`downloading ${url} answered ${res.status}, ${OFFLINE}`);
      const archive = join(scratch, `v${version}.tar.gz`);
      writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
      const src = join(scratch, "src", version);
      mkdirSync(src, { recursive: true });
      const tar = run(["tar", "-xzf", archive, "-C", src]);
      if (!tar.ok) fail(`unpacking v${version} failed: ${tar.err}`);
      const [top] = readdirSync(src);
      if (!top) fail(`the v${version} archive is empty`);
      const starter = requireDir(join(src, top, "skills", "site-cli-creator", "starter"), `starter/ in v${version}`);
      got.set(version, starter);
      return starter;
    },
  };
}

await runTool(async () => {
  const { values } = parseFlags(
    process.argv.slice(2),
    {
      dir: { type: "string", required: true, help: "the plugin's root folder (plugins/<plugin> in a shared repo)" },
      starters: {
        type: "string",
        help: "a folder with a <X.Y.Z>/ copy of each past version's starter/, instead of downloading them from the generator's tags (offline, tests)",
      },
    },
    USAGE,
  );
  const dir = requireDir(resolve(values.dir), "plugin dir");
  const state = readPlugin(dir);
  const from = state.generatedWith;
  const to = generatorVersion();
  // Only the records of CLI skills the plugin still has count.
  const recorded = state.skills.map((sk) => state.skillVersions[sk.name]).filter((v): v is string => !!v);
  if (compareVersions(from, to) === 0 && recorded.every((v) => v === to)) return { dir, from, to, upToDate: true };
  for (const v of [from, ...recorded]) {
    if (compareVersions(v, to) > 0) fail(`the plugin has Starter code from generator ${v}, newer than this one (${to}): update site-cli-creator first (/plugin marketplace update hoaj)`);
  }
  const status = run(["git", "status", "--porcelain"], state.root);
  if (!status.ok) fail(`${state.root} is not a git checkout (${status.err}): upgrade writes into a branch you review as a PR`);
  if (status.out.trim()) fail(`${state.root} has uncommitted changes: commit or stash them first, so the upgrade is the branch's only change`);

  const repo = generatorRepo();
  const scratch = mkdtempSync(join(tmpdir(), "site-cli-upgrade-"));
  try {
    const source = values.starters ? localStarters(requireDir(resolve(values.starters), "--starters")) : githubStarters(repo, scratch);
    const past = source.versions.filter((v) => compareVersions(v, to) < 0);

    // The version each part was copied from: its floor. Only Starter code from there up can be a file's base.
    // A plugin already at this version keeps its own files; only a skill a record holds back is merged.
    const pluginBase = compareVersions(from, to) === 0 ? { version: to, approximate: false } : pickBase(past, from);
    if (!pluginBase) fail(`no Starter code at or below ${from} (the plugin's generatedWith) in ${values.starters ?? `${repo}'s tags`}, ${OFFLINE}`);
    const skillBases: Record<string, { version: string; from: "generated.json" | "generatedWith"; approximate?: true }> = {};
    for (const skill of state.skills) {
      const want = state.skillVersions[skill.name];
      if (want && compareVersions(want, to) >= 0) {
        skillBases[skill.name] = { version: to, from: "generated.json" };
        continue;
      }
      // A skill with no record (added before add-skill kept one) is only known to be no older than the plugin.
      const b = want ? pickBase(past, want) : pluginBase;
      if (!b) fail(`no Starter code at or below ${want} (skills/${skill.name} in generated.json), ${OFFLINE}`);
      skillBases[skill.name] = { version: b.version, from: want ? "generated.json" : "generatedWith", ...(b.approximate ? { approximate: true as const } : {}) };
    }
    const floors = [pluginBase.version, ...Object.values(skillBases).map((b) => b.version)];
    const oldest = floors.sort(compareVersions)[0]!;

    const renders = [];
    for (const v of past.filter((v) => compareVersions(v, oldest) >= 0)) {
      const dir = join(scratch, "renders", v);
      renderStarter(await source.get(v), dir, state, from);
      renders.push({ version: v, dir });
    }
    progress(`merging the Starter code of v${oldest}…v${to} into ${state.plugin}`);
    const target = starterDir();
    renderStarter(target, join(scratch, "target"), state, to);
    const report = mergeStarter(
      state.root,
      renders,
      { version: to, dir: join(scratch, "target") },
      (rel) => {
        const skill = skillOf(rel, state);
        return skill ? skillBases[skill]!.version : pluginBase.version;
      },
      scratch,
      (v) => [state.plugin, `starter v${v}`, `starter v${to}`],
      (rel) => isSiteCode(rel, state),
    );
    // site.ts is the site's code, but its generatedWith line is the generator's (add-skill fills it; doctor falls back to it).
    for (const skill of state.skills) {
      const site = join(dir, "skills", skill.name, "cli", "src", "site.ts");
      const text = readFileSync(site, "utf8");
      const next = text.replace(/^(\s*generatedWith:\s*)(["'])[^"']*\2/m, `$1"${to}"`);
      if (next !== text) writeFileSync(site, next);
    }
    // Every part is at this version now, so the per-skill record goes.
    const genPath = join(dir, "generated.json");
    const { skills: _skills, ...generated } = readJson<Record<string, unknown>>(genPath);
    writeJson(genPath, { ...generated, generatedWith: to });

    // The site's own site.ts is never merged, but the runtime may read fields the new Starter site.ts added.
    const siteDiff = run(["git", "diff", "--no-index", "--no-color", join(await source.get(oldest), "skill/cli/src/site.ts"), join(target, "skill/cli/src/site.ts")]);
    const touched = [...report.added, ...report.updated, ...report.merged, ...report.conflicts, ...report.binaryConflicts];
    // The generator's commits between the versions; this version may not be tagged yet (version-tags.yml runs on main).
    const head = source.versions.includes(to) ? `v${to}` : "main";
    return {
      dir,
      from,
      to,
      bases: { plugin: { version: pluginBase.version, ...(pluginBase.approximate ? { approximate: true } : {}) }, skills: skillBases },
      compare: `https://github.com/${repo}/compare/v${oldest}...${head}`,
      ...report,
      siteTemplateDiff: siteDiff.out.trim() || null,
      workflowsChanged: touched.some((f) => f.startsWith(".github/workflows/")),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
