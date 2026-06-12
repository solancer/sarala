import { Show, createEffect, onMount, onCleanup } from "solid-js";
import Editor from "./components/Editor";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import SourceView from "./components/SourceView";
import QuickOpen from "./components/QuickOpen";
import FindBar from "./components/FindBar";
import TableDialog from "./components/TableDialog";
import { initSettings } from "./settings";
import {
  doc, theme, sourceMode, sidebarOpen, setSidebarOpen,
  fileName, setActive, fileTree, folderName, THEMES,
  spellcheckOn, smartPunctuation, preserveBreaks, lineEnding, copyImageToAssets,
} from "./store";
import { isTauri, setMenuChecked, IMAGE_EXTS } from "./platform";
import {
  executeCommand, openFile, openFolder, save, exportHtml, insertImageFromPath,
} from "./commands";

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
      onCleanup(() => { unlisten?.(); undrop?.(); });
    } else {
      window.addEventListener("keydown", onKey);
      onCleanup(() => window.removeEventListener("keydown", onKey));
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
  createEffect(() => setMenuChecked("edit.smart_punctuation", smartPunctuation()));
  createEffect(() => setMenuChecked("edit.preserve_breaks", preserveBreaks()));
  createEffect(() => {
    const le = lineEnding();
    void setMenuChecked("edit.line_ending.lf", le === "lf");
    void setMenuChecked("edit.line_ending.crlf", le === "crlf");
  });

  return (
    <div class="app" data-theme={theme()}>
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
        <header class="titlebar">
          <button class="ghost-btn" title="Toggle sidebar (Shift+Cmd/Ctrl+L)" onClick={() => setSidebarOpen(!sidebarOpen())}>☰</button>
          <span class="title">
            {fileName()}
            <Show when={doc.dirty}><span class="dirty" title="Unsaved changes">●</span></Show>
          </span>
          <span class="spacer" />
          <button class="ghost-btn" onClick={() => openFile()}>Open</button>
          <button class="ghost-btn" onClick={save}>Save</button>
          <button class="ghost-btn" onClick={exportHtml}>Export HTML</button>
        </header>
        <FindBar />
        <div class="scroll" ref={editorEl}>
          <Show when={!sourceMode()} fallback={<SourceView />}>
            <Editor />
          </Show>
        </div>
        <StatusBar />
      </main>
      <QuickOpen />
      <TableDialog />
    </div>
  );
}
