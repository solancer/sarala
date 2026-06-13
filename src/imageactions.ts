import { doc, updateBlock } from "./store";
import {
  isTauri, revealInDir, copyFileTo, renameFile, deleteFile,
  pickFolder, pickSavePath, confirmDialog, alertDialog,
} from "./platform";
import { imageFsPath, docDir, type ImageRef } from "./images";

/** A right-clicked image: where it lives in the document and its parsed form. */
export interface ImageTarget extends ImageRef {
  blockId: number;
}

const blockIndexOf = (id: number) => doc.blocks.findIndex((b) => b.id === id);

/** Path to store in markdown: relative to the doc dir when the file is under it. */
function refForPath(absPath: string): string {
  const dir = docDir();
  const norm = (p: string) => p.replace(/\\/g, "/");
  if (dir && norm(absPath).startsWith(norm(dir) + "/")) return norm(absPath).slice(norm(dir).length + 1);
  return norm(absPath);
}

/** Render an image occurrence in the requested syntax. */
function imageMarkup(src: string, alt: string, kind: "md" | "html", style?: string): string {
  if (kind === "html") {
    const styleAttr = style ? ` style="${style}"` : "";
    return `<img src="${src}" alt="${alt}"${styleAttr} />`;
  }
  return `![${alt}](${src})`;
}

/** Replace the image's source span with new text. */
function rewrite(t: ImageTarget, replacement: string) {
  const i = blockIndexOf(t.blockId);
  if (i < 0) return;
  const text = doc.blocks[i].text;
  if (t.start > text.length) return;
  updateBlock(i, text.slice(0, t.start) + replacement + text.slice(t.end));
}

async function localPathOrWarn(t: ImageTarget): Promise<string | null> {
  if (!isTauri) {
    await alertDialog("Image file actions are only available in the desktop app.");
    return null;
  }
  const fs = imageFsPath(t.src);
  if (!fs) {
    await alertDialog("This image isn't a local file.");
    return null;
  }
  return fs;
}

export async function openImageLocation(t: ImageTarget) {
  const fs = await localPathOrWarn(t);
  if (fs) await revealInDir(fs);
}

export async function copyImageTo(t: ImageTarget) {
  const fs = await localPathOrWarn(t);
  if (!fs) return;
  const dest = await pickFolder();
  if (!dest) return;
  try {
    const newAbs = await copyFileTo(fs, dest);
    rewrite(t, imageMarkup(refForPath(newAbs), t.alt, t.kind));
  } catch (e) {
    await alertDialog(String(e));
  }
}

export async function renameMoveImage(t: ImageTarget) {
  const fs = await localPathOrWarn(t);
  if (!fs) return;
  const base = fs.replace(/\\/g, "/").split("/").pop() ?? "image.png";
  const to = await pickSavePath(base);
  if (!to || to === fs) return;
  try {
    await renameFile(fs, to);
    rewrite(t, imageMarkup(refForPath(to), t.alt, t.kind));
  } catch (e) {
    await alertDialog(String(e));
  }
}

export async function deleteImageFile(t: ImageTarget) {
  const fs = await localPathOrWarn(t);
  if (!fs) return;
  if (!(await confirmDialog(`Delete the image file and remove it from the document?\n${fs}`))) return;
  try {
    await deleteFile(fs);
  } catch (e) {
    await alertDialog(String(e));
    return;
  }
  // Drop the image occurrence (and a single trailing space, if any).
  const i = blockIndexOf(t.blockId);
  if (i < 0) return;
  const text = doc.blocks[i].text;
  const end = text[t.end] === " " ? t.end + 1 : t.end;
  updateBlock(i, text.slice(0, t.start) + text.slice(end));
}

export async function uploadImage() {
  await alertDialog("Image upload is not configured.");
}

/** Apply a zoom percentage — forces HTML syntax (markdown can't carry size). */
export function setImageZoom(t: ImageTarget, percent: number) {
  const style = percent === 100 ? "" : `zoom: ${percent}%`;
  rewrite(t, imageMarkup(t.src, t.alt, "html", style));
}

export function switchImageSyntax(t: ImageTarget, to: "md" | "html") {
  if (to === t.kind) return;
  rewrite(t, imageMarkup(t.src, t.alt, to));
}
