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

### 2. Create the manifest gist

Create a public Gist containing a file named `latest.json` (see shape below).
Copy its ID into the `endpoints` URL in `tauri.conf.json` (replace
`REPLACE_WITH_GIST_ID`):

```
https://gist.githubusercontent.com/solancer/<GIST_ID>/raw/latest.json
```

The `/raw/` (no revision hash) form always serves the latest revision.

### 3. Build-time environment variables

Export these wherever you run `pnpm tauri build` (locally or in CI secrets):

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/sarala.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<the password you set>"
```

## Per-release checklist

1. **Bump the version** in both `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (and `package.json` for tidiness). The updater compares
   the manifest `version` against `tauri.conf.json`'s `version`.

2. **Build** on each target OS (the updater bundle differs per platform):

   ```sh
   pnpm tauri build
   ```

   With the signing env vars set, this emits an artifact **and** a `.sig` next to
   it:
   - **macOS** — `Sarala.app.tar.gz` + `Sarala.app.tar.gz.sig`
   - **Windows** — NSIS `Sarala_<ver>_x64-setup.exe` + `.sig`
   - **Linux** — `sarala_<ver>_amd64.AppImage` + `.sig`

   > macOS/Windows builds must be cross-compiled or built on their own OS;
   > there's no single-host build for all three. GitHub Actions matrix is the
   > usual way.

3. **Create a GitHub Release** tagged `v<version>` and upload the artifacts
   (the installable files; the `.sig` contents go into the manifest, not the
   release, though uploading them too is harmless).

4. **Update the gist `latest.json`**: bump `version`, set `pub_date`, paste each
   platform's `.sig` **file contents** into `signature`, and point `url` at the
   GitHub Release download links.

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
