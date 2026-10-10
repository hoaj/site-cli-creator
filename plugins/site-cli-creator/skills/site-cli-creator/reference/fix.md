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

Take the Fingerprint or bug key, the diff or stack, the reporter's version and OS, and the +1s. Search for duplicates with the same key (`gh issue list --repo <owner/name> --state all --search "\"<key>\" in:title"`); close them as duplicates of `<n>` with a link. Branch: `git switch -c fix/<n>`.

## 2a. Drift

The Fingerprint names the skill, the Operation, the break type and the field path.

1. Reproduce with the maintainer's account: `cd <skill>/cli && bun src/main.ts check --op "<operation>"` (quote it; a REST Operation may be given as the Fingerprint writes it, `"GET /api/invoices/{id}"`, or as its `name`, `"GET /api/invoices/:id"`) (on exit 4, run `bun src/main.ts login` first). Same Fingerprint: go on. `check` passes: the Drift may be account-specific; go to **Unverified** below.
2. Re-capture only the Task that uses the Operation (its slug is the `captures/` folder that holds the Operation's shape file):
   ```sh
   bun <gen>/tools/capture.ts --skill-dir <skill> --task <slug> --url <start page> [--write]
   ```
3. Update the Contract by break type:

   | breakType | Change |
   |---|---|
   | `zod` | the field's type, nullability or presence in `response`, and the command if it reads the field |
   | `graphql` | the trimmed query: a renamed or moved field, a new required argument |
   | `http` (404/405) | `rest.path` or `rest.method`, from the new Capture |
   | `input-rejected` | `variables` and how the command builds them |
   | `auth` | `site.ts`: `login.tokenRequest`, `login.hosts`, `postLogin` or `bootstrap` |
   | `request` | `variables` and the command, from the new Capture of the write |
   | `trigger` | the `trigger`'s locators; or, when the page now waits for a non-GET that changes no data (a token refresh, a post-login call) and `check` aborted it, `readOnlyRequests` in `site.ts` |

4. `cd <skill>/cli && bun src/main.ts check --writes` until it exits 0. Run the affected command and compare its output shape with the command's previous output; a renamed or removed output field is a major change the maintainer decides on.
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
git add -A && git commit -m "fix: <key>" && git push -u origin HEAD
gh pr create --title "fix: <key>" --body "<what changed and why, check result>

Fixes #<n>"     # add: --label unverified  when it applies
```

Body and commit message hold field paths and type names, never values.

| PR | Merge |
|---|---|
| Drift, not `unverified` | `gh pr checks <pr> --watch --fail-fast` exits 0, then `gh pr merge <pr> --squash --delete-branch` |
| Drift, `unverified` | the maintainer |
| bug | the maintainer |

When checks fail because the version is not above `main`'s, another release landed first: `git fetch origin && git rebase origin/main`, resolve the version files to `main`'s, `bun run bump patch`, push with `--force-with-lease`, and watch again.

After the merge, `release.yml` publishes `vX.Y.Z` and labels the issue `fixed-in:vX.Y.Z`. Confirm with `gh run watch` and tell the user the version.
