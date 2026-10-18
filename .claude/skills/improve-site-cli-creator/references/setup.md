# Setup

Per checkout or worktree. Commands assume macOS on Apple silicon; swap the asset names for other platforms.

## Bun 1.4.3

CI uses 1.4.3 (`BUN_VERSION` in `.github/workflows/site-cli-creator.yml`). If `bun --version` is missing or older:

```sh
mkdir -p ~/.local/bin && cd "$(mktemp -d)" && \
  gh release download bun-v1.4.3 -R oven-sh/bun --pattern 'bun-darwin-aarch64.zip' && \
  unzip -q bun-darwin-aarch64.zip && mv bun-darwin-aarch64/bun ~/.local/bin/ && export PATH=~/.local/bin:$PATH
```

The agent's shell keeps no state between commands: start each command with `export PATH=~/.local/bin:$PATH && …`. Homebrew installs the latest Bun, not CI's 1.4.3, so prefer the pinned download.

Asset names use `aarch64` and `x64` (`bun-darwin-aarch64.zip`, `bun-darwin-x64.zip`, `bun-linux-x64.zip`, `bun-linux-aarch64.zip`, `bun-windows-x64.zip`), not the `arm64` that `uname -m` prints.

## Dependencies

```sh
cd plugins/site-cli-creator && bun install --frozen-lockfile
```

The Starter CLI's types resolve through this `node_modules`; there is no separate install for `starter/skill/cli`.

## Google Chrome

Needed by the Capture, browser and e2e tests. Without Chrome they **skip and the suite still passes**: `tests/e2e.test.ts` and the Starter's `browser.test.ts` on every platform, `tests/capture.test.ts` on macOS (on Linux it fails instead). Install Chrome, or point `SITE_CLI_CHROME` at a Chrome binary.

## actionlint and shellcheck

```sh
brew install actionlint shellcheck
```

Without Homebrew: `gh release download -R rhysd/actionlint --pattern '*darwin_arm64.tar.gz'` and `gh release download -R koalaman/shellcheck --pattern '*darwin.aarch64.tar.xz'`, then unpack onto `PATH`.
