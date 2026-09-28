#!/usr/bin/env bash
# FIXED TEMPLATE FILE (plugin/repo substituted). PROTOTYPE — not run.
# Downloads the release binary matching this plugin's version with the user's gh,
# so private plugin repos work without a token of our own.
set -euo pipefail
PLUGIN=yousee
REPO="<owner>/yousee-plugin"
SKILL_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
VERSION="$(sed -n 's/.*version: \([0-9.]*\).*/\1/p' "$SKILL_DIR/SKILL.md" | head -1)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

command -v gh >/dev/null || { echo "Install GitHub CLI first: https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) T=darwin-arm64 ;; Darwin-x86_64) T=darwin-x64 ;;
  Linux-x86_64) T=linux-x64 ;;    Linux-aarch64) T=linux-arm64 ;;
  MINGW*|MSYS*|CYGWIN*) T=windows-x64.exe ;;
  *) echo "Unsupported platform $(uname -sm)" >&2; exit 1 ;;
esac

# Already on this version? Nothing to do.
if [ -x "$BIN_DIR/$PLUGIN" ] && "$BIN_DIR/$PLUGIN" version 2>/dev/null | grep -q "\"$VERSION\""; then
  echo "$PLUGIN $VERSION already installed"; exit 0
fi

mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
gh release download "v$VERSION" --repo "$REPO" --pattern "$PLUGIN-$T" --dir "$TMP"
install -m 0755 "$TMP/$PLUGIN-$T" "$BIN_DIR/$PLUGIN"
echo "Installed $PLUGIN $VERSION to $BIN_DIR/$PLUGIN"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add to PATH: export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
