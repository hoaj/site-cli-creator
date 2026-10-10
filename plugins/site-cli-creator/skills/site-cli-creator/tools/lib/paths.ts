import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** skills/site-cli-creator/ */
export const SKILL_ROOT = resolve(import.meta.dir, "../..");
/** plugins/site-cli-creator/ */
export const GENERATOR_ROOT = resolve(SKILL_ROOT, "../..");

/** The Starter code. Tests point STARTER_DIR at a fake starter. */
export function starterDir(): string {
  return process.env.STARTER_DIR ? resolve(process.env.STARTER_DIR) : join(SKILL_ROOT, "starter");
}

/** site-cli-creator's own version, recorded in generated plugins as info only. */
export function generatorVersion(): string {
  const manifest = join(GENERATOR_ROOT, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) return "0.0.0";
  try {
    const version = JSON.parse(readFileSync(manifest, "utf8")).version;
    return typeof version === "string" && version ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
