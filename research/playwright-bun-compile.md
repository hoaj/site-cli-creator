# Does Playwright work inside `bun build --compile` binaries?

Research for [hoaj/skills#2](https://github.com/hoaj/skills/issues/2), part of [#1](https://github.com/hoaj/skills/issues/1). Researched 2026-09-28.

## Answer

Yes, with one build-time patch. A `bun build --compile` binary can drive `playwright-core` with `launchPersistentContext(dir, { channel: "chrome" })` and abort requests with `route.abort()`. On macOS this was verified end to end, with `node_modules` removed at run time. Out of the box, a compiled binary only works on the machine that built it: playwright-core reads its own `package.json` and `browsers.json` through a path built from `__dirname`, and Bun freezes that path to the build machine's absolute path. A small `Bun.build` plugin that rewrites those two `require`s into static ones makes the binary self-contained.

- **Browser binary:** none bundled or downloaded. `channel: "chrome"` launches the user's installed Google Chrome.
- **How it finds Chrome:** a fixed path per OS (table below). No registry lookup, no PATH search. Pass `executablePath` to override it.
- **Profile:** it must be a dedicated automation profile dir, not the user's everyday Chrome profile. Chrome 136+ ignores the remote-debugging switches on the default user data dir.
- **Windows:** needs Bun >= 1.4.0. Older Bun hangs on the `--remote-debugging-pipe` handshake.

## Spike (macOS arm64, Chrome 154, playwright-core 1.63.0)

The script starts a local HTTP server that serves a page loading `/blocked.js`. It launches `chromium.launchPersistentContext(<fresh mkdtemp dir>, { channel: "chrome", headless: true })`, sets `ctx.route("**/blocked.js", r => r.abort())`, loads the page and checks that the script never ran.

| Build | Run with `node_modules` present | Run with `node_modules` removed |
|---|---|---|
| `bun run spike.ts` (Bun 1.2.13) | PASS | n/a |
| `bun build --compile` (no flags) | build fails: `Could not resolve: "chromium-bidi/lib/cjs/cdp/CdpConnection"` | n/a |
| `--compile --external chromium-bidi --external electron`, Bun 1.2.13 and 1.4.2 | PASS | **FAIL**: `Cannot find module '<build path>/node_modules/playwright-core/package.json' from '/$bunfs/root/…'` |
| same flags + static-require plugin (below), Bun 1.4.2 | PASS | **PASS** (`aborted: 1`, `blockedLoaded: false`, `requestfailed … net::ERR_FAILED`) |

Cross-compiles to `bun-linux-x64` and `bun-windows-x64` built fine from the Mac (ELF / PE32+). They were **not run** on Linux or Windows.

### The fix: a build plugin

`bun build --compile` on the CLI takes no plugins, so build through `Bun.build`. Bun 1.2.13 rejects `compile` in `Bun.build`, and 1.4.2 accepts it. Use Bun >= 1.4.0 anyway, for the Windows fix below.

```ts
import type { BunPlugin } from "bun";

const playwrightStaticRequires: BunPlugin = {
  name: "playwright-core-static-requires",
  setup(build) {
    build.onLoad({ filter: /playwright-core[\\/]lib[\\/]coreBundle\.js$/ }, async ({ path }) => {
      const src = await Bun.file(path).text();
      const re = /require\(import_path\d+\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g;
      const hits = src.match(re)?.length ?? 0;
      if (hits !== 2) throw new Error(`expected 2 patch sites, found ${hits}`);
      return { contents: src.replace(re, 'require("../$1.json")'), loader: "js" };
    });
  },
};

await Bun.build({
  entrypoints: ["./main.ts"],
  compile: { target: "bun-darwin-arm64", outfile: "app" },
  external: ["chromium-bidi", "electron"], // optional deps, only used for BiDi/Electron
  plugins: [playwrightStaticRequires],
});
```

The `hits !== 2` guard fails the build loudly if a playwright-core upgrade moves the call sites. Pin playwright-core.

Other `__dirname`-relative reads remain in `coreBundle.js`: `webp_codec.wasm` for screencast/video, and `trace-viewer` for tracing UI. They load lazily and are not on the launch/route/abort path. Avoid video and tracing in the binary, or embed those too.

## How Playwright finds Chrome (`channel: "chrome"`)

From `playwright-core/lib/coreBundle.js` (1.63.0), `_createChromiumChannel("chrome", …)`:

| OS | Path checked |
|---|---|
| macOS | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| Linux | `/opt/google/chrome/chrome` |
| Windows | `\Google\Chrome\Application\chrome.exe` under each of `%LOCALAPPDATA%`, `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`, `%HOMEDRIVE%\Program Files`, `%HOMEDRIVE%\Program Files (x86)` (first hit wins) |

If none exists it throws `Chromium distribution 'chrome' is not found at …`. Chrome in `~/Applications` on macOS, Flatpak/Snap Chrome on Linux, and Chromium are **not** found. For those, pass `executablePath` explicitly. The Playwright docs confirm that branded channels use "the branded Google Chrome and Microsoft Edge browsers available on the machine (note that Playwright doesn't install them by default)" ([Playwright: Browsers](https://playwright.dev/docs/browsers)). Headless `channel: "chrome"` uses Chrome's new headless mode, not `chrome-headless-shell`, so nothing from `~/Library/Caches/ms-playwright` is needed.

## Persistent profile caveat

- Chrome 136+ ignores `--remote-debugging-pipe`/`--remote-debugging-port` when pointed at the default user data dir. The switches only work with a non-default `--user-data-dir`, which gets its own encryption key ([Chrome for Developers: Changes to remote debugging switches](https://developer.chrome.com/blog/remote-debugging-port)).
- Playwright's docs: "automating the default Chrome user profile is not supported. Pointing `userDataDir` to Chrome's main "User Data" directory … may result in pages not loading or the browser exiting" ([BrowserType.launchPersistentContext](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)).
- So "persistent" means a tool-owned dir (e.g. `~/.config/<tool>/chrome-profile`) that the user logs into once through the automated browser. It cannot reuse their everyday Chrome sessions.

## Known Bun issues

- [oven-sh/bun#18749](https://github.com/oven-sh/bun/issues/18749) (open) is the canonical issue for "playwright-core not included into compiled build". The thread's workaround is `--external playwright-core` plus shipping `node_modules` next to the binary. The plugin above avoids that.
- [oven-sh/bun#25038](https://github.com/oven-sh/bun/issues/25038) and [#27530](https://github.com/oven-sh/bun/issues/27530) are duplicates. A #27530 comment traces the root cause: compile bakes the absolute path into any non-literal `require()`. It still reproduces on Bun 1.3.14, and we reproduced it on 1.4.2.
- [oven-sh/bun#27977](https://github.com/oven-sh/bun/issues/27977) (closed): `chromium.launch()` times out on **Windows** under Bun 1.3.14. The extra stdio pipes (fd 3/4) used by `--remote-debugging-pipe` never connect. Fixed by [oven-sh/bun#31829](https://github.com/oven-sh/bun/pull/31829), merged 2026-08-12 and shipped in Bun 1.4.0 (2026-08-20). Earlier Windows pipe support: [#13042](https://github.com/oven-sh/bun/issues/13042).

## Open / unverified

- Linux and Windows runs of the compiled binary, especially Windows on Bun >= 1.4.0. Test on real machines before relying on them.
- Headed mode was not tested (only headless). Headed mode matters if the user must log in interactively once.
