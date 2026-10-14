// `help` as JSON. tools/regen.ts builds the SKILL.md command table from this output.
import type { z } from "zod";
import type { Command } from "./command";
import { EXIT, nextStep, type Kind } from "./envelope";
import type { Site } from "./site";

export type FlagType = "boolean" | "string" | "number" | "enum";
export type FlagSpec = {
  /** As typed on the command line, kebab-case: "--from-date". */
  name: string;
  /** The key in the command's args schema: "fromDate". */
  key: string;
  type: FlagType;
  /** Repeat the flag to pass several values. */
  multiple: boolean;
  required: boolean;
  values?: string[];
  description?: string;
};

const WRAPPERS = new Set(["optional", "default", "prefault", "nullable", "nonoptional", "readonly", "catch"]);

function unwrap(schema: z.ZodType): z.ZodType {
  let s: any = schema;
  for (;;) {
    const def = s._zod.def;
    if (WRAPPERS.has(def.type)) s = def.innerType;
    else if (def.type === "pipe") s = def.in;
    else return s;
  }
}

export const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function flagSpecs(args: z.ZodObject): FlagSpec[] {
  return Object.entries(args.shape).map(([key, field]) => {
    const schema = field as z.ZodType;
    let inner: any = unwrap(schema);
    const multiple = inner._zod.def.type === "array";
    if (multiple) inner = unwrap(inner._zod.def.element);
    const t = inner._zod.def.type;
    const type: FlagType = t === "boolean" ? "boolean" : t === "number" || t === "int" || t === "bigint" ? "number" : t === "enum" ? "enum" : "string";
    const spec: FlagSpec = { name: `--${kebab(key)}`, key, type, multiple, required: (schema as any)._zod.optin !== "optional" && type !== "boolean" };
    if (type === "enum") spec.values = Object.values(inner._zod.def.entries).map(String);
    const description = schema.description ?? inner.description;
    if (description) spec.description = description;
    return spec;
  });
}

export const isWriteCommand = (c: Command) => c.uses.some((op) => op.effect === "write");

const flag = (name: string, type: FlagType, description: string): FlagSpec => ({ name: `--${name}`, key: name, type, multiple: false, required: false, description });

export const BUILTIN_FLAGS: Record<string, FlagSpec[]> = {
  help: [],
  version: [],
  doctor: [],
  login: [flag("from-profile", "string", "reuse the sign-in another Chrome profile holds (the Capture tool's ~/.site-cli-creator/profile) instead of signing in again")],
  check: [flag("op", "string", "check one Operation and the chain it needs"), flag("writes", "boolean", "also check write Operations in headless Chrome (aborted, never sent)")],
  // Hidden: the platform smoke test in CI; not listed by help.
  selftest: [flag("url", "string", "an http(s) URL to fetch"), flag("no-chrome", "boolean", "only the fetch, no Chrome")],
};

export function help(site: Site, commands: Command[]) {
  const builtins = [
    { name: "help", summary: "Commands, flags and exit codes as JSON" },
    ...(site.auth === "login" ? [{ name: "login", summary: "Open Chrome so the user signs in; run it when a command fails with kind session" }] : []),
    { name: "check", summary: "Call every read Operation live and validate it against its Contract; --writes also checks writes without sending them" },
    { name: "doctor", summary: "Versions, state dir, Chrome, gh status and binary findings, for reports" },
    { name: "version", summary: "Print the version" },
  ].map((b) => ({ ...b, flags: BUILTIN_FLAGS[b.name] }));
  return {
    plugin: site.plugin,
    skill: site.skill,
    version: site.version,
    auth: site.auth,
    usage: `${site.skill} <command> [flags]`,
    commands: commands.map((c) => ({ name: c.name, summary: c.summary, write: isWriteCommand(c), flags: flagSpecs(c.args) })),
    builtins,
    globalFlags: [
      flag("account", "string", "which account to act for, when the login has several"),
      flag("confirm", "boolean", "send write Operations; without it a write command prints a dry run"),
    ],
    exitCodes: (Object.entries(EXIT) as [keyof typeof EXIT, number][]).map(([kind, code]) => ({
      code,
      kind,
      ...(kind !== "ok" && { next: nextStep(kind as Kind, site) }),
    })),
  };
}
