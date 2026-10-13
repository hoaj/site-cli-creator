# Bumping the generator

Pick the versions first. The generator's: above `main`'s and above every open generator PR's (`gh pr list --repo hoaj/skills --state open --search "site-cli-creator in:title" --json number,headRefName`, then `git show origin/<headRefName>:plugins/site-cli-creator/.claude-plugin/plugin.json`). The marketplaces': above `main`'s and above every open PR's in the repo, any plugin's (`gh pr list --repo hoaj/skills --state open` and `git show origin/<branch>:.claude-plugin/marketplace.json`), because all plugins share it. Unlike a generated plugin's CI, the generator's CI checks neither.

## Pins to change

| File | Field |
|---|---|
| `plugins/site-cli-creator/.claude-plugin/plugin.json` | `version` |
| `plugins/site-cli-creator/.cursor-plugin/plugin.json` | `version` |
| `plugins/site-cli-creator/.github/plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.github/plugin/marketplace.json` (repo root) | `metadata.version`: the same kind of step as the generator (patch for a patch, minor for a minor), from the highest of `main` and every open PR |

## Tests that assert them

`plugins/site-cli-creator/skills/site-cli-creator/tests/skills-docs.test.ts` pins the generator's version and the marketplaces' `metadata.version` on purpose: update both expectations in the same commit. Other tests read the generator version through `generatorVersion()`.

## Version strings to leave alone

Change only the pins above, the two expectations in `skills-docs.test.ts`, and `ARCHITECTURE.md`'s `__GENERATOR_VERSION__` example. A `grep -rn '<old version>' plugins/site-cli-creator` finds many more hits; leave every other one alone. Most are a generated plugin's own starting version, which is `0.1.0` whatever the generator's version is (`INITIAL_VERSION` in `tools/lib/manifests.ts`, the Starter's `package.json`, `site.ts` and `<!-- version: 0.1.0 -->` SKILL.md comments, `reference/new.md`, the generator's SKILL.md, scaffold and fixture tests), and the rest are test data (`starter/plugin/tests/*`).
