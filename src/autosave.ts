import { createEffect, onCleanup } from "solid-js";
import {
  doc, fullText, autosaveInterval, loadDocument, setDocDirty, setExternalChange,
} from "./store";
import {
  writeShadow, clearShadow, listShadows, readFileEncoded, watchFile,
  type ShadowSession,
} from "./platform";
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

// The shadow key we last wrote, so we can delete it the moment the doc is saved.
let lastKey: string | null = null;

/** Wire up the autosave loop: a re-arming interval that shadows the dirty buffer,
 *  and an effect that clears the shadow once the document is saved (clean). */
export function startAutosave(): void {
  createEffect(() => {
    const secs = autosaveInterval();
    if (secs <= 0) return;
    const id = setInterval(() => void tick(), secs * 1000);
    onCleanup(() => clearInterval(id));
  });

  // When the buffer becomes clean (a real save happened), the on-disk file now
  // holds the content — drop the shadow.
  createEffect(() => {
    if (!doc.dirty && lastKey) {
      const k = lastKey;
      lastKey = null;
      void clearShadow(k);
    }
  });
}

async function tick(): Promise<void> {
  if (!doc.dirty || !doc.filePath) return; // saved files only
  const key = keyForPath(doc.filePath);
  lastKey = key;
  await writeShadow(key, {
    path: doc.filePath,
    content: fullText(),
    savedAt: Date.now(),
    encoding: doc.encoding,
    hadBom: doc.hadBom,
  });
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
      if (ed.content !== s.content) out.push(s);
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
  return s && s.content !== diskContent ? s : null;
}

/** Load a recovered session into the current window, marked dirty so the
 *  recovered content can be saved back over the file. */
export async function restoreSession(s: ShadowSession): Promise<void> {
  loadDocument(s.content, s.path, { encoding: s.encoding, hadBom: s.hadBom });
  setDocDirty(true);
  setExternalChange(null);
  await watchFile(s.path);
  await addRecentFile(s.path);
}

export { baseName as shadowBaseName };
