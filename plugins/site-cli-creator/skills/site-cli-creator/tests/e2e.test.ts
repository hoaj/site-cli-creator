// End-to-end test of the generator and a generated plugin, against fixtures/site, for both
// auth modes. Each mode gets its own fixture site, temp dirs and state dir, and drives a
// COMPILED binary for the host platform, the way users run it:
//
//   new.ts → add-skill.ts → fixtures/expected (copy.ts) → bun install → regen.ts → build.ts
//   then: login (login mode), Task commands, a write dry run and --confirm, input errors,
//   every Drift switch, outages, a crashing command (bug key), check (--op, --writes),
//   the built-ins, the Capture tool + draft-contract against a fresh fixture, and install.sh
//   with a fake gh that serves the compiled binary as a release asset.
//
// Needs Google Chrome (login, check --writes, Capture). Without it the suites are skipped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyExpected, OPERATION_NAMES } from "../fixtures/expected/copy";
import { ACCOUNT, INVOICES, newStore, SUBSCRIPTIONS, USER } from "../fixtures/site/data";
import { startFixtureSite, type Drift, type FixtureSite } from "../fixtures/site/server";
import { findChrome } from "../starter/skill/cli/src/runtime/chrome";
import { SKILL_ROOT } from "../tools/lib/paths";

const TOOLS = join(SKILL_ROOT, "tools");
const BUN = process.execPath;
const CHROME = findChrome(process.env).path;
const HAS_CHROME = CHROME !== undefined;
if (!HAS_CHROME) console.warn("e2e.test.ts: skipped, Google Chrome was not found (set SITE_CLI_CHROME to its executable)");

// ---- the host platform ------------------------------------------------------------

function hostTarget() {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch;
  const unameOs = os === "darwin" ? "Darwin" : os === "linux" ? "Linux" : "MINGW64_NT-10.0";
  const unameArch = arch === "x64" ? "x86_64" : arch;
  return { platform: `${os}-${arch}`, bunTarget: `bun-${os}-${arch}`, uname: `${unameOs} ${unameArch}`, exe: os === "windows" ? ".exe" : "" };
}
const HOST = hostTarget();

// ---- processes ----------------------------------------------------------------------

type Ran = { code: number; stdout: string; stderr: string };
const live = new Set<ReturnType<typeof Bun.spawn>>();

/** Runs a process without blocking the event loop: the fixture site answers from this process. */
async function spawn(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number } = {}): Promise<Ran> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: opts.timeout ?? 120_000,
    killSignal: "SIGKILL",
  });
  live.add(proc);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } finally {
    live.delete(proc);
  }
}

/** The environment without anything a developer's shell may have set for site CLIs. */
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("SITE_CLI_") && k !== "STARTER_DIR") env[k] = v;
  return env;
}

/** stdout must be exactly one JSON document, whatever the outcome. */
function oneJson(r: Ran, what: string): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${what}: stdout is not exactly one JSON document (exit ${r.code})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
  }
}

async function tool(name: string, args: string[], opts: { env?: Record<string, string>; timeout?: number } = {}) {
  const r = await spawn([BUN, join(TOOLS, name), ...args], { env: { ...cleanEnv(), ...opts.env }, timeout: opts.timeout });
  return { ...r, out: oneJson(r, `${name} ${args.join(" ")}`) };
}

// ---- values that must never leave the site --------------------------------------------

const NOTE_TEXT = "Ring mig efter frokost";

function leafValues(value: unknown, out: (string | number)[] = []): (string | number)[] {
  if (typeof value === "string" || typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const v of value) leafValues(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) leafValues(v, out);
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every string and number in the fixture's data, as patterns that match it as a whole word. */
const FIXTURE_VALUES: { value: string; re: RegExp }[] = [
  ...new Set(leafValues([USER, ACCOUNT, SUBSCRIPTIONS, INVOICES, newStore().notes, NOTE_TEXT])),
]
  .filter((v) => (typeof v === "number" ? Math.abs(v) >= 100 : v.length >= 3))
  .map((v) => {
    const s = String(v);
    const re = typeof v === "number" ? new RegExp(`(?<![\\d.])${escape(s)}(?![\\d.])`) : new RegExp(`(?<![\\p{L}\\p{N}_])${escape(s)}(?![\\p{L}\\p{N}_])`, "u");
    return { value: s, re };
  });

function leaks(text: string): string[] {
  return FIXTURE_VALUES.filter(({ re }) => re.test(text)).map(({ value }) => value);
}

const TYPE_NAMES = new Set(["undefined", "null", "string", "number", "boolean", "object", "array", "bigint", "symbol", "function"]);

/** A diff names paths, codes and type names only. */
function expectTypeOnlyDiff(diff: unknown) {
  expect(Array.isArray(diff)).toBe(true);
  for (const entry of diff as Record<string, unknown>[]) {
    for (const key of Object.keys(entry)) expect(["path", "code", "expected", "received"]).toContain(key);
    if (entry.received !== undefined) expect(TYPE_NAMES.has(String(entry.received))).toBe(true);
    if (entry.expected !== undefined) expect(TYPE_NAMES.has(String(entry.expected))).toBe(true);
  }
}

test("the value scanner finds fixture values as whole words only", () => {
  expect(FIXTURE_VALUES.length).toBeGreaterThan(40);
  expect(leaks(JSON.stringify({ data: { listSubscriptions: [{ status: "active", price: 399 }] } }))).toEqual(["active", "399"]);
  expect(leaks(JSON.stringify(USER))).toEqual(expect.arrayContaining([USER.cpr, USER.email, USER.customerId]));
  expect(leaks('{"url":"http://127.0.0.1:53990","note":"opens","type":"number","code":"invalid_type"}')).toEqual([]);
});

// ---- the fake gh for install.sh ---------------------------------------------------------

const FAKE_GH = `#!/usr/bin/env bash
echo "gh $*" >>"$E2E_GH_LOG"
case "$1 $2" in
  "auth status") exit 0 ;;
  "release download")
    shift 2; tag="$1"; shift
    while [ $# -gt 0 ]; do
      case "$1" in --pattern) pattern="$2"; shift ;; --dir) dir="$2"; shift ;; --repo) repo="$2"; shift ;; esac
      shift
    done
    if [ "$tag" != "v$E2E_VERSION" ] || [ "$pattern" != "$E2E_ASSET" ] || [ "$repo" != "$E2E_REPO" ]; then
      echo "release not found" >&2; exit 1
    fi
    cp "$E2E_BINARY" "$dir/$pattern" ;;
  "api repos/"*) exit 0 ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
`;

// ---- one suite per auth mode -------------------------------------------------------------

const PLUGIN = "shop";
const REPO = "acme/shop-plugin";
const OPS = OPERATION_NAMES;

for (const auth of ["none", "login"] as const) {
  const skill = `shop-${auth}`;
  const prefix = `${PLUGIN}:${skill}:`;
  const title = `e2e, auth ${auth}${HAS_CHROME ? "" : " (skipped: Google Chrome not found)"}`;

  describe.skipIf(!HAS_CHROME)(title, () => {
    let site: FixtureSite;
    let work: string;
    let pluginDir: string;
    let skillDir: string;
    let cliDir: string;
    let home: string;
    let binary: string;
    let built = false;
    const extraSites: FixtureSite[] = [];

    beforeAll(() => {
      site = startFixtureSite({ auth });
      work = mkdtempSync(join(tmpdir(), `e2e-${auth}-`));
      pluginDir = join(work, "plugin");
      skillDir = join(pluginDir, "skills", skill);
      cliDir = join(skillDir, "cli");
      home = join(work, "state");
      binary = join(work, "dist", `${skill}-${HOST.platform}${HOST.exe}`);
    });

    afterAll(() => {
      for (const p of live) p.kill("SIGKILL");
      site?.stop();
      for (const s of extraSites) s.stop();
      if (work) rmSync(work, { recursive: true, force: true });
    });

    const cliEnv = (extra: Record<string, string> = {}) => ({
      ...cleanEnv(),
      SITE_CLI_TEST: "1",
      SITE_CLI_HOME: home,
      SITE_CLI_CHROME: CHROME!,
      ...extra,
    });

    /** Runs the compiled binary; stdout must be one JSON document in every case. */
    async function cli(args: string[], opts: { env?: Record<string, string>; bin?: string; timeout?: number } = {}) {
      if (!built) throw new Error("the scaffold test did not produce a binary");
      const r = await spawn([opts.bin ?? binary, ...args], { env: cliEnv(opts.env), timeout: opts.timeout ?? 120_000 });
      return { ...r, out: oneJson(r, `${skill} ${args.join(" ")}`) };
    }

    const withDrift = async <T,>(drift: Drift, body: () => Promise<T>): Promise<T> => {
      site.setDrift(drift);
      try {
        return await body();
      } finally {
        site.setDrift(null);
      }
    };

    const writesSeen = () => site.requests().filter((r) => r.operationName === "addNote").length;

    // 1. scaffold ------------------------------------------------------------------------

    test("new, add-skill, the expected code, regen and a compiled binary for the host", async () => {
      const created = await tool("new.ts", [
        "--dir", pluginDir, "--plugin", PLUGIN, "--repo", REPO, "--description", "Shop account", "--maintainer", "octo", "--no-labels", "--skip-checks",
      ]);
      expect(created.code, created.stderr).toBe(0);
      expect(created.out).toMatchObject({ plugin: PLUGIN, repo: REPO, version: "0.1.0", labels: "skipped" });

      const added = await tool("add-skill.ts", ["--dir", pluginDir, "--skill", skill, "--origin", site.url, "--auth", auth]);
      expect(added.code, added.stderr).toBe(0);
      expect(added.out).toMatchObject({ plugin: PLUGIN, skill, auth, version: "0.1.0" });

      const copied = copyExpected(auth, join(cliDir, "src"), { plugin: PLUGIN, skill, repo: REPO, generatorVersion: "0.1.0", origin: site.url });
      expect(copied).toContain("site.ts");
      expect(copied.filter((f) => f.startsWith("commands/")).length).toBe(4);

      const install = await spawn([BUN, "install"], { cwd: cliDir, env: cleanEnv(), timeout: 240_000 });
      expect(install.code, install.stderr).toBe(0);

      const regen = await tool("regen.ts", ["--skill-dir", skillDir]);
      expect(regen.code, regen.stderr).toBe(0);
      expect(regen.out.needsChrome).toBe(true); // login, and a write Operation in both modes
      expect(regen.out.commands).toEqual([
        { name: "invoice list", write: false },
        { name: "invoice show", write: false },
        { name: "note add", write: true },
        { name: "subscription show", write: false },
      ]);
      expect(readFileSync(join(cliDir, "src", "site.ts"), "utf8")).toMatch(/needsChrome:\s*true\b/);
      const registry = readFileSync(join(cliDir, "src", "registry.ts"), "utf8");
      for (const f of copied.filter((f) => f !== "site.ts")) expect(registry).toContain(`./${f.replace(/\.ts$/, "")}"`);

      const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      const table = skillMd.slice(skillMd.indexOf("<!-- commands:start -->"), skillMd.indexOf("<!-- commands:end -->"));
      const rows = table.split("\n").filter((l) => l.startsWith(`| \`${skill} `));
      expect(rows.map((r) => /^\| `[^`]+? ([a-z]+ [a-z]+)`/.exec(r)?.[1])).toEqual(["invoice list", "invoice show", "note add", "subscription show"]);
      for (const row of rows) expect(row.includes("**Write.**")).toBe(row.includes(" note add`"));
      expect(rows.find((r) => r.includes(" invoice show`"))).toContain("`--id <id>`");
      expect(rows.find((r) => r.includes(" subscription show`"))).toContain("`[--all]`");

      mkdirSync(join(work, "dist"), { recursive: true });
      const build = await spawn([BUN, "build.ts", HOST.bunTarget, binary], { cwd: cliDir, env: cleanEnv(), timeout: 240_000 });
      expect(build.code, build.stderr).toBe(0);
      expect(existsSync(binary)).toBe(true);
      built = true;
    }, 600_000);

    // 2. login --------------------------------------------------------------------------------

    if (auth === "login") {
      test("login signs in (headless under SITE_CLI_TEST) and keeps only chain-root ids, private", async () => {
        const r = await cli(["login"]);
        expect(r.code, r.stderr).toBe(0);
        expect(r.out).toEqual({ loggedIn: true, stateDir: home, ids: ["customerId"] });
        const file = join(home, "session.json");
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(home).mode & 0o777).toBe(0o700);
        const saved = readFileSync(file, "utf8");
        const session = JSON.parse(saved);
        expect(session.ids).toEqual({ customerId: USER.customerId });
        expect(Object.keys(session.headers).sort()).toEqual(["authorization", "cookie"]);
        for (const v of [USER.cpr, USER.email, ACCOUNT.name]) expect(saved).not.toContain(v);
      }, 120_000);

      test("a command without a session signs in by itself (no exit 4)", async () => {
        unlinkSync(join(home, "session.json"));
        const r = await cli(["subscription", "show"]);
        expect(r.code, r.stderr).toBe(0);
        expect(r.out.customer).toBe(ACCOUNT.name);
        expect(JSON.parse(readFileSync(join(home, "session.json"), "utf8")).ids).toEqual({ customerId: USER.customerId });
      }, 120_000);

      test("a sign-in that never completes fails with exit 4, kind session", async () => {
        const impatient = { SITE_CLI_LOGIN_TIMEOUT_MS: "3000" };
        site.revokeSessions();
        site.blockSignIn(true);
        try {
          const login = await cli(["login"], { env: impatient });
          expect(login.code, login.stderr).toBe(4);
          expect(login.out.error.kind).toBe("session");
          expect(login.out.error.next).toContain(`${skill} login`);

          const command = await cli(["invoice", "list"], { env: impatient });
          expect(command.code, command.stderr).toBe(4);
          expect(command.out.error.kind).toBe("session");
        } finally {
          site.blockSignIn(false);
        }
        const again = await cli(["invoice", "list"]);
        expect(again.code, again.stderr).toBe(0);
      }, 180_000);
    } else {
      test("there is no login command without a login", async () => {
        const r = await cli(["login"]);
        expect(r.code).toBe(2);
        expect(r.out.error.kind).toBe("input");
      }, 60_000);
    }

    // 3. Task commands ----------------------------------------------------------------------

    test("Task commands read through the chain", async () => {
      const shown = await cli(["subscription", "show"]);
      expect(shown.code, shown.stderr).toBe(0);
      const active = SUBSCRIPTIONS.filter((s) => s.status === "active");
      expect(shown.out).toEqual({
        customer: ACCOUNT.name,
        subscriptions: active.map((s) => ({ name: s.name, status: s.status, since: s.startDate, monthlyDKK: s.price })),
        monthlyTotalDKK: active.reduce((sum, s) => sum + (s.price ?? 0), 0),
      });

      const all = await cli(["subscription", "show", "--all"]);
      expect(all.code, all.stderr).toBe(0);
      expect(all.out.subscriptions.map((s: { name: string }) => s.name)).toEqual(SUBSCRIPTIONS.map((s) => s.name));

      const list = await cli(["invoice", "list"]);
      expect(list.code, list.stderr).toBe(0);
      expect(list.out).toEqual({
        invoices: INVOICES.map((i) => ({ id: i.id, number: i.number, issued: i.issuedAt, due: i.dueDate, amountDKK: i.amountDKK, status: i.status })),
      });

      const invoice = INVOICES[1]!;
      const one = await cli(["invoice", "show", "--id", invoice.id]);
      expect(one.code, one.stderr).toBe(0);
      expect(one.out).toMatchObject({ id: invoice.id, number: invoice.number, issued: invoice.issuedAt, due: null, amountDKK: invoice.amountDKK, status: invoice.status });
      expect(one.out.lines.map((l: { text: string; amountDKK: number }) => [l.text, l.amountDKK])).toEqual(invoice.lines.map((l) => [l.text, l.amountDKK]));
    }, 120_000);

    test("a write is a dry run without --confirm, and writes once with it", async () => {
      const notes = site.notes().length;
      const writes = writesSeen();
      const dry = await cli(["note", "add", "--text", "x"]);
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.out).toEqual({ dryRun: true, would: { operation: "addNote", variables: { accountId: ACCOUNT.id, text: "x" } } });
      expect(site.notes().length).toBe(notes);
      expect(writesSeen()).toBe(writes);

      const done = await cli(["note", "add", "--text", "x", "--confirm"]);
      expect(done.code, done.stderr).toBe(0);
      expect(done.out.note).toMatchObject({ text: "x" });
      expect(site.notes().length).toBe(notes + 1);
      expect(site.notes().at(-1)!.text).toBe("x");
      expect(writesSeen()).toBe(writes + 1);
    }, 120_000);

    // 4. input -------------------------------------------------------------------------------

    test("an unknown command, an unknown flag or a missing flag is input, and nothing is sent", async () => {
      for (const argv of [["invoice", "pay"], ["subscription", "show", "--nope"], ["invoice", "show"], ["note", "add", "--text", ""]]) {
        const before = site.requests().length;
        const r = await cli(argv);
        expect({ argv, code: r.code }).toEqual({ argv, code: 2 });
        expect(r.out.error.kind).toBe("input");
        expect(r.out.error.next).toContain(`${skill} help`);
        expect(site.requests().length).toBe(before);
      }
    }, 120_000);

    // 5. Drift and outages ---------------------------------------------------------------------

    const DRIFTS: [Drift, string[], string][] = [
      ["rename-field", ["subscription", "show"], `${prefix}listSubscriptions:zod:data.listSubscriptions[].status:invalid_type`],
      ["type-change", ["subscription", "show"], `${prefix}listSubscriptions:zod:data.listSubscriptions[].price:invalid_type`],
      ["remove-rest", ["invoice", "show", "--id", INVOICES[0]!.id], `${prefix}GET /api/invoices/{id}:http::404`],
      ["graphql-validation", ["subscription", "show"], `${prefix}listSubscriptions:graphql:Subscription.price:GRAPHQL_VALIDATION_FAILED`],
      // The first call with variables is rejected: getAccount (login) or listSubscriptions (none: getAccount takes none).
      ["input-rejected", ["subscription", "show"], `${prefix}${auth === "login" ? "getAccount" : "listSubscriptions"}:input-rejected::BAD_USER_INPUT`],
      ["auth", ["subscription", "show"], `${prefix}getAccount:auth::401`],
    ];

    for (const [drift, argv, fingerprint] of DRIFTS) {
      test(`drift ${drift}: exit 3 with its Fingerprint, a type-only diff and no site values`, async () => {
        const r = await withDrift(drift, () => cli(argv));
        expect(r.code, r.stderr).toBe(3);
        const e = r.out.error;
        expect(e.kind).toBe("drift");
        expect(e.fingerprint).toBe(fingerprint);
        expectTypeOnlyDiff(e.diff);
        if (drift === "rename-field") expect(e.diff).toContainEqual(expect.objectContaining({ path: "data.listSubscriptions[].status", code: "invalid_type", received: "undefined" }));
        if (drift === "type-change") expect(e.diff).toContainEqual(expect.objectContaining({ path: "data.listSubscriptions[].price", received: "string" }));
        if (drift === "graphql-validation") expect(e.diff).toEqual([{ path: "Subscription.price", code: "GRAPHQL_VALIDATION_FAILED" }]);
        expect(e.next).toContain(`${PLUGIN}-feedback`);
        expect(e.next).toMatch(/^Stop/);
        expect(e).toMatchObject({ version: "0.1.0", os: HOST.platform });
        expect(leaks(r.stdout)).toEqual([]);
      }, 120_000);
    }

    for (const [drift, argv] of [["server-error", ["invoice", "list"]], ["rate-limit", ["subscription", "show"]]] as const) {
      test(`${drift}: exit 5, kind network`, async () => {
        const r = await withDrift(drift, () => cli([...argv]));
        expect(r.code, r.stderr).toBe(5);
        expect(r.out.error.kind).toBe("network");
        expect(r.out.error.fingerprint).toBeUndefined();
        expect(leaks(r.stdout)).toEqual([]);
      }, 120_000);
    }

    // 7. check ---------------------------------------------------------------------------------

    const readOps = [OPS.getAccount, OPS.listSubscriptions, OPS.listInvoices, OPS.getInvoice];

    test("check: every read Operation is ok, the write is skipped", async () => {
      const r = await cli(["check"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.out.ok).toBe(true);
      const rows = Object.fromEntries(r.out.operations.map((o: { operation: string; status: string }) => [o.operation, o.status]));
      expect(rows).toEqual({ ...Object.fromEntries(readOps.map((o) => [o, "ok"])), [OPS.addNote]: "skipped" });
    }, 120_000);

    test("check with a drift switch: exit 3 with drifts for exactly the affected Operations", async () => {
      const renamed = await withDrift("rename-field", () => cli(["check"]));
      expect(renamed.code, renamed.stderr).toBe(3);
      expect(renamed.out.error.kind).toBe("drift");
      expect(renamed.out.error.drifts.map((d: { operation: string; fingerprint: string }) => [d.operation, d.fingerprint])).toEqual([
        [OPS.listSubscriptions, `${prefix}listSubscriptions:zod:data.listSubscriptions[].status:invalid_type`],
      ]);
      for (const d of renamed.out.error.drifts) expectTypeOnlyDiff(d.diff);
      expect(leaks(renamed.stdout)).toEqual([]);

      const removed = await withDrift("remove-rest", () => cli(["check"]));
      expect(removed.code, removed.stderr).toBe(3);
      expect(removed.out.error.drifts.map((d: { operation: string; fingerprint: string }) => [d.operation, d.fingerprint])).toEqual([
        [OPS.getInvoice, `${prefix}GET /api/invoices/{id}:http::404`],
      ]);
      expect(leaks(removed.stdout)).toEqual([]);
    }, 120_000);

    test("check --op checks one Operation with its chain, in either name form", async () => {
      for (const op of [OPS.getInvoice, "GET /api/invoices/{id}"]) {
        const r = await cli(["check", "--op", op]);
        expect(r.code, r.stderr).toBe(0);
        expect(r.out.operations.map((o: { operation: string; status: string }) => `${o.operation}:${o.status}`)).toEqual([
          `${OPS.getAccount}:ok`,
          `${OPS.listInvoices}:ok`,
          `${OPS.getInvoice}:ok`,
        ]);
      }
      const drifted = await withDrift("remove-rest", () => cli(["check", "--op", "GET /api/invoices/{id}"]));
      expect(drifted.code).toBe(3);
      expect(drifted.out.error.drifts.map((d: { operation: string }) => d.operation)).toEqual([OPS.getInvoice]);
      const unknown = await cli(["check", "--op", "nope"]);
      expect(unknown.code).toBe(2);
      expect(unknown.out.error.kind).toBe("input");
    }, 120_000);

    test("check --writes drives the trigger in Chrome and never sends the write", async () => {
      const notes = site.notes().length;
      const writes = writesSeen();
      const r = await cli(["check", "--writes"], { timeout: 180_000 });
      expect(r.code, r.stderr).toBe(0);
      const rows = Object.fromEntries(r.out.operations.map((o: { operation: string; status: string }) => [o.operation, o.status]));
      expect(rows).toEqual(Object.fromEntries([...readOps, OPS.addNote].map((o) => [o, "ok"])));
      expect(writesSeen()).toBe(writes);
      expect(site.notes().length).toBe(notes);
    }, 240_000);

    // 8. built-ins ---------------------------------------------------------------------------

    test("help, version and doctor print one JSON document and exit 0", async () => {
      const help = await cli(["help"]);
      expect(help.code, help.stderr).toBe(0);
      expect(help.out.commands.map((c: { name: string; write: boolean }) => [c.name, c.write])).toEqual([
        ["invoice list", false],
        ["invoice show", false],
        ["note add", true],
        ["subscription show", false],
      ]);
      expect(help.out.exitCodes.map((e: { code: number; kind: string }) => `${e.code}:${e.kind}`)).toEqual(["0:ok", "1:bug", "2:input", "3:drift", "4:session", "5:network"]);
      const builtins = help.out.builtins.map((b: { name: string }) => b.name);
      expect(builtins).toEqual(auth === "login" ? ["help", "login", "check", "doctor", "version"] : ["help", "check", "doctor", "version"]);
      expect(builtins).not.toContain("selftest");

      const version = await cli(["version"]);
      expect(version.code, version.stderr).toBe(0);
      expect(version.out).toEqual({ plugin: PLUGIN, skill, version: "0.1.0" });
      expect((await cli(["--version"])).out).toEqual(version.out);

      const doctor = await cli(["doctor"]);
      expect(doctor.code, doctor.stderr).toBe(0);
      expect(typeof doctor.out).toBe("object");
      expect(JSON.stringify(doctor.out)).toContain(`${skill} check`);
      expect(leaks(doctor.stdout)).toEqual([]);
    }, 120_000);

    // 6. a bug ---------------------------------------------------------------------------------

    test("a crashing command exits 1 with the bug key and a stack of src/-relative frames", async () => {
      const crash = join(cliDir, "src", "commands", "crash-now.ts");
      writeFileSync(
        crash,
        `import { z } from "zod";
import { defineCommand } from "../runtime/command";

function explode(input: { deep?: { value: string } }): string {
  return input.deep!.value.toUpperCase();
}

export default defineCommand({
  name: "crash now",
  summary: "Throws a TypeError (e2e test only)",
  args: z.object({}),
  uses: [],
  run: async () => explode({}),
});
`,
      );
      const bugBinary = join(work, "dist-bug", `${skill}${HOST.exe}`);
      try {
        const regen = await tool("regen.ts", ["--skill-dir", skillDir]);
        expect(regen.code, regen.stderr).toBe(0);
        expect(regen.out.commands.map((c: { name: string }) => c.name)).toContain("crash now");
        mkdirSync(join(work, "dist-bug"), { recursive: true });
        const build = await spawn([BUN, "build.ts", HOST.bunTarget, bugBinary], { cwd: cliDir, env: cleanEnv(), timeout: 240_000 });
        expect(build.code, build.stderr).toBe(0);
      } finally {
        rmSync(crash, { force: true });
        const restored = await tool("regen.ts", ["--skill-dir", skillDir]);
        expect(restored.code, restored.stderr).toBe(0);
        expect(restored.out.commands.length).toBe(4);
      }

      const r = await cli(["crash", "now"], { bin: bugBinary });
      expect(r.code, r.stderr).toBe(1);
      const e = r.out.error;
      expect(e.kind).toBe("bug");
      expect(e.fingerprint).toBe(`${prefix}bug:crash-now:TypeError:commands/crash-now.ts#explode`);
      expect(e.next).toContain(`${PLUGIN}-feedback`);
      expect(e.stack.length).toBeGreaterThan(0);
      expect(e.stack[0]).toMatch(/^commands\/crash-now\.ts(:\d+){0,2}#explode$/);
      for (const frame of e.stack as string[]) {
        expect(frame).toMatch(/^(?:[\w.-]+\/)*[\w.-]+\.ts(?::\d+){0,2}#\S+$|^node_modules\/\S+#\S+$/);
        expect(frame).not.toContain(work);
        expect(frame).not.toMatch(/\$bunfs|~BUN|^\//);
      }
      expect(r.stdout).not.toContain(work);
    }, 600_000);

    // 9. Capture + draft-contract -----------------------------------------------------------------

    test("capture records a read Task and a write Task as shapes without values; draft-contract drafts from one", async () => {
      const fresh = startFixtureSite({ auth });
      extraSites.push(fresh);
      const scripts = join(work, "scripts");
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(scripts, "read.ts"), `export default async (page) => {\n  await page.waitForSelector("body[data-state=loaded]", { timeout: 30000 });\n};\n`);
      writeFileSync(
        join(scripts, "write.ts"),
        `export default async (page) => {
  await page.waitForSelector("body[data-state=loaded]", { timeout: 30000 });
  await page.getByLabel("Ny note").fill(${JSON.stringify(NOTE_TEXT)});
  await page.getByRole("button", { name: "Tilføj note" }).click();
  await page.waitForSelector(${JSON.stringify(`#notes li:has-text(${JSON.stringify(NOTE_TEXT)})`)}, { timeout: 30000 });
};
`,
      );
      const start = auth === "login" ? `${fresh.loginUrl}/login?autologin=1` : `${fresh.url}/`;
      const capture = (task: string, script: string, extra: string[] = []) =>
        tool(
          "capture.ts",
          ["--skill-dir", skillDir, "--task", task, "--url", start, "--headless", "--script", join(scripts, script), "--profile", join(work, `profile-${task}`), "--origin", fresh.url, ...extra],
          { env: { SITE_CLI_CHROME: CHROME! }, timeout: 180_000 },
        );
      const filesOf = (task: string) => {
        const dir = join(skillDir, "captures", task);
        return { dir, text: (f: string) => readFileSync(join(dir, f), "utf8") };
      };
      /** Shape files and stdout, minus the temp paths the tool prints. */
      const scanned = (stdout: string, task: string, files: string[]) =>
        [stdout.replaceAll(work, "<work>"), ...files.map((f) => filesOf(task).text(f))].join("\n");

      // A read Task: writes are aborted, sign-in steps (login) go through.
      const notesBefore = fresh.notes().length;
      const read = await capture("subscription-show", "read.ts");
      expect(read.code, JSON.stringify(read.out) + read.stderr).toBe(0);
      const readOps = read.out.operations as { operation: string; effect: string; file: string; loginFlow?: boolean; aborted: number }[];
      for (const name of ["getAccount", "listSubscriptions", "GET /api/invoices", "GET /api/invoices/:id"]) {
        expect(readOps.find((o) => o.operation === name), name).toMatchObject({ effect: "read", aborted: 0 });
      }
      if (auth === "login") {
        expect(readOps.filter((o) => o.loginFlow).map((o) => o.operation)).toEqual(["POST /oauth/token", "POST /api/session/post-login"]);
      }
      const readFiles = [...readOps.map((o) => o.file), "index.json"];
      for (const f of readFiles) expect(existsSync(join(filesOf("subscription-show").dir, f)), f).toBe(true);
      const subs = JSON.parse(filesOf("subscription-show").text("listSubscriptions.shape.json"));
      expect(subs.operation).toBe("listSubscriptions");
      expect(subs.kind).toBe("graphql");
      const item = subs.responses[0].body.shape.fields.data.fields.listSubscriptions;
      expect(item.type).toBe("array");
      expect(JSON.stringify(item)).toContain('"price"');
      expect(JSON.stringify(item)).toContain('"number"');
      expect(JSON.parse(filesOf("subscription-show").text("GET-api-invoices-id.shape.json")).operation).toBe("GET /api/invoices/:id");
      expect(leaks(scanned(read.stdout, "subscription-show", readFiles))).toEqual([]);
      expect(fresh.notes().length).toBe(notesBefore);

      // A write Task with --write: the user's one write goes through for real.
      const write = await capture("note-add", "write.ts", ["--write"]);
      expect(write.code, JSON.stringify(write.out) + write.stderr).toBe(0);
      const writeOps = write.out.operations as { operation: string; effect: string; file: string; aborted: number }[];
      expect(writeOps.find((o) => o.operation === "addNote")).toMatchObject({ effect: "write", file: "addNote.shape.json", aborted: 0 });
      expect(fresh.notes().length).toBe(notesBefore + 1);
      expect(fresh.notes().at(-1)!.text).toBe(NOTE_TEXT);
      const add = JSON.parse(filesOf("note-add").text("addNote.shape.json"));
      expect(add.request.variables.fields).toEqual({ accountId: { type: "string" }, text: { type: "string" } });
      expect(add.responses[0].body.shape.fields.data.fields.addNote.fields).toMatchObject({ id: { type: "string" }, text: { type: "string" } });
      const writeFiles = [...writeOps.map((o) => o.file), "index.json"];
      expect(leaks(scanned(write.stdout, "note-add", writeFiles))).toEqual([]);

      // draft-contract --out writes a module Bun can import, and never overwrites it.
      const drafts = join(cliDir, "src", "drafts");
      mkdirSync(drafts, { recursive: true });
      try {
        const out = join(drafts, "listSubscriptions.ts");
        const shape = join(filesOf("subscription-show").dir, "listSubscriptions.shape.json");
        const drafted = await tool("draft-contract.ts", [shape, "--out", out]);
        expect(drafted.code, drafted.stderr).toBe(0);
        expect(drafted.out).toEqual({ operation: "listSubscriptions", file: "src/operations/listSubscriptions.ts", written: out });
        const again = await tool("draft-contract.ts", [shape, "--out", out]);
        expect(again.code).toBe(1);
        expect(again.out.error.message).toContain("refusing to overwrite");
        expect(leaks(readFileSync(out, "utf8"))).toEqual([]);
        const op = (await import(out)).default;
        expect(op).toMatchObject({ name: "listSubscriptions", effect: "read" });
        expect(op.graphql).toContain("listSubscriptions(accountId: $accountId)");
        expect(op.variables.safeParse({ accountId: "x" }).success).toBe(true);
        expect(op.variables.safeParse({}).success).toBe(false);
        expect(typeof op.response.safeParse).toBe("function");
      } finally {
        rmSync(drafts, { recursive: true, force: true });
      }
    }, 600_000);

    // 10. install.sh -----------------------------------------------------------------------------

    test("install.sh downloads the binary through gh, installs it and it runs", async () => {
      const fakeBin = join(work, "fake-bin");
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, "gh"), FAKE_GH);
      chmodSync(join(fakeBin, "gh"), 0o755);
      const log = join(work, "gh.log");
      const asset = `${skill}-${HOST.platform}${HOST.exe}`;
      const sep = process.platform === "win32" ? ";" : ":";
      const r = await spawn(["bash", join(skillDir, "install.sh")], {
        env: {
          ...cleanEnv(),
          PATH: `${fakeBin}${sep}${process.env.PATH}`,
          SITE_CLI_INSTALL_UNAME: HOST.uname,
          SITE_CLI_CHROME: CHROME!,
          E2E_GH_LOG: log,
          E2E_VERSION: "0.1.0",
          E2E_ASSET: asset,
          E2E_REPO: REPO,
          E2E_BINARY: binary,
        },
        timeout: 120_000,
      });
      expect(r.code, r.stderr).toBe(0);
      const installed = join(skillDir, "bin", `${skill}${HOST.exe}`);
      expect(existsSync(installed)).toBe(true);
      expect(statSync(installed).mode & 0o111).not.toBe(0);
      expect(readFileSync(log, "utf8")).toContain(`gh release download v0.1.0 --repo ${REPO} --pattern ${asset}`);

      const version = await cli(["version"], { bin: installed });
      expect(version.code, version.stderr).toBe(0);
      expect(version.out).toEqual({ plugin: PLUGIN, skill, version: "0.1.0" });
    }, 180_000);
  });
}
