import { Show, createSignal } from "solid-js";
import { openExternal } from "../platform";

const APP_VERSION = "0.1.0";
const REPO_URL = "https://github.com/srinivasgowda/sarala";

const [visible, setVisible] = createSignal(false);
export function openAbout() {
  setVisible(true);
}

/** About Sarala dialog: name, version, author, license. */
export default function AboutModal() {
  return (
    <Show when={visible()}>
      <div class="about-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setVisible(false)}>
        <div class="about" onKeyDown={(e) => e.key === "Escape" && setVisible(false)} tabindex="-1">
          <div class="about-mark">ಸ</div>
          <h2 class="about-name">Sarala</h2>
          <div class="about-version">Version {APP_VERSION}</div>
          <p class="about-tagline">A seamless WYSIWYG Markdown editor — no preview pane, no split view.</p>
          <div class="about-meta">
            <div><span>Author</span> Srinivas Gowda</div>
            <div><span>License</span> GPL-3.0</div>
          </div>
          <div class="about-actions">
            <button class="ghost-btn" onClick={() => openExternal(REPO_URL)}>Source</button>
            <button class="ghost-btn primary" onClick={() => setVisible(false)}>Close</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
