# site-cli-creator: architecture and build contract

This is the implementation contract for the generator described in [`SPEC.md`](../../SPEC.md). SPEC.md says **what** and **why**. This file says **where** and **with which interfaces**. If they disagree, SPEC.md wins and this file is fixed.

Glossary terms (Task, CLI skill, Feedback skill, Starter code, Capture, Operation, Contract, Effect, Drift, Fingerprint) are defined in [`CONTEXT.md`](../../CONTEXT.md).

## 1. Layout of the generator plugin

```
plugins/site-cli-creator/
  .claude-plugin/plugin.json  .cursor-plugin/plugin.json  .github/plugin/plugin.json
  package.json                 dev + tool dependencies (zod, playwright-core, typescript, @types/bun)
  tsconfig.json                strict, the Starter CLI's options: tools, tests, fixtures/site, starter/plugin
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
        site/                  a local test website (GraphQL + REST, login and public modes, drift switches;
                               run as a server it also takes POST /__drift?name=<drift|none>, sessions kept)
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
| `__GENERATOR_VERSION__` | site-cli-creator's own version | `0.3.0` |
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
  .github/workflows/ci.yml        STARTER  PRs: bun test (version-sync, runtime), version-above-main check;
                                           push to main: scripts/stale-prs.ts marks open PRs no longer above main
  package.json                    STARTER  private, no version; scripts: bump, test
  scripts/bump.ts                 STARTER  bun run bump <patch|minor|major>
  scripts/version-check.ts        STARTER  fails when the PR's version is not above main's
  scripts/stale-prs.ts            STARTER  failing "version above main" status on every open PR whose version is not above main's
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
      src/lib/*.ts                AGENT    shared code between commands (never registered)
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
  generatedWith: "__GENERATOR_VERSION__", // generated.json's, filled by add-skill; doctor prints generated.json's own (fallback: this)
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

`ctx` for `postLogin`, `bootstrap` and `accounts`: `{ fetch: typeof fetch, origin: string, headers: Record<string,string>, ids: Record<string,string>, decodeJwt(token): object, call }`. `fetch` is plain fetch (no headers added, no cookie jar); `decodeJwt` takes the token with or without `Bearer `; `call` performs an Operation like a command's `ctx.call`.

### operation.ts — `defineOperation`

```ts
type Operation = {
  name: string;                         // GraphQL operationName, or "METHOD /path/:param"
  effect: "read" | "write";
  graphql?: string;                     // trimmed query text
  rest?: { method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"; path: string; body?: (vars) => unknown; bodyType?: "json"|"form"; query?: (vars) => Record<string,string> };
  variables: z.ZodType;                 // validated before any call → input
  response: z.ZodType;                  // only fields the CLI reads → Zod failure is Drift
  needs?: Record<string, { from: "session"; key: string } | { from: string; pick: (result: any) => unknown } | { value: unknown }>; // value: a constant
  trigger?: (page: Page) => Promise<void>;  // writes only
};
```

REST `path` params are written `:name` and filled from variables. `body(vars)` is sent as JSON (`application/json`), or with `bodyType: "form"` form-urlencoded (`buildRequest`: a flat object; arrays repeat their key, undefined/null are left out, a nested object is a ContractError). One variables convention for REST, shared by `draft-contract` (tools/lib/draft.ts) and `check --writes` (`capturedVariables`): path params, query keys and the body's fields are all top-level variables (`body: (v) => ({ name: v.name })`); a body that is no object is the variable `body`; a body keyed by data (a Shape `record`) drafts as `.catchall(...)` with `body: ({ <url keys>, ...body }) => body`. GraphQL Operations POST `{operationName, query, variables}` to `origin + graphqlPath`.

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

`ctx.call(op, vars)` performs one Operation and returns its parsed `response`. When the Operation is a `write` and the user did not pass `--confirm`, `call` throws a `DryRun` signal carrying `{operation: op.name, variables}` and `main` prints `{"dryRun": true, "would": {...}}` with exit 0 (SPEC §8). `ctx.session.ids` holds the chain-root ids. `ctx.account` is the `--account` value. `inputFailure(message): never` (command.ts) ends a command with exit 2: a command checks a value the user supplies (an id) against its list Operation with it, so a typo is input while a 404 on a known REST path stays Drift (SPEC §10). `trigger(page)` starts on `about:blank`.

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

- Drift: `plugin:skill:operation:breakType:path:code`, array indices written `[]` and record or map keys `{}` (they are the site's data: emails, phone numbers, ids), e.g. `yousee:yousee:listFtpdProducts:zod:data.listFtpdProducts[].status:invalid_type`. In the operation segment REST params are written `{param}` (space kept), so the only colons are the separators: `shop:shop:GET /api/invoices/{id}:http::404` for the Operation `GET /api/invoices/:id` (`operationSegment()`). `check --op` accepts either form. `diff` is a list of `{path, code, expected?, received?}` where `received` is a **type name**, never a value. `fieldPath(path, schema?)` walks the Contract's Zod schema next to the issue path (through optional, nullable, pipe, lazy, union, intersection): a key that is not a declared `z.object` field is written `{}`; without a schema, a key that is no identifier or holds 4+ digits is. `zodDiff(issues, input, schema)` is called with `op.response` (call.ts), `op.variables` (check.ts `compareWrite`, call.ts input messages). A `trigger` Drift's path is the locator its failed step waited for (`triggerStep()`: from Playwright's "waiting for …" line, colons replaced, at most 80 characters), e.g. `shop:shop:addNote:trigger:getByLabel('Ny note'):TimeoutError`.
- Bug: `plugin:skill:bug:<command-with-dashes>:<ErrorName>:<frame>`, where `<frame>` is the first stack frame inside `src/` as `relative/path.ts#function` with no line or column.

### session (session.ts)

- State dir (`stateDir(site, env, home?)`): `~/.<plugin>/` when `site.skill === site.plugin`, else `~/.<plugin>-<skill>/` (mode 0700). Override with env `SITE_CLI_HOME` (tests only).
- Legacy dir (`legacyStateDir()`): `~/.<plugin>-<plugin>/`, where builds before generator 0.2.1 kept a skill named after its plugin; null when `SITE_CLI_HOME` is set or the names differ. `run()` calls `migrateStateDir()` first, on every command: when the legacy dir exists and the new one doesn't, it renames it (one `renameSync`, then chmod 0700 on the dir and 0600 on `session.json`) and notes the move on stderr, so the user stays signed in. Both exist: nothing moves (`{moved: false, leftAlone}`), and `doctor` names the old one. A failed move is a stderr note, never an error. Nothing is ever merged or deleted.
- `session.json` (0600): `{ headers: {authorization?, cookie?, …}, ids: {…}, accounts?: [{id}], fromProfile?, savedAt }`. `fromProfile` is the absolute path of the Chrome profile `login --from-profile` signed in from (a path, no cookie); any other sign-in drops it. Accounts are ids only: labels come from the site and live only in the run's memory. An `--account` the cached list lacks, or a choice between several accounts (the input envelope lists labels), fetches the list again. An `auth: "none"` skill without `bootstrap` never writes `session.json`.
- `SITE_CLI_NONINTERACTIVE=1` (not test-only): when the headless refresh fails, a command exits 4 at once instead of opening a headed sign-in and waiting `login.timeoutMs`. `login` itself still opens Chrome.
- `profile/`: Chrome user-data dir (login skills only).
- No `last-error.json`.

### login and Chrome (login.ts, chrome.ts)

- `chrome.ts` finds Chrome at the fixed per-OS paths (SPEC §9), `SITE_CLI_CHROME` overrides.
- `login(headless)` uses `chromium.launchPersistentContext(profile, {channel: "chrome", headless})`, opens `site.login.startUrl`, waits for `tokenRequest`, collects the `authorization` header and the cookies for the site origin, runs `postLogin`, saves the session.
- `login --from-profile <dir>` (`Deps.login(headless, {fromProfile})`, `profileState()`): opens that Chrome profile headless (the Capture tool's `~/.site-cli-creator/profile`), reads its cookies for the site's hosts into memory (`siteCookie()`: a host on the origin's domain, `siteDomain()`, the scope the Capture tool records, so `api.example.com` for `www.example.com`; a login host or its subdomain, `isLoginHost()`; or a parent domain of either), closes it, starts a Chrome context with no profile on disk holding them (`launchInMemory(…, state)`: `chromium.launch` + `newContext({storageState})`, never the skill's own `profile/`), runs the headless sign-in above there, then closes it. Cookie values are never written except into `session.json` (0600) as for any login, and never logged (stderr names only their count). A missing dir or a profile Chrome can't open (a Capture still running on it) is input; no sign-in carried over is session. It saves the dir as `fromProfile` in `session.json` and prints `{loggedIn, fromProfile: true, stateDir, ids}`.
- The silent refresh (`Client.signInOrFail()`): when `session.json` names a `fromProfile` that still exists (`Client.fromProfile()`), it first signs in headless from that profile the same way (in memory; a profile Chrome can't open counts as not signed in), then headless from the skill's own `profile/`, then headed (unless `SITE_CLI_NONINTERACTIVE=1`). So after `login --from-profile` the maintainer never signs in a second time while the Capture's sign-in lasts.
- Tests set `SITE_CLI_TEST=1`. Only then does env `SITE_CLI_ORIGIN` override `site.origin` (the fixture site runs on localhost), env `SITE_CLI_LOGIN_TIMEOUT_MS` replace `site.login.timeoutMs` (`loginTimeoutMs()`: the headed sign-in waits that long, the headless refresh at most 30 s; tests of a sign-in that never completes), and `login` may run headless.

### check (check.ts) — SPEC §10

- Orders read Operations by `needs` (topological). Resolves each variable from `session`, from an earlier result via `pick`, or from a constant `{ value }`.
- A read Operation whose variables can never be built from its `needs` (a required variable with no entry, or a constant that does not fit) is skipped with reason `never checkable: …` (`no needs entry for <variable>` or `the needs entry for <variable> does not fit variables`, each with its own fix in the warning) and listed in the result's `warnings`; `regen.ts` warns about both too, with the same rule and text (both use `runtime/needs.ts`, which regen imports from the Starter; a generated plugin keeps its own copy); `check` still exits 0 (nothing drifted, the site is fine) but prints `ok: false`. A skip that depends on the account's data (an empty list to pick from) is no warning.
- `--op <name>` checks one Operation (with its chain). `--writes` also runs each write Operation's `trigger(page)` in headless Chrome (`chromeWriteChecker(site, env, fromProfile?)`): for auth none a fresh temp profile; for a login, the skill's own `profile/`, or, when `session.json` names a `fromProfile` that still exists, a context with no profile on disk holding that profile's site cookies and the origin's localStorage (`profileState(…, {localStorage: true})`, read on a page whose every request is fulfilled locally, so nothing reaches the site), as the skill's own profile would hold them after a plain `login`. It intercepts the matching request with `page.route`, compares the request body shape to the Contract's `variables`, and aborts it. `check` never writes.
- The intercepted body is read by its content-type (`parseCaptured`): form-urlencoded into an object of its fields, otherwise JSON when it parses, else text. For a REST write with a `body`, a request whose encoding (json/form, from its content-type) differs from `rest.bodyType` is request Drift with code `body_type` (`expected`/`received` are the encodings).
- While a trigger runs, every request gets `triggerVerdict(site, target, declaredWrites, reads, origin, req)`: the target write is captured and aborted; GET/HEAD/OPTIONS pass; another declared write is aborted; a login host passes; a GraphQL request (a POST to `site.graphqlPath` on the origin, or a non-form body with a document carrying `query` text or `extensions.persistedQuery`) is decided by its documents alone and never by a URL rule: it passes only when every document's operation (`graphqlOperation`: the definition `operationName` selects, else the only definition or the `{ … }` shorthand, scanning all top-level definitions as tools/lib/graphql.ts `describeQuery` does) is a query, or its `operationName` names a declared GraphQL read; a mutation or subscription, no query text (persisted, hash only), several definitions without `operationName`, an `operationName` the text does not define, or an empty batch aborts. Any other non-GET passes only when it is a declared read Operation, matches `login.tokenRequest` (auth login) or matches `site.readOnlyRequests`; everything else is aborted. `matchesOperation` names a GraphQL document by that same selected operation. `WriteChecker = (writes, reads, declaredWrites?) => Promise<Map<name, DriftEntry|null>>`.
- A network, session or input failure on one Operation does not discard Drift already found: the Operation gets a `failed` row (reason: the kind), and `check` goes on (after a session failure it reaches nothing more). If anything drifted it exits 3 with every drift (the message counts the Operations it could not check); otherwise it exits with the first other failure's kind.
- Result: `{ ok, operations: [{operation, effect, status: "ok"|"skipped"|"failed", reason?}], warnings?: string[] }` or a drift Failure with `drifts`. `ok` is false exactly when `warnings` is present; the exit stays 0.

### built-in commands (main.ts) — SPEC §8

`help` (JSON: commands with flags and write marker, built-ins, exit codes), `login [--from-profile <dir>]` (auth login only), `check [--op <name>] [--writes]`, `doctor`, `version`, `mcp` (below). Task commands are `<noun> <verb> [--flags]`. `--account <id>` and `--confirm` are global flags. Unknown command or flag → input. `<command> --help` or `-h` (a Task command or a listed built-in, wherever the flag stands except as another flag's value: `wantsHelp()`) prints that command's entry from `help` plus `usage` and `globalFlags` (`commandHelp()`) and exits 0, before any flag is validated, without signing in or calling the site. A Task command runs through `runTask()` and any throw through `failed(e, site, commandName, surface)`, which the MCP server shares.

Hidden built-in `selftest --url <http(s) url> [--no-chrome]` (runtime/selftest.ts, not listed by `help`): the platform smoke test of SPEC §9 / #29. It fetches the URL, launches Chrome headless with a temp profile and channel `chrome`, routes one request and aborts it (`net::ERR_FAILED`), and prints `{ok: true, fetch: <status>, chrome: true, abort: true}`; with `--no-chrome`, `{ok: true, fetch: <status>}`. A failed fetch is network (exit 5); no Chrome is input (exit 2). The generator's CI runs it on every target in `run-smoke`.

### mcp (runtime/mcp.ts, main.ts `mcpServer`) — SPEC §8 MCP server

- `run(["mcp"])` returns `{output: null, code: 0, serve: "mcp"}`; `main(argv, app)` (the entry point, and `tests/fixtures/cli.ts`) then calls `serveStdio(mcpServer(app))` and exits 0 when stdin ends. Any flag after `mcp` is input.
- `runtime/mcp.ts` is the protocol only and imports nothing from main: `createMcpServer({name, version, instructions}, tools)` → `{handle(message)}` answers `initialize` (echoes a known `protocolVersion` from `PROTOCOL_VERSIONS`, else the newest; capabilities `{tools: {listChanged: false}}`), `ping`, `tools/list`, `tools/call`; notifications get no answer; an unknown method is -32601, an unknown tool or non-object `arguments` -32602, a message that is no request -32600. `serveStdio(server, input?, write?)` reads one JSON message per line, answers in order (one at a time, so two calls never refresh one session together), writes one line per answer, and answers a line that is no JSON with -32700. `inputSchema(zodObject)` is `z.toJSONSchema(…, {io: "input", unrepresentable: "any"})` without `$schema`; `toolResult(output, code)` is `{content: [{type: "text", text: JSON}], structuredContent? (objects only), isError? (code ≠ 0)}`.
- `mcpServer(app)` in main.ts builds the tools: per Task command `toolName(name)` (`invoice list` → `invoice_list`), schema `command.args.extend({account, confirm (writes only)}).strict()`, annotations `{readOnlyHint: true, openWorldHint: true}` for reads and `{readOnlyHint: false, destructiveHint: true, openWorldHint: true}` for writes; then `login` (auth login: `Client.signIn(false)`), `check {op?, writes?, account?}` and `doctor`. Arguments failing the schema are input. Every call runs with `deps.env.SITE_CLI_NONINTERACTIVE = "1"` and a `Client` per call (`confirm` from the arguments), and ends in `failed(…, "mcp")`.
- `errorEnvelope(f, site, surface)` / `nextStep(kind, site, hasAccounts, surface)`: with `"mcp"` the sentences name tools and arguments (`login` tool, `account` argument, the input schema), and bug and Drift offer `<plugin>-feedback` when the client has it, else `https://github.com/<repo>/issues/new`, either only on a yes.
- Server name: `<plugin>` when the skill is named after it, else `<plugin>-<skill>`; version `site.version`. The instructions state the dry-run-then-`confirm` rule and "do what `next` says; on drift stop".

`doctor` prints: version, `generatedWith` and `maintainer` from the plugin's `generated.json` (read at run time, three levels above a binary in `skills/<skill>/bin/` or five above `src/runtime/` from source, so a handover shows without a new binary; `generated` says which file, and `site.generatedWith` is the fallback), bun version, os, state dir (plus `oldStateDir` when an older build's `~/.<plugin>-<plugin>/` is still beside `~/.<plugin>/`, left alone and unused), Chrome path or "not needed", gh status, quarantine / signature / Zone.Identifier findings for its own binary, and the `check` command to run.

## 5. Build, install, release (starter) — SPEC §9

- `cli/build.ts`: `bun build.ts <bun-target> <outfile>` with the playwright-core static-require patch (assert exactly 2 hits), `external: ["chromium-bidi", "electron"]`. Targets: `bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64 bun-windows-x64`. Release assets are `<skill>-<target>[.exe]`.
- `install.sh`: bash; reads the version from its SKILL.md comment `<!-- version: X.Y.Z -->`; steps in SPEC §9 order (gh present, gh logged in, Chrome if needed, platform supported, download, macOS xattr + codesign, Windows Unblock-File); 404 → repo visible? "still being built" : "ask <owner> for access". Testable with a stub `gh` on `PATH` and env `SITE_CLI_INSTALL_UNAME` overriding `uname -sm`.
- `release.yml`: on push to main, if `.claude-plugin/plugin.json` version has no tag yet → build every skill × 5 targets on ubuntu → `gh release create vX.Y.Z` → for each PR merged since the previous tag, for each `Fixes #n` / `Closes #n`, add label `fixed-in:vX.Y.Z` (create it if missing) and a comment. Concurrency is one group per commit (a shared group would cancel a pending run, and its version would never be released); `publish` is serialised per version and skips a release that exists. A commit that changes CLI code without changing the version fails the run, whether or not that version is tagged yet (two PRs that bumped to the same version both merged).
- `ci.yml`: on pull_request: `bun install`, `bun test`, `bun scripts/version-check.ts` (version above main's). On push to main: `bun scripts/stale-prs.ts`, which posts a failing `version above main` commit status on the head of every open PR whose version is not above the new main's, so a stale green check cannot merge (SPEC §9 Collisions). `fix` also runs `version-check` against a fresh `origin/main` just before merging.

## 6. Generator tools — SPEC §2, §3

- Every tool: `--help` (or `-h`) prints `{usage, flags: {"--flag": meaning}, notes?}` and exits 0. A `next` field names the tool by its absolute path, so it runs from any directory.
- `bun tools/new.ts --dir <path> --plugin <name> --repo <owner/name> --description "<text>" --maintainer <login> [--no-labels] [--skip-checks]` → first checks the maintainer requirements of SPEC §13 (tools/lib/requirements.ts: Bun >= 1.4, Google Chrome at the fixed per-OS path or `SITE_CLI_CHROME`, `gh` installed and `gh auth status` ok, `gh api repos/<repo> --jq .permissions.admin` = `true`; a missing repo says `gh repo create <repo> --private --clone`) and, when any is unmet, writes nothing and fails with `{"error": {"message", "unmet": [{requirement, message}]}}` listing all of them; `--skip-checks` (tests and CI only) skips this. Then copies starter/plugin + starter/feedback, writes manifests (version 0.1.0), the four marketplace files (`.claude-plugin/`, `.cursor-plugin/`, `.github/plugin/marketplace.json`: `{name: <plugin>, owner, metadata.description, plugins: [{name, source: "./", description}]}`; `.agents/plugins/marketplace.json` in Codex's format with `source: {source: "local", path: "./"}`; no version, so they hold no pin), generated.json, README, creates labels `feature`, `drift`, `bug`, `unverified`, `needs-account` with `gh label create` unless `--no-labels`. Prints JSON. A label it could not create fails the tool (exit 1) after the files are written: `{"error": {message, dir, labels: {created, failed}, retry: [gh label create …], next}}`; the loop needs every label, and the files are kept.
- `bun tools/add-skill.ts --dir <plugin> --skill <name> --origin <url> --auth login|none` → copies starter/skill, fills placeholders (`__GENERATOR_VERSION__` from `generated.json`'s `generatedWith`, else the generator's version), writes the skill's SKILL.md. Prints JSON.
- `bun tools/capture.ts --skill-dir <dir> --task <slug> --url <start> [--write] [--write-op <op>] [--allow-read <op>]... [--script <file.ts>] [--profile <dir>] [--headless] [--origin <url>] [--login-host <host>]...` → (`--origin` records another API origin, `--login-host` adds login hosts (host names, no port) not yet in site.ts; when nothing was recorded it fails and leaves an earlier Capture of the Task untouched) headed Chrome (tool-owned profile `~/.site-cli-creator/profile/`, which keeps cookies between Captures), records every request/response to the site as shapes only, writes `captures/<task>/<operation>.shape.json` and a `captures/<task>/index.json` listing operations in order with effect guesses. Stops when the browser is closed; when the last page on the recorded hosts closes (the Task window, the first page, counts even if it had left them; a tab the site opened on its own hosts keeps the Capture going), even if windows on other sites remain (they are closed, and the output's `closedWindows` counts them); on SIGINT or SIGTERM (a clean stop that still writes the Capture, `stoppedBy: "SIGINT"`; Playwright's own signal handlers are off); on Enter; or when `--script` (a module whose default export gets the Playwright page after `--url` is open) finishes. A headed Capture prints its pid and, every 30 s (`SITE_CLI_CAPTURE_HINT_MS`, tests), a `still recording: N windows open` hint naming `kill -INT <pid>` on stderr. Raw traffic is never written to disk; values stay in memory only.
  - **What goes through** (tools/lib/recorder.ts): a read Task aborts every non-GET/HEAD/OPTIONS request on **every** host, recorded or not, except sign-in steps and `--allow-read` matches (a GraphQL operationName, or a part of `host/path`). Sign-in steps: any request to a declared login host (site.ts `login.hosts`, `--login-host`) unless it is a DELETE or its path names a change (`logout`, `revoke`, `reset`, `update`, `…preferences`, …); a write whose path or operation name holds a sign-in word (`login`, `signin`, `oauth`, `authorize`, `post-login`, …) or is a token/session endpoint (`/api/token`, `/auth/refresh`, `POST /api/session`, `refreshToken`), never a DELETE or a change; a document (form) POST to a host whose first label looks like a sign-in host (`login.`, `id.`, `auth.`, …). They are marked `loginFlow: true` and belong in site.ts. Writes to hosts outside the recorded scope are listed in the output's `blockedElsewhere`. The hosts other than the origin's that sign-in steps went to (a sign-in step or page on a declared or sign-in-named host, a sign-in document form, a sign-in write outside the recorded scope) are listed as host names in `loginHosts` (output and `index.json`); those not yet in site.ts or `--login-host` get a hint to add them to `login.hosts`. A hash-only persisted GraphQL query sent by POST is treated as a write (`effectUnknown: true`). With `--write`, exactly one write goes through: the one `--write-op` names, else the first after a trusted click, key press or submit in the page (an init script reports them through an exposed binding; a main-frame document request resets it, so writes a page fires while loading are aborted). The output's `wrote` names it; `hints` explains when none went through.
  - **Shapes**: no values; ids, dotted names (`jens.hansen`) and every path segment equal to a value the Capture sent or received (or a capitalised word of one) become `:id`; keys that look like data collapse into a `record`; every GraphQL number and string literal is redacted (a leading comment says so when numbers were); strings carry a format class (`numeric`, `date`, `datetime`; none in form bodies); header values only for an allowlist of names, header names otherwise; response header names and Set-Cookie cookie names (`setCookies`); a bearer JWT's claim names and types (`request.bearerClaims`). Page loads are marked `navigation: true`. Next.js: a non-GET with a `next-action` header is a server action (`serverAction: true, effectUnknown: true`; a read Task aborts it and prints `server action aborted … --allow-read <path>` on stderr at once), and a `text/x-component` response, a `_rsc` query key or an `rsc: 1` header marks an RSC stream (`rsc: true`); neither is ever an Operation. A request is GraphQL only when it goes to a GraphQL path (a segment `graphql`, `gql`, `…graphql…`) or carries a GraphQL document (`{ … }` or a `query`/`mutation`/`subscription`/`fragment` definition, tools/lib/graphql.ts `isGraphqlDocument`) or `extensions.persistedQuery`; a `query` URL parameter or body field on a REST path holding anything else (a search word) is an ordinary field, recorded as a type.
- `bun tools/draft-contract.ts <shape.json> [--name <op>] [--out <file.ts>]` → prints (or, with `--out`, writes, refusing to overwrite) a draft `src/operations/<file>.ts` with a Zod response schema covering all fields (the agent then cuts it down) and a trimmed GraphQL query skeleton when the shape is GraphQL. The same Operation in the skill's other `captures/*/` is merged in (`mergedFrom`). A place seen only as null drafts as `z.unknown().nullable()` with a TODO; a string's format is a comment. `file` is the suggested file (REST: verb + noun, `getInvoice.ts`; GraphQL: the operationName), or the written path with `--out`. `--name` sets a GraphQL Contract's name; for a REST shape it is refused (the name is `METHOD /path`).
- `bun tools/regen.ts --skill-dir <dir>` → rewrites `cli/src/registry.ts` (static imports of every file in operations/, and of each commands/ file whose default export is a command (`name`, `uses`, `run`), whatever its name, with a warning when the name is not the command's `<noun>-<verb>.ts`; any other file in commands/ is left out with a warning pointing to `cli/src/lib/`), sets `needsChrome` in site.ts, warns (stderr and `warnings` in its JSON) about each read Operation with a required variable (its Zod field rejects `undefined`) that no `needs` entry supplies, runs `bun src/main.ts help` and rewrites the `## Commands` table in the skill's SKILL.md between `<!-- commands:start -->` and `<!-- commands:end -->`.

## 7. Tests

- `starter/skill/cli/tests/*.test.ts`: runtime unit tests with a fake fetch (classification table, fingerprints, bug key, envelope, dry run, accounts, check ordering, session file modes; `mcp.test.ts`: tools, schemas, annotations, results equal to the CLI's, dry run and `confirm`, MCP `next` texts, no headed sign-in, protocol errors, and `mcp` over stdio through `tests/fixtures/cli.ts`).
- `starter/plugin/tests/version-sync.test.ts` + bump tests.
- Starter tests that need an unfilled `site.ts` (`__AUTH__` still a placeholder) skip themselves in a generated plugin, where add-skill has filled the token in the test file too.
- `skills/site-cli-creator/tests/`: shape extraction and redaction, draft-contract, new/add-skill/regen scaffolding (manifests, marketplaces, maintainer requirements), skills-docs (SKILL.md structure, links, tool flags in the guidance, the CI workflow; plugin files are found relative to the test file, and the hoaj/skills wiring checks (bankmcp manifest parity, repo marketplaces, README, the workflow) skip in a copy of just this plugin but are required under `GITHUB_ACTIONS`), install.sh with a stub gh, and the end-to-end test `e2e.test.ts`, once per auth mode with its own fixture site, temp dirs and `SITE_CLI_HOME`: start fixtures/site, `new --skip-checks --no-labels`, `add-skill`, copy fixtures/expected, `bun install`, regen (command table, `needsChrome`), compile the host target with `build.ts` (`bun-<os>-<arch>` from `process.platform`/`arch`), then drive the binary: `login` (session.json 0600 in a 0700 dir, chain-root ids only), the state dir with `HOME` instead of `SITE_CLI_HOME` (the login skill is named after its plugin: `login` and `login --from-profile` write `~/.<plugin>/`, an older build's `~/.<plugin>-<plugin>/` moves there once and stays signed in, and with both present the old one is left alone and `doctor` names it), sign-in on its own after the session is deleted, a blocked sign-in with `SITE_CLI_LOGIN_TIMEOUT_MS` → exit 4, Task commands, a write dry run and `--confirm`, input errors with no request sent, every Drift switch → exit 3 with its Fingerprint and a type-only diff, outages → exit 5, a crashing command added and rebuilt → exit 1 with the bug key, `check` (drifts, `--op` in both name forms, `--writes` never sends the write), `help`/`version`/`doctor`, `mcp` over stdio (tool list, a Task result equal to the CLI's, a write dry run that sends nothing, Drift with the same Fingerprint and no fixture values); the Capture tool (`--headless --script`, a read Task and a `--write` Task against a fresh fixture) and `draft-contract --out`; and `install.sh` with a fake `gh` serving the compiled binary as `<skill>-<target>`. Every stdout must be exactly one JSON document, and no fixture value may appear in envelopes or shape files. Skipped when Chrome is absent.
- Run everything with `bun test` from `plugins/site-cli-creator/`. Type-check with `bun x tsc --noEmit -p .` there and in `starter/skill/cli/`; the generator's CI runs both before the tests.
