// bun run bump <patch|minor|major> [--root <dir>]
// Rewrites every copy of the plugin version: the four manifests, the version comment in every
// skills/*/SKILL.md, and every skills/*/cli/package.json and skills/*/cli/src/site.ts.
// Prints {"from", "to", "files"} as JSON. Nobody edits version numbers by hand.
import { join } from "node:path";
import { bump, LEVELS, type Level } from "./versions";

export function main(argv: string[]): number {
  const level = argv[0] as Level;
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag >= 0 ? argv[rootFlag + 1] : join(import.meta.dir, "..");
  if (!LEVELS.includes(level) || !root) {
    console.error(`usage: bun run bump <${LEVELS.join("|")}> [--root <dir>]`);
    return 2;
  }
  try {
    console.log(JSON.stringify(bump(root, level)));
    return 0;
  } catch (err) {
    console.error(`bump: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
