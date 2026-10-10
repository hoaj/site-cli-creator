#!/usr/bin/env bun
// bun tools/capture.ts --skill-dir <dir> --task <slug> --url <start> [--write]
//   [--script <file.ts>] [--profile <dir>] [--headless] [--origin <url>] [--login-host <host>]...
// The Capture tool (SPEC §3 step 2): drives Chrome while the user performs one
// Task and writes shapes only to <skill>/captures/<task>/. Raw traffic stays in
// memory and is never written anywhere.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type BrowserContext, type Page, type Request } from "playwright-core";
import { parseFlags, requireKebab } from "./lib/args";
import { fail, progress, runTool } from "./lib/output";
import { CaptureRecorder, shapeFileNames, type Planned } from "./lib/recorder";
import { parseHttpUrl, parseOrigin } from "./lib/scaffold";
import { redactPath } from "./lib/shape";

const USAGE =
  "bun tools/capture.ts --skill-dir <dir> --task <slug> --url <start> [--write] [--script <file.ts>] [--profile <dir>] [--headless] [--origin <url>] [--login-host <host>]";

const SETTLE_MS = 5_000;

type SiteHints = { origin?: string; loginHosts: string[] };

/** Origin and login hosts from the skill's site.ts, when it can be loaded. */
async function siteHints(skillDir: string): Promise<SiteHints> {
  const file = join(skillDir, "cli", "src", "site.ts");
  if (!existsSync(file)) return { loginHosts: [] };
  try {
    const site = (await import(pathToFileURL(file).href)).default as {
      origin?: unknown;
      login?: { hosts?: unknown };
    };
    const hosts = Array.isArray(site?.login?.hosts) ? site.login.hosts.filter((h): h is string => typeof h === "string") : [];
    const origin = typeof site?.origin === "string" && /^https?:\/\//.test(site.origin) ? site.origin : undefined;
    return { origin, loginHosts: hosts };
  } catch (error) {
    progress(`site.ts not loaded (${(error as Error).message}); using --url's origin`);
    return { loginHosts: [] };
  }
}

/** `login.example.com:8443` or a URL → `login.example.com`. */
function hostname(host: string): string {
  try {
    return new URL(host.includes("://") ? host : `https://${host}`).hostname.toLowerCase();
  } catch {
    return host.toLowerCase();
  }
}

async function launch(profile: string, headless: boolean): Promise<BrowserContext> {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const executablePath = process.env.SITE_CLI_CHROME;
  try {
    return await chromium.launchPersistentContext(profile, {
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless,
      viewport: headless ? undefined : null,
      serviceWorkers: "block",
    });
  } catch (error) {
    fail(`could not start Google Chrome: ${(error as Error).message.split("\n")[0]}`);
  }
}

function waitForStop(context: BrowserContext, interactive: boolean): Promise<string> {
  return new Promise((done) => {
    context.on("close", () => done("browser closed"));
    if (!interactive) return;
    process.once("SIGINT", () => done("interrupted"));
    if (process.stdin.readable) {
      process.stdin.on("data", (chunk) => {
        if (chunk.toString().includes("\n")) done("enter");
      });
    }
  });
}

async function loadScript(file: string): Promise<(page: Page) => Promise<void>> {
  const path = resolve(file);
  if (!existsSync(path)) fail(`no such script: ${path}`);
  let mod: { default?: unknown };
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (error) {
    // A build error is an AggregateError whose message only counts the errors; show them.
    const inner = (error as { errors?: unknown[] }).errors ?? [];
    const details = inner.map((e) => String((e as Error)?.message ?? e)).slice(0, 3);
    fail(`could not load --script ${path}: ${[(error as Error).message, ...details].join("; ")}`);
  }
  if (typeof mod.default !== "function") fail(`${path} must export default async (page) => {...}`);
  return mod.default as (page: Page) => Promise<void>;
}

function clearPreviousCapture(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".shape.json") || f === "index.json") rmSync(join(dir, f));
  }
}

await runTool(async () => {
  const { values } = parseFlags(
    process.argv.slice(2),
    {
      "skill-dir": { type: "string", required: true },
      task: { type: "string", required: true },
      url: { type: "string", required: true },
      write: { type: "boolean" },
      script: { type: "string" },
      profile: { type: "string" },
      headless: { type: "boolean" },
      origin: { type: "string" },
      "login-host": { type: "string", multiple: true },
    },
    USAGE,
  );
  const skillDir = resolve(values["skill-dir"]);
  if (!existsSync(skillDir)) fail(`no such skill dir: ${skillDir}`);
  const task = requireKebab("task", values.task);
  const startUrl = parseHttpUrl(values.url, "url").href;
  const script = values.script ? await loadScript(values.script) : undefined;

  const hints = await siteHints(skillDir);
  const origin = values.origin ? parseOrigin(values.origin) : (hints.origin ?? new URL(startUrl).origin);
  const loginHosts = [...hints.loginHosts, ...values["login-host"]].map(hostname);
  const recorder = new CaptureRecorder({ origin, loginHosts, allowWrite: values.write });

  const profile = resolve(values.profile ?? join(homedir(), ".site-cli-creator", "profile"));
  const context = await launch(profile, values.headless);

  const plans = new WeakMap<Request, Planned | null>();
  const aborted = new WeakSet<Request>();
  const pending = new Set<Promise<void>>();
  /** In-scope requests sent but not yet finished or failed. */
  const inflight = new Set<Request>();
  let open = true;
  const planOf = (req: Request): Planned | null => {
    if (!plans.has(req)) {
      plans.set(
        req,
        recorder.plan({
          method: req.method(),
          url: req.url(),
          headers: req.headers(),
          postData: req.postDataBuffer(),
          resourceType: req.resourceType(),
        }),
      );
    }
    return plans.get(req) ?? null;
  };
  const track = (req: Request, work: () => Promise<void>) => {
    if (!open) return;
    const p = work()
      .catch(() => {})
      .finally(() => inflight.delete(req));
    pending.add(p);
    p.finally(() => pending.delete(p));
  };

  context.on("request", (req) => {
    if (planOf(req)) inflight.add(req);
  });
  await context.route("**/*", async (route) => {
    const req = route.request();
    const plan = planOf(req);
    if (plan && recorder.shouldAbort(plan)) {
      aborted.add(req);
      progress(`aborted write: ${plan.calls.map((c) => c.shape.operation).join(", ")}`);
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    if (plan?.effect === "write") {
      const what = plan.loginFlow ? "let sign-in step through" : "let write through";
      progress(`${what}: ${plan.calls.map((c) => c.shape.operation).join(", ")}`);
    }
    await route.continue().catch(() => {});
  });
  context.on("requestfinished", (req) =>
    track(req, async () => {
      const plan = planOf(req);
      if (!plan) return;
      const response = await req.response();
      const headers = await req.allHeaders().catch(() => req.headers());
      if (!response) return recorder.record(plan, { headers });
      const body = await response.body().catch(() => null);
      const responseHeaders = await response.allHeaders().catch(() => response.headers());
      recorder.record(plan, { headers, response: { status: response.status(), headers: responseHeaders, body } });
    }),
  );
  context.on("requestfailed", (req) =>
    track(req, async () => {
      const plan = planOf(req);
      if (plan) recorder.record(plan, { headers: req.headers(), aborted: aborted.has(req) });
    }),
  );

  const stop = waitForStop(context, !script);
  const page = context.pages()[0] ?? (await context.newPage());
  let scriptError: Error | undefined;
  let stoppedBy: string;
  try {
    await page.goto(startUrl);
  } catch (error) {
    if (script) scriptError = new Error(`could not open --url: ${(error as Error).message.split("\n")[0]}`);
    else progress(`could not open --url (${(error as Error).message.split("\n")[0]}); navigate in the browser`);
  }
  if (script && !scriptError) {
    try {
      await script(page);
    } catch (error) {
      scriptError = error as Error;
    }
    stoppedBy = scriptError ? "script failed" : "script finished";
  } else if (script) {
    stoppedBy = "script failed";
  } else {
    progress("Perform the Task in Chrome, then close the browser or press Enter here.");
    stoppedBy = await stop;
  }

  // fetch() resolves on headers, so a script can end before its bodies arrive.
  const deadline = Date.now() + SETTLE_MS;
  while ((inflight.size > 0 || pending.size > 0) && Date.now() < deadline) await Bun.sleep(50);
  open = false;
  for (const req of inflight) {
    const plan = planOf(req);
    if (plan) recorder.record(plan, { headers: req.headers() });
  }
  await context.close().catch(() => {});
  process.stdin.pause();

  const operations = recorder.operations();
  const dir = join(skillDir, "captures", task);
  if (operations.length === 0) {
    const why = scriptError ? `--script failed: ${scriptError.message.split("\n")[0]}; ` : "";
    fail(`${why}no calls to ${origin} were recorded, so ${dir} was left as it was`);
  }
  const files = shapeFileNames(operations, recorder.originHostname);
  mkdirSync(dir, { recursive: true });
  clearPreviousCapture(dir);
  operations.forEach((op, i) => writeFileSync(join(dir, files[i] as string), `${JSON.stringify(op, null, 2)}\n`));
  const index = {
    task,
    startPath: redactPath(new URL(startUrl).pathname),
    write: values.write,
    operations: operations.map((op, i) => ({
      operation: op.operation,
      kind: op.kind,
      effect: op.effect,
      ...(op.loginFlow ? { loginFlow: true } : {}),
      method: op.method,
      host: op.host,
      path: op.path,
      file: files[i],
      seen: op.seen,
      aborted: op.aborted,
    })),
  };
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  if (scriptError) fail(`--script failed: ${scriptError.message.split("\n")[0]} (shapes so far written to ${dir})`);
  return {
    task,
    dir,
    stoppedBy,
    operations: index.operations.map(({ operation, effect, loginFlow, file, aborted: n }) => ({
      operation,
      effect,
      ...(loginFlow ? { loginFlow } : {}),
      file,
      aborted: n,
    })),
  };
});
