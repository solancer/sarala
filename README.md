# Inkdown

A seamless WYSIWYG Markdown editor in the spirit of Typora — no preview pane, no split view — built with **Tauri 2** (Rust) and **SolidJS**.

The editing surface *is* the preview: every paragraph, heading, list, quote, table and code fence is a live block. Click a block and it opens into raw Markdown source; click away and it renders in place. One parser (`marked` + GFM), one theme, one window — what you see while writing is exactly what exports.

## Features

- **Typora-style live editing** — type Markdown and the active block styles itself *as you type*: syntax markers stay visible but dimmed (the gray `##` next to a live-styled heading, gray `[ ]( )` around a blue link), and the block fully renders when you press **Enter** or move the caret away
- **Smart Enter** — continues lists (with auto-numbering and unchecked task carry-over), continues blockquotes, ends a list on an empty item, auto-closes a just-opened code fence, and inserts plain newlines inside fences; `Shift+Enter` for a soft break
- Click anywhere in rendered text and the caret lands at that spot in the source (rendered→source position mapping)
- Merge on backspace at block start, arrow-key navigation across blocks, IME-safe (composition events respected)
- **GFM**: tables, task lists (clickable checkboxes), strikethrough, fenced code with highlight.js (same highlighting on screen and in export)
- **Math** (KaTeX): inline `$…$` and block `$$…$$`, rendered in inactive blocks and shown as raw source while editing; optional `\(…\)` / `\[…\]` delimiters and a `` ```math `` block (both preference-gated, off by default); a broken formula keeps its last good render with an error rather than blanking
- **Diagrams** (Mermaid): `` ```mermaid `` blocks render every diagram type (flowchart, sequence, gantt, class, state, pie, ER, gitGraph, mindmap, timeline, quadrant, sankey, XY, block, kanban, architecture); invalid syntax shows an inline error and keeps the last good diagram; a `--mermaid-theme` CSS var follows the app's light/dark theme
- **Native menu bar** (Typora-style: File, Edit, Paragraph, Format, View, Themes, Window, Help) — every item dispatches through one frontend command bus shared with the keyboard shortcuts
- **Find & replace** (`Cmd/Ctrl+F`, replace one or all) and **Open Quickly** fuzzy finder (`Shift+Cmd/Ctrl+P`)
- **Sidebar**: file tree (open a folder, browse `.md` files) and live outline (click a heading to jump)
- **Source mode** (`Cmd/Ctrl+/`) as an escape hatch to the full raw document; **Focus** (`F8`) and **Typewriter** (`F9`) modes
- **Paragraph tools**: heading levels, pipe-table editing (insert/rows/columns/alignment), lists and task toggles, quotes, math/code blocks, `[TOC]`, footnotes, GFM alerts
- **Themes**: Paper, Graphite, GitHub, Night, Newsprint, Whitey — pure CSS variables, add your own in `src/styles/app.css`
- **Export**: HTML (with or without styles), PDF via print, and docx/odt/rtf/epub/LaTeX/MediaWiki/rst/Textile/OPML through [Pandoc](https://pandoc.org) when installed; Import via Pandoc too
- **Recent files**, settings persisted to disk, smart punctuation, LF/CRLF line endings, image insert with copy-to-assets rule; **save is atomic** (temp file + rename)
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
| `` Ctrl+` `` / ``Ctrl+Shift+` `` | Inline code / strike |
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
