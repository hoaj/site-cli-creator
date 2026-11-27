#!/usr/bin/env bash
# Prints "v<version> <commit>" for every generator version on <ref>'s first-parent history (main's merges)
# that has no tag yet: the first commit whose .claude-plugin/plugin.json carries that version, so a
# tag never moves when later commits keep the version. upgrade (SPEC §5) reads a plugin's past Starter
# code from these tags. Usage: version-tags.sh [<ref>] (default HEAD), run in the repo.
set -euo pipefail

ref="${1:-HEAD}"
tags="$(git tag -l 'v*')"
seen=""
for commit in $(git rev-list --first-parent --reverse "$ref"); do
  version="$(git show "$commit:.claude-plugin/plugin.json" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  grep -qxF "$version" <<<"$seen" && continue
  seen="$seen"$'\n'"$version"
  grep -qxF "v$version" <<<"$tags" || echo "v$version $commit"
done
