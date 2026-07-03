// The application menu as data — the single source for the in-app menubar
// (Linux, Windows, and the browser dev build) and for the frontend keyboard
// accelerators. macOS draws its own native global menu bar from
// `src-tauri/src/menu.rs`; the two are hand-kept mirrors of the same tree, so
// keep ids/labels in sync when items are added or removed.
//
// Accelerators here use the *non-macOS* forms of the chords in menu.rs:
//   CmdOrCtrl -> Ctrl,  Ctrl+Cmd (CTRL_CMD) -> Ctrl+Alt,
//   Paste-and-Match-Style -> Ctrl+Shift+V.

import {
  sourceMode, sidebarOpen, theme, THEMES, spellcheckOn, smartPunctuation,
  preserveBreaks, lineEnding, finalNewline, autosaveInterval, copyImageToAssets,
  focusMode, typewriterMode, alwaysOnTop, mathAltDelimiters, mathFence,
  emojiEnabled, highlightEnabled, subSupEnabled, autolinkEnabled,
  targetBlockIndex, doc,
} from "./store";

export interface MenuLeaf {
  /** Command id routed through executeCommand(); omitted for exec/submenu-only nodes. */
  id?: string;
  label: string;
  /** Display + bound accelerator (Tauri form, non-mac). Not bound when `exec` is set. */
  accel?: string;
  /** Renders a check/radio glyph driven by `checked()`. */
  type?: "check" | "radio";
  checked?: () => boolean;
  /** Overrides the block-targeted default; return false to disable the item. */
  enabled?: () => boolean;
  /** Native clipboard action handled by the webview (no bound accelerator). */
  exec?: "cut" | "copy" | "paste" | "selectAll";
  /** Nested submenu. */
  items?: MenuNode[];
}

export type MenuNode =
  | { sep: true }
  /** Expanded at open-time from live state (recent files / export presets). */
  | { dynamic: "recent" | "export-presets" }
  | MenuLeaf;

export type TopMenu = { label: string; items: MenuNode[] };

/** Block-targeted items are disabled until some block holds the caret. Shared
 *  with App.tsx (which syncs the same set to the native macOS menu). */
export const BLOCK_TARGETED_IDS = new Set<string>([
  "format.strong", "format.emphasis", "format.underline", "format.code",
  "format.strike", "format.comment", "format.inline_math", "format.hyperlink",
  "format.link", "format.image.insert", "format.clear",
  "paragraph.heading.0", "paragraph.heading.1", "paragraph.heading.2",
  "paragraph.heading.3", "paragraph.heading.4", "paragraph.heading.5",
  "paragraph.heading.6", "paragraph.heading_up", "paragraph.heading_down",
  "paragraph.table", "paragraph.math_block", "paragraph.code_fences",
  "paragraph.quote", "paragraph.ordered_list", "paragraph.unordered_list",
  "paragraph.task_list", "paragraph.task_status", "paragraph.indentation",
  "paragraph.insert_before", "paragraph.insert_after", "paragraph.footnote",
  "edit.move_row_up", "edit.move_row_down", "edit.delete_range", "edit.selection",
]);

export const blockTargetsEnabled = () => targetBlockIndex() >= 0;

/** Reflects the open document's encoding in the Reopen-with-Encoding radios.
 *  UTF-8 splits on the BOM flag; other labels match the encoding_rs name. */
function encChecked(label: string): boolean {
  const enc = doc.encoding.toLowerCase();
  if (label === "utf-8") return enc === "utf-8" && !doc.hadBom;
  if (label === "utf8_bom") return enc === "utf-8" && doc.hadBom;
  return enc === label;
}

const enc = (label: string, text: string): MenuNode => ({
  id: `edit.encoding.${label}`,
  label: text,
  type: "radio",
  checked: () => encChecked(label),
});

// Display names for the themes (matches menu.rs; mostly a capitalized id).
export const THEME_LABELS: Record<string, string> = {
  sarala: "Sarala", pro: "Pro", octagon: "Octagon", machine: "Machine",
  ristretto: "Ristretto", spectrum: "Spectrum", classic: "Classic",
  paper: "Paper", graphite: "Graphite", github: "GitHub", night: "Night",
  newsprint: "Newsprint", whitey: "Whitey",
};
const themeItems: MenuNode[] = THEMES.map((id) => ({
  id: `themes.set.${id}`,
  label: THEME_LABELS[id] ?? id,
  type: "radio",
  checked: () => theme() === id,
}));

export const MENUS: TopMenu[] = [
  {
    label: "File",
    items: [
      { id: "file.new", label: "New", accel: "Ctrl+N" },
      { id: "file.new_window", label: "New Window", accel: "Shift+Ctrl+N" },
      { sep: true },
      { id: "file.open", label: "Open…", accel: "Ctrl+O" },
      {
        label: "Open Recent",
        items: [
          { dynamic: "recent" },
          { sep: true },
          { id: "file.open_recent.clear", label: "Clear Menu" },
        ],
      },
      { id: "file.open_quickly", label: "Open Quickly…", accel: "Shift+Ctrl+P" },
      { sep: true },
      { id: "file.open_folder", label: "Open Folder…", accel: "Shift+Ctrl+O" },
      { sep: true },
      { id: "file.close", label: "Close", accel: "Ctrl+W" },
      { id: "file.save", label: "Save", accel: "Ctrl+S" },
      { id: "file.save_as", label: "Save As / Duplicate…", accel: "Shift+Ctrl+S" },
      { sep: true },
      { id: "file.rename", label: "Rename… / Move To…" },
      { id: "file.delete", label: "Delete…" },
      { label: "Revert To", items: [{ id: "file.revert.last_saved", label: "Last Saved" }] },
      { sep: true },
      { id: "file.import", label: "Import…" },
      {
        label: "Export",
        items: [
          { id: "file.export.html", label: "HTML" },
          { id: "file.export.html_plain", label: "HTML (without styles)" },
          { sep: true },
          { id: "file.export.pdf", label: "PDF" },
          { id: "file.export.image", label: "Image", enabled: () => false },
          { sep: true },
          { id: "file.export.docx", label: "Word (.docx)" },
          { id: "file.export.odt", label: "OpenOffice" },
          { id: "file.export.rtf", label: "RTF" },
          { id: "file.export.epub", label: "Epub" },
          { id: "file.export.latex", label: "LaTeX" },
          { id: "file.export.mediawiki", label: "Media Wiki" },
          { id: "file.export.rst", label: "reStructuredText" },
          { id: "file.export.textile", label: "Textile" },
          { id: "file.export.opml", label: "OPML" },
          { sep: true },
          { label: "Presets", items: [{ dynamic: "export-presets" }] },
          { id: "file.export.previous", label: "Export with Previous", accel: "Ctrl+Alt+E" },
        ],
      },
      { sep: true },
      { id: "file.print", label: "Print…", accel: "Ctrl+P" },
    ],
  },
  {
    label: "Edit",
    items: [
      { id: "edit.undo", label: "Undo", accel: "Ctrl+Z" },
      { id: "edit.redo", label: "Redo", accel: "Shift+Ctrl+Z" },
      { sep: true },
      { exec: "cut", label: "Cut", accel: "Ctrl+X" },
      { exec: "copy", label: "Copy", accel: "Ctrl+C" },
      { exec: "paste", label: "Paste", accel: "Ctrl+V" },
      { exec: "selectAll", label: "Select All", accel: "Ctrl+A" },
      { sep: true },
      { id: "edit.copy_markdown", label: "Copy as Markdown", accel: "Shift+Ctrl+C" },
      { id: "edit.copy_html", label: "Copy as HTML Code" },
      { id: "edit.paste_plain", label: "Paste and Match Style", accel: "Ctrl+Shift+V" },
      { sep: true },
      { id: "edit.move_row_up", label: "Move Row Up", accel: "Alt+Up" },
      { id: "edit.move_row_down", label: "Move Row Down", accel: "Alt+Down" },
      { id: "edit.delete_range", label: "Delete Range", items: [{ id: "edit.delete_block", label: "Delete Block" }] },
      {
        id: "edit.selection",
        label: "Selection",
        items: [
          { id: "edit.select_block", label: "Select Block" },
          { id: "edit.select_line", label: "Select Line" },
          { id: "edit.select_word", label: "Select Word" },
        ],
      },
      { sep: true },
      { id: "edit.find", label: "Find…", accel: "Ctrl+F" },
      { id: "edit.find_next", label: "Find Next", accel: "Ctrl+G" },
      { id: "edit.replace", label: "Replace…", accel: "Alt+Ctrl+F" },
      { sep: true },
      {
        label: "Substitutions",
        items: [
          { id: "edit.smart_punctuation", label: "Smart Punctuation", type: "check", checked: () => smartPunctuation() },
        ],
      },
      { id: "edit.spellcheck", label: "Check Spelling While Typing", type: "check", checked: () => spellcheckOn() },
      { sep: true },
      {
        label: "Line Endings",
        items: [
          { id: "edit.line_ending.lf", label: "LF (Unix)", type: "radio", checked: () => lineEnding() === "lf" },
          { id: "edit.line_ending.crlf", label: "CRLF (Windows)", type: "radio", checked: () => lineEnding() === "crlf" },
        ],
      },
      {
        label: "Final Newline",
        items: [
          { id: "edit.final_newline.ensure", label: "Ensure Trailing Newline", type: "radio", checked: () => finalNewline() === "ensure" },
          { id: "edit.final_newline.preserve", label: "Preserve As-Is", type: "radio", checked: () => finalNewline() === "preserve" },
          { id: "edit.final_newline.trim", label: "Trim Trailing Newlines", type: "radio", checked: () => finalNewline() === "trim" },
        ],
      },
      {
        label: "Reopen with Encoding",
        items: [
          enc("utf-8", "UTF-8"),
          enc("utf8_bom", "UTF-8 with BOM"),
          enc("utf-16le", "UTF-16 LE"),
          enc("utf-16be", "UTF-16 BE"),
          { sep: true },
          enc("windows-1252", "Western (Windows-1252)"),
          enc("windows-1251", "Cyrillic (Windows-1251)"),
          enc("koi8-r", "Cyrillic (KOI8-R)"),
          enc("shift_jis", "Japanese (Shift_JIS)"),
          enc("euc-jp", "Japanese (EUC-JP)"),
          enc("gbk", "Chinese Simplified (GBK)"),
          enc("big5", "Chinese Traditional (Big5)"),
          enc("euc-kr", "Korean (EUC-KR)"),
        ],
      },
      {
        label: "Autosave Recovery",
        items: [
          { id: "edit.autosave.off", label: "Off", type: "radio", checked: () => autosaveInterval() === 0 },
          { id: "edit.autosave.5", label: "Every 5 seconds", type: "radio", checked: () => autosaveInterval() === 5 },
          { id: "edit.autosave.15", label: "Every 15 seconds", type: "radio", checked: () => autosaveInterval() === 15 },
          { id: "edit.autosave.30", label: "Every 30 seconds", type: "radio", checked: () => autosaveInterval() === 30 },
        ],
      },
      {
        label: "Whitespace and Line Breaks",
        items: [
          { id: "edit.preserve_breaks", label: "Preserve Single Line Breaks", type: "check", checked: () => preserveBreaks() },
        ],
      },
      {
        label: "Math Options",
        items: [
          { id: "edit.math.alt_delimiters", label: "LaTeX Delimiters  \\( \\)  \\[ \\]", type: "check", checked: () => mathAltDelimiters() },
          { id: "edit.math.fence", label: "Enable ```math Code Block", type: "check", checked: () => mathFence() },
        ],
      },
      {
        label: "Markdown Extensions",
        items: [
          { id: "edit.ext.highlight", label: "Highlight  ==text==", type: "check", checked: () => highlightEnabled() },
          { id: "edit.ext.sub_sup", label: "Subscript and Superscript", type: "check", checked: () => subSupEnabled() },
          { id: "edit.ext.emoji", label: "Emoji Shortcodes  :smile:", type: "check", checked: () => emojiEnabled() },
          { id: "edit.ext.autolink", label: "Auto-link Bare URLs", type: "check", checked: () => autolinkEnabled() },
        ],
      },
    ],
  },
  {
    label: "Paragraph",
    items: [
      { id: "paragraph.heading.1", label: "Heading 1", accel: "Ctrl+1" },
      { id: "paragraph.heading.2", label: "Heading 2", accel: "Ctrl+2" },
      { id: "paragraph.heading.3", label: "Heading 3", accel: "Ctrl+3" },
      { id: "paragraph.heading.4", label: "Heading 4", accel: "Ctrl+4" },
      { id: "paragraph.heading.5", label: "Heading 5", accel: "Ctrl+5" },
      { id: "paragraph.heading.6", label: "Heading 6", accel: "Ctrl+6" },
      { sep: true },
      { id: "paragraph.heading.0", label: "Paragraph", accel: "Ctrl+0" },
      { sep: true },
      { id: "paragraph.heading_up", label: "Increase Heading Level", accel: "Ctrl+Equal" },
      { id: "paragraph.heading_down", label: "Decrease Heading Level", accel: "Ctrl+Minus" },
      { sep: true },
      {
        id: "paragraph.table",
        label: "Table",
        items: [
          { id: "paragraph.table.insert", label: "Insert Table…", accel: "Alt+Ctrl+T" },
          { sep: true },
          { id: "paragraph.table.row_above", label: "Add Row Above" },
          { id: "paragraph.table.row_below", label: "Add Row Below" },
          { id: "paragraph.table.delete_row", label: "Delete Row" },
          { sep: true },
          { id: "paragraph.table.add_col", label: "Add Column" },
          { id: "paragraph.table.delete_col", label: "Delete Column" },
          { sep: true },
          { id: "paragraph.table.align_left", label: "Align Left" },
          { id: "paragraph.table.align_center", label: "Align Center" },
          { id: "paragraph.table.align_right", label: "Align Right" },
        ],
      },
      { id: "paragraph.math_block", label: "Math Block", accel: "Alt+Ctrl+B" },
      { id: "paragraph.code_fences", label: "Code Fences", accel: "Alt+Ctrl+C" },
      { sep: true },
      { id: "paragraph.quote", label: "Quote", accel: "Alt+Ctrl+Q" },
      { id: "paragraph.ordered_list", label: "Ordered List", accel: "Alt+Ctrl+O" },
      { id: "paragraph.unordered_list", label: "Unordered List", accel: "Alt+Ctrl+U" },
      { id: "paragraph.task_list", label: "Task List", accel: "Alt+Ctrl+X" },
      {
        id: "paragraph.task_status",
        label: "Task Status",
        items: [{ id: "paragraph.task_toggle", label: "Toggle Task Status", accel: "Alt+Ctrl+Enter" }],
      },
      {
        id: "paragraph.indentation",
        label: "List Indentation",
        items: [
          { id: "paragraph.indent", label: "Indent", accel: "Ctrl+BracketRight" },
          { id: "paragraph.outdent", label: "Outdent", accel: "Ctrl+BracketLeft" },
        ],
      },
      { sep: true },
      { id: "paragraph.insert_before", label: "Insert Paragraph Before" },
      { id: "paragraph.insert_after", label: "Insert Paragraph After" },
      { sep: true },
      { id: "paragraph.hr", label: "Horizontal Line", accel: "Alt+Ctrl+Minus" },
      { id: "paragraph.toc", label: "Table of Contents" },
      { id: "paragraph.front_matter", label: "YAML Front Matter" },
      { sep: true },
      { id: "paragraph.footnote", label: "Link Reference / Footnote", accel: "Alt+Ctrl+R" },
      {
        label: "Alert",
        items: [
          { id: "paragraph.alert.note", label: "Note" },
          { id: "paragraph.alert.tip", label: "Tip" },
          { id: "paragraph.alert.warning", label: "Warning" },
        ],
      },
    ],
  },
  {
    label: "Format",
    items: [
      { id: "format.strong", label: "Strong", accel: "Ctrl+B" },
      { id: "format.emphasis", label: "Emphasis", accel: "Ctrl+I" },
      { id: "format.underline", label: "Underline", accel: "Ctrl+U" },
      { id: "format.code", label: "Code", accel: "Ctrl+E" },
      { id: "format.strike", label: "Strike", accel: "Shift+Ctrl+X" },
      { id: "format.comment", label: "Comment", accel: "Ctrl+Minus" },
      { id: "format.inline_math", label: "Inline Math", accel: "Ctrl+M" },
      { sep: true },
      { id: "format.hyperlink", label: "Hyperlink", accel: "Shift+Ctrl+K" },
      {
        id: "format.link",
        label: "Hyperlink Actions",
        items: [
          { id: "format.link.open", label: "Open Link" },
          { id: "format.link.copy", label: "Copy Link Address" },
        ],
      },
      {
        label: "Image",
        items: [
          { id: "format.image.insert", label: "Insert Image…", accel: "Ctrl+Shift+I" },
          { sep: true },
          { id: "format.image.copy_to_folder", label: "When Insert Local Image: Copy to Assets Folder", type: "check", checked: () => copyImageToAssets() },
          { id: "format.image.root_path", label: "Use Image Root Path…" },
          { id: "format.image.upload", label: "Upload Image" },
        ],
      },
      { sep: true },
      { id: "format.clear", label: "Clear Format", accel: "Ctrl+Backslash" },
    ],
  },
  {
    label: "View",
    items: [
      { id: "app.settings", label: "Settings…", accel: "Ctrl+Comma" },
      { sep: true },
      { id: "view.source_mode", label: "Source Code Mode", type: "check", checked: () => sourceMode(), accel: "Ctrl+Slash" },
      { sep: true },
      { id: "view.focus_mode", label: "Focus Mode", type: "check", checked: () => focusMode(), accel: "F8" },
      { id: "view.typewriter_mode", label: "Typewriter Mode", type: "check", checked: () => typewriterMode(), accel: "F9" },
      { sep: true },
      { id: "view.sidebar", label: "Toggle Sidebar", type: "check", checked: () => sidebarOpen(), accel: "Shift+Ctrl+L" },
      { id: "view.outline", label: "Outline", accel: "Ctrl+Alt+1" },
      { id: "view.file_tree", label: "File Tree", accel: "Ctrl+Alt+3" },
      { sep: true },
      { id: "view.search", label: "Search", accel: "Shift+Ctrl+F" },
      { sep: true },
      { id: "view.zoom_actual", label: "Actual Size", accel: "Shift+Ctrl+0" },
      { id: "view.zoom_in", label: "Zoom In", accel: "Shift+Ctrl+Equal" },
      { id: "view.zoom_out", label: "Zoom Out", accel: "Shift+Ctrl+Minus" },
      { sep: true },
      { id: "view.always_on_top", label: "Always on Top", type: "check", checked: () => alwaysOnTop() },
      { id: "view.fullscreen", label: "Toggle Full Screen" },
    ],
  },
  { label: "Themes", items: themeItems },
  {
    label: "Window",
    items: [
      { id: "window.minimize", label: "Minimize" },
      { id: "window.maximize", label: "Zoom" },
    ],
  },
  {
    label: "Help",
    items: [
      { id: "help.about", label: "About Sarala" },
      { id: "help.check_updates", label: "Check for Updates…" },
    ],
  },
];

/** Every accelerator-bound command in the tree, for the shortcut engine.
 *  `exec` items are skipped — the webview owns Cut/Copy/Paste/Select-All keys. */
export function menuAccelerators(): { accel: string; id: string }[] {
  const out: { accel: string; id: string }[] = [];
  const walk = (items: MenuNode[]) => {
    for (const n of items) {
      if ("sep" in n || "dynamic" in n) continue;
      if (n.items) walk(n.items);
      if (n.accel && n.id && !n.exec) out.push({ accel: n.accel, id: n.id });
    }
  };
  for (const m of MENUS) walk(m.items);
  return out;
}
