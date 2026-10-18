import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail } from "./output";

/** The four manifests of a generated plugin, relative to its root. */
export const MANIFESTS = {
  claude: ".claude-plugin/plugin.json",
  cursor: ".cursor-plugin/plugin.json",
  codex: ".codex-plugin/plugin.json",
  copilot: ".github/plugin/plugin.json",
} as const;

/**
 * The plugin repo is its own marketplace, named after the plugin, listing the plugin at "./",
 * so `/plugin marketplace add <owner/name>` then `/plugin install <plugin>@<plugin>` work.
 * Codex reads a repo marketplace from .agents/plugins/marketplace.json.
 */
export const MARKETPLACES = {
  claude: ".claude-plugin/marketplace.json",
  cursor: ".cursor-plugin/marketplace.json",
  copilot: ".github/plugin/marketplace.json",
  codex: ".agents/plugins/marketplace.json",
} as const;

export const INITIAL_VERSION = "0.1.0";

export type PluginInfo = {
  plugin: string;
  repo: string;
  description: string;
  maintainer: string;
  /** The plugin's folder in its repo: "." (its own repo) or plugins/<plugin> (a shared repo). */
  pluginDir?: string;
};

type Manifest = Record<string, unknown> & { skills?: string | string[] };

/**
 * Same fields in all four. Codex discovers skills from a folder; the others
 * list them. Copilot has no homepage.
 */
export function buildManifests(info: PluginInfo): Record<keyof typeof MANIFESTS, Manifest> {
  const url = `https://github.com/${info.repo}`;
  const inFolder = info.pluginDir && info.pluginDir !== ".";
  const base = {
    name: info.plugin,
    description: info.description,
    version: INITIAL_VERSION,
    author: { name: info.maintainer },
    homepage: inFolder ? `${url}/tree/main/${info.pluginDir}` : url,
    repository: url,
    keywords: [info.plugin],
  };
  const skills = [`./skills/${info.plugin}-deploy`, `./skills/${info.plugin}-feedback`];
  const { homepage: _homepage, ...withoutHomepage } = base;
  return {
    claude: { ...base, skills },
    cursor: { ...base, skills },
    codex: { ...base, skills: "./skills/" },
    copilot: { ...withoutHomepage, skills },
  };
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T = Record<string, unknown>>(path: string): T {
  if (!existsSync(path)) fail(`missing ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    fail(`not valid JSON: ${path}`);
  }
}

/** Adds `./skills/<skill>` to every manifest that lists its skills explicitly. Returns the files changed. */
export function addSkillToManifests(pluginDir: string, skill: string): string[] {
  const entry = `./skills/${skill}`;
  const changed: string[] = [];
  for (const rel of Object.values(MANIFESTS)) {
    const path = join(pluginDir, rel);
    if (!existsSync(path)) continue;
    const manifest = readJson<Manifest>(path);
    if (!Array.isArray(manifest.skills) || manifest.skills.includes(entry)) continue;
    manifest.skills = [...manifest.skills, entry].sort();
    writeJson(path, manifest);
    changed.push(rel);
  }
  return changed;
}

/** A plugin's entry in a shared repo's marketplace file (`new --into`), in that file's format. */
export function marketplaceEntry(kind: keyof typeof MARKETPLACES, info: PluginInfo & { pluginDir: string }): Record<string, unknown> {
  const path = `./${info.pluginDir}`;
  if (kind === "codex") {
    return {
      name: info.plugin,
      source: { source: "local", path },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    };
  }
  return { name: info.plugin, source: path, description: info.description };
}

/**
 * Appends `entry` to the top-level `plugins` array of a marketplace file's text, keeping the rest
 * of the text byte for byte (a maintainer's hand formatting, other plugins' entries). Falls back
 * to a 2-space rewrite only if the array cannot be found that way.
 */
export function appendPluginEntry(text: string, entry: Record<string, unknown>): string {
  const parsed = JSON.parse(text) as { plugins?: unknown[] };
  const expected = [...(parsed.plugins ?? []), entry];
  // Find `"plugins": [` at depth 1 and its closing bracket, skipping strings.
  let depth = 0;
  let open = -1;
  let close = -1;
  let lastKey = "";
  for (let i = 0; i < text.length && close < 0; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      lastKey = text.slice(i + 1, j);
      i = j;
    } else if (c === "{" || c === "[") {
      depth++;
      if (c === "[" && depth === 2 && lastKey === "plugins" && open < 0) open = i;
    } else if (c === "}" || c === "]") {
      if (c === "]" && depth === 2 && open >= 0) close = i;
      depth--;
    }
  }
  const rewrite = () => `${JSON.stringify({ ...parsed, plugins: expected }, null, 2)}\n`;
  if (open < 0 || close < 0) return rewrite();
  const lineIndent = (at: number) => /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", at) + 1))![0];
  const inner = text.slice(open + 1, close);
  const firstElement = inner.search(/\S/);
  const indent = firstElement >= 0 ? lineIndent(open + 1 + firstElement) : `${lineIndent(open)}  `;
  const block = JSON.stringify(entry, null, 2).replace(/^/gm, indent);
  const out =
    firstElement >= 0
      ? `${text.slice(0, open + 1 + inner.trimEnd().length)},\n${block}${text.slice(open + 1 + inner.trimEnd().length)}`
      : `${text.slice(0, open + 1)}\n${block}\n${lineIndent(open)}${text.slice(close)}`;
  try {
    if (JSON.stringify((JSON.parse(out) as { plugins: unknown[] }).plugins) === JSON.stringify(expected)) return out;
  } catch {
    // fall through to the rewrite
  }
  return rewrite();
}

/**
 * Same shape as hoaj/site-cli-creator' own marketplaces, with the plugin at "./". No version: the bump
 * script and version-sync test own every version pin, and a marketplace needs none.
 */
export function buildMarketplaces(info: PluginInfo): Record<keyof typeof MARKETPLACES, Record<string, unknown>> {
  const listing = {
    name: info.plugin,
    owner: { name: info.maintainer },
    metadata: { description: info.description },
    plugins: [{ name: info.plugin, source: "./", description: info.description }],
  };
  return {
    claude: listing,
    cursor: listing,
    copilot: listing,
    codex: {
      name: info.plugin,
      interface: { displayName: info.plugin },
      plugins: [
        {
          name: info.plugin,
          source: { source: "local", path: "./" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    },
  };
}
