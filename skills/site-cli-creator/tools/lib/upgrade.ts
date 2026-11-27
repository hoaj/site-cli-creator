// upgrade (SPEC §5): bring a plugin's Starter code from the generator versions it was copied from to this one.
// The plugin's own files came from the Starter code of generated.json's generatedWith (new); each CLI skill's
// from the generator that ran add-skill, which may be newer (generated.json's `skills`, else inferred).
// Both the base and the target Starter code are rendered with the plugin's own values, as new and
// add-skill would have written them, and each Starter file is merged three ways: the plugin's file, the
// base render and the target render. The site's own code is never touched.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Renders one version's Starter code for this plugin into `out`, laid out like the plugin's repo root, with
 * the plugin's current version in every pin, so two renders differ only where the Starter code changed.
 * `generatorVersion` fills __GENERATOR_VERSION__, which add-skill also filled with the plugin's generatedWith.
 */
export function renderStarter(starter: string, out: string, state: PluginState, generatorVersion: string): void {
  const tokens: Tokens = { ...state.tokens, GENERATOR_VERSION: generatorVersion };
  const dir = join(out, state.pluginDir);
  copyPluginStarter(starter, out, dir, tokens, state.layout, state.version);
  for (const skill of state.skills) {
    const skillTokens: Tokens = { ...tokens, SKILL: skill.name, ORIGIN: skill.origin, AUTH: skill.auth };
    copySkillStarter(join(starter, "skill"), join(dir, "skills", skill.name), skillTokens, state.layout, state.version);
  }
}

/** The CLI skill a repo-relative path belongs to, or null for the plugin's own files. */
export function skillOf(rel: string, state: PluginState): string | null {
  const prefix = `${state.pluginDir === "." ? "" : `${state.pluginDir}/`}skills/`;
  if (!rel.startsWith(prefix)) return null;
  const name = rel.slice(prefix.length).split("/")[0];
  return state.skills.some((s) => s.name === name) ? (name as string) : null;
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
  /** Equal to a past Starter file (never edited in the plugin): replaced with the new Starter file. */
  updated: string[];
  /** Edited in the plugin and changed in the Starter code, on different lines: merged cleanly. */
  merged: string[];
  /** Edited in the plugin and changed in the Starter code on the same lines: conflict markers written. */
  conflicts: string[];
  /** A binary file edited in the plugin and changed in the Starter code: left as it was, no markers. */
  binaryConflicts: string[];
  /** In the old Starter code and not the new: reported, never deleted. */
  removedFromStarter: string[];
  /** Changed in the Starter code, but the plugin deleted its copy: left deleted. */
  deletedInPlugin: string[];
  /**
   * Edited files merged from a newer base than their part's (`bases`): the plugin's file is closest to that
   * version's, as when it took a later Starter fix by hand. Starter changes up to that version are taken as
   * already in the file.
   */
  newerBases: Record<string, string>;
};

/** One version's Starter code rendered for this plugin (renderStarter). */
export type Render = { version: string; dir: string };

const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

/** A file's content for comparing and merging: text with LF line endings (a Windows checkout has CRLF), binary as is. */
function content(path: string): Buffer {
  const raw = readFileSync(path);
  return isBinary(raw) ? raw : Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"));
}

const execBits = (path: string) => statSync(path).mode & 0o111;

/** How far apart two texts are: the lines one has that the other lacks, counted both ways (a line multiset). */
function linesApart(a: Buffer, b: Buffer): number {
  const counts = new Map<string, number>();
  for (const line of a.toString("utf8").split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  let n = 0;
  for (const line of b.toString("utf8").split("\n")) {
    const c = counts.get(line) ?? 0;
    if (c > 0) counts.set(line, c - 1);
    else n++;
  }
  for (const c of counts.values()) n += c;
  return n;
}

/**
 * `git merge-file --diff3` of ours (the plugin's file) with base and theirs, all LF text; returns the merged
 * text and whether it holds conflicts. The labels name the sides in the conflict markers.
 */
function mergeFile(scratch: string, ours: Buffer, base: Buffer, theirs: Buffer, labels: [string, string, string]): { text: Buffer; conflict: boolean } {
  const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(scratch, `merge-${n}`)) as [string, string, string];
  writeFileSync(o, ours);
  writeFileSync(b, base);
  writeFileSync(t, theirs);
  const proc = Bun.spawnSync(["git", "merge-file", "-p", "--diff3", "-L", labels[0], "-L", labels[1], "-L", labels[2], o, b, t], { stdout: "pipe", stderr: "pipe" });
  const code = proc.exitCode ?? 255;
  if (code < 0 || code > 127) fail(`git merge-file failed: ${proc.stderr.toString().trim() || `exit ${code}`}`);
  return { text: Buffer.from(proc.stdout), conflict: code > 0 };
}

/**
 * Merges every Starter file into the plugin at `root`, by the rules of SPEC §5. `renders` are the past
 * versions' renders (ascending) and `target` this generator's; `floor(rel)` is the version the file's part
 * was copied from (generatedWith, or a CLI skill's own), and only renders from it up are a file's bases: a
 * part already at the target's version is left as it is.
 * A file equal to one of them was never edited and takes the target; an edited one is merged three ways
 * from the closest of them (fewest lines apart, the older on a tie, so a doubt applies a change twice
 * rather than skipping it); a new Starter file is added, and a removed one or one the plugin deleted is
 * only reported. A change of only the executable bit is applied too. `skip` leaves out the site's code.
 */
export function mergeStarter(
  root: string,
  renders: Render[],
  target: Render,
  floor: (rel: string) => string,
  scratch: string,
  labels: (version: string) => [string, string, string],
  skip: (rel: string) => boolean,
): MergeReport {
  const report: MergeReport = { added: [], updated: [], merged: [], conflicts: [], binaryConflicts: [], removedFromStarter: [], deletedInPlugin: [], newerBases: {} };
  const files = new Map(renders.map((r) => [r.version, new Set(listFiles(r.dir))]));
  const targetFiles = new Set(listFiles(target.dir));
  const all = new Set(targetFiles);
  for (const set of files.values()) for (const rel of set) all.add(rel);
  for (const rel of [...all].sort()) {
    if (skip(rel) || compareVersions(floor(rel), target.version) >= 0) continue;
    const bases = renders.filter((r) => compareVersions(r.version, floor(rel)) >= 0 && files.get(r.version)!.has(rel));
    const mine = join(root, rel);
    const inPlugin = existsSync(mine);
    if (!targetFiles.has(rel)) {
      if (inPlugin && bases.length) report.removedFromStarter.push(rel);
      continue;
    }
    const theirsPath = join(target.dir, rel);
    const theirs = content(theirsPath);
    const first = bases[0];
    if (!inPlugin) {
      if (!first) {
        mkdirSync(dirname(mine), { recursive: true });
        writeFileSync(mine, theirs);
        chmodSync(mine, statSync(theirsPath).mode & 0o777);
        report.added.push(rel);
      } else if (!content(join(first.dir, rel)).equals(theirs)) report.deletedInPlugin.push(rel);
      continue;
    }
    const current = content(mine);
    // The executable bit: take the target's when the plugin kept the one its part came with.
    const fixMode = () => {
      if (first && execBits(mine) === execBits(join(first.dir, rel)) && execBits(mine) !== execBits(theirsPath)) {
        chmodSync(mine, (statSync(mine).mode & ~0o111 & 0o777) | execBits(theirsPath));
      }
    };
    if (current.equals(theirs)) {
      fixMode();
      continue;
    }
    const exact = bases.find((r) => content(join(r.dir, rel)).equals(current));
    if (exact) {
      writeFileSync(mine, theirs);
      fixMode();
      report.updated.push(rel);
      continue;
    }
    let base: { version: string; text: Buffer } | null = null;
    let best = Infinity;
    for (const r of bases) {
      const text = content(join(r.dir, rel));
      const n = isBinary(text) || isBinary(current) ? 0 : linesApart(text, current);
      if (n < best) {
        best = n;
        base = { version: r.version, text };
      }
    }
    if (base && base.text.equals(theirs)) continue; // the plugin's edit already holds every Starter change to it
    if (isBinary(current) || isBinary(theirs) || (base && isBinary(base.text))) {
      report.binaryConflicts.push(rel);
      continue;
    }
    if (base && first && base.version !== first.version) report.newerBases[rel] = base.version;
    const { text, conflict } = mergeFile(scratch, current, base?.text ?? Buffer.alloc(0), theirs, labels(base?.version ?? "none"));
    writeFileSync(mine, text);
    fixMode();
    (conflict ? report.conflicts : report.merged).push(rel);
  }
  return report;
}
