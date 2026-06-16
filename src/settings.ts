import { isTauri } from "./platform";
import {
  setSpellcheckOn, setSmartPunctuation, setPreserveBreaks, setLineEnding,
  setFinalNewline, setAutosaveInterval,
  setCopyImageToAssets, setCopyImagesToFolder, setTableFullWidth, bumpRenderEpoch,
  setTheme, setZoom, clampZoom, THEMES, type ThemeId,
  setSidebarWidth, clampSidebar,
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
  lastExport: ExportMemo | null;
  exportPresets: ExportPreset[];
  pdfExport: PdfOptions;
  [key: string]: unknown;
}

const DEFAULT_PDF: PdfOptions = {
  // margin "0" → full-bleed: the theme background reaches the page edges (text
  // inset via padding). Set a non-zero margin to get @page header/footer.
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

export function recentFiles(): string[] {
  return data.recentFiles;
}

export async function addRecentFile(path: string): Promise<void> {
  data.recentFiles = [path, ...data.recentFiles.filter((p) => p !== path)].slice(0, 10);
  await persist();
  await syncRecentMenu();
}

export async function clearRecentFiles(): Promise<void> {
  data.recentFiles = [];
  await persist();
  await syncRecentMenu();
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
