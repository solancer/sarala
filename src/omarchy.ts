/** Omarchy's flat colors.toml palette, read through a Linux-only native command.
 * Only quoted hex colours and mode are consumed; no theme code is evaluated.
 */
import { base16ToCss, luminance, mixHex, type Base16Scheme } from "./base16";

export function parseOmarchyColors(text: string): Base16Scheme | null {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    // Stop at a table: colours belong to the root of colors.toml.
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*([a-z_]+\d*)\s*=\s*(["'])(#[\da-fA-F]{6}|light|dark)\2\s*(?:#.*)?$/.exec(line);
    if (match) values[match[1]] = match[3].toLowerCase();
  }
  const bg = values.background;
  const fg = values.foreground;
  if (!bg?.startsWith("#") || !fg?.startsWith("#")) return null;
  const color = (key: string, fallback: string) =>
    values[key]?.startsWith("#") ? values[key] : fallback;
  const variant = values.mode === "light" || values.mode === "dark"
    ? values.mode : luminance(bg) < 0.35 ? "dark" : "light";
  const accent = color("accent", color("blue", color("color4", fg)));
  return {
    name: "Omarchy",
    variant,
    palette: {
      base00: bg,
      base01: color("dark_background", mixHex(bg, fg, 0.05)),
      base02: color("selection_background", color("selection", mixHex(bg, fg, 0.2))),
      base03: color("muted", color("color8", mixHex(bg, fg, 0.45))),
      base04: color("light_foreground", mixHex(bg, fg, 0.7)),
      base05: fg,
      base06: color("bright_foreground", fg),
      base07: color("color15", fg),
      base08: color("red", color("color1", accent)),
      base09: color("orange", color("color9", accent)),
      base0A: color("yellow", color("color3", accent)),
      base0B: color("green", color("color2", accent)),
      base0C: color("cyan", color("color6", accent)),
      base0D: accent,
      base0E: color("magenta", color("color5", accent)),
      base0F: color("brown", color("color13", accent)),
    },
  };
}

export function omarchyToCss(scheme: Base16Scheme): string {
  return base16ToCss(scheme, '[data-theme="omarchy"]');
}

/** Keep the previous complete palette during Omarchy's atomic theme swap.
 * A recursive timer avoids overlapping native requests. Stopping also ignores
 * a request that was already in flight when the user changed theme.
 */
export function followOmarchyTheme(
  read: () => Promise<string | null>,
  update: (scheme: Base16Scheme) => void,
  interval = 2000,
): () => void {
  let stopped = false;
  let previous = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try {
      const text = await read();
      if (!stopped && text && text !== previous) {
        const scheme = parseOmarchyColors(text);
        if (scheme) { previous = text; update(scheme); }
      }
    } catch { /* A missing/unreadable palette keeps the last successful theme. */ }
    if (!stopped) timer = setTimeout(() => { void refresh(); }, interval);
  };
  void refresh();
  return () => { stopped = true; clearTimeout(timer); };
}
