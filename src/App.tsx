import { Show, createEffect, onMount, onCleanup } from "solid-js";
import Editor from "./components/Editor";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import SourceView from "./components/SourceView";
import QuickOpen from "./components/QuickOpen";
import FindBar from "./components/FindBar";
import TableDialog from "./components/TableDialog";
import ImageContextMenu from "./components/ImageContextMenu";
import PaletteSwitcher from "./components/PaletteSwitcher";
import AboutModal from "./components/AboutModal";
import SettingsModal from "./components/SettingsModal";
import ExportHtmlDialog from "./components/ExportHtmlDialog";
import ConflictBanner from "./components/ConflictBanner";
import { initSettings } from "./settings";
import {
  doc, theme, sourceMode, setSourceMode, sidebarOpen, setSidebarOpen,
  fileName, setActive, fileTree, folderName, THEMES, targetBlockIndex,
  spellcheckOn, smartPunctuation, preserveBreaks, lineEnding, copyImageToAssets,
  focusMode, typewriterMode, alwaysOnTop, zoom, tableFullWidth,
  mathAltDelimiters, mathFence, bumpMermaidEpoch,
  emojiEnabled, highlightEnabled, subSupEnabled, autolinkEnabled,
  finalNewline, autosaveInterval, setExternalChange,
} from "./store";
import {
  isTauri, setMenuChecked, setMenuEnabled, confirmDialog, IMAGE_EXTS,
  onExternalChange,
} from "./platform";
import {
  executeCommand, openFile, openFolder, insertImageFromPath,
} from "./commands";
import { startAutosave, findRecoverable, restoreSession, shadowBaseName } from "./autosave";

export default function App() {
  let editorEl: HTMLDivElement | undefined;

  const jumpTo = (blockIndex: number) => {
    setActive(-1);
    const el = editorEl?.querySelectorAll(".block")[blockIndex];
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Browser fallback only: in Tauri these chords are native menu accelerators,
  // which dispatch through the "menu" event; handling both would double-fire.
  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "z") { e.preventDefault(); executeCommand(e.shiftKey ? "edit.redo" : "edit.undo"); }
    if (k === "s") { e.preventDefault(); executeCommand("file.save"); }
    if (k === "o" && e.shiftKey) { e.preventDefault(); executeCommand("file.open_folder"); }
    else if (k === "o") { e.preventDefault(); executeCommand("file.open"); }
    if (k === "/") { e.preventDefault(); executeCommand("view.source_mode"); }
    if (k === "l" && e.shiftKey) { e.preventDefault(); executeCommand("view.sidebar"); }
    if (k === "e" && e.shiftKey) { e.preventDefault(); executeCommand("file.export.html"); }
    if (k === "p" && e.shiftKey) { e.preventDefault(); executeCommand("file.open_quickly"); }
    if (k === "f" && e.altKey) { e.preventDefault(); executeCommand("edit.replace"); }
    else if (k === "f" && !e.shiftKey) { e.preventDefault(); executeCommand("edit.find"); }
    if (k === "g") { e.preventDefault(); executeCommand("edit.find_next"); }
    if (k === "v" && e.shiftKey) { e.preventDefault(); executeCommand("edit.paste_plain"); }
  };

  onMount(() => {
    void initSettings();
    if (isTauri) {
      let unlisten: (() => void) | undefined;
      import("@tauri-apps/api/event").then(async ({ listen }) => {
        unlisten = await listen<string>("menu", (e) => executeCommand(e.payload));
      });
      // Dropped image files insert through the same path as Insert Image….
      let undrop: (() => void) | undefined;
      import("@tauri-apps/api/webviewWindow").then(async ({ getCurrentWebviewWindow }) => {
        undrop = await getCurrentWebviewWindow().onDragDropEvent((e) => {
          if (e.payload.type !== "drop") return;
          for (const path of e.payload.paths) {
            const ext = path.split(".").pop()?.toLowerCase() ?? "";
            if (IMAGE_EXTS.includes(ext)) void insertImageFromPath(path);
            else if (["md", "markdown", "txt"].includes(ext)) void openFile(path);
          }
        });
      });
      // Confirm before closing a window with unsaved changes.
      let unclose: (() => void) | undefined;
      import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        unclose = await win.onCloseRequested(async (event) => {
          if (!doc.dirty) return;
          event.preventDefault();
          if (await confirmDialog(`Discard unsaved changes to ${fileName()}?`)) {
            await win.destroy();
          }
        });

        // Crash recovery runs once, in the initial window (new windows carry a
        // "main-<ts>" label), so user-opened windows don't re-prompt.
        if (win.label === "main") {
          const cands = await findRecoverable();
          if (cands.length) {
            const newest = cands[0];
            const extra = cands.length > 1
              ? ` (and ${cands.length - 1} more — open those files to recover them)`
              : "";
            const ok = await confirmDialog(
              `Unsaved changes from a previous session were found for ${shadowBaseName(newest.path)}${extra}. Restore them now?`,
            );
            if (ok) await restoreSession(newest);
          }
        }
      });

      // Reload-or-keep conflict banner: surface the Rust watcher's events.
      let unwatch: (() => void) | undefined;
      onExternalChange((path, deleted) => setExternalChange({ path, deleted })).then((u) => {
        unwatch = u;
      });

      // Autosave shadows of dirty (saved) documents.
      startAutosave();

      onCleanup(() => { unlisten?.(); undrop?.(); unclose?.(); unwatch?.(); });
    } else {
      window.addEventListener("keydown", onKey);
      onCleanup(() => window.removeEventListener("keydown", onKey));
    }
  });

  // Window title: "Notes.md — Edited".
  createEffect(() => {
    const title = `${fileName()}${doc.dirty ? " — Edited" : ""}`;
    if (isTauri) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow().setTitle(`${title} — Sarala`).catch(() => {})
      );
    } else {
      document.title = `${title} — Sarala`;
    }
  });

  // Keep native check/radio menu items in sync with frontend state.
  createEffect(() => setMenuChecked("view.source_mode", sourceMode()));
  createEffect(() => setMenuChecked("view.sidebar", sidebarOpen()));
  createEffect(() => {
    const current = theme();
    for (const id of THEMES) setMenuChecked(`themes.set.${id}`, id === current);
  });
  createEffect(() => setMenuChecked("edit.spellcheck", spellcheckOn()));
  createEffect(() => setMenuChecked("format.image.copy_to_folder", copyImageToAssets()));
  createEffect(() => setMenuChecked("view.focus_mode", focusMode()));
  createEffect(() => setMenuChecked("view.typewriter_mode", typewriterMode()));
  createEffect(() => setMenuChecked("view.always_on_top", alwaysOnTop()));

  // Selection-dependent enabling: block-targeted items are disabled until
  // some block has held the caret (then targetBlockIndex keeps them valid).
  const BLOCK_TARGETED_IDS = [
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
  ];
  let lastBlockEnabled: boolean | null = null;
  createEffect(() => {
    void doc.activeIndex;
    const enabled = targetBlockIndex() >= 0;
    if (enabled === lastBlockEnabled) return;
    lastBlockEnabled = enabled;
    for (const id of BLOCK_TARGETED_IDS) void setMenuEnabled(id, enabled);
  });

  // Typewriter mode: keep the line being edited vertically centered.
  createEffect(() => {
    if (!typewriterMode()) return;
    const i = doc.activeIndex;
    if (i < 0) return;
    void doc.blocks[i]?.text; // re-center as the user types
    requestAnimationFrame(() => {
      editorEl?.querySelectorAll(".block")[i]?.scrollIntoView({ block: "center" });
    });
  });
  createEffect(() => setMenuChecked("edit.smart_punctuation", smartPunctuation()));
  createEffect(() => setMenuChecked("edit.preserve_breaks", preserveBreaks()));
  createEffect(() => setMenuChecked("edit.math.alt_delimiters", mathAltDelimiters()));
  createEffect(() => setMenuChecked("edit.math.fence", mathFence()));
  createEffect(() => setMenuChecked("edit.ext.highlight", highlightEnabled()));
  createEffect(() => setMenuChecked("edit.ext.sub_sup", subSupEnabled()));
  createEffect(() => setMenuChecked("edit.ext.emoji", emojiEnabled()));
  createEffect(() => setMenuChecked("edit.ext.autolink", autolinkEnabled()));
  // Re-render mermaid diagrams when the theme switches (dark/light).
  createEffect(() => { theme(); bumpMermaidEpoch(); });
  createEffect(() => {
    const le = lineEnding();
    void setMenuChecked("edit.line_ending.lf", le === "lf");
    void setMenuChecked("edit.line_ending.crlf", le === "crlf");
  });
  createEffect(() => {
    const fn = finalNewline();
    void setMenuChecked("edit.final_newline.ensure", fn === "ensure");
    void setMenuChecked("edit.final_newline.preserve", fn === "preserve");
    void setMenuChecked("edit.final_newline.trim", fn === "trim");
  });
  createEffect(() => {
    const s = autosaveInterval();
    void setMenuChecked("edit.autosave.off", s === 0);
    void setMenuChecked("edit.autosave.5", s === 5);
    void setMenuChecked("edit.autosave.15", s === 15);
    void setMenuChecked("edit.autosave.30", s === 30);
  });
  // Reflect the open document's encoding in the Reopen-with-Encoding radio.
  createEffect(() => {
    const enc = doc.encoding.toLowerCase();
    void setMenuChecked("edit.encoding.utf-8", enc === "utf-8" && !doc.hadBom);
    void setMenuChecked("edit.encoding.utf8_bom", enc === "utf-8" && doc.hadBom);
  });

  return (
    <div
      class="app"
      data-theme={theme()}
      classList={{ "focus-mode": focusMode(), "tables-full": tableFullWidth(), "is-tauri": isTauri }}
      style={{ "--zoom": `${zoom()}%` }}
    >
      {/* Full-width top bar: filename + status dot left, Live/Source right. */}
      <header class="topbar" data-tauri-drag-region>
        {/* Non-draggable gap over the native macOS traffic lights — a drag
            region here would swallow their clicks (close/minimize/zoom). */}
        {isTauri && <span class="topbar-traffic" aria-hidden="true" />}
        <button
          class="topbar-toggle"
          title="Toggle sidebar (Shift+Cmd/Ctrl+L)"
          onClick={() => setSidebarOpen(!sidebarOpen())}
        >☰</button>
        <span class="topbar-file">
          <span class="topbar-dot" classList={{ dirty: doc.dirty }} />
          {fileName()}
        </span>
        <span class="spacer" />
        <div class="view-toggle">
          <button classList={{ on: !sourceMode() }} onClick={() => setSourceMode(false)}>Live</button>
          <button classList={{ on: sourceMode() }} onClick={() => setSourceMode(true)}>Source</button>
        </div>
      </header>
      <div class="body">
        <Show when={sidebarOpen()}>
          <Sidebar
            tree={fileTree()}
            folderName={folderName()}
            onOpenFolder={openFolder}
            onOpenFile={openFile}
            onJump={jumpTo}
          />
        </Show>
        <main class="main">
          <FindBar />
          <ConflictBanner />
          <div class="scroll" ref={editorEl}>
            <Show when={!sourceMode()} fallback={<SourceView />}>
              <Editor />
            </Show>
          </div>
          <StatusBar />
        </main>
      </div>
      <PaletteSwitcher />
      <QuickOpen />
      <TableDialog />
      <ImageContextMenu />
      <AboutModal />
      <SettingsModal />
      <ExportHtmlDialog />
    </div>
  );
}
