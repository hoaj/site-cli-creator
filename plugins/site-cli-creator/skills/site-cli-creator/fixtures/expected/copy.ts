// Copies the expected agent-written code for one auth mode into a generated
// skill's cli/src/, filling the same placeholders add-skill fills.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loginOriginFor } from "../site/hosts";

export type ExpectedTokens = {
  plugin: string;
  skill: string;
  repo: string;
  generatorVersion: string;
  /** The fixture site's URL, e.g. startFixtureSite(...).url */
  origin: string;
};

export const EXPECTED_DIR = import.meta.dir;

/** Expected Fingerprint operation names, keyed by the operation file name. */
export const OPERATION_NAMES = {
  getAccount: "getAccount",
  listSubscriptions: "listSubscriptions",
  listInvoices: "GET /api/invoices",
  getInvoice: "GET /api/invoices/:id",
  addNote: "addNote",
} as const;

/** Fills the add-skill placeholders, plus the fixture's sign-in host, which is derived from `origin`. */
export function fillTokens(text: string, tokens: ExpectedTokens): string {
  const origin = tokens.origin.replace(/\/$/, "");
  const loginOrigin = text.includes("__LOGIN_") ? loginOriginFor(origin) : "";
  const filled = text
    .replaceAll("__PLUGIN__", tokens.plugin)
    .replaceAll("__SKILL__", tokens.skill)
    .replaceAll("__REPO__", tokens.repo)
    .replaceAll("__GENERATOR_VERSION__", tokens.generatorVersion)
    .replaceAll("__LOGIN_ORIGIN__", loginOrigin)
    .replaceAll("__LOGIN_HOST__", loginOrigin && new URL(loginOrigin).host)
    .replaceAll("__ORIGIN__", origin);
  const left = filled.match(/__[A-Z][A-Z_]*__/);
  if (left) throw new Error(`unfilled placeholder ${left[0]}`);
  return filled;
}

/** Writes site.ts, operations/*.ts and commands/*.ts into `srcDir`; returns the written paths relative to it. */
export function copyExpected(auth: "login" | "none", srcDir: string, tokens: ExpectedTokens): string[] {
  const from = join(EXPECTED_DIR, auth);
  const written: string[] = [];
  const copy = (rel: string) => {
    writeFileSync(join(srcDir, rel), fillTokens(readFileSync(join(from, rel), "utf8"), tokens));
    written.push(rel);
  };
  copy("site.ts");
  for (const dir of ["operations", "commands"]) {
    mkdirSync(join(srcDir, dir), { recursive: true });
    for (const file of readdirSync(join(from, dir)).filter((f) => f.endsWith(".ts")).sort()) copy(join(dir, file));
  }
  return written;
}
