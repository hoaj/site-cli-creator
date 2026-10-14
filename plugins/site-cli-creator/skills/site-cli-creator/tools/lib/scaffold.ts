import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./manifests";
import { fail } from "./output";

/** The version comment every SKILL.md carries below its frontmatter (SPEC §8). */
const VERSION_COMMENT = /<!--\s*version:\s*[^\s]+?\s*-->/;

export function setSkillMdVersion(path: string, version: string): void {
  const text = readFileSync(path, "utf8");
  const next = VERSION_COMMENT.test(text)
    ? text.replace(VERSION_COMMENT, `<!-- version: ${version} -->`)
    : text.replace(/^(---\n[\s\S]*?\n---\n)/, `$1<!-- version: ${version} -->\n`);
  if (!VERSION_COMMENT.test(next)) fail(`${path} has no frontmatter to put the version comment under`);
  writeFileSync(path, next);
}

export function setPackageVersion(path: string, version: string): void {
  writeJson(path, { ...readJson<Record<string, unknown>>(path), version });
}

/** Sets `version: "…"` in site.ts (a version pin like the others). */
export function setSiteVersion(path: string, version: string): void {
  const text = readFileSync(path, "utf8");
  const pattern = /(\bversion:\s*)(["'])[^"']*\2/;
  if (!pattern.test(text)) fail(`${path} has no version field`);
  writeFileSync(path, text.replace(pattern, `$1"${version}"`));
}

/** A directory new may write into: missing, empty, or holding only a fresh clone's .git. */
export function assertWritableDir(dir: string): void {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) fail(`${dir} exists and is not a directory`);
  const entries = readdirSync(dir).filter((e) => e !== ".git");
  if (entries.length > 0) fail(`refusing to write into non-empty ${dir} (found ${entries.slice(0, 5).join(", ")})`);
}

export function requireDir(path: string, what: string): string {
  if (!existsSync(path) || !statSync(path).isDirectory()) fail(`${what} not found at ${path}`);
  return path;
}


/** `https://github.com/owner/name(.git)` or `owner/name` → `owner/name`. */
export function repoFromManifest(repository: unknown): string {
  const raw = typeof repository === "object" && repository !== null ? (repository as { url?: unknown }).url : repository;
  if (typeof raw !== "string") fail(`.claude-plugin/plugin.json has no repository`);
  const m = raw.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (!m) fail(`.claude-plugin/plugin.json repository is not a GitHub repo: ${raw}`);
  return m[1] as string;
}

/** An http(s) URL's origin; `flag` names the flag in the error. */
export function parseOrigin(raw: string, flag = "origin"): string {
  return parseHttpUrl(raw, flag).origin;
}

export function parseHttpUrl(raw: string, flag: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`--${flag} must be a URL like https://www.example.com, got "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") fail(`--${flag} must be http(s), got "${raw}"`);
  return url;
}
