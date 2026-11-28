---
name: improve-site-cli-creator
description: Use when you will change the site-cli-creator generator in hoaj/site-cli-creator (the plugin at the repo root) yourself - triaging and fixing issues labelled `site-cli-creator` (filed by site-cli-creator-feedback), fixing friction you just hit in the Capture tool, draft-contract, regen, the Starter code or a mode's reference docs, or adding a generator feature the maintainer asks for. Not for a generated plugin's own Drift, bugs or missing Tasks (that is the generator's `fix` / `add-task` mode on the plugin's repo), nor for only reporting a problem (that is site-cli-creator-feedback).
---

# Improve site-cli-creator

Changes the generator itself: the plugin at the root of hoaj/site-cli-creator, plus this skill. Reports arrive through `site-cli-creator-feedback` as issues labelled `site-cli-creator`; this skill turns them into a tested PR and a new generator version.

The generator multiplies every mistake. A Starter code bug ships into every plugin created after it, a docs gap misleads every agent that runs a mode, and a fix nobody bumps never reaches users (Claude Code caches a plugin by its version). So every change goes **triage → red test → fix → green gate → cold read → bump → PR**.

This skill lives in `.claude/skills/`, not in the plugin's `skills/`, because plugin loaders ship a plugin's whole `skills/` folder to every user and Claude Code never loads `.claude/` from an installed plugin. It loads inside this repo as a project skill.

## Setup

Run once per checkout or worktree; details and commands in [references/setup.md](references/setup.md):

- Bun 1.4.3 (`bun --version`), then `bun install --frozen-lockfile` at the repo root.
- Google Chrome. Without it the browser-driven tests (e2e, the Starter's `browser.test.ts`, and on macOS the Capture tests) **skip and the suite still passes**, so a red test written there never goes red. Check the count line for skips.
- `actionlint` and `shellcheck`.

## Workflow

### 1. Triage

Read the issue: a bug has Intent / Where / Expected / Actual / Environment / Suggestion, a feature has Intent / The gap / Workaround / Environment / Suggestion. Then decide what it is:

| It is | Then |
|---|---|
| Misuse the tools already guard against (any programmatic click or submit inside `page.evaluate` in a `--write` Task's `--script`: `element.click()`, `form.submit()`, `requestSubmit()`; a flag the reference docs explain) | Comment with the documented way and close; if the docs were genuinely unclear, it is a docs bug: go on |
| Missing facts to reproduce (for a Capture issue: the `--script` or how the Task was performed, the flags, the `hints` and aborted lists) | Comment with the questions, add label `needs-info` (`gh label create needs-info --repo hoaj/site-cli-creator` if missing), stop |
| Duplicate of an open issue | Comment with the link, add `duplicate`, close |
| A generated plugin's own code (`operations/`, `commands/`, `site.ts`) | Comment that it belongs on the plugin's repo (filed with its `<plugin>-feedback` skill, fixed with the generator's `fix` mode) and close it |
| A bug in Starter code, seen in a generated plugin | This skill: fix it in `starter/`, and list that plugin under Starter code reach (step 9) |
| A generator tool, mode doc or feature | This skill: go on |

Done when the issue is closed, waiting on `needs-info` (step 2 leaves those out until the reporter answers), or pinned: one command and its wrong output (or, for a feature, one sentence naming the missing capability), plus the doc section the reporter followed.

### 2. Cluster

```sh
gh issue list --repo hoaj/site-cli-creator --label site-cli-creator --state open --search "-label:needs-info" --json number,title
gh pr list --repo hoaj/site-cli-creator --state open --search "site-cli-creator in:title" --json number,title,headRefName,files
```

Leave out issues an open PR already fixes (its body says `Fixes #n`). When the maintainer named the issues, take only those, plus any that share a file or a cause with them. Otherwise fix the rest in as few PRs as you can: one branch, one version, one CI run and one review for several issues, even from different areas ([references/areas.md](references/areas.md)). Issues that share a file or a cause always go together. Two kinds of issue get a PR of their own, with those that share a file or cause with them:

- **One whose files an open generator PR touches:** stack it on that PR (step 3), so the rest of the batch doesn't wait for that PR.
- **One that stalls:** no red test, a fix that outgrows the others, or a change that alone fails the green gate, the cold read, CI or the five-platform matrix. Drop its commit (one commit per issue, step 9) and give it its own PR instead of holding the rest.

### 3. Branch

Sweep merged leftovers first: `git fetch --prune && git branch -vv | grep ': gone]'`, then `git worktree remove ../skills-<slug>` and `git branch -D <branch>` for each, but only when its tip equals its merged PR's head (`gh pr list --state merged --head <branch> --json headRefOid`). `-D` is needed because a squash-merged branch never counts as merged. Skip any other branch and anything that errors.

- No open generator PR touches your files: `git worktree add ../skills-<slug> -b fix/site-cli-creator-<slug> origin/main`.
- An open generator PR touches the same files: branch from its branch instead (`origin/<its branch>`). Still open your PR against `main` (only merges into `main` close `Fixes #n` issues); it shows the other PR's commits until that one merges and you rebase onto `main` (CLAUDE.md, step 3 **Check main first**). Say "stacked on #<n>, merge after it" in the body.

Then run the setup in the new worktree: `node_modules` is per worktree.

### 4. Red test first

Write a test that fails on your branch's base for exactly the reported behaviour, in the area's test file ([references/areas.md](references/areas.md)). Prefer the test file's own inline page or server (`tests/capture.test.ts` has one); add a pattern to `fixtures/site` only when the e2e test or the cold read must exercise it too. A leak (a site value in a capture, envelope or issue) gets a test that plants the value and scans every output file for it.

Done when the new test fails for the reported reason, not for a typo in the test and not by being skipped (check the count line: a skip is not red).

### 5. Fix

- **SPEC.md (repo root) wins.** If the fix changes a rule SPEC.md states, change SPEC.md in the same PR.
- **`ARCHITECTURE.md` is the implementation contract**: update it when an interface, flag or file layout changes.
- **The generator's SKILL.md is a table of contents.** New detail goes to its `reference/*.md`; an edit to SKILL.md that adds a code fence or more than one line of prose belongs in a reference file.
- **Fix the class.** One issue about `?query=` is a rule about every REST query field; one leaked value is a rule about every output.
- **Enforce in tools before reminding in docs**: a tool that refuses or prints a hint beats a sentence the agent must recall.

### 6. Green gate

The commands in [references/areas.md](references/areas.md#green-gate): the test files of every area whose Files you touched (the table above it), `tsc` for the generator and the Starter CLI, `actionlint`, `shellcheck`. Of a [CI-only file](references/areas.md#ci-only-files) run only the tests you added or changed (`-t`). Don't run the full `bun test --parallel=3` locally: CI runs it on every PR (it includes the compiled end-to-end test), and step 9 waits for it. A browser test that fails in CI and passes on a rerun is a bug to fix, not to rerun.

Done when everything is green locally and none of the tests you ran skipped. The full suite's verdict is CI's, in step 9.

### 7. Cold read

Required when the change alters what an agent reads or acts on: `SKILL.md`, `reference/*.md`, the Starter skills, or a tool's flags, hints, errors or output fields (names or meaning). A fix that only makes a tool produce the output it already promised (a field that was wrongly empty) needs the red test, not a cold read. If the cold read must exercise a site pattern the fixture lacks, add it to `fixtures/site` first. Dispatch one fresh subagent with the brief in [references/cold-read.md](references/cold-read.md). It returns PASS, or FAIL with what a fresh agent would still get wrong; fix and rerun until PASS. Run it before opening the PR, so its findings land in the same branch.

### 8. Bump

Every PR that changes the plugin bumps its version: patch for fixes, minor for features or new flags, major only when the maintainer asks. The new version is above `main`'s **and** above every open generator PR's. Pins, the tests that assert them, and which `"0.1.0"` strings to leave alone: [references/bump.md](references/bump.md). After the bump, run `bun test skills/site-cli-creator/tests/skills-docs.test.ts`: it asserts the version.

### 9. Ship

Commit one issue per commit (`site-cli-creator: <summary> (#n)`), push, open a PR titled `site-cli-creator <version>: <summary>`. The body lists each issue as `Fixes #n` with one line on what changed, the cold-read result, and **Starter code reach**: a Starter code change reaches plugins created after the release, and an existing plugin only when its maintainer runs `upgrade` (SPEC §5), so list the generated plugins whose `generated.json` `generatedWith` is older (the maintainer knows their repos; `gh search code generatedWith --owner <owner> --filename generated.json` finds the ones on GitHub) and whether they should run `upgrade` for it. No Starter change: write "Starter code reach: none".

Watch CI: `gh run watch <id> --repo hoaj/site-cli-creator --exit-status`. All jobs must be green. A PR runs the smoke test on linux-x64 only; the five-platform matrix runs on main and on `workflow_dispatch`. Which changes need it on the branch, and when: CLAUDE.md, step 3 (once, on the PR's head commit).

Review and merge it with the procedure in the repo's CLAUDE.md (Pull requests): it holds the maintainer's standing yes, the review loop and the merge commands.

### 10. Relay

After the merge, in the one report CLAUDE.md step 5 asks for, tell the maintainer the PR, the new version, the issues it closes, the cold-read result and the Starter code reach list. They update with `/plugin marketplace update hoaj`.

## Gotchas

- **Windows binaries:** `import.meta.main` is false in a binary built with the `Bun.build` API's `compile` option on Windows. The Starter `main.ts` guards with `isEntry()`. Keep it, and keep the smoke job on windows-latest green.
- **No real site data in this repo.** Reports carry shapes only; tests use the fixture site's fake data or values they plant themselves.
- **CI is the only Windows and Intel-Mac test bed.** A change that the repo's CLAUDE.md lists (Pull requests, step 3) is done only when the smoke job passes on all five targets on the PR's head commit (a PR runs linux-x64 only: dispatch the full matrix on the branch with `gh workflow run site-cli-creator.yml --ref <branch>`).

A worked round (0.2.0, issues #33–#39, PR #40): [references/worked-example.md](references/worked-example.md).
