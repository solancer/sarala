import { createSignal } from "solid-js";
import { isTauri } from "./platform";
import {
  setSpellcheckOn, setSmartPunctuation, setPreserveBreaks, setLineEnding,
  setFinalNewline, setAutosaveInterval,
  setCopyImageToAssets, setCopyImagesToFolder, setTableFullWidth, bumpRenderEpoch,
  setTheme, setZoom, clampZoom, THEMES, type ThemeId,
  setSidebarWidth, clampSidebar, setStatusBarVisible,
  setMathAltDelimitersSig, setMathFenceSig,
  setEmojiEnabledSig, setHighlightEnabledSig, setSubSupEnabledSig, setAutolinkEnabledSig,
  setProseFont, setMonoFont,
} from "./store";
import { applyProseFont, applyMonoFont } from "./fonts";
import {
  setPreserveBreaksOption, setMathAltDelimiters, setMathFence,
  setEmojiEnabled, setHighlightEnabled, setSubSupEnabled, setAutolinkEnabled,
} from "./markdown";
import { setLiveHighlight, setLiveSubSup } from "./livesource";
import type { ExportPreset, PdfOptions } from "./export";

export interface ExportMemo {
  /** Menu id of the export command, e.g. "file.export.docx". */
  id: string;
  path: string;
  /** Set when the last export was a named preset (Export with Previous re-runs it). */
  presetName?: string;
}

interface SettingsData {
  recentFiles: string[];
  pinnedFiles: string[];
  lastExport: ExportMemo | null;
  exportPresets: ExportPreset[];
  pdfExport: PdfOptions;
  [key: string]: unknown;
}

const DEFAULT_PDF: PdfOptions = {
  // margin "0" → full-bleed: the theme background fills every page edge-to-edge.
  // On WebKit the @page margin area (and the page canvas under a non-zero
  // margin) can't take the theme colour, so a non-zero margin would leave white
  // bands. Default to full-bleed so the background stays consistent; a non-zero
  // margin (framed, with page-break spacing) is available for those who want it.
  pageSize: "A4",
  margin: "0",
  header: "",
  footer: "${title}    ${pageNo} / ${totalPages}",
};

const DEFAULT_PRESETS: ExportPreset[] = [
  { name: "PDF (reveal)", format: "pdf", after: "reveal" },
  { name: "Word + open", format: "docx", after: "open" },
];

const DEFAULTS: SettingsData = {
  recentFiles: [],
  pinnedFiles: [],
  lastExport: null,
  exportPresets: DEFAULT_PRESETS,
  pdfExport: DEFAULT_PDF,
};
const STORAGE_KEY = "sarala.settings";

let data: SettingsData = { ...DEFAULTS };

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounced write-behind: rapid toggles coalesce into one disk write. */
async function persist(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_settings", { value: data }).catch(() => {});
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  }, 300);
}

async function syncRecentMenu(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("update_recent_menu", { paths: data.recentFiles }).catch(() => {});
}

async function syncExportMenu(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const names = (data.exportPresets ?? []).map((p) => p.name);
  await invoke("update_export_menu", { names }).catch(() => {});
}

export async function initSettings(): Promise<void> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const loaded = await invoke<Partial<SettingsData>>("load_settings").catch(() => ({}));
    data = { ...DEFAULTS, ...loaded };
  } else {
    try {
      data = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
    } catch {
      data = { ...DEFAULTS };
    }
  }
  await syncRecentMenu();
  await syncExportMenu();
  hydrateStore();
}

/** Push persisted toggles into the reactive store on startup. */
function hydrateStore() {
  setRecentSig(Array.isArray(data.recentFiles) ? data.recentFiles : []);
  setPinnedSig(Array.isArray(data.pinnedFiles) ? data.pinnedFiles : []);
  setSpellcheckOn(getSetting("spellcheck", true));
  setSmartPunctuation(getSetting("smartPunctuation", false));
  setLineEnding(getSetting<"lf" | "crlf">("lineEnding", "lf"));
  setFinalNewline(getSetting<"ensure" | "preserve" | "trim">("finalNewline", "ensure"));
  setAutosaveInterval(getSetting("autosaveInterval", 5));
  setCopyImageToAssets(getSetting("copyImageToAssets", false));
  setCopyImagesToFolder(getSetting("copyImagesToFolder", "assets"));
  setTableFullWidth(getSetting("tableFullWidth", false));
  const savedTheme = getSetting<string>("theme", "sarala");
  if ((THEMES as readonly string[]).includes(savedTheme)) setTheme(savedTheme as ThemeId);
  setZoom(clampZoom(getSetting("zoom", 100)));
  setSidebarWidth(clampSidebar(getSetting("sidebarWidth", 240)));
  setStatusBarVisible(getSetting("statusBarVisible", true));
  const altDelim = getSetting("mathAltDelimiters", false);
  setMathAltDelimitersSig(altDelim);
  setMathAltDelimiters(altDelim);
  const mFence = getSetting("mathFence", false);
  setMathFenceSig(mFence);
  setMathFence(mFence);
  const breaks = getSetting("preserveBreaks", false);
  setPreserveBreaks(breaks);
  setPreserveBreaksOption(breaks);
  const emoji = getSetting("emojiEnabled", true);
  setEmojiEnabledSig(emoji);
  setEmojiEnabled(emoji);
  const highlight = getSetting("highlightEnabled", true);
  setHighlightEnabledSig(highlight);
  setHighlightEnabled(highlight);
  setLiveHighlight(highlight);
  const subSup = getSetting("subSupEnabled", true);
  setSubSupEnabledSig(subSup);
  setSubSupEnabled(subSup);
  setLiveSubSup(subSup);
  const autolink = getSetting("autolinkEnabled", true);
  setAutolinkEnabledSig(autolink);
  setAutolinkEnabled(autolink);
  const prose = getSetting<string | null>("proseFont", null);
  setProseFont(prose);
  applyProseFont(prose);
  const mono = getSetting<string | null>("monoFont", null);
  setMonoFont(mono);
  applyMonoFont(mono);
  bumpRenderEpoch();
}

export function getSetting<T>(key: string, fallback: T): T {
  return (data[key] as T | undefined) ?? fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  data[key] = value;
  await persist();
}

// Recent + pinned are mirrored into signals so the sidebar re-renders on change
// (the underlying `data` object is plain and not reactive).
const [recentSig, setRecentSig] = createSignal<string[]>([]);
const [pinnedSig, setPinnedSig] = createSignal<string[]>([]);

export function recentFiles(): string[] {
  return recentSig();
}

export async function addRecentFile(path: string): Promise<void> {
  // Leave a file that's already listed in place — reopening a Recent entry
  // shouldn't make it jump to the top under the user's cursor. Only files not
  // yet in the list are added, at the front (newest first).
  if (data.recentFiles.includes(path)) return;
  data.recentFiles = [path, ...data.recentFiles].slice(0, 10);
  setRecentSig(data.recentFiles);
  await persist();
  await syncRecentMenu();
}

export async function clearRecentFiles(): Promise<void> {
  data.recentFiles = [];
  setRecentSig([]);
  await persist();
  await syncRecentMenu();
}

/** Pinned files, most-recently-pinned first. Reactive. */
export function pinnedFiles(): string[] {
  return pinnedSig();
}
export function isPinned(path: string): boolean {
  return pinnedSig().includes(path);
}
export async function togglePin(path: string): Promise<void> {
  data.pinnedFiles = pinnedSig().includes(path)
    ? pinnedSig().filter((p) => p !== path)
    : [path, ...pinnedSig()];
  setPinnedSig(data.pinnedFiles);
  await persist();
}
export async function clearPinned(): Promise<void> {
  data.pinnedFiles = [];
  setPinnedSig([]);
  await persist();
}

export function lastExport(): ExportMemo | null {
  return data.lastExport;
}

export async function setLastExport(memo: ExportMemo): Promise<void> {
  data.lastExport = memo;
  await persist();
}

export function exportPresets(): ExportPreset[] {
  return data.exportPresets ?? [];
}

export function pdfOptions(): PdfOptions {
  return { ...DEFAULT_PDF, ...data.pdfExport };
}
