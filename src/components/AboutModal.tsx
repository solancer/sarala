import { Show, createSignal } from "solid-js";
import { openExternal, isTauri } from "../platform";
import appIcon from "../../src-tauri/icons/128x128.png";

const WEBSITE_URL = "https://sarala.solancer.com";
const REPO_URL = "https://github.com/solancer/sarala";
const AUTHOR_URL = "https://solancer.com";

// Shown in the browser dev build; the Tauri app replaces it with the real
// running version (from tauri.conf.json) via getVersion() on open.
const FALLBACK_VERSION = "0.2.3";

const [visible, setVisible] = createSignal(false);
const [version, setVersion] = createSignal(FALLBACK_VERSION);

export function openAbout() {
  setVisible(true);
  if (isTauri) {
    void import("@tauri-apps/api/app").then(({ getVersion }) =>
      getVersion().then(setVersion).catch(() => {}),
    );
  }
}

/** About Sarala dialog: name, live version, links, author, license. */
export default function AboutModal() {
  const close = () => setVisible(false);
  return (
    <Show when={visible()}>
      <div class="about-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div class="about" onKeyDown={(e) => e.key === "Escape" && close()} tabindex="-1">
          <button class="about-close" title="Close" aria-label="Close" onClick={close}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>

          <img class="about-mark" src={appIcon} alt="Sarala" width="68" height="68" />
          <h2 class="about-name">Sarala</h2>
          <div class="about-version">v{version()}</div>
          <p class="about-tagline">A seamless WYSIWYG Markdown editor — no preview pane, no split view.</p>

          <div class="about-links">
            <button class="about-link" onClick={() => openExternal(WEBSITE_URL)}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <g fill="none" stroke="currentColor" stroke-width="1.2">
                  <circle cx="8" cy="8" r="6.4" />
                  <ellipse cx="8" cy="8" rx="2.7" ry="6.4" />
                  <path d="M1.7 8h12.6M2.3 5.4h11.4M2.3 10.6h11.4" />
                </g>
              </svg>
              Website
            </button>
            <button class="about-link" onClick={() => openExternal(REPO_URL)}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path fill="currentColor" d="M8 .2a8 8 0 0 0-2.5 15.6c.4.1.5-.17.5-.38v-1.33c-2.03.44-2.46-.98-2.46-.98-.33-.84-.81-1.07-.81-1.07-.66-.45.05-.44.05-.44.73.05 1.12.75 1.12.75.65 1.12 1.71.8 2.13.61.07-.47.25-.8.46-.98-1.62-.18-3.32-.81-3.32-3.6 0-.8.28-1.45.75-1.96-.08-.19-.33-.94.07-1.96 0 0 .61-.2 2 .75a6.9 6.9 0 0 1 3.64 0c1.39-.95 2-.75 2-.75.4 1.02.15 1.77.07 1.96.47.51.75 1.16.75 1.96 0 2.8-1.7 3.42-3.33 3.6.26.22.49.66.49 1.33v1.98c0 .21.13.47.55.38A8 8 0 0 0 8 .2Z" />
              </svg>
              GitHub
            </button>
          </div>

          <div class="about-meta">
            <div>
              <span>Author</span>
              <button class="about-inline-link" onClick={() => openExternal(AUTHOR_URL)}>
                Srinivas Gowda
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <path fill="currentColor" d="M6.5 3H12a1 1 0 0 1 1 1v5.5h-1.5V5.56l-5.97 5.97L4.47 10.5l5.97-5.97H6.5V3Z" />
                </svg>
              </button>
            </div>
            <div><span>License</span> GPL-3.0</div>
          </div>

          <div class="about-footer">© {new Date().getFullYear()} · Made with ♥ in Bengaluru</div>
        </div>
      </div>
    </Show>
  );
}
