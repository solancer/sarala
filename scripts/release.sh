#!/usr/bin/env bash
#
# Cut a release. Bumps the version across all manifests, commits, tags it, and
# (optionally) pushes — the tag push triggers .github/workflows/release.yml,
# which builds + signs on every OS, publishes the GitHub Release, and updates
# the updater gist's latest.json.
#
# Usage:
#   pnpm release X.Y.Z          # bump, commit, tag (then push when ready)
#   pnpm release X.Y.Z --push   # also push main + the tag immediately
#
set -euo pipefail

VERSION="${1:-}"
PUSH="${2:-}"

if [ -z "$VERSION" ]; then
  echo "usage: pnpm release <X.Y.Z> [--push]" >&2
  exit 1
fi
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: version must be semver MAJOR.MINOR.PATCH (got: $VERSION)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty — commit or stash first" >&2
  exit 1
fi

TAG="v$VERSION"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists" >&2
  exit 1
fi

echo "Bumping version to $VERSION…"

# package.json + tauri.conf.json (both 2-space JSON).
node -e "const f='package.json';const j=require('./'+f);j.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
node -e "const f='src-tauri/tauri.conf.json';const j=require('./'+f);j.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"

# Cargo.toml: only the first line-anchored `version = "..."` (the [package] one;
# dependency versions are inline like `tauri = { version = "2" }`).
perl -i -pe 'if (!$done && s/^version = "[^"]*"/version = "'"$VERSION"'"/) { $done = 1 }' src-tauri/Cargo.toml

# Keep Cargo.lock's own package entry in sync (no-op offline; build fixes it).
( cd src-tauri && cargo update -p sarala >/dev/null 2>&1 || true )

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release $TAG"
git tag -a "$TAG" -m "Sarala $TAG"

if [ "$PUSH" = "--push" ]; then
  echo "Pushing main and $TAG…"
  git push origin HEAD "$TAG"
  echo "Done. Watch the build: https://github.com/solancer/sarala/actions"
else
  echo
  echo "Committed and tagged $TAG. Push to trigger the release workflow:"
  echo "  git push origin HEAD $TAG"
fi
