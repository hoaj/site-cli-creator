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
import { ContractError, DryRun, EXIT, Failure, emit, errorEnvelope, note } from "./runtime/envelope";
import { bugFrame, bugKey, errorName, redactStack } from "./runtime/fingerprint";
import { BUILTIN_FLAGS, flagSpecs, help, type FlagSpec } from "./runtime/help";
import { chromeLogin } from "./runtime/login";
import { selftest } from "./runtime/selftest";
import { legacyStateDir, migrateStateDir, stateDir } from "./runtime/session";
import type { Operation } from "./runtime/operation";
import { siteProblems, type Site } from "./runtime/site";

export type App = {
  site: Site;
  operations: Operation[];
  commands: Command[];
  deps?: Partial<Deps>;
  checkWrites?: WriteChecker;
  exec?: Exec;
};
export type RunResult = { output: unknown; code: number };

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

    const name = words.slice(0, 2).join(" ");
    const command = app.commands.find((c) => c.name === name);
    if (!command) throw input(`unknown command "${words.join(" ") || flags[0]}"; run \`${site.skill} help\``);
    commandName = command.name;
    if (words.length > 2) throw input(`unexpected argument "${words[2]}"`);
    const args = parseArgs(command, flags);
    if (site.auth === "login") await client.ensureSession();
    const chosen = await client.resolveAccount(account);
    deps.note(`${command.name}: ${command.uses.map((o) => o.name).join(" → ") || "no Operations"}`);
    const result = await command.run(args, {
      call: client.call,
      session: { get ids() { return client.peek()?.ids ?? {}; } },
      account: chosen,
      note: deps.note,
    });
    return ok(result ?? null);
  } catch (e) {
    if (e instanceof DryRun) return ok({ dryRun: true, would: { operation: e.operation, variables: e.variables } });
    if (e instanceof Failure) return { output: errorEnvelope(e, site), code: EXIT[e.kind] };
    const stack = e instanceof Error ? e.stack : undefined;
    const what = e instanceof ContractError ? e.message : `${errorName(e)} in ${bugFrame(stack)}`;
    const bug = new Failure("bug", what, { fingerprint: bugKey(site, commandName, e), stack: redactStack(e) });
    return { output: errorEnvelope(bug, site), code: EXIT.bug };
  }
}

const ok = (output: unknown): RunResult => ({ output, code: EXIT.ok });

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

if (import.meta.main || isEntry(import.meta.path)) {
  const { output, code } = await run(process.argv.slice(2), { site, operations, commands });
  await emit(output, code);
}
