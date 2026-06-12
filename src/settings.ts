import { isTauri } from "./platform";

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
const STORAGE_KEY = "inkdown.settings";

let data: SettingsData = { ...DEFAULTS };

async function persist(): Promise<void> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_settings", { value: data }).catch(() => {});
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }
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
