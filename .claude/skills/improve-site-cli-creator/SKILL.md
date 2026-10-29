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

Leave out issues an open PR already fixes (its body says `Fixes #n`). Group the rest by area ([references/areas.md](references/areas.md)) and root cause: issues that share a file or a cause go into one branch and one version.

### 3. Branch

Sweep merged leftovers first: `git fetch --prune && git branch -vv | grep ': gone]'`, then `git worktree remove ../skills-<slug>` and `git branch -d <branch>` for each; skip anything that errors.

- No open generator PR touches your files: `git worktree add ../skills-<slug> -b fix/site-cli-creator-<slug> origin/main`.
- An open generator PR touches the same files: branch from its branch instead (`origin/<its branch>`). Still open your PR against `main` (only merges into `main` close `Fixes #n` issues); it shows the other PR's commits until that one merges. Say "stacked on #<n>, merge after it" in the body.

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

The commands in [references/areas.md](references/areas.md#green-gate): full `bun test` (it includes the compiled end-to-end test), `tsc` for the generator and the Starter CLI, `actionlint`, `shellcheck`. Run `bun test` twice: browser tests that pass only sometimes are a bug to fix, not to rerun.

Done when everything is green on both runs and the count line shows no new skips.

### 7. Cold read

Required when the change alters what an agent reads or acts on: `SKILL.md`, `reference/*.md`, the Starter skills, or a tool's flags, hints, errors or output fields (names or meaning). A fix that only makes a tool produce the output it already promised (a field that was wrongly empty) needs the red test, not a cold read. If the cold read must exercise a site pattern the fixture lacks, add it to `fixtures/site` first. Dispatch one fresh subagent with the brief in [references/cold-read.md](references/cold-read.md). It returns PASS, or FAIL with what a fresh agent would still get wrong; fix and rerun until PASS. Run it before opening the PR, so its findings land in the same branch.

### 8. Bump

Every PR that changes the plugin bumps its version: patch for fixes, minor for features or new flags, major only when the maintainer asks. The new version is above `main`'s **and** above every open generator PR's. Pins, the tests that assert them, and which `"0.1.0"` strings to leave alone: [references/bump.md](references/bump.md).

### 9. Ship

Commit one issue per commit (`site-cli-creator: <summary> (#n)`), push, open a PR titled `site-cli-creator <version>: <summary>`. The body lists each issue as `Fixes #n` with one line on what changed, the cold-read result, and **Starter code reach**: a Starter code change reaches only plugins created after the release, so list the generated plugins whose `generated.json` `generatedWith` is older (the maintainer knows their repos; `gh search code generatedWith --owner <owner> --filename generated.json` finds the ones on GitHub) and whether they should port the change by hand. No Starter change: write "Starter code reach: none".

Watch CI: `gh run watch <id> --repo hoaj/site-cli-creator --exit-status`. All jobs must be green. A PR runs the smoke test on linux-x64 only; the five-platform matrix runs on main and on `workflow_dispatch`. Before merging a change to `build.ts`, `install.sh`, `release.yml` or `main.ts`, run it on the branch with `gh workflow run site-cli-creator.yml --ref <branch>` and watch it.

Merge when the maintainer says so; CLAUDE.md gives that yes for every PR you open, after its review. Remove your worktree first (`git worktree remove ../skills-<slug>`), then `gh pr merge <n> --merge --delete-branch`.

### 10. Relay

Tell the maintainer the PR, the new version, the issues it closes, the cold-read result and the Starter code reach list. After the merge they update with `/plugin marketplace update hoaj`.

## Gotchas

- **Windows binaries:** `import.meta.main` is false in a binary built with the `Bun.build` API's `compile` option on Windows. The Starter `main.ts` guards with `isEntry()`. Keep it, and keep the smoke job on windows-latest green.
- **No real site data in this repo.** Reports carry shapes only; tests use the fixture site's fake data or values they plant themselves.
- **CI is the only Windows and Intel-Mac test bed.** A change to `build.ts`, `install.sh`, `release.yml` or `main.ts` is done only when the smoke job passes on all five targets (a PR runs linux-x64 only: dispatch the full matrix on the branch with `gh workflow run site-cli-creator.yml --ref <branch>`).

A worked round (0.2.0, issues #33–#39, PR #40): [references/worked-example.md](references/worked-example.md).
