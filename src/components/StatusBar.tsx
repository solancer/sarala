import { Show } from "solid-js";
import { stats, doc, encodingLossy, readTime, caretLineCol, theme, proseFont } from "../store";
import { THEME_LABELS } from "../menudata";
import { togglePalette, isPaletteOpen } from "./PaletteSwitcher";
import { openSettings, isSettingsOpen } from "./SettingsModal";
import { executeCommand } from "../commands";
import { updatePhase, type UpdatePhase } from "../updater";

/** Human name for the open file's format, from its extension.
 *  Was hardcoded to "Markdown", which is wrong for the .txt files the app
 *  happily opens (drag-drop, and the Rust tree walker lists them). */
function formatLabel(path: string | null): string {
  const ext = (path ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (ext === "txt" || ext === "text") return "Plain text";
  return "Markdown";
}

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
    <footer class="statusbar" aria-label="Document status">
      {/* Stats carry no icons now. Two of the four had them (words, read time)
          and two did not, which read as arbitrary; at 12px the labels already
          say what each number is. */}
      <div class="sb-stats">
        <span class="sb-stat"><b>{stats().words}</b> words</span>
        <span class="sb-dot" aria-hidden="true" />
        <span class="sb-stat"><b>{stats().chars}</b> characters</span>
        <span class="sb-dot" aria-hidden="true" />
        <span class="sb-stat"><b>{readTime()}</b> min read</span>
        <span class="sb-dot" aria-hidden="true" />
        <span class="sb-stat sb-cursor">Ln {caretLineCol().line}, Col {caretLineCol().col}</span>
        <Show when={updatePhase().kind !== "idle"}>
          <span class="sb-dot" aria-hidden="true" />
          <span class="update-status">{updateLabel(updatePhase())}</span>
        </Show>
      </div>

      <span class="spacer" />

      <div class="status-right">
        {/* A real button: it looked exactly like the theme/font buttons beside
            it but did nothing. Clicking now does the thing the label implies. */}
        <button
          class="sb-saved"
          classList={{ dirty: !saved() }}
          title={saved() ? savedTitle() : `${savedTitle()} — click to save`}
          disabled={saved()}
          aria-live="polite"
          onClick={() => executeCommand("file.save")}
        >
          <span class="sync-dot" aria-hidden="true" />
          {saved() ? "Saved" : "Unsaved"}
        </button>
        {/* Deliberately NOT a button: changing encoding is a reopen, which
            lives in the Edit menu. Styled as a plain readout so it stops
            impersonating the controls next to it. */}
        <span
          class="sb-fmt"
          classList={{ lossy: encodingLossy() }}
          title={
            encodingLossy()
              ? "Some bytes didn't decode cleanly — try Edit ▸ Reopen with Encoding"
              : "Text encoding — change via Edit ▸ Reopen with Encoding"
          }
        >
          {formatLabel(doc.filePath)} · {doc.encoding}
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
          title={`Font: ${fontLabel()} — click for settings`}
          onClick={() => openSettings("fonts")}
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
