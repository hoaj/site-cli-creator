#!/usr/bin/env bun
// bun tools/capture.ts --skill-dir <dir> --task <slug> --url <start> [--write] [--write-op <op>]
//   [--allow-read <op>]... [--script <file.ts>] [--profile <dir>] [--headless] [--origin <url>] [--login-host <host>]...
// The Capture tool (SPEC §3 step 2): drives Chrome while the user performs one
// Task and writes shapes only to <skill>/captures/<task>/. Raw traffic stays in
// memory and is never written anywhere. A read Task aborts every write on every
// host except sign-in steps; --write lets the Task's one write through.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type BrowserContext, type Page, type Request } from "playwright-core";
import { parseFlags, requireKebab } from "./lib/args";
import { fail, progress, runTool } from "./lib/output";
import { CaptureRecorder, markers, shapeFileNames, type Planned } from "./lib/recorder";
import { parseHttpUrl, parseOrigin } from "./lib/scaffold";
import { redactPath } from "./lib/shape";
import { loginHostName } from "../starter/skill/cli/src/runtime/site";

const USAGE =
  "bun tools/capture.ts --skill-dir <dir> --task <slug> --url <start> [--write] [--write-op <op>] [--allow-read <op>] [--script <file.ts>] [--profile <dir>] [--headless] [--origin <url>] [--login-host <host>]";

const NOTES = [
  "--script <file.ts> must `export default async (page) => { ... }` (page is a Playwright Page). The tool has already opened --url (and followed its redirects, to a login host too) when the function is called; the Capture stops when it resolves. Drive the page with real input (page.click, page.fill, page.press, locators), not element.click() inside page.evaluate: --write counts only real clicks, key presses and submits.",
  "Without --script, Chrome opens headed: the user performs the Task, then closes the Task window or presses Enter in the terminal. The Capture ends when no window on the site is left open (windows on other sites, such as a shop the page opened, close with it); a tab the site opened on its own hosts keeps it going. SIGINT or SIGTERM (kill -INT <pid>; stderr prints the pid) is a clean stop that still writes the Capture: use it to end a Capture you run in the background.",
  "Hosts are host names without scheme or port (login.example.com).",
  "The profile (~/.site-cli-creator/profile/ by default) keeps cookies between Captures; pass --profile <empty dir> to see a site set its cookies from scratch.",
];

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

async function launch(profile: string, headless: boolean): Promise<BrowserContext> {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const executablePath = process.env.SITE_CLI_CHROME;
  try {
    return await chromium.launchPersistentContext(profile, {
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless,
      viewport: headless ? undefined : null,
      serviceWorkers: "block",
      // SIGINT and SIGTERM stop the Capture cleanly (watchStop): the browser closes after the shapes are written.
      handleSIGINT: false,
      handleSIGTERM: false,
    });
  } catch (error) {
    fail(`could not start Google Chrome: ${(error as Error).message.split("\n")[0]}`);
  }
}

/** How often a headed Capture reminds stderr that it is still recording (SITE_CLI_CAPTURE_HINT_MS overrides). */
const HINT_MS = Number(process.env.SITE_CLI_CAPTURE_HINT_MS) || 30_000;

/** How long a failed --script waits for the stop its failure may come from (the Task window closing). */
const STOP_GRACE_MS = 1_000;

/** `stoppedBy` is set the moment the Capture stops, before `reason`'s callbacks run. */
type Stop = { reason: Promise<string>; readonly stoppedBy?: string; dispose(): void };

/**
 * What ends a Capture besides a --script finishing: the browser closing; the last window on the
 * recorded hosts closing (the Task window, the first page, counts even when it had left them), even
 * while windows on other sites (a shop the page opened) stay open: capture.ts closes those. A tab the
 * site opened on its own hosts keeps the Capture going after the first one closes. SIGINT or SIGTERM,
 * a clean stop that still writes the Capture (how an agent ends a Capture it runs in the
 * background); and Enter in the terminal.
 */
function watchStop(context: BrowserContext, first: Page, inScope: (url: string) => boolean, interactive: boolean): Stop {
  let stoppedBy: string | undefined;
  let resolveReason!: (reason: string) => void;
  const reason = new Promise<string>((resolve) => (resolveReason = resolve));
  const done = (why: string) => {
    stoppedBy ??= why;
    resolveReason(stoppedBy);
  };
  context.on("close", () => done("browser closed"));
  const onPageClose = (closed: Page, lastUrl: string) => {
    const open = context.pages().filter((p) => p !== closed && !p.isClosed());
    // The Task goes on in another window on the site (a tab it opened): keep recording.
    if (open.some((p) => inScope(p.url()))) return;
    if (closed === first || inScope(lastUrl)) done("task window closed");
  };
  const watch = (page: Page) => {
    let lastUrl = page.url();
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) lastUrl = frame.url();
    });
    page.on("close", () => onPageClose(page, lastUrl));
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  const onSignal = (signal: NodeJS.Signals) => done(signal);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const onData = (chunk: Buffer) => {
    if (chunk.toString().includes("\n")) done("enter");
  };
  if (interactive && process.stdin.readable) process.stdin.on("data", onData);
  let hint: ReturnType<typeof setInterval> | undefined;
  if (interactive) {
    hint = setInterval(() => {
      const n = context.pages().filter((p) => !p.isClosed()).length;
      progress(
        `still recording: ${n} window${n === 1 ? "" : "s"} open; close the site's windows (windows on other sites close with them), press Enter here, or run: kill -INT ${process.pid}`,
      );
    }, HINT_MS);
  }
  return {
    reason,
    get stoppedBy() {
      return stoppedBy;
    },
    dispose() {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.stdin.off("data", onData);
      if (hint) clearInterval(hint);
    },
  };
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
      "skill-dir": { type: "string", required: true, help: "the CLI skill's folder; the Capture goes to <skill-dir>/captures/<task>/" },
      task: { type: "string", required: true, help: "the Task's slug, kebab-case (subscription-show)" },
      url: { type: "string", required: true, help: "the page the Task starts from" },
      write: {
        type: "boolean",
        help: "a write Task: one write goes through for real, the first after the user's first click, key press or submit (writes the page fires on its own while loading are aborted)",
      },
      "write-op": { type: "string", help: "with --write: the write that may go through, as the Capture names it (a GraphQL operationName or REST `METHOD /path`)" },
      "allow-read": {
        type: "string",
        multiple: true,
        help: "a non-GET request that only reads (a POST search, a persisted GraphQL query), as a GraphQL operationName or a part of host/path: it goes through instead of being aborted",
      },
      script: { type: "string", help: "a module that drives the page instead of a person (see notes)" },
      profile: { type: "string", help: "Chrome profile dir (default ~/.site-cli-creator/profile/)" },
      headless: { type: "boolean", help: "no visible window; only useful with --script" },
      origin: { type: "string", help: "record calls to this origin instead of site.ts's origin (an API on another host)" },
      "login-host": { type: "string", multiple: true, help: "a login host not yet in site.ts; its requests are sign-in steps" },
    },
    USAGE,
    0,
    NOTES,
  );
  const skillDir = resolve(values["skill-dir"]);
  if (!existsSync(skillDir)) fail(`no such skill dir: ${skillDir}`);
  const task = requireKebab("task", values.task);
  const startUrl = parseHttpUrl(values.url, "url").href;
  const script = values.script ? await loadScript(values.script) : undefined;

  const site = await siteHints(skillDir);
  const origin = values.origin ? parseOrigin(values.origin) : (site.origin ?? new URL(startUrl).origin);
  const loginHosts = [...site.loginHosts, ...values["login-host"]].map(loginHostName);
  if (values["write-op"] && !values.write) fail("--write-op needs --write");
  const recorder = new CaptureRecorder({
    origin,
    loginHosts,
    allowWrite: values.write,
    writeOp: values["write-op"],
    allowRead: values["allow-read"],
  });

  const profile = resolve(values.profile ?? join(homedir(), ".site-cli-creator", "profile"));
  const context = await launch(profile, values.headless);

  const plans = new WeakMap<Request, Planned | null>();
  /** Paths of server actions already explained on stderr. */
  const hintedActions = new Set<string>();
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

  // --write lets through the first write after a real click, key press or submit in the page;
  // a new main-frame document starts over, so writes a page fires on its own while loading are aborted.
  await context.exposeBinding("__siteCliGesture", () => recorder.noteGesture());
  await context.addInitScript(() => {
    for (const type of ["pointerdown", "keydown", "submit"]) {
      addEventListener(
        type,
        (event) => {
          if (event.isTrusted) (window as unknown as { __siteCliGesture?: () => void }).__siteCliGesture?.();
        },
        true,
      );
    }
  });
  const isPageLoad = (req: Request): boolean => {
    try {
      return req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame();
    } catch {
      return false; // a service worker's request has no frame
    }
  };

  context.on("request", (req) => {
    if (planOf(req)) inflight.add(req);
  });
  await context.route("**/*", async (route) => {
    const req = route.request();
    const plan = planOf(req);
    let abort = false;
    if (!plan && !recorder.allowElsewhere({ method: req.method(), url: req.url(), resourceType: req.resourceType() })) {
      progress(`aborted write outside the recorded hosts: ${req.method()} ${new URL(req.url()).host} (not recorded)`);
      abort = true;
    } else if (plan && recorder.shouldAbort(plan)) {
      aborted.add(req);
      const names = plan.calls.map((c) => c.shape.operation).join(", ");
      progress(`aborted write: ${names}`);
      // A read Task aborts Next.js server actions too, and the page may show an error: say why at once.
      const path = plan.calls[0]?.shape.path;
      if (plan.serverAction && path && !hintedActions.has(path)) {
        hintedActions.add(path);
        progress(`server action aborted (${names}): if the page breaks, capture again with --allow-read ${path}`);
      }
      abort = true;
    } else if (plan?.effect === "write") {
      const what = plan.loginFlow ? "let sign-in step through" : plan.allowedRead ? "let --allow-read request through" : "let write through";
      progress(`${what}: ${plan.calls.map((c) => c.shape.operation).join(", ")}`);
    }
    // Decided first: a form POST is both the user's write and a page load.
    if (isPageLoad(req)) recorder.noteNavigation();
    if (abort) await route.abort("blockedbyclient").catch(() => {});
    else await route.continue().catch(() => {});
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

  const page = context.pages()[0] ?? (await context.newPage());
  const stop = watchStop(context, page, (url) => recorder.inScope(url), !script);
  let scriptError: Error | undefined;
  let stoppedBy: string;
  try {
    await page.goto(startUrl);
  } catch (error) {
    if (script) scriptError = new Error(`could not open --url: ${(error as Error).message.split("\n")[0]}`);
    else progress(`could not open --url (${(error as Error).message.split("\n")[0]}); navigate in the browser`);
  }
  if (script && !scriptError) {
    const finished = script(page).then(
      () => "script finished",
      async (error) => {
        // A script still waiting when the Task window closed fails with it: that is the stop, not a
        // script error. Its failure can arrive just before the close event, so wait briefly for it.
        const stopped = stop.stoppedBy ?? (await Promise.race([stop.reason, Bun.sleep(STOP_GRACE_MS).then(() => undefined)]));
        if (stopped) return stopped;
        scriptError = error as Error;
        return "script failed";
      },
    );
    stoppedBy = await Promise.race([finished, stop.reason]);
  } else if (script) {
    stoppedBy = "script failed";
  } else {
    progress(
      `Perform the Task in Chrome, then close the Task window or press Enter here. Capture pid ${process.pid}: kill -INT ${process.pid} stops it cleanly too.`,
    );
    stoppedBy = await stop.reason;
  }
  stop.dispose();
  // Windows on other sites still open when the last one on the site closed (a shop the page opened): closed with the browser.
  const closedWindows = stoppedBy === "task window closed" ? context.pages().filter((p) => !p.isClosed()).length : 0;
  if (closedWindows) progress(`closing ${closedWindows} other window${closedWindows === 1 ? "" : "s"} still open`);

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
  const files = shapeFileNames(operations, new URL(origin).hostname);
  mkdirSync(dir, { recursive: true });
  clearPreviousCapture(dir);
  operations.forEach((op, i) => writeFileSync(join(dir, files[i] as string), `${JSON.stringify(op, null, 2)}\n`));
  // Host names only: where the sign-in went, so site.ts login.hosts can list them.
  const signInHosts = [...recorder.signInHosts].sort();
  const index = {
    task,
    startPath: recorder.redactValues(redactPath(new URL(startUrl).pathname)),
    write: values.write,
    ...(recorder.wrote ? { wrote: recorder.wrote } : {}),
    ...(signInHosts.length ? { loginHosts: signInHosts } : {}),
    operations: operations.map((op, i) => ({
      operation: op.operation,
      kind: op.kind,
      effect: op.effect,
      ...markers(op),
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
  const blockedElsewhere = [...recorder.blockedElsewhere].sort();
  const hints: string[] = [];
  if (values.write && !recorder.wrote) {
    hints.push(
      "No write went through: none came after a click, key press or submit" +
        (values["write-op"] ? ` and matched --write-op ${values["write-op"]}` : "") +
        ". Check the aborted writes below and capture again (with --write-op <operation> to name the Task's write).",
    );
  }
  if (operations.some((op) => op.effectUnknown && !op.serverAction)) {
    hints.push("effectUnknown: a persisted GraphQL query (hash only) was treated as a write and aborted. If it only reads, capture again with --allow-read <operationName>.");
  }
  if (operations.some((op) => op.serverAction || op.rsc)) {
    hints.push(
      "Next.js: serverAction (a POST with a next-action header) and rsc (a text/x-component stream) are never Operations. If an aborted server action broke the page, capture again with --allow-read <its path>. Look for the JSON /api route the page also calls (reference/add-task.md, Next.js sites).",
    );
  }
  const declared = new Set(loginHosts);
  const undeclared = signInHosts.filter((h) => !declared.has(h));
  if (undeclared.length > 0) {
    hints.push(
      `Sign-in went through ${undeclared.join(", ")} (loginHosts): add ${undeclared.length === 1 ? "it" : "them"} to site.ts login.hosts (host names, no port), or pass --login-host until then. Leave out a host that only served a token to the site's own pages.`,
    );
  }
  if (blockedElsewhere.length > 0) {
    hints.push("Writes to hosts outside the recorded scope were aborted (blockedElsewhere). A sign-in host among them: add --login-host <host>. The site's own API: pass --origin <url>.");
  }
  return {
    task,
    dir,
    stoppedBy,
    ...(closedWindows ? { closedWindows } : {}),
    ...(recorder.wrote ? { wrote: recorder.wrote } : {}),
    operations: index.operations.map(({ kind: _kind, method: _method, host: _host, path: _path, seen: _seen, ...op }) => op),
    ...(signInHosts.length ? { loginHosts: signInHosts } : {}),
    ...(blockedElsewhere.length ? { blockedElsewhere } : {}),
    ...(hints.length ? { hints } : {}),
  };
});
