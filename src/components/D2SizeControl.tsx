/**
 * Hover controls for a rendered ```d2 diagram: a theme picker and a "− NN% +"
 * size pill, anchored in the block's top-right corner. Both write into the
 * fence info string (`theme=NN`, `zoom=NN`), so they persist in the document
 * and bake into exports. Revealed on block hover via CSS (.d2-controls).
 */

import { For } from "solid-js";
import { D2_THEMES } from "../d2";

// Discrete zoom steps, mirroring the image zoom levels (imageactions.ts).
const STEPS = [25, 50, 75, 100, 125, 150, 200];

interface Props {
  /** Current zoom percent (100 when unset). */
  zoom: number;
  /** Persist a new zoom percent into the fence info string. */
  onZoom: (percent: number) => void;
  /** Current D2 theme id (string), or null when following the app theme. */
  theme: string | null;
  /** Persist a theme id (null = auto / follow app light-dark). */
  onTheme: (theme: string | null) => void;
}

export default function D2SizeControl(props: Props) {
  // Nearest step to the current zoom, so − / + always move one notch.
  const index = () => {
    let best = 0;
    for (let i = 1; i < STEPS.length; i++) {
      if (Math.abs(STEPS[i] - props.zoom) < Math.abs(STEPS[best] - props.zoom)) best = i;
    }
    return best;
  };
  const step = (dir: -1 | 1) => {
    const next = STEPS[Math.min(STEPS.length - 1, Math.max(0, index() + dir))];
    if (next !== props.zoom) props.onZoom(next);
  };

  // Keep clicks from bubbling to any block-level handler, but DON'T
  // preventDefault — that would stop the native <select> from opening.
  const guard = (e: MouseEvent) => { e.stopPropagation(); };

  return (
    <div class="d2-controls" contentEditable={false} onMouseDown={guard}>
      <select
        class="d2-theme-select"
        title="Diagram theme"
        value={props.theme ?? ""}
        onChange={(e) => props.onTheme(e.currentTarget.value || null)}
      >
        <option value="">Auto (theme)</option>
        <For each={D2_THEMES}>
          {(t) => <option value={String(t.id)}>{t.name}</option>}
        </For>
      </select>
      <span class="d2-controls-sep" />
      <button class="d2-zoom-btn" title="Smaller" disabled={index() === 0} onClick={() => step(-1)}>
        −
      </button>
      <button class="d2-zoom-label" title="Reset to 100%" onClick={() => props.onZoom(100)}>
        {props.zoom}%
      </button>
      <button
        class="d2-zoom-btn"
        title="Larger"
        disabled={index() === STEPS.length - 1}
        onClick={() => step(1)}
      >
        +
      </button>
    </div>
  );
}
