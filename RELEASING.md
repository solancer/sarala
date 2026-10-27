# Releasing Sarala

Sarala ships an opt-in auto-updater (**Help ▸ Check for Updates…**). It pulls a
JSON manifest from a GitHub Gist, compares the version against the running build,
and, if newer, downloads the signed artifact from a GitHub Release, verifies
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

The `/raw/` form **without** a revision hash always serves the latest revision, so
don't pin a revision in the endpoint, or the app will be stuck on one manifest.
CI rewrites this gist's `latest.json` on every release (see below).

### 3. GitHub Actions secrets

The release workflow (`.github/workflows/release.yml`) needs these repo secrets
(Settings ▸ Secrets and variables ▸ Actions):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/sarala.key` (the minisign private key). |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you set when generating it. |
| `GIST_TOKEN` | A GitHub PAT with the **`gist`** scope. The default `GITHUB_TOKEN` is repo-scoped and **cannot** edit a user-owned gist. |
| `APPLE_CERTIFICATE` | The Developer ID Application certificate and its private key, exported from Keychain as `.p12`, base64 encoded. |
| `APPLE_CERTIFICATE_PASSWORD` | The `.p12` export password. |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Lenzo International Private Limited (6WUKC69WYX)` |
| `APPLE_TEAM_ID` | `6WUKC69WYX` |
| `APPLE_ID` | An Apple ID on that team, for notarization. |
| `APPLE_PASSWORD` | An app-specific password for that Apple ID (account.apple.com ▸ Sign-In and Security). |

> Building locally instead? Export the two `TAURI_SIGNING_*` values in your shell
> before `pnpm tauri build` (see the manual fallback at the bottom).

### 4. Snap publishing (snapcraft.io)

The snap is **not** built in GitHub Actions. It's built by the **Snap Store
build service**, which is connected to this repo and builds `snap/snapcraft.yaml`
(a `core22`, strictly-confined build that compiles the app and unpacks Tauri's
`.deb` into the snap) natively on **amd64** and **arm64**. One-time setup:

1. **Register the name** once (the snap name must be globally unique):

   ```sh
   snapcraft register sarala
   ```

2. **Connect the repo:** at <https://snapcraft.io/sarala/builds>, link the GitHub
   repository. From then on every push to `main` triggers a build and uploads the
   resulting revisions to the **edge** channel automatically, with no repo secret or
   workflow required (which is why there's no `snap.yml`).

3. **Promote to stable** from the snap's **Releases** page once a revision looks
   good (or `snapcraft release sarala <revision> stable`). Edge is your testing
   channel; `snap install sarala --edge` to try a build before promoting.

> **First-revision review:** a brand-new snap's first revision goes through a
> one-time **manual review** by Canonical, and the store won't process newer
> uploads until that clears (you'll see *"Waiting for previous upload(s) to
> complete their review process"*). Clear or prioritize it from
> <https://dashboard.snapcraft.io/>, or ask on
> <https://forum.snapcraft.io/c/store-requests>. After it's approved, later
> revisions publish without manual steps.

#### Security rebuilds

Canonical's security bot scans published snaps daily and emails when a staged
`.deb` has since received a USN, for example *"sarala contains outdated Ubuntu
packages"* naming `gstreamer1.0-plugins-good`.

Nothing in this repo is at fault when that arrives. Those packages are **not**
listed in `snapcraft.yaml`; they come in transitively via `libwebkit2gtk-4.1-0`
and are frozen at whatever the Ubuntu archive held **on the day the revision was
built**. There is no version to bump and no automatic rebuild; the fix is
simply to build again so apt pulls the patched versions:

1. Trigger a build at <https://snapcraft.io/sarala/builds> (**Trigger new build**),
   or push any commit to `main`, since the build service watches the repo.
2. When the new revisions land in **edge**, promote them:

   ```sh
   snapcraft release sarala <revision> stable
   ```

   Both architectures need promoting; the email names one revision per arch
   (e.g. r17 amd64, r18 arm64).

Because the packages are pinned at build time, a snap that goes unreleased for a
while will drift again. Rebuilding every month or two, or whenever one of these
emails lands, keeps the published revision current without needing an app
release.

> **Auto-updater note:** a snap is a read-only image that the Snap Store keeps
> updated, so Tauri's in-app updater can't (and shouldn't) replace the binary
> there. The **Check for Updates…** action will simply fail to install inside the
> snap, and that's expected; `snap refresh` is the update path for this package.

### 5. Homebrew cask (macOS)

`Casks/sarala.rb` is a Homebrew cask served straight from this repo, so Mac users
can install without an Apple Developer account or notarization:

```sh
brew tap solancer/sarala https://github.com/solancer/sarala
brew trust --cask solancer/sarala/sarala
brew install --cask --yes sarala
```

Two Homebrew 6 behaviours are baked into that snippet, so keep it in sync with
the README's copy:

- **`brew trust`** is required: Homebrew 6 refuses to load casks from
  third-party taps until they're trusted, otherwise users hit *"Refusing to load
  cask solancer/sarala/sarala from untrusted tap"*. (`brew trust
  solancer/sarala` trusts the whole tap instead of just this cask.)
- **`--yes`** skips the new confirmation prompt. Ask mode is the default in
  Homebrew 6, so a bare `brew install --cask sarala` prints `Would install 1
  cask:` and waits for input, which reads as a hang when an unrelated tap-trust
  warning scrolls the prompt off screen.

The universal `.dmg` is **ad-hoc signed** by Tauri's build (verified:
`codesign` reports `flags=...(adhoc,linker-signed)`), which is enough to run on
Apple Silicon. It is **not** Apple-notarized, so the cask's `postflight` strips
`com.apple.quarantine` after install, and that attribute is what makes Gatekeeper
demand notarization on first launch, so removing it lets the ad-hoc-signed app
open with no extra flags. This is deliberately disallowed by the official
`homebrew/cask` repo (which mandates notarization), but fine for our self-hosted
tap. Users who'd rather keep quarantine can install with `--quarantine`.

No setup needed: the `update-cask` job in `release.yml` bumps the cask's
`version` + `sha256` to the new `.dmg` and commits it to `main` on every release.
If `main` is ever branch-protected, that push needs a PAT with `contents:write`
instead of the default `GITHUB_TOKEN`.

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
   - generates `latest.json` and **pushes it to the gist**, which is the moment
     existing installs start seeing the update.

3. Watch it at <https://github.com/solancer/sarala/actions>. That's it, with no
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

## Code signing (macOS)

The minisign signature above only lets the updater trust a download. Gatekeeper
needs the app itself signed with a Developer ID and notarized by Apple, which
the macOS build does with the `APPLE_*` secrets. Local `pnpm tauri build`s stay
ad-hoc signed (`"signingIdentity": "-"` in `tauri.conf.json`); the
`APPLE_SIGNING_IDENTITY` variable overrides it in CI.

To test the Apple secrets without releasing, run the **macOS signing check**
workflow (Actions tab, or it runs on PRs that touch the signing setup). It
builds a signed, notarized app and checks it with `codesign`, `spctl` and
`stapler`.

The certificate expires on **26 November 2027**. Before then, the Account Holder
creates a new Developer ID Application certificate from a fresh signing request
(Keychain Access ▸ Certificate Assistant ▸ Request a Certificate From a
Certificate Authority), and the new `.p12` replaces `APPLE_CERTIFICATE` and
`APPLE_CERTIFICATE_PASSWORD`. Apps already shipped keep working after it
expires. On a Mac without Xcode, `security find-identity -v -p codesigning`
only lists the certificate once Apple's
[Developer ID G2 intermediate](https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer)
is in the keychain.

## Manual fallback (build locally, no CI)

If you ever need to release without the workflow:

1. Export the signing env vars:

   ```sh
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/sarala.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<the password you set>"
   ```

2. `pnpm tauri build` **on each OS** (no single host builds all three). Each emits
   the artifact plus a sibling `.sig`:
   - **macOS**: `Sarala.app.tar.gz` + `.sig`
   - **Windows**: `Sarala_<ver>_x64-setup.exe` + `.sig`
   - **Linux**: `sarala_<ver>_amd64.AppImage` + `.sig`

3. Create a GitHub Release tagged `v<version>` and upload the artifacts.

4. Hand-edit the gist's `latest.json` (shape above): bump `version`, set
   `pub_date`, paste each `.sig`'s **contents** into `signature`, and point each
   `url` at the Release download link.
