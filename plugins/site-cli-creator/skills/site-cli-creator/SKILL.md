---
name: site-cli-creator
description: Use when creating or maintaining a plugin whose CLI skills run Tasks on a website through the calls its frontend makes. Covers a new plugin for a site (new), another site or login in an existing plugin (add-skill), a new Task or a feature-request issue (add-task), and a Drift or bug issue filed by a plugin's Feedback skill (fix).
---

# site-cli-creator

This skill builds and maintains a **plugin** for coding agents in a repo the user chooses. Each CLI skill in it wraps one site with one login or none, and runs **Tasks** as `<noun> <verb>` commands of a compiled Bun CLI. You Capture the calls the site's frontend makes while the user performs each Task in Chrome, keep only the Operations the Task needs, write a Contract (Zod schemas) per Operation and one command per Task. The CLI reports **Drift** when the site changes, and the plugin's Feedback skill files it on the plugin's repo, where `fix` picks it up. After `new` copies the Starter code, the plugin owns every file and shares no code with this generator.

Terms (Task, Capture, Operation, Contract, Effect, Drift, Fingerprint, Starter code) mean exactly what they mean in the product's `CONTEXT.md`. `<gen>` below is this skill's folder; `<plugin>` is the generated plugin's root; `<skill>` is `<plugin>/skills/<skill>`.

## Prerequisites

Run these before any mode. Stop at the first failure and tell the user the fix. `new.ts` checks Bun, Chrome, `gh` and admin rights itself before it writes anything, and fails with an `unmet` list naming every requirement that is missing; the site account stays a question you ask.

| Check | Command | Passes when |
|---|---|---|
| Bun 1.4 or newer | `bun --version` | `>= 1.4.0` (install: https://bun.sh) |
| Generator dependencies | `ls <gen>/../../node_modules/zod` | exists; else `cd <gen>/../.. && bun install` |
| Google Chrome | macOS `/Applications/Google Chrome.app`, Linux `/opt/google/chrome/chrome`, Windows `C:\Program Files\Google\Chrome\Application\chrome.exe` | the file exists |
| `gh` logged in | `gh auth status` | exit 0 |
| Admin on the plugin repo (once it exists) | `gh repo view <owner/name> --json viewerPermission -q .viewerPermission` | `ADMIN` |
| A site account that can perform the Tasks (`auth: login` only) | ask the user | they confirm |

## Modes

| Mode | Trigger | Read first | Version bump | PR |
|---|---|---|---|---|
| `new` | a new site and no plugin yet | [reference/new.md](reference/new.md) | none: starts at `0.1.0` | none: first push to `main` releases `v0.1.0` |
| `add-skill` | another site or another login in an existing plugin | [reference/add-skill.md](reference/add-skill.md) | minor | maintainer merges |
| `add-task` | a `feature` issue, or the maintainer wants a new Task | [reference/add-task.md](reference/add-task.md) | minor | maintainer merges |
| `fix` | an issue titled with a Fingerprint (Drift) or `bug: <key>` | [reference/fix.md](reference/fix.md) | patch | Drift: merge when checks are green; bug: maintainer merges |

`new` runs `add-skill` for the first CLI skill, and `add-skill` runs `add-task` for each Task, all inside the one mode's change and its one bump. Before writing any Operation, command or `site.ts`, read [reference/contracts.md](reference/contracts.md).

## The Task loop

Every mode that adds or changes a Task runs this loop. Steps are in [reference/add-task.md](reference/add-task.md).

1. **State the Tasks.** The user lists, in plain words, what agents should be able to do.
2. **Capture each Task** with `capture.ts` while the user performs it in Chrome. Read Tasks abort every write; a write Task passes `--write` and lets the user's one real write through.
3. **Filter Operations.** Keep the Operations whose fields reach the Task's output, plus the chain that supplies their variables. Show kept and dropped, one-line reason each.
4. **Show a card** and wait. Nothing is written before the user accepts or edits it:
   ```
   Task 1: "see my subscription and price"
     command: subscription show [--all]
     output:  customer: string
              products: [{name: string, status: string, since: date|null, monthlyDKK: number|null}]
              monthlyTotalDKK: number
     uses:    getCustomer → listFtpdProducts   (dropped: 4, with reasons)
     effect:  read
   ```
5. **Generate.** One Contract per Operation, one command file, then `regen.ts`, then `check --writes`.

## Rules

- Keep only the Operations whose fields feed the output, plus the chain that supplies their variables. Drop writes that fire as a side effect of a read Task (YouSee's `createQuote`). The full Capture stays archived in `captures/`.
- A Contract's `response` covers only the fields the command reads. Decide for each field whether it may be `null` or missing: one Capture is too narrow to tell, so ask yourself whether another customer could lack it.
- `effect` is declared from what the Operation does to the user's data, never from its method. A GraphQL mutation that only reads is `read`.
- GraphQL Operations carry a trimmed query: only the fields the Contract reads, under the frontend's `operationName`.
- Personal data is never stored or logged: `postLogin` returns chain-root ids only, and nothing writes values into captures, issues, PR text or commit messages. Shapes and type names only.
- Command names are `<noun> <verb>` in English (`subscription show`, `bill list`), one per Task; the file is `commands/<noun>-<verb>.ts`.
- `registry.ts` and the `## Commands` table are written only by `regen.ts`. Edit everything else in the plugin freely: it owns its files.
- Only the release build compiles. Run the CLI from source while developing: `cd <skill>/cli && bun src/main.ts <command>`.

## Tools

Run from anywhere; paths are absolute or relative to the shell's directory. Every tool prints JSON. Quote every value that holds a space (`--description "Read your bills"`): an unquoted multi-word value is refused as an unexpected argument.

```sh
bun <gen>/tools/new.ts --dir <path> --plugin <name> --repo <owner/name> --description "<text>" --maintainer <login> [--no-labels] [--skip-checks]
bun <gen>/tools/add-skill.ts --dir <plugin> --skill <name> --origin <url> --auth login|none
bun <gen>/tools/capture.ts --skill-dir <skill> --task <slug> --url <start> [--write] [--script <file.ts>] [--profile <dir>] [--headless] [--origin <url>] [--login-host <host>]
bun <gen>/tools/draft-contract.ts <skill>/captures/<task>/<operation>.shape.json [--name <op>] [--out <file.ts>]
bun <gen>/tools/regen.ts --skill-dir <skill>
```

- `new.ts --skip-checks` skips the maintainer requirement checks; only tests and CI use it.
- `capture.ts` records calls to the origin in `site.ts`; `--origin <url>` names another API origin and `--login-host <host>` (repeatable) a login host not yet in `site.ts`. When nothing was recorded it fails and leaves an earlier Capture of that Task untouched.
- Operations the Capture marks `loginFlow: true` are sign-in steps (token request, post-login). They go into `site.ts` (`login.tokenRequest`, `postLogin`, `readOnlyRequests`), never into `operations/`.
- `draft-contract.ts --out <file.ts>` writes the draft and refuses to overwrite an existing file; use `--out`, not shell redirection.

In the plugin:

```sh
cd <skill>/cli && bun install                       # once per skill, before regen or any CLI run
cd <skill>/cli && bun src/main.ts login              # auth: login, the user signs in
cd <skill>/cli && bun src/main.ts check --writes     # every mode, before the PR
cd <plugin> && bun run bump <patch|minor|major>      # rewrites every version pin
cd <plugin> && bun test                              # version-sync and runtime tests
```

## Versioning

Every mode that opens a PR bumps in that PR with `bun run bump`: `fix` patch, `add-task` and `add-skill` minor. A renamed or removed command is a major bump the maintainer asks for. Never edit a version by hand: the version-sync test fails on any copy that differs. When CI says the PR's version is not above `main`'s, rebase on `main` and bump again.

## Fix mode

- Drift: re-capture only the affected Task with the maintainer's account, correct the Contract, `check --writes`, patch bump, PR, merge when checks are green.
- The maintainer's account can't reach the Task: correct the Contract from the issue's diff (field path and type), label the PR `unverified`, leave it for the maintainer to merge, and after the release ask the reporter on the issue to run `check --op <name>`.
- Bug: fix it in the plugin's own code and add a test that fails without the fix. If the code came from the Starter code, offer the user an issue through `site-cli-creator-feedback` so new plugins get the fix.
- `add-task` for a Task the maintainer's account can't perform: close the issue with an explanation and the label `needs-account`.

## Pull requests

- Branch `<mode>/<short-slug>`; title `<mode>: <what changed>`; body lists Tasks, Operations and Contracts touched, the `check` result, and `Fixes #<n>` for every issue it resolves (the release labels those issues `fixed-in:vX.Y.Z`).
- Merge automatically only a Drift `fix` without `unverified`, and only after `gh pr checks <n> --watch --fail-fast` exits 0: then `gh pr merge <n> --squash --delete-branch`. Everything else waits for the maintainer.
- A generator problem (a tool fails, this guidance misleads, Starter code is wrong): offer `site-cli-creator-feedback`.

## Maintainer handover

The maintainer is whoever ran `new`, named in `generated.json` (`maintainer`) and the plugin's `README.md`. A handover is an ordinary PR with a patch bump (CI requires every PR's version to be above `main`'s) in which a person with admin rights on the repo and their own site account updates both. After it merges, reopen the `needs-account` issues their account can perform and run `add-task` for them.
