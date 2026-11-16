#!/usr/bin/env bun
// bun tools/regen.ts --skill-dir <dir>
// Rewrites cli/src/registry.ts, sets needsChrome in site.ts, and rewrites the
// SKILL.md command table from the CLI's own `help` (SPEC §3 step 5) and its
// site.never list under "When NOT to use". Only commands/ files that
// default-export a command are registered. A Contract whose request site.never
// forbids is refused before anything is written (SPEC §6).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags } from "./lib/args";
import { fail, progress, runTool } from "./lib/output";
import {
  cliPaths,
  commandFileName,
  commandsTable,
  helpCommands,
  isCommandExport,
  moduleFiles,
  registrySource,
  replaceCommandsBlock,
  replaceNeverBlock,
  setNeedsChrome,
  SHARED_CODE_HOME,
} from "./lib/regen";
import { listsWithoutContainer, noContainerWarning } from "../starter/skill/cli/src/runtime/html";
import { neverCheckable, neverCheckedWarning } from "../starter/skill/cli/src/runtime/needs";
import { neverList, neverListProblems, neverProblems } from "../starter/skill/cli/src/runtime/never";
import type { Operation } from "../starter/skill/cli/src/runtime/operation";
import type { Site } from "../starter/skill/cli/src/runtime/site";
import { parseJson } from "./lib/shape";

const USAGE = "bun tools/regen.ts --skill-dir <dir>";

/** A module's default export, whatever it is; a module that does not import is a JSON error. */
async function importDefault(file: string): Promise<unknown> {
  try {
    return ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
  } catch (error) {
    fail(`could not import ${file}: ${(error as Error).message} (run bun install in the skill's cli/ first?)`);
  }
}

async function defaultExport(file: string): Promise<Record<string, unknown>> {
  const value = await importDefault(file);
  if (typeof value !== "object" || value === null) fail(`${file} has no default export`);
  return value as Record<string, unknown>;
}

/**
 * The files in commands/ that are commands: a command (defineCommand) as default export, whatever
 * the file's name (a 0.1.0 plugin's `status.ts` stays registered; a name that does not match the
 * command is a warning). Any other file (a shared helper) is left out of registry.ts with a
 * warning, so it never becomes a command.
 */
async function commandModules(dir: string, files: string[], warnings: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const file of files) {
    const command = await importDefault(join(dir, file));
    if (!isCommandExport(command)) {
      warnings.push(`commands/${file} is not registered: its default export is no command (defineCommand). ${SHARED_CODE_HOME}`);
      continue;
    }
    kept.push(file);
    const { name } = command as { name: string };
    const expected = commandFileName(name);
    if (file !== expected) warnings.push(`commands/${file} holds the command "${name}": name the file ${expected} (it is registered as it is).`);
  }
  return kept;
}

function runHelp(cli: string, main: string): unknown {
  const home = mkdtempSync(join(tmpdir(), "regen-home-"));
  try {
    const proc = Bun.spawnSync([process.execPath, main, "help"], {
      cwd: cli,
      env: { ...process.env, SITE_CLI_TEST: "1", SITE_CLI_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    const parsed = parseJson(out);
    if (!proc.success || !parsed.ok) {
      const detail = (proc.stderr.toString().trim() || out.trim()).split("\n").slice(-15).join("\n");
      fail(`\`bun src/main.ts help\` failed (exit ${proc.exitCode}):\n${detail}`);
    }
    return parsed.value;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

await runTool(async () => {
  const { values } = parseFlags(
    process.argv.slice(2),
    { "skill-dir": { type: "string", required: true, help: "the CLI skill's folder (<plugin>/skills/<skill>)" } },
    USAGE,
  );
  const skillDir = resolve(values["skill-dir"]);
  const paths = cliPaths(skillDir);
  for (const required of [paths.site, paths.main, paths.skillMd]) {
    if (!existsSync(required)) fail(`not a CLI skill: missing ${required}`);
  }
  const warnings: string[] = [];
  const operationFiles = moduleFiles(paths.operations);
  const commandFiles = await commandModules(paths.commands, moduleFiles(paths.commands), warnings);

  const site = await defaultExport(paths.site);
  if (site.auth !== "login" && site.auth !== "none") fail(`site.ts auth must be "login" or "none"`);
  // The never list is the generator's rule as well as the runtime's: a malformed one stops regen.
  const neverBad = neverListProblems(site.never);
  if (neverBad.length) fail(`site.ts: ${neverBad.join("; ")}`);
  const operations: { name: string; effect: string }[] = [];
  const forbidden: string[] = [];
  for (const file of operationFiles) {
    const op = await defaultExport(join(paths.operations, file));
    if (op.effect !== "read" && op.effect !== "write") fail(`operations/${file}: effect must be "read" or "write"`);
    operations.push({ name: String(op.name), effect: op.effect });
    for (const problem of neverProblems(site as unknown as Site, [op as unknown as Operation])) forbidden.push(`operations/${file}: ${problem}`);
    // The same rule and text as the Starter's `check` (runtime/needs.ts).
    const never = op.effect === "read" ? neverCheckable(op) : undefined;
    if (never) warnings.push(neverCheckedWarning(String(op.name), never));
    const html = (op as { html?: { fields?: unknown } }).html;
    if (html?.fields && typeof html.fields === "object") {
      for (const path of listsWithoutContainer(html.fields as Parameters<typeof listsWithoutContainer>[0])) warnings.push(noContainerWarning(String(op.name), path));
    }
  }
  if (forbidden.length) {
    fail(
      `site.ts's never list forbids these Operations: ${forbidden.join("; ")}. Delete each such Operation and the commands that use it (the CLI never sends these requests), then run regen again. Nothing was written.`,
    );
  }
  writeFileSync(paths.registry, registrySource(operationFiles, commandFiles));
  progress(`registry.ts: ${operationFiles.length} operations, ${commandFiles.length} commands`);
  const never = neverList(site as unknown as Site);
  const skillMd = readFileSync(paths.skillMd, "utf8");
  const withNever = replaceNeverBlock(skillMd, never);
  if (withNever === undefined && never.length > 0) {
    warnings.push(
      "SKILL.md has no <!-- never:start --> and <!-- never:end --> markers, so site.never is not listed under ## When NOT to use: add the two lines at the end of that section and run regen again.",
    );
  }
  for (const w of warnings) progress(`warning: ${w}`);
  const needsChrome = site.auth === "login" || site.transport === "browser" || operations.some((o) => o.effect === "write");
  writeFileSync(paths.site, setNeedsChrome(readFileSync(paths.site, "utf8"), needsChrome));

  const commands = helpCommands(runHelp(paths.cli, paths.main));
  const skill = typeof site.skill === "string" ? site.skill : basename(skillDir);
  const table = commandsTable(skill, commands);
  writeFileSync(paths.skillMd, replaceCommandsBlock(withNever ?? skillMd, table));

  return {
    skillDir,
    registry: paths.registry,
    operations,
    commands: commands.map((c) => ({ name: c.name, write: c.write })),
    needsChrome,
    ...(never.length ? { never: never.map((n) => n.request) } : {}),
    skillMd: paths.skillMd,
    ...(warnings.length ? { warnings } : {}),
  };
});
