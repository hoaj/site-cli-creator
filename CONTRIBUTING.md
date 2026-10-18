# Contributing

## Layout

- The repo root is the plugin (manifests in `.claude-plugin/`, `.cursor-plugin/`, `.github/plugin/`). `skills/` is what ships to users: the generator skill is in `skills/site-cli-creator/` (tools, Starter code, reference docs, tests, fixture site); the generator's feedback skill is in `skills/site-cli-creator-feedback/`.
- `.claude/skills/`: skills for changing the generator. Claude Code never loads `.claude/` from an installed plugin, so they never ship to users.
- `SPEC.md`, `CONTEXT.md`, `ARCHITECTURE.md`: the spec, glossary and implementation contract. SPEC.md wins when they disagree.
- `.github/workflows/site-cli-creator.yml`: the generator's CI.

## Setup

You need Bun 1.4.3 (the version CI uses), Google Chrome, `actionlint` and `shellcheck`. Without Chrome the browser tests skip.

```sh
bun install --frozen-lockfile
```

Step-by-step installs: [setup.md](./.claude/skills/improve-site-cli-creator/references/setup.md).

## Before you open a PR

Run the green gate from the repo root:

```sh
bun test
bun x tsc --noEmit -p .
bun x tsc --noEmit -p skills/site-cli-creator/starter/skill/cli
actionlint .github/workflows/*.yml skills/site-cli-creator/starter/plugin/.github/workflows/*.yml
shellcheck skills/site-cli-creator/starter/skill/install.sh
```

Every PR that touches the plugin (`skills/`, the manifests, `package.json`) bumps the version. [bump.md](./.claude/skills/improve-site-cli-creator/references/bump.md) lists the files to change.

## Working with an agent

Agent-driven maintenance uses the `improve-site-cli-creator` maintainer skill in `.claude/skills/`. It covers triaging issues labelled `site-cli-creator`, which area owns a bug and which tests to extend.

## No real site data

Do not put real site data in the repo, in issues or in PRs: no names, ids, amounts, tokens, cookies or raw traffic. Shapes and type names only.

## Reporting a problem

Use the `site-cli-creator-feedback` skill, or open an issue labelled `site-cli-creator` (the issue forms add it). Security problems go through [SECURITY.md](./SECURITY.md).
