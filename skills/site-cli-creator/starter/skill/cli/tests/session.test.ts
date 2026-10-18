import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { legacyStateDir, loadSession, migrateStateDir, profileDir, saveSession, sessionFile, stateDir } from "../src/runtime/session";
import { tempHome } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

const mode = (p: string) => statSync(p).mode & 0o777;

test("state dir is ~/.<plugin>-<skill>/ unless SITE_CLI_HOME is set", () => {
  expect(stateDir({ plugin: "yousee", skill: "mit" }, {})).toBe(join(homedir(), ".yousee-mit"));
  expect(stateDir({ plugin: "yousee", skill: "mit" }, { SITE_CLI_HOME: "/tmp/x" })).toBe("/tmp/x");
});

test("a skill named after its plugin keeps its state in ~/.<plugin>/, not ~/.<plugin>-<plugin>/ (#44)", () => {
  expect(stateDir({ plugin: "logbuy", skill: "logbuy" }, {})).toBe(join(homedir(), ".logbuy"));
  expect(stateDir({ plugin: "logbuy", skill: "logbuy" }, {}, "/h")).toBe(join("/h", ".logbuy"));
  expect(stateDir({ plugin: "logbuy", skill: "logbuy" }, { SITE_CLI_HOME: "/tmp/x" })).toBe("/tmp/x");
  expect(stateDir({ plugin: "yousee", skill: "mit" }, {}, "/h")).toBe(join("/h", ".yousee-mit"));
  // The old name only differs for a skill named after its plugin.
  expect(legacyStateDir({ plugin: "logbuy", skill: "logbuy" }, {}, "/h")).toBe(join("/h", ".logbuy-logbuy"));
  expect(legacyStateDir({ plugin: "yousee", skill: "mit" }, {}, "/h")).toBeNull();
  expect(legacyStateDir({ plugin: "logbuy", skill: "logbuy" }, { SITE_CLI_HOME: "/tmp/x" }, "/h")).toBeNull();
});

describe("moving ~/.<plugin>-<plugin>/ to ~/.<plugin>/ on the first run (#44)", () => {
  const names = { plugin: "logbuy", skill: "logbuy" };
  const oldDir = () => join(home.dir, ".logbuy-logbuy");
  const newDir = () => join(home.dir, ".logbuy");
  const plantOld = () => {
    mkdirSync(profileDir(oldDir()), { recursive: true, mode: 0o700 });
    writeFileSync(join(profileDir(oldDir()), "Cookies"), "chrome");
    saveSession(oldDir(), { headers: { authorization: "Bearer t" }, ids: { customerId: "C" } });
  };

  test("moves the old dir once, so the user stays signed in", () => {
    plantOld();
    const before = readFileSync(sessionFile(oldDir()), "utf8");
    expect(migrateStateDir(names, {}, home.dir)).toEqual({ moved: true, from: oldDir(), to: newDir() });
    expect(existsSync(oldDir())).toBe(false);
    expect(readFileSync(sessionFile(newDir()), "utf8")).toBe(before);
    expect(readFileSync(join(profileDir(newDir()), "Cookies"), "utf8")).toBe("chrome");
    expect(loadSession(stateDir(names, {}, home.dir))?.ids).toEqual({ customerId: "C" });
    // A second run has nothing to move.
    expect(migrateStateDir(names, {}, home.dir)).toEqual({ moved: false });
  });

  test.skipIf(process.platform === "win32")("keeps the dir 0700 and session.json 0600", () => {
    plantOld();
    migrateStateDir(names, {}, home.dir);
    expect(mode(newDir())).toBe(0o700);
    expect(mode(sessionFile(newDir()))).toBe(0o600);
  });

  test("both dirs exist: the new one is used and the old one is left alone", () => {
    plantOld();
    const oldSession = readFileSync(sessionFile(oldDir()), "utf8");
    saveSession(newDir(), { headers: {}, ids: { customerId: "NEW" } });
    const newSession = readFileSync(sessionFile(newDir()), "utf8");
    expect(migrateStateDir(names, {}, home.dir)).toEqual({ moved: false, leftAlone: oldDir() });
    expect(readFileSync(sessionFile(oldDir()), "utf8")).toBe(oldSession);
    expect(readFileSync(join(profileDir(oldDir()), "Cookies"), "utf8")).toBe("chrome");
    expect(readFileSync(sessionFile(newDir()), "utf8")).toBe(newSession);
    expect(existsSync(join(newDir(), "profile"))).toBe(false);
  });

  test("nothing to move: no dir is created", () => {
    expect(migrateStateDir(names, {}, home.dir)).toEqual({ moved: false });
    expect(existsSync(newDir())).toBe(false);
    expect(existsSync(oldDir())).toBe(false);
  });

  test("SITE_CLI_HOME or a skill not named after its plugin: nothing moves", () => {
    plantOld();
    expect(migrateStateDir(names, { SITE_CLI_HOME: join(home.dir, "x") }, home.dir)).toEqual({ moved: false });
    mkdirSync(join(home.dir, ".yousee-mit"));
    expect(migrateStateDir({ plugin: "yousee", skill: "mit" }, {}, home.dir)).toEqual({ moved: false });
    expect(existsSync(oldDir())).toBe(true);
    expect(existsSync(join(home.dir, ".yousee-mit"))).toBe(true);
    expect(existsSync(newDir())).toBe(false);
  });
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
