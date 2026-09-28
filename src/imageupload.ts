/** Explicit, user-configured multipart upload. Never invoked by paste or open. */
export async function uploadImageBlob(endpoint: string, file: Blob, name: string, fetcher: typeof fetch = fetch): Promise<string> {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Set an image upload URL in Settings → Images first."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("The upload URL must use HTTPS and must not contain credentials.");
  if (!file.type.startsWith("image/")) throw new Error("The selected file is not an image.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Images must be smaller than 20 MB.");
  const body = new FormData();
  body.append("file", file, name);
  const response = await fetcher(url.href, { method: "POST", body, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Image upload failed (${response.status}).`);
  const data = await response.json() as { url?: unknown };
  if (typeof data.url !== "string") throw new Error('The upload service must return JSON containing a "url" string.');
  const result = new URL(data.url);
  if (result.protocol !== "https:" || result.username || result.password) throw new Error("The upload service returned an invalid image URL.");
  return result.href;
}
