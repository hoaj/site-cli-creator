@AGENTS.md

## Pull requests

You have the maintainer's standing yes to merge: review and merge every PR you open in this repo yourself.

1. Once its checks are green, run `/code-review high` on it.
2. Fix every finding that holds up (a red test first for a bug), push, and wait for green again.
3. Merge with the merge step of the `improve-site-cli-creator` skill: remove the worktree, then `gh pr merge <n> --merge --delete-branch`.
4. Tell the maintainer the PR, what the review found and the merge commit.
