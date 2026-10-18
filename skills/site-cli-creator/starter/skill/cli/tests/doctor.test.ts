import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromeCandidates, chromeLaunchOptions, findChrome } from "../src/runtime/chrome";
import { binaryFindings, doctor, generatedJsonPath, readGenerated, type Exec } from "../src/runtime/doctor";
import { saveSession } from "../src/runtime/session";
import { loginSite, makeSite, tempHome } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

describe("chrome", () => {
  test("fixed paths per OS", () => {
    expect(chromeCandidates("darwin")).toEqual(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
    expect(chromeCandidates("linux")).toEqual(["/opt/google/chrome/chrome"]);
    expect(chromeCandidates("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PROGRAMFILES: "C:\\Program Files", HOMEDRIVE: "C:" })).toEqual([
      "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]);
    expect(chromeCandidates("freebsd")).toEqual([]);
  });

  test("first existing path wins; SITE_CLI_CHROME overrides and becomes executablePath", () => {
    const found = findChrome({}, "linux", (p) => p === "/opt/google/chrome/chrome");
    expect(found.path).toBe("/opt/google/chrome/chrome");
    expect(chromeLaunchOptions(found)).toEqual({ channel: "chrome" });
    const over = findChrome({ SITE_CLI_CHROME: "/x/chrome" }, "linux", () => true);
    expect(over).toEqual({ path: "/x/chrome", checked: ["/x/chrome"], override: true });
    expect(chromeLaunchOptions(over)).toEqual({ executablePath: "/x/chrome" });
    expect(findChrome({}, "linux", () => false).path).toBeUndefined();
  });
});

describe("doctor", () => {
  const fakeExec = (codes: Record<string, number>, seen: string[] = []): Exec => async (cmd) => {
    const key = cmd.slice(0, 2).join(" ");
    seen.push(cmd.join(" "));
    return { code: codes[key] ?? 0, stdout: key === "gh --version" ? "gh version 2.80.0 (2026-01-01)\n" : "" };
  };

  test("reports versions, state, Chrome, gh and the check command", async () => {
    saveSession(home.dir, { headers: {}, ids: {}, savedAt: "2026-10-01T00:00:00.000Z" });
    // Injected, never the plugin's own generated.json: this test must hold in every generated
    // plugin, whatever generator version and maintainer it was created with.
    const generated = join(home.dir, "generated.json");
    writeFileSync(generated, JSON.stringify({ generatedWith: "9.8.7", maintainer: "octo" }));
    const out = await doctor(loginSite(), {
      env: { SITE_CLI_HOME: home.dir, SITE_CLI_CHROME: "/x/chrome" },
      exec: fakeExec({}),
      exists: () => true,
      platform: "darwin",
      generatedJson: generated,
    });
    expect(out).toMatchObject({
      plugin: "acme",
      skill: "shop",
      version: "1.2.3",
      generatedWith: "9.8.7",
      maintainer: "octo",
      generated,
      bun: Bun.version,
      stateDir: home.dir,
      session: "saved 2026-10-01T00:00:00.000Z",
      chrome: "/x/chrome",
      gh: { installed: true, version: "2.80.0", loggedIn: true, repoAccess: true },
      binary: { compiled: false, findings: [] },
      check: "shop check",
    });
  });

  test("Chrome not needed, gh missing", async () => {
    const out = await doctor(makeSite(), { env: { SITE_CLI_HOME: home.dir }, exec: fakeExec({ "gh --version": -1 }) });
    expect(out.chrome).toBe("not needed");
    expect(out.session).toBe("none");
    expect(out.gh).toEqual({ installed: false, hint: expect.stringContaining("gh auth login") });
  });

  test("a login skill always needs Chrome, even if needsChrome was left false", async () => {
    const out = await doctor(loginSite({ needsChrome: false }), {
      env: { SITE_CLI_HOME: home.dir },
      exec: fakeExec({}),
      exists: () => false,
      platform: "linux",
    });
    expect(out.chrome).toStartWith("not found (looked at /opt/google/chrome/chrome)");
  });

  test("an older build's ~/.<plugin>-<plugin>/ beside ~/.<plugin>/ is named as left alone (#44)", async () => {
    const site = makeSite({ plugin: "acme", skill: "acme" });
    const opts = { env: {}, exec: fakeExec({}), home: home.dir };
    expect(await doctor(site, opts)).toMatchObject({ stateDir: join(home.dir, ".acme"), session: "none" });
    expect((await doctor(site, opts)).oldStateDir).toBeUndefined();
    mkdirSync(join(home.dir, ".acme-acme"));
    expect((await doctor(site, opts)).oldStateDir).toBeUndefined(); // only the old one: run() moves it
    saveSession(join(home.dir, ".acme"), { headers: {}, ids: {}, savedAt: "2026-10-01T00:00:00.000Z" });
    const both = await doctor(site, opts);
    expect(both).toMatchObject({ stateDir: join(home.dir, ".acme"), session: "saved 2026-10-01T00:00:00.000Z" });
    expect(both.oldStateDir).toStartWith(`${join(home.dir, ".acme-acme")}: left alone and not used`);
    // A skill not named after its plugin has no older name.
    expect((await doctor(makeSite({ plugin: "acme", skill: "shop" }), opts)).stateDir).toBe(join(home.dir, ".acme-shop"));
  });

  test("no repo access names the owner", async () => {
    const out = await doctor(makeSite(), { env: { SITE_CLI_HOME: home.dir }, exec: fakeExec({ "gh repo": 1 }) });
    expect(out.gh).toMatchObject({ loggedIn: true, repoAccess: false, hint: "ask acme for access to acme/acme-plugin" });
  });

  test("a compiled binary is checked for quarantine and signature on macOS", async () => {
    const seen: string[] = [];
    const findings = await binaryFindings("/p/bin/shop", "darwin", fakeExec({ "xattr -p": 0, "codesign -v": 1 }, seen), () => false);
    expect(seen).toEqual(["xattr -p com.apple.quarantine /p/bin/shop", "codesign -v /p/bin/shop"]);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain("xattr -d com.apple.quarantine");
    expect(findings[1]).toContain("codesign --force --sign -");
    expect(await binaryFindings("/p/bin/shop", "darwin", fakeExec({ "xattr -p": 1, "codesign -v": 0 }), () => false)).toEqual([]);
  });

  test("Zone.Identifier on Windows; probes that throw never fail doctor", async () => {
    expect(await binaryFindings("C:\\p\\shop.exe", "win32", fakeExec({}), (p) => p.endsWith(":Zone.Identifier"))).toEqual([
      expect.stringContaining("Unblock-File"),
    ]);
    expect(await binaryFindings("C:\\p\\shop.exe", "win32", fakeExec({}), () => { throw new Error("no ADS"); })).toEqual([]);
    const throwing: Exec = async () => { throw new Error("spawn failed"); };
    const out = await doctor(loginSite(), { env: { SITE_CLI_HOME: home.dir }, exec: throwing, compiled: true, platform: "darwin" }).catch(() => "threw");
    expect(out).not.toBe("threw");
    expect((out as any).gh.installed).toBe(false);
    expect((out as any).binary.findings).toEqual([]);
  });
});

describe("doctor and generated.json (SPEC §5, §13)", () => {
  test("prints generatedWith and maintainer from generated.json, so a handover shows without a new binary", async () => {
    const file = join(home.dir, "generated.json");
    writeFileSync(file, JSON.stringify({ generatedWith: "0.0.9", maintainer: "alice" }));
    const out = await doctor(loginSite(), { env: { SITE_CLI_HOME: home.dir }, exec: async () => ({ code: 1, stdout: "" }), generatedJson: file });
    expect(out).toMatchObject({ generatedWith: "0.0.9", maintainer: "alice", generated: file });
  });

  test("without generated.json it falls back to site.ts's generatedWith and says where it looked", () => {
    expect(readGenerated("/nowhere/generated.json", { generatedWith: "0.1.0" })).toEqual({
      generatedWith: "0.1.0",
      maintainer: "unknown",
      generated: "not found (looked at /nowhere/generated.json)",
    });
  });

  test("found next to the plugin root from the binary and from the source tree", () => {
    expect(generatedJsonPath(true, "/p/skills/shop/bin/shop")).toBe("/p/generated.json");
    expect(generatedJsonPath(false, "/usr/bin/bun", "/p/skills/shop/cli/src/runtime")).toBe("/p/generated.json");
  });
});
