import { createEffect, onCleanup } from "solid-js";
import {
  openDocuments, autosaveInterval, openDocument, setDocDirty, setExternalChange,
} from "./store";
import {
  writeShadow, clearShadow, listShadows, readFileEncoded, watchFile,
  type ShadowSession,
} from "./platform";
import { joinBlocks } from "./markdown";
import { addRecentFile } from "./settings";

/** Stable per-file shadow key (FNV-1a hex of the absolute path). The Rust side
 *  stores `<key>.json`, so one file maps to exactly one shadow, overwritten in
 *  place each autosave tick. */
export function keyForPath(path: string): string {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() || p;

// Shadows store the editor's normalized buffer (LF joins + a trailing newline
// from joinBlocks). A file saved with CRLF or a different final-newline policy
// is byte-different but not *meaningfully* changed, so compare line-ending- and
// trailing-newline-insensitively to avoid nagging about untouched files.
const normalizeForCompare = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n+$/, "");

// Track each tab's shadow independently; switching to a clean tab must never
// clear another tab's recovery data. The value is what was last written, so an
// unchanged dirty buffer isn't re-serialized to disk every tick.
const shadowKeys = new Map<string, string>();
let ticking = false;

/** Wire up the autosave loop: a re-arming interval that shadows the dirty buffer,
 *  and an effect that clears the shadow once the document is saved (clean). */
export function startAutosave(): void {
  createEffect(() => {
    const secs = autosaveInterval();
    if (secs <= 0) return;
    const id = setInterval(() => void tick(), secs * 1000);
    onCleanup(() => clearInterval(id));
  });

  createEffect(() => {
    const dirtyKeys = new Set(openDocuments().filter(({ document }) => document.dirty && document.filePath)
      .map(({ document }) => keyForPath(document.filePath!)));
    for (const key of shadowKeys.keys()) {
      if (!dirtyKeys.has(key)) { shadowKeys.delete(key); void clearShadow(key); }
    }
  });
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const { document } of openDocuments()) {
      if (!document.dirty || !document.filePath) continue;
      const path = document.filePath;
      const key = keyForPath(path);
      const content = joinBlocks(document.blocks.map((b) => b.text));
      const written = `${document.encoding}\u0000${document.hadBom ? 1 : 0}\u0000${content}`;
      if (shadowKeys.get(key) === written) continue;
      shadowKeys.set(key, written);
      try {
        await writeShadow(key, {
          path, content, savedAt: Date.now(),
          encoding: document.encoding, hadBom: document.hadBom,
        });
      } catch (error) {
        shadowKeys.set(key, ""); // not written: retry next tick
        throw error;
      }
      // A save or close may have completed while this write was in flight.
      if (!openDocuments().some(({ document: d }) => d.filePath === path && d.dirty)) {
        shadowKeys.delete(key);
        await clearShadow(key);
      }
    }
  } finally { ticking = false; }
}

/** Shadows whose content differs from the file currently on disk (i.e. real
 *  unsaved work from a previous session). Stale shadows that match disk are
 *  cleaned up as a side effect. Newest first. */
export async function findRecoverable(): Promise<ShadowSession[]> {
  const shadows = await listShadows();
  const out: ShadowSession[] = [];
  for (const s of shadows) {
    try {
      const ed = await readFileEncoded(s.path);
      if (normalizeForCompare(ed.content) !== normalizeForCompare(s.content)) out.push(s);
      else await clearShadow(keyForPath(s.path));
    } catch {
      // File is gone — its unsaved content may still be wanted.
      out.push(s);
    }
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out;
}

/** The shadow for `path` if it holds unsaved changes vs. the given on-disk
 *  content; used by openFile to offer recovery when a file is opened. */
export async function shadowFor(path: string, diskContent: string): Promise<ShadowSession | null> {
  const shadows = await listShadows();
  const s = shadows.find((x) => x.path === path);
  return s && normalizeForCompare(s.content) !== normalizeForCompare(diskContent) ? s : null;
}

/** Delete the given sessions' shadows — used when the user declines recovery so
 *  the prompt doesn't reappear on every launch. */
export async function discardShadows(sessions: ShadowSession[]): Promise<void> {
  for (const s of sessions) await clearShadow(keyForPath(s.path));
}

/** Drop the shadow for one path. Called on a *deliberate* close/discard so the
 *  next launch doesn't offer to "recover" changes the user chose to drop; a
 *  crash skips this path, leaving the shadow so recovery still works. */
export async function discardShadowFor(path: string | null): Promise<void> {
  if (path) await clearShadow(keyForPath(path));
}

/** Load a recovered session into the current window, marked dirty so the
 *  recovered content can be saved back over the file. */
export async function restoreSession(s: ShadowSession): Promise<void> {
  openDocument(s.content, s.path, { encoding: s.encoding, hadBom: s.hadBom });
  setDocDirty(true);
  setExternalChange(null);
  await watchFile(s.path);
  await addRecentFile(s.path);
}

export { baseName as shadowBaseName };
