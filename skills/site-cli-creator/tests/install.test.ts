// Runs starter/skill/install.sh in temp copies, with stubs for gh, xattr, codesign and
// powershell on a PATH that holds nothing else but the few tools the script needs.
// Also covers starter/skill/cli/build.ts, the other half of getting a binary to users.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STARTER_INSTALL = join(import.meta.dir, "..", "starter", "skill", "install.sh");
const BASH = Bun.which("bash")!;
const TOOLS = ["dirname", "mktemp", "mkdir", "mv", "chmod", "rm", "tr", "cat"];

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "install-sh-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const stub = (body: string) => `#!${BASH}\necho "$(basename "$0") $*" >>"$STUB_LOG"\n${body}\n`;

const GH = stub(`
case "$1 $2" in
  "auth status") [ "$GH_STUB_AUTH" = ok ] || { echo "You are not logged into any GitHub hosts." >&2; exit 1; } ;;
  "release download")
    shift 2; tag="$1"; shift
    while [ $# -gt 0 ]; do
      case "$1" in --pattern) pattern="$2"; shift ;; --dir) dir="$2"; shift ;; esac
      shift
    done
    case "$GH_STUB_DOWNLOAD" in
      ok) printf 'binary for %s %s\\n' "$tag" "$pattern" >"$dir/$pattern" ;;
      404) echo "release not found" >&2; exit 1 ;;
      noasset) echo "no assets match the file pattern" >&2; exit 1 ;;
      *) echo "error connecting to api.github.com" >&2; exit 1 ;;
    esac ;;
  "api repos/"*) [ "$GH_STUB_REPO" = visible ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac`);

// curl as install.sh calls it: -sSL -o <file> -w '%{http_code}' <url>. CURL_STUB picks the answer.
const CURL = stub(`
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; -w) shift ;; -*) ;; *) url="$1" ;; esac
  shift
done
case "$CURL_STUB" in
  ok) printf 'binary from %s\\n' "$url" >"$out"; printf 200 ;;
  404) printf 'Not Found' >"$out"; printf 404 ;;
  *) echo "curl: (6) Could not resolve host: github.com" >&2; exit 6 ;;
esac`);

const CODESIGN = stub(`[ "$1" = -v ] && [ "$CODESIGN_VALID" != 1 ] && exit 1; exit 0`);

// withCurl defaults to false, so the tests that predate the public download drive the gh path.
type Setup = { needsChrome?: boolean; withGh?: boolean; withCurl?: boolean; skillMd?: string; prefix?: string };

function makeSkill(name: string, opts: Setup = {}) {
  const dir = join(root, name);
  const skill = join(dir, "skills", "demo");
  const path = join(dir, "path");
  mkdirSync(join(skill, "cli", "src"), { recursive: true });
  mkdirSync(path);

  const script = readFileSync(STARTER_INSTALL, "utf8")
    .replaceAll("__SKILL__", "demo")
    .replaceAll("__REPO__", "acme/demo-plugin")
    .replaceAll("__OWNER__", "acme")
    .replaceAll("__PREFIX__", opts.prefix ?? "");
  writeFileSync(join(skill, "install.sh"), script);
  writeFileSync(
    join(skill, "SKILL.md"),
    opts.skillMd ?? "---\nname: demo\ndescription: test\n---\n<!-- version: 1.2.3 -->\n\n# demo\n",
  );
  writeFileSync(
    join(skill, "cli", "src", "site.ts"),
    `export default defineSite({\n  version: "1.2.3",\n  needsChrome: ${opts.needsChrome ?? false},\n});\n`,
  );

  for (const tool of TOOLS) symlinkSync(Bun.which(tool)!, join(path, tool));
  const stubs: Record<string, string> = {
    xattr: stub("exit 0"),
    codesign: CODESIGN,
    powershell: stub("exit 0"),
  };
  if (opts.withGh !== false) stubs.gh = GH;
  if (opts.withCurl) stubs.curl = CURL;
  for (const [file, body] of Object.entries(stubs)) {
    writeFileSync(join(path, file), body);
    chmodSync(join(path, file), 0o755);
  }
  // basename is used by the stubs' logging only.
  symlinkSync(Bun.which("basename")!, join(path, "basename"));

  const chrome = join(dir, "chrome");
  writeFileSync(chrome, "");
  chmodSync(chrome, 0o755);
  return { skill, path, log: join(dir, "calls.log"), chrome };
}

type Run = { env?: Record<string, string> } & Setup;

function run(name: string, opts: Run = {}) {
  const s = makeSkill(name, opts);
  const proc = Bun.spawnSync([BASH, join(s.skill, "install.sh")], {
    env: {
      PATH: s.path,
      HOME: root,
      TMPDIR: root,
      STUB_LOG: s.log,
      GH_STUB_AUTH: "ok",
      GH_STUB_DOWNLOAD: "ok",
      GH_STUB_REPO: "visible",
      SITE_CLI_INSTALL_UNAME: "Darwin arm64",
      SITE_CLI_CHROME: s.chrome,
      ...opts.env,
    },
  });
  const calls = existsSync(s.log) ? readFileSync(s.log, "utf8").trim().split("\n") : [];
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    calls,
    skill: s.skill,
  };
}

describe("install.sh", () => {
  test("the starter keeps its placeholders", () => {
    const src = readFileSync(STARTER_INSTALL, "utf8");
    for (const token of ["__SKILL__", "__REPO__", "__OWNER__", "__PREFIX__"]) expect(src).toContain(token);
  });

  test("stops when neither curl nor gh is there", () => {
    const r = run("no-gh", { withGh: false });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("neither curl nor GitHub CLI (gh) found");
    expect(r.stderr).toContain("gh auth login");
    expect(existsSync(join(r.skill, "bin"))).toBe(false);
  });

  describe("public release over HTTPS", () => {
    const URL = "https://github.com/acme/demo-plugin/releases/download/v1.2.3/demo-darwin-arm64";

    test("downloads with curl and needs no gh at all", () => {
      const r = run("curl-public", { withCurl: true, withGh: false, env: { CURL_STUB: "ok" } });
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(join(r.skill, "bin", "demo"), "utf8")).toBe(`binary from ${URL}\n`);
      expect(r.calls.some((c) => c.startsWith("gh "))).toBe(false);
      expect(r.stdout).toContain("installed demo v1.2.3 (darwin-arm64)");
    });

    test("does not touch gh when the public download works, even when gh is logged out", () => {
      const r = run("curl-public-gh-out", { withCurl: true, env: { CURL_STUB: "ok", GH_STUB_AUTH: "fail" } });
      expect(r.code, r.stderr).toBe(0);
      expect(r.calls.some((c) => c.startsWith("gh "))).toBe(false);
    });

    test("SITE_CLI_INSTALL_BASE_URL replaces https://github.com", () => {
      const r = run("curl-base", {
        withCurl: true,
        withGh: false,
        env: { CURL_STUB: "ok", SITE_CLI_INSTALL_BASE_URL: "http://127.0.0.1:9" },
      });
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(join(r.skill, "bin", "demo"), "utf8")).toContain(
        "http://127.0.0.1:9/acme/demo-plugin/releases/download/v1.2.3/demo-darwin-arm64",
      );
    });

    test("a plugin in a shared repo downloads from its own prefixed tag, over HTTPS and through gh", () => {
      const pub = run("curl-prefix", { withCurl: true, withGh: false, prefix: "demo-", env: { CURL_STUB: "ok" } });
      expect(pub.code, pub.stderr).toBe(0);
      expect(readFileSync(join(pub.skill, "bin", "demo"), "utf8")).toBe(`binary from ${URL.replace("/v1.2.3/", "/demo-v1.2.3/")}\n`);
      const priv = run("curl-prefix-gh", { withCurl: true, prefix: "demo-", env: { CURL_STUB: "404" } });
      expect(priv.code, priv.stderr).toBe(0);
      expect(priv.calls.some((c) => c.startsWith("gh release download demo-v1.2.3 --repo acme/demo-plugin"))).toBe(true);
    });

    test("a 404 with gh logged in falls back to gh (a private repo)", () => {
      const r = run("curl-404-gh", { withCurl: true, env: { CURL_STUB: "404" } });
      expect(r.code, r.stderr).toBe(0);
      expect(r.calls.some((c) => c.startsWith("gh release download v1.2.3 --repo acme/demo-plugin"))).toBe(true);
      expect(readFileSync(join(r.skill, "bin", "demo"), "utf8")).toBe("binary for v1.2.3 demo-darwin-arm64\n");
    });

    test("a 404 without gh says the release is still being built or the repo is private", () => {
      const r = run("curl-404-no-gh", { withCurl: true, withGh: false, env: { CURL_STUB: "404" } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`release v1.2.3 of acme/demo-plugin was not found at ${URL}`);
      expect(r.stderr).toContain("try again in a few minutes");
      expect(r.stderr).toContain("gh auth login");
      expect(existsSync(join(r.skill, "bin"))).toBe(false);
    });

    test("a network error passes curl's message through and leaves bin/ alone", () => {
      const r = run("curl-neterr", { withCurl: true, withGh: false, env: { CURL_STUB: "error" } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`could not download ${URL}: curl: (6) Could not resolve host`);
      expect(existsSync(join(r.skill, "bin"))).toBe(false);
    });
  });

  test("stops when gh is not logged in", () => {
    const r = run("no-auth", { env: { GH_STUB_AUTH: "fail" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("run `gh auth login`");
    expect(r.calls.some((c) => c.startsWith("gh release"))).toBe(false);
  });

  test("stops when the skill needs Chrome and it is missing", () => {
    const r = run("no-chrome", { needsChrome: true, env: { SITE_CLI_CHROME: join(root, "missing-chrome") } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("demo needs Google Chrome");
    expect(r.stderr).toContain("https://www.google.com/chrome/");
    expect(r.calls.some((c) => c.startsWith("gh release"))).toBe(false);
  });

  test("Linux Chrome hint names the right .deb", () => {
    const r = run("no-chrome-linux", {
      needsChrome: true,
      env: { SITE_CLI_INSTALL_UNAME: "Linux aarch64", SITE_CLI_CHROME: join(root, "missing-chrome") },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("google-chrome-stable_current_arm64.deb");
  });

  test("does not ask for Chrome when the skill does not need it", () => {
    const r = run("chrome-not-needed", { needsChrome: false, env: { SITE_CLI_CHROME: join(root, "missing-chrome") } });
    expect(r.code).toBe(0);
  });

  test("installs when Chrome is needed and present", () => {
    const r = run("chrome-present", { needsChrome: true });
    expect(r.code).toBe(0);
  });

  test.each([
    ["FreeBSD amd64", "freebsd-x64"],
    ["MINGW64_NT-10.0-26100 aarch64", "windows-arm64"],
    ["Linux riscv64", "linux-riscv64"],
  ])("rejects unsupported platform %s", (uname, platform) => {
    const r = run(`unsupported-${platform}`, { env: { SITE_CLI_INSTALL_UNAME: uname } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`unsupported platform: ${platform}`);
    expect(r.calls.some((c) => c.startsWith("gh release"))).toBe(false);
  });

  test("404 on a repo the user can see: the release is still being built", () => {
    const r = run("404-visible", { env: { GH_STUB_DOWNLOAD: "404", GH_STUB_REPO: "visible" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("release v1.2.3 of acme/demo-plugin is still being built: try again in a few minutes");
    expect(r.calls).toContain("gh api repos/acme/demo-plugin --silent");
    expect(existsSync(join(r.skill, "bin"))).toBe(false);
  });

  test("missing asset on a visible repo is treated like a release in progress", () => {
    const r = run("noasset-visible", { env: { GH_STUB_DOWNLOAD: "noasset" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("still being built");
  });

  test("404 on a repo the user cannot see: ask the owner for access", () => {
    const r = run("404-hidden", { env: { GH_STUB_DOWNLOAD: "404", GH_STUB_REPO: "hidden" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ask acme for access to acme/demo-plugin");
  });

  test("other download errors pass gh's message through", () => {
    const r = run("download-error", { env: { GH_STUB_DOWNLOAD: "error" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("gh release download v1.2.3 failed: error connecting to api.github.com");
    expect(r.calls.some((c) => c.startsWith("gh api"))).toBe(false);
  });

  test("stops when SKILL.md has no version comment", () => {
    const r = run("no-version", { skillMd: "---\nname: demo\n---\n# demo\n" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no <!-- version: X.Y.Z --> comment");
  });

  test("reads the version from a CRLF SKILL.md", () => {
    const r = run("crlf", { skillMd: "---\r\nname: demo\r\n---\r\n<!-- version: 2.0.10 -->\r\n" });
    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.startsWith("gh release download v2.0.10 "))).toBe(true);
  });

  test("macOS: installs bin/<skill>, strips quarantine and re-signs an invalid signature", () => {
    const r = run("darwin", { env: { CODESIGN_VALID: "0" } });
    expect(r.code).toBe(0);
    const bin = join(r.skill, "bin", "demo");
    expect(readFileSync(bin, "utf8")).toBe("binary for v1.2.3 demo-darwin-arm64\n");
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    expect(r.calls.find((c) => c.startsWith("gh release download"))).toStartWith(
      "gh release download v1.2.3 --repo acme/demo-plugin --pattern demo-darwin-arm64 --dir ",
    );
    const xattr = r.calls.findIndex((c) => c.startsWith("xattr -d com.apple.quarantine "));
    const verify = r.calls.findIndex((c) => c.startsWith("codesign -v "));
    const sign = r.calls.findIndex((c) => c.startsWith("codesign --force --sign - "));
    expect(xattr).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(xattr);
    expect(sign).toBeGreaterThan(verify);
    expect(r.calls.some((c) => c.startsWith("powershell"))).toBe(false);
    expect(r.stdout).toContain("installed demo v1.2.3 (darwin-arm64)");
  });

  test("macOS: keeps a valid signature", () => {
    const r = run("darwin-valid", { env: { CODESIGN_VALID: "1", SITE_CLI_INSTALL_UNAME: "Darwin x86_64" } });
    expect(r.code).toBe(0);
    expect(readFileSync(join(r.skill, "bin", "demo"), "utf8")).toContain("demo-darwin-x64");
    expect(r.calls.some((c) => c.startsWith("codesign -v "))).toBe(true);
    expect(r.calls.some((c) => c.startsWith("codesign --force"))).toBe(false);
  });

  test.each([
    ["Linux x86_64", "demo-linux-x64"],
    ["Linux aarch64", "demo-linux-arm64"],
  ])("Linux %s: downloads %s with no unblock step", (uname, asset) => {
    const r = run(`linux-${asset}`, { env: { SITE_CLI_INSTALL_UNAME: uname } });
    expect(r.code).toBe(0);
    expect(readFileSync(join(r.skill, "bin", "demo"), "utf8")).toContain(asset);
    expect(r.calls.some((c) => /^(xattr|codesign|powershell)/.test(c))).toBe(false);
  });

  test("Windows: installs bin/<skill>.exe and runs Unblock-File", () => {
    const r = run("windows", { env: { SITE_CLI_INSTALL_UNAME: "MINGW64_NT-10.0-26100 x86_64" } });
    expect(r.code).toBe(0);
    const bin = join(r.skill, "bin", "demo.exe");
    expect(readFileSync(bin, "utf8")).toContain("demo-windows-x64.exe");
    expect(r.calls.some((c) => c.startsWith("powershell -NoProfile -Command Unblock-File -LiteralPath "))).toBe(true);
    expect(r.calls.some((c) => /^(xattr|codesign)/.test(c))).toBe(false);
  });

  function rerun(name: string, skill: string, env: Record<string, string>) {
    return Bun.spawnSync([BASH, join(skill, "install.sh")], {
      env: {
        PATH: join(root, name, "path"),
        TMPDIR: root,
        STUB_LOG: join(root, name, "calls.log"),
        GH_STUB_AUTH: "ok",
        SITE_CLI_INSTALL_UNAME: "Darwin arm64",
        ...env,
      },
    });
  }

  test("reinstalling replaces an existing binary", () => {
    const s = run("reinstall");
    expect(s.code).toBe(0);
    const bin = join(s.skill, "bin", "demo");
    writeFileSync(bin, "stale binary\n");
    writeFileSync(join(s.skill, "SKILL.md"), "---\nname: demo\n---\n<!-- version: 1.3.0 -->\n");
    expect(rerun("reinstall", s.skill, { GH_STUB_DOWNLOAD: "ok" }).exitCode).toBe(0);
    expect(readFileSync(bin, "utf8")).toBe("binary for v1.3.0 demo-darwin-arm64\n");
  });

  test("a failed download leaves an existing binary in place", () => {
    const s = run("keep-old");
    const bin = join(s.skill, "bin", "demo");
    writeFileSync(bin, "working binary\n");
    expect(rerun("keep-old", s.skill, { GH_STUB_DOWNLOAD: "error" }).exitCode).toBe(1);
    expect(readFileSync(bin, "utf8")).toBe("working binary\n");
  });

  describe("Windows Chrome lookup", () => {
    // Git Bash has cygpath; this stub turns the script's backslashes into slashes.
    const CYGPATH = stub(`printf '%s' "$2" | tr '\\\\' '/'`);

    function windows(name: string, chromeUnder: "LocalAppData" | "ProgramFiles" | null) {
      const s = makeSkill(name, { needsChrome: true });
      writeFileSync(join(s.path, "cygpath"), CYGPATH);
      chmodSync(join(s.path, "cygpath"), 0o755);
      symlinkSync(Bun.which("printenv")!, join(s.path, "printenv"));
      if (chromeUnder) {
        const dir = join(root, name, chromeUnder, "Google", "Chrome", "Application");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "chrome.exe"), "");
      }
      const proc = Bun.spawnSync([BASH, join(s.skill, "install.sh")], {
        env: {
          PATH: s.path,
          TMPDIR: root,
          STUB_LOG: s.log,
          GH_STUB_AUTH: "ok",
          GH_STUB_DOWNLOAD: "ok",
          SITE_CLI_INSTALL_UNAME: "MINGW64_NT-10.0-26100 x86_64",
          LOCALAPPDATA: join(root, name, "LocalAppData"),
          PROGRAMFILES: join(root, name, "ProgramFiles"),
        },
      });
      return { code: proc.exitCode, stderr: proc.stderr.toString() };
    }

    test("finds Chrome under %LOCALAPPDATA%", () => {
      expect(windows("win-chrome-local", "LocalAppData").code).toBe(0);
    });

    test("finds Chrome under %PROGRAMFILES%", () => {
      expect(windows("win-chrome-pf", "ProgramFiles").code).toBe(0);
    });

    test("stops with the install hint when Chrome is in none of them", () => {
      const r = windows("win-no-chrome", null);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("demo needs Google Chrome, which was not found: install Google Chrome from");
    });
  });
});

// build.ts sits next to install.sh in the Starter skill and is tested here, because
// starter/skill/cli/tests/ holds the runtime's tests.
describe("build.ts", () => {
  const BUILD = join(import.meta.dir, "..", "starter", "skill", "cli", "build.ts");
  const PLAYWRIGHT = join(import.meta.dir, "..", "..", "..", "node_modules", "playwright-core");
  const HOST = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const EXE = process.platform === "win32" ? "app.exe" : "app";

  test("patches exactly the two package.json / browsers.json requires in playwright-core", async () => {
    const { patchCoreBundle } = await import(BUILD);
    const src = readFileSync(join(PLAYWRIGHT, "lib", "coreBundle.js"), "utf8");
    const out: string = patchCoreBundle(src);
    expect(out).toContain('require("../package.json")');
    expect(out).toContain('require("../browsers.json")');
    expect(out).not.toMatch(/join\(packageRoot, "(package|browsers)\.json"\)\)/);
  });

  test("refuses a coreBundle.js with a different number of patch sites", async () => {
    const { patchCoreBundle } = await import(BUILD);
    const site = 'require(import_path1.default.join(packageRoot, "package.json"))';
    expect(() => patchCoreBundle("nothing here")).toThrow("expected 2 patch sites in coreBundle.js, found 0");
    expect(() => patchCoreBundle([site, site, site].join("\n"))).toThrow("found 3");
  });

  test("lists the five v1 targets", async () => {
    const { TARGETS } = await import(BUILD);
    expect(TARGETS).toEqual(["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64", "bun-windows-x64"]);
  });

  test.each([[[]], [["bun-linux-x64"]], [["linux-x64", "out"]]])("exits 2 on bad usage %j", (args) => {
    const p = Bun.spawnSync([process.execPath, BUILD, ...args]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("usage: bun build.ts <bun-target> <outfile>");
  });

  test(
    "compiles a binary that runs without node_modules and maps stack frames to src/",
    () => {
      // A real copy of playwright-core, not a symlink: an unpatched binary would still find
      // the symlink's target on this machine and pass by accident.
      const dir = mkdtempSync(join(tmpdir(), "build-ts-"));
      try {
        cpSync(BUILD, join(dir, "build.ts"));
        cpSync(PLAYWRIGHT, join(dir, "node_modules", "playwright-core"), { recursive: true });
        mkdirSync(join(dir, "src", "commands"), { recursive: true });
        writeFileSync(
          join(dir, "src", "commands", "boom.ts"),
          'export function explode(): never {\n  throw new TypeError("boom");\n}\n',
        );
        writeFileSync(
          join(dir, "src", "main.ts"),
          [
            'import { chromium } from "playwright-core";',
            'import { explode } from "./commands/boom";',
            'if (process.argv.includes("boom")) {',
            "  try { explode(); } catch (err) { console.log(JSON.stringify({ stack: (err as Error).stack })); }",
            "} else {",
            "  console.log(JSON.stringify({ browser: chromium.name() }));",
            "}",
          ].join("\n"),
        );
        const outfile = join(dir, "dist", EXE);
        const build = Bun.spawnSync([process.execPath, join(dir, "build.ts"), HOST, outfile], { cwd: dir });
        expect(build.stderr.toString()).toContain(`built ${outfile} for ${HOST}`);
        expect(build.exitCode).toBe(0);
        expect(readdirSync(join(dir, "dist"))).toEqual([EXE]);

        rmSync(join(dir, "node_modules"), { recursive: true, force: true });
        const ok = Bun.spawnSync([outfile], { cwd: tmpdir() });
        expect(ok.stderr.toString()).toBe("");
        expect(JSON.parse(ok.stdout.toString())).toEqual({ browser: "chromium" });

        const boom = Bun.spawnSync([outfile, "boom"], { cwd: tmpdir() });
        const stack: string = JSON.parse(boom.stdout.toString()).stack;
        expect(stack).toMatch(/at explode \(.*src\/commands\/boom\.ts:\d+:\d+\)/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
