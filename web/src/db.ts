/**
 * A small promise layer over IndexedDB. IndexedDB holds the workspace because
 * it stores Blobs natively and survives reloads; localStorage holds only
 * settings, as it is synchronous, small and strings-only.
 */
const NAME = "sarala";
const VERSION = 1;

/** files: documents and images. handles: folders and files on this device.
 *  kv: session snapshots and small flags. */
export type StoreName = "files" | "handles" | "kv";

let opened: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("files", { keyPath: "path" });
      db.createObjectStore("handles", { keyPath: "id" });
      db.createObjectStore("kv");
    };
    req.onsuccess = () => {
      // Let another tab's future upgrade proceed instead of blocking on us.
      req.result.onversionchange = () => { req.result.close(); opened = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return opened;
}

const done = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error("The browser refused to store this."));
  tx.onabort = () => reject(tx.error ?? new Error("The browser refused to store this."));
});

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key));
}

export async function all<T>(store: StoreName): Promise<T[]> {
  const db = await open();
  return done(db.transaction(store).objectStore(store).getAll());
}

export async function keys(store: StoreName): Promise<IDBValidKey[]> {
  const db = await open();
  return done(db.transaction(store).objectStore(store).getAllKeys());
}

export async function put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  await finished(tx);
}

export async function del(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await finished(tx);
}

/** Read-modify-write in a single transaction, so a save is all-or-nothing and
 *  two tabs can't interleave. `fn` must stay synchronous: an IndexedDB
 *  transaction ends as soon as it has nothing pending. */
export async function update<T>(store: StoreName, key: IDBValidKey, fn: (current: T | undefined) => T): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  const req = os.get(key);
  req.onsuccess = () => { os.put(fn(req.result as T | undefined)); };
  await finished(tx);
}

/** Apply several deletes and puts atomically (a rename is one of each). */
export async function batch(store: StoreName, ops: { del?: IDBValidKey; put?: unknown }[]): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  for (const op of ops) {
    if (op.del !== undefined) os.delete(op.del);
    if (op.put !== undefined) os.put(op.put);
  }
  await finished(tx);
}
