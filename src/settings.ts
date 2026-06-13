import { isTauri } from "./platform";
import {
  setSpellcheckOn, setSmartPunctuation, setPreserveBreaks, setLineEnding,
  setCopyImageToAssets, setCopyImagesToFolder, setTableFullWidth, bumpRenderEpoch,
  setTheme, setZoom, clampZoom, THEMES, type ThemeId,
  setSidebarWidth, clampSidebar,
  setMathAltDelimitersSig, setMathFenceSig,
} from "./store";
import { setPreserveBreaksOption, setMathAltDelimiters, setMathFence } from "./markdown";

export interface ExportMemo {
  /** Menu id of the export command, e.g. "file.export.docx". */
  id: string;
  path: string;
}

interface SettingsData {
  recentFiles: string[];
  lastExport: ExportMemo | null;
  [key: string]: unknown;
}

const DEFAULTS: SettingsData = { recentFiles: [], lastExport: null };
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
  hydrateStore();
}

/** Push persisted toggles into the reactive store on startup. */
function hydrateStore() {
  setSpellcheckOn(getSetting("spellcheck", true));
  setSmartPunctuation(getSetting("smartPunctuation", false));
  setLineEnding(getSetting<"lf" | "crlf">("lineEnding", "lf"));
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
