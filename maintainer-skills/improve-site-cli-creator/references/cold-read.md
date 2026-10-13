# Cold read

One fresh subagent that did not see the failure follows the generator's docs on the fixture site. Its blindness is the point: it catches a fix that only reads well if you already know the problem.

Send it this brief, filled in, as one self-contained prompt. `<worktree>` is your worktree's absolute path; `<gen>` is `<worktree>/plugins/site-cli-creator/skills/site-cli-creator`. Drift switch names are the `DRIFTS` list in `<gen>/fixtures/site/server.ts` (`rename-field`, `type-change`, `remove-rest`, `graphql-validation`, `write-shape`, `ui-change`, `auth`, `server-error`, `rate-limit`, `input-rejected` at the time of writing).

```
You are a coding agent whose user asked: "Make me a plugin for the site at <fixture url>
with <my login | no login>. Tasks: see my subscriptions, see one invoice by id, list
invoices, add a note to my account."

Work in a fresh temp dir. Learn ONLY from <worktree>/plugins/site-cli-creator/skills/site-cli-creator/SKILL.md,
its reference/*.md, and each tool's --help. Do not read fixtures/expected/** or tests/**.
Start the fixture: bun <gen>/fixtures/site/server.ts --auth <login|none> --port <free port> (background;
kill it at the end). Read fixtures/site/** only to script the clicks during Captures
(--script, --headless), never to learn the API.

Follow mode `new` (new.ts with --skip-checks --no-labels, repo test-owner/fixture-plugin),
the Task loop for each Task, regen, check --writes. Then restart the fixture with --drift <switch> and follow reference/fix.md to repair it.

This round changed: <the fix, in one paragraph, and the docs/tool sections it touched>.
Original failure: <the step-1 capture: command, raw output, doc section followed>.

Answer one question: would a fresh agent following these docs now avoid that failure, and
does the whole flow still work? Return PASS, or FAIL with the one thing a fresh agent would
still get wrong (file + section + what happened). Kill every process you started.
```

Pick the auth mode and drift switch closest to the reported failure. Tell it to use a fresh `--profile <temp dir>` for Captures, so it never touches the maintainer's `~/.site-cli-creator/profile`. A fix that touched only one Task's path may shorten the brief to that Task, but always keep `check --writes` at the end.
