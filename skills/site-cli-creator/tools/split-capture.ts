#!/usr/bin/env bun
// bun tools/split-capture.ts --skill-dir <dir> --task <slug> --op <operation>... [--start-path <path>]
// Copies the Operations one chosen Task needs out of the explore Capture
// (<skill>/captures/explore/, made by capture.ts --explore) into the Task's own
// Capture, <skill>/captures/<task>/, with an index.json like capture.ts writes.
// Each Task then has its own Capture, which fix re-captures with capture.ts.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFlags, requireKebab } from "./lib/args";
import { writeJson } from "./lib/manifests";
import { fail, runTool } from "./lib/output";
import { toolCommand } from "./lib/paths";

const USAGE = "bun tools/split-capture.ts --skill-dir <dir> --task <slug> --op <operation> [--op <operation>]... [--start-path <path>]";

const EXPLORE = "explore";

type Entry = {
  operation: string;
  effect: "read" | "write";
  file: string;
  host: string;
  pages?: string[];
  seen: number;
  aborted: number;
  effectUnknown?: true;
  loginFlow?: true;
  navigation?: true;
  serverAction?: true;
  rsc?: true;
};

type ExploreIndex = { startPath?: string; loginHosts?: string[]; operations: Entry[] };

function readExplore(skillDir: string): { dir: string; index: ExploreIndex } {
  const dir = join(skillDir, "captures", EXPLORE);
  const file = join(dir, "index.json");
  if (!existsSync(file)) {
    fail(`no explore Capture in ${dir}: make one first with ${toolCommand("capture")} --skill-dir ${skillDir} --explore --url <start>`);
  }
  let index: ExploreIndex;
  try {
    index = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file} is not JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(index?.operations)) fail(`${file} lists no operations`);
  return { dir, index };
}

/** The one entry `op` names: its Operation name, or its shape file when the name is on several hosts. */
function choose(entries: Entry[], op: string): Entry {
  const byFile = entries.find((e) => e.file === op);
  if (byFile) return byFile;
  const named = entries.filter((e) => e.operation === op);
  if (named.length === 1) return named[0] as Entry;
  if (named.length > 1) {
    fail(`${op} is recorded on ${named.length} hosts: pass --op with one of its files instead (${named.map((e) => e.file).join(", ")})`);
  }
  fail(`not in captures/${EXPLORE}/index.json: ${op}`);
}

/** Why `e` cannot be part of a Task's Capture, or undefined when it can. */
function refusal(e: Entry, task: string): string | undefined {
  const op = e.operation;
  if (e.loginFlow) return `${op} is a sign-in step (loginFlow): it belongs in site.ts, never in a Task's Capture`;
  if (e.navigation) return `${op} is a page load (navigation), not an Operation: the Task's start page is --start-path`;
  if (e.serverAction || e.rsc) return `${op} is a Next.js ${e.serverAction ? "server action" : "RSC stream"}: never an Operation (reference/add-task.md, Next.js sites)`;
  if (e.aborted >= e.seen) {
    if (e.effect === "write" && !e.effectUnknown) return `${op} was aborted (a write): capture its Task with capture.ts --task ${task} --write`;
    return `${op} never answered in the explore Capture (aborted): capture its Task with capture.ts --task ${task}, adding --allow-read ${op} once you are sure it only reads`;
  }
  return undefined;
}

/** The page that called the most chosen Operations (the first such page in call order), else the explore start page. */
function startPage(chosen: Entry[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const e of chosen) for (const page of e.pages ?? []) counts.set(page, (counts.get(page) ?? 0) + 1);
  let best: string | undefined;
  for (const [page, n] of counts) if (best === undefined || n > (counts.get(best) as number)) best = page;
  return best ?? fallback;
}

await runTool(async () => {
  const { values } = parseFlags(
    process.argv.slice(2),
    {
      "skill-dir": { type: "string", required: true, help: "the CLI skill's folder, holding captures/explore/ (capture.ts --explore)" },
      task: { type: "string", required: true, help: "the chosen Task's slug, kebab-case (bill-list); its Capture goes to <skill-dir>/captures/<task>/" },
      op: {
        type: "string",
        multiple: true,
        help: "an Operation the Task needs, as captures/explore/index.json names it (operation), or its shape file when the name is on several hosts: the Task's own Operations and the chain that supplies their variables",
      },
      "start-path": {
        type: "string",
        help: "the path of the page the Task starts from (/bills), as index.json's pages name it; default: the page that called the most chosen Operations",
      },
    },
    USAGE,
    0,
    [
      "Run once per chosen read Task. A write Task, and an Operation the explore Capture aborted, needs its own capture.ts --task <slug> Capture instead.",
      "The explore Capture stays as it was: draft-contract never merges it into a Task's draft.",
    ],
  );
  const skillDir = resolve(values["skill-dir"]);
  if (!existsSync(skillDir)) fail(`no such skill dir: ${skillDir}`);
  const task = requireKebab("task", values.task);
  if (task === EXPLORE) fail(`the slug "${EXPLORE}" is reserved for the explore Capture: name the Task (bill-list)`);
  const startOverride = values["start-path"];
  if (startOverride !== undefined && !startOverride.startsWith("/")) fail(`--start-path must start with / (a path, not a URL): got "${startOverride}"`);
  if (values.op.length === 0) fail(`missing --op: name each Operation the Task needs\nusage: ${USAGE}`);

  const explore = readExplore(skillDir);
  const picked = new Set(values.op.map((op) => choose(explore.index.operations, op)));
  for (const e of picked) {
    const why = refusal(e, task);
    if (why) fail(why);
  }
  // In the explore Capture's call order, as capture.ts lists them.
  const chosen = explore.index.operations.filter((e) => picked.has(e));

  const dir = join(skillDir, "captures", task);
  if (existsSync(join(dir, "index.json"))) {
    fail(`${dir} already holds a Capture of ${task}: pick another slug, or remove that folder if the explore Capture should replace it`);
  }
  for (const e of chosen) {
    if (!existsSync(join(explore.dir, e.file))) fail(`${e.file} is listed in captures/${EXPLORE}/index.json but missing: capture again with --explore`);
  }
  const startPath = startOverride ?? startPage(chosen, explore.index.startPath ?? "/");

  mkdirSync(dir, { recursive: true });
  for (const e of chosen) copyFileSync(join(explore.dir, e.file), join(dir, e.file));
  const index = {
    task,
    startPath,
    write: false,
    from: EXPLORE,
    ...(explore.index.loginHosts?.length ? { loginHosts: explore.index.loginHosts } : {}),
    operations: chosen,
  };
  writeJson(join(dir, "index.json"), index);
  return { task, dir, startPath, operations: chosen.map((e) => ({ operation: e.operation, file: e.file })) };
});
