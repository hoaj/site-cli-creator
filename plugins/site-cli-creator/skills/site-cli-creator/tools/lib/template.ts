import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fail } from "./output";

/** The placeholders of ARCHITECTURE §2, without the surrounding underscores. */
export const TOKEN_NAMES = [
  "PLUGIN",
  "SKILL",
  "REPO",
  "OWNER",
  "DESCRIPTION",
  "MAINTAINER",
  "GENERATOR_VERSION",
  "ORIGIN",
  "AUTH",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type Tokens = Partial<Record<TokenName, string>>;

const SKIPPED = new Set(["node_modules", ".DS_Store", "bin"]);

const TOKEN_PATTERN = new RegExp(`__(${TOKEN_NAMES.join("|")})__`, "g");

export function fillTokens(text: string, tokens: Tokens): string {
  return text.replace(TOKEN_PATTERN, (match, name: TokenName) => tokens[name] ?? match);
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function walk(dir: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.isFile()) visit(path);
  }
}

/**
 * Copies every file under `src` into `dest`, replacing tokens in text contents
 * and in path names, and keeping file modes (install.sh stays executable).
 * Never overwrites an existing file. Returns the written paths relative to `dest`.
 */
export function copyTemplate(src: string, dest: string, tokens: Tokens): string[] {
  const written: string[] = [];
  walk(src, (file) => {
    const rel = fillTokens(relative(src, file), tokens);
    const target = join(dest, rel);
    const raw = readFileSync(file);
    const content = isBinary(raw) ? raw : fillTokens(raw.toString("utf8"), tokens);
    mkdirSync(join(target, ".."), { recursive: true });
    try {
      writeFileSync(target, content, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail(`refusing to overwrite ${target}`);
      throw error;
    }
    chmodSync(target, statSync(file).mode & 0o777);
    written.push(rel);
  });
  return written.sort();
}

/** Lists every known placeholder still present in a tree (contents or paths). */
export function findTokens(dir: string): { file: string; token: string }[] {
  const found: { file: string; token: string }[] = [];
  walk(dir, (file) => {
    const rel = relative(dir, file);
    const raw = readFileSync(file);
    const text = isBinary(raw) ? "" : raw.toString("utf8");
    for (const m of `${rel}\n${text}`.matchAll(TOKEN_PATTERN)) found.push({ file: rel, token: m[0] });
  });
  return found;
}

export function assertNoTokens(dir: string): void {
  const left = findTokens(dir);
  if (left.length) {
    const list = [...new Set(left.map((l) => `${l.file} (${l.token})`))].join(", ");
    fail(`placeholders left after copying the Starter code: ${list}`);
  }
}
