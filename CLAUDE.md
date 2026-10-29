@AGENTS.md

## Pull requests

You have the maintainer's standing yes to merge: review and merge every PR you open in this repo yourself.

1. **Wait for its checks to go green.** A PR that touches only paths CI skips (docs, `SPEC.md`, `CLAUDE.md`) reports none, which counts as green. When AGENTS.md asks for the five-platform matrix (`install.sh`, `build.ts`, `main.ts`, Starter workflows, templating), that run must be green too.
2. **Review it:** `/code-review high <n>`. Fix every finding that holds up, with a red test first for a bug. Push, wait for green again, and review again until nothing that holds up is left.
3. **Merge,** a stacked PR only after the one it is stacked on.
   - Leave the PR's worktree (ExitWorktree, keep).
   - Remove it from the main checkout: `git worktree remove ../<worktree>`.
   - Run `gh pr merge <n> --repo hoaj/site-cli-creator --merge --delete-branch`.
4. **Tell the maintainer:**
   - the PR, what the review found and the merge commit;
   - for a generator change, also what the `improve-site-cli-creator` skill's Relay step lists (version, issues closed, cold-read result, Starter code reach).
