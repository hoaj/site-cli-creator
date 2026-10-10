// Every copy ("pin") of the plugin version, and how to read and rewrite each one.
// The source of truth is .claude-plugin/plugin.json; every other pin must equal it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SOURCE = ".claude-plugin/plugin.json";
export const MANIFESTS = [SOURCE, ".cursor-plugin/plugin.json", ".codex-plugin/plugin.json", ".github/plugin/plugin.json"];

export type Level = "patch" | "minor" | "major";
export const LEVELS: readonly Level[] = ["patch", "minor", "major"];

type Kind = "json" | "skill-md" | "site-ts";
export type PinFile = { file: string; kind: Kind };
export type Pin = PinFile & { version: string | null };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const JSON_VERSION = /("version"\s*:\s*")([^"]*)(")/;
const SKILL_MD_VERSION = /^(<!-- version: )(\d+\.\d+\.\d+)( |-->)/m;
const SITE_TS_VERSION = /^(\s*version:\s*["'])([^"']*)(["'])/m;

export function parseVersion(version: string): [number, number, number] {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`not a X.Y.Z version: ${JSON.stringify(version)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

export function nextVersion(version: string, level: Level): string {
  const [major, minor, patch] = parseVersion(version);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Every file that must carry a pin, relative to the plugin root, whether or not it exists. */
export function pinFiles(root: string): PinFile[] {
  const files: PinFile[] = MANIFESTS.map((file) => ({ file, kind: "json" }));
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return files;
  const skills = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const skill of skills) {
    const dir = `skills/${skill}`;
    files.push({ file: `${dir}/SKILL.md`, kind: "skill-md" });
    if (existsSync(join(root, dir, "cli"))) {
      files.push({ file: `${dir}/cli/package.json`, kind: "json" });
      files.push({ file: `${dir}/cli/src/site.ts`, kind: "site-ts" });
    }
  }
  return files;
}

export function readPin(text: string, kind: Kind): string | null {
  if (kind === "json") {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  }
  const m = (kind === "skill-md" ? SKILL_MD_VERSION : SITE_TS_VERSION).exec(text);
  return m ? m[2]! : null;
}

export function writePin(text: string, kind: Kind, version: string): string {
  const re = kind === "json" ? JSON_VERSION : kind === "skill-md" ? SKILL_MD_VERSION : SITE_TS_VERSION;
  if (!re.test(text)) throw new Error(`no version pin to rewrite (${kind})`);
  const out = text.replace(re, (_all, before: string, _old: string, after: string) => `${before}${version}${after}`);
  if (readPin(out, kind) !== version) throw new Error(`rewriting the version pin failed (${kind})`);
  return out;
}

function readFile(root: string, file: string): string | null {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function collectPins(root: string): Pin[] {
  return pinFiles(root).map((p) => {
    const text = readFile(root, p.file);
    return { ...p, version: text === null ? null : readPin(text, p.kind) };
  });
}

export function sourceVersion(root: string): string {
  const text = readFile(root, SOURCE);
  if (text === null) throw new Error(`${SOURCE} not found in ${root}`);
  const version = readPin(text, "json");
  if (version === null) throw new Error(`${SOURCE} has no "version"`);
  parseVersion(version);
  return version;
}

/** Pins that differ from the source version, or that are missing. Empty when all are in sync. */
export function mismatches(root: string): { file: string; found: string | null; expected: string }[] {
  const expected = sourceVersion(root);
  return collectPins(root)
    .filter((p) => p.version !== expected)
    .map((p) => ({ file: p.file, found: p.version, expected }));
}

/** Rewrites every pin to the next version. Fails before writing anything if a pin is missing. */
export function bump(root: string, level: Level): { from: string; to: string; files: string[] } {
  const from = sourceVersion(root);
  const to = nextVersion(from, level);
  const updates = pinFiles(root).map((p) => {
    const text = readFile(root, p.file);
    if (text === null) throw new Error(`${p.file} is missing`);
    try {
      return { file: p.file, text: writePin(text, p.kind, to) };
    } catch (err) {
      throw new Error(`${p.file}: ${(err as Error).message}`);
    }
  });
  for (const u of updates) writeFileSync(join(root, u.file), u.text);
  return { from, to, files: updates.map((u) => u.file) };
}
