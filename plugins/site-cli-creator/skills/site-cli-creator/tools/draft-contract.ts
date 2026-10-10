#!/usr/bin/env bun
// bun tools/draft-contract.ts <shape.json> [--name <op>] [--out <file.ts>]
// Prints {"operation", "file", "source"}: a draft src/operations/<name>.ts with a
// Zod response schema covering every captured field. With --out, writes it there
// (never over an existing file) instead of printing the source.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFlags } from "./lib/args";
import { draftOperation, operationFileName } from "./lib/draft";
import { fail, runTool } from "./lib/output";
import type { OperationShape } from "./lib/recorder";

const USAGE = "bun tools/draft-contract.ts <shape.json> [--name <op>] [--out <file.ts>]";

function readShape(path: string): OperationShape {
  if (!existsSync(path)) fail(`no such shape file: ${path}`);
  let shape: OperationShape;
  try {
    shape = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`not JSON: ${path}`);
  }
  if (!shape || typeof shape.operation !== "string" || !Array.isArray(shape.responses) || !shape.request) {
    fail(`not a Capture shape file: ${path}`);
  }
  return shape;
}

await runTool(async () => {
  const { values, positionals } = parseFlags(
    process.argv.slice(2),
    { name: { type: "string" }, out: { type: "string" } },
    USAGE,
    1,
  );
  if (positionals.length !== 1) fail(`expected one shape file\nusage: ${USAGE}`);
  const path = resolve(positionals[0] as string);
  const shape = readShape(path);
  const from = path.match(/(?:^|[\\/])(captures[\\/].+)$/)?.[1]?.replace(/\\/g, "/");
  const { name, source } = draftOperation(shape, { name: values.name, from });
  const file = `src/operations/${operationFileName(name)}.ts`;
  if (values.out) {
    const out = resolve(values.out);
    if (existsSync(out)) fail(`refusing to overwrite ${out}`);
    writeFileSync(out, source);
    return { operation: name, file, written: out };
  }
  return { operation: name, file, source };
});
