import { doc, updateBlock, insertBlockAfter, imageUploadUrl } from "./store";
import {
  isTauri, revealInDir, copyFileTo, renameFile, deleteFile,
  pickFolder, pickSavePath, confirmDialog, alertDialog,
} from "./platform";
import { imageFsPath, resolveImageSrc, docDir, type ImageRef } from "./images";
import { imageMarkup, needsHtmlSyntax } from "./imageattrs";

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

/** Re-render an image occurrence, carrying its other attributes across. */
function remark(t: ImageTarget, src = t.src, alt = t.alt, attrs = t.attrs ?? {}): string {
  return imageMarkup(src, alt, t.kind, attrs);
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
    rewrite(t, remark(t, refForPath(newAbs)));
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
    rewrite(t, remark(t, refForPath(to)));
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

/** Add or update a key in the document's YAML front matter (block 0). */
function setFrontMatterKey(key: string, value: string) {
  const entry = `${key}: "${value}"`;
  const first = doc.blocks[0]?.text ?? "";
  const m = /^---\n([\s\S]*?)\n---\s*$/.exec(first);
  if (m) {
    const lines = m[1].split("\n");
    const re = new RegExp(`^\\s*${key}\\s*:`);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx >= 0) lines[idx] = entry;
    else lines.push(entry);
    updateBlock(0, `---\n${lines.join("\n")}\n---`);
  } else {
    // No front matter yet — prepend a new block (insertBlockAfter(-1) → index 0).
    insertBlockAfter(-1, `---\n${entry}\n---`);
  }
}

/**
 * Choose a folder to resolve root-relative image links (`/img/foo.png`)
 * against. Stored as the `image-root-url` front-matter key that the image
 * resolver (images.ts) already honours.
 */
export async function setImageRootPath() {
  if (!isTauri) {
    await alertDialog("Setting an image root path is only available in the desktop app.");
    return;
  }
  const dir = await pickFolder();
  if (!dir) return;
  setFrontMatterKey("image-root-url", dir.replace(/\\/g, "/"));
}

/** Apply a zoom percentage — forces HTML syntax (markdown can't carry size). */
export function setImageZoom(t: ImageTarget, percent: number) {
  const attrs = { ...(t.attrs ?? {}) };
  if (percent === 100) delete attrs.style;
  else attrs.style = `zoom: ${percent}%`;
  rewrite(t, imageMarkup(t.src, t.alt, "html", attrs));
}

export function switchImageSyntax(t: ImageTarget, to: "md" | "html") {
  if (to === t.kind) return;
  // Going back to markdown discards what markdown cannot carry, so say so.
  rewrite(t, imageMarkup(t.src, t.alt, to, to === "md" ? {} : (t.attrs ?? {})));
}

/** Replace the image's source, preserving its alt text and every attribute. */
export function setImageSource(t: ImageTarget, src: string) {
  if (src === t.src) return;
  rewrite(t, remark(t, src));
}

/** Replace the image's alt text, preserving its source and every attribute. */
export function setImageAlt(t: ImageTarget, alt: string) {
  if (alt === t.alt) return;
  rewrite(t, remark(t, t.src, alt));
}

/**
 * Apply a batch of property edits from the Image Properties panel. An empty
 * value clears the attribute; setting anything markdown cannot express
 * promotes the occurrence to `<img>` syntax.
 */
export function setImageProps(t: ImageTarget, patch: Record<string, string>) {
  const attrs: Record<string, string> = { ...(t.attrs ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v.trim() === "") delete attrs[k];
    else attrs[k] = k === "alt" ? v : v.trim();
  }
  const src = patch.src !== undefined ? patch.src.trim() : t.src;
  const alt = patch.alt !== undefined ? patch.alt : t.alt;
  delete attrs.src;
  delete attrs.alt;
  const kind = t.kind === "html" || needsHtmlSyntax(attrs) ? "html" : "md";
  const next = imageMarkup(src, alt, kind, attrs);
  const i = blockIndexOf(t.blockId);
  if (i < 0) return;
  if (next === doc.blocks[i].text.slice(t.start, t.end)) return;
  rewrite(t, next);
}

/** Upload only the selected local image and avoid replacing edits made while waiting. */
export async function uploadSelectedImage(t: ImageTarget) {
  const source = doc.blocks.find(b => b.id === t.blockId)?.text.slice(t.start, t.end);
  if (!source) return;
  const path = imageFsPath(t.src);
  if (!path) { await alertDialog("Choose a local image to upload."); return; }
  if (!imageUploadUrl()) { await alertDialog("Set an image upload URL in Settings → Images first."); return; }
  try {
    const response = await fetch(resolveImageSrc(t.src));
    if (!response.ok) throw new Error("Could not read the image.");
    const { uploadImageBlob } = await import("./imageupload");
    const url = await uploadImageBlob(imageUploadUrl(), await response.blob(), path.split(/[\\/]/).pop() || "image");
    const current = doc.blocks.find(b => b.id === t.blockId);
    if (current?.text.slice(t.start, t.end) !== source) {
      await alertDialog(`Image uploaded, but the document changed. Image URL: ${url}`); return;
    }
    rewrite(t, remark(t, url));
  } catch (error) { await alertDialog(String(error)); }
}
