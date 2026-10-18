// The envelope as a process sees it: exactly one JSON document on stdout, progress on stderr,
// the exit code per kind; plus the pure envelope helpers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EXIT, Failure, errorEnvelope, nextStep, osName } from "../src/runtime/envelope";
import { saveSession } from "../src/runtime/session";
import { happySite, json, tempHome, type Recorded } from "./helpers";

const site = { plugin: "acme", skill: "shop", version: "1.2.3" };

describe("envelope helpers", () => {
  test("exit codes", () => {
    expect(EXIT).toEqual({ ok: 0, bug: 1, input: 2, drift: 3, session: 4, network: 5 });
  });

  test("next per kind", () => {
    expect(nextStep("bug", site)).toContain("acme-feedback");
    expect(nextStep("bug", site)).toContain("only if the user says yes");
    expect(nextStep("drift", site)).toMatch(/Stop.*raw calls.*acme-feedback.*only if the user says yes/);
    expect(nextStep("input", site)).toContain("shop help");
    expect(nextStep("input", site, true)).toContain("--account <id>");
    expect(nextStep("session", site)).toContain("shop login");
    expect(nextStep("network", site)).toContain("isn't responding");
  });

  test("os names follow the release targets", () => {
    expect(osName("win32", "x64")).toBe("windows-x64");
    expect(osName("darwin", "arm64")).toBe("darwin-arm64");
  });

  test("optional fields appear only when set", () => {
    const plain = errorEnvelope(new Failure("network", "down"), site);
    expect(Object.keys(plain.error)).toEqual(["kind", "message", "version", "os", "next"]);
    const full = errorEnvelope(new Failure("drift", "x", { fingerprint: "f", diff: [], drifts: [], stack: [] }), site);
    expect(Object.keys(full.error)).toEqual(["kind", "message", "fingerprint", "diff", "drifts", "stack", "version", "os", "next"]);
  });
});

describe("as a process", () => {
  const home = tempHome();
  let mode: "ok" | "drift" | "down" = "ok";
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (mode === "down") return json({}, 503);
      const body = req.method === "POST" ? await req.json() : undefined;
      if (mode === "drift") return json({ data: { getCustomer: { id: "C-1", name: { first: "Kim" } } } });
      const rec: Recorded = { method: req.method, url: req.url, headers: {}, body };
      return happySite(rec);
    },
  });
  beforeAll(() => saveSession(home.dir, { headers: {}, ids: { customerId: "C-1" } }));
  afterAll(() => {
    server.stop(true);
    home.cleanup();
  });

  async function cli(...argv: string[]) {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "cli.ts"), ...argv], {
      env: { ...process.env, SITE_CLI_TEST: "1", SITE_CLI_ORIGIN: server.url.origin, SITE_CLI_HOME: home.dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  const oneDocument = (stdout: string) => {
    expect(stdout.endsWith("\n")).toBe(true);
    return JSON.parse(stdout);
  };

  test("success: one JSON document, progress on stderr, exit 0", async () => {
    mode = "ok";
    const r = await cli("products", "show");
    expect(r.code).toBe(0);
    expect(oneDocument(r.stdout)).toEqual({ customer: "Kim Secret", products: [{ id: "P1", status: "active" }] });
    expect(r.stderr).toContain("products show: getCustomer → listProducts");
  });

  test("drift: one JSON document with the envelope, exit 3, no site values", async () => {
    mode = "drift";
    const r = await cli("products", "show");
    expect(r.code).toBe(3);
    const doc = oneDocument(r.stdout);
    expect(doc.error).toMatchObject({ kind: "drift", version: "1.2.3", fingerprint: "acme:shop:getCustomer:zod:data.getCustomer.name:invalid_type" });
    expect(r.stdout).not.toContain("Kim");
  });

  test("network: exit 5", async () => {
    mode = "down";
    const r = await cli("products", "show");
    expect(r.code).toBe(5);
    expect(oneDocument(r.stdout).error.kind).toBe("network");
  });

  test("bug and input exit codes", async () => {
    mode = "ok";
    expect((await cli("crash", "now")).code).toBe(1);
    const bad = await cli("products", "show", "--nope");
    expect(bad.code).toBe(2);
    expect(oneDocument(bad.stdout).error.kind).toBe("input");
  });

  test("dry run prints the would-be write and exits 0", async () => {
    mode = "ok";
    const r = await cli("order", "rename", "--order-id", "9", "--name", "N");
    expect(r.code).toBe(0);
    expect(oneDocument(r.stdout)).toEqual({ dryRun: true, would: { operation: "PATCH /api/orders/:orderId", variables: { orderId: "9", name: "N" } } });
  });

  test("a large result reaches a slow pipe reader whole, then the process exits", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "cli.ts"), "big", "list", "--rows", "20000"], {
      env: { ...process.env, SITE_CLI_HOME: home.dir },
      stdout: "pipe",
      stderr: "ignore",
    });
    // Read only after the CLI has tried to exit, like an agent harness that collects output late.
    await Bun.sleep(1500);
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout.length).toBeGreaterThan(1_000_000);
    expect(oneDocument(stdout)).toHaveLength(20000);
  });

  test("SITE_CLI_ORIGIN is ignored without SITE_CLI_TEST=1", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "cli.ts"), "products", "show"], {
      env: { ...process.env, SITE_CLI_TEST: "", SITE_CLI_ORIGIN: server.url.origin, SITE_CLI_HOME: home.dir },
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = JSON.parse(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(5);
    expect(out.error.message).toContain("shop.example.test");
  });
});
