// Routing and flag parsing. The only file that imports ./site and ./registry; everything else
// is a runtime module driven from here, so tests can run `run()` with a fake site and fetch.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import site from "./site";
import { commands, operations } from "./registry";
import { Client, type Deps } from "./runtime/call";
import { check, findOperation, type WriteChecker } from "./runtime/check";
import type { Command } from "./runtime/command";
import { doctor, type Exec } from "./runtime/doctor";
import { ContractError, DryRun, EXIT, Failure, emit, errorEnvelope, note, type Surface } from "./runtime/envelope";
import { bugFrame, bugKey, errorName, redactStack } from "./runtime/fingerprint";
import { BUILTIN_FLAGS, commandHelp, flagDescription, flagSpecs, GLOBAL_FLAGS, help, isWriteCommand, type FlagSpec } from "./runtime/help";
import { chromeLogin } from "./runtime/login";
import { createMcpServer, serveStdio, toolName, type McpTool, type ServerInfo } from "./runtime/mcp";
import { hashPassword, MIN_PASSWORD_LENGTH, remoteConfig, type RemoteConfig } from "./runtime/remote-config";
import { selftest } from "./runtime/selftest";
import { ensureStateDir, legacyStateDir, migrateStateDir, stateDir, type Session } from "./runtime/session";
import type { SessionCheck } from "./runtime/setup";
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
  /** All of stdin as text (`mcp --hash-password`); tests pass their own. */
  readStdin?: () => Promise<string>;
};
/**
 * `serve`: the run starts a server instead of printing one document (the `mcp` built-in): local
 * mode over stdio, or remote mode over HTTP with its checked `remote` settings.
 */
export type RunResult = { output: unknown; code: number; serve?: "mcp" | "mcp-http"; remote?: RemoteConfig };

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
    // A Task command wins over a built-in of the same first word (`mcp list`): built-ins take no second word.
    if (words.length >= 2 && app.commands.some((c) => c.name === words.slice(0, 2).join(" "))) builtin = "";
    // `<command> --help`: that command's entry from help, and nothing runs (no sign-in, no call).
    const asked = commandHelp(site, app.commands, words.slice(0, 2).join(" ")) ?? commandHelp(site, app.commands, words[0] ?? "");
    if (asked && wantsHelp(asked.flags, rest)) {
      commandName = asked.name;
      return ok(asked);
    }
    // `login` is a built-in only for a skill that signs in; otherwise the word is looked up as a Task.
    if (Object.hasOwn(BUILTIN_FLAGS, builtin) && (builtin !== "login" || site.auth === "login")) {
      commandName = builtin;
      if (words.length > 1) throw input(`unexpected argument "${words[1]}"`);
      const f = parseFlags(BUILTIN_FLAGS[builtin]!, rest);
      if (builtin === "help") return ok(help(site, app.commands));
      if (builtin === "version") return ok({ plugin: site.plugin, skill: site.skill, version: site.version });
      if (builtin === "doctor") return ok(await doctor(site, { env: deps.env, exec: app.exec, compiled: compiled() }));
      // Hidden built-in for the generator's platform smoke test (SPEC §9); not listed by help.
      if (builtin === "selftest") return ok(await selftest({ url: f.url as string | undefined, chrome: !f["no-chrome"], fetch: deps.fetch, env: deps.env }));
      if (builtin === "check") return ok(await check(client, app.operations, { op: f.op as string | undefined, writes: !!f.writes, account }, app.checkWrites));
      if (builtin === "mcp") {
        if (account !== undefined || confirm) throw input("mcp takes no --account or --confirm; account and confirm are arguments of each tool call");
        if (f["hash-password"]) {
          if (f.http || f.port !== undefined) throw input("--hash-password takes no other flags");
          // The password comes on stdin, so it stays out of the shell's history and the process list.
          const password = (await (app.readStdin ?? (() => Bun.stdin.text()))()).replace(/\r?\n$/, "");
          if (password.length < MIN_PASSWORD_LENGTH) throw input(`the Owner password must be at least ${MIN_PASSWORD_LENGTH} characters`);
          return ok({ OWNER_PASSWORD_HASH: hashPassword(password) });
        }
        if (f.port !== undefined && !f.http) throw input("--port is for remote mode; pass it with --http");
        if (!f.http) return { output: null, code: EXIT.ok, serve: "mcp" };
        // Remote mode: the host's settings are checked here, so a missing password is one input envelope.
        return { output: null, code: EXIT.ok, serve: "mcp-http", remote: remoteConfig(deps.env, { port: f.port as number | undefined }) };
      }
      // login
      const raw = f["from-profile"] as string | undefined;
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

const MCP_ACCOUNT = z.string().min(1).optional().describe(flagDescription(GLOBAL_FLAGS, "account"));
const MCP_CONFIRM = z.boolean().optional().describe("send the write; without it the tool returns a dry run to show the user first");

/**
 * What the Setup page says when it cannot take an uploaded Session: one sentence for the Owner,
 * built from the Failure's kind and never from its message, so nothing the site sent is echoed.
 */
function sessionReason(e: unknown, skill: string): string {
  if (e instanceof Failure) {
    const refused = e.kind === "session" || (e.kind === "drift" && !!e.drifts?.length && e.drifts.every((d) => d.fingerprint.split(":")[3] === "auth"));
    if (refused) return `the site did not accept this Session (signed out or expired). Run \`${skill} login\` on your computer again and upload the new session.json`;
    if (e.kind === "network") return "the site is not responding right now; try again later";
    if (e.kind === "drift") return `the site has changed (Drift), so the Session could not be checked; run \`${skill} check\` on your computer`;
  }
  return "the Session could not be checked (an error inside the server)";
}

/**
 * The Setup page's live check: the read Operations, called as `check` does but with the uploaded
 * Session and no sign-in or refresh, so a bad upload is refused before it replaces a working
 * Session. The candidate is never saved.
 */
export async function checkSession(app: App, candidate: Session): Promise<SessionCheck> {
  const client = new Client(app.site, defaultDeps(app), { session: candidate, reauth: false, surface: "mcp" });
  try {
    let result: Awaited<ReturnType<typeof check>>;
    try {
      result = await check(client, app.operations, { writes: false });
    } catch (e) {
      // Several accounts and no account asked for: check ends in input naming them. One account proves the Session works.
      const accounts = e instanceof Failure && e.kind === "input" ? e.details.accounts : undefined;
      if (!accounts?.length) throw e;
      result = await check(client, app.operations, { writes: false, account: accounts[0]!.id });
    }
    const tried = result.operations.filter((r) => r.effect === "read" && r.status === "ok").length;
    // Nothing ran: fine when the reads need input no Session supplies (check's "never checkable" and
    // "needs input the chain does not supply" skips); not when a value the Session should hold is
    // missing ("no value for <key>"; a "needs <operation>" skip only follows from another row's).
    const lacking = result.operations.some((r) => r.effect === "read" && r.status === "skipped" && r.reason?.startsWith("no value for"));
    if (tried === 0 && lacking) return { ok: false, reason: `this session.json lacks what the site's reads need; upload the file \`${app.site.skill} login\` wrote` };
    return { ok: true, tried };
  } catch (e) {
    return { ok: false, reason: sessionReason(e, app.site.skill) };
  }
}

/**
 * `loginWaitMs`: how long the login tool waits for the sign-in before answering signingIn (below an
 * MCP client's request timeout). `remote`: the tools of a remote server (below).
 */
export type McpOptions = { loginWaitMs?: number; remote?: boolean };

/**
 * The `mcp` built-in's tools: one per Task command, plus login (auth login), check and doctor.
 * A tool call runs the same code as the CLI command, with three differences: arguments come
 * typed (JSON, not flags), messages and `next` speak of tools, and a command never opens a headed
 * sign-in (Client `surface: "mcp"`), so it fails with session and the client calls login instead.
 * run() has already moved a legacy state dir by the time main() serves. Local mode serves them
 * over stdio (mcpServer); remote mode over HTTP (runtime/remote.ts). In remote mode there is no
 * Chrome to sign in with: the login tool is not listed, check offers no `writes`, and a session
 * failure sends the Owner to the Setup page (the adapter in remote.ts rewrites its `next`).
 */
export function mcpTools(app: App, options: McpOptions = {}): { info: ServerInfo; tools: McpTool[] } {
  const { site } = app;
  // A remote server has no Chrome: a Client there never tries one, so a refused sign-in is a clean session failure.
  const deps: Deps = options.remote ? { ...defaultDeps(app), login: async () => null } : defaultDeps(app);
  const loginWaitMs = options.loginWaitMs ?? 20_000;
  /** The headed sign-in the login tool started, while its Chrome window is open. */
  let signingIn: Promise<unknown> | null = null;
  const notWhileSigningIn = () => {
    if (signingIn) {
      throw new Failure("session", `A sign-in to ${site.origin} is still open in a Chrome window.`, {
        next: "Ask the user to finish signing in in the Chrome window, then call this tool again.",
      });
    }
  };

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
      ({ account, confirm, ...args }) => {
        notWhileSigningIn();
        return runTask(app, new Client(site, deps, { confirm: confirm === true, surface: "mcp" }), deps, command, args, account);
      },
    );
  });

  /**
   * Opens Chrome for the user to sign in, and answers within loginWaitMs either way, so one sign-in
   * never holds the server (calls are handled one at a time) past the client's request timeout. A
   * sign-in still open answers signingIn; calling login again reports on that same sign-in.
   */
  const signIn = async () => {
    if (!signingIn) {
      const client = new Client(site, deps);
      const started = client.signIn(false).then((session) => {
        if (!session) throw new Failure("session", `Sign-in to ${site.origin} did not complete in the Chrome window.`, { next: "Ask the user whether they want to try again; if so, call login again and have them finish signing in in the Chrome window." });
        return { loggedIn: true, stateDir: client.dir, ids: Object.keys(session.ids) };
      }, (e) => {
        // The login tool's own failure (no Chrome, a profile in use): pointing back at login would loop.
        if (e instanceof Failure && e.kind === "session") throw new Failure("session", e.message, { ...e.details, next: "Tell the user what the message says; once they have fixed it, call login again." });
        throw e;
      });
      signingIn = started;
      started.then(() => { signingIn = null; }, () => { signingIn = null; });
    }
    const pending = signingIn;
    const done = await Promise.race([pending.then((r) => ({ r })), Bun.sleep(loginWaitMs).then(() => null)]);
    if (!done) return { signingIn: true, message: "Chrome is open for the user to sign in. Ask them to finish there, then call login again to confirm, or call the tool that needed it." };
    return done.r;
  };

  const login = site.auth === "login" && !options.remote
    ? [tool("login", "Open Chrome so the user signs in to the site; call it when a tool fails with kind session", z.object({}).strict(), { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, "login", signIn)]
    : [];

  const checkSchema = z.object({
    op: z.string().optional().describe(flagDescription(BUILTIN_FLAGS.check!, "op")),
    ...(!options.remote && { writes: z.boolean().optional().describe(flagDescription(BUILTIN_FLAGS.check!, "writes")) }),
    account: MCP_ACCOUNT,
  }).strict();

  const tools: McpTool[] = [
    ...tasks,
    ...login,
    tool("check", options.remote ? "Call every read Operation live and validate it against its Contract, to tell whether the site changed" : "Call every read Operation live and validate it against its Contract, to tell whether the site changed; writes: true also checks writes without sending them", checkSchema, { readOnlyHint: true, openWorldHint: true }, "check",
      ({ op, writes, account }) => {
        notWhileSigningIn();
        // A write is checked by driving its page in Chrome, which a remote server does not have.
        if (options.remote && op !== undefined && findOperation(app.operations, op).effect === "write") {
          throw input("checking a write needs Chrome, which a remote server does not have; check reads only");
        }
        return check(new Client(site, deps, { surface: "mcp" }), app.operations, { op, writes: !!writes, account }, app.checkWrites);
      }),
    // The report (paths, Chrome, gh) describes the server's host, which a remote client cannot act on.
    ...(options.remote ? [] : [tool("doctor", "Versions, state dir, Chrome, gh status and binary findings, for reports", z.object({}).strict(), { readOnlyHint: true, openWorldHint: false }, "doctor",
      () => doctor(site, { env: deps.env, exec: app.exec, compiled: compiled() }))]),
  ];

  const instructions = [
    `These tools run Tasks on ${site.origin}${site.auth === "login" ? " as the signed-in user" : ""}; every result is JSON.`,
    `A tool with a confirm argument writes: call it without confirm first, show the user the dry run it returns, and call it again with confirm: true only after the user's explicit yes.`,
    `A failed call returns {"error": {kind, message, next}}: do what next says. On kind drift, stop and do not work around it.`,
    ...(options.remote ? [`When a tool fails with kind session, the Owner must give this server a new Session on its Setup page; do what next says.`] : []),
  ].join(" ");
  return { info: { name: site.skill === site.plugin ? site.plugin : `${site.plugin}-${site.skill}`, version: site.version, instructions }, tools };
}

/** Local mode: the tools as a stdio JSON-RPC server. */
export function mcpServer(app: App, options: McpOptions = {}) {
  const { info, tools } = mcpTools(app, options);
  return createMcpServer(info, tools);
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

/**
 * Runs argv and prints its one document, or serves MCP: on stdio until stdin ends (local mode), or
 * over HTTP until the host stops it (remote mode, which prints nothing on stdout; its log is stderr).
 */
export async function main(argv: string[], app: App): Promise<never> {
  const result = await run(argv, app);
  if (result.serve === "mcp") {
    await serveStdio(mcpServer(app));
    process.exit(EXIT.ok);
  }
  if (result.serve === "mcp-http" && result.remote) {
    // Loaded only here, so local mode and every CLI command never load the SDK or Express.
    const { serveHttp } = await import("./runtime/remote");
    const deps = defaultDeps(app);
    let server: Awaited<ReturnType<typeof serveHttp>>;
    try {
      server = await serveHttp({
        ...mcpTools(app, { remote: true }),
        site: app.site,
        config: result.remote,
        dir: ensureStateDir(stateDir(app.site, deps.env)),
        env: deps.env,
        checkSession: (candidate) => checkSession(app, candidate),
        note,
      });
    } catch (e) {
      // A port in use or an unreadable oauth.json is still one envelope on stdout, never a stack trace.
      const { output, code } = failed(e, app.site, "mcp");
      return emit(output, code);
    }
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    await server.close();
    process.exit(EXIT.ok);
  }
  return emit(result.output, result.code);
}

if (import.meta.main || isEntry(import.meta.path)) {
  await main(process.argv.slice(2), { site, operations, commands });
}
