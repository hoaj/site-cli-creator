# Contributing

## Layout

- `plugins/site-cli-creator/`: the plugin. The generator skill is in `skills/site-cli-creator/` (tools, Starter code, reference docs, tests, fixture site); the generator's feedback skill is in `skills/site-cli-creator-feedback/`.
- `maintainer-skills/`: skills for changing the generator. They never ship to users and load here through `.claude/skills/`.
- `SPEC.md`, `CONTEXT.md`, `plugins/site-cli-creator/ARCHITECTURE.md`: the spec, glossary and implementation contract. SPEC.md wins when they disagree.
- `.github/workflows/site-cli-creator.yml`: the generator's CI.

## Setup

You need Bun 1.4.3 (the version CI uses), Google Chrome, `actionlint` and `shellcheck`. Without Chrome the browser tests skip.

```sh
cd plugins/site-cli-creator && bun install --frozen-lockfile
```

Step-by-step installs: [setup.md](./maintainer-skills/improve-site-cli-creator/references/setup.md).

## Before you open a PR

Run the green gate from `plugins/site-cli-creator`:

```sh
bun test
bun x tsc --noEmit -p .
bun x tsc --noEmit -p skills/site-cli-creator/starter/skill/cli
actionlint ../../.github/workflows/*.yml skills/site-cli-creator/starter/plugin/.github/workflows/*.yml
shellcheck skills/site-cli-creator/starter/skill/install.sh
```

Every PR that touches `plugins/site-cli-creator` bumps the version. [bump.md](./maintainer-skills/improve-site-cli-creator/references/bump.md) lists the files to change.

## Working with an agent

Agent-driven maintenance uses the `improve-site-cli-creator` maintainer skill in `maintainer-skills/`. It covers triaging issues labelled `site-cli-creator`, which area owns a bug and which tests to extend.

## No real site data

Do not put real site data in the repo, in issues or in PRs: no names, ids, amounts, tokens, cookies or raw traffic. Shapes and type names only.

## Reporting a problem

Use the `site-cli-creator-feedback` skill, or open an issue labelled `site-cli-creator` (the issue forms add it). Security problems go through [SECURITY.md](./SECURITY.md).
