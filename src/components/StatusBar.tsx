import { Show } from "solid-js";
import { stats, doc, encodingLossy, readTime, caretLineCol, theme, proseFont } from "../store";
import { THEME_LABELS } from "../menudata";
import { togglePalette, isPaletteOpen } from "./PaletteSwitcher";
import { openSettings, isSettingsOpen } from "./SettingsModal";
import { updatePhase, type UpdatePhase } from "../updater";

function updateLabel(p: UpdatePhase): string {
  switch (p.kind) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading update… ${p.percent}%`;
    case "installing":
      return "Installing update…";
    default:
      return "";
  }
}

export default function StatusBar() {
  // "Saved" only when the buffer is clean AND actually backed by a file on disk.
  // A new/never-saved document (no filePath) is "Unsaved" even before any edit.
  const saved = () => !doc.dirty && !!doc.filePath;
  const savedTitle = () =>
    saved()
      ? "All changes saved to disk"
      : !doc.filePath
        ? "New file — not saved to disk yet"
        : "Unsaved changes";

  // Current writing font — the chosen family, or the theme's default.
  const fontLabel = () => proseFont() ?? "Default";

  return (
    <footer class="statusbar">
      <span class="sb-stat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
        <b>{stats().words}</b> words
      </span>
      <span class="sb-dot" />
      <span class="sb-stat"><b>{stats().chars}</b> characters</span>
      <span class="sb-dot" />
      <span class="sb-stat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
        <b>{readTime()}</b> min read
      </span>
      <span class="sb-dot" />
      <span class="sb-stat sb-cursor">Ln {caretLineCol().line}, Col {caretLineCol().col}</span>
      <Show when={updatePhase().kind !== "idle"}>
        <span class="sb-dot" />
        <span class="update-status">{updateLabel(updatePhase())}</span>
      </Show>

      <span class="spacer" />

      <div class="status-right">
        <span class="sb-saved" classList={{ dirty: !saved() }} title={savedTitle()}>
          <span class="sync-dot" />
          {saved() ? "Saved" : "Unsaved"}
        </span>
        <span
          class="sb-fmt"
          classList={{ lossy: encodingLossy() }}
          title={
            encodingLossy()
              ? "Some bytes didn't decode cleanly — try Edit ▸ Reopen with Encoding"
              : "Text encoding — change via Edit ▸ Reopen with Encoding"
          }
        >
          Markdown · {doc.encoding}
          <Show when={doc.hadBom}> BOM</Show>
          <Show when={encodingLossy()}> ⚠</Show>
        </span>
        <button
          class="sb-theme"
          classList={{ on: isPaletteOpen() }}
          title="Theme palette"
          onClick={togglePalette}
        >
          <svg class="sb-palette-ic" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.6c-3.5 0-6.4 2.6-6.4 5.9 0 3 2.4 4.8 5 4.8.9 0 1.5-.6 1.5-1.4 0-.4-.2-.7-.4-1-.2-.2-.3-.5-.3-.8 0-.6.5-1.1 1.1-1.1h1.3c2 0 3.6-1.5 3.6-3.6 0-2.6-2.4-4.8-5.4-4.8Zm-3.5 6.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm1.9-2.6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm3.2 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
          </svg>
          {THEME_LABELS[theme()] ?? theme()}
        </button>
        <button
          class="sb-font"
          classList={{ on: isSettingsOpen() }}
          title={`Font: ${fontLabel()} — click for typography settings`}
          onClick={openSettings}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M5 6h14M12 6v13M9 19h6" />
          </svg>
          <span class="sb-font-name">{fontLabel()}</span>
        </button>
      </div>
    </footer>
  );
}
