# Bumping the generator

Pick the version first: above `main`'s and above every open generator PR's (`gh pr list --repo hoaj/site-cli-creator --state open --search "site-cli-creator in:title" --json number,headRefName`, then `git show origin/<headRefName>:plugins/site-cli-creator/.claude-plugin/plugin.json`). Unlike a generated plugin's CI, the generator's CI does not check it.

Users install the generator from the `hoaj` marketplace in `hoaj/plugins`, whose entry points at this repo's `plugins/site-cli-creator` on `main`. Claude Code caches a plugin by its `version`, so the bump below is what makes users pick up a change; the marketplace needs no edit.

## Pins to change

| File | Field |
|---|---|
| `plugins/site-cli-creator/.claude-plugin/plugin.json` | `version` |
| `plugins/site-cli-creator/.cursor-plugin/plugin.json` | `version` |
| `plugins/site-cli-creator/.github/plugin/plugin.json` | `version` |

## Tests that assert them

`plugins/site-cli-creator/skills/site-cli-creator/tests/skills-docs.test.ts` pins the generator's version on purpose: update its expectation in the same commit. Other tests read the generator version through `generatorVersion()`.

## Version strings to leave alone

Change only the pins above, the expectation in `skills-docs.test.ts`, and `ARCHITECTURE.md`'s `__GENERATOR_VERSION__` example. A `grep -rn '<old version>' plugins/site-cli-creator` finds many more hits; leave every other one alone. Most are a generated plugin's own starting version, which is `0.1.0` whatever the generator's version is (`INITIAL_VERSION` in `tools/lib/manifests.ts`, the Starter's `package.json`, `site.ts` and `<!-- version: 0.1.0 -->` SKILL.md comments, `reference/new.md`, the generator's SKILL.md, scaffold and fixture tests), and the rest are test data (`starter/plugin/tests/*`).
