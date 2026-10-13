# Bumping the generator

Pick the version first: above `main`'s and above every open generator PR's (`gh pr list --repo hoaj/skills --state open --search "site-cli-creator in:title"`, then each PR's `.claude-plugin/plugin.json`). Unlike a generated plugin's CI, the generator's CI does not check it.

## Pins to change

| File | Field |
|---|---|
| `plugins/site-cli-creator/.claude-plugin/plugin.json` | `version` |
| `plugins/site-cli-creator/.cursor-plugin/plugin.json` | `version` |
| `plugins/site-cli-creator/.github/plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.github/plugin/marketplace.json` (repo root) | `metadata.version`: the same kind of step as the generator (patch for a patch, minor for a minor), from the highest of `main` and the open PRs |

## Tests that assert them

`plugins/site-cli-creator/skills/site-cli-creator/tests/skills-docs.test.ts` pins the generator's version and the marketplaces' `metadata.version` on purpose: update both expectations in the same commit. Other tests read the generator version through `generatorVersion()`.

## Version strings to leave alone

`grep -rn '<old version>' plugins/site-cli-creator` also finds strings that are not the generator's version. A generated plugin's own starting version is `0.1.0` whatever the generator's version is: `tools/lib/manifests.ts` (`INITIAL_VERSION`), `starter/skill/cli/package.json`, `starter/skill/cli/src/site.ts`, `starter/skill/cli/tests/helpers.ts`, `tests/fixture-site.test.ts`, `fixtures/expected/**`. `starter/plugin/tests/bump.test.ts` uses arbitrary versions as test data. Do change `ARCHITECTURE.md`'s `__GENERATOR_VERSION__` example. Change a hit only when it means the generator's version.
