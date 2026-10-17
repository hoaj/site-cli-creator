# site-cli-creator: build spec

site-cli-creator is a skill that turns the calls a website's frontend makes into a **plugin** for coding agents. Each plugin holds one or more **CLI skills**. A CLI skill wraps one site, with one login or none, and runs **Tasks** as commands. It detects when the site changes (**Drift**). The plugin's **Feedback skill** reports it, once the user agrees, to the plugin's repo, where the generator fixes it.

Glossary terms (**Task**, **CLI skill**, **Feedback skill**, **Starter code**, **Capture**, **Operation**, **Contract**, **Effect**, **Drift**, **Fingerprint**) are defined in [`CONTEXT.md`](./CONTEXT.md). Sections link the tickets that decided them, on the map [site-cli-creator](https://github.com/hoaj/skills/issues/1). The test case is Mit YouSee (yousee.dk): reading the logged-in user's subscription.

---

## 1. Parts

| Part | Who runs it | What it is |
|---|---|---|
| **site-cli-creator** | the maintainer | a plugin in `hoaj/skills`: the generator skill (SKILL.md, the Starter code, the Capture tool) and `site-cli-creator-feedback` |
| **Generated plugin** | many users | its own repo, holding one or more CLI skills, one Deploy skill, one Feedback skill, four manifests and a release workflow |
| **CLI skill** | users' agents | `skills/<skill>/`: a SKILL.md and a compiled CLI for one site, with one login or none (§7) |
| **Deploy skill** | the Owner's agent | `skills/<plugin>-deploy/`: runs a CLI skill in remote mode on a host the Owner controls (Railway first), see **Deploy shape** in §8 |
| **Feedback skill** | users' agents | `skills/<plugin>-feedback/`: files Drift, bugs and feature requests on the plugin's own repo (§10) |

Every Feedback skill lies next to the plugin it reports on and files issues on that plugin's repo, decided in [Feedback skills next to each plugin](https://github.com/hoaj/skills/issues/24). `site-cli-creator-feedback` files problems with the generator itself (the Capture tool, a mode, the Starter code, misleading guidance) on `hoaj/skills` with the label `site-cli-creator`. It does not forward users' issues from generated plugins, but `fix` offers it when a plugin bug turns out to come from the Starter code (§5).

The generator writes into a repo that the person running it chooses. **After generation, a plugin shares no code with the generator and depends on nothing from it.** It owns every file it has, decided in [No shared code in generated plugins](https://github.com/hoaj/skills/issues/26).

## 2. Generator modes

Decided in [Who picks a plugin's task commands?](https://github.com/hoaj/skills/issues/11), [One site per plugin, or several?](https://github.com/hoaj/skills/issues/12) and [How do generated plugins pick up template fixes?](https://github.com/hoaj/skills/issues/13), changed by [No shared code in generated plugins](https://github.com/hoaj/skills/issues/26), which removed `upgrade`.

| Mode | Trigger | Does |
|---|---|---|
| `new` | a new site | copies the Starter code (§5) into a new plugin, writes `generated.json`, creates the repo labels the loop uses (`feature`, `drift`, `bug`, `unverified`, `needs-account`; `fixed-in:*` labels are made by `release.yml`), writes the Deploy skill (`skills/<plugin>-deploy/`), then runs **add-skill** for the first CLI skill |
| `add-skill` | a new site or login in an existing plugin | creates `skills/<skill>/`, asks whether the site needs a login and confirms it from the Capture (`auth`, §7), sets up login or `bootstrap`, then runs **add-task** for each Task |
| `add-task` | a feature request filed by the Feedback skill, or the maintainer | runs the Task loop (§3) once, reusing existing Operations, then opens a PR that the maintainer merges. If the maintainer's account can't perform the Task, the issue is closed with an explanation and the label `needs-account` (§13) |
| `fix` | a Drift or bug issue | **Drift:** re-captures only the affected Task, updates the Contract, runs `check`, opens a PR that auto-merges when green. If the maintainer's account can't reach the Task, see §13. **Bug:** fixes it in the plugin's own code, wherever it sits, and opens a PR. If the bug came from the Starter code, it also offers an issue through `site-cli-creator-feedback`, so new plugins get the fix (§5) |

Only Drift fixes auto-merge. The maintainer merges everything else. Every mode passes `--writes` when it runs `check` (§10). Every mode that opens a PR also bumps the plugin version in that PR (§9).

## 3. The Task loop

Decided in [Who picks a plugin's task commands?](https://github.com/hoaj/skills/issues/11).

1. **State the Tasks.** The user lists, in plain words, what agents should be able to do. For example: "see my subscription and price", "see my latest bill".
2. **Capture each Task.** The user performs the Task in Chrome while the Capture tool records the calls as shapes only: no values, ids redacted. The Capture tool is a Bun TypeScript script in the generator's skill folder, run with `bun` on the maintainer's machine and never compiled. It drives headed Chrome with a tool-owned profile in `~/.site-cli-creator/profile/`, writes shape files straight into the plugin's `captures/<task>/`, and never writes raw traffic to disk ([Gaps found in the final spec read](https://github.com/hoaj/skills/issues/31)). Header values are kept only for an allowlist of names (a spec choice, taken from the capture script). For a **read** Task, the tool aborts every write. For a **write** Task, the user's own write goes through for real, once, so the request and response shapes are both recorded.
3. **Filter Operations.** The agent keeps only the Operations whose fields end up in the Task's output, plus the Operations that supply their variables (the chain). It shows the kept and dropped lists with a one-line reason for each. Writes that fire as a side effect during a read Task, such as YouSee's `createQuote`, are dropped. The Capture is archived complete in `captures/`.
4. **Show a card for the user to confirm.** Nothing is written before the user accepts or edits it:
   ```
   Task 1: "see my subscription and price"
     command: subscription show [--all]
     output:  customer: string
              products: [{name: string, status: string, since: date|null, monthlyDKK: number|null}]
              monthlyTotalDKK: number
     uses:    getCustomer → listFtpdProducts   (dropped: 4, with reasons)
     effect:  read
   ```
   Command names are `<noun> <verb>` in English.
5. **Generate.** The agent writes one Contract per Operation (§6) and the command file. The generator regenerates `registry.ts` and the SKILL.md command table (from `help`), then runs `check`. Only the generator writes the command table, in add-task and fix. The release build never rewrites committed files.

## 4. Generated plugin layout

Decided in [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6) and [One site per plugin, or several?](https://github.com/hoaj/skills/issues/12). A prototype of one CLI skill (the older single-skill layout, reference only, see §5) is on [`prototype/template-command-surface`](https://github.com/hoaj/skills/tree/prototype/template-command-surface/prototypes/yousee-plugin-PROTOTYPE).

```
<plugin>/                                   own repo, usually private
  .claude-plugin/plugin.json                GENERATED  four manifests with the same fields;
  .cursor-plugin/plugin.json                           Codex uses "skills": "./skills/",
  .codex-plugin/plugin.json                            Copilot has no homepage
  .github/plugin/plugin.json
  .github/workflows/release.yml             STARTER    draft release vX.Y.Z → build every skill × target, uploading to the draft → publish
  generated.json                            GENERATED  {"generatedWith", "maintainer"}, info only (§5, §13)
  skills/<plugin>-feedback/SKILL.md         GENERATED  one per plugin, written once by `new`, then owned
                                                       by the plugin (§10)
  skills/<plugin>-deploy/SKILL.md           GENERATED  one per plugin, written once by `new`, then owned
  skills/<plugin>-deploy/hosts/railway.md   GENERATED  the Railway steps; one `hosts/<host>.md` per host
                                                       by the plugin (§8, Deploy shape)
  skills/<skill>/                           one per site and login
    SKILL.md                                GENERATED  see §8
    install.sh                              STARTER    see §9
    .gitignore                              GENERATED  bin/
    Dockerfile                              STARTER    remote mode's image (§8, Deploy shape)
    .dockerignore                           STARTER    bin/, captures/, node_modules, tests
    captures/<task>/*.shape.json            GENERATED  shape-only Captures (file naming is a spec choice)
    cli/
      package.json                          GENERATED  plugin version and dependency pins
      build.ts                              STARTER    carries the playwright-core patch (§9)
      src/main.ts, src/runtime/*            STARTER    routing, envelope, call + classification,
                                                       session, check
      src/site.ts                           GENERATED  origin, URLs, `auth`, repo; for login: login hosts,
                                                       token request, post-login step; for none:
                                                       optional `bootstrap` (§7)
      src/registry.ts                       GENERATED  static imports, so `bun build --compile` sees them
      src/operations/<name>.ts              AGENT      one Contract per Operation
      src/commands/<noun>-<verb>.ts         AGENT      one per Task
      src/lib/*.ts                          AGENT      code shared between commands, never registered
```

There is no CLI framework. Routing and flag parsing are about 30 lines in `main.ts`. Maintainer-only tooling never ships inside `skills/`, because agents load every skill folder they find.

## 5. Starter code

Decided in [No shared code in generated plugins](https://github.com/hoaj/skills/issues/26), which replaced the template files and `upgrade` from [How do generated plugins pick up template fixes?](https://github.com/hoaj/skills/issues/13).

- **The generator holds tested Starter code:** `main.ts`, `runtime/*`, `build.ts` (with the playwright-core patch), `install.sh`, the deploy files (`Dockerfile`, `.dockerignore`), the Deploy skill with its host guides (`hosts/<host>.md`), `release.yml`, the bump script, the version-sync test and the version check workflow (§9).
- **`new` copies it once.** From then on it belongs to the plugin, like every other file, and can be changed freely. Nothing ever overwrites a plugin's files from outside. There is no `upgrade` mode.
- **Labels in §4** say where a file came from, not who owns it: STARTER (copied from the Starter code), GENERATED (written by the generator), AGENT (written by the agent in the Task loop). The plugin owns all of them, including the Feedback skill and every SKILL.md.
- **A bug in code that came from the Starter code** is fixed by `fix` in the plugin. `fix` also offers an issue through `site-cli-creator-feedback`, so the Starter code is fixed for future plugins. Existing plugins are not touched. They get the fix only if they hit the bug themselves.
- **`generated.json`** records the generator version the plugin was created with (`generatedWith`) and its `maintainer` (§13), as information only, and `doctor` prints them. When a Starter code bug is fixed, the maintainer can see which plugins were created before the fix and may be affected. Nothing acts on it automatically.
- Improvements to the generator reach only plugins created after them.
- **How the Starter code is built**, decided in [Prototype versus Starter code](https://github.com/hoaj/skills/issues/30): it is written fresh from this spec during the build, not copied from the prototype. The prototype is a reference only, mainly for its offline scenario switch (`PROTO_SCENARIO=ok|drift|gqlerror|session|network`), which becomes the pattern for the Starter code's test fixtures. The Starter code has its own tests in the generator's CI: unit tests for routing, the envelope, classification, Fingerprints and bug keys, plus the platform smoke test from §9. The prototype branch is deleted once the Starter code lands.

## 6. Contracts

Decided in [Contract format per endpoint](https://github.com/hoaj/skills/issues/4), and changed for writes by [Who picks a plugin's task commands?](https://github.com/hoaj/skills/issues/11).

Each `src/operations/<name>.ts` exports:

| Export | Meaning |
|---|---|
| `name` | the GraphQL `operationName`, or `METHOD /path` for REST |
| `effect` | `read` or `write`, declared and never inferred from the method |
| `graphql` / `rest` | the trimmed query: only the fields the CLI reads, not the frontend's text |
| `variables` | a Zod schema, validated before any call (input kind) |
| `response` | a Zod schema covering only the fields the CLI reads. The script drafts it from the Capture, and the agent cuts it down and decides which fields may be null, because one Capture is too narrow to decide nullability |
| `needs` | for each variable, where it comes from: another Operation's result plus a pick, `session`, or a constant (`{ value }`: a fixed parameter the command passes). `check` uses this chain, and no personal data is stored |
| `trigger(page)` | writes only: drives the UI in Playwright up to the request, so `check` can intercept and abort it |

The Zod schema is both the runtime parser and the TypeScript type, so Drift shows up as a parse failure.

## 7. Login, bootstrap and session

Decided in [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6), [Where does the CLI get the chain-root customerId?](https://github.com/hoaj/skills/issues/9) and [Live check of YouSee token claims and post-login](https://github.com/hoaj/skills/issues/10). Playwright feasibility comes from [Does Playwright work inside bun compile binaries?](https://github.com/hoaj/skills/issues/2). Sites without login were added in [Sites without login](https://github.com/hoaj/skills/issues/27).

- **Every CLI skill declares `auth` in `site.ts`:** `"login"` or `"none"`. The generator asks at `add-skill` and confirms it from the Capture. A plugin can mix both kinds. The rest of this section describes `auth: "login"`. `auth: "none"` is at the end.
- **Chrome only runs for `login`, the session refresh and `check`'s write checks.** Every command, including write commands, uses plain `fetch`.
- **State** lives in `~/.<plugin>/` when the CLI skill is named after its plugin (as `new` names a plugin's first skill), else in `~/.<plugin>-<skill>/`, with mode 0700. The path and mode are spec choices: naming the plugin avoids collisions between two plugins whose CLI skills share a name, without doubling the name for a plugin's own skill ([State dir doubles the name](https://github.com/hoaj/skills/issues/44)). Builds before generator 0.2.1 used `~/.<plugin>-<plugin>/`; on its first run the CLI moves that dir to `~/.<plugin>/` (a rename, so the modes and the sign-in carry over) when `~/.<plugin>/` doesn't exist yet. It never merges or deletes: if both exist, it uses `~/.<plugin>/`, leaves the old one alone, and `doctor` names it. It holds:
  - `profile/`: a Chrome user-data dir owned by the tool. Chrome 136+ refuses automation on the default profile.
  - `session.json` (0600): the bearer, the cookie, and the chain-root ids.

  There is no `last-error.json`. The Feedback skill works from the error JSON the CLI just printed (§10).
- **`login`** launches headed Chrome via `launchPersistentContext(profile, {channel: "chrome"})`. It waits up to 10 minutes for the request named by `site.tokenRequest`, sniffs its `authorization` header and the cookies, then runs the site's **post-login step**.
- **`login --from-profile <dir>`** lets the maintainer sign in once: right after the first Capture, it reads the Capture profile's cookies for the site's hosts (the origin's domain and its subdomains, as the Capture records them) and its login hosts, in memory only, and runs the same sign-in headless with them in a Chrome context that keeps nothing on disk (not the CLI's `profile/`). Nothing is written but `session.json`, which also names that profile dir (a path, no cookie), and no cookie value is logged. Until a plain `login` replaces that sign-in, the session refresh and `check --writes` seed their Chrome from that profile the same way, in memory, so the maintainer signs in once ([login --from-profile leaves the CLI's profile signed out](https://github.com/hoaj/skills/issues/46)).
- **Post-login step** (`site.ts`): site-specific, written by the agent from the Capture. It derives the chain-root ids and keeps nothing else. For YouSee:
  1. Decode `ciam_id` and `individual_id` from the access token.
  2. `POST /shop/api/session-management/post-login` with `{ciamId, individualId}`, sending both the bearer and the cookie.
  3. Store only `personalInfo.customerId` and `individualId`. The response also holds CPR, address, email and phone, which are never stored or logged. Repeating this call is normal frontend behavior.
- **Commands** use plain `fetch` with the cached session. On a 401, 403 or a redirect to login, the CLI:
  1. refreshes headless from the profile (first from the `login --from-profile` profile, when that is where the sign-in came from) and retries;
  2. if still logged out, opens headed login and reruns the command;
  3. if login doesn't complete, fails with `session`.

  A 401 or 403 right after a fresh login counts as Drift.
- **`auth: "none"`:** there is no `login` command, no `profile/`, no post-login step, and exit 4 (session) never happens. Commands use plain `fetch`.
  - **Optional `bootstrap`** (`site.ts`), written by the agent from the Capture, fetches what a public API still needs, such as a front-page cookie or a CSRF token, with plain `fetch`. It is cached in `session.json` like a session and reruns silently when it expires.
  - **On a 401 or 403,** the CLI reruns `bootstrap` and retries once. If it still fails, it's Drift: the site now wants a login, a new token, or blocks the CLI. A 429 is `network`.
  - Sites behind real bot walls (Cloudflare challenges, captchas) are out of scope for v1.
  - `check --writes` on an `auth: "none"` skill runs `trigger(page)` in a fresh temporary profile, deleted afterwards ([Gaps found in the final spec read](https://github.com/hoaj/skills/issues/31)).
- **Several accounts under one login** (for YouSee, several Customers from `getAssociationsByParty`): without `--account <id>`, a command fails with `input` and lists the accounts. The agent asks the user and passes `--account` on later calls. Single-account users never see this. Decided in [One site per plugin, or several?](https://github.com/hoaj/skills/issues/12).

## 8. CLI surface

Decided in [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6).

**Commands:**
- **Task commands:** `<noun> <verb> [flags]`, one per Task. There is no raw `op <name>` escape hatch, because it would invite working around Drift.
- **Built-in, the same in every CLI skill:**
  - `help`: commands, flags and exit codes, as JSON. `<command> --help` (or `-h`) prints that one command's entry and runs nothing ([Generated CLI rejects <command> --help](https://github.com/hoaj/skills/issues/47));
  - `login [--from-profile <dir>]` (only for `auth: "login"`, §7);
  - `check [--op <name>] [--writes]` (§10);
  - `doctor`: versions, `generatedWith`, Chrome path, plus the state dir and `gh` status (both spec choices). It prints the `check` command but doesn't run it;
  - `version`;
  - `mcp [--http [--port <n>]]`: serves the same CLI skill as an MCP server, in local mode on stdio or, with `--http`, in remote mode (see **MCP server** below). Agents running the CLI never call it.

**Output:** stdout is always exactly one JSON document, and stderr carries progress. A failure prints:

```json
{"error": {"kind": "drift", "message": "…", "fingerprint": "…", "diff": [], "version": "…", "os": "…", "next": "<what the agent must do>"}}
```

The envelope is everything the Feedback skill needs, and the CLI is responsible for keeping values out of it. A `bug` envelope also carries a redacted stack trace. A `check` envelope carries one entry per drifted Operation, each with its own Fingerprint and diff.

**Exit codes:**

| Exit | kind | `next` tells the agent |
|---|---|---|
| 0 | ok | |
| 1 | bug | tell the user and offer to file it through the Feedback skill, passing this envelope. File only on a yes |
| 2 | input | fix the flags (see `help`). If the error lists accounts, ask the user which one and pass `--account <id>` from then on |
| 3 | drift | stop, offer to file it through the Feedback skill with this envelope (filed only on a yes), and don't work around it with raw calls |
| 4 | session | run `login` (the user signs in to Chrome), then rerun. Never happens for `auth: "none"` |
| 5 | network | tell the user the site isn't responding, and stop |

**Writes:** decided in [Who picks a plugin's task commands?](https://github.com/hoaj/skills/issues/11). A write command without `--confirm` validates its input, resolves the chain, prints `{"dryRun": true, "would": {...}}` and exits 0. SKILL.md tells the agent to show the user the dry run and get an explicit yes before rerunning with `--confirm`.

**Tasks across logins:** never one command. The agent chains commands from each CLI skill.

**MCP server:** `<skill> mcp` turns the same binary into an MCP server (stdio, JSON-RPC, tools only), so MCP clients without skills (Claude Desktop, Cursor and others) get the same Tasks. There is one code path: a tool call runs the Task command's own code, Contracts, session and classification, and returns exactly what the command prints (its result, a dry run, or the error envelope) as JSON text, plus structured content when it is an object; a failure has `isError`. Nothing is maintained twice. The wrap differs from the CLI only in these ways:
- **Tools:** one per Task, named `<noun>_<verb>`, described by the command's summary. Its input schema is the command's `args` schema, plus `account` and, on writes, `confirm`. Unknown arguments are input. Annotations follow the Effect: a read Task is `readOnlyHint`, a write Task is `destructiveHint` (the Effect cannot say less). Built-in tools: `login` (`auth: "login"` only), `check` and `doctor`. There are no `help`, `version` or `selftest` tools: `tools/list` and the server info replace them.
- **Writes:** a write tool without `confirm: true` returns the dry run, and the server's instructions tell the client to show it and get the user's yes first, as SKILL.md does.
- **Sign-in:** a Task tool never opens a headed sign-in and waits. With no saved sign-in it returns `session` at once, without launching Chrome; after a failed silent refresh it returns `session` too. The message names no setting the user must change, and `next` says to call the `login` tool, which opens Chrome. The `login` tool answers within about 20 s whether or not the user has finished (`signingIn: true` while the window is open), so one sign-in never holds the server past a client's request timeout; meanwhile Task tools return `session` asking the user to finish in the Chrome window. A failure of the login tool itself (no Chrome) says to tell the user, never to call login again.
- **`next` and messages:** speak of tools and arguments instead of commands and flags (the `account` argument, never `--account`). An MCP client may have no Feedback skill, so for Drift and bugs `next` offers the Feedback skill when it is there, else the plugin repo's new-issue page, and either only on the user's yes.
- **Remote mode** (`mcp --http`, decided on the map [Wayfinder: remote mode for site-cli-creator plugins](https://github.com/hoaj/skills/issues/53)): the same binary and the same tools, served over the MCP SDK's Streamable HTTP transport on one canonical URL, `<public URL>/mcp`, behind the Owner's **Server sign-in**. The SDK v1 and Express 5 are pinned exactly and loaded only for `--http`.
  - **One Owner per instance.** The password comes from the host, `OWNER_PASSWORD_HASH` (scrypt, made by `<skill> mcp --hash-password` from the password on stdin) or `OWNER_PASSWORD` (at least 12 characters); with neither, a short one, a hash it cannot check, or no public URL (`PUBLIC_URL`, else Railway's domain), `mcp --http` is an input failure and nothing listens. A port in use or an unreadable `oauth.json` is an input envelope too, never a stack trace. `TRUST_PROXY` sets how many proxies in front may name the client's address (default 1 behind https, 0 on loopback).
  - **Server sign-in is OAuth 2.1** on the SDK's router, ported from BankMCP: PKCE S256; access tokens 1 h, refresh 90 d rotating, codes 10 min and single use, all stored only as hashes; a sign-in page that asks for the Owner password and names the site, the client and where it returns to. Redirects go only to claude.ai's callback and loopback, unless `EXTRA_REDIRECT_URIS` adds more.
  - **Fixed against BankMCP:** an unknown or expired token is 401; tokens are bound to this server's `/mcp`; a reused refresh token signs its client out; a revoke drops both tokens of a pair; open registration never evicts a client with live tokens, and open sign-in pages do not protect a client; a client that has signed in stays registered after a sign-out, so it reconnects; the redirect allowlist is checked again at every sign-in; a refresh cannot widen its scopes; a disallowed `Origin` on `/mcp` is 403; the password fingerprint behind the kill switch is a salted HMAC. Five wrong passwords lock an address out for 15 minutes; past a global cap, addresses that failed are locked sooner, but an address that never failed (the Owner's) is not. Changing the password signs every client out.
  - Tool calls run one at a time, as over stdio. The Session is the one in the CLI skill's state dir.
  - **Setup page** (`/setup`, decided in [How does the Owner give the server a Session, and how is it kept safe?](https://github.com/hoaj/skills/issues/58)): where the Owner gives the server a Session. It shows the site and whether the Session is valid, expired or missing (unchecked when one is stored that was not uploaded here), with when it was uploaded and last checked, never its contents; and, on a host with no volume, a warning that the Session and every client's sign-in vanish on the next deploy. Actions: upload a Session, delete it, and sign out every client (revoke all tokens). Each form asks for the Owner password itself, with the Server sign-in's check and lockout; there are no cookies. A skill with `auth: "none"` has no Session to upload, so its page has only the sign-out action.
  - **Session upload:** the whole `session.json` that `<skill> login` writes, chosen as a file or pasted. A request over 256 KB (declared or read) or a file over 64 KB is refused; the shape is checked (unknown keys, such as `fromProfile`, are dropped); then the server makes the site's reads once with it, as `check` does and through the same one-at-a-time queue as tool calls. A skill whose reads all need input has nothing to try: its Session is stored and shown as unchecked. Only a Session that works is stored (file, mode 0600, in the state dir), so a bad upload never replaces a working one, and the Owner is told why: the site did not accept it, did not respond, or has changed. The Session is never sent back out, and no Session value reaches a response or the log.
  - **Remote tools:** the `login` and `doctor` tools are not listed (Chrome and the host's paths mean nothing to a remote client), `check` has no `writes` and refuses a write Operation, and the instructions say the Owner must give a new Session on the Setup page. A `session` failure's `next` tells the client to ask the Owner to upload a new Session at `<public URL>/setup`, and marks the Session expired on that page until a later call succeeds, which marks it valid again. `GET /` redirects to `/setup`.
- **Deploy shape**, decided in [How is a remote-mode server deployed and configured on Railway?](https://github.com/hoaj/skills/issues/59), [How do generated plugins get remote mode, and how does logbuy get it?](https://github.com/hoaj/skills/issues/60) and [Deploy files, the Deploy skill, docs and e2e for remote mode](https://github.com/hoaj/skills/issues/65):
  - **The contract is host-neutral:** a container built from `skills/<skill>/Dockerfile` (that folder is the build context; a Bun stage compiles the binary, a distroless image runs it), the variables `OWNER_PASSWORD` or `OWNER_PASSWORD_HASH`, `PUBLIC_URL`, optional `PORT`, `TRUST_PROXY` and `EXTRA_REDIRECT_URIS`, a persistent volume on `/data`, one replica, and `GET /healthz`. The CLI skill's folder holds only these host-neutral files (`Dockerfile`, `.dockerignore`); it has to, because the build context needs `cli/` and `railway up` uploads only that folder. Host specifics live in the Deploy skill. The one-replica rule and the health check are set on the host, not in the image.
  - **The Deploy skill** (`skills/<plugin>-deploy/`, one per plugin, covering every CLI skill) states the contract and points at the host guides (`hosts/railway.md` holds every Railway step; a later host adds `hosts/<host>.md`, and its config file, if it needs one, goes next to it), offers to generate the Owner password (shown once, a hash recommended), then guides the Session upload and the claude.ai connector. It is private use: the Owner deploys from their own checkout.
  - **Railway reads no config file** ([#74](https://github.com/hoaj/skills/issues/74), [#75](https://github.com/hoaj/skills/issues/75)): `railway.json` is ignored for every service created today (Config as Code is closed to new services), and its replacement, the IaC file `.railway/railway.ts`, needs the npm package `railway` and owns the whole project (omitted resources are deleted), so it is rejected. Railway's defaults give a root `Dockerfile` build, one replica and restart on failure; the health check is a step in `hosts/railway.md` (Railway's MCP server `update-service`, or the dashboard).
  - **Always included:** `new` writes the Deploy skill and `add-skill` copies the deploy files, since the remote-mode code is in every binary.
- **Not yet:** no output schemas (a command declares no output schema).

**SKILL.md** (about 45–60 lines):
1. Frontmatter with only `name` and `description`. The version goes in an HTML comment below it, because a `version:` key breaks Copilot.
2. A short intro (session, network and input failures never go to the Feedback skill):
   - `bin/<skill>` is in this skill's folder, and output is JSON;
   - write commands: show the user the dry run and get an explicit yes before rerunning with `--confirm`;
   - Tasks spanning logins: chain commands from each CLI skill.
3. `## Commands`: a table generated from `help` by the generator (§3, step 5), with writes marked.
4. `## When it fails`: exit code → kind → action, plus three extra rows:
   - a missing binary: run `install.sh`;
   - several accounts: ask the user, then pass `--account`;
   - the plugin can't do what the user asked: offer a feature request through the Feedback skill;
   - the user asks whether the plugin works, or a failure looks odd: run `check`.

   It also says, in prose, to stop on Drift and never work around it with raw calls.
5. `## When NOT to use`.

## 9. Build, release and install

Decided in [Does Playwright work inside bun compile binaries?](https://github.com/hoaj/skills/issues/2), [Do the compiled binaries run on Linux and Windows?](https://github.com/hoaj/skills/issues/15), [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6) and [What do users without gh or repo access get?](https://github.com/hoaj/skills/issues/14).

- **Build:** Bun >= 1.4.0, TypeScript, `Bun.build` with `compile`. `build.ts` carries an `onLoad` plugin that rewrites playwright-core's two `require(join(packageRoot, "package.json" | "browsers.json"))` calls in `lib/coreBundle.js` to static `../package.json` and `../browsers.json`. It asserts exactly two hits and sets `external: ["chromium-bidi", "electron"]`. Without the patch, the binary only runs on the build machine.
- **Targets (v1):** `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` and `windows-x64`, cross-compiled on one Ubuntu runner. Decided in [Release targets for v1 and how they're verified](https://github.com/hoaj/skills/issues/29):
  - **Verified to run:** darwin-arm64 (local runs), linux-x64 and windows-x64 (CI), linux-arm64 once Chrome is installed (CI).
  - **darwin-x64** is verified once, in the generator's own CI, by the Starter code's smoke test (`help`, `fetch`, Chrome launch, `route.abort`) on an Intel macOS runner, with the binary re-signed as `install.sh` does. Each runner builds the binary and runs it in one job, with the build's files deleted first, so a binary that leans on the build machine's paths still fails. The full five-target matrix runs on main and on `workflow_dispatch`; a pull request runs linux-x64 only, so a darwin or Windows break shows up after the merge (macOS minutes bill at 10x on a private repo). darwin-arm64 gets the same test on an Apple silicon runner. Plugin releases don't repeat it.
  - **Not in v1:** windows-arm64 and musl Linux. On a platform without a binary, `install.sh` stops with "unsupported platform: `<os>-<arch>`".
- **Release:** one tag `vX.Y.Z` per plugin, so all CLI skills ship together. Assets are named `<skill>-<target>[.exe]`.
- **Versioning**, decided in [Who bumps a plugin's version, and how is the fixed version recorded?](https://github.com/hoaj/skills/issues/21):
  - **One bump command** (part of the Starter code). `bun run bump <patch|minor|major>` rewrites every copy of the plugin version: the four manifests, the version comment in each SKILL.md (every CLI skill, the Deploy skill and the Feedback skill) and each `cli/package.json`. Nobody edits version numbers by hand. A version-sync test fails CI if any copy differs.
  - **Each generator PR bumps.** `fix`, `add-task` and `add-skill` run the bump in their own PR. `new` starts at `0.1.0`. `fix` is a patch. `add-task` and `add-skill` are minor. Major bumps, such as a renamed or removed command, are done by hand.
  - **Merging releases.** When a PR that changed the version merges to main, `release.yml` creates a draft release `vX.Y.Z`, builds every skill and target and uploads each binary to the draft (no workflow artifacts), then publishes the draft, which creates the tag. An auto-merged Drift fix ships with no human step.
  - **Collisions.** A CI check requires a PR's version to be higher than main's. A stale PR goes red, and the generator rebases and bumps again. Auto-merge waits for green, so two releases never share a number.
  - **Recording the fix.** Generator PRs say `Fixes #n`. Once the release is published (a failed run leaves its draft, which the next run of that version reuses), `release.yml` adds a `fixed-in:vX.Y.Z` label and a short comment to every issue the released PRs closed. The label is written only after the binaries exist.
- **Chrome** is required for a CLI skill with `auth: "login"` or with any write Operation (for `check --writes`). A read-only `auth: "none"` skill installs and runs without it. The maintainer always needs Chrome for Captures. It is found at a fixed path per OS, and `executablePath` overrides it. No browser is shipped. `install.sh` and `doctor` check for Chrome when the skill needs it and print how to install it. Decided in [Sites without login](https://github.com/hoaj/skills/issues/27).
- **`install.sh`** runs once, when the agent finds `bin/<skill>` missing. It stops with a clear message at the first step that fails:
  1. `gh` present, else "install GitHub CLI and run `gh auth login`";
  2. `gh` logged in, else "run `gh auth login`";
  3. Chrome present, if the skill needs it, else how to install it;
  4. `gh release download v<version> --pattern <skill>-<target>` into `skills/<skill>/bin/`. A plugin update lands in a new cache dir, so the binary always matches its SKILL.md.
  5. **macOS:** `xattr -d com.apple.quarantine` on the binary, ignoring errors, then `codesign --force --sign -` if `codesign -v` fails. **Windows:** `powershell -NoProfile -Command Unblock-File` on the `.exe`, ignoring errors.

  Step 5 comes from [Do unsigned binaries trigger Gatekeeper or SmartScreen when installed with gh?](https://github.com/hoaj/skills/issues/22). On macOS 27, `gh release download` sets no quarantine attribute, so Gatekeeper never checks the binary, and an ad-hoc signature is enough. A quarantined copy is blocked and removed, so the `xattr` step is defensive. Bun's cross-compile to darwin-x64 carries an invalid signature, which the re-sign fixes. Windows was not tested: SmartScreen only checks files with Mark-of-the-Web, which `gh` doesn't add. `doctor` reports a quarantine attribute, an invalid signature or a Zone.Identifier if one is present. No Developer ID signing or notarization is needed.

  `install.sh` is bash. On Windows it runs in Git Bash, which Claude Code already requires there. SKILL.md's "missing binary" row says to run `bash install.sh` ([Gaps found in the final spec read](https://github.com/hoaj/skills/issues/31)).

  Users install from main, so a new version reaches them as soon as its PR merges, minutes before its binaries exist. On a 404, `install.sh` checks whether it can see the repo. If it can, the release is still being built: "try again in a few minutes". If it can't: "ask `<owner>` for access to `<repo>`". `doctor` gives the same answer. A failed build shows up as a red workflow on main.

## 10. Drift, check and the Feedback skill

Decided in [Drift classification vs other failures](https://github.com/hoaj/skills/issues/5), [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6) and [What do users without gh or repo access get?](https://github.com/hoaj/skills/issues/14). `check` was settled in [When does check run?](https://github.com/hoaj/skills/issues/20). The Feedback skill was decided in [Feedback skills next to each plugin](https://github.com/hoaj/skills/issues/24), which replaced the `report` subcommand.

**Classification:** the CLI classifies every failure deterministically, and the agent never guesses.
- **drift:** any of
  - a Zod parse failure;
  - a GraphQL validation error;
  - a 404 or 405 on a known REST path;
  - a write request whose shape changed, or a `trigger(page)` that can't find its element;
  - a 401 or 403 right after a fresh login, or, for `auth: "none"`, after a rerun of `bootstrap`;
  - the server rejecting input that passed the variables schema.
- **session:** a 401, a 403 or a redirect to login (handled as in §7). Only for `auth: "login"`.
- **network:** 5xx responses, 429 and transport errors, retried 1–2 times.
- **input:** fails the variables or flag schema, so no call is made.
- **bug:** anything else thrown.

**Fingerprint:** `plugin:skill:operation:breakType:path:code`, with array indices written as `[]`. `code` is the Zod issue code, the HTTP status or the GraphQL error code, and it may be empty. For example, `yousee:yousee:listFtpdProducts:zod:data.listFtpdProducts[].status:invalid_type`.

**`check`:**
- Calls every **read** Operation live, in chain order, and validates it against its Contract. Plain `check` never launches Chrome.
- A read Operation it can never call, because a required variable has no `needs` entry or its constant does not fit the variable's schema, is skipped and listed in the output's `warnings`. That is a Contract gap, not Drift, so it doesn't change the exit code; the output's `ok` is false whenever `warnings` is present. `regen` warns about it too, and the generator fixes it before `check` passes.
- With `--writes` (or `--op <write>`), it also runs `trigger(page)` headless from the profile for each **write** Operation, intercepts the write request, compares its shape and aborts it. `check` never writes.
- If anything drifted, it exits 3 with one entry per drifted Operation, and each can be filed through the Feedback skill.
- **Nothing runs `check` automatically.** Users run it on demand, to answer "is the site broken or is it me?". The generator runs it, with `--writes`, in `add-task` and `fix`. A Task command validates only the Operations it calls. After Drift, nobody sweeps the other Operations: `fix` runs the full `check` anyway. The maintainer schedules no proactive runs in v1, so users surface Drift. CI doesn't run `check`: login skills need a real account, and for `auth: "none"` skills the same no-automatic-runs rule keeps v1 simple.

**The Feedback skill** (`skills/<plugin>-feedback/`, one per plugin, covering every CLI skill in it):
- **When:** exit 3 (Drift), exit 1 (bug), a Task the plugin can't do (a feature request for `add-task`), or the user saying "report this". Never for session, network or input failures.
- **Input:** the error envelope the CLI just printed (§8). The skill never reads the state dir and never sees response values.
- **Always asks first, Drift included.** It drafts the issue, shows it to the user and files it only on a yes, using the user's own `gh`.
- **Dedup**, as SKILL.md steps:
  1. Search the plugin repo for the Fingerprint (Drift) or the bug key (below).
  2. An open match gets a +1 comment with the version and OS.
  3. A closed match with a `fixed-in:vX.Y.Z` label newer than the user's version gets "update the plugin", and nothing is filed (§9).
  4. A closed match with no `fixed-in` label yet: tell the user a fix is merged and on its way, and add a +1 so a stuck release becomes visible. Nothing new is filed.
  5. Otherwise, create an issue that links any closed match.
- **Bug key**, decided in [Dedup key for bug reports](https://github.com/hoaj/skills/issues/28): `plugin:skill:bug:<command>:<ErrorName>:<frame>`. `<frame>` is the first stack frame inside the plugin's own `src/`, written as its path relative to `src/` plus the function name, with no line or column, so a rebuild doesn't change the key. For example, `yousee:yousee:bug:subscription-show:TypeError:commands/subscription-show.ts#render`. The CLI computes it and puts it in the envelope's `fingerprint` field, so the Feedback skill deduplicates bugs exactly like Drift.
- **Feature requests** have no key. The skill lists open issues with the label `feature`, and if one looks like the same Task, it asks the user whether to +1 it instead of filing a new one.
- **Titles:** the Fingerprint for Drift with the label `drift`, `bug: <bug key>` for a bug with the label `bug`, and `feature: <skill>: <Task in plain words>` with the label `feature` for a feature request. Labels only filter the queue (`fix` lists it with `--label drift` and `--label bug`); dedup goes by the exact title. The body holds the diff or stack trace and never values.
- **Without `gh`, or without permission to file:** the skill gives the user a pre-filled `/issues/new` link, titled as above. Duplicates are caught by `fix` through that Fingerprint.
- **What the user sees:** a short message with the issue link. On Drift the agent stops the task.

## 11. Out of scope

- Building the generator. This spec is where the map ends.
- Real writes during `check`.
- Running `check` automatically, on users' machines or on a maintainer schedule (v1).
- Rub-style inspection of the site's JS bundle.
- Public plugins installed without `gh`, because they would publish a site's internal API shapes. This holds for sites without login too ([Sites without login](https://github.com/hoaj/skills/issues/27)).
- Sites behind real bot walls, such as Cloudflare challenges or captchas.
- Jira as a test case: it was replaced by Mit YouSee.

## 12. Open points (all resolved)

All points are now decided. The list is kept as a record. Points 1–5 were tickets on the map: [When does check run?](https://github.com/hoaj/skills/issues/20) (resolved), [Who bumps a plugin's version, and how is the fixed version recorded?](https://github.com/hoaj/skills/issues/21) (resolved), [Do unsigned binaries trigger Gatekeeper or SmartScreen when installed with gh?](https://github.com/hoaj/skills/issues/22) (resolved) and [Who runs fix mode, and with which site account?](https://github.com/hoaj/skills/issues/23) (resolved).

1. ~~**When `check` runs.**~~ Resolved in [When does check run?](https://github.com/hoaj/skills/issues/20): on demand only (§10).
2. ~~**Who bumps the plugin version and tags a release.**~~ Resolved in [Who bumps a plugin's version, and how is the fixed version recorded?](https://github.com/hoaj/skills/issues/21) (§9).
3. ~~**Recording the fixed version.**~~ Resolved in [Who bumps a plugin's version, and how is the fixed version recorded?](https://github.com/hoaj/skills/issues/21): a `fixed-in` label added at release (§9, §10).
4. ~~**Unsigned binaries.**~~ Resolved in [Do unsigned binaries trigger Gatekeeper or SmartScreen when installed with gh?](https://github.com/hoaj/skills/issues/22) and [Release targets for v1 and how they're verified](https://github.com/hoaj/skills/issues/29) (§9).
5. ~~**Who runs fix mode for Drift.**~~ Resolved in [Who runs fix mode, and with which site account?](https://github.com/hoaj/skills/issues/23) (§13).
6. ~~**A dedup key for bugs.**~~ Resolved in [Dedup key for bug reports](https://github.com/hoaj/skills/issues/28) (§10).
7. ~~**Bug reports need the user's yes.**~~ Resolved in [Feedback skills next to each plugin](https://github.com/hoaj/skills/issues/24): every report needs the user's yes, Drift included.
8. ~~**The prototype predates five decisions.**~~ Resolved in [Prototype versus Starter code](https://github.com/hoaj/skills/issues/30): reference only (§5).

## 13. Maintainer

Decided in [Who runs fix mode, and with which site account?](https://github.com/hoaj/skills/issues/23).

- **The maintainer is whoever ran `new`.** They own the plugin's repo, and each plugin can have its own maintainer. The generator's owner is not automatically responsible for other people's plugins. The maintainer is named in `generated.json` (`maintainer`) and the README.
- **Requirements**, checked by `new`:
  1. their own account on the site that can perform the plugin's Tasks, for `auth: "login"` skills (`new` asks);
  2. admin rights on the plugin repo, for auto-merge, labels and releases (`new` checks);
  3. Bun ≥ 1.4, Google Chrome and a logged-in `gh` (`new` checks).
- **`fix` uses the maintainer's own account whenever it can.** If that account can't reach the failing Task, for example a different subscription type:
  - `fix` corrects the Contract from the issue's diff (field path and type);
  - the PR gets the label `unverified` and is not auto-merged;
  - after the release, `fix` comments on the issue asking the reporter to run `check --op <name>` and confirm.
- **`add-task` can't capture a Task the maintainer's account can't perform.** Without a Capture there is no Contract, so the issue is closed with an explanation and the label `needs-account`. It can be reopened when a maintainer with access turns up.
- **Handover** is an ordinary PR: a new person with repo admin rights and their own account updates `maintainer` in `generated.json` and the README. `needs-account` issues can then be reopened.
