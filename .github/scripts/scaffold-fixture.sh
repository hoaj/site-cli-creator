#!/usr/bin/env bash
# Scaffolds the fixture plugin with the generator's own tools, the way `new` and `add-skill` do,
# fills in the fixture's agent-written files, installs its CLI and regenerates its SKILL.md.
# The smoke and docker jobs of site-cli-creator.yml both build on this.
# Usage: scaffold-fixture.sh <plugin-dir>   (needs SKILL_DIR, relative to the repo root, in the env)
set -euo pipefail

plugin="${1:?usage: scaffold-fixture.sh <plugin-dir>}"
skill_dir="${SKILL_DIR:?SKILL_DIR must name the generator skill folder}"
workspace="${GITHUB_WORKSPACE:-$PWD}"
skill="$plugin/skills/fixture"

bun "$skill_dir/tools/new.ts" --dir "$plugin" --plugin smoke --repo hoaj/smoke-plugin \
  --description "Smoke test plugin" --maintainer hoaj --no-labels --skip-checks
bun "$skill_dir/tools/add-skill.ts" --dir "$plugin" --skill fixture \
  --origin http://127.0.0.1:4310 --auth none
# The fixture's agent-written files, with the placeholders add-skill fills.
SRC="$skill/cli/src" WORKSPACE="$workspace" bun -e '
  const { copyExpected } = await import(process.env.WORKSPACE + "/" + process.env.SKILL_DIR + "/fixtures/expected/copy.ts");
  copyExpected("none", process.env.SRC, {
    plugin: "smoke", skill: "fixture", repo: "hoaj/smoke-plugin",
    generatorVersion: "0.1.0", origin: "http://127.0.0.1:4310",
  });'
(cd "$skill/cli" && bun install)
bun "$skill_dir/tools/regen.ts" --skill-dir "$skill"
