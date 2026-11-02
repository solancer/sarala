/** The web implementation of the seam in src/platform.ts. */
import { createRoot } from "solid-js";
import type { EncodedDoc, FileNode, FolderSearchHit, FolderSearchOptions, WebPlatform } from "../../src/platform";
import { alertDialog, confirmDialog } from "../../src/platform";
import { doc, fileName as currentName, fullText, openDocument, requestCaret, setActive, setFileTree, setFolderName, setFolderPath, setSidebarOpen } from "../../src/store";
import { docDir, currentFrontMatter } from "../../src/images";
import { buildSearchRegex, matchLines, MAX_PER_FILE, MAX_TOTAL } from "../../src/search";
import * as db from "./db";
import { decode, encode } from "./encoding";
import { backupLibrary, restoreLibrary } from "./backup";
import { askFolder, askSavePath, Overlays } from "./components/dialogs";
import StoragePanel from "./components/StoragePanel";
import { fontFaces, listFonts } from "./fonts";
import { imageUrl, inlineImages, preloadImages } from "./images";
import { downloadPandoc, hasPandoc, holdImport, pandocExport, pandocImport } from "./pandoc";
import { importFile, pickFolderToAdd, pickMarkdownFile, pickWith } from "./pickers";
import { exportPdf } from "./print";
import { checkForUpdates, registerServiceWorker } from "./pwa";
import { restoreSession, startSnapshots } from "./session";
import { WELCOME } from "./welcome";
import * as vfs from "./vfs";

const { DOWNLOADS, LIBRARY } = vfs;

// A tab never hands these to the page. An installed app's window does.
const accelWorks = (accel: string) =>
  !/^(Shift\+)?Ctrl\+[NTW]$/.test(accel) || matchMedia("(display-mode: standalone)").matches;

// `voice` alone is the Edit submenu. Its commands stay in the palette and Settings.
const HIDDEN = /^(ai\.|voice$|edit\.autosave|window\.(minimize|maximize)$|view\.always_on_top$)/;

async function readDoc(path: string, label = ""): Promise<EncodedDoc> {
  return decode(new Uint8Array(await (await vfs.read(path)).arrayBuffer()), label);
}

async function search(root: string, query: string, opts: FolderSearchOptions): Promise<FolderSearchHit[]> {
  const re = buildSearchRegex(query, opts);
  if (!re) return [];
  const files: FileNode[] = [];
  const collect = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (n.is_dir) collect(n.children ?? []);
      else files.push(n);
    }
  };
  collect(await vfs.tree());
  const hits: FolderSearchHit[] = [];
  let total = 0;
  for (const file of files) {
    if (total >= MAX_TOTAL) break;
    const text = await vfs.read(file.path, true).then((b) => b.text()).catch(() => null);
    if (text === null) continue;
    const matches = matchLines(text, re, Math.min(MAX_PER_FILE, MAX_TOTAL - total));
    total += matches.length;
    if (matches.length) hits.push({ path: file.path, name: file.name, matches });
  }
  return hits;
}

/** Where a new image for this document goes: its own folder when that can be
 *  written, honouring the copy-images-to rule, else the library. */
async function storeImage(file: File): Promise<string> {
  const dir = docDir();
  const base = dir && vfs.isWritableDir(dir) ? dir : LIBRARY;
  const fm = currentFrontMatter();
  const subfolder = (fm["copy-images-to"] ?? fm["typora-copy-images-to"] ?? "assets")
    .replace(/\$\{filename\}/g, currentName().replace(/\.[^.]+$/, ""));
  const named = file.name && file.name !== "image.png"
    ? file
    : new File([file], `image-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.${file.type.split("/")[1]?.split("+")[0] ?? "png"}`, { type: file.type });
  return importFile(named, `${base}/${subfolder}`);
}

function installDrop() {
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
  window.addEventListener("dragover", (e) => {
    if (hasFiles(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; }
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const items = [...e.dataTransfer!.items].filter((i) => i.kind === "file");
    // getAsFile and getAsFileSystemHandle work only during the event itself.
    const dropped = items.map((item) => ({ file: item.getAsFile(), handle: item.getAsFileSystemHandle?.() ?? null }));
    void (async () => {
      const { insertImageFromPath, openFile, refreshTree } = await import("../../src/commands");
      for (const { file, handle } of dropped) {
        const h = await handle?.catch(() => null);
        if (h?.kind === "directory") {
          await vfs.mountFolder(h as FileSystemDirectoryHandle);
          await h.requestPermission({ mode: "readwrite" }).catch(() => {});
          await refreshTree();
        } else if (file?.type.startsWith("image/")) {
          await insertImageFromPath(await storeImage(file));
        } else if (file && /\.(md|markdown|mdown|txt)$/i.test(file.name)) {
          await openFile(h ? await vfs.mountFile(h as FileSystemFileHandle) : await importFile(file));
        }
      }
    })().catch((error) => alertDialog(String(error)));
  }, true);
}

/** Files handed over by the OS to the installed app ("Open With"). */
function installFileHandler() {
  window.launchQueue?.setConsumer(async ({ files }) => {
    const { openFile } = await import("../../src/commands");
    for (const handle of files) await openFile(await vfs.mountFile(handle));
  });
}

async function start() {
  await vfs.initVfs();
  setFolderPath(LIBRARY);
  setFolderName("Library");
  // On a phone the sidebar would cover the page: it opens when asked for.
  if (window.innerWidth <= 640) setSidebarOpen(false);
  setFileTree(await vfs.tree());
  const restored = await restoreSession();
  if (!restored && !(await db.get("kv", "welcomed"))) {
    await db.put("kv", true, "welcomed");
    const path = `${LIBRARY}/Welcome.md`;
    await vfs.write(path, new Blob([WELCOME]));
    openDocument(WELCOME, path);
    await vfs.watch(path);
  }
  startSnapshots();
  installDrop();
  installFileHandler();
  await registerServiceWorker();
}

export const platform: WebPlatform = {
  version: __SARALA_VERSION__,
  pickMarkdownFile,
  pickFolder: () => askFolder("Choose a folder"),
  async addFolder() {
    const path = await pickFolderToAdd();
    if (path && vfs.isLibrary(path)) await alertDialog("This browser can't edit folders on your device, so the files were copied into your library.");
    return path;
  },
  async pickSavePath(defaultName, title = "Save") {
    const slash = defaultName.lastIndexOf("/");
    const dir = slash >= 0 ? defaultName.slice(0, slash) : docDir();
    // A dialog in the page takes focus, which ends editing in the block. A
    // native one doesn't, so put the caret back and typing simply carries on.
    const { getActiveBlockApi } = await import("../../src/commands");
    const block = doc.activeIndex;
    const caret = getActiveBlockApi()?.caretOffset() ?? 0;
    const path = await askSavePath(defaultName.slice(slash + 1), dir && vfs.isWritableDir(dir) ? dir : LIBRARY, title);
    if (block >= 0 && block < doc.blocks.length) {
      requestCaret(caret);
      setActive(block);
    }
    return path;
  },
  exportPath: (name) => `${DOWNLOADS}/${name}`,
  async pickImportFile() {
    const file = await pickWith(".docx,.epub,.rst,.org,.odt,.html,.tex");
    if (!file) return null;
    holdImport(file);
    return file.name;
  },
  async pickImageFile() {
    const file = await pickWith("image/*");
    return file ? storeImage(file) : null;
  },
  pathExists: vfs.exists,
  readFileEncoded: (path) => readDoc(path),
  reopenWithEncoding: readDoc,
  async writeTextFile(path, contents, encoding, bom) {
    await vfs.write(path, await encode(contents, encoding, bom));
  },
  watchFile: vfs.watch,
  unwatchFile: vfs.unwatch,
  onExternalChange: vfs.onExternal,
  watchTree: () => vfs.tree(),
  onTreeChange: (fn) => vfs.onTree((tree) => fn(LIBRARY, tree)),
  searchInFolder: search,
  blockedFolders: () => vfs.needsAccess().map((m) => m.name),
  reconnectFolders: vfs.reconnectAll,
  async copyAsset(src, dir, subfolder) {
    const name = vfs.fileName(src);
    if (!vfs.isWritableDir(dir)) return src;
    const target = `${dir}/${subfolder}`;
    // A picked or pasted image is stored in place, so usually nothing moves.
    if (vfs.dirName(src) === target) return `${subfolder}/${name}`;
    const path = await vfs.uniquePath(target, name);
    await vfs.write(path, await vfs.read(src));
    return `${subfolder}/${vfs.fileName(path)}`;
  },
  renameFile: vfs.move,
  async copyFileTo(src, dest) {
    const path = await vfs.uniquePath(dest, vfs.fileName(src));
    await vfs.write(path, await vfs.read(src));
    return path;
  },
  deleteFile: vfs.remove,
  hasPandoc,
  downloadPandoc,
  pandocImport,
  pandocExport,
  exportPdf,
  async openExternal(url) {
    if (url.startsWith("/")) {
      // A workspace file that isn't a document: show it in a new tab.
      window.open(URL.createObjectURL(await vfs.read(url)), "_blank", "noopener");
      return;
    }
    window.open(url, "_blank", "noopener");
  },
  imageUrl,
  preloadImages,
  inlineImages,
  storeImage,
  listFonts,
  fontFaces,
  checkForUpdates,
  hidden: (id) => HIDDEN.test(id),
  accelWorks,
  commands: {
    async "web.download_markdown"() {
      await vfs.write(`${DOWNLOADS}/${currentName()}`, await encode(fullText(), doc.encoding, doc.hadBom));
    },
    "web.backup": backupLibrary,
    async "web.restore"() {
      const file = await pickWith(".zip,application/zip");
      if (!file) return;
      if (await confirmDialog(`Restore the library from ${file.name}?`)) await restoreLibrary(file).catch((e) => alertDialog(String(e)));
    },
  },
  menuItems: {
    File: [
      { id: "web.download_markdown", label: "Download Markdown" },
      { id: "web.backup", label: "Back Up Library…" },
      { id: "web.restore", label: "Restore Library…" },
    ],
  },
  start: () => { void start().catch((error) => alertDialog(`Sarala could not start:\n${String(error)}`)); },
  overlays: () => createRoot(() => Overlays()),
  storagePanel: StoragePanel,
};
