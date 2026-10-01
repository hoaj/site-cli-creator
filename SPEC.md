# site-cli-creator: build spec

site-cli-creator is a skill that turns the calls a website's frontend makes into a **plugin** for coding agents. Each plugin holds one or more **CLI skills**. A CLI skill wraps one login on one site and runs **Tasks** as commands. It detects when the site changes (**Drift**) and reports it to the plugin's repo, where the generator fixes it.

Terms in **bold** are defined in [`CONTEXT.md`](./CONTEXT.md). Every section links the ticket that decided it, on the map [site-cli-creator](https://github.com/hoaj/skills/issues/1). The test case is Mit YouSee (yousee.dk): reading the logged-in user's subscription.

---

## 1. Parts

| Part | Who runs it | What it is |
|---|---|---|
| **site-cli-creator** | the maintainer | a skill: SKILL.md, the fixed template, and the Capture tool |
| **Generated plugin** | many users | its own repo, holding one or more CLI skills, four manifests and a release workflow |
| **CLI skill** | users' agents | `skills/<skill>/`: a SKILL.md and a compiled CLI for one login |

The generator writes into a repo that the person running it chooses. After generation, a plugin depends on nothing from the generator at run time.

## 2. Generator modes

Decided in [Who picks a plugin's task commands?](https://github.com/hoaj/skills/issues/11), [One site per plugin, or several?](https://github.com/hoaj/skills/issues/12) and [How do generated plugins pick up template fixes?](https://github.com/hoaj/skills/issues/13).

| Mode | Trigger | Does |
|---|---|---|
| `new` | a new site | creates the plugin repo layout, then runs **add-skill** for the first login |
| `add-skill` | a new login in an existing plugin | creates `skills/<skill>/`, sets up login for the site, then runs **add-task** for each Task |
| `add-task` | a `report --feature` issue, or the maintainer | runs the Task loop (§3) once, reusing existing Operations |
| `fix` | a Drift or bug issue | **Drift:** re-captures only the affected Task, updates the Contract, runs `check`, opens a PR that auto-merges when green. **Bug in the site's own code** (`operations/`, `commands/`, `site.ts`): fixes it in the plugin and opens a PR. **Bug in template code:** fixes the generator's template, then runs `upgrade` on the plugin |
| `upgrade` | a template change | replaces only the template files (§5), rebuilds, runs `check`, opens a PR |

Only Drift fixes auto-merge. The maintainer merges everything else.

## 3. The Task loop

Decided in [Who picks a plugin's task commands?](https://github.com/hoaj/skills/issues/11).

1. **State the Tasks.** The user lists, in plain words, what agents should be able to do. For example: "see my subscription and price", "see my latest bill".
2. **Capture each Task.** The user performs the Task in Chrome while the Capture tool records the calls as shapes only: no values, ids redacted, headers allowlisted. For a **read** Task, the tool aborts every write. For a **write** Task, the user's own write goes through for real, once, so the request and response shapes are both recorded.
3. **Filter Operations.** The agent keeps only the Operations whose fields end up in the Task's output, plus the Operations that supply their variables (the chain). It shows the kept and dropped lists with a one-line reason for each. Writes that fire as a side effect during a read Task, such as YouSee's `createQuote`, are dropped. The Capture is archived complete in `captures/`.
4. **Show a card for the user to confirm.** Nothing is written before the user accepts or edits it:
   ```
   Task 1: "see my subscription and price"
     command: subscription show [--all]
     output:  customer, products[{name,status,since,monthlyDKK}], monthlyTotalDKK
     uses:    getCustomer → listFtpdProducts   (dropped: 4, with reasons)
     effect:  read
   ```
   Command names are `<noun> <verb>` in English.
5. **Generate.** The agent writes one Contract per Operation (§6) and the command file. It regenerates `registry.ts` and the SKILL.md command table, then runs `check`.

## 4. Generated plugin layout

Decided in [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6) and [One site per plugin, or several?](https://github.com/hoaj/skills/issues/12). There is a runnable prototype of one CLI skill (the older single-skill layout) on [`prototype/template-command-surface`](https://github.com/hoaj/skills/tree/prototype/template-command-surface/prototypes/yousee-plugin-PROTOTYPE).

```
<plugin>/                                   own repo, usually private
  .claude-plugin/plugin.json                GENERATED  four manifests with the same fields;
  .cursor-plugin/plugin.json                           Codex uses "skills": "./skills/",
  .codex-plugin/plugin.json                            Copilot has no homepage
  .github/plugin/plugin.json
  .github/workflows/release.yml             TEMPLATE   tag vX.Y.Z → build every skill × target → release
  template.json                             GENERATED  {"template": "<generator version>"}
  skills/<skill>/                           one per login
    SKILL.md                                GENERATED  see §8
    install.sh                              TEMPLATE   see §9
    .gitignore                              TEMPLATE   bin/
    captures/<task>/*.shape.json            GENERATED  shape-only Captures
    cli/
      package.json, build.ts                TEMPLATE   build.ts carries the playwright-core patch (§9)
      src/main.ts, src/runtime/*            TEMPLATE   routing, envelope, call + classification,
                                                       session, check, report
      src/site.ts                           GENERATED  origin, endpoints, login hosts, token request, repo;
                                                       site-specific post-login step (§7)
      src/registry.ts                       GENERATED  static imports, so `bun build --compile` sees them
      src/operations/<name>.ts              AGENT      one Contract per Operation
      src/commands/<noun>-<verb>.ts         AGENT      one per Task
```

There is no CLI framework. Routing and flag parsing are about 30 lines in `main.ts`. Maintainer-only tooling never ships inside `skills/`, because agents load every skill folder they find.

## 5. Template files and upgrade

Decided in [How do generated plugins pick up template fixes?](https://github.com/hoaj/skills/issues/13).

- **Template files**, owned by the generator and overwritten by `upgrade`: `release.yml`, `install.sh`, `.gitignore`, `package.json`, `build.ts`, `main.ts` and `runtime/*`.
- **Site files**, never touched by `upgrade`: `site.ts`, `operations/`, `commands/`, `captures/` and SKILL.md's frontmatter and command table. `registry.ts` is regenerated.
- `template.json` records the template version, and `doctor` prints it, so a stale plugin shows up.
- A template bug is fixed in the generator first, and plugins receive it through `upgrade`. Copies never diverge from the template.

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
| `needs` | for each variable, where it comes from: another Operation's result plus a pick, or `session`. `check` uses this chain, and no personal data is stored |
| `trigger(page)` | writes only: drives the UI in Playwright up to the request, so `check` can intercept and abort it |

The Zod schema is both the runtime parser and the TypeScript type, so Drift shows up as a parse failure.

## 7. Login and session

Decided in [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6), [Where does the CLI get the chain-root customerId?](https://github.com/hoaj/skills/issues/9) and [Live check of YouSee token claims and post-login](https://github.com/hoaj/skills/issues/10). Playwright feasibility comes from [Does Playwright work inside bun compile binaries?](https://github.com/hoaj/skills/issues/2).

- **State** lives in `~/.<skill>/` with mode 0700:
  - `profile/`: a Chrome user-data dir owned by the tool. Chrome 136+ refuses automation on the default profile.
  - `session.json` (0600): the bearer, the cookie, and the chain-root ids.
  - `last-error.json`: what `report --last` files.
- **`login`** launches headed Chrome via `launchPersistentContext(profile, {channel: "chrome"})`. It waits up to 10 minutes for the request named by `site.tokenRequest`, sniffs its `authorization` header and the cookies, then runs the site's **post-login step**.
- **Post-login step** (`site.ts`): site-specific, written by the agent from the Capture. It derives the chain-root ids and keeps nothing else. For YouSee:
  1. Decode `ciam_id` and `individual_id` from the access token.
  2. `POST /shop/api/session-management/post-login` with `{ciamId, individualId}`, sending both the bearer and the cookie.
  3. Store only `personalInfo.customerId` and `individualId`. The response also holds CPR, address, email and phone, which are never stored or logged. Repeating this call is normal frontend behavior.
- **Commands** use plain `fetch` with the cached session. On a 401, 403 or a redirect to login, the CLI:
  1. refreshes headless from the profile and retries;
  2. if still logged out, opens headed login and reruns the command;
  3. if login doesn't complete, fails with `session`.

  A 401 or 403 right after a fresh login counts as Drift.
- **Several accounts under one login** (for YouSee, several Customers from `getAssociationsByParty`): without `--account <id>`, a command fails with `input` and lists the accounts. The agent asks the user and passes `--account` on later calls. Single-account users never see this. Decided in [One site per plugin, or several?](https://github.com/hoaj/skills/issues/12).

## 8. CLI surface

Decided in [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6).

**Commands:**
- **Task commands:** `<noun> <verb> [flags]`, one per Task.
- **Built-in, the same in every CLI skill:**
  - `help`: commands, flags and exit codes, as JSON;
  - `login`;
  - `check [--op <name>]`;
  - `report --last` or `report --feature "<task>"`;
  - `doctor`: versions, template version, state dir, Chrome path, `gh` status;
  - `version`.

**Output:** stdout is always exactly one JSON document, and stderr carries progress. A failure prints:

```json
{"error": {"kind": "drift", "message": "…", "fingerprint": "…", "diff": [], "next": "<what the agent must do>"}}
```

**Exit codes:**

| Exit | kind | `next` tells the agent |
|---|---|---|
| 0 | ok | |
| 1 | bug | run `report --last`, show the user the link, stop |
| 2 | input | fix the flags (see `help`) |
| 3 | drift | run `report --last`, show the user the link, stop, and don't work around it with raw calls |
| 4 | session | run `login` (the user signs in to Chrome), then rerun |
| 5 | network | tell the user the site isn't responding, and stop |

**Writes:** decided in [Who picks a plugin's task commands?](https://github.com/hoaj/skills/issues/11). A write command without `--confirm` validates its input, resolves the chain, prints `{"dryRun": true, "would": {...}}` and exits 0. SKILL.md tells the agent to show the user the dry run and get an explicit yes before rerunning with `--confirm`.

**Tasks across logins:** never one command. The agent chains commands from each CLI skill.

**SKILL.md** (about 45 lines):
1. Frontmatter with only `name` and `description`. The version goes in an HTML comment below it, because a `version:` key breaks Copilot.
2. A one-paragraph intro: `bin/<skill>` is in this skill's folder, and output is JSON.
3. `## Commands`: a table generated from `help` at build time, with writes marked.
4. `## When it fails`: exit code → kind → action, plus the missing-binary row (run `install.sh`).
5. `## When NOT to use`.

## 9. Build, release and install

Decided in [Does Playwright work inside bun compile binaries?](https://github.com/hoaj/skills/issues/2), [Do the compiled binaries run on Linux and Windows?](https://github.com/hoaj/skills/issues/15), [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6) and [What do users without gh or repo access get?](https://github.com/hoaj/skills/issues/14).

- **Build:** Bun >= 1.4.0, TypeScript, `Bun.build` with `compile`. `build.ts` carries an `onLoad` plugin that rewrites playwright-core's two `require(join(packageRoot, "package.json" | "browsers.json"))` calls in `lib/coreBundle.js` to static `../package.json` and `../browsers.json`. It asserts exactly two hits and sets `external: ["chromium-bidi", "electron"]`. Without the patch, the binary only runs on the build machine.
- **Targets:** `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` and `windows-x64`, all cross-compiled on one Ubuntu runner. Verified to run:
  - macOS, linux-x64 and windows-x64;
  - linux-arm64 once Chrome is installed.
- **Release:** one tag `vX.Y.Z` per plugin, so all CLI skills ship together. Assets are named `<skill>-<target>[.exe]`.
- **Chrome** is a hard prerequisite. It is found at a fixed path per OS, and `executablePath` overrides it. No browser is shipped. `install.sh` and `doctor` check for Chrome and print how to install it.
- **`install.sh`** runs once, when the agent finds `bin/<skill>` missing. It stops with a clear message at the first failing check:
  - no `gh`: "install GitHub CLI and run `gh auth login`";
  - not logged in: "run `gh auth login`";
  - a 404 on download: "ask `<owner>` for access to `<repo>`";
  - no Chrome: how to install it.

  Then it runs `gh release download v<version> --pattern <skill>-<target>` into `skills/<skill>/bin/`. A plugin update lands in a new cache dir, so the binary always matches its SKILL.md.

## 10. Drift, check and report

Decided in [Drift classification vs other failures](https://github.com/hoaj/skills/issues/5), [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6), [How do generated plugins pick up template fixes?](https://github.com/hoaj/skills/issues/13) and [What do users without gh or repo access get?](https://github.com/hoaj/skills/issues/14).

**Classification:** the CLI classifies every failure deterministically, and the agent never guesses.
- **drift:** any of
  - a Zod parse failure;
  - a GraphQL validation error;
  - a 404 or 405 on a known REST path;
  - a write request whose shape changed, or a `trigger(page)` that can't find its element;
  - a 401 or 403 right after a fresh login;
  - the server rejecting input that passed the variables schema.
- **session:** a 401, a 403 or a redirect to login (handled as in §7).
- **network:** 5xx responses and transport errors, retried 1–2 times.
- **input:** fails the variables or flag schema, so no call is made.
- **bug:** anything else thrown.

**Fingerprint:** `plugin:skill:operation:breakType:path`, with array indices written as `[]`. For example, `yousee:yousee:listFtpdProducts:zod:data.listFtpdProducts[].status:invalid_type`.

**`check`:**
- Calls every **read** Operation live, in chain order, and validates it against its Contract.
- For **write** Operations, runs `trigger(page)`, intercepts the write request, compares its shape and aborts it. `check` never writes.

**`report --last`:** files the last failure if it was `drift` or `bug`, using the user's own `gh`.
1. Searches the plugin repo for the Fingerprint.
2. An open match gets a +1 comment, with the version and OS.
3. A closed match whose fixed version is newer than the user's gets "update the plugin" and nothing is filed. This means `fix` must record the fixed version when it closes an issue.
4. Otherwise it creates an issue.

The issue holds the diff or stack trace and never values.

**`report --feature "<task>"`:** files a Task request, which the maintainer handles with `add-task`.

**Without `gh`, or without permission to file:** `report` returns `{"filed": false, "openInBrowser": "<pre-filled /issues/new link>"}`, with the Fingerprint in the title. The agent gives the link to the user. Duplicates are caught by `fix` through that Fingerprint.

**What the user sees:** a short message with the issue link. On Drift the agent stops the task.

## 11. Out of scope

- Building the generator. This spec is where the map ends.
- Real writes during `check`.
- Rub-style inspection of the site's JS bundle.
- Public plugins installed without `gh`, because they would publish a site's internal API shapes.
- Jira as a test case: it was replaced by Mit YouSee.

## 12. Open points found while writing this spec

These are not decided. Each one needs a short decision before or during the build.

1. **When `check` runs.** The charting session said "runs locally during normal use", but no ticket fixed the trigger. The candidates are only on demand, on every Drift, or once a day before the first command.
2. **Who bumps the plugin version and tags a release.** The version is pinned in at least seven places: four manifests, the SKILL.md comment, `package.json` and `template.json`. `fix`, `add-task` and `upgrade` all open PRs, but nothing says which of them bumps the version and tags. A version-sync test like cogx's is likely needed.
3. **Recording the fixed version.** `report` relies on `fix` recording the version that fixed an issue (§10, step 3), but nowhere specifies how. A label or a closing comment in a fixed format are two ways.
4. **Unsigned binaries.** Gatekeeper on macOS and SmartScreen on Windows prompts for binaries downloaded with `gh` are untested, and so are windows-arm64 and musl Linux.
5. **Who runs fix mode for Drift.** fix re-captures with the maintainer's own login, so the maintainer needs an account on the site that reaches the drifted Task. That's the same assumption as `add-task`, but it's never stated.
6. **The prototype predates three decisions:** CLI skills under `skills/<skill>/`, dry-run writes, and bug and feature reports. It is a throwaway and shouldn't be used as a template.
