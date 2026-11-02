/** Opening things, with the File System Access API where a browser has it (a
 *  real file, editable in place) and a plain file input where it doesn't (a copy
 *  in the library). */
import { dirName, LIBRARY, mountFile, mountFolder, uniquePath, write } from "./vfs";

const MARKDOWN_TYPES = [{ description: "Markdown", accept: { "text/markdown": [".md", ".markdown", ".mdown", ".txt"] } }];

const cancelled = (error: unknown) => (error as DOMException)?.name === "AbortError";

/** Show a file input and wait. An input can't reject, so `cancel` resolves it. */
function inputFiles(accept: string, opts: { multiple?: boolean; directory?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = !!opts.multiple;
    if (opts.directory) input.webkitdirectory = true;
    input.style.display = "none";
    const finish = (files: File[]) => { input.remove(); resolve(files); };
    input.addEventListener("change", () => finish([...(input.files ?? [])]));
    input.addEventListener("cancel", () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

export const pickWith = async (accept: string) => (await inputFiles(accept))[0] ?? null;

export async function importFile(file: File, dir = LIBRARY): Promise<string> {
  const path = await uniquePath(dir, file.name);
  await write(path, file);
  return path;
}

export async function pickMarkdownFile(): Promise<string | null> {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: MARKDOWN_TYPES });
      return handle ? await mountFile(handle) : null;
    } catch (error) {
      if (cancelled(error)) return null;
      throw error;
    }
  }
  const file = await pickWith(".md,.markdown,.mdown,.txt,text/markdown,text/plain");
  return file ? importFile(file) : null;
}

/** Add a folder. Without the API, its files are copied into the library, and
 *  the path of that copy comes back so the caller can say so. */
export async function pickFolderToAdd(): Promise<string | null> {
  if (window.showDirectoryPicker) {
    try {
      return await mountFolder(await window.showDirectoryPicker({ mode: "readwrite" }));
    } catch (error) {
      if (cancelled(error)) return null;
      throw error;
    }
  }
  const files = await inputFiles("", { directory: true });
  if (!files.length) return null;
  const wanted = files.filter((f) => /\.(md|markdown|mdown|txt|png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(f.name)
    && !f.webkitRelativePath.split("/").some((part) => part.startsWith(".") || part === "node_modules"));
  for (const file of wanted) await write(`${LIBRARY}/${file.webkitRelativePath}`, file);
  return `${LIBRARY}/${dirName(files[0].webkitRelativePath).split("/")[0]}`;
}
