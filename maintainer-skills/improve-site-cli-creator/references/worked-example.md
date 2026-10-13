# Worked round: 0.2.0 (issues #33–#39)

The first real plugin (`logbuy`, a Next.js site with an email + password login) produced seven `site-cli-creator` issues. They went into one branch, `fix/site-cli-creator-0.2.0`, as PR #40.

## 1–2. Pin and cluster

| Area | Issues | Shared root cause |
|---|---|---|
| Capture tool | #33 (`?query=` recorded as GraphQL, search word leaked), #34 (Capture never ends after a popup), #36 (Next.js server actions aborted, RSC not flagged) | `tools/lib/recorder.ts` classifies requests; `capture.ts` decides when to stop |
| Starter runtime | #35 (`check` silently skips reads with fixed inputs), #38 (signing in twice) | `needs` had no constants; `login` had no way to reuse the Capture's profile |
| regen | #37 (a helper in `commands/` registered as a command) | regen imported every file |
| Scaffolding + Feedback skill | #39 (no `drift` / `bug` labels) | label list in `new.ts` |

One version was right: the issues came from one plugin build, and two areas share `reference/add-task.md`.

## 4. Red tests

Each issue got a test that failed on `origin/main` for the reported reason:

- #33: a REST GET with `?query=<word>` → the word must appear in no output file, and `query` must be a query field. (`tests/shape.test.ts`, `tests/capture.test.ts`)
- #34: a `--script` that opens a popup to another origin, then closes the Task window → the Capture must end and be written; SIGTERM must also write it. (`tests/capture.test.ts`)
- #35: an Operation with required inputs and no chain → `check` must list it under `warnings`. (`starter/skill/cli/tests/check.test.ts`, `tests/regen.test.ts`)
- #38: a login skill signed in through a Capture profile, with fresh sign-ins blocked → `login --from-profile` must exit 0. This needed the fixture's login host to remember a sign-in in a cookie, the way a real SSO host does (step 4: a pattern goes into `fixtures/site` when the e2e test must exercise it, as here). (`tests/e2e.test.ts`, `tests/fixture-site.test.ts`)

## 5. Fix choices worth copying

- **Rules, not instances.** #33 became "GraphQL only on a GraphQL path or with a real document", not "ignore a parameter named query".
- **Enforce, then document.** #36 prints a hint naming `--allow-read <path>` the moment a server action is aborted; a new "Next.js sites" section in add-task.md backs it up.
- **SPEC stayed the authority.** #35 kept `check`'s exit 0 (SPEC §10 keeps exit codes for the site's state) and added `warnings`; SPEC §6 and §10 were updated in the same PR.

## 8. Bump

Generator 0.1.0 → 0.2.0 in the three plugin manifests; marketplaces 1.2.0 → 1.3.0. The e2e and regen tests that had hard-coded "0.1.0" as the generator version now read it from `generatorVersion()`; `skills-docs.test.ts` pins the generator and marketplace versions on purpose and was updated. The remaining "0.1.0" strings are a generated plugin's own starting version and stay ([bump.md](bump.md)).

## 9. Starter code reach

`logbuy` (generatedWith 0.1.0) carries the old `check` (no constant `needs`, no warnings) and `login` (no `--from-profile`). Its own workaround (Zod defaults for `limit` and `sortBy`) still works, so porting is optional.

## 7. Cold read: what it caught

The cold read was skipped before the PR opened and run afterwards, twice:

1. **FAIL.** A freshly generated plugin's own `bun test` failed: a Starter test (`doctor.test.ts`) read the plugin's real `generated.json` and expected `generatedWith` "0.1.0", which held only while the generator was 0.1.0. The generator's 467 tests were green, because none ran a generated plugin's full suite. Fixed the test, and fixed the class with a scaffold test that generates a plugin and runs its whole `bun test`. The same read found four smaller gaps (no `loginHosts` in the Capture output, fix mode signing in twice, a `needs` constant example of the wrong type, `check` saying `ok: true` beside warnings).
2. **PASS** after those fixes, with two one-line doc clarifications applied.

Lesson: green generator tests are not a green generated plugin. Run the cold read before opening the PR, so its findings land in the same branch, and rerun it after any fix that changes docs or tool output.
