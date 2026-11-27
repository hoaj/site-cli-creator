#!/usr/bin/env bun
// bun tools/upgrade.ts --dir <plugin> [--starters <folder>]
// Brings a plugin's Starter code to this generator's (SPEC §5 upgrade): renders the Starter code each
// part was copied from (the plugin's own files: generated.json's generatedWith; each CLI skill: its
// version in generated.json's `skills`, else the closest one) and this generator's, merges each
// Starter file three ways, leaves the site's own code alone, and records the new generatedWith.
// Past Starter code comes from the generator's version tags on GitHub, or from --starters.
// STARTER_DIR overrides the target (tests only).

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseFlags } from "./lib/args";
import { readJson, writeJson } from "./lib/manifests";
import { fail, progress, runTool } from "./lib/output";
import { GENERATOR_ROOT, generatorVersion, starterDir } from "./lib/paths";
import { repoFromManifest, requireDir } from "./lib/scaffold";
import {
  closestSkillVersion,
  compareVersions,
  isSiteCode,
  localStarters,
  mergeStarter,
  pickBase,
  readPlugin,
  renderStarter,
  type StarterParts,
  type StarterSource,
} from "./lib/upgrade";

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
  const recorded = Object.values(state.skillVersions);
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
    const target = starterDir();
    // This generator's Starter code is the target, and also a candidate base for a skill added with it.
    const versions = [...new Set([...source.versions.filter((v) => compareVersions(v, to) < 0), to])].sort(compareVersions);
    const get = (v: string) => (v === to ? Promise.resolve(target) : source.get(v));

    const pluginBase = pickBase(versions, from);
    if (!pluginBase) fail(`no Starter code at or below ${from} (the plugin's generatedWith) in ${values.starters ?? `${repo}'s tags`}, ${OFFLINE}`);
    const parts: StarterParts = { plugin: await get(pluginBase.version), skills: {} };
    const skillBases: Record<string, { version: string; from: "generated.json" | "closest"; approximate?: true; linesApart?: number }> = {};
    for (const skill of state.skills) {
      const want = state.skillVersions[skill.name];
      if (want) {
        const b = pickBase(versions, want);
        if (!b) fail(`no Starter code at or below ${want} (skills/${skill.name} in generated.json), ${OFFLINE}`);
        parts.skills[skill.name] = await get(b.version);
        skillBases[skill.name] = { version: b.version, from: "generated.json", ...(b.approximate ? { approximate: true as const } : {}) };
        continue;
      }
      // No record (a skill added before add-skill wrote one): the closest version from the plugin's own up.
      progress(`finding the Starter version skills/${skill.name} was copied from`);
      const candidates = [];
      for (const v of versions.filter((v) => compareVersions(v, pluginBase.version) >= 0)) candidates.push({ version: v, starter: await get(v) });
      const best = closestSkillVersion(candidates, state, skill, scratch);
      parts.skills[skill.name] = await get(best.version);
      skillBases[skill.name] = { version: best.version, from: "closest", linesApart: best.linesApart };
    }

    progress(`rendering the Starter code it came from and v${to} for ${state.plugin}`);
    renderStarter(parts, join(scratch, "base"), state, from);
    const targetParts: StarterParts = { plugin: target, skills: {} };
    renderStarter(targetParts, join(scratch, "target"), state, to);
    const report = mergeStarter(
      state.root,
      join(scratch, "base"),
      join(scratch, "target"),
      scratch,
      [state.plugin, "starter it came from", `starter v${to}`],
      (rel) => isSiteCode(rel, state),
    );
    // Every part is at this version now, so the per-skill record goes.
    const genPath = join(dir, "generated.json");
    const { skills: _skills, ...generated } = readJson<Record<string, unknown>>(genPath);
    writeJson(genPath, { ...generated, generatedWith: to });

    // The site's own site.ts is never merged, but the runtime may read fields the new Starter site.ts added.
    const oldest = [pluginBase.version, ...Object.values(skillBases).map((b) => b.version)].sort(compareVersions)[0]!;
    const siteDiff = run(["git", "diff", "--no-index", "--no-color", join(await get(oldest), "skill/cli/src/site.ts"), join(target, "skill/cli/src/site.ts")]);
    const touched = [...report.added, ...report.updated, ...report.merged, ...report.conflicts];
    return {
      dir,
      from,
      to,
      bases: { plugin: { version: pluginBase.version, ...(pluginBase.approximate ? { approximate: true } : {}) }, skills: skillBases },
      compare: `https://github.com/${repo}/compare/v${oldest}...v${to}`,
      ...report,
      siteTemplateDiff: siteDiff.out.trim() || null,
      workflowsChanged: touched.some((f) => f.startsWith(".github/workflows/")),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
