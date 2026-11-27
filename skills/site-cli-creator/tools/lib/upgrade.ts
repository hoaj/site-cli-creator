// upgrade (SPEC §5): bring a plugin's Starter code from the generator versions it was copied from to this one.
// The plugin's own files came from the Starter code of generated.json's generatedWith (new); each CLI skill's
// from the generator that ran add-skill, which may be newer (generated.json's `skills`, else inferred).
// Both the base and the target Starter code are rendered with the plugin's own values, as new and
// add-skill would have written them, and each Starter file is merged three ways: the plugin's file, the
// base render and the target render. The site's own code is never touched.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { MANIFESTS, MARKETPLACES, readJson } from "./manifests";
import { fail } from "./output";
import { copyPluginStarter, copySkillStarter } from "./render";
import { repoFromManifest } from "./scaffold";
import { layoutTokens, type Layout, type Tokens } from "./template";

export type PluginSkill = { name: string; origin: string; auth: "login" | "none" };

export type PluginState = {
  /** The repo root: the plugin's root, or the shared repo's root for plugins/<plugin>. */
  root: string;
  /** The plugin's folder relative to root: "." or plugins/<plugin>. */
  pluginDir: string;
  layout: Layout;
  plugin: string;
  version: string;
  generatedWith: string;
  /** generated.json's `skills`: the generator version add-skill copied a skill's Starter code from, when not generatedWith. */
  skillVersions: Record<string, string>;
  tokens: Tokens;
  skills: PluginSkill[];
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => {
    const m = SEMVER.exec(v);
    if (!m) fail(`not a X.Y.Z version: ${JSON.stringify(v)}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }) as [number[], number[]];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/**
 * The Starter version to merge from for a part copied from `want`: `want` itself when the source has it,
 * or, when that version was never tagged (it never reached the generator's main), the highest one below
 * it, marked approximate.
 */
export function pickBase(versions: string[], want: string): { version: string; approximate: boolean } | null {
  if (versions.includes(want)) return { version: want, approximate: false };
  const best = versions.filter((v) => compareVersions(v, want) < 0).sort(compareVersions).at(-1);
  return best ? { version: best, approximate: true } : null;
}

/** Where the Starter code of past generator versions comes from: the generator's tags, or a local folder. */
export type StarterSource = {
  /** Every version it holds, as X.Y.Z. */
  versions: string[];
  /** The starter/ folder of one of those versions. */
  get(version: string): Promise<string>;
};

/** A folder holding one `<X.Y.Z>/` subfolder per version, each a copy of that version's starter/ (--starters). */
export function localStarters(dir: string): StarterSource {
  const versions = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SEMVER.test(d.name))
    .map((d) => d.name)
    .sort(compareVersions);
  return { versions, get: async (v) => join(dir, v) };
}

/** A CLI skill's origin and auth, read back from its site.ts (add-skill wrote them from --origin and --auth). */
function readSkill(pluginDir: string, name: string): PluginSkill {
  const path = join(pluginDir, "skills", name, "cli", "src", "site.ts");
  const text = readFileSync(path, "utf8");
  const origin = /^\s*origin:\s*["']([^"']+)["']/m.exec(text)?.[1];
  const auth = /^\s*auth:\s*["'](login|none)["']/m.exec(text)?.[1] as "login" | "none" | undefined;
  if (!origin || !auth) fail(`${path} has no origin or auth line to read the skill's Starter tokens from`);
  return { name, origin, auth };
}

/** Reads what the Starter code was filled with in this plugin: its manifest, generated.json and each CLI skill's site.ts. */
export function readPlugin(dir: string): PluginState {
  const manifest = readJson<{ name?: unknown; version?: unknown; repository?: unknown; description?: unknown }>(join(dir, MANIFESTS.claude));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") fail(`${MANIFESTS.claude} needs name and version`);
  const genPath = join(dir, "generated.json");
  if (!existsSync(genPath)) fail(`${genPath} not found: upgrade works on a plugin made by site-cli-creator's new`);
  const generated = readJson<{ generatedWith?: unknown; maintainer?: unknown; pluginDir?: unknown; skills?: unknown }>(genPath);
  if (typeof generated.generatedWith !== "string") fail(`${genPath} has no generatedWith`);
  const plugin = manifest.name;
  const repo = repoFromManifest(manifest.repository);
  const pluginDir = typeof generated.pluginDir === "string" && generated.pluginDir !== "" ? generated.pluginDir : ".";
  const layout: Layout = pluginDir === "." ? "standalone" : "shared";
  const root = pluginDir === "." ? dir : join(dir, ...pluginDir.split("/").map(() => ".."));
  let marketplace = plugin;
  if (layout === "shared") {
    // The README installs from the shared repo's marketplace (new --into read its name the same way).
    for (const rel of Object.values(MARKETPLACES)) {
      const path = join(root, rel);
      if (!existsSync(path)) continue;
      const name = readJson<{ name?: unknown }>(path).name;
      if (typeof name === "string") {
        marketplace = name;
        break;
      }
    }
  }
  const owner = repo.split("/")[0] as string;
  const tokens: Tokens = {
    PLUGIN: plugin,
    REPO: repo,
    OWNER: owner,
    DESCRIPTION: typeof manifest.description === "string" ? manifest.description : "",
    MAINTAINER: typeof generated.maintainer === "string" ? generated.maintainer : owner,
    ...layoutTokens(layout, plugin),
    MARKETPLACE: marketplace,
  };
  const skillsDir = join(dir, "skills");
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, "cli", "src", "site.ts")))
        .map((d) => readSkill(dir, d.name))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const skillVersions: Record<string, string> = {};
  if (generated.skills && typeof generated.skills === "object") {
    for (const [name, v] of Object.entries(generated.skills)) if (typeof v === "string" && SEMVER.test(v)) skillVersions[name] = v;
  }
  return { root, pluginDir, layout, plugin, version: manifest.version, generatedWith: generated.generatedWith, skillVersions, tokens, skills };
}

/** Paths in a CLI skill that hold the site's own code or what regen writes: the merge never touches them. */
const SITE_CODE = [/^cli\/src\/site\.ts$/, /^cli\/src\/registry\.ts$/, /^cli\/src\/(operations|commands|lib)\//, /^captures\//];

/** Which starter/ folder each part of the plugin is rendered from: the plugin's own files, and each CLI skill. */
export type StarterParts = { plugin: string; skills: Record<string, string> };

/**
 * Renders the Starter code for this plugin into `out`, laid out like the plugin's repo root, with the
 * plugin's current version in every pin, so two renders differ only where the Starter code changed.
 * `generatorVersion` fills __GENERATOR_VERSION__, which add-skill also filled with the plugin's generatedWith.
 */
export function renderStarter(parts: StarterParts, out: string, state: PluginState, generatorVersion: string): void {
  const tokens: Tokens = { ...state.tokens, GENERATOR_VERSION: generatorVersion };
  const dir = join(out, state.pluginDir);
  copyPluginStarter(parts.plugin, out, dir, tokens, state.layout, state.version);
  for (const skill of state.skills) renderSkill(parts.skills[skill.name] ?? parts.plugin, join(dir, "skills", skill.name), state, skill, generatorVersion);
}

function renderSkill(starter: string, skillDir: string, state: PluginState, skill: PluginSkill, generatorVersion: string): void {
  const tokens: Tokens = { ...state.tokens, GENERATOR_VERSION: generatorVersion, SKILL: skill.name, ORIGIN: skill.origin, AUTH: skill.auth };
  copySkillStarter(join(starter, "skill"), skillDir, tokens, state.layout, state.version);
}

/** Lines that differ between two folders (`git diff --no-index --numstat`, added plus deleted). */
function linesApart(a: string, b: string): number {
  const proc = Bun.spawnSync(["git", "diff", "--no-index", "--numstat", a, b], { stdout: "pipe", stderr: "pipe" });
  if ((proc.exitCode ?? 2) > 1) fail(`git diff --no-index failed: ${proc.stderr.toString().trim()}`);
  let n = 0;
  for (const line of proc.stdout.toString().split("\n")) {
    const [added, deleted] = line.split("\t");
    if (added && added !== "-") n += Number(added) + Number(deleted);
  }
  return n;
}

/**
 * The Starter version a CLI skill was most likely copied from, for a plugin with no record of it: of the
 * `candidates`, the one whose render differs from the skill's Starter files by the fewest lines (the
 * newest on a tie). A skill the plugin edited still lands on the version it came from, since every other
 * version adds that version's own differences on top.
 */
export function closestSkillVersion(
  candidates: { version: string; starter: string }[],
  state: PluginState,
  skill: PluginSkill,
  scratch: string,
): { version: string; linesApart: number } {
  const root = join(scratch, "infer", skill.name);
  const renders = candidates.map((c) => {
    const out = join(root, c.version);
    renderSkill(c.starter, out, state, skill, state.generatedWith);
    return { ...c, out };
  });
  // The plugin's copy of every file some candidate has, outside the site's own code.
  const mine = join(root, "plugin");
  const skillDir = join(state.root, state.pluginDir, "skills", skill.name);
  const starterFiles = new Set(renders.flatMap((r) => listFiles(r.out)).filter((rel) => !SITE_CODE.some((re) => re.test(rel))));
  for (const rel of starterFiles) {
    if (existsSync(join(skillDir, rel))) {
      mkdirSync(dirname(join(mine, rel)), { recursive: true });
      cpSync(join(skillDir, rel), join(mine, rel));
    }
  }
  mkdirSync(mine, { recursive: true });
  let best: { version: string; linesApart: number } | null = null;
  for (const r of renders) {
    for (const rel of listFiles(r.out)) if (SITE_CODE.some((re) => re.test(rel))) rmSync(join(r.out, rel));
    const n = linesApart(r.out, mine);
    if (!best || n < best.linesApart || (n === best.linesApart && compareVersions(r.version, best.version) > 0)) best = { version: r.version, linesApart: n };
  }
  if (!best) fail(`no Starter version to compare skills/${skill.name} with`);
  return best;
}


export function isSiteCode(rel: string, state: PluginState): boolean {
  for (const skill of state.skills) {
    const prefix = `${state.pluginDir === "." ? "" : `${state.pluginDir}/`}skills/${skill.name}/`;
    if (rel.startsWith(prefix) && SITE_CODE.some((re) => re.test(rel.slice(prefix.length)))) return true;
  }
  return false;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

export type MergeReport = {
  /** New in the Starter code, now in the plugin. */
  added: string[];
  /** Unchanged in the plugin since it was copied: replaced with the new Starter file. */
  updated: string[];
  /** Changed in both, on different lines: merged cleanly. */
  merged: string[];
  /** Changed in both on the same lines (conflict markers written), or a binary file changed in both (left as it was). */
  conflicts: string[];
  /** In the old Starter code and not the new: reported, never deleted. */
  removedFromStarter: string[];
  /** Changed in the Starter code, but the plugin deleted its copy: left deleted. */
  deletedInPlugin: string[];
};

const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

function writeLike(target: string, content: Buffer | string, modeFrom: string): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  chmodSync(target, statSync(modeFrom).mode & 0o777);
}

/**
 * `git merge-file --diff3` of ours (the plugin's file) with base and theirs; returns the merged text and
 * whether it holds conflicts. The labels name the sides in the conflict markers.
 */
function mergeFile(ours: string, base: string, theirs: string, labels: [string, string, string]): { text: string; conflict: boolean } {
  const proc = Bun.spawnSync(
    ["git", "merge-file", "-p", "--diff3", "-L", labels[0], "-L", labels[1], "-L", labels[2], ours, base, theirs],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = proc.exitCode ?? 255;
  if (code < 0 || code > 127) fail(`git merge-file failed on ${ours}: ${proc.stderr.toString().trim() || `exit ${code}`}`);
  return { text: proc.stdout.toString(), conflict: code > 0 };
}

/**
 * Merges every Starter file from the base render to the target render into the plugin at `root`, by the
 * rules of SPEC §5: a file the plugin never changed takes the target, a file only the plugin changed stays,
 * a file both changed is merged (conflict markers where they touch the same lines), a new Starter file is
 * added, and a removed one or one the plugin deleted is only reported. `skip` leaves out the site's code.
 */
export function mergeStarter(
  root: string,
  base: string,
  target: string,
  scratch: string,
  labels: [string, string, string],
  skip: (rel: string) => boolean,
): MergeReport {
  const report: MergeReport = { added: [], updated: [], merged: [], conflicts: [], removedFromStarter: [], deletedInPlugin: [] };
  const empty = join(scratch, "empty");
  writeFileSync(empty, "");
  const baseFiles = new Set(listFiles(base));
  const targetFiles = new Set(listFiles(target));
  for (const rel of [...new Set([...baseFiles, ...targetFiles])].sort()) {
    if (skip(rel)) continue;
    const mine = join(root, rel);
    const inPlugin = existsSync(mine);
    if (!targetFiles.has(rel)) {
      if (inPlugin) report.removedFromStarter.push(rel);
      continue;
    }
    const theirs = readFileSync(join(target, rel));
    const old = baseFiles.has(rel) ? readFileSync(join(base, rel)) : null;
    if (old && old.equals(theirs)) continue; // the Starter code did not change this file
    if (!inPlugin) {
      if (old) report.deletedInPlugin.push(rel);
      else {
        writeLike(mine, theirs, join(target, rel));
        report.added.push(rel);
      }
      continue;
    }
    const current = readFileSync(mine);
    if (current.equals(theirs)) continue; // already the new Starter file
    if (old && current.equals(old)) {
      writeLike(mine, theirs, join(target, rel));
      report.updated.push(rel);
      continue;
    }
    if (isBinary(current) || isBinary(theirs) || (old && isBinary(old))) {
      report.conflicts.push(rel);
      continue;
    }
    const { text, conflict } = mergeFile(mine, old ? join(base, rel) : empty, join(target, rel), labels);
    writeFileSync(mine, text);
    (conflict ? report.conflicts : report.merged).push(rel);
  }
  return report;
}
