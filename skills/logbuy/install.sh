#!/usr/bin/env bash
# Installs this CLI skill's binary as bin/logbuy (bin/logbuy.exe on Windows).
# Run it once, when the binary is missing:  bash install.sh   (Git Bash on Windows)
#
# It stops with a clear message at the first step that fails:
#   1. GitHub CLI (gh) present
#   2. gh logged in
#   3. Google Chrome present, when this skill needs it
#   4. this platform has a release binary
#   5. gh release download v<version> --pattern logbuy-<target>[.exe]
#   6. macOS: strip quarantine, ad-hoc sign if the signature is invalid.
#      Windows: Unblock-File. Both ignore errors.
#
# The version comes from the `<!-- version: X.Y.Z -->` comment in SKILL.md, so the binary
# always matches the SKILL.md next to it. The skill needs Chrome when cli/src/site.ts has the
# line `needsChrome: true` (regen sets it for auth login or any write Operation).
#
# Environment:
#   SITE_CLI_CHROME          Chrome executable to check instead of the fixed per-OS path
#   SITE_CLI_INSTALL_UNAME   replaces `uname -sm`, e.g. "Darwin arm64" (tests only)
set -euo pipefail

SKILL="logbuy"
REPO="hoaj/logbuy-plugin"
OWNER="hoaj"
SUPPORTED="darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64"

SKILL_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

# Prints the first capture group of the first line in $1 matching the regex $2.
first_match() {
  local file="$1" re="$2" line
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ $line =~ $re ]]; then
      printf '%s' "${BASH_REMATCH[1]-}"
      return 0
    fi
  done <"$file"
  return 1
}

needs_chrome() {
  first_match "$SKILL_DIR/cli/src/site.ts" '^[[:space:]]*needsChrome:[[:space:]]*(true)([^[:alnum:]_]|$)' >/dev/null
}

# Sets os ("darwin" | "linux" | "windows" | lower-cased uname) and platform ("<os>-<arch>").
detect_platform() {
  local uname_sm os_name arch
  uname_sm="${SITE_CLI_INSTALL_UNAME:-$(uname -sm)}"
  read -r os_name arch _ <<<"$uname_sm"
  case "$os_name" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT) os=windows ;;
    *) os="$(printf '%s' "$os_name" | tr '[:upper:]' '[:lower:]')" ;;
  esac
  case "$arch" in
    x86_64 | amd64 | x64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
  esac
  platform="$os-$arch"
  # Release binaries link against glibc; musl Linux is not a v1 target.
  if [ "$os" = linux ] && [ -z "${SITE_CLI_INSTALL_UNAME:-}" ] && compgen -G '/lib/ld-musl-*' >/dev/null; then
    platform="$platform-musl"
  fi
}

to_unix_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s' "$1"; fi
}

# Prints the first Chrome path that exists, in the order playwright-core checks them.
find_chrome() {
  local candidate base
  if [ -n "${SITE_CLI_CHROME:-}" ]; then
    [ -x "$SITE_CLI_CHROME" ] && printf '%s' "$SITE_CLI_CHROME"
    return
  fi
  case "$os" in
    darwin) candidate="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ;;
    linux) candidate="/opt/google/chrome/chrome" ;;
    windows)
      for base in "${LOCALAPPDATA:-}" "${PROGRAMFILES:-}" "$(printenv 'ProgramFiles(x86)' || true)" \
        "${HOMEDRIVE:-}\\Program Files" "${HOMEDRIVE:-}\\Program Files (x86)"; do
        case "$base" in "" | '\Program Files' | '\Program Files (x86)') continue ;; esac
        candidate="$(to_unix_path "$base\\Google\\Chrome\\Application\\chrome.exe")"
        [ -f "$candidate" ] && break
      done
      ;;
    *) return ;;
  esac
  [ -n "${candidate:-}" ] && [ -e "$candidate" ] && printf '%s' "$candidate"
}

chrome_hint() {
  case "$os" in
    darwin) printf 'install Google Chrome from https://www.google.com/chrome/ into /Applications' ;;
    linux)
      local deb=amd64
      [ "${platform#linux-}" = arm64 ] && deb=arm64
      printf 'install Google Chrome: curl -fsSLO https://dl.google.com/linux/direct/google-chrome-stable_current_%s.deb && sudo apt-get install -y ./google-chrome-stable_current_%s.deb' "$deb" "$deb"
      ;;
    *) printf 'install Google Chrome from https://www.google.com/chrome/' ;;
  esac
  printf ', or set SITE_CLI_CHROME to its executable'
}

# 1-2. GitHub CLI
command -v gh >/dev/null 2>&1 || die "GitHub CLI (gh) not found: install GitHub CLI (https://cli.github.com) and run \`gh auth login\`"
gh auth status >/dev/null 2>&1 || die "gh is not logged in: run \`gh auth login\`"

detect_platform

# 3. Chrome, only when the skill needs it. An unknown OS fails at step 4 instead.
case "$os" in
  darwin | linux | windows)
    if needs_chrome && [ -z "$(find_chrome)" ]; then
      die "$SKILL needs Google Chrome, which was not found: $(chrome_hint)"
    fi
    ;;
esac

# 4. Platform
case " $SUPPORTED " in
  *" $platform "*) ;;
  *) die "unsupported platform: $platform" ;;
esac

ext=""
[ "$os" = windows ] && ext=".exe"
asset="$SKILL-$platform$ext"
target="$SKILL_DIR/bin/$SKILL$ext"

version="$(first_match "$SKILL_DIR/SKILL.md" '^<!-- version: ([0-9]+\.[0-9]+\.[0-9]+) -->')" ||
  die "SKILL.md has no <!-- version: X.Y.Z --> comment"

# 5. Download into a temp dir, so bin/ only ever holds a finished binary.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/dl"
if ! gh release download "v$version" --repo "$REPO" --pattern "$asset" --dir "$tmp/dl" 2>"$tmp/err"; then
  err="$(<"$tmp/err")"
  case "$err" in
    *"not found"* | *"Not Found"* | *404* | *"no assets match"* | *"Could not resolve"*)
      if gh api "repos/$REPO" --silent >/dev/null 2>&1; then
        die "release v$version of $REPO is still being built: try again in a few minutes"
      fi
      die "cannot see $REPO: ask $OWNER for access to $REPO"
      ;;
  esac
  die "gh release download v$version failed: $err"
fi
binary="$tmp/dl/$asset"
[ -f "$binary" ] || die "gh release download v$version did not produce $asset"
chmod 0755 "$binary"

# 6. Unblock. gh sets no quarantine attribute today, so the xattr step is defensive. Bun's
# cross-compiled darwin binaries can carry an invalid signature, which an ad-hoc one replaces.
case "$os" in
  darwin)
    xattr -d com.apple.quarantine "$binary" >/dev/null 2>&1 || true
    if ! codesign -v "$binary" >/dev/null 2>&1; then
      codesign --force --sign - "$binary" >/dev/null 2>&1 || die "codesign could not sign $asset ad hoc"
    fi
    ;;
  windows)
    win_path="$binary"
    command -v cygpath >/dev/null 2>&1 && win_path="$(cygpath -w "$binary")"
    powershell -NoProfile -Command "Unblock-File -LiteralPath '$win_path'" >/dev/null 2>&1 || true
    ;;
esac

mkdir -p "$SKILL_DIR/bin"
mv -f "$binary" "$target"
printf 'installed %s v%s (%s) as %s\n' "$SKILL" "$version" "$platform" "$target"
