@AGENTS.md

## Pull requests

You have the maintainer's standing yes to merge: review and merge every PR you open in this repo yourself. This is the merge procedure; the `improve-site-cli-creator` skill points here.

1. **Wait for green.**
   - **CI:** wait for the PR's checks. When its changed files all fall outside the `paths:` filter of `.github/workflows/site-cli-creator.yml`, CI never runs and there is nothing to wait for. Check that against the filter, never from an empty `gh pr checks`.
   - **Five-platform run:** when it changes a file AGENTS.md lists for the five-platform matrix, or `package.json` / `bun.lock`, that run must be green on its latest commit too.
2. **Review:** `/code-review high <n>`. Fix every finding that holds up, with a red test first for a bug, then push and go back to step 1. Stop when a round finds only cleanup or nothing, or after three rounds; then tell the maintainer what is left.
3. **Merge.**
   - **When main has moved** since the checks ran (always for a PR stacked on one that just merged): merge `origin/main` into the branch, push, and go back to step 1.
   - **Then:**
     1. Leave its worktree (ExitWorktree, keep).
     2. Remove it from the main checkout at the path `git worktree list` shows.
     3. Run `gh pr merge <n> --repo hoaj/site-cli-creator --merge --delete-branch`.
4. **Tell the maintainer:**
   - the PR, what the review found and the merge commit;
   - for a generator change, also what the skill's Relay step lists (version, issues closed, cold-read result, Starter code reach).
