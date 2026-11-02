/** Fonts installed on this device, through the Local Font Access API (Chromium).
 *  Elsewhere the list is empty and the bundled fonts remain. */
export async function listFonts(): Promise<string[]> {
  if (!window.queryLocalFonts) return [];
  const fonts = await window.queryLocalFonts().catch(() => []);
  return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
}

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100], [/extra\s*light|ultra\s*light/i, 200], [/light/i, 300], [/medium/i, 500],
  [/semi\s*bold|demi/i, 600], [/extra\s*bold|ultra\s*bold/i, 800], [/bold/i, 700], [/black|heavy/i, 900],
];

const base64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

/** Font data for embedding in an export, as the desktop's font_faces_b64 gives. */
export async function fontFaces(family: string) {
  if (!window.queryLocalFonts) return [];
  const fonts = (await window.queryLocalFonts().catch(() => [])).filter((f) => f.family === family);
  return Promise.all(fonts.slice(0, 8).map(async (font) => {
    const bytes = new Uint8Array(await (await font.blob()).arrayBuffer());
    return {
      weight: WEIGHTS.find(([re]) => re.test(font.style))?.[1] ?? 400,
      italic: /italic|oblique/i.test(font.style),
      format: String.fromCharCode(...bytes.subarray(0, 4)) === "OTTO" ? "opentype" : "truetype",
      b64: base64(bytes),
    };
  }));
}
