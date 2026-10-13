import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSession, saveSession, sessionFile, stateDir } from "../src/runtime/session";
import { tempHome } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

const mode = (p: string) => statSync(p).mode & 0o777;

test("state dir is ~/.<plugin>-<skill>/ unless SITE_CLI_HOME is set", () => {
  expect(stateDir({ plugin: "yousee", skill: "mit" }, {})).toBe(join(homedir(), ".yousee-mit"));
  expect(stateDir({ plugin: "yousee", skill: "mit" }, { SITE_CLI_HOME: "/tmp/x" })).toBe("/tmp/x");
});

test.skipIf(process.platform === "win32")("session.json is 0600 inside a 0700 dir, even if the dir existed looser", () => {
  const dir = join(home.dir, "state");
  mkdirSync(dir, { mode: 0o755 });
  saveSession(dir, { headers: { authorization: "Bearer t" }, ids: { customerId: "C" } });
  expect(mode(dir)).toBe(0o700);
  expect(mode(sessionFile(dir))).toBe(0o600);
  saveSession(dir, { headers: {}, ids: {} });
  expect(mode(sessionFile(dir))).toBe(0o600);
});

test("round trip keeps headers, ids, accounts and adds savedAt", () => {
  saveSession(home.dir, { headers: { cookie: "a=b" }, ids: { x: "1" }, accounts: [{ id: "A" }] });
  const s = loadSession(home.dir)!;
  expect(s.headers).toEqual({ cookie: "a=b" });
  expect(s.ids).toEqual({ x: "1" });
  expect(s.accounts).toEqual([{ id: "A" }]);
  expect(Number.isNaN(Date.parse(s.savedAt))).toBe(false);
});

test("missing or corrupt session.json reads as no session", () => {
  expect(loadSession(home.dir)).toBeNull();
  writeFileSync(sessionFile(home.dir), "{not json");
  expect(loadSession(home.dir)).toBeNull();
  writeFileSync(sessionFile(home.dir), JSON.stringify({ headers: "x" }));
  expect(loadSession(home.dir)).toBeNull();
});
