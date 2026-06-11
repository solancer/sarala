import { Show, createSignal, onMount, onCleanup } from "solid-js";
import Editor from "./components/Editor";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import SourceView from "./components/SourceView";
import {
  doc, theme, sourceMode, setSourceMode, sidebarOpen, setSidebarOpen,
  fileName, fullText, loadDocument, markSaved, setActive,
} from "./store";
import {
  isTauri, pickFolder, pickMarkdownFile, pickSavePath,
  readTextFile, writeTextFile, listDirectory, type FileNode,
} from "./platform";
import { renderMarkdown } from "./markdown";

export default function App() {
  const [tree, setTree] = createSignal<FileNode[]>([]);
  const [folderName, setFolderName] = createSignal<string | null>(null);
  let editorEl: HTMLDivElement | undefined;

  const openFolder = async () => {
    const path = await pickFolder();
    if (!path) return;
    setFolderName(path.replace(/\\/g, "/").split("/").pop() ?? path);
    setTree(await listDirectory(path));
  };

  const openFile = async (path?: string) => {
    const p = path ?? (await pickMarkdownFile());
    if (!p) return;
    loadDocument(await readTextFile(p), p);
  };

  const save = async () => {
    let path = doc.filePath;
    if (!path) path = await pickSavePath(fileName());
    if (!path && isTauri) return;
    await writeTextFile(path ?? fileName(), fullText());
    if (path) markSaved(path);
  };

  const exportHtml = async () => {
    const css = await fetch(new URL("./styles/export.css", import.meta.url)).then((r) => r.text()).catch(() => "");
    const body = renderMarkdown(fullText());
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${fileName()}</title><style>${css}</style></head><body data-theme="${theme()}"><article class="rendered">${body}</article></body></html>`;
    const out = await pickSavePath(fileName().replace(/\.(md|markdown|txt)$/i, "") + ".html");
    await writeTextFile(out ?? fileName() + ".html", html);
  };

  const jumpTo = (blockIndex: number) => {
    setActive(-1);
    const el = editorEl?.querySelectorAll(".block")[blockIndex];
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "s") { e.preventDefault(); save(); }
    if (k === "o" && e.shiftKey) { e.preventDefault(); openFolder(); }
    else if (k === "o") { e.preventDefault(); openFile(); }
    if (k === "/") { e.preventDefault(); setSourceMode(!sourceMode()); }
    if (k === "\\") { e.preventDefault(); setSidebarOpen(!sidebarOpen()); }
    if (k === "e" && e.shiftKey) { e.preventDefault(); exportHtml(); }
  };

  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="app" data-theme={theme()}>
      <Show when={sidebarOpen()}>
        <Sidebar
          tree={tree()}
          folderName={folderName()}
          onOpenFolder={openFolder}
          onOpenFile={openFile}
          onJump={jumpTo}
        />
      </Show>
      <main class="main">
        <header class="titlebar">
          <button class="ghost-btn" title="Toggle sidebar (Cmd/Ctrl+\\)" onClick={() => setSidebarOpen(!sidebarOpen())}>☰</button>
          <span class="title">
            {fileName()}
            <Show when={doc.dirty}><span class="dirty" title="Unsaved changes">●</span></Show>
          </span>
          <span class="spacer" />
          <button class="ghost-btn" onClick={() => openFile()}>Open</button>
          <button class="ghost-btn" onClick={save}>Save</button>
          <button class="ghost-btn" onClick={exportHtml}>Export HTML</button>
        </header>
        <div class="scroll" ref={editorEl}>
          <Show when={!sourceMode()} fallback={<SourceView />}>
            <Editor />
          </Show>
        </div>
        <StatusBar />
      </main>
    </div>
  );
}
