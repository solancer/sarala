#!/usr/bin/env bash
# Point the AUR package at a published release: sets pkgver, resets pkgrel and
# fills in the .deb's checksum. Then regenerate .SRCINFO and push (aur/README.md).
#   aur/update.sh 1.3.1
set -euo pipefail
version="${1:?usage: aur/update.sh X.Y.Z}"
pkgbuild="$(dirname "$0")/sarala-bin/PKGBUILD"
url="https://github.com/solancer/sarala/releases/download/v$version/Sarala_${version}_amd64.deb"
sha="$(curl -fsSL "$url" | shasum -a 256 | cut -d' ' -f1)"
sed -i.bak -E \
  -e "s/^pkgver=.*/pkgver=$version/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('$sha')/" \
  "$pkgbuild"
rm -f "$pkgbuild.bak"
echo "sarala-bin $version: $sha"
