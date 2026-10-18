#!/usr/bin/env bun
// bun tools/draft-contract.ts <shape.json> [--name <op>] [--out <file.ts>]
// Prints {"operation", "file", "source"}: a draft src/operations/<name>.ts with a
// Zod response schema covering every captured field. The same Operation captured
// for other Tasks of the skill (captures/*/) is merged in, so a field seen as a
// string in one Capture and null in another drafts as nullable. The explore Capture
// (captures/explore/) never is: once fix re-captures a Task, its shapes are old.
// With --out, writes it there (never over an existing file) instead of printing the source.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseFlags } from "./lib/args";
import { draftOperation, operationFileName } from "./lib/draft";
import { fail, runTool } from "./lib/output";
import { mergeOperation, type OperationShape } from "./lib/recorder";
import { parseJson } from "./lib/shape";

const USAGE = "bun tools/draft-contract.ts <shape.json> [--name <op>] [--out <file.ts>]";

/** A Capture shape file, or null for anything else: unreadable (a directory, no access), no JSON, or another shape. */
function parseShape(path: string): OperationShape | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseJson(text);
  const shape = parsed.ok ? (parsed.value as any) : null;
  if (!shape || typeof shape.operation !== "string" || !Array.isArray(shape.responses) || !shape.request) return null;
  return shape as OperationShape;
}

function readShape(path: string): OperationShape {
  if (!existsSync(path)) fail(`no such shape file: ${path}`);
  const shape = parseShape(path);
  if (!shape) fail(`not a Capture shape file: ${path}`);
  return shape;
}

/**
 * The same Operation (name, kind, host) in the skill's other Captures: captures/<task>/*.shape.json.
 * Never captures/explore/: each Task chosen from it has its own copy, which fix keeps current.
 */
function sameOperationElsewhere(path: string, shape: OperationShape): { files: string[]; shapes: OperationShape[] } {
  const taskDir = dirname(path);
  const captures = dirname(taskDir);
  if (basename(captures) !== "captures") return { files: [], shapes: [] };
  const files: string[] = [];
  const shapes: OperationShape[] = [];
  for (const task of readdirSync(captures, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const dir = join(captures, task);
    if (dir === taskDir || task === "explore") continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".shape.json")).sort()) {
      const other = parseShape(join(dir, f));
      if (other && other.operation === shape.operation && other.kind === shape.kind && other.host === shape.host) {
        files.push(`captures/${task}/${f}`);
        shapes.push(other);
      }
    }
  }
  return { files, shapes };
}

await runTool(async () => {
  const { values, positionals } = parseFlags(
    process.argv.slice(2),
    {
      name: {
        type: "string",
        help: "GraphQL only: the Contract's name when the Capture has none (an anonymous or persisted query). A REST name stays `METHOD /path`",
      },
      out: {
        type: "string",
        help: "write the draft to this file (refuses to overwrite) instead of printing it; name a REST file verb + noun (getInvoice.ts)",
      },
    },
    USAGE,
    1,
    ["The one positional argument is a shape file: <skill>/captures/<task>/<operation>.shape.json."],
  );
  if (positionals.length !== 1) fail(`expected one shape file\nusage: ${USAGE}`);
  const path = resolve(positionals[0] as string);
  let shape = readShape(path);
  if (values.name !== undefined && shape.kind === "rest") {
    fail(
      `--name is for GraphQL only: a REST Operation's name is "${shape.operation}" (the Fingerprint, check --op and needs.from use it). ` +
        `Choose the file with --out instead, e.g. --out <skill>/cli/src/operations/${operationFileName(shape.operation)}.ts`,
    );
  }
  const elsewhere = sameOperationElsewhere(path, shape);
  for (const other of elsewhere.shapes) shape = mergeOperation(shape, other);
  const capture = path.match(/(?:^|[\\/])(captures[\\/].+)$/)?.[1]?.replace(/\\/g, "/");
  const from = capture && elsewhere.files.length ? [capture, ...elsewhere.files].join(" + ") : capture;
  const { name, source } = draftOperation(shape, { name: values.name, from });
  const merged = elsewhere.files.length ? { mergedFrom: elsewhere.files } : {};
  if (values.out) {
    const out = resolve(values.out);
    if (existsSync(out)) fail(`refusing to overwrite ${out}`);
    writeFileSync(out, source);
    return { operation: name, file: out, written: out, ...merged };
  }
  return { operation: name, file: `src/operations/${operationFileName(name)}.ts`, ...merged, source };
});
