# Do the MCP SDK's Streamable HTTP transport and auth router run in a Bun-compiled binary?

Answers hoaj/skills#55 (part of the map #53, remote mode for site-cli-creator plugins). Builds on `research/playwright-bun-compile.md` and `research/binaries-linux-windows.md`.

## Answer

Yes. Nothing breaks and no workaround is needed. `@modelcontextprotocol/sdk` (`StreamableHTTPServerTransport`, `mcpAuthRouter`, `requireBearerAuth`) and Express 5 compile with the Starter's `build.ts` as it is: the same playwright-core patch, the same `external: ["chromium-bidi", "electron"]`, and no extra plugin or external. The bundler logs no warnings. The binary passes the full OAuth and MCP flow in four places:

- on the host (darwin-arm64), run from a folder with no `node_modules`
- as a linux-x64 binary cross-compiled on a macOS arm64 runner, inside `debian:bookworm-slim`, `gcr.io/distroless/cc-debian12` and `ubuntu:24.04` containers
- from source (`bun src/main.ts`) on the host
- from source inside an `oven/bun:1.4.3-slim` container

The new dependencies add about **2.8 MB** to the binary, roughly 3.5%.

Passing CI run: https://github.com/hoaj/skills/actions/runs/38615603394

## What the spike checks

`spike/src/main.ts` follows the remote-mode shape BankMCP uses (`~/Documents/projects/hobby/mcp-bank/src/app.ts`): an Express app that mounts `mcpAuthRouter` with a stub one-user `OAuthServerProvider`, and a stateless `POST /mcp` behind `requireBearerAuth`. It opens a fresh `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` for each request and has one zod-typed tool, `echo`. The stub provider auto-approves `/authorize` and keeps everything in memory. The `main pw` command checks that playwright-core still finds its `browsers.json` registry inside the binary.

`spike/smoke.ts` runs these checks against a running server, and every check passed in every place:

1. `GET /.well-known/oauth-authorization-server` returns 200 with a `token_endpoint`.
2. `GET /.well-known/oauth-protected-resource/mcp` returns 200 and points at the issuer.
3. `POST /mcp` without a token returns 401 with a `WWW-Authenticate: Bearer ... resource_metadata=...` header.
4. Dynamic client registration (`POST /register`) returns 201 with a `client_id`.
5. `/authorize` with a PKCE S256 challenge returns a 302 to the redirect URI with a `code`.
6. `/token` (authorization_code plus the PKCE verifier) returns 200 with an `access_token`. This exercises `pkce-challenge` and `express-rate-limit` inside the binary.
7. Over Streamable HTTP with the bearer token: `initialize` returns `serverInfo` and protocol `2025-06-18`, `tools/list` returns `["echo"]`, and `tools/call echo` returns `"echo: hi"`.

## Setup

- Bun 1.4.3 locally and in CI. Spike dependencies: `playwright-core` 1.63.0 and `zod` ^4.6.5 (the Starter's `cli/package.json`), plus `@modelcontextprotocol/sdk` ^1.30.0 and `express` ^5.2.1 (BankMCP's ranges). These resolved to **sdk 1.32.1, express 5.3.0, zod 4.6.7** (`spike/bun.lock`).
- `spike/build.ts` copies the Starter's `plugins/site-cli-creator/skills/site-cli-creator/starter/skill/cli/build.ts` with one change: an optional third argument picks the entry file (`baseline.ts` or `main.ts`). The plugin, externals and source map setting are untouched.
- `spike/src/baseline.ts` uses only today's dependencies (zod and playwright-core). It is there to measure the size difference.
- Workflow: `.github/workflows/research-mcp-sdk-bun-compile.yml`. It cross-compiles on `macos-latest` (arm64), then runs the linux-x64 binary on `ubuntu-latest` in each container image. A separate job runs `bun install --frozen-lockfile --production && bun src/main.ts serve` in `oven/bun:1.4.3-slim`.
- There is no Docker on the maintainer's Mac, so the container checks ran on GitHub-hosted runners, as #15 did.

## Sizes

| Build | darwin-arm64 | linux-x64 (cross-compiled from macOS) |
|---|---|---|
| Bare Bun runtime (`console.log("hi")`) | 70.9 MB | n/a |
| Baseline: zod + playwright-core | 81.0 MB (81,000,818 B) | 100.9 MB (100,857,824 B) |
| Spike: + MCP SDK + Express | 83.9 MB (83,857,394 B) | 103.7 MB (103,688,160 B) |
| **Added by the new deps** | **+2.86 MB (+3.5%)** | **+2.83 MB (+2.8%)** |

The linux binaries built locally and on the CI macOS runner came out the same size, byte for byte.

- The JS bundle alone (`bun build --target=bun`, no compile) is 6.67 MB for the baseline and 8.57 MB for the spike, so +1.9 MB of JS. The rest of the 2.8 MB is the embedded source map, which grows with the bundle because `build.ts` uses `sourcemap: "linked"`.
- Memory right after the smoke run (`docker stats`): **56 MiB** for the compiled binary in debian-slim, and **92 MiB** for `bun src/main.ts` in oven/bun. The host binary's RSS was about 97 MB.
- The from-source container needs `node_modules` (42 MB, 93 packages with `--production`) and a `bun install` at start or image build. The compiled binary needs neither, and it runs on `distroless/cc`, which has no shell and no package manager.

## Findings

1. **No compile breakage.** The bundle has no dynamic requires, no ESM/CJS interop errors and no missing files. `Bun.build` reports `success: true` with 0 log entries. The only `require()` calls left in the bundle load Node built-ins (`fs`, `path`, `http`, `crypto`, and so on), which Bun provides. The ESM-only `pkce-challenge`, the CJS `express`, `cors` and `express-rate-limit`, and `ajv`, `hono` and `@hono/node-server` all bundle cleanly.
2. **The playwright-core patch still applies and still works** with the new dependencies in the graph. Exactly 2 patch sites are hit, and `main pw` resolves the registry path in every container (`/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`).
3. **`StreamableHTTPServerTransport` is a thin wrapper.** In SDK 1.32.1, the Node `StreamableHTTPServerTransport` wraps `WebStandardStreamableHTTPServerTransport` and converts Node request and response objects with `@hono/node-server`'s `getRequestListener`. The file header says Bun can use the web-standard transport directly (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js`, lines 1-10). That matters only if remote mode drops Express. `mcpAuthRouter` and `requireBearerAuth` are Express routers and middleware (`dist/esm/server/auth/router.js`, `handlers/token.js` imports `express-rate-limit` and `pkce-challenge`), so a BankMCP-style Server sign-in needs Express either way. Inside Bun's `node:http`, Express and the hono adapter work as they are.
4. **Running from source works too, but it solves nothing.** `bun src/main.ts` passes on the host and in `oven/bun:1.4.3-slim`. Since the compiled binary has no problems, running from source has no compile problems to avoid. It costs a `bun install` (42 MB of `node_modules`), an image that ships Bun, and about 36 MiB more memory.
5. **Not tested here, but known from BankMCP:** behind Railway's proxy, the SDK's `express-rate-limit` reads `X-Forwarded-For`. BankMCP sets `app.set("trust proxy", 1)` (`mcp-bank/src/app.ts`) so the limiter keys on the client IP. Remote mode should do the same.
6. **Version pinning:** the `^` ranges resolved to sdk 1.32.1 and express 5.3.0, newer than BankMCP's lockfile (1.30.0 and 5.2.1). Nothing here depends on the patch level. The build ticket can pin exact versions the way the Starter pins playwright-core.

## What this means for #56 (where remote mode lives)

Compiling does not limit where remote mode lives. Remote mode can live inside the CLI skill's existing compiled binary (the Starter's `runtime/`, next to the stdio `mcp.ts`). It needs no change to `build.ts`. It costs about 2.8 MB in every user's binary, including people who only use local mode, and a Linux deploy is just the cross-compiled `bun-linux-x64` binary copied into a slim or distroless image. Running from source is not needed to avoid compile problems, so #56 can be decided on other grounds: one artifact versus a separate server package, deploy shape, and whether local-only users should carry the extra 2.8 MB.

## Not covered

- linux-arm64, windows-x64 and musl (`bun-linux-x64-musl` on Alpine). Earlier research shows the Starter's binaries run on these targets. The new dependencies are plain JS, so no target-specific issue is expected, but they were not run.
- A real password login page, hashed token storage, refresh tokens and revocation. The stub provider auto-approves, so the SDK's routing, validation, PKCE and bearer checks were tested but BankMCP's `SingleUserProvider` logic was not.
- SSE streaming responses. The spike uses `enableJsonResponse: true`, as BankMCP does. A Railway deploy and a claude.ai or phone client are left to later tickets.
