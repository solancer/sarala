<div align="center">

<img src="src-tauri/icons/icon.png" alt="Sarala" width="128" height="128" />

# Sarala

**A seamless WYSIWYG Markdown editor — no preview pane, no split view.**

The editing surface *is* the preview. Every paragraph, heading, list, quote, table and code fence is a live block: click into one and it opens to raw Markdown, click away and it renders in place. One parser, one theme, one window — what you see while writing is exactly what exports.

[![Release](https://github.com/solancer/sarala/actions/workflows/release.yml/badge.svg)](https://github.com/solancer/sarala/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/solancer/sarala?sort=semver)](https://github.com/solancer/sarala/releases/latest)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#run-it)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB.svg?logo=tauri&logoColor=white)](https://tauri.app)
[![SolidJS](https://img.shields.io/badge/SolidJS-2C4F7C.svg?logo=solid&logoColor=white)](https://www.solidjs.com)

<br />

<img src="docs/screenshot.png" alt="Sarala editing a Markdown document — live blocks, outline sidebar, and theme palette" width="900" />

</div>

## Install

**macOS (Homebrew)** — the easiest way to get Sarala on a Mac:

```bash
brew tap solancer/sarala https://github.com/solancer/sarala
brew install --cask sarala
```

> Sarala's universal build is ad-hoc signed (so it runs natively on both Apple Silicon
> and Intel) but isn't Apple-notarized. The cask clears the quarantine attribute on
> install so Gatekeeper won't block the first launch — no extra flags needed. Upgrade
> later with `brew upgrade --cask sarala`.

**Other platforms** — grab an installer from the
[latest release](https://github.com/solancer/sarala/releases/latest): `.dmg` (macOS),
`.exe`/`.msi` (Windows), or `.AppImage`/`.deb`/`.rpm` (Linux). Linux users can also
install the [snap](https://snapcraft.io/sarala).

## Features

- **Live block editing** — type Markdown and the active block styles itself *as you type*: syntax markers stay visible but dimmed (the gray `##` next to a live-styled heading, gray `[ ]( )` around a blue link), and the block fully renders when you press **Enter** or move the caret away
- **Smart Enter** — continues lists (with auto-numbering and unchecked task carry-over), continues blockquotes, ends a list on an empty item, auto-closes a just-opened code fence, and inserts plain newlines inside fences; `Shift+Enter` for a soft break
- Click anywhere in rendered text and the caret lands at that spot in the source (rendered→source position mapping)
- Merge on backspace at block start, arrow-key navigation across blocks, IME-safe (composition events respected)
- **GFM**: tables, task lists (clickable checkboxes), strikethrough, fenced code highlighted by [Shiki](https://shiki.style) (TextMate grammars + VS Code themes; light/dark via CSS variables, self-contained inline styles in export)
- **Math** (KaTeX): inline `$…$` and block `$$…$$`, rendered in inactive blocks and shown as raw source while editing; optional `\(…\)` / `\[…\]` delimiters and a `` ```math `` block (both preference-gated, off by default); a broken formula keeps its last good render with an error rather than blanking
- **Diagrams** (Mermaid): `` ```mermaid `` blocks render every diagram type (flowchart, sequence, gantt, class, state, pie, ER, gitGraph, mindmap, timeline, quadrant, sankey, XY, block, kanban, architecture); invalid syntax shows an inline error and keeps the last good diagram; a `--mermaid-theme` CSS var follows the app's light/dark theme
- **Native menu bar** (File, Edit, Paragraph, Format, View, Themes, Window, Help) — every item dispatches through one frontend command bus shared with the keyboard shortcuts
- **Find & replace** (`Cmd/Ctrl+F`, replace one or all) and **Open Quickly** fuzzy finder (`Shift+Cmd/Ctrl+P`)
- **Sidebar**: file tree (open a folder, browse `.md` files) and live outline (click a heading to jump)
- **Source mode** (`Cmd/Ctrl+/`) as an escape hatch to the full raw document; **Focus** (`F8`) and **Typewriter** (`F9`) modes
- **Paragraph tools**: heading levels, pipe-table editing (insert/rows/columns/alignment), lists and task toggles, quotes, math/code blocks, `[TOC]`, footnotes, GFM alerts
- **Themes**: Paper, Graphite, GitHub, Night, Newsprint, Whitey — pure CSS variables, add your own in `src/styles/app.css`
- **Export**: HTML (with an outline sidebar), real PDF (headless Chromium with configurable page size, margins, and header/footer using `${pageNo}`/`${totalPages}`/`${title}`/`${date}`; falls back to the print dialog), and docx/odt/rtf/epub/LaTeX/MediaWiki/rst/Textile/OPML via [Pandoc](https://pandoc.org) (with sensible flags — docx reference doc, epub TOC/chapters). **Named presets** store a format, output path, after-export action (reveal/open/run a command) and pandoc flags; **Export with Previous** re-runs the last. Per-document YAML keys (`export_filename`, `export_pdf_margin`, …) override settings. Import via Pandoc too
- **Local images**: relative `src` paths resolve against the document's folder (via Tauri's asset protocol) and render inline; inserting an image can copy it into a configurable folder (with a `${filename}` variable), and the per-document `copy-images-to` / `image-root-url` YAML keys override the copy folder and image root
- **Recent files**, settings persisted to disk, smart punctuation, LF/CRLF line endings; **save is atomic** (temp file + rename)
- **Auto-update** (opt-in): **Help ▸ Check for Updates…** checks a manifest, then downloads, verifies (minisign), installs, and relaunches — signed artifacts from GitHub Releases, see [Releasing](#releasing)
- Word/character count, dirty indicator (window title shows *— Edited*), confirm-on-close, keyboard-first

## Shortcuts

Most items live in the native menus with their accelerators shown inline; the core set:

| Keys | Action |
| --- | --- |
| `Cmd/Ctrl+S` / `Shift+Cmd/Ctrl+S` | Save / Save As |
| `Cmd/Ctrl+O` / `Shift+Cmd/Ctrl+O` | Open file / Open folder |
| `Shift+Cmd/Ctrl+P` | Open Quickly |
| `Cmd/Ctrl+F` / `Cmd/Ctrl+G` / `Alt+Cmd/Ctrl+F` | Find / Find next / Replace |
| `Cmd/Ctrl+/` | Toggle source mode |
| `Shift+Cmd/Ctrl+L` | Toggle sidebar |
| `F8` / `F9` | Focus mode / Typewriter mode |
| `Cmd/Ctrl+B / I / U / K` | Bold / italic / underline / link |
| `Cmd/Ctrl+E` / `Shift+Cmd/Ctrl+X` | Inline code / strike |
| `Cmd/Ctrl+1…6`, `0` | Heading level / paragraph |
| `Cmd/Ctrl+=` / `Cmd/Ctrl+-` | Increase / decrease heading level |
| `Alt+Cmd/Ctrl+T / C / Q / O / U / X` | Table / fences / quote / ordered / bullet / task list |
| `Alt+Up` / `Alt+Down` | Move block up / down |
| `Shift+Cmd/Ctrl+0 / = / -` | Actual size / zoom in / zoom out |
| `Cmd/Ctrl+P` | Print (also: Export ▸ PDF) |
| `Esc` | Render the current block |

## Run it

Prereqs: Node 18+, Rust stable, and Tauri's platform dependencies
(<https://tauri.app/start/prerequisites/> — on Linux that's `webkit2gtk-4.1`, etc.).

```bash
pnpm install
pnpm tauri dev      # desktop app
pnpm tauri build    # installers in src-tauri/target/release/bundle
```

The frontend also runs standalone in a browser (`pnpm dev`) with an in-memory
demo document — file dialogs are desktop-only, and Save downloads the file instead.

## Releasing

Releases are automated — bump the version and push a tag, and CI does the rest:

```bash
pnpm release 0.2.0          # bump manifests + commit + tag v0.2.0
pnpm release 0.2.0 --push   # ...and push main + the tag in one go
```

Pushing the `vX.Y.Z` tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. builds and signs on macOS (universal), Windows, and Linux via `tauri-action`;
2. publishes the **GitHub Release** `vX.Y.Z` with the installers and updater
   artifacts (`.app.tar.gz`, `-setup.exe`, `.AppImage`, each with a `.sig`);
3. writes the generated `latest.json` to the updater gist — the moment existing
   installs start seeing the update (**Help ▸ Check for Updates…**).

The updater verifies each download against the minisign public key in
`src-tauri/tauri.conf.json`. One-time setup (signing key, CI secrets:
`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `GIST_TOKEN`),
the `latest.json` shape, the macOS notarization caveat, and a no-CI manual
fallback are all documented in [RELEASING.md](RELEASING.md).

## Architecture

```
src/
  markdown.ts        parser config, block splitter (fence/front-matter aware),
                     outline extraction, word count, task toggling
  store.ts           reactive document model: blocks, split/merge, dirty state
  commands.ts        command bus: every menu id / shortcut maps to one action
  settings.ts        persisted settings (recent files, theme, zoom, toggles)
  tabletools.ts      pipe-table parse/serialize + caret-positioned edits
  platform.ts        Tauri invoke bridge with graceful browser fallback
  components/
    Editor.tsx       block list + click-to-append behavior
    Block.tsx        the hybrid cell: rendered HTML ⇄ live-styled
                     contenteditable source (Enter semantics, caret logic)
  livesource.ts      the live styler: dims markers, styles content in
                     real time; caret offset get/set; click-position mapping
    Sidebar.tsx      file tree + outline tabs
    SourceView.tsx   whole-document raw mode
    StatusBar.tsx    counts, theme + mode toggles
    FindBar.tsx      find / replace across blocks
    QuickOpen.tsx    fuzzy file finder overlay
src-tauri/
  src/main.rs        list_dir (md-aware recursive walk), read_file,
                     save_file (atomic write), settings, pandoc bridge,
                     dialog / opener / clipboard plugins
  src/menu.rs        native menu tree; forwards item ids as one "menu"
                     event — no editing logic in Rust
```

### Design notes

- **Block model over character model.** The document is an array of Markdown blocks (code fences and YAML front matter are kept whole). The active block is a `contenteditable` whose innerHTML is re-styled by `styleSource()` on every input — a key invariant is that the styled HTML's `textContent` is byte-identical to the source, which is what makes caret save/restore by text offset exact (verified by roundtrip tests).
- **One pipeline.** The same `renderMarkdown()` renders editor blocks and the HTML export, so editing view and output can never diverge.
- **Normalization on save** falls out of the model: blocks re-join with exactly one blank line between them.

## Roadmap (from the PRD)

Autosave + crash recovery, file watching, custom CSS theme folder.

## License

GPL-3.0-or-later © Srinivas Gowda
