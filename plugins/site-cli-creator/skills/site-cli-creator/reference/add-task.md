# Mode: add-task (the Task loop)

Adds one command per Task to an existing CLI skill, reusing its Operations. Triggered by a `feature: <skill>: <Task>` issue or by the maintainer.

Done when every Task is a command that returns the card's output from source, `check --writes` exits 0, and (outside `new` / `add-skill`) the PR is open with a minor bump.

## 1. State the Tasks

From the issue or the user, write each Task in plain words. Turn a vague one into something checkable ("see my latest bill" → which fields, how many bills). Outside `add-skill`, branch: `git switch -c add-task/<slug>`.

If the issue asks for a Task the maintainer's account cannot perform (a product they lack, a role they don't hold), there can be no Capture and no Contract. Close the issue:

```sh
gh issue close <n> --repo <owner/name> --comment "<why the maintainer's account can't perform it; reopen when a maintainer with such an account takes over>"
gh issue edit <n> --repo <owner/name> --add-label needs-account
```

## 2. Capture each Task

Pick a short slug per Task (`subscription-show`) and the page the Task starts from. Then:

```sh
bun <gen>/tools/capture.ts --skill-dir <skill> --task <slug> --url <start page>            # read Task
bun <gen>/tools/capture.ts --skill-dir <skill> --task <slug> --url <start page> --write    # write Task
```

The tool records calls to the origin in `site.ts`; when the site's API lives on another host, pass `--origin <api origin>`, and add `--login-host <host>` for each login host not yet in `site.ts`. Chrome opens headed on the tool's own profile (`~/.site-cli-creator/profile/`). Tell the user to sign in if asked, perform the Task exactly once, then close the browser or press Enter in the terminal. For a read Task the tool aborts every write. For a write Task the user's first write goes through for real, once: say so before starting, and agree on a harmless write (a setting they can revert).

The Capture lands in `<skill>/captures/<slug>/`: one `<operation>.shape.json` per Operation (shapes only, ids redacted) and `index.json` listing Operations in call order with an effect guess. Commit all of it.

If nothing reached the origin, `capture.ts` exits with an error and leaves any earlier Capture of the Task as it was: check `--url`, `--origin` and that the Task was performed, then run it again.

Recapture when the Task's data never appeared (wrong start page, still loading when the browser closed) or a needed Operation is missing.

## 3. Filter Operations

Read `index.json` and the shape files. Keep:

- every Operation with a field that appears in the Task's output;
- every Operation that supplies a variable to a kept one (the chain), back to a root that comes from `session` (the ids `postLogin` stored) or a constant;
- for a write Task, the write itself.

Drop everything else: analytics, feature flags, page chrome, prefetches, and writes that fire as a side effect of a read Task.

Operations marked `loginFlow: true` in `index.json` are sign-in steps (a token request, a post-login call). They are never Operations: they belong in `site.ts`, as `login.tokenRequest` or inside `postLogin` ([contracts.md](contracts.md#sitets)). When the page sends such a POST (or any other non-GET that changes no data) before the Task's data appears, list it in `readOnlyRequests` so `check --writes` lets it through. Reuse an existing `operations/<name>.ts` when the Operation is already there; widen its `response` only by the fields this Task reads.

Show the result as two lists, kept and dropped, with a one-line reason per Operation.

## 4. Card

Show one card per Task and wait for the user to accept or edit it. Write nothing before that.

```
Task 1: "see my subscription and price"
  command: subscription show [--all]
  output:  customer: string
           products: [{name: string, status: string, since: date|null, monthlyDKK: number|null}]
           monthlyTotalDKK: number
  uses:    getCustomer → listFtpdProducts   (dropped: 4, with reasons)
  effect:  read
```

`output` is the command's JSON with the nullability you decided. `effect` is `write` if any used Operation writes; a write command prints a dry run unless `--confirm` is passed.

## 5. Generate

For each new Operation, draft its Contract into its file with `--out` (not shell redirection: `--out` refuses to overwrite an existing Contract), then cut it down by hand:

```sh
bun <gen>/tools/draft-contract.ts <skill>/captures/<slug>/<operation>.shape.json --name <op> --out <skill>/cli/src/operations/<op>.ts
```

Write `<skill>/cli/src/commands/<noun>-<verb>.ts`. [contracts.md](contracts.md) has the format, the cutting rules and the fixture's files as examples. Then:

```sh
bun <gen>/tools/regen.ts --skill-dir <skill>
cd <skill>/cli && bunx tsc --noEmit -p .
cd <skill>/cli && bun src/main.ts <noun> <verb> [flags]        # read Task: compare with the card
cd <skill>/cli && bun src/main.ts <noun> <verb> [flags]        # write Task: must print {"dryRun": true, ...}
cd <skill>/cli && bun src/main.ts check --writes
```

Show the user each read command's output shape against the card, not its values. Run a write with `--confirm` only when the user asks for it and agrees to the change on the site.

`check` passes when it exits 0 with every Operation `ok`. On exit 3, the Contract is wrong for this account: fix the field (usually nullability) and rerun.

## 6. Bump and PR

Skip inside `new` and `add-skill`.

```sh
cd <plugin> && bun run bump minor && bun test
git add -A && git commit -m "add-task: <skill>: <noun> <verb>" && git push -u origin HEAD
gh pr create --title "add-task: <skill>: <noun> <verb>" --body "<the card, kept/dropped Operations, check result>

Fixes #<n>"
```

The maintainer merges.
