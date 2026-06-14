import { Show } from "solid-js";
import { stats, doc, encodingLossy } from "../store";
import { togglePalette, isPaletteOpen } from "./PaletteSwitcher";

export default function StatusBar() {
  return (
    <footer class="statusbar">
      <span>{stats().words} words</span>
      <span class="sep">·</span>
      <span>{stats().chars} characters</span>
      <span class="sep">·</span>
      <span
        class="encoding"
        classList={{ lossy: encodingLossy() }}
        title={
          encodingLossy()
            ? "Some bytes didn't decode cleanly — try Edit ▸ Reopen with Encoding"
            : "Text encoding — change via Edit ▸ Reopen with Encoding"
        }
      >
        {doc.encoding}
        <Show when={doc.hadBom}> BOM</Show>
        <Show when={encodingLossy()}> ⚠</Show>
      </span>
      <span class="spacer" />
      <button
        class="palette-toggle"
        classList={{ on: isPaletteOpen() }}
        title="Theme palette"
        onClick={togglePalette}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path fill="currentColor" d="M8 1.6c-3.5 0-6.4 2.6-6.4 5.9 0 3 2.4 4.8 5 4.8.9 0 1.5-.6 1.5-1.4 0-.4-.2-.7-.4-1-.2-.2-.3-.5-.3-.8 0-.6.5-1.1 1.1-1.1h1.3c2 0 3.6-1.5 3.6-3.6 0-2.6-2.4-4.8-5.4-4.8Zm-3.5 6.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm1.9-2.6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm3.2 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>
        </svg>
      </button>
    </footer>
  );
}
