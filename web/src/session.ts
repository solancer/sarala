/**
 * What makes a reload a non-event. Every open tab, unsaved ones included, is
 * snapshotted to IndexedDB moments after it changes and reopened on load, which
 * covers the desktop's autosave shadows and crash recovery in one mechanism.
 *
 * Each window owns one snapshot under a Web Lock, so two windows can't overwrite
 * each other and a window opened later picks up one that was closed.
 */
import { createEffect, createRoot } from "solid-js";
import { activeTabId, doc, fullText, openDocument, openDocuments, openTabs, removeTab, setDocDirty, switchTab } from "../../src/store";
import { joinBlocks } from "../../src/markdown";
import * as db from "./db";
import { decode } from "./encoding";
import { isLibrary, read, watch } from "./vfs";

interface TabSnapshot { path: string | null; dirty: boolean; content?: string; encoding: string; hadBom: boolean }
interface Snapshot { savedAt: number; active: number; tabs: TabSnapshot[] }

const PREFIX = "session:";
const KEPT = 6;
const WINDOW_ID = "sarala.session";

let sessionKey = "";

/**
 * Take a snapshot's lock, held until this window goes away. On a reload the old
 * page can still hold its lock for a moment, so a window waits for its own
 * snapshot: giving up at once would open a blank tab, its documents apparently
 * gone. The wait only runs out when another window really has it (a window
 * opened from this one inherits sessionStorage).
 */
function lock(id: string, patience = 0): Promise<boolean> {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    const keep = () => new Promise<void>(() => {});
    const name = `sarala-${id}`;
    if (patience) {
      navigator.locks.request(name, { signal: AbortSignal.timeout(patience) }, () => {
        resolve(true);
        return keep();
      }).catch(() => resolve(false));
    } else {
      void navigator.locks.request(name, { ifAvailable: true }, (held) => {
        resolve(!!held);
        return held ? keep() : undefined;
      });
    }
  });
}

async function claim(): Promise<Snapshot | null> {
  const fresh = new URLSearchParams(location.search).has("new");
  if (fresh) history.replaceState(null, "", location.pathname);
  const stored = (await db.keys("kv")).map(String).filter((k) => k.startsWith(PREFIX));
  const snapshots = await Promise.all(stored.map(async (key) => ({ key, snap: await db.get<Snapshot>("kv", key) })));
  snapshots.sort((a, b) => (b.snap?.savedAt ?? 0) - (a.snap?.savedAt ?? 0));
  for (const { key } of snapshots.slice(KEPT)) await db.del("kv", key);

  const windowId = sessionStorage.getItem(WINDOW_ID);
  const own = windowId ? `${PREFIX}${windowId}` : null;
  const candidates = fresh ? [] : [...(own ? [own] : []), ...snapshots.slice(0, KEPT).map((s) => s.key)];
  for (const key of new Set(candidates)) {
    if (await lock(key, key === own ? 1500 : 0)) {
      sessionKey = key;
      sessionStorage.setItem(WINDOW_ID, key.slice(PREFIX.length));
      return (await db.get<Snapshot>("kv", key)) ?? null;
    }
  }
  const id = crypto.randomUUID().slice(0, 8);
  sessionKey = `${PREFIX}${id}`;
  sessionStorage.setItem(WINDOW_ID, id);
  await lock(sessionKey);
  return null;
}

/** Reopen the last session. False when there was nothing to bring back. */
export async function restoreSession(): Promise<boolean> {
  const snapshot = await claim();
  if (!snapshot?.tabs.length) return false;
  const scratch = activeTabId();
  const opened: number[] = [];
  for (const tab of snapshot.tabs) {
    const meta = { encoding: tab.encoding, hadBom: tab.hadBom };
    if (tab.path && !tab.dirty) {
      try {
        const ed = await decode(new Uint8Array(await (await read(tab.path, true)).arrayBuffer()), tab.encoding === "UTF-8" ? "" : tab.encoding);
        opened.push(openDocument(ed.content, tab.path, ed));
        await watch(tab.path);
      } catch {
        // Gone, or the browser wants asking again. What the tab last held is
        // still here for a real file; a deleted library file has no tab to keep.
        if (tab.content !== undefined) opened.push(openDocument(tab.content, tab.path, meta));
      }
      continue;
    }
    opened.push(openDocument(tab.content ?? "", tab.path, meta));
    if (tab.dirty || !tab.path) setDocDirty(tab.dirty);
    if (tab.path) await watch(tab.path);
  }
  if (!opened.length) return false;
  if (!opened.includes(scratch) && openTabs().some((t) => t.id === scratch)) removeTab(scratch);
  const active = opened[Math.min(snapshot.active, opened.length - 1)];
  if (active !== undefined) switchTab(active);
  return true;
}

async function save() {
  const tabs: TabSnapshot[] = openDocuments().map(({ document: d }) => {
    const text = joinBlocks(d.blocks.map((b) => b.text));
    // Library files can be read back. Unsaved text can't, and a real file may
    // need a permission the page can't ask for at startup, so keep those.
    const keep = d.dirty || !d.filePath || !isLibrary(d.filePath);
    return { path: d.filePath, dirty: d.dirty, content: keep ? text : undefined, encoding: d.encoding, hadBom: d.hadBom };
  }).filter((t) => t.path || t.content);
  if (!sessionKey) return;
  if (!tabs.length) { await db.del("kv", sessionKey); return; }
  const active = Math.max(0, openDocuments().findIndex(({ id }) => id === activeTabId()));
  await db.put("kv", { savedAt: Date.now(), active, tabs } satisfies Snapshot, sessionKey);
}

export function startSnapshots() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => { clearTimeout(timer); void save(); };
  createRoot(() => {
    createEffect(() => {
      openTabs();
      activeTabId();
      void doc.dirty;
      fullText();
      clearTimeout(timer);
      timer = setTimeout(flush, 500);
    });
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);
}
