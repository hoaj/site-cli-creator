#!/usr/bin/env bun
// bun tools/regen.ts --skill-dir <dir>
// Rewrites cli/src/registry.ts, sets needsChrome in site.ts, and rewrites the
// SKILL.md command table from the CLI's own `help` (SPEC §3 step 5).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags } from "./lib/args";
import { fail, progress, runTool } from "./lib/output";
import {
  cliPaths,
  commandsTable,
  helpCommands,
  moduleFiles,
  neverCheckedWarning,
  registrySource,
  replaceCommandsBlock,
  setNeedsChrome,
  unsuppliedVariables,
} from "./lib/regen";
import { parseJson } from "./lib/shape";

const USAGE = "bun tools/regen.ts --skill-dir <dir>";

async function defaultExport(file: string): Promise<Record<string, unknown>> {
  let mod: { default?: unknown };
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (error) {
    fail(`could not import ${file}: ${(error as Error).message} (run bun install in the skill's cli/ first?)`);
  }
  if (typeof mod.default !== "object" || mod.default === null) fail(`${file} has no default export`);
  return mod.default as Record<string, unknown>;
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
  const operationFiles = moduleFiles(paths.operations);
  const commandFiles = moduleFiles(paths.commands);
  writeFileSync(paths.registry, registrySource(operationFiles, commandFiles));
  progress(`registry.ts: ${operationFiles.length} operations, ${commandFiles.length} commands`);

  const site = await defaultExport(paths.site);
  if (site.auth !== "login" && site.auth !== "none") fail(`site.ts auth must be "login" or "none"`);
  const operations: { name: string; effect: string }[] = [];
  const warnings: string[] = [];
  for (const file of operationFiles) {
    const op = await defaultExport(join(paths.operations, file));
    if (op.effect !== "read" && op.effect !== "write") fail(`operations/${file}: effect must be "read" or "write"`);
    operations.push({ name: String(op.name), effect: op.effect });
    const unsupplied = op.effect === "read" ? unsuppliedVariables(op) : [];
    if (unsupplied.length) warnings.push(neverCheckedWarning(String(op.name), unsupplied));
  }
  for (const w of warnings) progress(`warning: ${w}`);
  const needsChrome = site.auth === "login" || operations.some((o) => o.effect === "write");
  writeFileSync(paths.site, setNeedsChrome(readFileSync(paths.site, "utf8"), needsChrome));

  const commands = helpCommands(runHelp(paths.cli, paths.main));
  const skill = typeof site.skill === "string" ? site.skill : basename(skillDir);
  const table = commandsTable(skill, commands);
  writeFileSync(paths.skillMd, replaceCommandsBlock(readFileSync(paths.skillMd, "utf8"), table));

  return {
    skillDir,
    registry: paths.registry,
    operations,
    commands: commands.map((c) => ({ name: c.name, write: c.write })),
    needsChrome,
    skillMd: paths.skillMd,
    ...(warnings.length ? { warnings } : {}),
  };
});
