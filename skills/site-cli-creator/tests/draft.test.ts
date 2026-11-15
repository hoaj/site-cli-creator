import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequest } from "../starter/skill/cli/src/runtime/call";
import { capturedVariables, compareWrite, parseCaptured } from "../starter/skill/cli/src/runtime/check";
import { extractHtml } from "../starter/skill/cli/src/runtime/html";
import { draftOperation, namePathParams, operationFileName } from "../tools/lib/draft";
import { fromSource } from "../tools/lib/draft-html";
import { GENERATOR_ROOT, SKILL_ROOT } from "../tools/lib/paths";
import { CaptureRecorder, type OperationShape, type RequestInfo } from "../tools/lib/recorder";

const TOOL = join(SKILL_ROOT, "tools", "draft-contract.ts");
const RUNTIME = join(SKILL_ROOT, "starter", "skill", "cli", "src", "runtime");
const RUNTIME_OPERATION = join(RUNTIME, "operation.ts");
const ORIGIN = "https://www.shop.example";
const json = (v: unknown) => Buffer.from(JSON.stringify(v));

const accountBody = {
  data: {
    getAccount: {
      id: "A-1",
      name: "x",
      "kebab-key": 1,
      plan: { price: 1.5, currency: "DKK" },
      tags: ["a"],
      endsAt: null,
      lines: [{ msisdn: "1", roaming: true }, { msisdn: "2" }],
    },
  },
};

function capture(requests: { req: Partial<RequestInfo> & { url: string }; status?: number; body?: unknown; aborted?: boolean }[]) {
  const r = new CaptureRecorder({ origin: ORIGIN });
  for (const { req, status = 200, body, aborted } of requests) {
    const plan = r.plan({ method: "GET", headers: {}, postData: null, resourceType: "fetch", ...req })!;
    r.record(plan, aborted ? { aborted } : { response: { status, headers: { "content-type": "application/json" }, body: json(body) } });
  }
  return r.operations();
}

const [graphqlOp] = capture([
  {
    req: {
      url: `${ORIGIN}/graphql`,
      method: "POST",
      postData: json({
        operationName: "getAccount",
        query: "query getAccount($customerId: ID!) {\n  getAccount(customerId: $customerId) { id name `tick` ${x} }\n}",
        variables: { customerId: "C-1", filter: { since: null } },
      }),
    },
    body: accountBody,
  },
]) as [OperationShape];

const [restOp] = capture([
  {
    req: {
      url: `${ORIGIN}/api/customers/123456/invoices/987654?status=open&page=1`,
      method: "PATCH",
      headers: { "content-type": "application/json" },
      postData: json({ note: "n", flags: { pinned: true } }),
    },
    body: { invoice: { id: "I", total: 10, lines: [] } },
  },
]) as [OperationShape];

const [abortedWrite] = capture([
  { req: { url: `${ORIGIN}/graphql`, method: "POST", postData: json({ query: "mutation addNote($text: String!) { addNote(text: $text) { id } }", variables: { text: "t" } }) }, aborted: true },
]) as [OperationShape];

let work: string;

/** A throwaway cli/ where zod and playwright-core resolve and runtime/operation.ts exists. */
function scaffoldCli(): string {
  const cli = join(work, "cli");
  mkdirSync(join(cli, "src", "operations"), { recursive: true });
  mkdirSync(join(cli, "src", "runtime"), { recursive: true });
  symlinkSync(join(GENERATOR_ROOT, "node_modules"), join(cli, "node_modules"));
  const operationTs = join(cli, "src", "runtime", "operation.ts");
  if (existsSync(RUNTIME_OPERATION)) copyFileSync(RUNTIME_OPERATION, operationTs);
  else writeFileSync(operationTs, "export const defineOperation = <T>(op: T): T => op;\n");
  // operation.ts names html.ts's types, and html.ts throws envelope.ts's ContractError.
  for (const file of ["html.ts", "envelope.ts"]) if (existsSync(join(RUNTIME, file))) copyFileSync(join(RUNTIME, file), join(cli, "src", "runtime", file));
  return cli;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "draft-test-"));
  scaffoldCli();
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function importDraft(file: string, source: string) {
  const path = join(work, "cli", "src", "operations", file);
  writeFileSync(path, source);
  return (await import(path)).default as {
    name: string;
    effect: string;
    graphql?: string;
    rest?: { method: string; path: string; query?: (v: any) => unknown; body?: (v: any) => unknown };
    html?: { from?: (body: unknown) => unknown; fields: Parameters<typeof extractHtml>[1] };
    variables: import("zod").ZodType;
    response: import("zod").ZodType;
  };
}

describe("draftOperation", () => {
  test("GraphQL: compiles, keeps the captured query, parses what was captured", async () => {
    const { name, source } = draftOperation(graphqlOp, { from: "captures/account-show/getAccount.shape.json" });
    expect(name).toBe("getAccount");
    expect(source.split("\n")[0]).toBe("// From captures/account-show/getAccount.shape.json (GraphQL query).");
    const op = await importDraft("getAccount.ts", source);
    expect(op.name).toBe("getAccount");
    expect(op.effect).toBe("read");
    expect(op.graphql).toBe("query getAccount($customerId: ID!) {\n  getAccount(customerId: $customerId) { id name `tick` ${x} }\n}");
    expect(op.response.safeParse(accountBody).success).toBe(true);
    expect(op.variables.safeParse({ customerId: "C", filter: { since: null } }).success).toBe(true);
    // endsAt was only seen as null: its type is unknown, not null; lines[].roaming only sometimes
    expect(source).toContain("endsAt: z.unknown().nullable() /* TODO: only null was seen; decide the type */");
    expect(source).not.toContain("z.null()");
    expect(source).toContain("msisdn: z.string() /* numeric string */");
    expect(source).toContain("roaming: z.boolean().optional()");
    expect(source).toContain('"kebab-key": z.number()');
    const drifted = structuredClone(accountBody) as any;
    drifted.data.getAccount.plan.price = "1.5";
    expect(op.response.safeParse(drifted).success).toBe(false);
  });

  test("REST: path params, query and body become variables", async () => {
    const { name, source } = draftOperation(restOp);
    expect(name).toBe("PATCH /api/customers/:id/invoices/:id");
    const op = await importDraft("patchInvoice.ts", source);
    expect(op.rest?.method).toBe("PATCH");
    expect(op.rest?.path).toBe("/api/customers/:id/invoices/:id2");
    // A JSON object body's fields are variables of their own, next to path params and query (as check reads them).
    const vars = { id: "1", id2: "2", status: "open", page: "1", note: "n", flags: { pinned: true } };
    expect(op.variables.safeParse(vars).success).toBe(true);
    expect(op.rest?.query?.(vars)).toEqual({ status: "open", page: "1" });
    expect(op.rest?.body?.(vars)).toEqual({ note: "n", flags: { pinned: true } });
    expect(op.rest).not.toHaveProperty("bodyType");
    expect(op.effect).toBe("write");
    expect(op.response.safeParse({ invoice: { id: "I", total: 1, lines: [] } }).success).toBe(true);
    expect(source).toContain("trigger(page)");
  });

  test("a drafted REST write passes check --writes against a page that sends exactly the captured body", async () => {
    const page = { note: "n", flags: { pinned: true } };
    const [write] = capture([
      { req: { url: `${ORIGIN}/api/customers/123456/notes`, method: "POST", headers: { "content-type": "application/json" }, postData: json(page) }, aborted: true },
    ]) as [OperationShape];
    const op = (await importDraft("createNote.ts", draftOperation(write).source)) as any;
    const site = { plugin: "p", skill: "s" } as any;
    const captured = { method: "POST", url: new URL(`${ORIGIN}/api/customers/123456/notes`), body: page, contentType: "application/json" };
    expect(compareWrite(site, op, captured)).toBeNull();
    // ...and the CLI sends the same body back.
    const sent = buildRequest(op, capturedVariables(op, captured), { origin: ORIGIN, headers: {} });
    expect(JSON.parse(sent.body!)).toEqual(page);
    expect(sent.headers["content-type"]).toBe("application/json");
    // A body that changed shape is still request Drift.
    expect(compareWrite(site, op, { ...captured, body: { text: "n" } })?.fingerprint).toBe("p:s:POST /api/customers/{id}/notes:request:note:invalid_type");
  });

  test("a form-urlencoded REST write drafts bodyType form, and check and call agree on it", async () => {
    const [write] = capture([
      { req: { url: `${ORIGIN}/api/orders/7`, method: "PATCH", headers: { "content-type": "application/x-www-form-urlencoded" }, postData: Buffer.from("name=New+Name&qty=2") }, aborted: true },
    ]) as [OperationShape];
    const { source } = draftOperation(write);
    expect(source).toContain('bodyType: "form"');
    const op = (await importDraft("updateOrder.ts", source)) as any;
    const site = { plugin: "p", skill: "s" } as any;
    const contentType = "application/x-www-form-urlencoded";
    const captured = { method: "PATCH", url: new URL(`${ORIGIN}/api/orders/7`), body: parseCaptured("name=New+Name&qty=2", contentType), contentType };
    expect(compareWrite(site, op, captured)).toBeNull();
    const sent = buildRequest(op, capturedVariables(op, captured), { origin: ORIGIN, headers: {} });
    expect(sent.headers["content-type"]).toBe(contentType);
    expect(sent.body).toBe("name=New+Name&qty=2");
  });

  test("a JSON body that is not an object stays one `body` variable", async () => {
    const [write] = capture([
      { req: { url: `${ORIGIN}/api/tags`, method: "PUT", headers: { "content-type": "application/json" }, postData: json(["a", "b"]) }, aborted: true },
    ]) as [OperationShape];
    const op = (await importDraft("updateTag.ts", draftOperation(write).source)) as any;
    const captured = { method: "PUT", url: new URL(`${ORIGIN}/api/tags`), body: ["a", "b"], contentType: "application/json" };
    expect(compareWrite({ plugin: "p", skill: "s" } as any, op, captured)).toBeNull();
    expect(JSON.parse(buildRequest(op, capturedVariables(op, captured), { origin: ORIGIN, headers: {} }).body!)).toEqual(["a", "b"]);
  });

  test("a JSON object body keyed by data: its keys are variables too, and check agrees", async () => {
    const page = { "12345678": { qty: 1 }, "87654321": { qty: 2 } };
    const [write] = capture([
      { req: { url: `${ORIGIN}/api/carts/42?mode=x`, method: "PUT", headers: { "content-type": "application/json" }, postData: json(page) }, aborted: true },
    ]) as [OperationShape];
    const op = (await importDraft("updateCart.ts", draftOperation(write).source)) as any;
    const captured = { method: "PUT", url: new URL(`${ORIGIN}/api/carts/42?mode=x`), body: page, contentType: "application/json" };
    expect(compareWrite({ plugin: "p", skill: "s" } as any, op, captured)).toBeNull();
    expect(JSON.parse(buildRequest(op, capturedVariables(op, captured), { origin: ORIGIN, headers: {} }).body!)).toEqual(page);
  });

  test("aborted write: unknown response, still compiles", async () => {
    const { source } = draftOperation(abortedWrite, { name: "addNote" });
    expect(source).toContain("the request was aborted during the Capture");
    const op = await importDraft("addNote.ts", source);
    expect(op.effect).toBe("write");
    expect(op.variables.safeParse({ text: "t" }).success).toBe(true);
  });

  test("a sign-in step the Capture let through points at site.ts instead of trigger(page)", () => {
    const [token] = capture([{ req: { url: `${ORIGIN}/oauth/token`, method: "POST" }, body: { access_token: "x" } }]);
    expect(token!.loginFlow).toBe(true);
    const { source } = draftOperation(token!);
    expect(source).toContain("sign-in step");
    expect(source).not.toContain("trigger(page)");
  });

  // A server-rendered page (#102): no </li>, inline JSON, a link and a date per item, a data id.
  const EVENTS = `<!doctype html><html><head><script type="application/ld+json">{"name":"n","startDate":"2026-01-01"}</script></head><body>
<main class="content"><ul><li class="event" data-id="e1"><h2 class="title">Koncert</h2><a href="/e/1">mere</a><time datetime="2026-12-01">1. dec</time>
<li class="event" data-id="e2"><h2 class="title">Foredrag</h2><a href="/e/2">mere</a><time datetime="2026-12-02">2. dec</time></ul></main></body></html>`;
  const htmlCapture = (url: string, body: string, contentType: string, resourceType = "document") => {
    const r = new CaptureRecorder({ origin: ORIGIN });
    const plan = r.plan({ method: "GET", url, headers: {}, postData: null, resourceType })!;
    r.record(plan, { response: { status: 200, headers: { "content-type": contentType }, body: Buffer.from(body) } });
    return r.operations()[0]!;
  };

  test("an HTML page drafts html.fields that pick every item's values from the page it was drafted from (#102)", async () => {
    const shape = htmlCapture(`${ORIGIN}/events?from=2026-01-01`, EVENTS, "text/html; charset=utf-8");
    const { source } = draftOperation(shape);
    expect(source).toContain('each: "li.event", in: "main.content ul"');
    expect(source).toContain("A page load (a document request)");
    const op = await importDraft("listEvents.ts", source);
    expect(op.rest?.query?.({ from: "x" })).toEqual({ from: "x" });
    const picked = extractHtml(EVENTS, op.html!.fields);
    expect(picked.ok).toBe(true);
    const value = (picked as { value: any }).value;
    expect(op.response.safeParse(value).success).toBe(true);
    const [first] = Object.values(value) as any[][];
    expect(first).toHaveLength(2);
    expect(Object.values(first![1])).toEqual(expect.arrayContaining(["e2", "Foredrag", "/e/2", "2026-12-02"]));
  });

  test("a query key seen on only some loads of a page drafts as optional, so check can call it with none (#102, cold read)", async () => {
    const r = new CaptureRecorder({ origin: ORIGIN });
    for (const url of [`${ORIGIN}/events`, `${ORIGIN}/events?area=x&page=2`, `${ORIGIN}/events?page=1`]) {
      const plan = r.plan({ method: "GET", url, headers: {}, postData: null, resourceType: "document" })!;
      r.record(plan, { response: { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(EVENTS) } });
    }
    const [shape] = r.operations();
    expect(shape!.request.query).toEqual({ type: "object", fields: { area: { type: "string" }, page: { type: "string" } }, optional: ["area", "page"] });
    const { source } = draftOperation(shape!);
    const op = await importDraft("listEventsByArea.ts", source);
    expect(op.variables.safeParse({}).success).toBe(true);
    expect(op.variables.safeParse({ area: "x" }).success).toBe(true);
    expect(op.rest?.query?.({ area: "x" })).toEqual({ area: "x", page: undefined });
  });

  test("a JSON API with a rich-text field drafts its JSON response, naming the HTML strings in a comment (review)", async () => {
    const items = [1, 2].map((id) => ({ id, name: "n", price: 10.5, descriptionHtml: "<p>Fin <b>vare</b></p>" }));
    const { source } = draftOperation(htmlCapture(`${ORIGIN}/api/products`, JSON.stringify({ items }), "application/json", "fetch"));
    expect(source).not.toContain("html: {");
    expect(source).toContain("items[].descriptionHtml");
    const op = await importDraft("listProducts.ts", source);
    expect(op.response.safeParse({ items }).success).toBe(true);
  });

  test("a repeated element inside an item drafts as all: true, so no value is lost (review)", async () => {
    const page = `<ul class="l">${[1, 2].map((i) => `<li class="e"><h3 class="t">T${i}</h3><span>tag${i}a</span><span>tag${i}b</span></li>`).join("")}</ul>`;
    const { source } = draftOperation(htmlCapture(`${ORIGIN}/tags`, page, "text/html"));
    expect(source).toContain('{ css: "span", all: true }');
    const op = await importDraft("listTags.ts", source);
    const picked = extractHtml(page, op.html!.fields) as { ok: true; value: Record<string, any[]> };
    expect(op.response.safeParse(picked.value).success).toBe(true);
    expect(Object.values(picked.value)[0]![1]).toMatchObject({ text: ["tag2a", "tag2b"] });
  });

  test("html.from for a JSON answer that is one HTML string, and for keys that are no identifiers (review)", () => {
    expect(fromSource("")).toBe("(body: any) => body");
    expect(fromSource("content-html")).toBe('(body: any) => body?.["content-html"]');
    expect(fromSource("data.view.rendered")).toBe("(body: any) => body?.data?.view?.rendered");
    expect(fromSource("[].data-html")).toBe('(body: any) => (Array.isArray(body) ? body : []).find((item: any) => typeof item?.["data-html"] === "string")?.["data-html"]');
    expect(fromSource("{}.html")).toContain("TODO");
  });

  test("a page with no repeated element drafts a field per element with text, and inline JSON as json: true (#102)", async () => {
    const page = `<html><head><script type="application/ld+json">{"name":"n","price":1}</script></head><body><article class="event"><h1 class="name">x</h1><p class="where">y</p></article></body></html>`;
    const { source } = draftOperation(htmlCapture(`${ORIGIN}/event/:id`, page, "text/html"));
    expect(source).toContain('json: true');
    const op = await importDraft("getEvent.ts", source);
    const picked = extractHtml(page, op.html!.fields) as { ok: true; value: Record<string, unknown> };
    expect(picked.ok).toBe(true);
    expect(op.response.safeParse(picked.value).success).toBe(true);
    expect(Object.values(picked.value)).toEqual(expect.arrayContaining([{ name: "n", price: 1 }, "x", "y"]));
  });

  test("a JSON answer that carries HTML drafts html.from for that place, which finds it (#102)", async () => {
    const commands = [{ command: "settings", settings: {} }, { command: "insert", data: EVENTS.replace(/^[\s\S]*<main/, "<main").replace(/<\/body>[\s\S]*$/, "") }];
    const { source } = draftOperation(htmlCapture(`${ORIGIN}/views/ajax`, JSON.stringify(commands), "application/json", "xhr"));
    expect(source).toContain("carries HTML at [].data");
    const op = await importDraft("getViewsAjax.ts", source);
    const html = op.html!.from!(commands);
    expect(typeof html).toBe("string");
    const picked = extractHtml(html as string, op.html!.fields) as { ok: true; value: Record<string, unknown> };
    expect(op.response.safeParse(picked.value).success).toBe(true);
  });

  test("drafts type-check against the runtime's Operation type", () => {
    const tsc = Bun.spawnSync(
      [process.execPath, "x", "tsc", "--noEmit", "--strict", "--skipLibCheck", "--target", "esnext", "--module", "esnext",
        "--moduleResolution", "bundler", "--types", "bun", ...["getAccount.ts", "patchInvoice.ts", "addNote.ts", "createNote.ts", "updateOrder.ts", "updateTag.ts", "updateCart.ts", "listEvents.ts", "getViewsAjax.ts", "getEvent.ts", "listProducts.ts", "listTags.ts"].map((f) => join(work, "cli", "src", "operations", f))],
      { cwd: GENERATOR_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("");
    expect(tsc.exitCode).toBe(0);
  });

  test("a persisted query (hash only) says its effect is unknown", async () => {
    const [apq] = capture([{ req: { url: `${ORIGIN}/graphql`, method: "POST", postData: json({ operationName: "getPlan", extensions: { persistedQuery: { sha256Hash: "ab" } } }) }, aborted: true }]);
    expect(apq!.effectUnknown).toBe(true);
    const { source } = draftOperation(apq!);
    expect(source).toContain("nothing in the Capture says whether it writes");
    expect(source).toContain("write the query text here");
    expect(source).not.toContain("trigger(page)");
  });

  test("names: GraphQL passes through, REST files are verb + noun", () => {
    expect(operationFileName("getAccount")).toBe("getAccount");
    for (const [name, file] of [
      ["GET /api/invoices/:id", "getInvoice"],
      ["GET /api/invoices", "listInvoices"],
      ["GET /api/v2/me", "getMe"],
      ["GET /api/account", "getAccount"],
      ["POST /api/notes", "createNote"],
      ["PATCH /api/customers/:id/invoices/:id", "updateInvoice"],
      ["PUT /api/user/settings", "updateSetting"],
      ["DELETE /api/subscriptions/:id", "deleteSubscription"],
      ["GET /api/categories", "listCategories"],
      ["GET /", "getRoot"],
    ]) {
      expect(operationFileName(name!), name).toBe(file!);
    }
    expect(namePathParams("/a/:id/b/:id/c")).toEqual({ path: "/a/:id/b/:id2/c", params: ["id", "id2"] });
  });
});

describe("draft-contract.ts", () => {
  function run(...args: string[]) {
    const proc = Bun.spawnSync([process.execPath, TOOL, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode, out: JSON.parse(proc.stdout.toString()) };
  }

  test("prints JSON with the source, or writes it with --out", () => {
    const dir = join(work, "captures", "account-show");
    mkdirSync(dir, { recursive: true });
    const shapeFile = join(dir, "getAccount.shape.json");
    writeFileSync(shapeFile, JSON.stringify(graphqlOp));
    const printed = run(shapeFile, "--name", "getAccount");
    expect(printed.code).toBe(0);
    expect(printed.out.operation).toBe("getAccount");
    expect(printed.out.file).toBe("src/operations/getAccount.ts");
    expect(printed.out.source).toStartWith("// From captures/account-show/getAccount.shape.json");

    const out = join(work, "written.ts");
    const written = run(shapeFile, "--out", out).out;
    expect(written.written).toBe(out);
    expect(written.file).toBe(out);
    expect(readFileSync(out, "utf8")).toBe(printed.out.source);
    const again = run(shapeFile, "--out", out);
    expect(again.code).toBe(1);
    expect(again.out.error.message).toContain("refusing to overwrite");
  });

  test("REST: --name is refused (the name is METHOD /path), and the suggested file is verb + noun", () => {
    const dir = join(work, "captures", "invoice-show");
    mkdirSync(dir, { recursive: true });
    const [invoice] = capture([{ req: { url: `${ORIGIN}/api/invoices/INV-2024-0287` }, body: { id: "x", dueDate: "2024-01-01" } }]);
    const shapeFile = join(dir, "GET-api-invoices-id.shape.json");
    writeFileSync(shapeFile, JSON.stringify(invoice));
    const named = run(shapeFile, "--name", "getInvoice");
    expect(named.code).toBe(1);
    expect(named.out.error.message).toContain('a REST Operation\'s name is "GET /api/invoices/:id"');
    expect(named.out.error.message).toContain("operations/getInvoice.ts");
    const printed = run(shapeFile);
    expect(printed.out).toMatchObject({ operation: "GET /api/invoices/:id", file: "src/operations/getInvoice.ts" });
  });

  test("the same Operation in the skill's other Captures is merged in, so nullability shows", () => {
    const [seenNull] = capture([{ req: { url: `${ORIGIN}/api/invoices/1001` }, body: { id: "x", dueDate: null, pdfUrl: null } }]);
    const [seenString] = capture([{ req: { url: `${ORIGIN}/api/invoices/1002` }, body: { id: "y", dueDate: "2024-01-01", pdfUrl: null } }]);
    for (const [task, op] of [["merge-a", seenNull], ["merge-b", seenString]] as const) {
      mkdirSync(join(work, "merge", "captures", task), { recursive: true });
      writeFileSync(join(work, "merge", "captures", task, "GET-api-invoices-id.shape.json"), JSON.stringify(op));
    }
    const r = run(join(work, "merge", "captures", "merge-a", "GET-api-invoices-id.shape.json"));
    expect(r.code).toBe(0);
    expect(r.out.mergedFrom).toEqual(["captures/merge-b/GET-api-invoices-id.shape.json"]);
    expect(r.out.source).toContain('dueDate: z.string() /* ISO date string */.nullable()');
    expect(r.out.source).toContain("pdfUrl: z.unknown().nullable() /* TODO");
    expect(r.out.source).toStartWith("// From captures/merge-a/GET-api-invoices-id.shape.json + captures/merge-b/");

    // A sibling shape file that cannot be read is skipped, not fatal.
    mkdirSync(join(work, "merge", "captures", "merge-c", "GET-api-invoices-id.shape.json"), { recursive: true });
    const skipped = run(join(work, "merge", "captures", "merge-a", "GET-api-invoices-id.shape.json"));
    expect(skipped.code).toBe(0);
    expect(skipped.out.mergedFrom).toEqual(["captures/merge-b/GET-api-invoices-id.shape.json"]);
  });

  test("the explore Capture is never merged in: after a fix re-captures a Task, its old shapes would come back (#84)", () => {
    const [current] = capture([{ req: { url: `${ORIGIN}/api/invoices/1001` }, body: { id: "x", total: 12 } }]);
    const [stale] = capture([{ req: { url: `${ORIGIN}/api/invoices/1002` }, body: { id: "y", total: "12.00" } }]);
    for (const [task, op] of [["invoice-show", current], ["explore", stale]] as const) {
      mkdirSync(join(work, "explored", "captures", task), { recursive: true });
      writeFileSync(join(work, "explored", "captures", task, "GET-api-invoices-id.shape.json"), JSON.stringify(op));
    }
    const r = run(join(work, "explored", "captures", "invoice-show", "GET-api-invoices-id.shape.json"));
    expect(r.code).toBe(0);
    expect(r.out.mergedFrom).toBeUndefined();
    expect(r.out.source).toContain("total: z.number()");
    expect(r.out.source).not.toContain("z.union");
    // Drafting from the explore Capture itself still merges the Tasks' Captures in.
    const fromExplore = run(join(work, "explored", "captures", "explore", "GET-api-invoices-id.shape.json"));
    expect(fromExplore.out.mergedFrom).toEqual(["captures/invoice-show/GET-api-invoices-id.shape.json"]);
  });

  test("--help prints the usage and every flag's meaning, exit 0", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.out.usage).toContain("draft-contract.ts <shape.json>");
    expect(Object.keys(r.out.flags)).toEqual(["--name", "--out"]);
  });

  test("errors are JSON with a non-zero exit", () => {
    const missing = run(join(work, "nope.shape.json"));
    expect(missing.code).toBe(1);
    expect(missing.out.error.message).toContain("no such shape file");
    writeFileSync(join(work, "bad.json"), JSON.stringify({ hello: 1 }));
    expect(run(join(work, "bad.json")).out.error.message).toContain("not a Capture shape file");
    mkdirSync(join(work, "dir.shape.json"), { recursive: true });
    expect(run(join(work, "dir.shape.json")).out.error.message).toContain("not a Capture shape file");
    expect(run().out.error.message).toContain("expected one shape file");
    expect(run(join(work, "bad.json"), join(work, "other.json")).out.error.message).toContain('unexpected argument');
  });
});
