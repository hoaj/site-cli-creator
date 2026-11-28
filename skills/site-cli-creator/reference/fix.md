# Mode: fix

Fixes one issue filed by a plugin's Feedback skill. The title says which kind:

| Title | Kind | Example |
|---|---|---|
| `plugin:skill:operation:breakType:path:code` | Drift | `yousee:yousee:listFtpdProducts:zod:data.listFtpdProducts[].status:invalid_type` |
| `plugin:skill:command:output:path:code` | Drift of a command's `output` schema (2a: the command's name, with its space, stands where the Operation does) | `shop:shop:invoice list:output:invoices[].amountDKK:too_small` |
| `bug: plugin:skill:bug:command:ErrorName:frame` | bug | `bug: yousee:yousee:bug:subscription-show:TypeError:commands/subscription-show.ts#render` |
| `check: plugin:skill: the daily check failed (<kind>)` | the daily drift check's `check` failed without Drift (label `bug`, no bug key) | `check: shop:shop: the daily check failed (input)` |
| `bug: plugin:skill:blocked:<blocked>` | a bot block: the site refuses the CLI as automated traffic (label `bug`), see 2c | `bug: shop:shop:blocked:cloudflare` |
| `ci-session: plugin:skill: the daily check needs a new session` | the daily drift check's CI session for a login skill expired (label `ci-session`) | `ci-session: shop:shop: the daily check needs a new session` |

**A `check:` issue** is the daily drift check (README: Daily drift check) reporting a `check` that failed with a kind other than Drift. Run `bin/<skill> check` (or `bun src/main.ts check`) yourself and read its envelope: a `bug` envelope carries its bug key, so fix it as a bug; an `input` one (often several accounts under the CI login) is fixed in the Contract's `needs`, or with the secret `ACCOUNT_<PLUGIN>_<SKILL>` naming the account (README: Daily drift check), not the code; `secret` means `SESSION_<PLUGIN>_<SKILL>` holds no session.json: store it again; `timeout` means `check` hung for 5 minutes: run it yourself to see where; `blocked` means the site refuses the CI runner (a bot wall, a blocked address): climb the ladder in 2c first, and set the skill's `dailyCheck: false` in `site.ts` only when it is the runner's address, with a patch bump; `crash` or `drift with no Fingerprint` means the binary did not run as built (a release asset missing, a broken build): check the release. Close it once a manual run of the workflow (`gh workflow run drift-check.yml`) passes.

**A `ci-session:` issue** needs no code: renew the CI session with the commands in the issue, then close it.

The queue, by kind (the Feedback skill labels each issue; one filed through the pre-filled link may lack the label, but its title still says the kind):

```sh
gh issue list --repo <owner/name> --state open --label drift
gh issue list --repo <owner/name> --state open --label bug
```

**A plugin in a shared repo** (its `generated.json` has a `pluginDir` other than `.`, such as `plugins/<plugin>`): add `--label <plugin>` to both, since the repo holds other plugins' issues too (an issue filed through the link may lack labels; its title starts with `<plugin>:` or `bug: <plugin>:`). Run every `cd <plugin>` below in that folder, and read release tags as `generated.json`'s `tagPrefix` plus the version (`<plugin>-v1.2.3`); a plugin whose `generated.json` has no `tagPrefix` uses `v`.

Done when the PR is open with a patch bump and `Fixes #<n>`, `check --writes` passed (or the PR is labelled `unverified`), and a Drift PR without `unverified` is merged after green checks.

## 1. Read the issue

```sh
gh issue view <n> --repo <owner/name> --comments
```

Take the Fingerprint or bug key, the diff or stack, the reporter's version and OS, and the +1s. Search for duplicates with the same key; close them as duplicates of `<n>` with a link. Put the key in a variable through a quoted heredoc, because a Fingerprint can hold `$` (`$type`), which the shell would expand inside double quotes:

```sh
key=$(cat <<'EOF'
<key>
EOF
)
gh issue list --repo <owner/name> --state all --search "\"$key\" in:title"
gh issue list --repo <owner/name> --state open --search "\"<plugin>:<skill>:<operation>:\" in:title"
```

The second search finds the same Operation reported with another break type: one site change can reach users as two Fingerprints (`check --writes` sees a write's `request` shape change, a command sees the server's `graphql` error). When the fix in step 2a also makes those pass, close them as duplicates of `<n>` too. Branch: `git switch -c fix/<n>`.

## 2a. Drift

The Fingerprint names the skill, the Operation (for break type `output`, the command), the break type and the field path. In the path `[]` is an array index and `{}` a record or map key: the key is the site's data, so it is never shown. A `trigger` Fingerprint's path is the locator the trigger waited for.

1. Re-capture first, so the maintainer signs in once: the Capture's own Chrome profile signs in (the user signs in there if it asks). **An `output` Fingerprint** names the command, not an Operation: its `<noun> <verb>` is the Task, and its slug is the Capture folder `<noun>-<verb>` in `captures/`; re-capture that Task. Otherwise re-capture the Task whose command uses the Operation: `grep -l "operations/<file>" <skill>/cli/src/commands/*.ts` names the command files, and the Task's slug is the command's `<noun>-<verb>` folder in `captures/` (or the folder whose Capture holds the Operation's shape file). When several Tasks use it, re-capture each one whose output reads the drifted field, so no `captures/` folder keeps the old shape of that field; the others may keep theirs (a Capture records what the site did then). A Fingerprint with an empty path (`auth`, `http`) names no field: re-capture one Task that uses the Operation. The start page is the origin plus `startPath` in the Task's `captures/<slug>/index.json`; a Task split from `captures/explore/` is re-captured the same way, and `captures/explore/` is left as it is (`draft-contract` never merges it).
   ```sh
   bun <gen>/tools/capture.ts --skill-dir <skill> --task <slug> --url <start page> [--write]
   ```
   When the site refuses the Capture (a bot wall or an error page instead of the Task's data), it exits 1 and keeps the earlier Capture of the Task as it was; its error says why. Follow the error's next step (capture again without `--headless`, or with `--allow-read`), and when the wall stays, it is a bot block: [2c](#2c-a-bot-block).
2. **An `output` Fingerprint:** reproduce by running the command itself, never `check --op` (it names Operations, and `check` never runs a command): `cd <skill>/cli && SITE_CLI_NONINTERACTIVE=1 bun src/main.ts <noun> <verb> <args>`, after signing the CLI in as the paragraph below describes (`login --from-profile`). The same Fingerprint: go on. The command passes: go to **Unverified**, for a read command. A write command must not be rerun with `--confirm` to reproduce (the Drift's envelope says `writeSent: true` when it was already sent), and its dry run always exits 0 and never reaches the output check, so a passing dry run proves nothing: do not go to Unverified because of it. Diagnose from the new Capture and the command's mapping instead (what the write's answer carries now, and what `run` maps from it), and correct it from the issue's `diff`. For every other Fingerprint:

   Reproduce with the maintainer's account. For a login skill, sign the CLI in from the Capture's profile once the Capture has stopped: `cd <skill>/cli && bun src/main.ts login --from-profile ~/.site-cli-creator/profile` (or the `--profile` you gave `capture.ts`). Only if that exits 4, run plain `login`, and tell the user first that Chrome opens and they must sign in again. Without a session the next command would open a headed Chrome and wait up to 10 minutes, so run with `SITE_CLI_NONINTERACTIVE=1`, which turns that wait into an immediate exit 4: `cd <skill>/cli && SITE_CLI_NONINTERACTIVE=1 bun src/main.ts check --op "<operation>"` (quote it; a REST Operation may be given as the Fingerprint writes it, `"GET /api/invoices/{id}"`, or as its `name`, `"GET /api/invoices/:id"`). Same Fingerprint: go on, unless it is `auth` (a 403) or `zod` with an empty path (an HTML page where JSON was expected) while the new Capture recorded JSON for that call. Then the site now refuses requests that don't come from a browser: set `transport: "browser"` ([contracts.md](contracts.md#sitets)) and run `check` again; that is the fix. `check` passes: first rule out an expired sign-in. When `site.ts` has no `login.sessionProbe` and the site serves a signed-out request as an anonymous user (the `curl` test in [add-skill.md](add-skill.md#4-fill-in-sitets) step 4), the user's expired sign-in reached them as this Drift: add `sessionProbe` ([contracts.md](contracts.md#sitets)); that is the fix. The same when it is an `html` Drift (`no_match`) or `zod` and the signed-out `curl` shows a redirect to a sign-in page on the site's own host or a 200 sign-in form: set `login.paths` or `login.signedOutSelector` instead, choosing them with the second signed-out check in [add-skill.md](add-skill.md#4-fill-in-sitets) step 4 (`-w '%{http_code} %{content_type}'` and the `tr '\n' ' ' | grep -oiE '<form[^>]*>'`, which print no page text). Otherwise the Drift may be account-specific; go to **Unverified** below.
3. Update the Contract by break type:

   | breakType | Change |
   |---|---|
   | `zod` | the field's type, nullability or presence in `response`, and the command if it reads the field (a type change: below). Leave the query as the new Capture's `request` shows it: the site answers it, only the response changed |
   | `graphql` | the trimmed query: a renamed or moved field, a new required argument |
   | `http` (404/405) | `rest.path` or `rest.method`, from the new Capture |
   | `input-rejected` | `variables` and how the command builds them. A REST 400/422 Drift's `diff` and message name the rejected fields (`rejected`; a name the Contract does not declare is `{}`); `diff: []` means the site's body named none |
   | `auth` | `site.ts`: `login.tokenRequest`, `login.hosts`, `postLogin` or `bootstrap`; a 403 while the new Capture got JSON: `transport: "browser"` (step 2) |
   | `request` | `variables` and the command, from the new Capture of the write |
   | `html` | an HTML Operation's `html.fields` selectors (a `no_match` list: its `each` and `in`), or `html.from`, rewritten from the new Capture's outline ([contracts.md](contracts.md#html-operations)); a missing field is `zod` Drift on the picked object, fixed in `html.fields` the same way |
   | `output` | the command, not an Operation: the command's result no longer matches its `output` schema at `<path>` (`too_small`: a `.min(1)` or `.positive()` value is now empty or zero; `invalid_type`: a field is missing, null or another type). Run the command, not `check` (`check --op` does not know it), and compare with the new Capture: a field the Contract marks optional or nullable that the site renamed or dropped is fixed in the Operation's `response` and in how `run` maps it. When the site really now sends an empty value for it, loosen `output` (drop the refinement, add `.nullable()`) and say so in the PR: the maintainer decides, since the output's meaning changes |
   | `trigger` | the `trigger`'s locators; or, when the page now waits for a non-GET that changes no data (a token refresh, a post-login call) and `check` aborted it, `readOnlyRequests` in `site.ts` |

   **A field whose type changed** (`price` number → string): keep the command's output type when a lossless conversion exists. Accept the new form in the Contract with a format check, so an unexpected format is still Drift rather than wrong data, and convert in the command: `price: z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])` and `Number(s.price)`. The new Capture's shape notes a string's format (`"format": "numeric"`, `"date"`); when it gives none, look at what the site's page shows. When no lossless conversion exists, changing the output field's type is a major change, like a rename: the maintainer decides.

4. `cd <skill>/cli && bun src/main.ts check --writes` until it exits 0. Run the affected command and compare its output shape with the command's previous output; a renamed or removed output field, or an output field whose type changed, is a major change the maintainer decides on. When the output does change, update the command's `output` schema in the same change, so it still describes what the command prints. A command that has no `output` yet gets one now, written from its current output (nullability as the Contract and the card have it), unless the plugin has no `cli/src/runtime/output.ts`: there do not add one (its older `Command` type rejects the field and the typecheck fails); say in the PR that the runtime predates output schemas and offer the port as a separate change, never unasked (`regen` prints a different hint in that case).
5. Bump, PR, merge (step 3).

### Unverified

When the maintainer's account can't reach the failing Task or field (a different subscription type, a product they lack):

- correct the Contract from the issue's `diff` alone: field path, Zod issue code, expected and received type names;
- run `check` anyway, so the rest still passes for the maintainer;
- label the PR `unverified` and leave it for the maintainer to merge;
- after the release, comment on the issue: "Fixed in <tag> without access to an account like yours. Please update the plugin and run `<skill> check --op <operation>`, then tell us whether it passes." For `output` Drift, ask them to run the command instead (`<skill> <noun> <verb> <args>`, never a write with `--confirm`), since `check` does not run commands.

## 2b. Bug

1. Find the frame in the bug key (`commands/subscription-show.ts#render`) and the stack in the issue.
2. Reproduce it in a test under `<skill>/cli/tests/` that fails before the fix. Use a fake `fetch` the way the runtime tests do; never paste site values from the maintainer's account into a test, invent them.
3. Fix it in the plugin's own code, wherever it sits, and run `bun test` in `<skill>/cli` and in `<plugin>`.
4. If the file came from the Starter code (`main.ts`, `runtime/*`, `build.ts`, `install.sh`, the workflows, `scripts/`), tell the user the generator's Starter code likely has the same bug, and offer to file it with `site-cli-creator-feedback` (file only on a yes). Other plugins are not touched.

## 2c. A bot block

A `bug: plugin:skill:blocked:<blocked>` issue (the Feedback skill files it when exit 5 with `blocked` keeps happening) says the site refuses the CLI as automated traffic. It is a bug, not a missing Task: the CLI's job is to send what the user's browser sends, so a block means it does not look like the browser yet. The plugin's agent stops and works around nothing; getting past the wall is yours.

1. Reproduce it: `SITE_CLI_NONINTERACTIVE=1 bun src/main.ts check` exits 5 with the same `blocked`. A wall the CLI does not recognise shows as exit 3 (an `auth` Fingerprint, or `zod` with an empty path on an HTML answer); the same `curl` as in [add-skill.md](add-skill.md#4-fill-in-sitets) step 4 tells which.
2. Climb the ladder, cheapest step first. After each step run `check` again, and stop at the first that exits 0. Each step is a patch to the plugin, with a test where code changed.
   1. **Headers.** Plain fetch sends the user-agent of the user's own Chrome and an `accept-language` by default (`runtime/browser-headers.ts`); a plugin generated before generator 0.19.0 does not, nor has it `site.headers`: port from the Starter code `runtime/browser-headers.ts` (new), `runtime/never.ts` (`keepGuard`), `runtime/site.ts` (the `headers` field and its check), `runtime/call.ts` (the Client constructor's `withOwn`) and the `browserLike` wiring in `main.ts` first. Then compare the request header names the Capture recorded (`requests[].headers`: names, with values only for a few) with what the CLI sends: `accept`, `content-type`, the session's headers, those two defaults and `site.headers`. Put each one the CLI lacks in `site.headers` ([contracts.md](contracts.md#sitets)); the `sec-fetch-*` values below suit API calls, so an HTML Operation (a page fetched as a navigation) wants `sec-fetch-mode: navigate`, `sec-fetch-dest: document` and `sec-fetch-user: ?1`, or leave them out: `origin` (the site's origin), `referer` (the origin and `/`), `sec-fetch-site: same-origin`, `sec-fetch-mode: cors`, `sec-fetch-dest: empty`, `x-requested-with`. Client hints (`sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`) only when the Capture shows the page sends them and the wall needs them: they are fixed values, and the user-agent follows each user's Chrome, so pin both (`user-agent` in `site.headers` too, the same Chrome major and OS), or go to step 3, where Chrome sends its own. Chrome's own header values are not account data: read them from DevTools (Network, any request on the site, in your own browser). The client hints must match the user-agent's Chrome major version (`runtime/browser-headers.ts` `installedChromeVersion()` reads it).
   2. **Cookies the page's scripts set.** A script on the page sets a cookie the API wants (`document.cookie = "name=value"`). Find its name in the page source or DevTools (Application, Cookies); the Capture's `setCookies` lists only cookies a response set, not these. Plain fetch cannot run the script and `ctx.cookies()` never sees a `document.cookie` cookie, so this works only when the value is a constant, and only for `auth: "none"`: return it in `bootstrap`'s `headers` as `cookie`. A login skill has no `bootstrap` (its session holds the cookies its sign-in captured), and a value the script computes needs a browser: go to step 3.
   3. **`transport: "browser"`**, for Chrome's own TLS and JavaScript ([contracts.md](contracts.md#sitets)).
   4. **`browserWindow: true`**, for a site that refuses headless Chrome.
   5. **Only what needs a person is out of scope:** a captcha that must be solved. A request the page signs one at a time may sometimes be ported: decide case by case. Close the issue saying which step failed and why; never rotate IPs or forge a fingerprint.
3. The daily check can file its own `check:` issue ("blocked") for the same wall: close whichever came second as a duplicate, and fix once.
4. Add the daily check's `dailyCheck: false` only when the wall is the CI runner's address and no step helps (`check` passes on the maintainer's machine).

## 3. Bump, PR, merge

```sh
cd <plugin> && bun run bump patch && bun test
git add -A && git commit -m "fix: $key" && git push -u origin HEAD
gh pr create --title "fix: $key" --body "<what changed and why, check result>

Fixes #<n>"     # add: --label unverified  when it applies
```

`$key` is the variable from step 1 (set it again through the quoted heredoc in a new shell). Body and commit message hold field paths and type names, never values.

| PR | Merge |
|---|---|
| Drift, not `unverified` | `gh pr checks <pr> --watch --fail-fast` exits 0, then `git fetch origin && bun run version-check origin/main` exits 0, then `gh pr merge <pr> --squash --delete-branch --match-head-commit "$(git rev-parse HEAD)"` |
| Drift, `unverified` | the maintainer |
| bug | the maintainer |

A green check can be stale: it compared the version with `main` as it was when the PR was pushed. The local `version-check` against a fresh `origin/main` catches a release that landed since, and every push to `main` marks open PRs whose version is no longer above it with a failing `version above main` status. When either fails, another release landed first: `git fetch origin && git rebase origin/main`, resolve the version files to `main`'s, `bun run bump patch`, push with `--force-with-lease`, and watch again.

After the merge, `release.yml` (`<plugin>-release.yml` at the root of a shared repo) publishes `vX.Y.Z` (`<plugin>-vX.Y.Z`) and labels the issue `fixed-in:` plus that tag. Confirm with `gh run watch` and tell the user the version.
