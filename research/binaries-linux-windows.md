# Do the compiled binaries run on Linux and Windows?

Answers hoaj/skills#15. Follows `research/playwright-bun-compile.md`, which verified the patched `bun build --compile` binary on macOS only.

## Answer

Yes. The linux-x64 and windows-x64 binaries pass every check on GitHub-hosted runners: `help`, a plain `fetch`, `launchPersistentContext` with `channel: "chrome"` headless on a fresh profile dir, and `route.abort`. They need no `node_modules` and no extra workaround beyond the macOS one. A linux-arm64 binary also passes, provided Google Chrome is installed first.

Passing run: https://github.com/hoaj/skills/actions/runs/36826672713

| Runner | Binary | Result | Chrome found at | Chrome version | Launch |
|---|---|---|---|---|---|
| ubuntu-latest | `app-linux-x64` (ELF x86-64, 84 MB) | pass | `/opt/google/chrome/chrome` (preinstalled) | 154.0.8037.57 | 1.0 s |
| windows-latest | `app-windows-x64.exe` (PE32+ x86-64, 88 MB) | pass | `C:\Program Files\Google\Chrome\Application\chrome.exe` (preinstalled) | 153.0.8010.53 | 4.3 s |
| ubuntu-24.04-arm (extra) | `app-linux-arm64` (ELF aarch64, 84 MB) | pass after installing Chrome | `/opt/google/chrome/chrome` (installed from Google's arm64 .deb) | 154.0.8037.92 | 0.5 s |

On every runner `fetch("https://example.com")` returned 200, and `page.goto("https://example.com")` under `context.route(..., r => r.abort())` threw `net::ERR_FAILED at https://example.com/`, which confirms the abort.

## Setup

- Bun 1.4.2 (`oven-sh/setup-bun@v2`, `bun-version: 1.4.2`), playwright-core 1.63.0.
- All three targets cross-compile on one ubuntu-latest job (`bun build.ts <target> <outfile>`). Each run job downloads only the binary, with no checkout and no `node_modules`.
- The build is the macOS one unchanged: a `Bun.build` `onLoad` plugin rewrites the two `require(import_pathN.default.join(packageRoot, "package.json"|"browsers.json"))` calls in `playwright-core/lib/coreBundle.js` to `require("../package.json")` / `require("../browsers.json")` and asserts exactly 2 hits, with `external: ["chromium-bidi", "electron"]`.
- Code: `research/binaries-linux-windows/` (`build.ts`, `main.ts`, `package.json`). Workflow: `.github/workflows/research-binaries.yml`.

## Findings

1. **No platform-specific workaround is needed.** The single `coreBundle.js` patch is enough on Linux and Windows, and the `$bunfs` virtual filesystem resolves `../package.json` / `../browsers.json` the same way on all three OSes.
2. **`browser-actions/setup-chrome` was not needed.** ubuntu-latest and windows-latest ship Google Chrome stable at the paths playwright-core 1.63.0 checks for `channel: "chrome"`: `/opt/google/chrome/chrome` on Linux, and on Windows the first hit among `%LOCALAPPDATA%`, `%PROGRAMFILES%`, and `%PROGRAMFILES(X86)%` + `\Google\Chrome\Application\chrome.exe`.
3. **ubuntu-24.04-arm ships no Chrome.** The first run failed there with `Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome` (https://github.com/hoaj/skills/actions/runs/36825689829). Installing `https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb` with `apt-get` fixed it. Any user without Chrome gets this same error, so the CLI should catch it and tell them to install Chrome.
4. **CI trap: on Windows, `chrome.exe --version` launches the browser and never prints a version**, which hung the first run's Windows job until it was cancelled. Read the file version instead: `(Get-Item ...chrome.exe).VersionInfo.ProductVersion`.
5. `chromium.executablePath()` still reports the bundled `ms-playwright/chromium-1243` path even though that browser is not installed. Only `channel: "chrome"` is exercised here.

## Not covered

- windows-arm64 and macOS x64 targets.
- Linux distros other than Ubuntu 24.04, and musl (`bun-linux-x64-musl`).
- Code signing and SmartScreen or Gatekeeper prompts for downloaded, unsigned binaries.
