# site-cli-creator: architecture and build contract

This is the implementation contract for the generator described in [`SPEC.md`](../../SPEC.md). SPEC.md says **what** and **why**. This file says **where** and **with which interfaces**. If they disagree, SPEC.md wins and this file is fixed.

Glossary terms (Task, CLI skill, Feedback skill, Starter code, Capture, Operation, Contract, Effect, Drift, Fingerprint) are defined in [`CONTEXT.md`](../../CONTEXT.md).

## 1. Layout of the generator plugin

```
plugins/site-cli-creator/
  .claude-plugin/plugin.json  .cursor-plugin/plugin.json  .github/plugin/plugin.json
  package.json                 dev + tool dependencies (zod, playwright-core, typescript, @types/bun)
  ARCHITECTURE.md              this file
  skills/
    site-cli-creator/
      SKILL.md                 the generator: modes new, add-skill, add-task, fix (SPEC §2, §3)
      reference/               mode guides and Contract guide the SKILL.md links to
      tools/                   Bun scripts the maintainer's agent runs (never compiled)
        new.ts                 scaffold a plugin from starter/ (SPEC §2 new)
        add-skill.ts           scaffold skills/<skill>/ from starter/skill (SPEC §2 add-skill)
        capture.ts             the Capture tool (SPEC §3 step 2)
        draft-contract.ts      draft a Zod response schema from a shape file (SPEC §6)
        regen.ts               regenerate registry.ts + the SKILL.md command table (SPEC §3 step 5)
        lib/                   shared code for the tools (shape extraction, templating, fs helpers)
      starter/                 the Starter code, copied once by new / add-skill (SPEC §5)
        plugin/                files for the plugin root
        skill/                 files for one skills/<skill>/
        feedback/              files for skills/<plugin>-feedback/
      fixtures/
        site/                  a local test website (GraphQL + REST, login and public modes, drift switches)
        expected/              what an agent would write for the fixture site: site.ts, operations, commands
      tests/                   generator tests: unit + end-to-end against fixtures/site
    site-cli-creator-feedback/
      SKILL.md                 files generator problems on hoaj/skills, label site-cli-creator (SPEC §1)
```

The repo root also gets `.github/workflows/site-cli-creator.yml` (the generator's CI, SPEC §5 and §9).

## 2. Placeholders in starter/

`tools/new.ts` and `tools/add-skill.ts` copy `starter/` and replace these tokens in every text file and in path names. All placeholders sit inside strings or comments, so every starter file is still valid TypeScript, JSON, YAML or bash and can be tested in place.

| Token | Meaning | Example |
|---|---|---|
| `__PLUGIN__` | plugin name, kebab-case | `yousee` |
| `__SKILL__` | CLI skill name, kebab-case | `yousee` |
| `__REPO__` | GitHub `owner/name` of the plugin repo | `hoaj/yousee-plugin` |
| `__OWNER__` | GitHub owner of the plugin repo | `hoaj` |
| `__DESCRIPTION__` | one-line plugin description | |
| `__MAINTAINER__` | GitHub login of the maintainer | `hoaj` |
| `__GENERATOR_VERSION__` | site-cli-creator's own version | `0.1.0` |
| `__ORIGIN__` | the site origin | `https://www.yousee.dk` |
| `__AUTH__` | `login` or `none` | |

The plugin version starts at `0.1.0` and is written by the generator directly (not a placeholder token) in the four manifests, every SKILL.md version comment and every `cli/package.json`.

## 3. Generated plugin layout (after `new` + `add-skill`)

```
<plugin>/
  .claude-plugin/plugin.json .cursor-plugin/plugin.json .codex-plugin/plugin.json .github/plugin/plugin.json
  .claude-plugin/marketplace.json .cursor-plugin/marketplace.json .github/plugin/marketplace.json
  .agents/plugins/marketplace.json GENERATED the repo is its own marketplace, named after the plugin, listing it at "./" (Codex format in .agents/)
  .github/workflows/release.yml   STARTER  merge to main with a version change → tag, build, release, fixed-in labels
  .github/workflows/ci.yml        STARTER  PRs: bun test (version-sync, runtime), version-above-main check
  package.json                    STARTER  private, no version; scripts: bump, test
  scripts/bump.ts                 STARTER  bun run bump <patch|minor|major>
  scripts/version-check.ts        STARTER  fails when the PR's version is not above main's
  tests/version-sync.test.ts      STARTER  every pin (4 manifests, SKILL.md comments, cli/package.json, site.ts version) equals .claude-plugin/plugin.json's
  generated.json                  GENERATED {"generatedWith": "...", "maintainer": "..."}
  README.md                       GENERATED
  .gitignore
  skills/<plugin>-feedback/SKILL.md          from starter/feedback
  skills/<skill>/
    SKILL.md                      GENERATED from starter/skill/SKILL.md (command table filled by regen)
    install.sh                    STARTER
    .gitignore                    bin/
    captures/<task>/*.shape.json  shape-only Captures
    cli/
      package.json                STARTER  name, version, deps (zod, playwright-core)
      tsconfig.json  build.ts     STARTER
      src/main.ts                 STARTER  wires site + registry into the runtime
      src/runtime/*.ts            STARTER
      src/site.ts                 GENERATED from starter/skill/cli/src/site.ts, then edited by the agent
      src/registry.ts             GENERATED by regen.ts
      src/operations/<name>.ts    AGENT
      src/commands/<noun>-<verb>.ts AGENT
      tests/*.test.ts             STARTER runtime tests (run with bun test)
```

## 4. Runtime interfaces (starter/skill/cli/src/runtime)

All runtime modules are pure functions of their inputs where possible, so `bun test` can drive them with a fake `fetch` and a temp state dir. `main.ts` is the only file that imports `site.ts` and `registry.ts`.

### site.ts

```ts
import { defineSite } from "./runtime/site";
export default defineSite({
  plugin: "__PLUGIN__",
  skill: "__SKILL__",
  repo: "__REPO__",
  version: "0.1.0",                 // kept in sync by bump.ts (it is a pin too)
  generatedWith: "__GENERATOR_VERSION__", // info only (SPEC §5); doctor prints it
  origin: "__ORIGIN__",
  graphqlPath: "/graphql",          // optional; needed when any Operation uses graphql
  auth: "__AUTH__",                 // "login" | "none"
  needsChrome: false,               // regen sets true if auth is login or any Operation is a write
  login: {                          // auth: "login" only
    startUrl: "https://…",          // page that leads to the site's login
    hosts: ["login.example.com"],   // hosts that belong to the login flow
    tokenRequest: "/api/",          // substring or RegExp: the first request to this carrying an authorization header (or, if none carries one, a 2xx response) marks a finished login
    timeoutMs: 600_000,
    postLogin: async (ctx) => ({}), // derive chain-root ids; returns ids to store (never personal data)
  },
  bootstrap: async (ctx) => ({ headers: {} }), // auth: "none" only, optional: fetch cookie/CSRF; returns headers to send
  accounts: async (ctx) => [],      // optional: list accounts under one login (SPEC §7); [] or 1 → no --account needed
  readOnlyRequests: ["/api/session/post-login", /\/token\/refresh$/], // optional: non-GET requests the pages send that change no data; check --writes lets them through (string = URL path substring, RegExp = tested against the whole URL)
});
```

`ctx` for `postLogin`, `bootstrap` and `accounts`: `{ fetch: typeof fetch, origin: string, headers: Record<string,string>, ids: Record<string,string>, decodeJwt(token): object }`.

### operation.ts — `defineOperation`

```ts
type Operation = {
  name: string;                         // GraphQL operationName, or "METHOD /path/:param"
  effect: "read" | "write";
  graphql?: string;                     // trimmed query text
  rest?: { method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"; path: string; body?: (vars) => unknown; query?: (vars) => Record<string,string> };
  variables: z.ZodType;                 // validated before any call → input
  response: z.ZodType;                  // only fields the CLI reads → Zod failure is Drift
  needs?: Record<string, { from: "session"; key: string } | { from: string; pick: (result: any) => unknown }>;
  trigger?: (page: Page) => Promise<void>;  // writes only
};
```

REST `path` params are written `:name` and filled from variables. GraphQL Operations POST `{operationName, query, variables}` to `origin + graphqlPath`.

### command.ts — `defineCommand`

```ts
type Command = {
  name: "<noun> <verb>";
  summary: string;
  args: z.ZodObject<…>;                // flags; booleans are presence flags; validated → input
  uses: Operation[];
  run: (args, ctx: { call, session, account?: string, note }) => Promise<unknown>;
};
```

`ctx.call(op, vars)` performs one Operation. When the Operation is a `write` and the user did not pass `--confirm`, `call` throws a `DryRun` signal carrying `{operation: op.name, variables}` and `main` prints `{"dryRun": true, "would": {...}}` with exit 0 (SPEC §8). `ctx.session.ids` holds the chain-root ids. `ctx.account` is the `--account` value.

### envelope and exit codes (envelope.ts)

```ts
EXIT = { ok: 0, bug: 1, input: 2, drift: 3, session: 4, network: 5 }
class Failure extends Error { kind; message; fingerprint?; diff?; drifts?; stack? }
// stdout: exactly one JSON document. Success: the command's result. Failure:
{ "error": { "kind", "message", "fingerprint"?, "diff"?, "drifts"?, "stack"?, "version", "os", "next" } }
```

- `next` is a fixed sentence per kind, matching SPEC §8's exit-code table (exit 1 and 3 name the Feedback skill `<plugin>-feedback` and say it files only after the user's yes; exit 3 also says stop and don't work around it with raw calls; exit 2 mentions `--account` when accounts are listed).
- `os` is `<platform>-<arch>`. `version` is `site.version`.
- `drifts` is used by `check`: an array of `{operation, fingerprint, diff}`.
- `stack` (bug only): frames only, paths relative to `src/`, no values, no messages from user data.
- Progress goes to stderr.

### classification (call.ts) — SPEC §10

| Condition | Kind |
|---|---|
| variables fail Zod | input (no call made) |
| transport error, 5xx, 429 (after 1–2 retries) | network |
| GraphQL answer (any status) with `data` null and an error whose `extensions.code` is `INTERNAL_SERVER_ERROR`, `SERVICE_UNAVAILABLE` or starts with `INTERNAL` (retried like a 5xx; writes are not resent) | network |
| auth login: 401/403/3xx to a login host → refresh headless → else headed login → retry; still 401/403 | drift (breakType `auth`) |
| auth login: login doesn't complete | session |
| auth none: 401/403 → rerun bootstrap once → retry; still 401/403 | drift (breakType `auth`) |
| 404/405 on a REST path | drift (breakType `http`, code = status) |
| GraphQL `errors[]` with a validation code / "Cannot query field" | drift (breakType `graphql`) |
| GraphQL/HTTP 400/422 rejecting input that passed `variables` | drift (breakType `input-rejected`) |
| response fails Zod | drift (breakType `zod`, path, code = Zod issue code) |
| anything else thrown | bug |

### Fingerprint and bug key (fingerprint.ts)

- Drift: `plugin:skill:operation:breakType:path:code`, array indices written `[]`, e.g. `yousee:yousee:listFtpdProducts:zod:data.listFtpdProducts[].status:invalid_type`. In the operation segment REST params are written `{param}` (space kept), so the only colons are the separators: `shop:shop:GET /api/invoices/{id}:http::404` for the Operation `GET /api/invoices/:id` (`operationSegment()`). `check --op` accepts either form. `diff` is a list of `{path, code, expected?, received?}` where `received` is a **type name**, never a value.
- Bug: `plugin:skill:bug:<command-with-dashes>:<ErrorName>:<frame>`, where `<frame>` is the first stack frame inside `src/` as `relative/path.ts#function` with no line or column.

### session (session.ts)

- State dir: `~/.<plugin>-<skill>/` (mode 0700). Override with env `SITE_CLI_HOME` (tests only).
- `session.json` (0600): `{ headers: {authorization?, cookie?, …}, ids: {…}, accounts?: [...], savedAt }`.
- `profile/`: Chrome user-data dir (login skills only).
- No `last-error.json`.

### login and Chrome (login.ts, chrome.ts)

- `chrome.ts` finds Chrome at the fixed per-OS paths (SPEC §9), `SITE_CLI_CHROME` overrides.
- `login(headless)` uses `chromium.launchPersistentContext(profile, {channel: "chrome", headless})`, opens `site.login.startUrl`, waits for `tokenRequest`, collects the `authorization` header and the cookies for the site origin, runs `postLogin`, saves the session.
- Tests set `SITE_CLI_TEST=1`. Only then does env `SITE_CLI_ORIGIN` override `site.origin` (the fixture site runs on localhost), env `SITE_CLI_LOGIN_TIMEOUT_MS` replace `site.login.timeoutMs` (`loginTimeoutMs()`: the headed sign-in waits that long, the headless refresh at most 30 s; tests of a sign-in that never completes), and `login` may run headless.

### check (check.ts) — SPEC §10

- Orders read Operations by `needs` (topological). Resolves each variable from `session` or from an earlier result via `pick`.
- `--op <name>` checks one Operation (with its chain). `--writes` also runs each write Operation's `trigger(page)` in Chrome (login profile, or a fresh temp profile for auth none), intercepts the matching request with `page.route`, compares the request body shape to the Contract's `variables`, and aborts it. `check` never writes.
- While a trigger runs, every request gets `triggerVerdict(site, target, declaredWrites, reads, origin, req)`: the target write is captured and aborted; GET/HEAD/OPTIONS pass; another declared write is aborted; a non-GET passes only when it goes to a login host, is a declared read Operation, matches `login.tokenRequest` (auth login), matches `site.readOnlyRequests`, or is a GraphQL document whose query text is no mutation; a GraphQL mutation that is not a declared read is aborted even when `tokenRequest`/`readOnlyRequests` matches its URL; everything else is aborted. `WriteChecker = (writes, reads, declaredWrites?) => Promise<Map<name, DriftEntry|null>>`.
- Result: `{ ok: true, operations: [{operation, effect, status: "ok"|"skipped"}] }` or a drift Failure with `drifts`.

### built-in commands (main.ts) — SPEC §8

`help` (JSON: commands with flags and write marker, built-ins, exit codes), `login` (auth login only), `check [--op <name>] [--writes]`, `doctor`, `version`. Task commands are `<noun> <verb> [--flags]`. `--account <id>` and `--confirm` are global flags. Unknown command or flag → input.

Hidden built-in `selftest --url <http(s) url> [--no-chrome]` (runtime/selftest.ts, not listed by `help`): the platform smoke test of SPEC §9 / #29. It fetches the URL, launches Chrome headless with a temp profile and channel `chrome`, routes one request and aborts it (`net::ERR_FAILED`), and prints `{ok: true, fetch: <status>, chrome: true, abort: true}`; with `--no-chrome`, `{ok: true, fetch: <status>}`. A failed fetch is network (exit 5); no Chrome is input (exit 2). The generator's CI runs it on every target in `run-smoke`.

`doctor` prints: version, `site.generatedWith`, bun version, os, state dir, Chrome path or "not needed", gh status, quarantine / signature / Zone.Identifier findings for its own binary, and the `check` command to run.

## 5. Build, install, release (starter) — SPEC §9

- `cli/build.ts`: `bun build.ts <bun-target> <outfile>` with the playwright-core static-require patch (assert exactly 2 hits), `external: ["chromium-bidi", "electron"]`. Targets: `bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64 bun-windows-x64`. Release assets are `<skill>-<target>[.exe]`.
- `install.sh`: bash; reads the version from its SKILL.md comment `<!-- version: X.Y.Z -->`; steps in SPEC §9 order (gh present, gh logged in, Chrome if needed, platform supported, download, macOS xattr + codesign, Windows Unblock-File); 404 → repo visible? "still being built" : "ask <owner> for access". Testable with a stub `gh` on `PATH` and env `SITE_CLI_INSTALL_UNAME` overriding `uname -sm`.
- `release.yml`: on push to main, if `.claude-plugin/plugin.json` version has no tag yet → build every skill × 5 targets on ubuntu → `gh release create vX.Y.Z` → for each PR merged since the previous tag, for each `Fixes #n` / `Closes #n`, add label `fixed-in:vX.Y.Z` (create it if missing) and a comment.
- `ci.yml`: on pull_request: `bun install`, `bun test`, `bun scripts/version-check.ts` (version above main's).

## 6. Generator tools — SPEC §2, §3

- `bun tools/new.ts --dir <path> --plugin <name> --repo <owner/name> --description "<text>" --maintainer <login> [--no-labels] [--skip-checks]` → first checks the maintainer requirements of SPEC §13 (tools/lib/requirements.ts: Bun >= 1.4, Google Chrome at the fixed per-OS path or `SITE_CLI_CHROME`, `gh` installed and `gh auth status` ok, `gh api repos/<repo> --jq .permissions.admin` = `true`; a missing repo says `gh repo create <repo> --private --clone`) and, when any is unmet, writes nothing and fails with `{"error": {"message", "unmet": [{requirement, message}]}}` listing all of them; `--skip-checks` (tests and CI only) skips this. Then copies starter/plugin + starter/feedback, writes manifests (version 0.1.0), the four marketplace files (`.claude-plugin/`, `.cursor-plugin/`, `.github/plugin/marketplace.json`: `{name: <plugin>, owner, metadata.description, plugins: [{name, source: "./", description}]}`; `.agents/plugins/marketplace.json` in Codex's format with `source: {source: "local", path: "./"}`; no version, so they hold no pin), generated.json, README, creates labels `feature`, `unverified`, `needs-account` with `gh label create` unless `--no-labels`. Prints JSON.
- `bun tools/add-skill.ts --dir <plugin> --skill <name> --origin <url> --auth login|none` → copies starter/skill, fills placeholders, writes the skill's SKILL.md. Prints JSON.
- `bun tools/capture.ts --skill-dir <dir> --task <slug> --url <start> [--write] [--script <file.ts>] [--profile <dir>] [--headless] [--origin <url>] [--login-host <host>]...` → (`--origin` records another API origin, `--login-host` adds login hosts not yet in site.ts; when nothing was recorded it fails and leaves an earlier Capture of the Task untouched; sign-in steps are marked `loginFlow: true` and belong in site.ts, not in operations/) headed Chrome (tool-owned profile `~/.site-cli-creator/profile/`), records every request/response to the site as shapes only (no values, ids redacted, header values only for an allowlist of names, header names otherwise), aborts writes unless `--write` (then lets the first write through), writes `captures/<task>/<operation>.shape.json` and a `captures/<task>/index.json` listing operations in order with effect guesses. Stops when the browser is closed, on Enter, or when `--script` finishes. Raw traffic is never written to disk.
- `bun tools/draft-contract.ts <shape.json> [--name <op>] [--out <file.ts>]` → prints (or, with `--out`, writes, refusing to overwrite) a draft `src/operations/<name>.ts` with a Zod response schema covering all fields (the agent then cuts it down) and a trimmed GraphQL query skeleton when the shape is GraphQL.
- `bun tools/regen.ts --skill-dir <dir>` → rewrites `cli/src/registry.ts` (static imports of every file in operations/ and commands/), sets `needsChrome` in site.ts, runs `bun src/main.ts help` and rewrites the `## Commands` table in the skill's SKILL.md between `<!-- commands:start -->` and `<!-- commands:end -->`.

## 7. Tests

- `starter/skill/cli/tests/*.test.ts`: runtime unit tests with a fake fetch (classification table, fingerprints, bug key, envelope, dry run, accounts, check ordering, session file modes).
- `starter/plugin/tests/version-sync.test.ts` + bump tests.
- Starter tests that need an unfilled `site.ts` (`__AUTH__` still a placeholder) skip themselves in a generated plugin, where add-skill has filled the token in the test file too.
- `skills/site-cli-creator/tests/`: shape extraction and redaction, draft-contract, new/add-skill/regen scaffolding (manifests, marketplaces, maintainer requirements), skills-docs (SKILL.md structure, links, tool flags in the guidance, the CI workflow; plugin files are found relative to the test file, and the hoaj/skills wiring checks (bankmcp manifest parity, repo marketplaces, README, the workflow) skip in a copy of just this plugin but are required under `GITHUB_ACTIONS`), install.sh with a stub gh, and the end-to-end test `e2e.test.ts`, once per auth mode with its own fixture site, temp dirs and `SITE_CLI_HOME`: start fixtures/site, `new --skip-checks --no-labels`, `add-skill`, copy fixtures/expected, `bun install`, regen (command table, `needsChrome`), compile the host target with `build.ts` (`bun-<os>-<arch>` from `process.platform`/`arch`), then drive the binary: `login` (session.json 0600 in a 0700 dir, chain-root ids only), sign-in on its own after the session is deleted, a blocked sign-in with `SITE_CLI_LOGIN_TIMEOUT_MS` → exit 4, Task commands, a write dry run and `--confirm`, input errors with no request sent, every Drift switch → exit 3 with its Fingerprint and a type-only diff, outages → exit 5, a crashing command added and rebuilt → exit 1 with the bug key, `check` (drifts, `--op` in both name forms, `--writes` never sends the write), `help`/`version`/`doctor`; the Capture tool (`--headless --script`, a read Task and a `--write` Task against a fresh fixture) and `draft-contract --out`; and `install.sh` with a fake `gh` serving the compiled binary as `<skill>-<target>`. Every stdout must be exactly one JSON document, and no fixture value may appear in envelopes or shape files. Skipped when Chrome is absent.
- Run everything with `bun test` from `plugins/site-cli-creator/`.
