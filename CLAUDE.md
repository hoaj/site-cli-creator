@AGENTS.md

## Pull requests

You have the maintainer's standing yes to merge: review and merge every PR you open in this repo yourself. This is the merge procedure; the `improve-site-cli-creator` skill points here.

1. **Wait for green.**
   - **CI:** wait for the PR's checks. When its changed files all fall outside the `paths:` filter of `.github/workflows/site-cli-creator.yml`, CI never runs and there is nothing to wait for. Check that against the filter, never from an empty `gh pr checks`.
   - **Five-platform matrix:** when the PR changes `install.sh`, `build.ts`, `main.ts`, `release.yml` or another Starter workflow, templating (`tools/lib/template.ts`), `package.json` or `bun.lock`, run `gh workflow run site-cli-creator.yml --ref <branch>`. That run must be green on the PR's latest commit too.
2. **Review:** `/code-review high <n>`.
   - **Fixes:** fix every finding that holds up, with a red test first for a bug.
   - **Another round:** when a round found a correctness problem, push the fixes and go back to step 1. When it found only cleanup, push and go on to step 3.
   - **The cap:** three rounds at most. If a correctness problem is still open after the third, stop without merging and tell the maintainer.
3. **Merge.**
   - **Check main first:** `git fetch origin`. When `origin/main` has moved since the checks ran (always for a PR stacked on one that just merged), merge it into the branch, push, wait for green again, and review only that update if it needed more than a clean merge.
   - **Then:**
     1. Confirm `gh pr view <n> --json mergeable` says `MERGEABLE`.
     2. Leave its worktree: ExitWorktree (keep), or `cd` to the main checkout when the session started inside it.
     3. From the main checkout, remove the worktree at the path `git worktree list` shows.
     4. Run `gh pr merge <n> --merge --delete-branch` (no `--repo`, which would keep the local branch).
4. **Tell the maintainer,** after the merge and once:
   - the PR, what the review found and the merge commit;
   - for a generator change, also the skill's Relay items (version, issues closed, cold-read result, Starter code reach).
