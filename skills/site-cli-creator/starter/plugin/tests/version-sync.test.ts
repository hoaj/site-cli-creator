// Every copy of the plugin version must equal .claude-plugin/plugin.json's. Fix a failure with
// `bun run bump <patch|minor|major>`, never by hand.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mismatches } from "../scripts/versions";

const root = join(import.meta.dir, "..");
const name = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string }).name;
// In the generator's starter/ folder there are no manifests yet; tests/bump.test.ts covers the
// logic there. The token is split so scaffolding does not replace it.
const isStarter = name.includes("__" + "PLUGIN" + "__");

test.skipIf(isStarter)("every version pin equals .claude-plugin/plugin.json", () => {
  expect(mismatches(root)).toEqual([]);
});
