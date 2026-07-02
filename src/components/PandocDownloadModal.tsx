import { Show, createSignal, onCleanup } from "solid-js";
import { hasPandoc, downloadPandoc, isTauri } from "../platform";

// Phases mirror the `pandoc-download` events emitted by the Rust command.
type Phase =
  | "confirm"
  | "query"
  | "download"
  | "extract"
  | "install"
  | "verify"
  | "done"
  | "error";

interface Progress {
  phase: Phase;
  percent: number | null;
  message: string | null;
}

const BUSY: Phase[] = ["query", "download", "extract", "install", "verify"];

const [visible, setVisible] = createSignal(false);
const [phase, setPhase] = createSignal<Phase>("confirm");
const [percent, setPercent] = createSignal(0);
const [errorMsg, setErrorMsg] = createSignal("");

let resolveFlow: ((ok: boolean) => void) | null = null;
let unlisten: (() => void) | null = null;

function stopListening() {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}

function finish(ok: boolean) {
  stopListening();
  setVisible(false);
  const r = resolveFlow;
  resolveFlow = null;
  r?.(ok);
}

async function startDownload() {
  setErrorMsg("");
  setPercent(0);
  setPhase("query");

  // Stream progress from the background download task.
  if (isTauri && !unlisten) {
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<Progress>("pandoc-download", (e) => {
      const p = e.payload;
      setPhase(p.phase);
      if (typeof p.percent === "number") setPercent(p.percent);
      if (p.phase === "error" && p.message) setErrorMsg(p.message);
    });
  }

  try {
    await downloadPandoc();
    setPhase("done");
    setPercent(100);
    // Let the success state read for a beat, then continue the export.
    setTimeout(() => finish(true), 900);
  } catch (e) {
    stopListening();
    setPhase("error");
    if (!errorMsg()) setErrorMsg(String(e));
    // Stay open so the user can Retry or Cancel.
  }
}

/**
 * Ensure Pandoc is available, prompting the user to download it (with a progress
 * modal) if it isn't. Resolves `true` once Pandoc is ready to use, `false` if the
 * user cancels. Callers gate their Pandoc work on the result.
 */
export async function ensurePandoc(): Promise<boolean> {
  if (await hasPandoc()) return true;
  setErrorMsg("");
  setPercent(0);
  setPhase("confirm");
  setVisible(true);
  return new Promise<boolean>((resolve) => {
    resolveFlow = resolve;
  });
}

const STEP_LABEL: Record<Phase, string> = {
  confirm: "",
  query: "Contacting GitHub…",
  download: "Downloading Pandoc…",
  extract: "Extracting…",
  install: "Installing…",
  verify: "Verifying…",
  done: "Pandoc installed",
  error: "",
};

export default function PandocDownloadModal() {
  onCleanup(stopListening);
  const busy = () => BUSY.includes(phase());
  const determinate = () => phase() === "download";

  return (
    <Show when={visible()}>
      <div
        class="about-backdrop"
        onMouseDown={(e) => {
          // Backdrop dismiss only while idle-ish (never mid-download).
          if (e.target === e.currentTarget && (phase() === "confirm" || phase() === "error")) {
            finish(false);
          }
        }}
      >
        <div class="pandoc-dl" onKeyDown={(e) => e.key === "Escape" && phase() !== "done" && !busy() && finish(false)} tabindex="-1">
          <div class="pandoc-dl-icon" classList={{ ok: phase() === "done", err: phase() === "error" }}>
            <Show
              when={phase() === "done"}
              fallback={
                <Show
                  when={phase() === "error"}
                  fallback={
                    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
                      <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3v10m0 0 3.5-3.5M12 13 8.5 9.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                    </svg>
                  }
                >
                  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
                    <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 8v5m0 3h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                  </svg>
                </Show>
              }
            >
              <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
                <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5 10 17l9-10" />
              </svg>
            </Show>
          </div>

          <h2 class="pandoc-dl-title">
            {phase() === "confirm"
              ? "Pandoc needed"
              : phase() === "done"
                ? "All set"
                : phase() === "error"
                  ? "Download failed"
                  : "Setting up Pandoc"}
          </h2>

          <Show when={phase() === "confirm"}>
            <p class="pandoc-dl-text">
              DOCX, EPUB and other rich exports use <strong>Pandoc</strong>. It isn't installed
              yet — download it now? About 30&nbsp;MB, one-time, kept in the app's data folder.
            </p>
          </Show>

          <Show when={busy() || phase() === "done"}>
            <div class="pandoc-bar" classList={{ indet: !determinate() && phase() !== "done" }}>
              <div class="pandoc-bar-fill" style={{ width: determinate() || phase() === "done" ? `${percent()}%` : undefined }} />
            </div>
            <p class="pandoc-dl-step">
              {STEP_LABEL[phase()]}
              <Show when={determinate()}> <span class="pandoc-dl-pct">{percent()}%</span></Show>
            </p>
          </Show>

          <Show when={phase() === "error"}>
            <p class="pandoc-dl-text err">{errorMsg()}</p>
            <p class="pandoc-dl-hint">You can also install Pandoc yourself from pandoc.org.</p>
          </Show>

          <div class="pandoc-dl-actions">
            <Show when={phase() === "confirm"}>
              <button class="pandoc-btn ghost" onClick={() => finish(false)}>Cancel</button>
              <button class="pandoc-btn primary" onClick={() => void startDownload()}>Download</button>
            </Show>
            <Show when={phase() === "error"}>
              <button class="pandoc-btn ghost" onClick={() => finish(false)}>Cancel</button>
              <button class="pandoc-btn primary" onClick={() => void startDownload()}>Retry</button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
