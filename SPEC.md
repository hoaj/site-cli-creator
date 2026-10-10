# site-cli-creator: build spec

site-cli-creator is a skill that turns the calls a website's frontend makes into a **plugin** for coding agents. Each plugin holds one or more **CLI skills**. A CLI skill wraps one login on one site and runs **Tasks** as commands. It detects when the site changes (**Drift**). The plugin's **Feedback skill** reports it, once the user agrees, to the plugin's repo, where the generator fixes it.

Glossary terms (**Task**, **CLI skill**, **Feedback skill**, **Capture**, **Operation**, **Contract**, **Effect**, **Drift**, **Fingerprint**) are defined in [`CONTEXT.md`](./CONTEXT.md). Sections link the tickets that decided them, on the map [site-cli-creator](https://github.com/hoaj/skills/issues/1). The test case is Mit YouSee (yousee.dk): reading the logged-in user's subscription.

---

## 1. Parts

| Part | Who runs it | What it is |
|---|---|---|
| **site-cli-creator** | the maintainer | a plugin in `hoaj/skills`: the generator skill (SKILL.md, the fixed template, the Capture tool) and `site-cli-creator-feedback` |
| **Generated plugin** | many users | its own repo, holding one or more CLI skills, one Feedback skill, four manifests and a release workflow |
| **CLI skill** | users' agents | `skills/<skill>/`: a SKILL.md and a compiled CLI for one login |
| **Feedback skill** | users' agents | `skills/<plugin>-feedback/`: files Drift, bugs and feature requests on the plugin's own repo (§10) |

Every Feedback skill lies next to the plugin it reports on and files issues on that plugin's repo, decided in [Feedback skills next to each plugin](https://github.com/hoaj/skills/issues/24). `site-cli-creator-feedback` files problems with the generator itself (the Capture tool, a mode, the template, misleading guidance) on `hoaj/skills` with the label `site-cli-creator`. It does not forward issues from generated plugins.

The generator writes into a repo that the person running it chooses. After generation, a plugin depends on nothing from the generator at run time.

## 2. Generator modes

Decided in [Who picks a plugin's task commands?](https://github.com/hoaj/skills/issues/11), [One site per plugin, or several?](https://github.com/hoaj/skills/issues/12) and [How do generated plugins pick up template fixes?](https://github.com/hoaj/skills/issues/13).

| Mode | Trigger | Does |
|---|---|---|
| `new` | a new site | creates the plugin repo layout, then runs **add-skill** for the first login |
| `add-skill` | a new login in an existing plugin | creates `skills/<skill>/`, sets up login for the site, then runs **add-task** for each Task |
| `add-task` | a feature request filed by the Feedback skill, or the maintainer | runs the Task loop (§3) once, reusing existing Operations, then opens a PR that the maintainer merges |
| `fix` | a Drift or bug issue | **Drift:** re-captures only the affected Task, updates the Contract, runs `check`, opens a PR that auto-merges when green. **Bug in the site's own code** (`operations/`, `commands/`, `site.ts`): fixes it in the plugin and opens a PR. **Bug in template code:** fixes the generator's template, then runs `upgrade` on the plugin |
| `upgrade` | a template change | replaces only the template files (§5), rewrites `template.json` to the new version, rebuilds, runs `check`, opens a PR |

Only Drift fixes auto-merge. The maintainer merges everything else. Every mode passes `--writes` when it runs `check` (§10). Every mode that opens a PR also bumps the plugin version in that PR (§9).

## 3. The Task loop

Decided in [Who picks a plugin's task commands?](https://github.com/hoaj/skills/issues/11).

1. **State the Tasks.** The user lists, in plain words, what agents should be able to do. For example: "see my subscription and price", "see my latest bill".
2. **Capture each Task.** The user performs the Task in Chrome while the Capture tool records the calls as shapes only: no values, ids redacted. Header values are kept only for an allowlist of names (a spec choice, taken from the capture script). For a **read** Task, the tool aborts every write. For a **write** Task, the user's own write goes through for real, once, so the request and response shapes are both recorded.
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
5. **Generate.** The agent writes one Contract per Operation (§6) and the command file. The generator regenerates `registry.ts` and the SKILL.md command table (from `help`), then runs `check`. Only the generator writes the command table, in add-task, fix and upgrade. The release build never rewrites committed files.

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
  skills/<plugin>-feedback/SKILL.md         GENERATED  one per plugin, written once by `new`, then owned
                                                       by the plugin (§10)
  skills/<skill>/                           one per login
    SKILL.md                                MIXED      see §5 and §8
    install.sh                              TEMPLATE   see §9
    .gitignore                              GENERATED  bin/
    captures/<task>/*.shape.json            GENERATED  shape-only Captures (file naming is a spec choice)
    cli/
      package.json                          GENERATED  plugin version and dependency pins
      build.ts                              TEMPLATE   carries the playwright-core patch (§9)
      src/main.ts, src/runtime/*            TEMPLATE   routing, envelope, call + classification,
                                                       session, check
      src/site.ts                           GENERATED  origin, URLs, login hosts, token request, repo;
                                                       site-specific post-login step (§7)
      src/registry.ts                       GENERATED  static imports, so `bun build --compile` sees them
      src/operations/<name>.ts              AGENT      one Contract per Operation
      src/commands/<noun>-<verb>.ts         AGENT      one per Task
```

There is no CLI framework. Routing and flag parsing are about 30 lines in `main.ts`. Maintainer-only tooling never ships inside `skills/`, because agents load every skill folder they find.

## 5. Template files and upgrade

Decided in [How do generated plugins pick up template fixes?](https://github.com/hoaj/skills/issues/13).

- **Template files**, owned by the generator and overwritten by `upgrade`: `main.ts`, `runtime/*`, `build.ts`, `install.sh` and `release.yml`, exactly as decided in the ticket. [Who bumps a plugin's version, and how is the fixed version recorded?](https://github.com/hoaj/skills/issues/21) adds the bump script, the version-sync test and the version check workflow (§9).
- **Site files**, never touched by `upgrade`: `site.ts`, `operations/`, `commands/`, `captures/` and `package.json`. `package.json` holds the plugin version, and its dependency pins move only when a template change requires it. `registry.ts` is regenerated.
- **The Feedback skill is a site file.** `new` writes `skills/<plugin>-feedback/SKILL.md` once, and `upgrade` never touches it. A plugin can tailor it, but a later fix to the feedback flow does not reach existing plugins. That trade-off was chosen in [Feedback skills next to each plugin](https://github.com/hoaj/skills/issues/24).
- **SKILL.md is mixed** (a spec choice, so the failure guidance can't go stale). `upgrade` rewrites the intro and `## When it fails`, because they describe template behavior. The frontmatter, `## When NOT to use` and the command table belong to the site. The command table is regenerated from `help`.
- `template.json` records the template version, which is the generator plugin's own version in `hoaj/skills`, bumped the same way (§9). `upgrade` rewrites it, and `doctor` prints it, so a stale plugin shows up. `upgrade` opens no PR when no template file changed.
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

- **Chrome only runs for `login`, the session refresh and `check`'s write checks.** Every command, including write commands, uses plain `fetch`.
- **State** lives in `~/.<plugin>-<skill>/` with mode 0700. The path and mode are spec choices: the path avoids collisions between two plugins whose CLI skills share a name. It holds:
  - `profile/`: a Chrome user-data dir owned by the tool. Chrome 136+ refuses automation on the default profile.
  - `session.json` (0600): the bearer, the cookie, and the chain-root ids.

  There is no `last-error.json`. The Feedback skill works from the error JSON the CLI just printed (§10).
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
- **Task commands:** `<noun> <verb> [flags]`, one per Task. There is no raw `op <name>` escape hatch, because it would invite working around Drift.
- **Built-in, the same in every CLI skill:**
  - `help`: commands, flags and exit codes, as JSON;
  - `login`;
  - `check [--op <name>] [--writes]` (§10);
  - `doctor`: versions, template version, Chrome path, plus the state dir and `gh` status (both spec choices). It prints the `check` command but doesn't run it;
  - `version`.

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
| 4 | session | run `login` (the user signs in to Chrome), then rerun |
| 5 | network | tell the user the site isn't responding, and stop |

**Writes:** decided in [Who picks a plugin's task commands?](https://github.com/hoaj/skills/issues/11). A write command without `--confirm` validates its input, resolves the chain, prints `{"dryRun": true, "would": {...}}` and exits 0. SKILL.md tells the agent to show the user the dry run and get an explicit yes before rerunning with `--confirm`.

**Tasks across logins:** never one command. The agent chains commands from each CLI skill.

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
- **Targets:** `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` and `windows-x64`, cross-compiled on one Ubuntu runner (a spec choice; CI did this for the Linux and Windows targets). Verified to run:
  - darwin-arm64 (one local run), linux-x64 and windows-x64;
  - linux-arm64 once Chrome is installed.

  darwin-x64 is unverified.
- **Release:** one tag `vX.Y.Z` per plugin, so all CLI skills ship together. Assets are named `<skill>-<target>[.exe]`.
- **Versioning**, decided in [Who bumps a plugin's version, and how is the fixed version recorded?](https://github.com/hoaj/skills/issues/21):
  - **One bump command.** `bun run bump <patch|minor|major>` rewrites every copy of the plugin version: the four manifests, the version comment in each SKILL.md (every CLI skill and the Feedback skill) and each `cli/package.json`. Nobody edits version numbers by hand. A version-sync test fails CI if any copy differs.
  - **Each generator PR bumps.** `fix`, `add-task`, `add-skill` and `upgrade` run the bump in their own PR. `new` starts at `0.1.0`. `fix` is a patch. `add-task` and `add-skill` are minor. `upgrade` is a patch, or minor if the template adds something agents can use, such as a flag or a built-in. Major bumps, such as a renamed or removed command, are done by hand.
  - **Merging releases.** When a PR that changed the version merges to main, `release.yml` tags `vX.Y.Z` and builds and publishes the binaries. An auto-merged Drift fix ships with no human step.
  - **Collisions.** A CI check requires a PR's version to be higher than main's. A stale PR goes red, and the generator rebases and bumps again. Auto-merge waits for green, so two releases never share a number.
  - **Recording the fix.** Generator PRs say `Fixes #n`. Once the release is published, `release.yml` adds a `fixed-in:vX.Y.Z` label and a short comment to every issue the released PRs closed. The label is written only after the binaries exist.
- **Chrome** is a hard prerequisite. It is found at a fixed path per OS, and `executablePath` overrides it. No browser is shipped. `install.sh` and `doctor` check for Chrome and print how to install it.
- **`install.sh`** runs once, when the agent finds `bin/<skill>` missing. It stops with a clear message at the first step that fails:
  1. `gh` present, else "install GitHub CLI and run `gh auth login`";
  2. `gh` logged in, else "run `gh auth login`";
  3. Chrome present, else how to install it;
  4. `gh release download v<version> --pattern <skill>-<target>` into `skills/<skill>/bin/`. A plugin update lands in a new cache dir, so the binary always matches its SKILL.md.

  Users install from main, so a new version reaches them as soon as its PR merges, minutes before its binaries exist. On a 404, `install.sh` checks whether it can see the repo. If it can, the release is still being built: "try again in a few minutes". If it can't: "ask `<owner>` for access to `<repo>`". `doctor` gives the same answer. A failed build shows up as a red workflow on main.

## 10. Drift, check and the Feedback skill

Decided in [Drift classification vs other failures](https://github.com/hoaj/skills/issues/5), [Template command surface and SKILL.md layout](https://github.com/hoaj/skills/issues/6), [How do generated plugins pick up template fixes?](https://github.com/hoaj/skills/issues/13) and [What do users without gh or repo access get?](https://github.com/hoaj/skills/issues/14). `check` was settled in [When does check run?](https://github.com/hoaj/skills/issues/20). The Feedback skill was decided in [Feedback skills next to each plugin](https://github.com/hoaj/skills/issues/24), which replaced the `report` subcommand.

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

**Fingerprint:** `plugin:skill:operation:breakType:path:code`, with array indices written as `[]`. `code` is the Zod issue code, the HTTP status or the GraphQL error code, and it may be empty. For example, `yousee:yousee:listFtpdProducts:zod:data.listFtpdProducts[].status:invalid_type`.

**`check`:**
- Calls every **read** Operation live, in chain order, and validates it against its Contract. Plain `check` never launches Chrome.
- With `--writes` (or `--op <write>`), it also runs `trigger(page)` headless from the profile for each **write** Operation, intercepts the write request, compares its shape and aborts it. `check` never writes.
- If anything drifted, it exits 3 with one entry per drifted Operation, and each can be filed through the Feedback skill.
- **Nothing runs `check` automatically.** Users run it on demand, to answer "is the site broken or is it me?". The generator runs it, with `--writes`, in `add-task`, `fix` and `upgrade`. A Task command validates only the Operations it calls. After Drift, nobody sweeps the other Operations: `fix` runs the full `check` anyway. The maintainer schedules no proactive runs in v1, so users surface Drift. CI can't run `check`, because it needs a real logged-in account.

**The Feedback skill** (`skills/<plugin>-feedback/`, one per plugin, covering every CLI skill in it):
- **When:** exit 3 (Drift), exit 1 (bug), a Task the plugin can't do (a feature request for `add-task`), or the user saying "report this". Never for session, network or input failures.
- **Input:** the error envelope the CLI just printed (§8). The skill never reads the state dir and never sees response values.
- **Always asks first, Drift included.** It drafts the issue, shows it to the user and files it only on a yes, using the user's own `gh`.
- **Dedup**, as SKILL.md steps:
  1. Search the plugin repo for the Fingerprint (Drift) or the bug key (see §12).
  2. An open match gets a +1 comment with the version and OS.
  3. A closed match with a `fixed-in:vX.Y.Z` label newer than the user's version gets "update the plugin", and nothing is filed (§9).
  4. A closed match with no `fixed-in` label yet: tell the user a fix is merged and on its way, and add a +1 so a stuck release becomes visible. Nothing new is filed.
  5. Otherwise, create an issue that links any closed match.
- **Titles:** the Fingerprint for Drift, the kind plus the command for a bug or a feature request. The body holds the diff or stack trace and never values.
- **Without `gh`, or without permission to file:** the skill gives the user a pre-filled `/issues/new` link, titled as above. Duplicates are caught by `fix` through that Fingerprint.
- **What the user sees:** a short message with the issue link. On Drift the agent stops the task.

## 11. Out of scope

- Building the generator. This spec is where the map ends.
- Real writes during `check`.
- Running `check` automatically, on users' machines or on a maintainer schedule (v1).
- Rub-style inspection of the site's JS bundle.
- Public plugins installed without `gh`, because they would publish a site's internal API shapes.
- Jira as a test case: it was replaced by Mit YouSee.

## 12. Open points found while writing this spec

These are not decided. Each one needs a short decision before or during the build. Points 1–5 are tickets on the map: [When does check run?](https://github.com/hoaj/skills/issues/20) (resolved), [Who bumps a plugin's version, and how is the fixed version recorded?](https://github.com/hoaj/skills/issues/21), [Do unsigned binaries trigger Gatekeeper or SmartScreen when installed with gh?](https://github.com/hoaj/skills/issues/22) and [Who runs fix mode, and with which site account?](https://github.com/hoaj/skills/issues/23).

1. ~~**When `check` runs.**~~ Resolved in [When does check run?](https://github.com/hoaj/skills/issues/20): on demand only (§10).
2. ~~**Who bumps the plugin version and tags a release.**~~ Resolved in [Who bumps a plugin's version, and how is the fixed version recorded?](https://github.com/hoaj/skills/issues/21) (§9).
3. ~~**Recording the fixed version.**~~ Resolved in [Who bumps a plugin's version, and how is the fixed version recorded?](https://github.com/hoaj/skills/issues/21): a `fixed-in` label added at release (§9, §10).
4. **Unsigned binaries.** Gatekeeper on macOS and SmartScreen on Windows prompts for binaries downloaded with `gh` are untested, and so are windows-arm64 and musl Linux.
5. **Who runs fix mode for Drift.** fix re-captures with the maintainer's own login, so the maintainer needs an account on the site that reaches the drifted Task. That's the same assumption as `add-task`, but it's never stated.
6. **A dedup key for bugs.** A Fingerprint is defined only for Drift. Bugs need their own key for the Feedback skill to search on, for example kind, command and the top stack frame.
7. ~~**Bug reports need the user's yes.**~~ Resolved in [Feedback skills next to each plugin](https://github.com/hoaj/skills/issues/24): every report needs the user's yes, Drift included.
8. **The prototype predates four decisions:** CLI skills under `skills/<skill>/`, dry-run writes, bug and feature reports, and the Feedback skill replacing `report`. It is a throwaway and shouldn't be used as a template.
