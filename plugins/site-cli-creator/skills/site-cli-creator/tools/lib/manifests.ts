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
};

type Manifest = Record<string, unknown> & { skills?: string | string[] };

/**
 * Same fields in all four. Codex discovers skills from a folder; the others
 * list them. Copilot has no homepage.
 */
export function buildManifests(info: PluginInfo): Record<keyof typeof MANIFESTS, Manifest> {
  const url = `https://github.com/${info.repo}`;
  const base = {
    name: info.plugin,
    description: info.description,
    version: INITIAL_VERSION,
    author: { name: info.maintainer },
    homepage: url,
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

/**
 * Same shape as hoaj/skills' own marketplaces, with the plugin at "./". No version: the bump
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
