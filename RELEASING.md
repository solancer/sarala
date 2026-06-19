# Releasing Sarala

Sarala ships an opt-in auto-updater (**Help ▸ Check for Updates…**). It pulls a
JSON manifest from a GitHub Gist, compares the version against the running build,
and — if newer — downloads the signed artifact from a GitHub Release, verifies
its minisign signature, installs it, and restarts the app.

- Updater config lives in `src-tauri/tauri.conf.json` under `plugins.updater`
  (`pubkey` + `endpoints`).
- Update artifacts are produced by `bundle.createUpdaterArtifacts: true`.
- The frontend flow is `src/updater.ts`; relaunch is the Rust `relaunch` command
  (`app.restart()`) in `src-tauri/src/main.rs`.

## One-time setup

### 1. Generate the signing keypair

Updater artifacts must be signed; signing **cannot** be disabled in Tauri v2.
This minisign key is **separate** from Apple/Windows code-signing.

```sh
pnpm tauri signer generate -w ~/.tauri/sarala.key
```

This prints a **public key** and writes the password-protected **private key** to
`~/.tauri/sarala.key`.

- Paste the public key into `src-tauri/tauri.conf.json` →
  `plugins.updater.pubkey` (replace `REPLACE_WITH_MINISIGN_PUBLIC_KEY`).
- **Never commit the private key or its password.** Keep them in `~/.tauri/` and
  in GitHub Actions secrets.

### 2. The manifest gist (already configured)

The updater endpoint in `tauri.conf.json` points at this gist:

```
https://gist.githubusercontent.com/solancer/47a3dee0bace9ff5134878f55d887157/raw/latest.json
```

The `/raw/` form **without** a revision hash always serves the latest revision —
don't pin a revision in the endpoint, or the app will be stuck on one manifest.
CI rewrites this gist's `latest.json` on every release (see below).

### 3. GitHub Actions secrets

The release workflow (`.github/workflows/release.yml`) needs three repo secrets
(Settings ▸ Secrets and variables ▸ Actions):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/sarala.key` (the minisign private key). |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you set when generating it. |
| `GIST_TOKEN` | A GitHub PAT with the **`gist`** scope. The default `GITHUB_TOKEN` is repo-scoped and **cannot** edit a user-owned gist. |
| `SNAPCRAFT_STORE_CREDENTIALS` | A Snap Store login token (see [Snap publishing](#snap-publishing-snapcraftio)). Only needed if you publish the snap. |

> Building locally instead? Export the two `TAURI_SIGNING_*` values in your shell
> before `pnpm tauri build` (see the manual fallback at the bottom).

### 4. Snap publishing (snapcraft.io)

The snap is built and pushed by a **separate** workflow,
`.github/workflows/snap.yml`, on the same `vX.Y.Z` tag. The manifest lives at
`snap/snapcraft.yaml` (a `core22`, strictly-confined build that compiles the app
and unpacks Tauri's `.deb` into the snap). One-time setup:

1. **Register the name** once (the snap name must be globally unique):

   ```sh
   snapcraft register sarala
   ```

2. **Export a store token** and save it as the `SNAPCRAFT_STORE_CREDENTIALS`
   repo secret. Scope it to just this snap so a leak can't touch your account:

   ```sh
   snapcraft export-login --snaps sarala \
     --acls package_access,package_push,package_release -
   ```

   Paste the printed token into Settings ▸ Secrets and variables ▸ Actions.

After that, pushing a `vX.Y.Z` tag builds the snap and releases it to the
**stable** channel. To push to another channel for testing, run the **Snap**
workflow manually (Actions ▸ Snap ▸ Run workflow) and set the `channel` input
(e.g. `edge` or `beta`). The build also uploads the `.snap` as a workflow
artifact, so you can grab and `snap install --dangerous` it without publishing.

> **Auto-updater note:** a snap is a read-only image that the Snap Store keeps
> updated, so Tauri's in-app updater can't (and shouldn't) replace the binary
> there. The **Check for Updates…** action will simply fail to install inside the
> snap — that's expected; `snap refresh` is the update path for this package.

## Cutting a release (automated)

1. **Bump + tag** with the helper (updates `package.json`,
   `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`, commits, tags):

   ```sh
   pnpm release 0.2.0          # then push when ready
   pnpm release 0.2.0 --push   # or bump, tag, and push in one go
   ```

2. **Pushing the `vX.Y.Z` tag** triggers `.github/workflows/release.yml`, which:
   - builds + signs on macOS (universal), Windows, and Linux;
   - creates the **GitHub Release** `vX.Y.Z` with the installers and updater
     artifacts (`Sarala.app.tar.gz`, `*-setup.exe`, `*.AppImage`, each + `.sig`);
   - generates `latest.json` and **pushes it to the gist** — which is the moment
     existing installs start seeing the update.

3. Watch it at <https://github.com/solancer/sarala/actions>. That's it — no
   manual signature pasting.

The updater compares the manifest `version` against `tauri.conf.json`'s
`version`, so step 1 keeping them in lockstep is what makes the update visible.

## `latest.json` shape

```json
{
  "version": "0.2.0",
  "notes": "What's new in this release.",
  "pub_date": "2026-06-16T10:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of Sarala.app.tar.gz.sig>",
      "url": "https://github.com/solancer/sarala/releases/download/v0.2.0/Sarala.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "<contents of Sarala.app.tar.gz.sig>",
      "url": "https://github.com/solancer/sarala/releases/download/v0.2.0/Sarala.app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "<contents of the .exe.sig>",
      "url": "https://github.com/solancer/sarala/releases/download/v0.2.0/Sarala_0.2.0_x64-setup.exe"
    },
    "linux-x86_64": {
      "signature": "<contents of the .AppImage.sig>",
      "url": "https://github.com/solancer/sarala/releases/download/v0.2.0/sarala_0.2.0_amd64.AppImage"
    }
  }
}
```

Notes:

- A **macOS universal** build is listed under **both** `darwin-aarch64` and
  `darwin-x86_64` pointing at the same `.tar.gz`. If you ship per-arch builds
  instead, point each key at its own artifact.
- `signature` is the **contents** of the `.sig` file (a base64 blob), not a path
  or URL.

## Code-signing caveat (macOS)

The minisign signature above is **not** Apple code-signing. On macOS, Gatekeeper
blocks an unsigned/un-notarized auto-update the same way it blocks a first
install. For a real public release you need **both**:

1. The updater's minisign signature (above), and
2. An Apple Developer ID **codesigned + notarized** `.app`.

Until the Apple Developer account is set up, auto-updates will install but
Gatekeeper may refuse to launch the replaced app on other machines. Windows has
an analogous (softer) SmartScreen story; an Authenticode cert removes the
warning.

## Manual fallback (build locally, no CI)

If you ever need to release without the workflow:

1. Export the signing env vars:

   ```sh
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/sarala.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<the password you set>"
   ```

2. `pnpm tauri build` **on each OS** (no single host builds all three). Each emits
   the artifact plus a sibling `.sig`:
   - **macOS** — `Sarala.app.tar.gz` + `.sig`
   - **Windows** — `Sarala_<ver>_x64-setup.exe` + `.sig`
   - **Linux** — `sarala_<ver>_amd64.AppImage` + `.sig`

3. Create a GitHub Release tagged `v<version>` and upload the artifacts.

4. Hand-edit the gist's `latest.json` (shape above): bump `version`, set
   `pub_date`, paste each `.sig`'s **contents** into `signature`, and point each
   `url` at the Release download link.
