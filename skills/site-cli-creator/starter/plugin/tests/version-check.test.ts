import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionCheck } from "../scripts/version-check";

const CHECK = join(import.meta.dir, "..", "scripts", "version-check.ts");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  // Neutralise the developer's global config (signing, hooks) so commits always succeed.
  const config = ["user.name=t", "user.email=t@example.com", "commit.gpgsign=false", "core.hooksPath=/dev/null"];
  const p = Bun.spawnSync(["git", ...config.flatMap((c) => ["-c", c]), ...args], { cwd: root });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}

function setManifest(root: string, version: string) {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "demo", version }));
}

/** A repo whose main has `mainVersion` (or no manifest), checked out on a PR branch at `headVersion`. */
function repo(mainVersion: string | null, headVersion: string): string {
  const root = mkdtempSync(join(tmpdir(), "version-check-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "demo\n");
  if (mainVersion) setManifest(root, mainVersion);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "main");
  git(root, "checkout", "-q", "-b", "pr");
  setManifest(root, headVersion);
  git(root, "add", ".");
  git(root, "commit", "-q", "--allow-empty", "-m", "pr");
  return root;
}

test("passes when the PR's version is above main's", () => {
  const r = versionCheck(repo("0.9.0", "0.10.0"), "main");
  expect(r).toEqual({ ok: true, message: "version 0.10.0 is above main's 0.9.0" });
});

test("fails when the PR's version equals main's", () => {
  const r = versionCheck(repo("0.2.0", "0.2.0"), "main");
  expect(r.ok).toBe(false);
  expect(r.message).toContain("version 0.2.0 is not above main's 0.2.0");
  expect(r.message).toContain("bun run bump");
});

test("fails when the PR's version is below main's", () => {
  expect(versionCheck(repo("0.3.0", "0.2.9"), "main").ok).toBe(false);
});

test("passes when main has no manifest yet", () => {
  const r = versionCheck(repo(null, "0.1.0"), "main");
  expect(r.ok).toBe(true);
  expect(r.message).toContain("is the first");
});

test("fails loudly when the base ref is missing", () => {
  const r = versionCheck(repo("0.1.0", "0.1.1"), "origin/main");
  expect(r.ok).toBe(false);
  expect(r.message).toContain("base ref origin/main not found");
});

test("reads main's manifest from the plugin's folder when the plugin is not the repo root", () => {
  const root = mkdtempSync(join(tmpdir(), "version-check-"));
  roots.push(root);
  const plugin = join(root, "plugins", "demo");
  git(root, "init", "-q", "-b", "main");
  setManifest(root, "9.9.9"); // another plugin's manifest at the repo root must not count
  setManifest(plugin, "0.3.0");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "main");
  git(root, "checkout", "-q", "-b", "pr");
  setManifest(plugin, "0.3.1");
  git(root, "commit", "-q", "-am", "pr");
  expect(versionCheck(plugin, "main")).toEqual({ ok: true, message: "version 0.3.1 is above main's 0.3.0" });
});

test("CLI exits 0 or 1 with the message", () => {
  const ok = Bun.spawnSync([process.execPath, CHECK, "main", "--root", repo("0.1.0", "0.1.1")]);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toContain("version-check: version 0.1.1 is above main's 0.1.0");
  const stale = Bun.spawnSync([process.execPath, CHECK, "--root", repo("0.1.1", "0.1.1"), "main"]);
  expect(stale.exitCode).toBe(1);
  expect(stale.stderr.toString()).toContain("is not above main's 0.1.1");
});
