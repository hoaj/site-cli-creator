# Areas of the generator

File paths are under `skills/site-cli-creator/` unless they name the repo root or another folder. Run tests from the repo root, prefixing the test path with `skills/site-cli-creator/`: `bun test skills/site-cli-creator/tests/draft.test.ts`. For a folder of tests pass the folder (`bun test skills/site-cli-creator/starter/plugin/tests`), not a glob; a folder that holds a [CI-only file](#ci-only-files) (`starter/skill/cli/tests/`) gets its other files listed instead.

| Area | Files | Tests | Typical reports |
|---|---|---|---|
| Capture tool | `tools/capture.ts`, `tools/lib/recorder.ts`, `tools/lib/shape.ts`, `tools/lib/graphql.ts` | `tests/capture.test.ts` (has its own inline page: put red tests there), `tests/shape.test.ts` | a value in a shape file; a call mislabelled (REST vs GraphQL, read vs write); a Capture that never stops; a page broken by an aborted read |
| Drafting | `tools/draft-contract.ts`, `tools/lib/draft.ts`, `tools/lib/zod-source.ts` | `tests/draft.test.ts` | a variable dropped; wrong nullability; a draft that doesn't compile or drifts on `check` |
| Scaffolding | `tools/new.ts`, `tools/add-skill.ts`, `tools/lib/scaffold.ts`, `tools/lib/template.ts`, `tools/lib/manifests.ts`, `tools/lib/requirements.ts` | `tests/scaffold.test.ts` | a missing file, label or manifest field; a requirement not checked |
| Registry and SKILL.md table | `tools/regen.ts`, `tools/lib/regen.ts` | `tests/regen.test.ts` | a non-command file registered; a table row wrong |
| Starter runtime | `starter/skill/cli/src/**` | `starter/skill/cli/tests/` (`browser.test.ts` drives real Chrome) | a wrong exit code or Fingerprint; `check` skipping or writing; login/session; Windows-only failures |
| Starter packaging | `starter/skill/cli/build.ts`, `starter/skill/install.sh`, `starter/plugin/**` (workflows, bump, version checks) | `tests/install.test.ts`, `starter/plugin/tests/`, `tests/scaffold.test.ts` (actionlint on the generated workflows) | an install message; a release or `fixed-in` label; version pins out of sync |
| Upgrade | `tools/upgrade.ts`, `tools/lib/upgrade.ts`, `.github/scripts/version-tags.sh` (repo root) | `tests/upgrade.test.ts` | a Starter file merged wrongly; a past Starter version not found; an untagged version |
| Split capture | `tools/split-capture.ts` | `tests/split-capture.test.ts` | a Task's Capture missing an Operation it needs |
| Manifests and README | `.claude-plugin/**`, `.cursor-plugin/**`, `.github/plugin/**`, `README.md`, `package.json`, `bun.lock`, `tsconfig.json` (repo root) | `tests/skills-docs.test.ts` | a version pin out of sync; a manifest field missing |
| Starter Feedback skill | `starter/feedback/SKILL.md` | `tests/skills-docs.test.ts` | dedup, titles, labels |
| Starter Deploy skill and deploy files | `starter/deploy/**` (the skill and `hosts/*.md`), `starter/skill/Dockerfile`, `starter/skill/.dockerignore` | `tests/skills-docs.test.ts` (the skill, its host guides, the Dockerfile, the CI `docker` job), `tests/e2e.test.ts` (`mcp --http`), the CI `docker` job builds the image | a wrong Railway step or flag; a Dockerfile that does not build; the contract (`/data`, env vars) out of step with the runtime |
| Generator docs | `SKILL.md`, `reference/*.md`, `ARCHITECTURE.md` (repo root) | `tests/skills-docs.test.ts` (flags in docs match each tool's usage, links resolve) | an instruction that misleads; a missing site pattern |
| Generator feedback skill | `skills/site-cli-creator-feedback/SKILL.md` (repo root) | `tests/skills-docs.test.ts` | labels, redaction |
| Fixture site | `fixtures/site/**`, `fixtures/expected/**` | `tests/fixture-site.test.ts`, `tests/e2e.test.ts` | a real-site pattern the fixture lacks |
| Generator CI | `.github/workflows/site-cli-creator.yml`, `.github/scripts/scaffold-fixture.sh` | `tests/skills-docs.test.ts` ("generator CI workflow"), and the workflow's own run | a smoke target failing |

## Green gate

```sh
bun test skills/site-cli-creator/tests/shape.test.ts skills/site-cli-creator/tests/draft.test.ts   # the test files of every area you touched, in one command, except the CI-only files; without Chrome the browser tests SKIP
bun test skills/site-cli-creator/tests/capture.test.ts -t "<test name>"                            # a CI-only file: only the tests you added or changed
bun x tsc --noEmit -p .                                      # tools, tests, fixtures
bun x tsc --noEmit -p skills/site-cli-creator/starter/skill/cli
actionlint .github/workflows/*.yml skills/site-cli-creator/starter/plugin/.github/workflows/*.yml
shellcheck skills/site-cli-creator/starter/skill/install.sh
```

Which tests: those of every area whose Files you touched; of a [CI-only file](#ci-only-files), only the tests you added or changed (`-t`). For a file in no row, or a `tools/lib` file shared by several areas, also run the test files that import it (`git grep -l <module> -- '*.test.ts'`).

The full `bun test --parallel=3` (everything, incl. the compiled e2e test) runs in CI on every PR; don't run it locally.

### CI-only files

These drive Chrome and take most of the suite's time (CI, Nov 2026: about 105, 65, 50, 45 and 30 s of the suite's 130 s). Don't run them whole locally: run only the tests you added or changed, with `-t "<test name>"`. CI runs them whole.

Chrome itself is fine locally. Investigate a bug in a real browser (the Playwright CLI, a Capture against the fixture site), and add a Chrome test when one proves the fix. What stays in CI is the full suite and these files whole.

- `tests/e2e.test.ts` (it also compiles the CLI)
- `starter/skill/cli/tests/browser.test.ts`
- `tests/fixture-site.test.ts`
- `tests/capture.test.ts`
- `starter/skill/cli/tests/transport.test.ts`

The full suite runs on Linux only in CI; macOS and Windows get the smoke test, on `main` and on `workflow_dispatch`.

Installing Bun, Chrome, `actionlint` and `shellcheck`: [setup.md](setup.md).
