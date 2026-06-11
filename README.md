# Inkdown

A seamless WYSIWYG Markdown editor in the spirit of Typora — no preview pane, no split view — built with **Tauri 2** (Rust) and **SolidJS**.

The editing surface *is* the preview: every paragraph, heading, list, quote, table and code fence is a live block. Click a block and it opens into raw Markdown source (marked by the teal *ink seam* on its left edge); click away and it renders in place. One parser (`marked` + GFM), one theme, one window — what you see while writing is exactly what exports.

## Features

- **Typora-style live editing** — type Markdown and the active block styles itself *as you type*: syntax markers stay visible but dimmed (the gray `##` next to a live-styled heading, gray `[ ]( )` around a blue link), and the block fully renders when you press **Enter** or move the caret away
- **Smart Enter** — continues lists (with auto-numbering and unchecked task carry-over), continues blockquotes, ends a list on an empty item, auto-closes a just-opened code fence, and inserts plain newlines inside fences; `Shift+Enter` for a soft break
- Click anywhere in rendered text and the caret lands at that spot in the source (rendered→source position mapping)
- Merge on backspace at block start, arrow-key navigation across blocks, IME-safe (composition events respected)
- **GFM**: tables, task lists (clickable checkboxes), strikethrough, fenced code with highlight.js (same highlighting on screen and in export)
- **Sidebar**: file tree (open a folder, browse `.md` files) and live outline (click a heading to jump)
- **Source mode** (`Cmd/Ctrl+/`) as an escape hatch to the full raw document
- **Themes**: Paper (ivory + teal ink) and Graphite (charcoal + sea glass), pure CSS variables — add your own in `src/styles/app.css`
- **Export to HTML** with the same prose styles; **save is atomic** (temp file + rename)
- Word/character count, dirty indicator, keyboard-first

## Shortcuts

| Keys | Action |
| --- | --- |
| `Cmd/Ctrl+S` | Save |
| `Cmd/Ctrl+O` | Open file |
| `Cmd/Ctrl+Shift+O` | Open folder |
| `Cmd/Ctrl+/` | Toggle source mode |
| `Cmd/Ctrl+\` | Toggle sidebar |
| `Cmd/Ctrl+Shift+E` | Export HTML |
| `Cmd/Ctrl+B / I / E / K` | Bold / italic / code / link (in a block) |
| `Cmd/Ctrl+1…6`, `0` | Heading level / paragraph |
| `Esc` | Render the current block |

## Run it

Prereqs: Node 18+, Rust stable, and Tauri's platform dependencies
(<https://tauri.app/start/prerequisites/> — on Linux that's `webkit2gtk-4.1`, etc.).

```bash
npm install
npm run tauri dev      # desktop app
npm run tauri build    # installers in src-tauri/target/release/bundle
```

The frontend also runs standalone in a browser (`npm run dev`) with an in-memory
demo document — file dialogs are desktop-only, and Save downloads the file instead.

## Architecture

```
src/
  markdown.ts        parser config, block splitter (fence/front-matter aware),
                     outline extraction, word count, task toggling
  store.ts           reactive document model: blocks, split/merge, dirty state
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
src-tauri/
  src/main.rs        list_dir (md-aware recursive walk), read_file,
                     save_file (atomic write), dialog & opener plugins
```

### Design notes

- **Block model over character model.** The document is an array of Markdown blocks (code fences and YAML front matter are kept whole). The active block is a `contenteditable` whose innerHTML is re-styled by `styleSource()` on every input — a key invariant is that the styled HTML's `textContent` is byte-identical to the source, which is what makes caret save/restore by text offset exact (verified by roundtrip tests).
- **One pipeline.** The same `renderMarkdown()` renders editor blocks and the HTML export, so editing view and output can never diverge.
- **Normalization on save** falls out of the model: blocks re-join with exactly one blank line between them.

## Roadmap (from the PRD)

Math (KaTeX), Mermaid fences, focus/typewriter modes, find & replace, autosave + crash recovery, file watching, Pandoc export, image paste-to-folder rules, custom CSS theme folder.
