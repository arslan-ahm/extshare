#!/bin/sh
# Installs extshare from https://extshare.vercel.app (macOS, Linux, and Git Bash on Windows).
#
#   curl -fsSL https://extshare.vercel.app/install.sh | sh              # the CLI: extshare
#   curl -fsSL https://extshare.vercel.app/install.sh | sh -s -- server  # the server: extshare-server
#
# extshare runs on Bun (https://bun.sh). If Bun 1.3 or newer is not installed, this script installs it
# with Bun's official installer first.
#
# Environment:
#   EXTSHARE_HOME           install location (default: $HOME/.extshare; commands go in its bin folder)
#   EXTSHARE_BUN            path of the bun executable to use
#   EXTSHARE_NO_BUN_INSTALL set to 1 to fail instead of installing Bun
#   EXTSHARE_DOWNLOAD_BASE  download URL override (used by tests and mirrors)
#
# Downloads are checked against SHA256SUMS before anything is installed.
# Everything runs inside main() so a partially downloaded script does nothing.

set -eu

fail() {
  echo "extshare install: $*" >&2
  exit 1
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum or shasum is required to verify the download"
  fi
}

# Prints the path of a Bun 1.3+ executable, installing Bun if needed. Messages go to stderr.
find_bun() {
  bun=""
  if [ -n "${EXTSHARE_BUN:-}" ]; then
    bun="$EXTSHARE_BUN"
  elif command -v bun >/dev/null 2>&1; then
    bun="$(command -v bun)"
  elif [ -x "$HOME/.bun/bin/bun" ]; then
    bun="$HOME/.bun/bin/bun"
  elif [ -x "$HOME/.bun/bin/bun.exe" ]; then
    bun="$HOME/.bun/bin/bun.exe"
  elif [ "${EXTSHARE_NO_BUN_INSTALL:-}" = 1 ]; then
    fail "Bun 1.3 or newer is required. Install it from https://bun.sh and run this again."
  else
    echo "extshare runs on Bun, which is not installed. Installing it from https://bun.sh ..." >&2
    curl -fsSL https://bun.sh/install | bash >&2 || fail "installing Bun failed; install it from https://bun.sh and run this again"
    bun="$HOME/.bun/bin/bun"
    [ -x "$bun" ] || bun="$HOME/.bun/bin/bun.exe"
  fi
  [ -x "$bun" ] || fail "bun not found at $bun"
  v="$("$bun" --version 2>/dev/null)" || fail "$bun does not run"
  major="${v%%.*}"
  rest="${v#*.}"
  minor="${rest%%.*}"
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 3 ]; }; then
    fail "Bun $v is too old; extshare needs 1.3 or newer. Run: bun upgrade"
  fi
  echo "$bun"
}

main() {
  component="${1:-${EXTSHARE_COMPONENT:-cli}}"
  case "$component" in
    cli) tool=extshare ;;
    server) tool=extshare-server ;;
    *) fail "unknown component '$component'. Use: sh -s -- cli (default) or sh -s -- server" ;;
  esac
  file="$tool.js"
  base="${EXTSHARE_DOWNLOAD_BASE:-https://extshare.vercel.app/download}"
  home="${EXTSHARE_HOME:-$HOME/.extshare}"

  bun="$(find_bun)"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading $file..."
  download "$base/$file" "$tmp/$file" || fail "could not download $base/$file"
  download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"
  expected="$(awk -v a="$file" '$2 == a || $2 == "*" a { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $file"
  actual="$(sha256 "$tmp/$file")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $file (expected $expected, got $actual). Nothing was installed."

  version="$("$bun" "$tmp/$file" --version 2>/dev/null)" || fail "the downloaded $file does not run with $bun"

  mkdir -p "$home/lib" "$home/bin"
  mv -f "$tmp/$file" "$home/lib/$file"
  launcher="$home/bin/$tool"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$bun" "$home/lib/$file" >"$launcher"
  chmod 755 "$launcher"
  echo "Installed $version: $launcher"

  case ":$PATH:" in
    *":$home/bin:"*) ;;
    *)
      echo
      echo "Add it to your PATH, for example in ~/.profile, ~/.bashrc or ~/.zshrc:"
      echo "  export PATH=\"$home/bin:\$PATH\""
      ;;
  esac
}

main "$@"
