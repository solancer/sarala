# Welcome to Sarala

A seamless **WYSIWYG Markdown** editor built with *Tauri* and *SolidJS* — no preview pane, no split view. Click any block to edit its Markdown source; click away and it renders in place.

## Why no preview window?

> A Markdown document should be publishable as-is, as plain text, without looking like it's been marked up with tags or formatting instructions.

Split panes duplicate content, waste half the screen, and pull your eyes away from the writing. Here, the editing surface *is* the preview.

## What works

- **Live blocks** — click to reveal source, blur to render
- Keyboard: `Cmd/Ctrl+B` bold, `I` italic, `K` link, `1–6` headings
- Task lists with clickable checkboxes
- [ ] try checking this
- [x] this one is done

### Code, highlighted the same on screen and in export

```rust
#[tauri::command]
fn save_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}
```

### Tables

| Shortcut | Action |
| --- | --- |
| Cmd/Ctrl+S | Save |
| Cmd/Ctrl+/ | Source mode |
| Cmd/Ctrl+\\ | Toggle sidebar |

Open a folder from the sidebar to browse your notes, or just start typing.
