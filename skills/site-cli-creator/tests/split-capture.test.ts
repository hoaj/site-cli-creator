import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_ROOT } from "../tools/lib/paths";

const SPLIT = join(SKILL_ROOT, "tools", "split-capture.ts");
const work = mkdtempSync(join(tmpdir(), "split-capture-test-"));
const skill = join(work, "skill");
const explore = join(skill, "captures", "explore");

afterAll(() => rmSync(work, { recursive: true, force: true }));

type Entry = { operation: string; kind: "rest" | "graphql"; effect: "read" | "write"; host: string; file: string; pages: string[]; seen?: number; aborted?: number; loginFlow?: true; navigation?: true };

/** A shape file as capture.ts writes one: enough for the tool, which copies it unread. */
function shape(e: Entry): string {
  const answered = (e.aborted ?? 0) < (e.seen ?? 1);
  return `${JSON.stringify(
    {
      operation: e.operation,
      kind: e.kind,
      effect: e.effect,
      host: e.host,
      method: e.kind === "graphql" ? "POST" : e.operation.split(" ")[0],
      path: e.kind === "graphql" ? "/graphql" : e.operation.split(" ")[1],
      request: { headers: {} },
      responses: answered ? [{ status: 200, body: { kind: "json", shape: { type: "object", fields: {} } } }] : [],
      seen: e.seen ?? 1,
      aborted: e.aborted ?? 0,
    },
    null,
    2,
  )}\n`;
}

const ENTRIES: Entry[] = [
  { operation: "POST /oauth/token", kind: "rest", effect: "write", host: "www.example.dk", file: "POST-oauth-token.shape.json", pages: ["/"], loginFlow: true },
  { operation: "GET /", kind: "rest", effect: "read", host: "www.example.dk", file: "GET-root.shape.json", pages: ["/"], navigation: true },
  { operation: "getCustomer", kind: "graphql", effect: "read", host: "www.example.dk", file: "getCustomer.shape.json", pages: ["/", "/bills"] },
  { operation: "createQuote", kind: "graphql", effect: "write", host: "www.example.dk", file: "createQuote.shape.json", pages: ["/"], aborted: 1 },
  { operation: "GET /api/bills", kind: "rest", effect: "read", host: "www.example.dk", file: "GET-api-bills.shape.json", pages: ["/bills"] },
  { operation: "GET /api/bills/:id", kind: "rest", effect: "read", host: "www.example.dk", file: "GET-api-bills-id.shape.json", pages: ["/bills/:id"] },
  { operation: "GET /api/status", kind: "rest", effect: "read", host: "www.example.dk", file: "GET-api-status.shape.json", pages: [] },
  { operation: "GET /api/status", kind: "rest", effect: "read", host: "api.example.dk", file: "api.example.dk-GET-api-status.shape.json", pages: [] },
];

beforeEach(() => {
  rmSync(skill, { recursive: true, force: true });
  mkdirSync(explore, { recursive: true });
  for (const e of ENTRIES) writeFileSync(join(explore, e.file), shape(e));
  const index = {
    task: "explore",
    explore: true,
    startPath: "/",
    write: false,
    loginHosts: ["login.example.dk"],
    pages: [
      { path: "/", operations: ["getCustomer", "createQuote"] },
      { path: "/bills", operations: ["getCustomer", "GET /api/bills"] },
      { path: "/bills/:id", operations: ["GET /api/bills/:id"] },
    ],
    operations: ENTRIES.map(({ kind: _k, ...e }) => ({ ...e, kind: _k, method: "GET", path: "/", seen: e.seen ?? 1, aborted: e.aborted ?? 0 })),
  };
  writeFileSync(join(explore, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
});

function split(args: string[]) {
  const p = Bun.spawnSync([process.execPath, SPLIT, "--skill-dir", skill, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: JSON.parse(p.stdout.toString()), stderr: p.stderr.toString() };
}

describe("split-capture.ts", () => {
  test("copies the chosen Operations into captures/<task>/ with an index.json for that Task (#84)", () => {
    const r = split(["--task", "bill-list", "--op", "GET /api/bills", "--op", "getCustomer"]);
    expect(r.code, JSON.stringify(r.out) + r.stderr).toBe(0);
    const dir = join(skill, "captures", "bill-list");
    // The Task starts on the page that called the most chosen Operations: getCustomer is on "/" too.
    expect(r.out).toEqual({
      task: "bill-list",
      dir,
      startPath: "/bills",
      operations: [
        { operation: "getCustomer", file: "getCustomer.shape.json" },
        { operation: "GET /api/bills", file: "GET-api-bills.shape.json" },
      ],
    });
    expect(readdirSync(dir).sort()).toEqual(["GET-api-bills.shape.json", "getCustomer.shape.json", "index.json"]);
    for (const f of ["GET-api-bills.shape.json", "getCustomer.shape.json"]) {
      expect(readFileSync(join(dir, f), "utf8")).toBe(readFileSync(join(explore, f), "utf8"));
    }
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    expect(index).toMatchObject({ task: "bill-list", startPath: "/bills", write: false, from: "explore", loginHosts: ["login.example.dk"] });
    expect(index.explore).toBeUndefined();
    expect(index.pages).toBeUndefined();
    expect(index.operations.map((o: { operation: string }) => o.operation)).toEqual(["getCustomer", "GET /api/bills"]);
    // The explore Capture is left as it was, for the next Task.
    expect(readdirSync(explore)).toContain("GET-api-bills.shape.json");
  });

  test("--start-path names the Task's page when the busiest page is not it", () => {
    const r = split(["--task", "bill-list", "--op", "getCustomer", "--op", "GET /api/bills", "--start-path", "/"]);
    expect(r.code, JSON.stringify(r.out)).toBe(0);
    expect(r.out.startPath).toBe("/");
    expect(JSON.parse(readFileSync(join(skill, "captures", "bill-list", "index.json"), "utf8")).startPath).toBe("/");
  });

  test("an Operation named on two hosts is chosen by its file", () => {
    const ambiguous = split(["--task", "status-show", "--op", "GET /api/status"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.out.error.message).toContain("GET /api/status is recorded on 2 hosts");
    expect(ambiguous.out.error.message).toContain("api.example.dk-GET-api-status.shape.json");
    const byFile = split(["--task", "status-show", "--op", "api.example.dk-GET-api-status.shape.json"]);
    expect(byFile.code, JSON.stringify(byFile.out)).toBe(0);
    expect(byFile.out.operations).toEqual([{ operation: "GET /api/status", file: "api.example.dk-GET-api-status.shape.json" }]);
    // No page recorded for it: the explore Capture's start page.
    expect(byFile.out.startPath).toBe("/");
  });

  test("refuses what cannot become a Task's Capture, and writes nothing", () => {
    const refused = (args: string[], message: string) => {
      const r = split(args);
      expect(r.code, JSON.stringify(r.out)).toBe(1);
      expect(r.out.error.message).toContain(message);
      expect(existsSync(join(skill, "captures", "x-show"))).toBe(false);
    };
    refused(["--task", "x-show", "--op", "listNothing"], "not in captures/explore/index.json: listNothing");
    refused(["--task", "x-show", "--op", "createQuote"], "createQuote was aborted (a write): capture its Task with capture.ts --task x-show --write");
    refused(["--task", "x-show", "--op", "POST /oauth/token"], "is a sign-in step (loginFlow)");
    refused(["--task", "x-show", "--op", "GET /"], "is a page load (navigation)");
    refused(["--task", "x-show"], "missing --op");
    refused(["--task", "explore", "--op", "getCustomer"], "reserved");
    refused(["--task", "x-show", "--op", "getCustomer", "--start-path", "bills"], "--start-path must start with /");
  });

  test("refuses to replace an existing Capture of the Task", () => {
    const dir = join(skill, "captures", "bill-list");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.json"), "{}");
    const r = split(["--task", "bill-list", "--op", "GET /api/bills"]);
    expect(r.code).toBe(1);
    expect(r.out.error.message).toContain(`${dir} already holds a Capture`);
    expect(readdirSync(dir)).toEqual(["index.json"]);
  });

  test("without an explore Capture it says how to make one", () => {
    rmSync(explore, { recursive: true });
    const r = split(["--task", "bill-list", "--op", "GET /api/bills"]);
    expect(r.code).toBe(1);
    expect(r.out.error.message).toContain("no explore Capture");
    expect(r.out.error.message).toContain("capture.ts --skill-dir");
  });

  test("--help lists every flag, exit 0", () => {
    const p = Bun.spawnSync([process.execPath, SPLIT, "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(Object.keys(JSON.parse(p.stdout.toString()).flags)).toEqual(["--skill-dir", "--task", "--op", "--start-path"]);
  });
});
