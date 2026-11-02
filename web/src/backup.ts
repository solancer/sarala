/** The library as a zip of plain files: the way out of browser storage, and
 *  the way to move a library to another browser. */
import { unzip, zip, type Zippable } from "fflate";
import { confirmDialog, alertDialog } from "../../src/platform";
import { download, LIBRARY, libraryFiles, exists, write } from "./vfs";

export async function backupLibrary() {
  const files = await libraryFiles();
  if (!files.length) { await alertDialog("The library is empty, so there is nothing to back up."); return; }
  const entries: Zippable = {};
  for (const f of files) {
    const bytes = new Uint8Array(await f.data.arrayBuffer());
    // Images are already compressed; deflating them only costs time.
    entries[f.path.slice(LIBRARY.length + 1)] = [bytes, { level: /\.(md|markdown|mdown|txt|svg)$/i.test(f.path) ? 6 : 0, mtime: f.modified }];
  }
  const archive = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) =>
    zip(entries, (error, data) => (error ? reject(error) : resolve(data as Uint8Array<ArrayBuffer>))));
  download(`sarala-library-${new Date().toISOString().slice(0, 10)}.zip`, new Blob([archive], { type: "application/zip" }));
}

/** Refuse anything that climbs out of the library. */
const safe = (name: string) => !name.endsWith("/") && !name.split("/").some((part) => part === ".." || part === "" || part.startsWith("__MACOSX"));

export async function restoreLibrary(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array<ArrayBuffer>>>((resolve, reject) =>
    unzip(bytes, (error, data) => (error ? reject(error) : resolve(data as Record<string, Uint8Array<ArrayBuffer>>))));
  const names = Object.keys(entries).filter(safe);
  if (!names.length) { await alertDialog("That zip has no files to restore."); return; }
  const present = (await Promise.all(names.map((n) => exists(`${LIBRARY}/${n}`)))).filter(Boolean).length;
  const message = present
    ? `Restore ${names.length} files? ${present} will replace files already in the library.`
    : `Restore ${names.length} files into the library?`;
  if (!(await confirmDialog(message))) return;
  for (const name of names) await write(`${LIBRARY}/${name}`, new Blob([entries[name]]));
}
