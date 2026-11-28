#!/usr/bin/env bash
# Prints "v<version> <commit>" for every generator version on <ref>'s first-parent history (main's merges)
# that has no tag yet: the first commit whose .claude-plugin/plugin.json carries that version, so a
# tag never moves when later commits keep the version. upgrade (SPEC §5) reads a plugin's past Starter
# code from these tags. Usage: version-tags.sh [<ref>] (default HEAD), run in the repo.
set -euo pipefail
command -v jq >/dev/null || { echo "version-tags.sh needs jq" >&2; exit 1; }

ref="${1:-HEAD}"
# The tags GitHub has, not a long-lived checkout's local ones; a repo with no origin (the test) uses its own.
if git remote get-url origin >/dev/null 2>&1; then
  tags="$(git ls-remote --tags --refs origin 'v*' | sed 's|.*refs/tags/||')"
else
  tags="$(git tag -l 'v*')"
fi
seen=""
# A bad ref must stop the script: inside a `for` list, rev-list's failure would read as "all tagged".
commits="$(git rev-list --first-parent --reverse "$ref")"
for commit in $commits; do
  # A commit without the manifest (before it existed) has no version. ls-tree prints nothing then and
  # exits 0; any other git failure stops the script.
  [[ -n "$(git ls-tree --name-only "$commit" -- .claude-plugin/plugin.json)" ]] || continue
  manifest="$(git show "$commit:.claude-plugin/plugin.json")"
  # A manifest that does not parse has no version either, so one bad commit can't stop every later run (#175).
  version="$(jq -r '.version // empty' <<<"$manifest" 2>/dev/null)" || continue
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  grep -qxF "$version" <<<"$seen" && continue
  seen="$seen"$'\n'"$version"
  grep -qxF "v$version" <<<"$tags" || echo "v$version $commit"
done
