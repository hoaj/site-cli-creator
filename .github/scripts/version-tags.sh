#!/usr/bin/env bash
# Prints "v<version> <commit>" for every generator version on <ref>'s first-parent history (main's merges)
# that has no tag yet: the first commit whose .claude-plugin/plugin.json carries that version, so a
# tag never moves when later commits keep the version. upgrade (SPEC §5) reads a plugin's past Starter
# code from these tags. Usage: version-tags.sh [<ref>] (default HEAD), run in the repo.
set -euo pipefail
command -v jq >/dev/null || { echo "version-tags.sh needs jq" >&2; exit 1; }

ref="${1:-HEAD}"
tags="$(git tag -l 'v*')"
seen=""
for commit in $(git rev-list --first-parent --reverse "$ref"); do
  # A commit without the manifest (before it existed) has no version; any other failure stops the script.
  manifest="$(git show "$commit:.claude-plugin/plugin.json" 2>/dev/null)" || continue
  version="$(jq -r '.version // empty' <<<"$manifest")"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  grep -qxF "$version" <<<"$seen" && continue
  seen="$seen"$'\n'"$version"
  grep -qxF "v$version" <<<"$tags" || echo "v$version $commit"
done
