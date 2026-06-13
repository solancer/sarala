import { For } from "solid-js";
import { theme, THEMES } from "../store";
import { executeCommand } from "../commands";

// A representative dot color per theme (its accent).
const DOTS: Record<string, string> = {
  sarala: "#e0566a",
  paper: "#0e6a60",
  graphite: "#58bdb0",
  github: "#4183c4",
  night: "#6cb2f7",
  newsprint: "#a4502f",
  whitey: "#2f6fed",
};

/** Floating palette pill (bottom-right): one dot per theme. */
export default function PaletteSwitcher() {
  return (
    <div class="palette">
      <span class="palette-label">palette</span>
      <For each={THEMES}>
        {(id) => (
          <button
            class="palette-dot"
            classList={{ on: theme() === id }}
            title={id}
            style={{ background: DOTS[id] }}
            onClick={() => executeCommand(`themes.set.${id}`)}
          />
        )}
      </For>
    </div>
  );
}
