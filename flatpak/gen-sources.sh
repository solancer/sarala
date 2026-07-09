#!/usr/bin/env bash
#
# Regenerate the vendored dependency source lists that let Sarala build offline
# on Flathub's network-less builders. Run this whenever src-tauri/Cargo.lock or
# the frontend dependencies in package.json change, then commit the outputs:
#
#   flatpak/cargo-sources.json   crates from src-tauri/Cargo.lock
#   flatpak/package-lock.json    an npm lockfile derived from package.json
#   flatpak/node-sources.json    npm tarballs from that lockfile
#
# Requirements: python3 with the venv/ensurepip module (Debian/Ubuntu:
# `apt install python3-venv`), npm, and network access (this step downloads; the
# actual Flatpak build does not). A throwaway venv is created under flatpak/.venv.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VENV="$HERE/.venv"
FBT_REF="master"  # flatpak-builder-tools pin; bump deliberately.

echo "==> Setting up generator toolchain in $VENV"
if ! python3 -m venv "$VENV" 2>/dev/null; then
  echo "error: 'python3 -m venv' failed. Install the venv module first," >&2
  echo "       e.g. on Debian/Ubuntu:  sudo apt install python3-venv" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --quiet --upgrade pip
# Cargo generator deps + the node generator (installed straight from the repo).
pip install --quiet aiohttp toml \
  "git+https://github.com/flatpak/flatpak-builder-tools.git@${FBT_REF}#subdirectory=node"

echo "==> Fetching flatpak-cargo-generator.py ($FBT_REF)"
CARGO_GEN="$HERE/.venv/flatpak-cargo-generator.py"
curl -fsSL -o "$CARGO_GEN" \
  "https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/${FBT_REF}/cargo/flatpak-cargo-generator.py"

echo "==> Generating cargo-sources.json from Cargo.lock"
python3 "$CARGO_GEN" "$ROOT/src-tauri/Cargo.lock" -o "$HERE/cargo-sources.json"

echo "==> Deriving an npm lockfile from package.json"
# npm requires node_modules to be ABSENT when the lockfile is generated, so do it
# in a scratch dir holding only the package manifest.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$ROOT/package.json" "$TMP/package.json"
( cd "$TMP" && npm install --package-lock-only --ignore-scripts >/dev/null )
cp "$TMP/package-lock.json" "$HERE/package-lock.json"

echo "==> Generating node-sources.json from the npm lockfile"
flatpak-node-generator npm "$HERE/package-lock.json" -o "$HERE/node-sources.json"

deactivate
echo
echo "Done. Generated:"
echo "  flatpak/cargo-sources.json"
echo "  flatpak/package-lock.json"
echo "  flatpak/node-sources.json"
echo "Review and commit these before opening/refreshing the Flathub PR."
