#!/usr/bin/env bash
#
# Fetch the bitmap (CBDT) Noto Color Emoji that the Linux AppImage bundles
# (issue #45; see src-tauri/src/appimage_fonts.rs for why). Pinned to a release
# tag and checked by SHA-256. Used by src-tauri/tauri.appimage.conf.json, which
# only the AppImage build passes, so other builds never need this.
#
set -euo pipefail

TAG="v2.051"
BASE="https://raw.githubusercontent.com/googlefonts/noto-emoji/$TAG/fonts"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/linux/fonts"
mkdir -p "$DEST"

fetch() { # <remote name> <local name> <sha256>
  local out="$DEST/$2"
  if [ -f "$out" ] && echo "$3  $out" | shasum -a 256 -c - > /dev/null 2>&1; then
    return
  fi
  curl -sSfL --retry 3 -o "$out.part" "$BASE/$1"
  echo "$3  $out.part" | shasum -a 256 -c - > /dev/null \
    || { echo "checksum mismatch for $1" >&2; rm -f "$out.part"; exit 1; }
  mv "$out.part" "$out"
}

fetch NotoColorEmoji.ttf NotoColorEmoji.ttf 72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b
fetch LICENSE NotoColorEmoji-OFL.txt 6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2
echo "emoji font ready in $DEST"
