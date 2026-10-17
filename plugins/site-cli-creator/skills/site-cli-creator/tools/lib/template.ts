import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fail } from "./output";

/** The placeholders of ARCHITECTURE §2, without the surrounding underscores. */
const TOKEN_NAMES = [
  "PLUGIN",
  "SKILL",
  "REPO",
  "OWNER",
  "DESCRIPTION",
  "MAINTAINER",
  "GENERATOR_VERSION",
  "ORIGIN",
  "AUTH",
  "PREFIX",
  "PLUGIN_DIR",
  "MARKETPLACE",
] as const;
type TokenName = (typeof TOKEN_NAMES)[number];
export type Tokens = Partial<Record<TokenName, string>>;

/**
 * Where a plugin lives: `standalone`, the root of its own repo (its own marketplace, tags vX.Y.Z),
 * or `shared`, a folder plugins/<plugin> of a repo that holds other plugins and one marketplace
 * (tags <plugin>-vX.Y.Z, workflows <plugin>-*.yml at the repo root). ARCHITECTURE §2.
 */
export type Layout = "standalone" | "shared";

/** The values of the layout tokens: tag and workflow prefix, and the plugin's folder in its repo. */
export function layoutTokens(layout: Layout, plugin: string): Pick<Required<Tokens>, "PREFIX" | "PLUGIN_DIR"> {
  return layout === "shared" ? { PREFIX: `${plugin}-`, PLUGIN_DIR: `plugins/${plugin}` } : { PREFIX: "", PLUGIN_DIR: "." };
}

const SKIPPED = new Set(["node_modules", ".DS_Store", "bin"]);

const TOKEN_PATTERN = new RegExp(`__(${TOKEN_NAMES.join("|")})__`, "g");

/**
 * A layout line: `#@shared <text>` or `#@standalone <text>` (after any indentation). It becomes
 * `<text>`, at the marker's indentation, in that layout, and disappears in the other. As a comment
 * in YAML and bash, the Starter file stays valid in place.
 */
const LAYOUT_LINE = /^([ \t]*)#@(shared|standalone)(?: (.*))?\n/gm;
const LAYOUT_MARKER = /^[ \t]*#@(?:shared|standalone)\b/m;

export function applyLayout(text: string, layout: Layout): string {
  return text.replace(LAYOUT_LINE, (_line, indent: string, which: string, rest?: string) =>
    which === layout ? `${rest ? indent + rest : ""}\n` : "",
  );
}

export function fillTokens(text: string, tokens: Tokens): string {
  return text.replace(TOKEN_PATTERN, (match, name: TokenName) => tokens[name] ?? match);
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function walk(dir: string, visit: (path: string) => void, root = dir, skip?: (rel: string) => boolean): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    // `skip` always sees "/" separators, on Windows too (".github/workflows", not ".github\\workflows").
    if (skip?.(relative(root, path).split(sep).join("/"))) continue;
    if (entry.isDirectory()) walk(path, visit, root, skip);
    else if (entry.isFile()) visit(path);
  }
}

/**
 * Copies every file under `src` into `dest`, keeping the lines of `layout` (default standalone),
 * replacing tokens in text contents and in path names, and keeping file modes (install.sh stays
 * executable). `skip` leaves out a path relative to `src`, written with "/" on every OS (a folder
 * skips all below it).
 * Never overwrites an existing file. Returns the written paths relative to `dest`.
 */
export function copyTemplate(
  src: string,
  dest: string,
  tokens: Tokens,
  opts: { layout?: Layout; skip?: (rel: string) => boolean } = {},
): string[] {
  const written: string[] = [];
  walk(
    src,
    (file) => {
      const rel = fillTokens(relative(src, file), tokens);
      const target = join(dest, rel);
      const raw = readFileSync(file);
      const content = isBinary(raw) ? raw : fillTokens(applyLayout(raw.toString("utf8"), opts.layout ?? "standalone"), tokens);
      mkdirSync(join(target, ".."), { recursive: true });
      try {
        writeFileSync(target, content, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") fail(`refusing to overwrite ${target}`);
        throw error;
      }
      chmodSync(target, statSync(file).mode & 0o777);
      written.push(rel);
    },
    src,
    opts.skip,
  );
  return written.sort();
}

/** Lists every known placeholder and layout marker still present in a tree (contents or paths). */
export function findTokens(dir: string): { file: string; token: string }[] {
  const found: { file: string; token: string }[] = [];
  walk(dir, (file) => {
    const rel = relative(dir, file);
    const raw = readFileSync(file);
    const text = isBinary(raw) ? "" : raw.toString("utf8");
    for (const m of `${rel}\n${text}`.matchAll(TOKEN_PATTERN)) found.push({ file: rel, token: m[0] });
    const marker = LAYOUT_MARKER.exec(text);
    if (marker) found.push({ file: rel, token: marker[0].trim() });
  });
  return found;
}

/** Fails on any placeholder or layout marker left in `dir`, or, with `only`, in those paths relative to it. */
export function assertNoTokens(dir: string, only?: string[]): void {
  const left = findTokens(dir).filter((t) => !only || only.includes(t.file));
  if (left.length) {
    const list = [...new Set(left.map((l) => `${l.file} (${l.token})`))].join(", ");
    fail(`placeholders left after copying the Starter code: ${list}`);
  }
}
