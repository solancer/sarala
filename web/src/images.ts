/**
 * Rendering is synchronous but reading a workspace image isn't. The first
 * render of an image gets a transparent placeholder while its bytes load into a
 * blob: URL; assetsReady() then re-renders the blocks that use images.
 */
import { assetsReady } from "../../src/assets";
import { onAccessRestored, onFileChanged, read } from "./vfs";

const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

const MIME: Record<string, string> = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
};

const urls = new Map<string, string>();
const loading = new Map<string, Promise<void>>();

let notifyQueued = false;
function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  setTimeout(() => { notifyQueued = false; assetsReady(); }, 30);
}

function load(path: string): Promise<void> {
  let pending = loading.get(path);
  if (pending) return pending;
  pending = read(path, true).then((blob) => {
    // The browser needs the type to treat an .svg as an image.
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    urls.set(path, URL.createObjectURL(MIME[ext] ? blob.slice(0, blob.size, MIME[ext]) : blob));
  }).catch(() => {
    // Leave a URL that fails, so the page shows a broken image and not a blank.
    urls.set(path, path);
  }).finally(() => {
    loading.delete(path);
    notify();
  });
  loading.set(path, pending);
  return pending;
}

export function imageUrl(path: string): string {
  const url = urls.get(path);
  if (url) return url;
  void load(path);
  return PLACEHOLDER;
}

/** Load up front, for exports, which render once and can't wait for a re-render. */
export async function preloadImages(paths: string[]): Promise<void> {
  await Promise.all(paths.filter((p) => !urls.has(p)).map(load));
}

function forget(path: string) {
  const url = urls.get(path);
  if (!url) return;
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  urls.delete(path);
  notify();
}

onFileChanged(forget);
// A folder coming back makes its images readable: retry what failed.
onAccessRestored(() => { for (const [path, url] of urls) if (url === path) forget(path); });

const asDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

export async function inlineImages(root: HTMLElement): Promise<void> {
  await Promise.all([...root.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')].map(async (img) => {
    const blob = await (await fetch(img.src)).blob();
    img.src = await asDataUrl(blob);
  }));
}
