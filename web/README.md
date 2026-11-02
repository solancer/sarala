# Sarala for the web

The same editor as the desktop app, running entirely in the browser. There is no server: once the files are loaded, nothing about your documents leaves your device.

It shares `src/` with the desktop app, so the editor, the Markdown renderer and exports can't drift apart. Everything specific to the browser lives here and plugs in through one interface, `WebPlatform` in `src/platform.ts`. The dependency only points this way: the desktop bundle contains no web code.

## What's different from the desktop app

| Feature | Desktop | Web |
| --- | --- | --- |
| Editor, themes, diagrams, math, tables, find, command palette | Yes | Yes, identical |
| Where documents live | Folders on disk | **Library** in the browser (IndexedDB), plus real folders in Chrome and Edge |
| Unsaved work | Autosave shadows, recovery prompt | Every tab restored after a reload, with no prompt |
| Images | Files beside the document | The same, stored in the library or the real folder. Paste and drop both work |
| Legacy encodings (Shift_JIS, Big5, ...) | `encoding_rs`, `chardetng` | The same two crates, compiled to WebAssembly |
| Word, EPUB, ODT, RTF, LaTeX export and import | Pandoc, downloaded on demand | `pandoc.wasm`, downloaded on demand. Import also keeps embedded images |
| HTML export | Yes | Yes, with images embedded |
| PDF export | Headless Chromium, writes a file | The browser's print dialog, "Save as PDF" |
| Voice typing | On-device models | On-device models, using WebGPU or WebAssembly. Audio never leaves the browser |
| System fonts | Yes | Chrome and Edge, after a permission prompt |
| Updates | In-app updater | Automatic, through the service worker |
| Offline | Yes | Yes, after the first visit. Installable as an app |
| **AI assistant** | Runs your installed agent CLIs | **Not available.** A web page can't start programs on your computer |
| Always on top, window controls, reveal in Finder, export presets' "run a command" | Yes | Not available |

### Browser support

| | Chrome, Edge | Firefox | Safari |
| --- | --- | --- | --- |
| Editing, library, export, Pandoc, voice | Yes | Yes | Yes |
| Real folders and files on your device | Yes | Opens a copy in the library | Opens a copy in the library |

Browsers keep a few shortcuts for themselves in a tab, such as Ctrl+W and Ctrl+N, so the app doesn't advertise them there. Every command is in the command palette.

## Commands

A browser already has a menu bar, so the web version doesn't draw a second one. The toolbar holds the everyday controls: tabs, save state, Undo and Redo, Search, Live and Source, and Export. **Menu** holds the rest, and the command palette lists everything. Rename a saved document by double-clicking its tab or pressing F2. On a phone the tabs give way to the document name, Menu opens as a full-height sheet, and a formatting bar sits above the keyboard. The commands still come from `src/menudata.ts`; `web/src/components/toolbar.tsx` only chooses which to show.

### Keeping your work safe

Browser storage belongs to one browser on one device, and clearing site data erases it. **Back Up Library** in the Menu downloads everything as a zip of plain files, and **Restore Library** in the command palette or Settings ▸ Storage brings it back, in any browser. Storage shows how much is used and asks the browser to protect it. Safari may clear storage for sites you haven't visited in a while, unless the app is installed to the Dock or Home Screen.

## How it's put together

| File | What it does |
| --- | --- |
| `src/main.ts` | Entry point. Installs the platform before the app's modules load |
| `src/platform.ts` | Implements `WebPlatform` |
| `src/vfs.ts` | The filesystem, as paths: `/Library` (IndexedDB), `/Folders` and `/Files` (File System Access handles), `/Downloads` |
| `src/session.ts` | Snapshots open tabs so a reload changes nothing. One per window, under a Web Lock |
| `src/images.ts` | Workspace images as `blob:` URLs. Rendering is synchronous, so the first render is a placeholder |
| `src/encoding.ts`, `wasm/` | Text decoding. Plain UTF-8 needs no WebAssembly, so `wasm/` is only fetched for other encodings |
| `src/pandoc.ts`, `src/pandoc.worker.ts` | Pandoc in a worker, with its binary kept in Cache Storage |
| `src/voice/` | The voice `Backend`: microphone, a small speech gate, and recognition in a worker |
| `src/sw.js` | The service worker. The build fills in its file list |

The page's Content Security Policy is in `index.html`. Documents share an origin with everything stored here, so it backs up the sanitizer rather than replacing it, and `tests/e2e-web.mjs` checks each one holds without the other.

## Developing

Rust's WebAssembly target is needed once:

```bash
rustup target add wasm32-unknown-unknown
pnpm dev:web          # http://localhost:1421
pnpm build:web        # web/dist, any static host at any path
```

`pnpm dev` at the repository root is a different thing: the desktop frontend in a browser, with mocks.

## Tests

```bash
pnpm test:web                                  # Chrome in depth, then Firefox and WebKit
SPEECH=speech.wav pnpm --filter sarala-web test:voice   # real model, real audio path
```

They run against the production build. The voice test needs network access and a recording, which it plays through Chrome's fake microphone (see the top of `tests/e2e-voice.mjs`). `chrome-headless-shell` crashes on reading a file handle from IndexedDB, so the deep suite needs Chrome installed.

## Deploying

The output of `pnpm build:web` is static and runs under any path. `.github/workflows/web.yml` publishes it to GitHub Pages when run by hand, once Pages is set to deploy from GitHub Actions. The largest single file is 28 MB; Cloudflare Pages' 25 MB limit rules it out unless `public/ort/` moves elsewhere.

Hosting distributes Pandoc (GPL-2.0-or-later) and ONNX Runtime (MIT). Their licences ship in `licenses/`; Pandoc's source is at <https://github.com/jgm/pandoc>.

## Releases

The web app has its own version in `web/package.json`, apart from the desktop app, and its own tags, `web-vX.Y.Z`. To release, add a section to `web/CHANGELOG.md`, then:

```sh
pnpm release:web 0.2.0
git push origin HEAD web-v0.2.0
```

The tag runs `.github/workflows/web-release.yml`, which checks and builds the app, publishes it to GitHub Pages, and creates a GitHub release that is never marked as the repository's latest, because that belongs to the desktop app.
