# Flatpak / Flathub packaging

This directory holds everything needed to build Sarala as a Flatpak and submit it
to [Flathub](https://flathub.org). The app ID is **`io.github.solancer.Sarala`**
(the `io.github.<user>` fallback for GitHub-hosted apps, which needs no domain
verification).

## Files

| File | Purpose |
| --- | --- |
| `io.github.solancer.Sarala.yml` | The Flatpak manifest (build recipe). |
| `io.github.solancer.Sarala.metainfo.xml` | AppStream metadata shown on the Flathub website. |
| `io.github.solancer.Sarala.desktop` | Desktop entry (menu launcher, MIME types). |
| `gen-sources.sh` | Regenerates the offline dependency lists below. |
| `cargo-sources.json` | Vendored Rust crates (generated). |
| `package-lock.json` | npm lockfile derived from `package.json` (generated). |
| `node-sources.json` | Vendored npm tarballs (generated). |

The three generated files are **not** hand-edited. Flathub builders have no
network access, so every dependency is pre-fetched into these source lists.

> **Why npm here when the app uses pnpm?** `npm` ships inside the Flatpak node
> SDK extension and vendors cleanly offline, while pnpm's CLI cannot be fetched
> during a network-less build. Vite (the frontend bundler) is package-manager
> agnostic, so building with npm produces the same `dist/` as the pnpm dev build.
> Day-to-day development and the Snap build still use pnpm — this is Flatpak-only.

## Regenerating dependency sources

Run this whenever `src-tauri/Cargo.lock` or the frontend deps in `package.json`
change (needs `python3`, `npm`, and network — a throwaway venv is created under
`flatpak/.venv`):

```bash
./flatpak/gen-sources.sh
git add flatpak/cargo-sources.json flatpak/package-lock.json flatpak/node-sources.json
```

## Building & linting locally

Install the toolchain (once):

```bash
flatpak install -y flathub org.flatpak.Builder \
  org.gnome.Platform//48 org.gnome.Sdk//48 \
  org.freedesktop.Sdk.Extension.rust-stable//24.08 \
  org.freedesktop.Sdk.Extension.node22//24.08
```

To build against your **local working tree** (fastest iteration), edit the app
source in the manifest to:

```yaml
    sources:
      - type: dir
        path: ..
```

Then build and run:

```bash
flatpak run org.flatpak.Builder --force-clean --user --install \
  build-dir flatpak/io.github.solancer.Sarala.yml
flatpak run io.github.solancer.Sarala
```

Run the Flathub linter (must pass before submitting):

```bash
flatpak run --command=flatpak-builder-lint org.flatpak.Builder \
  manifest flatpak/io.github.solancer.Sarala.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder \
  appstream flatpak/io.github.solancer.Sarala.metainfo.xml
```

## Submitting to Flathub

> **Status:** submitted — [flathub/flathub#9267](https://github.com/flathub/flathub/pull/9267).
> Iterate by pushing to the `io.github.solancer.Sarala` branch on the `solancer/flathub` fork.

Flathub builds from a **fixed** commit, so the manifest's app source must point at
a published tag/commit that already contains this `flatpak/` directory.

1. Commit the `flatpak/` files and cut a release (e.g. `pnpm release 0.4.3`). Then
   set the manifest's `tag:` (and pin the `commit:` sha) to that release.
2. Fork [`flathub/flathub`](https://github.com/flathub/flathub) and create a
   branch **off the `new-pr` branch** (not `master`).
3. Copy the manifest and generated sources into the fork. A single-manifest
   submission expects the app-ID-named manifest plus its `*-sources.json` files.
4. Verify `flatpak-builder-lint` passes, then open a PR titled
   **`Add io.github.solancer.Sarala`** against the `new-pr` branch.
5. The Flathub bot builds the PR; address any review feedback. Once merged, a
   dedicated `flathub/io.github.solancer.Sarala` repo is created — future updates
   (new versions, regenerated sources) go there.

Reference: <https://docs.flathub.org/docs/for-app-authors/submission>

## Notes / follow-ups

- **Auto-updater:** disabled for the Flatpak build. The manifest sets
  `SARALA_FLATPAK=1`, which Vite bakes in (`__SARALA_FLATPAK__`); `updater.ts`
  then skips the startup check and points the manual "Check for Updates…" entry
  at the software center. Flathub delivers updates.
- **Screenshot URL:** the metainfo points at
  `raw.githubusercontent.com/solancer/sarala/main/docs/screenshot.png`. Reviewers
  may prefer a commit-pinned URL for stability.
