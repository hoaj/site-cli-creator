// Routing and flag parsing. The only file that imports ./site and ./registry; everything else
// is a runtime module driven from here, so tests can run `run()` with a fake site and fetch.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import site from "./site";
import { commands, operations } from "./registry";
import { Client, type Deps } from "./runtime/call";
import { check, type WriteChecker } from "./runtime/check";
import type { Command } from "./runtime/command";
import { doctor, type Exec } from "./runtime/doctor";
import { ContractError, DryRun, EXIT, Failure, emit, errorEnvelope, note, type Surface } from "./runtime/envelope";
import { bugFrame, bugKey, errorName, redactStack } from "./runtime/fingerprint";
import { BUILTIN_FLAGS, commandHelp, flagSpecs, help, isWriteCommand, type FlagSpec } from "./runtime/help";
import { chromeLogin } from "./runtime/login";
import { createMcpServer, serveStdio, toolName, type McpTool } from "./runtime/mcp";
import { selftest } from "./runtime/selftest";
import { legacyStateDir, migrateStateDir, stateDir } from "./runtime/session";
import type { Operation } from "./runtime/operation";
import { siteProblems, type Site } from "./runtime/site";
import { z } from "zod";

export type App = {
  site: Site;
  operations: Operation[];
  commands: Command[];
  deps?: Partial<Deps>;
  checkWrites?: WriteChecker;
  exec?: Exec;
};
/** `serve`: the run starts a server instead of printing one document (the `mcp` built-in). */
export type RunResult = { output: unknown; code: number; serve?: "mcp" };

const input = (message: string) => new Failure("input", message);

/** A path flag as an absolute path: a leading `~` (which the shell leaves alone in `--flag=~/x`) is the home dir. */
export function expandPath(raw: string): string {
  const home = /^~(?=$|[\\/])/.test(raw) ? join(homedir(), raw.slice(1)) : raw;
  return resolve(home);
}

/** Pulls the global flags (--account <id>, --confirm) out of argv, wherever they stand. */
export function splitGlobals(argv: string[]) {
  const rest: string[] = [];
  let account: string | undefined;
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--confirm") confirm = true;
    else if (t.startsWith("--confirm=")) throw input("--confirm is a presence flag; pass it without a value");
    else if (t === "--account" || t.startsWith("--account=")) {
      const v = t === "--account" ? argv[++i] : t.slice("--account=".length);
      if (!v || v.startsWith("--")) throw input("--account needs a value");
      if (account !== undefined) throw input("--account given twice");
      account = v;
    } else rest.push(t);
  }
  const words: string[] = [];
  while (words.length < rest.length && !rest[words.length].startsWith("-")) words.push(rest[words.length]);
  return { words, flags: rest.slice(words.length), account, confirm };
}

/** `--name value`, `--name=value`, presence-only booleans, repeatable arrays. Keys come back camelCase. */
export function parseFlags(specs: FlagSpec[], tokens: string[]): Record<string, unknown> {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const out: Record<string, unknown> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("--")) throw input(`unexpected argument "${t}"`);
    const eq = t.indexOf("=");
    const name = eq < 0 ? t : t.slice(0, eq);
    const spec = byName.get(name);
    if (!spec) throw input(`unknown flag ${name}`);
    if (spec.type === "boolean") {
      if (eq >= 0) throw input(`${name} is a presence flag; pass it without a value`);
      out[spec.key] = true;
      continue;
    }
    const raw = eq >= 0 ? t.slice(eq + 1) : tokens[++i];
    if (raw === undefined || (eq < 0 && raw.startsWith("--"))) throw input(`${name} needs a value`);
    const value = spec.type === "number" && raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
    if (spec.multiple) out[spec.key] = [...((out[spec.key] as unknown[]) ?? []), value];
    else if (spec.key in out) throw input(`${name} given twice`);
    else out[spec.key] = value;
  }
  return out;
}

/**
 * Whether `--help` or `-h` stands where a flag would: not as the value of a flag that takes one
 * (`--name -h`). Checked before the flags are, so `<command> --bogus --help` still prints help.
 */
export function wantsHelp(specs: FlagSpec[], tokens: string[]): boolean {
  const byName = new Map(specs.map((s) => [s.name, s]));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--help" || t === "-h") return true;
    const spec = byName.get(t);
    if (spec && spec.type !== "boolean") i++;
  }
  return false;
}

function parseArgs(command: Command, tokens: string[]) {
  const specs = flagSpecs(command.args);
  const r = command.args.safeParse(parseFlags(specs, tokens));
  if (r.success) return r.data;
  const flagOf = (key: PropertyKey | undefined) => specs.find((s) => s.key === key)?.name ?? String(key ?? "flags");
  throw input(r.error.issues.map((i) => `${flagOf(i.path[0])}: ${i.message}`).join("; "));
}

function defaultDeps(app: App): Deps {
  return {
    fetch: (input, init) => fetch(input, init),
    env: process.env,
    login: (headless, options) => chromeLogin(app.site, { headless, note, fromProfile: options?.fromProfile }),
    sleep: (ms) => Bun.sleep(ms),
    retryDelays: [500, 1500],
    note,
    ...app.deps,
  };
}

/**
 * Moves a state dir an older build left in ~/.<plugin>-<plugin>/ to ~/.<plugin>/ once (SPEC §7), so
 * the user stays signed in. A move that fails is reported and never stops the command.
 */
function moveLegacyStateDir(site: Site, deps: Deps) {
  try {
    const m = migrateStateDir(site, deps.env);
    if (m.moved) deps.note(`moved the state dir ${m.from} to ${m.to}; the sign-in carries over`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? errorName(e);
    deps.note(`could not move the state dir ${legacyStateDir(site, deps.env)} to ${stateDir(site, deps.env)} (${code}); it stays where it is, and a sign-in may be needed`);
  }
}

const compiled = () => import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");

export async function run(argv: string[], app: App): Promise<RunResult> {
  const { site } = app;
  let commandName = "main";
  try {
    const problems = siteProblems(site);
    if (problems.length) throw new ContractError(`site.ts: ${problems.join("; ")}`);
    const { words, flags, account, confirm } = splitGlobals(argv);
    const deps = defaultDeps(app);
    moveLegacyStateDir(site, deps);
    const client = new Client(site, deps, { confirm });
    let builtin = words[0] ?? "help";
    let rest = flags;
    if (words.length === 0 && ["--help", "-h", "--version"].includes(flags[0])) {
      builtin = flags[0] === "--version" ? "version" : "help";
      rest = flags.slice(1);
    }
    // `<command> --help`: that command's entry from help, and nothing runs (no sign-in, no call).
    const asked = commandHelp(site, app.commands, words.slice(0, 2).join(" ")) ?? commandHelp(site, app.commands, words[0] ?? "");
    if (asked && wantsHelp(asked.flags, rest)) {
      commandName = asked.name;
      return ok(asked);
    }
    const builtinFlags = (name: string) => {
      if (words.length > 1) throw input(`unexpected argument "${words[1]}"`);
      return parseFlags(BUILTIN_FLAGS[name], rest);
    };

    if (builtin === "help") {
      commandName = "help";
      builtinFlags("help");
      return ok(help(site, app.commands));
    }
    if (builtin === "version") {
      commandName = "version";
      builtinFlags("version");
      return ok({ plugin: site.plugin, skill: site.skill, version: site.version });
    }
    if (builtin === "doctor") {
      commandName = "doctor";
      builtinFlags("doctor");
      return ok(await doctor(site, { env: deps.env, exec: app.exec, compiled: compiled() }));
    }
    if (builtin === "selftest") {
      // Hidden built-in for the generator's platform smoke test (SPEC §9); not listed by help.
      commandName = "selftest";
      const f = builtinFlags("selftest");
      return ok(await selftest({ url: f.url as string | undefined, chrome: !f["no-chrome"], fetch: deps.fetch, env: deps.env }));
    }
    if (builtin === "check") {
      commandName = "check";
      const f = builtinFlags("check");
      return ok(await check(client, app.operations, { op: f.op as string | undefined, writes: !!f.writes, account }, app.checkWrites));
    }
    if (builtin === "login" && site.auth === "login") {
      commandName = "login";
      const raw = builtinFlags("login")["from-profile"] as string | undefined;
      if (raw === undefined) {
        const session = await client.signIn(false);
        if (!session) throw new Failure("session", `Sign-in to ${site.origin} did not complete; run login again and finish signing in in the Chrome window.`);
        return ok({ loggedIn: true, stateDir: client.dir, ids: Object.keys(session.ids) });
      }
      // Reuse a sign-in another Chrome profile holds (the Capture's), headless: the user signs in once.
      const session = await client.signIn(true, { fromProfile: expandPath(raw) });
      if (!session) {
        throw new Failure(
          "session",
          `The sign-in in ${raw} did not carry over to ${site.origin} (none there, expired, or not kept in cookies); run login without --from-profile and sign in in the Chrome window.`,
        );
      }
      return ok({ loggedIn: true, fromProfile: true, stateDir: client.dir, ids: Object.keys(session.ids) });
    }

    if (builtin === "mcp") {
      commandName = "mcp";
      builtinFlags("mcp");
      return { output: null, code: EXIT.ok, serve: "mcp" };
    }

    const name = words.slice(0, 2).join(" ");
    const command = app.commands.find((c) => c.name === name);
    if (!command) throw input(`unknown command "${words.join(" ") || flags[0]}"; run \`${site.skill} help\``);
    commandName = command.name;
    if (words.length > 2) throw input(`unexpected argument "${words[2]}"`);
    return ok(await runTask(app, client, deps, command, parseArgs(command, flags), account));
  } catch (e) {
    return failed(e, site, commandName);
  }
}

const ok = (output: unknown): RunResult => ({ output, code: EXIT.ok });

/** One Task with its parsed args: the CLI and the MCP server both end here. */
async function runTask(app: App, client: Client, deps: Deps, command: Command, args: unknown, account: string | undefined) {
  if (app.site.auth === "login") await client.ensureSession();
  const chosen = await client.resolveAccount(account);
  deps.note(`${command.name}: ${command.uses.map((o) => o.name).join(" → ") || "no Operations"}`);
  const result = await command.run(args as never, {
    call: client.call,
    session: { get ids() { return client.peek()?.ids ?? {}; } },
    account: chosen,
    note: deps.note,
  });
  return result ?? null;
}

/** What a run that threw prints: the dry run, the classified Failure's envelope, or a bug. */
function failed(e: unknown, site: Site, commandName: string, surface: Surface = "cli"): RunResult {
  if (e instanceof DryRun) return ok({ dryRun: true, would: { operation: e.operation, variables: e.variables } });
  if (e instanceof Failure) return { output: errorEnvelope(e, site, surface), code: EXIT[e.kind] };
  const stack = e instanceof Error ? e.stack : undefined;
  const what = e instanceof ContractError ? e.message : `${errorName(e)} in ${bugFrame(stack)}`;
  const bug = new Failure("bug", what, { fingerprint: bugKey(site, commandName, e), stack: redactStack(e) });
  return { output: errorEnvelope(bug, site, surface), code: EXIT.bug };
}

const MCP_ACCOUNT = z.string().min(1).optional().describe("which account to act for, when the login has several");
const MCP_CONFIRM = z.boolean().optional().describe("send the write; without it the tool returns a dry run to show the user first");

/**
 * The `mcp` built-in's tools: one per Task command, plus login (auth login), check and doctor.
 * A tool call runs the same code as the CLI command, with three differences: arguments come
 * typed (JSON, not flags), `next` speaks of tools, and a command never opens a headed sign-in
 * (SITE_CLI_NONINTERACTIVE), so it fails with session and the client calls login instead.
 */
export function mcpServer(app: App) {
  const { site } = app;
  const base = defaultDeps(app);
  const deps: Deps = { ...base, env: { ...base.env, SITE_CLI_NONINTERACTIVE: "1" } };
  moveLegacyStateDir(site, deps);

  const tool = (name: string, description: string, schema: z.ZodObject, annotations: McpTool["annotations"], commandName: string, body: (args: any) => Promise<unknown>): McpTool => ({
    name,
    description,
    schema,
    annotations,
    async call(raw) {
      try {
        const r = schema.safeParse(raw);
        if (!r.success) throw input(r.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; "));
        return ok(await body(r.data));
      } catch (e) {
        return failed(e, site, commandName, "mcp");
      }
    },
  });

  const tasks = app.commands.map((command) => {
    const write = isWriteCommand(command);
    const schema = command.args.extend({ account: MCP_ACCOUNT, ...(write && { confirm: MCP_CONFIRM }) }).strict();
    return tool(
      toolName(command.name),
      command.summary,
      schema,
      write ? { title: command.summary, readOnlyHint: false, destructiveHint: true, openWorldHint: true } : { title: command.summary, readOnlyHint: true, openWorldHint: true },
      command.name,
      ({ account, confirm, ...args }) => runTask(app, new Client(site, deps, { confirm: confirm === true }), deps, command, args, account),
    );
  });

  const login = site.auth === "login"
    ? [tool("login", "Open Chrome so the user signs in to the site; call it when a tool fails with kind session", z.object({}).strict(), { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, "login", async () => {
        const client = new Client(site, deps);
        const session = await client.signIn(false);
        if (!session) throw new Failure("session", `Sign-in to ${site.origin} did not complete; call login again and finish signing in in the Chrome window.`);
        return { loggedIn: true, stateDir: client.dir, ids: Object.keys(session.ids) };
      })]
    : [];

  const checkSchema = z.object({
    op: z.string().optional().describe("check one Operation and the chain it needs"),
    writes: z.boolean().optional().describe("also check write Operations in headless Chrome (aborted, never sent)"),
    account: MCP_ACCOUNT,
  }).strict();

  const tools: McpTool[] = [
    ...tasks,
    ...login,
    tool("check", "Call every read Operation live and validate it against its Contract, to tell whether the site changed; writes: true also checks writes without sending them", checkSchema, { readOnlyHint: true, openWorldHint: true }, "check",
      ({ op, writes, account }) => check(new Client(site, deps), app.operations, { op, writes: !!writes, account }, app.checkWrites)),
    tool("doctor", "Versions, state dir, Chrome, gh status and binary findings, for reports", z.object({}).strict(), { readOnlyHint: true, openWorldHint: false }, "doctor",
      () => doctor(site, { env: deps.env, exec: app.exec, compiled: compiled() })),
  ];

  const instructions = [
    `These tools run Tasks on ${site.origin}${site.auth === "login" ? " as the signed-in user" : ""}; every result is JSON.`,
    `A tool marked readOnlyHint false writes: call it without confirm first, show the user the dry run it returns, and call it again with confirm: true only after the user's explicit yes.`,
    `A failed call returns {"error": {kind, message, next}}: do what next says. On kind drift, stop and do not work around it.`,
  ].join(" ");
  return createMcpServer({ name: site.skill === site.plugin ? site.plugin : `${site.plugin}-${site.skill}`, version: site.version, instructions }, tools);
}

/**
 * True when `path` is the module Bun started with. Not plain `import.meta.main`: in a Windows
 * binary built through Bun.build's `compile` option it is false, because import.meta.path
 * ("B:\\~BUN\\root\\main") and Bun.main ("B:/~BUN/root/main") differ in their separators, so the
 * binary ran nothing and exited 0 with empty stdout.
 */
export function isEntry(path: string, main: string = Bun.main): boolean {
  const norm = (p: string) => p.replaceAll("\\", "/");
  return norm(path) === norm(main);
}

/** Runs argv and prints its one document, or serves MCP on stdio until stdin ends. */
export async function main(argv: string[], app: App): Promise<never> {
  const result = await run(argv, app);
  if (result.serve !== "mcp") return emit(result.output, result.code);
  await serveStdio(mcpServer(app));
  process.exit(EXIT.ok);
}

if (import.meta.main || isEntry(import.meta.path)) {
  await main(process.argv.slice(2), { site, operations, commands });
}
