@AGENTS.md

## Pull requests

You have the maintainer's standing yes to merge: review and merge every PR you open in this repo yourself. This is the merge procedure; the `improve-site-cli-creator` skill points here.

1. **Wait for green:** wait for the PR's checks. When its changed files all fall outside the `paths:` filter of `.github/workflows/site-cli-creator.yml`, CI never runs and there is nothing to wait for. Check that against the filter, never from an empty `gh pr checks`.
2. **Review:** `/code-review high <n>`.
   - **Fixes:** fix every finding that holds up, with a red test first for a bug.
   - **Another round:** when a round found a correctness problem, push the fixes and go back to step 1. When it found only cleanup, push, get green as in step 1 and go on to step 3.
   - **The cap:** three rounds at most. The third round's findings are not fixed in this PR, and neither are findings from the review in step 3's **Check main first** once three rounds are used. What happens to them:
     - **Some hold the merge.** That is any finding that blocks a pipeline (CI, the five-platform matrix, release or install) or breaks something vital. Vital means, for example, an unwanted, unconsented or repeated write, lost or leaked data, a security hole, a broken Server sign-in or Session, or Starter code that breaks every generated CLI. When one of these is open, file nothing. Stop without merging and give the maintainer every open finding, including whether the five-platform matrix has run on that commit. A security hole is never a public issue (`SECURITY.md`).
     - **The rest don't.** File each as an issue with `--label site-cli-creator`, naming the PR. List them in the PR body under "Follow-ups (left open)" without a closing keyword, so the merge leaves them open. Then go on to step 3.
3. **Merge.**
   - **Check main first:** `git fetch origin`. When `origin/main` has moved since the checks ran (always for a PR stacked on one that just merged), merge it into the branch, push, wait for green again, and review only that update if it needed more than a clean merge.
   - **Five-platform matrix:** when the PR changes `install.sh`, `build.ts`, `main.ts`, `release.yml` or another Starter workflow, templating (`tools/lib/template.ts`), `package.json`, `bun.lock`, anything in the Starter CLI's `src/runtime/`, or its `tests/browser.test.ts`, `tests/transport.test.ts` or `tests/helpers.ts`, run `gh workflow run site-cli-creator.yml --ref <branch>`. Run it once, after the last review round and any merge of `main`, not after each round: it must be green on the PR's head commit. Its `test` job also runs a generated plugin's Chrome tests, on Linux only; the other targets run the smoke test. A runner or download failure before any test ran may be rerun once (`gh run rerun <id> --failed`). When it fails because of the PR and fewer than three review rounds are used, fix it, push and go back to step 1. On any other failure, stop without merging and tell the maintainer.
   - **Then:**
     1. `git fetch origin` again. When `origin/main` moved since **Check main first**, go back to it, and rerun the matrix if this PR needs one.
     2. Confirm `gh pr view <n> --json mergeable` says `MERGEABLE`.
     3. Leave its worktree: ExitWorktree (keep), or `cd` to the main checkout when the session started inside it.
     4. From the main checkout, remove the worktree at the path `git worktree list` shows.
     5. Run `gh pr merge <n> --merge --delete-branch` (no `--repo`, which would keep the local branch).
4. **Tell the maintainer,** after the merge and once:
   - the PR, what the review found, the issues filed for findings left open, and the merge commit;
   - for a generator change, also the skill's Relay items (version, issues closed, cold-read result, Starter code reach).
