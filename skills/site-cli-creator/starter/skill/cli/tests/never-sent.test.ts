// This CLI's own Contracts and code never send a request site.ts's `never` list forbids, so a PR that
// adds one fails CI (SPEC §6). The runtime refuses such a request too; this catches it before release.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { operations } from "../src/registry";
import { neverInSource, neverProblems, stripNeverList } from "../src/runtime/never";
import site from "../src/site";

const CLI = join(import.meta.dir, "..");

/**
 * Every .ts file under the folders that hold this CLI's Contracts, commands and shared code, and
 * site.ts (its hooks send requests too) without the never list itself.
 */
function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (name.endsWith(".ts")) out.push({ path: relative(CLI, file).replace(/\\/g, "/"), text: readFileSync(file, "utf8") });
    }
  };
  for (const dir of ["operations", "commands", "lib"]) walk(join(CLI, "src", dir));
  out.push({ path: "src/site.ts", text: stripNeverList(readFileSync(join(CLI, "src", "site.ts"), "utf8")) });
  return out;
}

test("no Operation in the registry is a request site.never forbids", () => {
  expect(neverProblems(site, operations)).toEqual([]);
});

test("no Contract, command, shared code or site.ts hook names a request site.never forbids", () => {
  expect(neverInSource(site, sources())).toEqual([]);
});
