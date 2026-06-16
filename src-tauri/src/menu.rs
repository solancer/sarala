use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuItem, MenuItemBuilder, MenuItemKind,
    PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Wry};

// Chords that are Ctrl+Cmd on macOS get a Ctrl+Alt equivalent elsewhere.
#[cfg(target_os = "macos")]
const CTRL_CMD: &str = "Ctrl+Cmd";
#[cfg(not(target_os = "macos"))]
const CTRL_CMD: &str = "Ctrl+Alt";

// Paste and Match Style: Cmd+Opt+Shift+V on macOS, Ctrl+Shift+V elsewhere.
#[cfg(target_os = "macos")]
const PASTE_MATCH_STYLE: &str = "Cmd+Alt+Shift+V";
#[cfg(not(target_os = "macos"))]
const PASTE_MATCH_STYLE: &str = "Ctrl+Shift+V";

fn mi(app: &AppHandle, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    let mut b = MenuItemBuilder::with_id(id, label);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

fn mi_disabled(app: &AppHandle, id: &str, label: &str) -> tauri::Result<MenuItem<Wry>> {
    MenuItemBuilder::with_id(id, label)
        .enabled(false)
        .build(app)
}

fn ci(
    app: &AppHandle,
    id: &str,
    label: &str,
    checked: bool,
    accel: Option<&str>,
) -> tauri::Result<CheckMenuItem<Wry>> {
    let mut b = CheckMenuItemBuilder::with_id(id, label).checked(checked);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;

    // macOS application menu (About / Hide / Quit).
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Sarala")
            .item(&mi(app, "help.about", "About Sarala", None)?)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu.append(&app_menu)?;
    }

    // ---- File ----
    let open_recent = SubmenuBuilder::with_id(app, "file.open_recent", "Open Recent")
        .item(&mi_disabled(
            app,
            "file.open_recent.empty",
            "No Recent Files",
        )?)
        .separator()
        .item(&mi(app, "file.open_recent.clear", "Clear Menu", None)?)
        .build()?;

    let export = SubmenuBuilder::with_id(app, "file.export", "Export")
        .item(&mi(app, "file.export.html", "HTML", None)?)
        .item(&mi(
            app,
            "file.export.html_plain",
            "HTML (without styles)",
            None,
        )?)
        .separator()
        .item(&mi(app, "file.export.pdf", "PDF", None)?)
        .item(&mi_disabled(app, "file.export.image", "Image")?)
        .separator()
        .item(&mi(app, "file.export.docx", "Word (.docx)", None)?)
        .item(&mi(app, "file.export.odt", "OpenOffice", None)?)
        .item(&mi(app, "file.export.rtf", "RTF", None)?)
        .item(&mi(app, "file.export.epub", "Epub", None)?)
        .item(&mi(app, "file.export.latex", "LaTeX", None)?)
        .item(&mi(app, "file.export.mediawiki", "Media Wiki", None)?)
        .item(&mi(app, "file.export.rst", "reStructuredText", None)?)
        .item(&mi(app, "file.export.textile", "Textile", None)?)
        .item(&mi(app, "file.export.opml", "OPML", None)?)
        .separator()
        .item(
            &SubmenuBuilder::with_id(app, "file.export.presets", "Presets")
                .item(&mi_disabled(
                    app,
                    "file.export.presets.empty",
                    "No Presets",
                )?)
                .build()?,
        )
        .item(&mi(
            app,
            "file.export.previous",
            "Export with Previous",
            Some(&format!("{CTRL_CMD}+E")),
        )?)
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&mi(app, "file.new", "New", Some("CmdOrCtrl+N"))?)
        .item(&mi(
            app,
            "file.new_window",
            "New Window",
            Some("Shift+CmdOrCtrl+N"),
        )?)
        .separator()
        .item(&mi(app, "file.open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&open_recent)
        .item(&mi(
            app,
            "file.open_quickly",
            "Open Quickly…",
            Some("Shift+CmdOrCtrl+P"),
        )?)
        .separator()
        .item(&mi(
            app,
            "file.open_folder",
            "Open Folder…",
            Some("Shift+CmdOrCtrl+O"),
        )?)
        .separator()
        .item(&mi(app, "file.close", "Close", Some("CmdOrCtrl+W"))?)
        .item(&mi(app, "file.save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&mi(
            app,
            "file.save_as",
            "Save As / Duplicate…",
            Some("Shift+CmdOrCtrl+S"),
        )?)
        .separator()
        .item(&mi(app, "file.rename", "Rename… / Move To…", None)?)
        .item(&mi(app, "file.delete", "Delete…", None)?)
        .item(
            &SubmenuBuilder::with_id(app, "file.revert", "Revert To")
                .item(&mi(app, "file.revert.last_saved", "Last Saved", None)?)
                .build()?,
        )
        .separator()
        .item(&mi(app, "file.import", "Import…", None)?)
        .item(&export)
        .separator()
        .item(&mi(app, "file.print", "Print…", Some("CmdOrCtrl+P"))?)
        .build()?;
    menu.append(&file)?;

    // ---- Edit ----
    let selection = SubmenuBuilder::with_id(app, "edit.selection", "Selection")
        .item(&mi(app, "edit.select_block", "Select Block", None)?)
        .item(&mi(app, "edit.select_line", "Select Line", None)?)
        .item(&mi(app, "edit.select_word", "Select Word", None)?)
        .build()?;

    let substitutions = SubmenuBuilder::with_id(app, "edit.substitutions", "Substitutions")
        .item(&ci(
            app,
            "edit.smart_punctuation",
            "Smart Punctuation",
            false,
            None,
        )?)
        .build()?;

    let line_endings = SubmenuBuilder::with_id(app, "edit.line_endings", "Line Endings")
        .item(&ci(app, "edit.line_ending.lf", "LF (Unix)", true, None)?)
        .item(&ci(
            app,
            "edit.line_ending.crlf",
            "CRLF (Windows)",
            false,
            None,
        )?)
        .build()?;

    let final_newline = SubmenuBuilder::with_id(app, "edit.final_newline", "Final Newline")
        .item(&ci(
            app,
            "edit.final_newline.ensure",
            "Ensure Trailing Newline",
            true,
            None,
        )?)
        .item(&ci(
            app,
            "edit.final_newline.preserve",
            "Preserve As-Is",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.final_newline.trim",
            "Trim Trailing Newlines",
            false,
            None,
        )?)
        .build()?;

    // Decode the current file again with a chosen encoding (fixes mis-detected
    // legacy files). Ids carry the encoding_rs label the Rust side decodes with;
    // "utf8_bom" is a save-time variant (UTF-8 that re-emits its BOM).
    let encoding = SubmenuBuilder::with_id(app, "edit.encoding", "Reopen with Encoding")
        .item(&ci(app, "edit.encoding.utf-8", "UTF-8", true, None)?)
        .item(&ci(
            app,
            "edit.encoding.utf8_bom",
            "UTF-8 with BOM",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.encoding.utf-16le",
            "UTF-16 LE",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.encoding.utf-16be",
            "UTF-16 BE",
            false,
            None,
        )?)
        .separator()
        .item(&ci(
            app,
            "edit.encoding.windows-1252",
            "Western (Windows-1252)",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.encoding.windows-1251",
            "Cyrillic (Windows-1251)",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.encoding.koi8-r",
            "Cyrillic (KOI8-R)",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.encoding.shift_jis",
            "Japanese (Shift_JIS)",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.encoding.euc-jp",
            "Japanese (EUC-JP)",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.encoding.gbk",
            "Chinese Simplified (GBK)",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.encoding.big5",
            "Chinese Traditional (Big5)",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.encoding.euc-kr",
            "Korean (EUC-KR)",
            false,
            None,
        )?)
        .build()?;

    let autosave = SubmenuBuilder::with_id(app, "edit.autosave", "Autosave Recovery")
        .item(&ci(app, "edit.autosave.off", "Off", false, None)?)
        .item(&ci(app, "edit.autosave.5", "Every 5 seconds", true, None)?)
        .item(&ci(
            app,
            "edit.autosave.15",
            "Every 15 seconds",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.autosave.30",
            "Every 30 seconds",
            false,
            None,
        )?)
        .build()?;

    let whitespace = SubmenuBuilder::with_id(app, "edit.whitespace", "Whitespace and Line Breaks")
        .item(&ci(
            app,
            "edit.preserve_breaks",
            "Preserve Single Line Breaks",
            false,
            None,
        )?)
        .build()?;

    let math = SubmenuBuilder::with_id(app, "edit.math", "Math Options")
        .item(&ci(
            app,
            "edit.math.alt_delimiters",
            "LaTeX Delimiters  \\( \\)  \\[ \\]",
            false,
            None,
        )?)
        .item(&ci(
            app,
            "edit.math.fence",
            "Enable ```math Code Block",
            false,
            None,
        )?)
        .build()?;

    let extensions = SubmenuBuilder::with_id(app, "edit.extensions", "Markdown Extensions")
        .item(&ci(
            app,
            "edit.ext.highlight",
            "Highlight  ==text==",
            true,
            None,
        )?)
        .item(&ci(
            app,
            "edit.ext.sub_sup",
            "Subscript and Superscript",
            true,
            None,
        )?)
        .item(&ci(
            app,
            "edit.ext.emoji",
            "Emoji Shortcodes  :smile:",
            true,
            None,
        )?)
        .item(&ci(
            app,
            "edit.ext.autolink",
            "Auto-link Bare URLs",
            true,
            None,
        )?)
        .build()?;

    // Undo/Redo are custom: the live styler rebuilds the DOM per keystroke,
    // so history lives in the frontend store, not the webview's undo stack.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&mi(app, "edit.undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&mi(app, "edit.redo", "Redo", Some("Shift+CmdOrCtrl+Z"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&mi(
            app,
            "edit.copy_markdown",
            "Copy as Markdown",
            Some("Shift+CmdOrCtrl+C"),
        )?)
        .item(&mi(app, "edit.copy_html", "Copy as HTML Code", None)?)
        .item(&mi(
            app,
            "edit.paste_plain",
            "Paste and Match Style",
            Some(PASTE_MATCH_STYLE),
        )?)
        .separator()
        .item(&mi(app, "edit.move_row_up", "Move Row Up", Some("Alt+Up"))?)
        .item(&mi(
            app,
            "edit.move_row_down",
            "Move Row Down",
            Some("Alt+Down"),
        )?)
        .item(
            &SubmenuBuilder::with_id(app, "edit.delete_range", "Delete Range")
                .item(&mi(app, "edit.delete_block", "Delete Block", None)?)
                .build()?,
        )
        .item(&selection)
        .separator()
        .item(&mi(app, "edit.find", "Find…", Some("CmdOrCtrl+F"))?)
        .item(&mi(
            app,
            "edit.find_next",
            "Find Next",
            Some("CmdOrCtrl+G"),
        )?)
        .item(&mi(
            app,
            "edit.replace",
            "Replace…",
            Some("Alt+CmdOrCtrl+F"),
        )?)
        .separator()
        .item(&substitutions)
        .item(&ci(
            app,
            "edit.spellcheck",
            "Check Spelling While Typing",
            true,
            None,
        )?)
        .separator()
        .item(&line_endings)
        .item(&final_newline)
        .item(&encoding)
        .item(&autosave)
        .item(&whitespace)
        .item(&math)
        .item(&extensions)
        .build()?;
    menu.append(&edit)?;

    // ---- Paragraph ----
    let table = SubmenuBuilder::with_id(app, "paragraph.table", "Table")
        .item(&mi(
            app,
            "paragraph.table.insert",
            "Insert Table…",
            Some("Alt+CmdOrCtrl+T"),
        )?)
        .separator()
        .item(&mi(
            app,
            "paragraph.table.row_above",
            "Add Row Above",
            None,
        )?)
        .item(&mi(
            app,
            "paragraph.table.row_below",
            "Add Row Below",
            None,
        )?)
        .item(&mi(app, "paragraph.table.delete_row", "Delete Row", None)?)
        .separator()
        .item(&mi(app, "paragraph.table.add_col", "Add Column", None)?)
        .item(&mi(
            app,
            "paragraph.table.delete_col",
            "Delete Column",
            None,
        )?)
        .separator()
        .item(&mi(app, "paragraph.table.align_left", "Align Left", None)?)
        .item(&mi(
            app,
            "paragraph.table.align_center",
            "Align Center",
            None,
        )?)
        .item(&mi(
            app,
            "paragraph.table.align_right",
            "Align Right",
            None,
        )?)
        .build()?;

    let task_status = SubmenuBuilder::with_id(app, "paragraph.task_status", "Task Status")
        .item(&mi(
            app,
            "paragraph.task_toggle",
            "Toggle Task Status",
            Some("Alt+CmdOrCtrl+Enter"),
        )?)
        .build()?;

    let indentation = SubmenuBuilder::with_id(app, "paragraph.indentation", "List Indentation")
        .item(&mi(
            app,
            "paragraph.indent",
            "Indent",
            Some("CmdOrCtrl+BracketRight"),
        )?)
        .item(&mi(
            app,
            "paragraph.outdent",
            "Outdent",
            Some("CmdOrCtrl+BracketLeft"),
        )?)
        .build()?;

    let alert = SubmenuBuilder::with_id(app, "paragraph.alert", "Alert")
        .item(&mi(app, "paragraph.alert.note", "Note", None)?)
        .item(&mi(app, "paragraph.alert.tip", "Tip", None)?)
        .item(&mi(app, "paragraph.alert.warning", "Warning", None)?)
        .build()?;

    let paragraph = SubmenuBuilder::new(app, "Paragraph")
        .item(&mi(
            app,
            "paragraph.heading.1",
            "Heading 1",
            Some("CmdOrCtrl+1"),
        )?)
        .item(&mi(
            app,
            "paragraph.heading.2",
            "Heading 2",
            Some("CmdOrCtrl+2"),
        )?)
        .item(&mi(
            app,
            "paragraph.heading.3",
            "Heading 3",
            Some("CmdOrCtrl+3"),
        )?)
        .item(&mi(
            app,
            "paragraph.heading.4",
            "Heading 4",
            Some("CmdOrCtrl+4"),
        )?)
        .item(&mi(
            app,
            "paragraph.heading.5",
            "Heading 5",
            Some("CmdOrCtrl+5"),
        )?)
        .item(&mi(
            app,
            "paragraph.heading.6",
            "Heading 6",
            Some("CmdOrCtrl+6"),
        )?)
        .separator()
        .item(&mi(
            app,
            "paragraph.heading.0",
            "Paragraph",
            Some("CmdOrCtrl+0"),
        )?)
        .separator()
        .item(&mi(
            app,
            "paragraph.heading_up",
            "Increase Heading Level",
            Some("CmdOrCtrl+Equal"),
        )?)
        .item(&mi(
            app,
            "paragraph.heading_down",
            "Decrease Heading Level",
            Some("CmdOrCtrl+Minus"),
        )?)
        .separator()
        .item(&table)
        .item(&mi(
            app,
            "paragraph.math_block",
            "Math Block",
            Some("Alt+CmdOrCtrl+B"),
        )?)
        .item(&mi(
            app,
            "paragraph.code_fences",
            "Code Fences",
            Some("Alt+CmdOrCtrl+C"),
        )?)
        .separator()
        .item(&mi(
            app,
            "paragraph.quote",
            "Quote",
            Some("Alt+CmdOrCtrl+Q"),
        )?)
        .item(&mi(
            app,
            "paragraph.ordered_list",
            "Ordered List",
            Some("Alt+CmdOrCtrl+O"),
        )?)
        .item(&mi(
            app,
            "paragraph.unordered_list",
            "Unordered List",
            Some("Alt+CmdOrCtrl+U"),
        )?)
        .item(&mi(
            app,
            "paragraph.task_list",
            "Task List",
            Some("Alt+CmdOrCtrl+X"),
        )?)
        .item(&task_status)
        .item(&indentation)
        .separator()
        .item(&mi(
            app,
            "paragraph.insert_before",
            "Insert Paragraph Before",
            None,
        )?)
        .item(&mi(
            app,
            "paragraph.insert_after",
            "Insert Paragraph After",
            None,
        )?)
        .separator()
        .item(&mi(
            app,
            "paragraph.hr",
            "Horizontal Line",
            Some("Alt+CmdOrCtrl+Minus"),
        )?)
        .item(&mi(app, "paragraph.toc", "Table of Contents", None)?)
        .item(&mi(
            app,
            "paragraph.front_matter",
            "YAML Front Matter",
            None,
        )?)
        .separator()
        .item(&mi(
            app,
            "paragraph.footnote",
            "Link Reference / Footnote",
            Some("Alt+CmdOrCtrl+R"),
        )?)
        .item(&alert)
        .build()?;
    menu.append(&paragraph)?;

    // ---- Format ----
    let link_actions = SubmenuBuilder::with_id(app, "format.link", "Hyperlink Actions")
        .item(&mi(app, "format.link.open", "Open Link", None)?)
        .item(&mi(app, "format.link.copy", "Copy Link Address", None)?)
        .build()?;

    let image = SubmenuBuilder::with_id(app, "format.image", "Image")
        .item(&mi(
            app,
            "format.image.insert",
            "Insert Image…",
            Some("Ctrl+Shift+I"),
        )?)
        .separator()
        .item(&ci(
            app,
            "format.image.copy_to_folder",
            "When Insert Local Image: Copy to Assets Folder",
            false,
            None,
        )?)
        .item(&mi(
            app,
            "format.image.root_path",
            "Use Image Root Path…",
            None,
        )?)
        .item(&mi(app, "format.image.upload", "Upload Image", None)?)
        .build()?;

    let format = SubmenuBuilder::new(app, "Format")
        .item(&mi(app, "format.strong", "Strong", Some("CmdOrCtrl+B"))?)
        .item(&mi(
            app,
            "format.emphasis",
            "Emphasis",
            Some("CmdOrCtrl+I"),
        )?)
        .item(&mi(
            app,
            "format.underline",
            "Underline",
            Some("CmdOrCtrl+U"),
        )?)
        // Accelerators are kept OFF the Backquote key: it's the key users press
        // to type `` ` `` and ``` code fences, so an accelerator there fires the
        // inline-code command when they just want to type a backtick.
        .item(&mi(app, "format.code", "Code", Some("CmdOrCtrl+E"))?)
        .item(&mi(
            app,
            "format.strike",
            "Strike",
            Some("Shift+CmdOrCtrl+X"),
        )?)
        .item(&mi(app, "format.comment", "Comment", Some("Ctrl+Minus"))?)
        .item(&mi(
            app,
            "format.inline_math",
            "Inline Math",
            Some("Ctrl+M"),
        )?)
        .separator()
        .item(&mi(
            app,
            "format.hyperlink",
            "Hyperlink",
            Some("CmdOrCtrl+K"),
        )?)
        .item(&link_actions)
        .item(&image)
        .separator()
        .item(&mi(
            app,
            "format.clear",
            "Clear Format",
            Some("CmdOrCtrl+Backslash"),
        )?)
        .build()?;
    menu.append(&format)?;

    // ---- View ----
    let view = SubmenuBuilder::new(app, "View")
        .item(&mi(
            app,
            "app.settings",
            "Settings…",
            Some("CmdOrCtrl+Comma"),
        )?)
        .separator()
        .item(&ci(
            app,
            "view.source_mode",
            "Source Code Mode",
            false,
            Some("CmdOrCtrl+Slash"),
        )?)
        .separator()
        .item(&ci(
            app,
            "view.focus_mode",
            "Focus Mode",
            false,
            Some("F8"),
        )?)
        .item(&ci(
            app,
            "view.typewriter_mode",
            "Typewriter Mode",
            false,
            Some("F9"),
        )?)
        .separator()
        .item(&ci(
            app,
            "view.sidebar",
            "Toggle Sidebar",
            true,
            Some("Shift+CmdOrCtrl+L"),
        )?)
        .item(&mi(
            app,
            "view.outline",
            "Outline",
            Some(&format!("{CTRL_CMD}+1")),
        )?)
        .item(&mi(
            app,
            "view.file_tree",
            "File Tree",
            Some(&format!("{CTRL_CMD}+3")),
        )?)
        .separator()
        .item(&mi(
            app,
            "view.search",
            "Search",
            Some("Shift+CmdOrCtrl+F"),
        )?)
        .separator()
        .item(&mi(
            app,
            "view.zoom_actual",
            "Actual Size",
            Some("Shift+CmdOrCtrl+Digit0"),
        )?)
        .item(&mi(
            app,
            "view.zoom_in",
            "Zoom In",
            Some("Shift+CmdOrCtrl+Equal"),
        )?)
        .item(&mi(
            app,
            "view.zoom_out",
            "Zoom Out",
            Some("Shift+CmdOrCtrl+Minus"),
        )?)
        .separator()
        .item(&ci(
            app,
            "view.always_on_top",
            "Always on Top",
            false,
            None,
        )?)
        .item(&mi(app, "view.fullscreen", "Toggle Full Screen", None)?)
        .build()?;
    menu.append(&view)?;

    // ---- Themes ----
    let themes = SubmenuBuilder::new(app, "Themes")
        .item(&ci(app, "themes.set.sarala", "Sarala", true, None)?)
        .item(&ci(app, "themes.set.pro", "Pro", false, None)?)
        .item(&ci(app, "themes.set.octagon", "Octagon", false, None)?)
        .item(&ci(app, "themes.set.machine", "Machine", false, None)?)
        .item(&ci(app, "themes.set.ristretto", "Ristretto", false, None)?)
        .item(&ci(app, "themes.set.spectrum", "Spectrum", false, None)?)
        .item(&ci(app, "themes.set.classic", "Classic", false, None)?)
        .item(&ci(app, "themes.set.paper", "Paper", false, None)?)
        .item(&ci(app, "themes.set.graphite", "Graphite", false, None)?)
        .item(&ci(app, "themes.set.github", "GitHub", false, None)?)
        .item(&ci(app, "themes.set.night", "Night", false, None)?)
        .item(&ci(app, "themes.set.newsprint", "Newsprint", false, None)?)
        .item(&ci(app, "themes.set.whitey", "Whitey", false, None)?)
        .build()?;
    menu.append(&themes)?;

    // ---- Window ----
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;
    menu.append(&window)?;

    // ---- Help ----
    let help = SubmenuBuilder::new(app, "Help")
        .item(&mi(app, "help.about", "About Sarala", None)?)
        .item(&mi(app, "help.check_updates", "Check for Updates…", None)?)
        .build()?;
    menu.append(&help)?;

    Ok(menu)
}

fn find_check_item(items: Vec<MenuItemKind<Wry>>, id: &str) -> Option<CheckMenuItem<Wry>> {
    for item in items {
        match item {
            MenuItemKind::Check(c) if c.id().as_ref() == id => return Some(c),
            MenuItemKind::Submenu(s) => {
                if let Ok(children) = s.items() {
                    if let Some(found) = find_check_item(children, id) {
                        return Some(found);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn find_submenu(items: Vec<MenuItemKind<Wry>>, id: &str) -> Option<tauri::menu::Submenu<Wry>> {
    for item in items {
        if let MenuItemKind::Submenu(s) = item {
            if s.id().as_ref() == id {
                return Some(s);
            }
            if let Ok(children) = s.items() {
                if let Some(found) = find_submenu(children, id) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// Rebuild the File ▸ Open Recent submenu. Item ids carry the index into the
/// frontend's recent-files list ("file.open_recent.item.<n>").
#[tauri::command]
pub fn update_recent_menu(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let menu = app.menu().ok_or("application menu not set")?;
    let items = menu.items().map_err(|e| e.to_string())?;
    let submenu = find_submenu(items, "file.open_recent").ok_or("Open Recent submenu missing")?;

    while !submenu.items().map_err(|e| e.to_string())?.is_empty() {
        submenu.remove_at(0).map_err(|e| e.to_string())?;
    }

    let err = |e: tauri::Error| e.to_string();
    if paths.is_empty() {
        submenu
            .append(&mi_disabled(&app, "file.open_recent.empty", "No Recent Files").map_err(err)?)
            .map_err(err)?;
    } else {
        for (i, path) in paths.iter().take(10).enumerate() {
            let item = mi(&app, &format!("file.open_recent.item.{i}"), path, None).map_err(err)?;
            submenu.append(&item).map_err(err)?;
        }
    }
    submenu
        .append(&PredefinedMenuItem::separator(&app).map_err(err)?)
        .map_err(err)?;
    submenu
        .append(&mi(&app, "file.open_recent.clear", "Clear Menu", None).map_err(err)?)
        .map_err(err)?;
    Ok(())
}

/// Rebuild the File ▸ Export ▸ Presets submenu from preset names. Item ids carry
/// the index into the frontend's preset list ("file.export.preset.<n>").
#[tauri::command]
pub fn update_export_menu(app: AppHandle, names: Vec<String>) -> Result<(), String> {
    let menu = app.menu().ok_or("application menu not set")?;
    let items = menu.items().map_err(|e| e.to_string())?;
    let submenu = find_submenu(items, "file.export.presets").ok_or("Presets submenu missing")?;

    while !submenu.items().map_err(|e| e.to_string())?.is_empty() {
        submenu.remove_at(0).map_err(|e| e.to_string())?;
    }
    let err = |e: tauri::Error| e.to_string();
    if names.is_empty() {
        submenu
            .append(&mi_disabled(&app, "file.export.presets.empty", "No Presets").map_err(err)?)
            .map_err(err)?;
    } else {
        for (i, name) in names.iter().take(20).enumerate() {
            let item = mi(&app, &format!("file.export.preset.{i}"), name, None).map_err(err)?;
            submenu.append(&item).map_err(err)?;
        }
    }
    Ok(())
}

fn set_enabled_deep(
    items: Vec<MenuItemKind<Wry>>,
    id: &str,
    enabled: bool,
) -> Result<bool, String> {
    let err = |e: tauri::Error| e.to_string();
    for item in items {
        match item {
            MenuItemKind::MenuItem(m) if m.id().as_ref() == id => {
                m.set_enabled(enabled).map_err(err)?;
                return Ok(true);
            }
            MenuItemKind::Check(c) if c.id().as_ref() == id => {
                c.set_enabled(enabled).map_err(err)?;
                return Ok(true);
            }
            MenuItemKind::Submenu(s) => {
                if s.id().as_ref() == id {
                    s.set_enabled(enabled).map_err(err)?;
                    return Ok(true);
                }
                if let Ok(children) = s.items() {
                    if set_enabled_deep(children, id, enabled)? {
                        return Ok(true);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(false)
}

/// Enable/disable a menu item (selection-dependent items like Format ▸ Strong).
#[tauri::command]
pub fn set_menu_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let menu = app.menu().ok_or("application menu not set")?;
    let items = menu.items().map_err(|e| e.to_string())?;
    set_enabled_deep(items, &id, enabled)?;
    Ok(())
}

#[tauri::command]
pub fn set_menu_checked(app: AppHandle, id: String, checked: bool) -> Result<(), String> {
    let menu = app.menu().ok_or("application menu not set")?;
    let items = menu.items().map_err(|e| e.to_string())?;
    match find_check_item(items, &id) {
        Some(item) => item.set_checked(checked).map_err(|e| e.to_string()),
        None => Err(format!("no check menu item with id {id}")),
    }
}
