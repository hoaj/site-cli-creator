import { parseArgs } from "node:util";
import { fail, ToolHelp } from "./output";

type OptionSpec = { type: "string" | "boolean"; multiple?: boolean };
/** `help` is the flag's one-line meaning, printed by --help. */
type Spec = Record<string, OptionSpec & { required?: boolean; help?: string }>;

type Values<S extends Spec> = {
  [K in keyof S]: S[K]["type"] extends "boolean"
    ? boolean
    : S[K]["multiple"] extends true
      ? string[]
      : S[K]["required"] extends true
        ? string
        : string | undefined;
};

/**
 * Strict flag parsing: unknown flags, missing values, missing required flags
 * and stray arguments (an unquoted multi-word value) all become a ToolError
 * naming the problem. `positionals` is how many bare arguments the tool takes.
 * `--help` or `-h` anywhere prints {usage, flags, notes?} and exits 0.
 */
export function parseFlags<S extends Spec>(
  argv: string[],
  spec: S,
  usage: string,
  positionals = 0,
  notes?: string[],
): { values: Values<S>; positionals: string[] } {
  if (argv.includes("--help") || argv.includes("-h")) {
    const flags: Record<string, string> = {};
    for (const [name, opt] of Object.entries(spec)) {
      const meaning = opt.help ?? "";
      flags[`--${name}`] = `${opt.required ? "required. " : ""}${opt.multiple ? "repeatable. " : ""}${meaning}`.trim();
    }
    throw new ToolHelp({ usage, flags, ...(notes?.length ? { notes } : {}) });
  }
  const options: Record<string, OptionSpec> = {};
  for (const [name, { type, multiple }] of Object.entries(spec)) options[name] = { type, multiple };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    fail(`${(error as Error).message}\nusage: ${usage}`);
  }
  if (parsed.positionals.length > positionals) {
    const stray = parsed.positionals.slice(positionals).map((p) => JSON.stringify(p)).join(", ");
    fail(`unexpected argument ${stray} (quote values that contain spaces)\nusage: ${usage}`);
  }
  const values: Record<string, unknown> = {};
  for (const [name, opt] of Object.entries(spec)) {
    const v = parsed.values[name];
    if (opt.type === "boolean") values[name] = v === true;
    else if (opt.multiple) values[name] = (v as string[] | undefined) ?? [];
    else {
      if (opt.required && (typeof v !== "string" || v.trim() === "")) fail(`missing --${name}\nusage: ${usage}`);
      values[name] = v;
    }
  }
  return { values: values as Values<S>, positionals: parsed.positionals };
}

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function requireKebab(flag: string, value: string): string {
  if (!KEBAB.test(value)) fail(`--${flag} must be kebab-case (a-z, 0-9, dashes), got "${value}"`);
  return value;
}
