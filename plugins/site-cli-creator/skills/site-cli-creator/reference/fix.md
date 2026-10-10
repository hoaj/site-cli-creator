# Mode: fix

Fixes one issue filed by a plugin's Feedback skill. The title says which kind:

| Title | Kind | Example |
|---|---|---|
| `plugin:skill:operation:breakType:path:code` | Drift | `yousee:yousee:listFtpdProducts:zod:data.listFtpdProducts[].status:invalid_type` |
| `bug: plugin:skill:bug:command:ErrorName:frame` | bug | `bug: yousee:yousee:bug:subscription-show:TypeError:commands/subscription-show.ts#render` |

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

The Fingerprint names the skill, the Operation, the break type and the field path. In the path `[]` is an array index and `{}` a record or map key: the key is the site's data, so it is never shown. A `trigger` Fingerprint's path is the locator the trigger waited for.

1. Reproduce with the maintainer's account. For a login skill, sign in first (`cd <skill>/cli && bun src/main.ts login`, the user signs in in Chrome): an expired session otherwise makes the next command open a headed Chrome and wait up to 10 minutes. Then run with `SITE_CLI_NONINTERACTIVE=1`, which turns that wait into an immediate exit 4: `cd <skill>/cli && SITE_CLI_NONINTERACTIVE=1 bun src/main.ts check --op "<operation>"` (quote it; a REST Operation may be given as the Fingerprint writes it, `"GET /api/invoices/{id}"`, or as its `name`, `"GET /api/invoices/:id"`). Same Fingerprint: go on. `check` passes: the Drift may be account-specific; go to **Unverified** below.
2. Re-capture the Task whose command uses the Operation: `grep -l "operations/<file>" <skill>/cli/src/commands/*.ts` names the command files, and the Task's slug is the command's `<noun>-<verb>` folder in `captures/` (or the folder whose Capture holds the Operation's shape file). When several Tasks use it, re-capture each one whose output reads the drifted field, so no `captures/` folder keeps the old shape of that field; the others may keep theirs (a Capture records what the site did then).
   ```sh
   bun <gen>/tools/capture.ts --skill-dir <skill> --task <slug> --url <start page> [--write]
   ```
3. Update the Contract by break type:

   | breakType | Change |
   |---|---|
   | `zod` | the field's type, nullability or presence in `response`, and the command if it reads the field (a type change: below) |
   | `graphql` | the trimmed query: a renamed or moved field, a new required argument |
   | `http` (404/405) | `rest.path` or `rest.method`, from the new Capture |
   | `input-rejected` | `variables` and how the command builds them |
   | `auth` | `site.ts`: `login.tokenRequest`, `login.hosts`, `postLogin` or `bootstrap` |
   | `request` | `variables` and the command, from the new Capture of the write |
   | `trigger` | the `trigger`'s locators; or, when the page now waits for a non-GET that changes no data (a token refresh, a post-login call) and `check` aborted it, `readOnlyRequests` in `site.ts` |

   **A field whose type changed** (`price` number → string): keep the command's output type when a lossless conversion exists. Accept the new form in the Contract with a format check, so an unexpected format is still Drift rather than wrong data, and convert in the command: `price: z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])` and `Number(s.price)`. The new Capture's shape notes a string's format (`"format": "numeric"`, `"date"`); when it gives none, look at what the site's page shows. When no lossless conversion exists, changing the output field's type is a major change, like a rename: the maintainer decides.

4. `cd <skill>/cli && bun src/main.ts check --writes` until it exits 0. Run the affected command and compare its output shape with the command's previous output; a renamed or removed output field, or an output field whose type changed, is a major change the maintainer decides on.
5. Bump, PR, merge (step 3).

### Unverified

When the maintainer's account can't reach the failing Task or field (a different subscription type, a product they lack):

- correct the Contract from the issue's `diff` alone: field path, Zod issue code, expected and received type names;
- run `check` anyway, so the rest still passes for the maintainer;
- label the PR `unverified` and leave it for the maintainer to merge;
- after the release, comment on the issue: "Fixed in vX.Y.Z without access to an account like yours. Please update the plugin and run `<skill> check --op <operation>`, then tell us whether it passes."

## 2b. Bug

1. Find the frame in the bug key (`commands/subscription-show.ts#render`) and the stack in the issue.
2. Reproduce it in a test under `<skill>/cli/tests/` that fails before the fix. Use a fake `fetch` the way the runtime tests do; never paste site values from the maintainer's account into a test, invent them.
3. Fix it in the plugin's own code, wherever it sits, and run `bun test` in `<skill>/cli` and in `<plugin>`.
4. If the file came from the Starter code (`main.ts`, `runtime/*`, `build.ts`, `install.sh`, the workflows, `scripts/`), tell the user the generator's Starter code likely has the same bug, and offer to file it with `site-cli-creator-feedback` (file only on a yes). Other plugins are not touched.

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

After the merge, `release.yml` publishes `vX.Y.Z` and labels the issue `fixed-in:vX.Y.Z`. Confirm with `gh run watch` and tell the user the version.
