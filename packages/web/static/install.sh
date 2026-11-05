#!/bin/sh
# Installs the extshare CLI from GitHub Releases.
#
#   curl -fsSL https://extshare.vercel.app/install.sh | sh
#
# Environment:
#   EXTSHARE_VERSION       release tag to install, e.g. v0.1.0 (default: latest)
#   EXTSHARE_INSTALL_DIR   where to put the binary (default: $HOME/.extshare/bin)
#   EXTSHARE_DOWNLOAD_BASE override the download URL (used by tests and mirrors)
#
# The binary is checked against the release's SHA256SUMS before it is installed.
# Everything runs inside main() so a partially downloaded script does nothing.

set -eu

REPO="arslan-ahm/extshare"

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

main() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN*) os=windows ;;
    *) fail "unsupported system $(uname -s). Download a binary from https://github.com/$REPO/releases" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported CPU $(uname -m). Download a binary from https://github.com/$REPO/releases" ;;
  esac

  asset="extshare-$os-$arch"
  name="extshare"
  if [ "$os" = windows ]; then
    # Windows on ARM runs the x64 build through emulation.
    asset="extshare-windows-x64.exe"
    name="extshare.exe"
  fi

  version="${EXTSHARE_VERSION:-latest}"
  if [ -n "${EXTSHARE_DOWNLOAD_BASE:-}" ]; then
    base="$EXTSHARE_DOWNLOAD_BASE"
  elif [ "$version" = latest ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/$version"
  fi
  dir="${EXTSHARE_INSTALL_DIR:-$HOME/.extshare/bin}"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading $asset ($version)..."
  download "$base/$asset" "$tmp/$asset" || fail "could not download $base/$asset"
  download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

  expected="$(awk -v a="$asset" '$2 == a || $2 == "*" a { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
  actual="$(sha256 "$tmp/$asset")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed."

  chmod 755 "$tmp/$asset"
  installed="$("$tmp/$asset" --version 2>/dev/null)" || fail "the downloaded binary does not run on this machine"

  mkdir -p "$dir"
  mv -f "$tmp/$asset" "$dir/$name"
  echo "Installed $installed to $dir/$name"

  case ":$PATH:" in
    *":$dir:"*) ;;
    *)
      echo
      echo "Add extshare to your PATH, for example in ~/.profile or ~/.zshrc:"
      echo "  export PATH=\"$dir:\$PATH\""
      ;;
  esac
}

main "$@"
