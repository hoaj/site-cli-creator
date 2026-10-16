// Routing, flag parsing, envelopes, dry runs and --account, through main's run().
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { isEntry, parseFlags, run, splitGlobals } from "../src/main";
import { defineCommand } from "../src/runtime/command";
import { EXIT, Failure, ProfileUnavailable } from "../src/runtime/envelope";
import { flagSpecs } from "../src/runtime/help";
import { loadSession, saveSession } from "../src/runtime/session";
import { fakeFetch, happySite, json, loginSite, makeApp, makeDeps, makeSite, tempHome } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

const errorOf = (o: unknown) => (o as { error: Record<string, any> }).error;

function inputError(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof Failure && e.kind === "input") return e.message;
    throw e;
  }
  throw new Error("expected an input Failure");
}

describe("flag parsing", () => {
  const args = z.object({
    all: z.boolean().default(false),
    fromDate: z.string().optional(),
    limit: z.number().optional(),
    tag: z.array(z.string()).optional(),
    kind: z.enum(["a", "b"]).optional(),
  });
  const specs = flagSpecs(args);

  test("specs are kebab-case with types", () => {
    expect(specs.map((s) => [s.name, s.type, s.multiple, s.required])).toEqual([
      ["--all", "boolean", false, false],
      ["--from-date", "string", false, false],
      ["--limit", "number", false, false],
      ["--tag", "string", true, false],
      ["--kind", "enum", false, false],
    ]);
    expect(specs[4].values).toEqual(["a", "b"]);
  });

  test("a flag with a default is not required, whatever wraps it (#70: Zod 4 reports it as defaulted)", () => {
    const withDefaults = flagSpecs(z.object({
      limit: z.number().default(10),
      pages: z.coerce.number().int().min(1).max(200).default(10).describe("how many"),
      query: z.string(),
      sort: z.enum(["new", "old"]).default("new"),
    }));
    expect(withDefaults.map((s) => [s.name, s.required])).toEqual([
      ["--limit", false],
      ["--pages", false],
      ["--query", true],
      ["--sort", false],
    ]);
  });

  test("presence booleans, --k v, --k=v, numbers, repeated arrays", () => {
    expect(parseFlags(specs, ["--all", "--from-date", "2026-01-01", "--limit=5", "--tag", "x", "--tag", "y"])).toEqual({
      all: true,
      fromDate: "2026-01-01",
      limit: 5,
      tag: ["x", "y"],
    });
  });

  test("errors are input", () => {
    expect(inputError(() => parseFlags(specs, ["--nope"]))).toContain("unknown flag --nope");
    expect(inputError(() => parseFlags(specs, ["--limit"]))).toContain("--limit needs a value");
    expect(inputError(() => parseFlags(specs, ["--from-date", "--all"]))).toContain("needs a value");
    expect(inputError(() => parseFlags(specs, ["--all=false"]))).toContain("presence flag");
    expect(inputError(() => parseFlags(specs, ["--limit", "1", "--limit", "2"]))).toContain("given twice");
    expect(inputError(() => parseFlags(specs, ["stray"]))).toContain('unexpected argument "stray"');
  });

  test("global flags are taken from anywhere", () => {
    expect(splitGlobals(["--account", "A1", "products", "show", "--all", "--confirm"])).toEqual({
      words: ["products", "show"],
      flags: ["--all"],
      account: "A1",
      confirm: true,
    });
    expect(splitGlobals(["x", "--account=B"]).account).toBe("B");
    expect(inputError(() => splitGlobals(["x", "--account"]))).toContain("--account needs a value");
    expect(inputError(() => splitGlobals(["x", "--confirm=yes"]))).toContain("presence flag");
  });
});

describe("routing and envelopes", () => {
  const app = () => makeApp(makeSite(), makeDeps(fakeFetch(happySite).fetch, home.dir).deps);

  test("help is JSON with commands, write markers, flags, built-ins and exit codes", async () => {
    const { output, code } = await run(["help"], app());
    const h = output as any;
    expect(code).toBe(0);
    expect(h.commands.map((c: any) => [c.name, c.write])).toEqual([
      ["products show", false],
      ["order rename", true],
      ["crash now", false],
    ]);
    expect(h.commands[0].flags.map((f: any) => f.name)).toEqual(["--all", "--limit"]);
    expect(h.builtins.map((b: any) => b.name)).toEqual(["help", "check", "doctor", "version", "mcp"]);
    expect(h.globalFlags.map((f: any) => f.name)).toEqual(["--account", "--confirm"]);
    expect(h.exitCodes.map((e: any) => [e.code, e.kind])).toEqual([[0, "ok"], [1, "bug"], [2, "input"], [3, "drift"], [4, "session"], [5, "network"]]);
    expect((await run([], app())).output).toEqual(h);
    expect((await run(["--help"], app())).output).toEqual(h);
  });

  test("<command> --help or -h prints that command's entry from help, and nothing runs (#47)", async () => {
    const { fetch, calls } = fakeFetch(happySite);
    const { deps, loginCalls } = makeDeps(fetch, home.dir);
    const a = makeApp(loginSite(), deps);
    const h = (await run(["help"], a)).output as any;
    const cases: [string[], string][] = [
      [["products", "show", "--help"], "products show"],
      [["order", "rename", "-h"], "order rename"],
      [["products", "show", "--limit", "abc", "--bogus", "--help"], "products show"],
      [["--confirm", "order", "rename", "--order-id", "1", "--help"], "order rename"],
      [["login", "--help"], "login"],
      [["check", "-h"], "check"],
      [["help", "--help"], "help"],
    ];
    for (const [argv, name] of cases) {
      const { output, code } = await run(argv, a);
      expect(code, argv.join(" ")).toBe(0);
      const entry = [...h.commands, ...h.builtins].find((c: any) => c.name === name);
      expect(output).toEqual({ ...entry, usage: `shop ${name} [flags]`, globalFlags: h.globalFlags });
    }
    expect((await run(["order", "rename", "--help"], a)).output).toMatchObject({ write: true, flags: [{ name: "--order-id" }, { name: "--name" }] });
    expect(calls).toEqual([]);
    expect(loginCalls).toEqual([]);
    // An unknown command stays input, --help or not; `-h` as a flag's value is that value.
    expect((await run(["nope", "x", "--help"], a)).code).toBe(2);
    saveSession(home.dir, { headers: {}, ids: { customerId: "C-1" } });
    expect((await run(["order", "rename", "--order-id", "1", "--name", "-h"], a)).output).toEqual({
      dryRun: true,
      would: { operation: "PATCH /api/orders/:orderId", variables: { orderId: "1", name: "-h" } },
    });
  });

  test("help lists login only for auth login", async () => {
    const { output } = await run(["help"], makeApp(loginSite(), makeDeps(fakeFetch(happySite).fetch, home.dir).deps));
    expect((output as any).builtins.map((b: any) => b.name)).toContain("login");
  });

  test("selftest --no-chrome fetches the URL and is not listed by help", async () => {
    const { fetch, calls } = fakeFetch(() => json({ hello: "Kim Secret" }));
    const a = makeApp(makeSite(), makeDeps(fetch, home.dir).deps);
    const { output, code } = await run(["selftest", "--url", "http://127.0.0.1:9/", "--no-chrome"], a);
    expect(code).toBe(0);
    expect(output).toEqual({ ok: true, fetch: 200 });
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:9/"]);
    const h = (await run(["help"], a)).output as any;
    expect(JSON.stringify(h)).not.toContain("selftest");
    expect((await run(["selftest", "--no-chrome"], a)).code).toBe(2);
    expect((await run(["selftest", "--url", "ftp://x", "--no-chrome"], a)).code).toBe(2);
    const down = makeApp(makeSite(), makeDeps(async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); }, home.dir).deps);
    const failed = await run(["selftest", "--url", "http://127.0.0.1:9/", "--no-chrome"], down);
    expect(failed.code).toBe(5);
    expect((failed.output as any).error.kind).toBe("network");
  });

  test("version", async () => {
    expect((await run(["version"], app())).output).toEqual({ plugin: "acme", skill: "shop", version: "1.2.3" });
    expect((await run(["--version"], app())).code).toBe(0);
  });

  test("a task command returns its result", async () => {
    saveSession(home.dir, { headers: {}, ids: { customerId: "C-1" } });
    const { output, code } = await run(["products", "show", "--all"], app());
    expect(code).toBe(0);
    expect(output).toEqual({ customer: "Kim Secret", products: [{ id: "P1", status: "active" }, { id: "P2", status: "ended" }] });
  });

  test("unknown command, unknown flag, flag schema failure → input (exit 2) with next", async () => {
    for (const argv of [["nope", "x"], ["products", "show", "--bogus"], ["products", "show", "--limit", "abc"], ["login"], ["help", "extra"], ["check", "--nope"]]) {
      const { output, code } = await run(argv, app());
      expect(code).toBe(2);
      const e = errorOf(output);
      expect(e.kind).toBe("input");
      expect(e.next).toContain("shop help");
    }
  });

  test("error envelope: kind, message, version, os, next", async () => {
    const drifting = makeApp(makeSite(), makeDeps(fakeFetch(() => json({ data: { getCustomer: { id: 1 } } })).fetch, home.dir).deps);
    saveSession(home.dir, { headers: {}, ids: { customerId: "C-1" } });
    const { output, code } = await run(["products", "show"], drifting);
    expect(code).toBe(3);
    const e = errorOf(output);
    expect(Object.keys(output as object)).toEqual(["error"]);
    expect(e).toMatchObject({ kind: "drift", version: "1.2.3", fingerprint: "acme:shop:getCustomer:zod:data.getCustomer.id:invalid_type" });
    expect(e.os).toMatch(/^(darwin|linux|windows)-(arm64|x64)$/);
    expect(e.next).toContain("acme-feedback");
    expect(e.next).toContain("only if the user says yes");
    expect(e.next).toContain("raw calls");
  });

  test("anything else thrown → bug with key, redacted stack, feedback next", async () => {
    const { output, code } = await run(["crash", "now"], app());
    expect(code).toBe(1);
    const e = errorOf(output);
    expect(e.kind).toBe("bug");
    expect(e.fingerprint).toMatch(/^acme:shop:bug:crash-now:TypeError:[^:]+#\w+$/);
    expect(e.fingerprint).not.toMatch(/:\d+:\d+/);
    expect(Array.isArray(e.stack)).toBe(true);
    expect(e.next).toContain("acme-feedback");
  });

  test("a bug's message names the error and frame, never the thrown message", async () => {
    const leaky = defineCommand({
      name: "leak it",
      summary: "",
      args: z.object({}),
      uses: [],
      run: async () => {
        throw new RangeError("customer Kim Secret has 3 products");
      },
    });
    const { output, code } = await run(["leak", "it"], { ...app(), commands: [leaky] });
    expect(code).toBe(1);
    expect(errorOf(output).message).toMatch(/^RangeError in /);
    expect(JSON.stringify(output)).not.toContain("Kim");
  });

  test("a ContractError (the plugin's own config) is a bug that keeps the runtime's message", async () => {
    const orphan = { ...makeApp(makeSite(), makeDeps(fakeFetch(happySite).fetch, home.dir).deps) };
    orphan.operations = [{ ...orphan.operations[0], needs: { customerId: { from: "gone", pick: () => "x" } } }];
    const { output, code } = await run(["check"], orphan);
    expect(code).toBe(1);
    const e = errorOf(output);
    expect(e.message).toBe("listProducts needs gone, which is not in the registry");
    expect(e.fingerprint).toMatch(/^acme:shop:bug:check:ContractError:runtime\/check\.ts#/);
  });

  // add-skill replaces the placeholder in this file too; then the starter's unfilled case can't be built here.
  const starterCopy = ("login" as string).startsWith("__");
  test.skipIf(!starterCopy)("a site.ts that is not filled in is a bug with a readable message", async () => {
    const { output, code } = await run(["version"], makeApp(makeSite({ auth: "login" as any }), makeDeps(fakeFetch(happySite).fetch, home.dir).deps));
    expect(code).toBe(1);
    expect(errorOf(output).message).toContain('auth must be "login" or "none"');
  });
});

describe("writes: dry run vs --confirm", () => {
  test("without --confirm: reads run, the write is printed, nothing written", async () => {
    const { fetch, calls } = fakeFetch(happySite);
    const { output, code } = await run(["order", "rename", "--order-id", "7", "--name", "New"], makeApp(makeSite(), makeDeps(fetch, home.dir).deps));
    expect(code).toBe(0);
    expect(output).toEqual({ dryRun: true, would: { operation: "PATCH /api/orders/:orderId", variables: { orderId: "7", name: "New" } } });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("with --confirm the write is sent", async () => {
    const { fetch, calls } = fakeFetch(happySite);
    const { output, code } = await run(["order", "rename", "--order-id", "7", "--name", "New", "--confirm"], makeApp(makeSite(), makeDeps(fetch, home.dir).deps));
    expect(code).toBe(0);
    expect(output).toEqual({ ok: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
  });

  test("a dry run still validates input", async () => {
    const { fetch, calls } = fakeFetch(happySite);
    const { code } = await run(["order", "rename", "--order-id", "7", "--name", ""], makeApp(makeSite(), makeDeps(fetch, home.dir).deps));
    expect(code).toBe(2);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});

describe("--account", () => {
  const multi = (accounts: string[]) => {
    let listed = 0;
    const site = loginSite({ accounts: async () => (listed++, accounts.map((id) => ({ id, label: `Account ${id}` }))) });
    return { site, listed: () => listed };
  };

  test("several accounts and no --account → input listing them, next says --account", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer t" }, ids: { customerId: "C-1" } });
    const { site } = multi(["A1", "A2"]);
    const { output, code } = await run(["products", "show"], makeApp(site, makeDeps(fakeFetch(happySite).fetch, home.dir).deps));
    expect(code).toBe(2);
    const e = errorOf(output);
    expect(e.accounts).toEqual([{ id: "A1", label: "Account A1" }, { id: "A2", label: "Account A2" }]);
    expect(e.next).toContain("--account <id>");
  });

  test("--account picks one; the list is cached in session.json", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer t" }, ids: { customerId: "C-1" } });
    const { site, listed } = multi(["A1", "A2"]);
    const { fetch, calls } = fakeFetch(happySite);
    const app = makeApp(site, makeDeps(fetch, home.dir).deps);
    const { output, code } = await run(["products", "show", "--account", "A2"], app);
    expect(code).toBe(0);
    expect((output as any).customer).toBe("Kim Secret");
    expect(calls[0].body.variables.customerId).toBe("A2");
    await run(["products", "show", "--account", "A1"], app);
    expect(listed()).toBe(1);
    expect(loadSession(home.dir)!.accounts!.map((a) => a.id)).toEqual(["A1", "A2"]);
  });

  test("an unknown --account → input listing the accounts", async () => {
    saveSession(home.dir, { headers: {}, ids: {} });
    const { site } = multi(["A1", "A2"]);
    const { output, code } = await run(["products", "show", "--account", "ZZ"], makeApp(site, makeDeps(fakeFetch(happySite).fetch, home.dir).deps));
    expect(code).toBe(2);
    expect(errorOf(output).accounts).toHaveLength(2);
  });

  test("a single account needs no --account", async () => {
    saveSession(home.dir, { headers: {}, ids: {} });
    const { site } = multi(["ONLY"]);
    const { fetch, calls } = fakeFetch(happySite);
    const { code } = await run(["products", "show"], makeApp(site, makeDeps(fetch, home.dir).deps));
    expect(code).toBe(0);
    expect(calls[0].body.variables.customerId).toBe("ONLY");
  });
});

describe("login", () => {
  test("login signs in headed, runs postLogin, prints id names only", async () => {
    const { deps } = makeDeps(fakeFetch(happySite).fetch, home.dir, [{ authorization: "Bearer t" }]);
    const { output, code } = await run(["login"], makeApp(loginSite(), deps));
    expect(code).toBe(0);
    expect(output).toEqual({ loggedIn: true, stateDir: home.dir, ids: ["customerId"] });
    expect(loadSession(home.dir)!.ids).toEqual({ customerId: "C-1" });
  });

  test("login that doesn't complete → session (exit 4)", async () => {
    const { deps, loginCalls } = makeDeps(fakeFetch(happySite).fetch, home.dir, [null]);
    const { output, code } = await run(["login"], makeApp(loginSite(), deps));
    expect(code).toBe(4);
    expect(errorOf(output).next).toContain("shop login");
    expect(loginCalls).toEqual([false]);
  });

  test("login --from-profile signs in headless from that profile; when it does not carry over → session (exit 4)", async () => {
    const seen: unknown[] = [];
    const { deps } = makeDeps(fakeFetch(happySite).fetch, home.dir);
    const answers = [{ authorization: "Bearer t" }, null];
    deps.login = async (headless, options) => {
      seen.push({ headless, options });
      return answers.shift() ?? null;
    };
    const ok = await run(["login", "--from-profile", "/tmp/capture-profile"], makeApp(loginSite(), deps));
    expect(ok.code).toBe(0);
    expect(ok.output).toEqual({ loggedIn: true, fromProfile: true, stateDir: home.dir, ids: ["customerId"] });
    expect(seen).toEqual([{ headless: true, options: { fromProfile: "/tmp/capture-profile" } }]);
    const failed = await run(["login", "--from-profile", "/tmp/capture-profile"], makeApp(loginSite(), deps));
    expect(failed.code).toBe(4);
    expect(errorOf(failed.output).message).toContain("run login without --from-profile");
  });

  test("login --from-profile=~/<dir> expands the ~ the shell left alone (review)", async () => {
    const seen: unknown[] = [];
    const { deps } = makeDeps(fakeFetch(happySite).fetch, home.dir);
    deps.login = async (_headless, options) => {
      seen.push(options?.fromProfile);
      return { authorization: "Bearer t" };
    };
    for (const arg of ["--from-profile=~/.site-cli-creator/profile", "--from-profile=~"]) {
      expect((await run(["login", arg], makeApp(loginSite(), deps))).code).toBe(0);
    }
    expect(seen).toEqual([join(homedir(), ".site-cli-creator", "profile"), homedir()]);
  });

  test("after login --from-profile the silent refresh signs in from that profile first, then the CLI's own (#46)", async () => {
    const source = tempHome();
    try {
      const seen: unknown[] = [];
      let answers: Array<Record<string, string> | null> = [{ authorization: "Bearer t1" }];
      const { fetch } = fakeFetch((req) => (req.headers.authorization === "Bearer t1" ? json({}, 401) : happySite(req)));
      const { deps } = makeDeps(fetch, home.dir);
      deps.env = { ...deps.env, SITE_CLI_NONINTERACTIVE: "1" };
      deps.login = async (headless, options) => {
        seen.push({ headless, fromProfile: options?.fromProfile });
        return answers.shift() ?? null;
      };
      expect((await run(["login", "--from-profile", source.dir], makeApp(loginSite(), deps))).code).toBe(0);
      expect(loadSession(home.dir)!.fromProfile).toBe(source.dir);

      // The bearer expires: the refresh reuses the --from-profile sign-in, so no second sign-in is needed.
      seen.length = 0;
      answers = [{ authorization: "Bearer t2" }];
      expect((await run(["products", "show"], makeApp(loginSite(), deps))).code).toBe(0);
      expect(seen).toEqual([{ headless: true, fromProfile: source.dir }]);
      expect(loadSession(home.dir)!.fromProfile).toBe(source.dir);

      // That profile is signed out too: the CLI's own profile is tried next; its sign-in no longer names the other profile.
      saveSession(home.dir, { headers: { authorization: "Bearer t1" }, ids: { customerId: "C-1" }, fromProfile: source.dir });
      seen.length = 0;
      answers = [null, { authorization: "Bearer t3" }];
      expect((await run(["products", "show"], makeApp(loginSite(), deps))).code).toBe(0);
      expect(seen).toEqual([{ headless: true, fromProfile: source.dir }, { headless: true, fromProfile: undefined }]);
      expect(loadSession(home.dir)!.fromProfile).toBeUndefined();
    } finally {
      source.cleanup();
    }
  });

  test("the silent refresh skips a --from-profile profile it cannot open, and nothing else (#46)", async () => {
    const source = tempHome();
    try {
      const { fetch } = fakeFetch((req) => (req.headers.authorization === "Bearer t1" ? json({}, 401) : happySite(req)));
      const { deps } = makeDeps(fetch, home.dir);
      deps.env = { ...deps.env, SITE_CLI_NONINTERACTIVE: "1" };
      let seeded: Error = new ProfileUnavailable(`--from-profile: could not open ${source.dir} (in use)`);
      deps.login = async (_headless, options) => {
        if (options?.fromProfile) throw seeded;
        return { authorization: "Bearer t2" };
      };
      saveSession(home.dir, { headers: { authorization: "Bearer t1" }, ids: { customerId: "C-1" }, fromProfile: source.dir });
      expect((await run(["products", "show"], makeApp(loginSite(), deps))).code).toBe(0);

      saveSession(home.dir, { headers: { authorization: "Bearer t1" }, ids: { customerId: "C-1" }, fromProfile: source.dir });
      seeded = new Failure("input", "postLogin: no customer id");
      expect((await run(["products", "show"], makeApp(loginSite(), deps))).code).toBe(EXIT.input);
    } finally {
      source.cleanup();
    }
  });

  test("a login skill without a session signs in before running the command", async () => {
    const { deps, loginCalls } = makeDeps(fakeFetch(happySite).fetch, home.dir, [{ authorization: "Bearer t" }]);
    const { code } = await run(["products", "show"], makeApp(loginSite(), deps));
    expect(code).toBe(0);
    expect(loginCalls).toEqual([true]);
  });
});

test("ctx gives commands the session ids, the account and note", async () => {
  saveSession(home.dir, { headers: {}, ids: { customerId: "C-5" } });
  let seen: unknown;
  const probe = defineCommand({
    name: "probe it",
    summary: "",
    args: z.object({}),
    uses: [],
    run: async (_args, ctx) => {
      ctx.note("hello");
      seen = { ids: ctx.session.ids, account: ctx.account };
      return { ok: true };
    },
  });
  const { deps, notes } = makeDeps(fakeFetch(happySite).fetch, home.dir);
  const { code } = await run(["probe", "it", "--account", "X"], { ...makeApp(makeSite(), deps), commands: [probe] });
  expect(code).toBe(0);
  expect(seen).toEqual({ ids: { customerId: "C-5" }, account: "X" });
  expect(notes).toContain("hello");
});

describe("values never reach an envelope (SPEC §8, §10)", () => {
  test("a record keyed by phone number or email drifts with {} in the path, message and Fingerprint", async () => {
    const { defineOperation } = await import("../src/runtime/operation");
    const subs = defineOperation({
      name: "GET /api/subs",
      effect: "read",
      rest: { method: "GET", path: "/api/subs" },
      variables: z.object({}),
      response: z.object({ byNumber: z.record(z.string(), z.object({ status: z.string() })) }),
    });
    const show = defineCommand({ name: "subs show", summary: "s", args: z.object({}), uses: [subs], run: async (_a, { call }) => call(subs, {}) });
    const { fetch } = fakeFetch(() => json({ byNumber: { "+4522334455": { status: 1 }, "jens.hansen@example.dk": { status: 2 } } }));
    const { output, code } = await run(["subs", "show"], { ...makeApp(makeSite(), makeDeps(fetch, home.dir).deps), operations: [subs], commands: [show] });
    expect(code).toBe(3);
    const e = errorOf(output);
    expect(e.fingerprint).toBe("acme:shop:GET /api/subs:zod:byNumber.{}.status:invalid_type");
    expect(e.diff).toEqual([{ path: "byNumber.{}.status", code: "invalid_type", expected: "string", received: "number" }]);
    const text = JSON.stringify(output);
    for (const v of ["4522334455", "jens.hansen", "example.dk"]) expect(text).not.toContain(v);
  });
});

describe("--account cache", () => {
  test("labels are never saved; only ids are", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer t" }, ids: { customerId: "C-1" } });
    const site = loginSite({ accounts: async () => [{ id: "A1", label: "Jens Hansen, Vesterbrogade 1" }, { id: "A2" }] });
    await run(["products", "show", "--account", "A1"], makeApp(site, makeDeps(fakeFetch(happySite).fetch, home.dir).deps));
    expect(loadSession(home.dir)!.accounts).toEqual([{ id: "A1" }, { id: "A2" }]);
    expect(JSON.stringify(loadSession(home.dir))).not.toContain("Vesterbrogade");
  });

  test("an --account the cached list lacks makes the CLI look again before refusing", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer t" }, ids: { customerId: "C-1" }, accounts: [{ id: "A1" }, { id: "A2" }] });
    let listed = 0;
    const site = loginSite({ accounts: async () => (listed++, [{ id: "A1" }, { id: "A2" }, { id: "A3" }]) });
    const { code } = await run(["products", "show", "--account", "A3"], makeApp(site, makeDeps(fakeFetch(happySite).fetch, home.dir).deps));
    expect(code).toBe(0);
    expect(listed).toBe(1);
    expect(loadSession(home.dir)!.accounts!.map((a) => a.id)).toEqual(["A1", "A2", "A3"]);
  });

  test("several cached accounts and no --account: the list is fetched again, so the user sees labels", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer t" }, ids: { customerId: "C-1" }, accounts: [{ id: "A1" }, { id: "A2" }] });
    const site = loginSite({ accounts: async () => [{ id: "A1", label: "Mobil" }, { id: "A2", label: "Bredbånd" }] });
    const { output, code } = await run(["products", "show"], makeApp(site, makeDeps(fakeFetch(happySite).fetch, home.dir).deps));
    expect(code).toBe(2);
    expect(errorOf(output).accounts).toEqual([{ id: "A1", label: "Mobil" }, { id: "A2", label: "Bredbånd" }]);
  });

  test("auth none without bootstrap writes no session.json at all", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    let listed = 0;
    const site = makeSite({ accounts: async () => (listed++, [{ id: "A1", label: "x" }, { id: "A2" }]) });
    const app = makeApp(site, makeDeps(fakeFetch(happySite).fetch, home.dir).deps);
    expect((await run(["products", "show", "--account", "A1"], app)).code).toBe(0);
    expect(existsSync(join(home.dir, "session.json"))).toBe(false);
    expect((await run(["products", "show", "--account", "A2"], app)).code).toBe(0);
    expect(listed).toBe(2);
  });
});

describe("isEntry", () => {
  test("matches the entry module whatever its path separators", () => {
    // What a Windows binary built with Bun.build's compile option reports (Bun 1.4.3).
    expect(isEntry("B:\\~BUN\\root\\fixture", "B:/~BUN/root/fixture")).toBe(true);
    expect(isEntry("/$bunfs/root/fixture", "/$bunfs/root/fixture")).toBe(true);
    expect(isEntry("B:\\~BUN\\root\\main", "B:/~BUN/root/other")).toBe(false);
  });

  test("is false for main.ts when a test file is the entry", () => {
    expect(isEntry(join(import.meta.dir, "..", "src", "main.ts"))).toBe(false);
  });
});
