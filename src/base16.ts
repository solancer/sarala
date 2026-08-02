/**
 * base16 → Sarala theme tokens.
 *
 * base16 is a published 16-colour interchange format: `base00`–`base07` are a
 * tonal ramp (backgrounds through foregrounds) and `base08`–`base0F` are
 * accents with *fixed roles* — `base08` is always "variables / diff-deleted",
 * `base0B` always "strings". Fixing roles rather than hues is what lets one
 * scheme drive chrome, callouts and syntax colours at once, and it means the
 * hundreds of schemes published by the Tinted Theming project all work here.
 *
 * The ramp's direction flips with `variant`: dark schemes run base00 (darkest)
 * → base07 (lightest), light schemes run the other way. Derivation below is
 * written in terms of ramp *positions*, not literal lightness, so one mapping
 * serves both.
 *
 * Sarala layers six surface tones (`--bg`, `--bg-panel`, `--bg-page`,
 * `--bg-topbar`, `--chip`, `--track`) where base16 offers three, so the extras
 * are mixed from adjacent ramp slots rather than collapsed onto one another —
 * a flat mapping loses exactly the depth the curated themes are built on.
 *
 * The curated `[data-theme]` palettes are hand-tuned and deliberately NOT
 * generated from this: their charm is in relationships no formula produces.
 * This drives the single "Custom" slot only.
 */

export const BASE16_SLOTS = [
  "base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07",
  "base08", "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F",
] as const;

export type Base16Slot = (typeof BASE16_SLOTS)[number];
export type Base16Palette = Record<Base16Slot, string>;

/** Short role per slot — shown as the swatch label in the editor. */
export const BASE16_ROLES: Record<Base16Slot, string> = {
  base00: "Background",
  base01: "Panel / code background",
  base02: "Selection, borders",
  base03: "Comments, rails",
  base04: "Secondary text",
  base05: "Body text",
  base06: "Bright text",
  base07: "Brightest text",
  base08: "Red — errors, deleted",
  base09: "Orange — numbers",
  base0A: "Yellow — types",
  base0B: "Green — strings, added",
  base0C: "Cyan — links",
  base0D: "Blue — accent, functions",
  base0E: "Magenta — keywords",
  base0F: "Brown — meta",
};

export interface Base16Scheme {
  name: string;
  author?: string;
  variant: "light" | "dark";
  palette: Base16Palette;
}

/* ---------- colour utilities ---------- */

const HEX = /^#?([0-9a-f]{6})$/i;

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value.trim());
}

/** Normalise to `#rrggbb` lowercase. */
export function normHex(value: string): string {
  const m = HEX.exec(value.trim());
  return m ? `#${m[1].toLowerCase()}` : "#000000";
}

const rgb = (hex: string): [number, number, number] => {
  const h = normHex(hex).slice(1);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
};

const toHex = (c: number) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0");

/** Blend `a` toward `b` by `t` (0 = all a, 1 = all b). */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const k = Math.max(0, Math.min(1, t));
  return `#${toHex(ar + (br - ar) * k)}${toHex(ag + (bg - ag) * k)}${toHex(ab + (bb - ab) * k)}`;
}

/** WCAG relative luminance, used to infer a missing `variant`. */
export function luminance(hex: string): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/* ---------- parsing ---------- */

export interface ParseResult {
  scheme?: Base16Scheme;
  error?: string;
}

/**
 * Parse a base16 scheme from YAML or JSON text.
 *
 * Both published layouts are accepted: the Tinted Theming one (slots nested
 * under `palette:`, `#`-prefixed hex, explicit `variant`) and the original
 * chriskempson one (slots at the top level, bare hex, no `variant`).
 *
 * Deliberately a tolerant scanner rather than a real YAML parse: the format is
 * sixteen `key: value` pairs plus a little metadata, and both layouts — and the
 * JSON equivalents — fall out of the same regex. That avoids taking on a YAML
 * dependency for one narrow, stable schema.
 */
export function parseBase16(text: string): ParseResult {
  if (!text.trim()) return { error: "Paste a base16 scheme first." };

  const palette = {} as Partial<Base16Palette>;
  for (const slot of BASE16_SLOTS) {
    // `base00: "#282a36"` / `base00: 282a36` / `"base00": "#282a36"`
    const re = new RegExp(`["']?${slot}["']?\\s*:\\s*["']?#?([0-9a-fA-F]{6})["']?`);
    const m = re.exec(text);
    if (m) palette[slot] = `#${m[1].toLowerCase()}`;
  }

  const missing = BASE16_SLOTS.filter((s) => !palette[s]);
  if (missing.length === BASE16_SLOTS.length) {
    return { error: "No base16 colours found. Expected base00–base0F entries." };
  }
  if (missing.length) {
    return { error: `Missing ${missing.length} slot${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.` };
  }

  const str = (key: string) => {
    const m = new RegExp(`["']?${key}["']?\\s*:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m").exec(text);
    return m ? m[1].trim() : undefined;
  };
  const declared = str("variant");
  const full = palette as Base16Palette;

  return {
    scheme: {
      name: str("name") ?? str("scheme") ?? "Custom",
      author: str("author"),
      // Absent in the chriskempson layout — infer it by comparing the ramp's
      // endpoints, since every derivation below depends on the direction.
      variant:
        declared === "light" || declared === "dark"
          ? declared
          : luminance(full.base00) < luminance(full.base05)
            ? "dark"
            : "light",
      palette: full,
    },
  };
}

/** Serialise back to Tinted Theming YAML (for export / round-tripping). */
export function toBase16Yaml(scheme: Base16Scheme): string {
  const lines = [
    "system: base16",
    `name: "${scheme.name}"`,
    ...(scheme.author ? [`author: "${scheme.author}"`] : []),
    `variant: ${scheme.variant}`,
    "palette:",
    ...BASE16_SLOTS.map((s) => `  ${s}: "${scheme.palette[s]}"`),
  ];
  return lines.join("\n") + "\n";
}

/* ---------- derivation ---------- */

/**
 * Derive Sarala's theme tokens from a scheme.
 *
 * Written against ramp positions, so it holds for both variants: base00 is
 * always the content surface, base01 the chrome surface, base02 borders and
 * selection, base03 hairlines, base04 secondary text, base05 body text.
 *
 * `accent` takes base0D (base16's "functions / primary" role) and `link` takes
 * base0C, keeping the two distinct — the same rule the curated themes follow,
 * where a link is never the signature accent.
 */
export function base16ToTokens(scheme: Base16Scheme): Record<string, string> {
  const p = scheme.palette;
  const dark = scheme.variant === "dark";
  const soft = (c: string) => `color-mix(in srgb, ${c} 15%, transparent)`;

  return {
    "--mermaid-theme": dark ? "dark" : "default",

    // Surfaces. base16 gives three; Sarala layers six, so the in-between tones
    // are mixed from adjacent slots instead of collapsing onto one another.
    "--bg-page": p.base00,
    "--bg-panel": p.base01,
    "--bg": mixHex(p.base00, p.base01, 0.7),
    "--bg-topbar": mixHex(p.base00, p.base01, 0.7),
    "--chip": mixHex(p.base01, p.base02, 0.35),
    "--track": mixHex(p.base01, p.base02, 0.65),
    "--tint": mixHex(p.base01, p.base02, 0.5),
    "--code-bg": p.base01,

    // Text.
    "--ink": p.base05,
    "--ink-soft": p.base04,
    "--code-ink": p.base05,

    // Lines. base02 is the border slot by definition; the softer variants step
    // back toward the panel so dividers stay quieter than borders.
    "--rule": p.base02,
    "--rule-soft": mixHex(p.base02, p.base01, 0.45),
    "--rail": mixHex(p.base02, p.base01, 0.3),
    "--code-border": p.base02,
    "--grip": p.base03,
    "--quote-bar": p.base03,

    // Accents.
    "--accent": p.base0D,
    "--accent-soft": soft(p.base0D),
    "--select": p.base0D,
    "--select-soft": soft(p.base0D),
    "--link": p.base0C,
    "--warn": p.base08,
    "--marker": p.base0D,
    "--marker-opacity": "0.85",

    // Shadows read as light on a dark scheme and vice versa.
    "--shadow": dark
      ? "0 1px 2px rgba(0, 0, 0, 0.3), 0 10px 34px rgba(0, 0, 0, 0.45)"
      : "0 1px 2px rgba(40, 40, 40, 0.06), 0 10px 34px rgba(40, 40, 40, 0.09)",
  };
}

/**
 * The derived tokens as a CSS rule, for a `<style>` element.
 *
 * The selector matches the curated blocks' shape (a bare attribute rule, not
 * `.app[…]`) so the tokens also cascade into a nested preview card carrying
 * `data-theme="custom"`. It wins over the curated blocks on document order,
 * being appended to `<head>` after the stylesheet.
 */
export function base16ToCss(scheme: Base16Scheme, selector = '[data-theme="custom"]'): string {
  const tokens = base16ToTokens(scheme);
  const body = Object.entries(tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `${selector} {\n${body}\n}\n`;
}

/** A neutral starting scheme for the editor when nothing has been imported. */
export const DEFAULT_SCHEME: Base16Scheme = {
  name: "Custom",
  variant: "dark",
  palette: {
    base00: "#1d1f21", base01: "#282a2e", base02: "#373b41", base03: "#969896",
    base04: "#b4b7b4", base05: "#c5c8c6", base06: "#e0e0e0", base07: "#ffffff",
    base08: "#cc6666", base09: "#de935f", base0A: "#f0c674", base0B: "#b5bd68",
    base0C: "#8abeb7", base0D: "#81a2be", base0E: "#b294bb", base0F: "#a3685a",
  },
};
