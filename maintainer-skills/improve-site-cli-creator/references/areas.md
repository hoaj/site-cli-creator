# Areas of the generator

File paths are under `plugins/site-cli-creator/skills/site-cli-creator/` unless they start with `plugins/` or name the repo root. Run tests from `plugins/site-cli-creator`, prefixing the test path with `skills/site-cli-creator/`: `bun test skills/site-cli-creator/tests/capture.test.ts`. For a folder of tests pass the folder (`bun test skills/site-cli-creator/starter/skill/cli/tests`), not a glob.

| Area | Files | Tests | Typical reports |
|---|---|---|---|
| Capture tool | `tools/capture.ts`, `tools/lib/recorder.ts`, `tools/lib/shape.ts`, `tools/lib/graphql.ts` | `tests/capture.test.ts` (has its own inline page: put red tests there), `tests/shape.test.ts` | a value in a shape file; a call mislabelled (REST vs GraphQL, read vs write); a Capture that never stops; a page broken by an aborted read |
| Drafting | `tools/draft-contract.ts`, `tools/lib/draft.ts`, `tools/lib/zod-source.ts` | `tests/draft.test.ts` | a variable dropped; wrong nullability; a draft that doesn't compile or drifts on `check` |
| Scaffolding | `tools/new.ts`, `tools/add-skill.ts`, `tools/lib/scaffold.ts`, `tools/lib/template.ts`, `tools/lib/manifests.ts`, `tools/lib/requirements.ts` | `tests/scaffold.test.ts` | a missing file, label or manifest field; a requirement not checked |
| Registry and SKILL.md table | `tools/regen.ts`, `tools/lib/regen.ts` | `tests/regen.test.ts` | a non-command file registered; a table row wrong |
| Starter runtime | `starter/skill/cli/src/**` | `starter/skill/cli/tests/` (`browser.test.ts` drives real Chrome) | a wrong exit code or Fingerprint; `check` skipping or writing; login/session; Windows-only failures |
| Starter packaging | `starter/skill/cli/build.ts`, `starter/skill/install.sh`, `starter/plugin/**` (workflows, bump, version checks) | `tests/install.test.ts`, `starter/plugin/tests/` | an install message; a release or `fixed-in` label; version pins out of sync |
| Starter Feedback skill | `starter/feedback/SKILL.md` | `tests/skills-docs.test.ts` | dedup, titles, labels |
| Starter Deploy skill and deploy files | `starter/deploy/**` (the skill and `hosts/*.md`), `starter/skill/Dockerfile`, `starter/skill/.dockerignore` | `tests/skills-docs.test.ts` (the skill, its host guides, the Dockerfile, the CI `docker` job), `tests/e2e.test.ts` (`mcp --http`), the CI `docker` job builds the image | a wrong Railway step or flag; a Dockerfile that does not build; the contract (`/data`, env vars) out of step with the runtime |
| Generator docs | `SKILL.md`, `reference/*.md`, `plugins/site-cli-creator/ARCHITECTURE.md` | `tests/skills-docs.test.ts` (flags in docs match each tool's usage, links resolve) | an instruction that misleads; a missing site pattern |
| Generator feedback skill | `plugins/site-cli-creator/skills/site-cli-creator-feedback/SKILL.md` | `tests/skills-docs.test.ts` | labels, redaction |
| Fixture site | `fixtures/site/**`, `fixtures/expected/**` | `tests/fixture-site.test.ts`, `tests/e2e.test.ts` | a real-site pattern the fixture lacks |
| Generator CI | `.github/workflows/site-cli-creator.yml` (repo root) | `tests/skills-docs.test.ts` ("generator CI workflow"), and the workflow's own run | a smoke target failing |

## Green gate

```sh
cd plugins/site-cli-creator
bun test                                                     # everything, incl. the compiled e2e test; without Chrome the browser tests SKIP
bun x tsc --noEmit -p .                                      # tools, tests, fixtures
bun x tsc --noEmit -p skills/site-cli-creator/starter/skill/cli
actionlint ../../.github/workflows/*.yml skills/site-cli-creator/starter/plugin/.github/workflows/*.yml
shellcheck skills/site-cli-creator/starter/skill/install.sh
```

Installing Bun, Chrome, `actionlint` and `shellcheck`: [setup.md](setup.md).
