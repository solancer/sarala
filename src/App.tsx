import { Show, createEffect, onMount, onCleanup, untrack } from "solid-js";
import Editor from "./components/Editor";
import DocumentTabs from "./components/DocumentTabs";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import SourceView from "./components/SourceView";
import QuickOpen from "./components/QuickOpen";
import CommandPalette from "./components/CommandPalette";
import FindBar from "./components/FindBar";
import TableDialog from "./components/TableDialog";
import ImageContextMenu from "./components/ImageContextMenu";
import EditorContextMenu from "./components/EditorContextMenu";
import SelectionToolbar from "./components/SelectionToolbar";
import EmojiMenu from "./components/EmojiMenu";
import SlashMenu from "./components/SlashMenu";
import PaletteSwitcher from "./components/PaletteSwitcher";
import AboutModal from "./components/AboutModal";
import SettingsModal from "./components/SettingsModal";
import ThemeEditor from "./components/ThemeEditor";
import ThemePicker from "./components/ThemePicker";
import PandocDownloadModal from "./components/PandocDownloadModal";
import UpdateModal from "./components/UpdateModal";
import ExportHtmlDialog from "./components/ExportHtmlDialog";
import ConflictBanner from "./components/ConflictBanner";
import MenuBar from "./components/MenuBar";
import AiPanel from "./components/AiPanel";
import AiRail from "./components/AiRail";
import AiEditorMarks from "./components/AiEditorMarks";
import VoiceHud, { VoiceButton } from "./components/VoiceHud";
import VoiceSetup from "./components/VoiceSetup";
import VoiceCommands from "./components/VoiceCommands";
import { aiPanelOpen, aiRailVisible } from "./ai/config";
import { flushChatSaves } from "./ai/session";
import { initSettings } from "./settings";
import { base16ToCss } from "./base16";
import { autoCheckForUpdates } from "./updater";
import {
  activeTabId, openTabs, removeTab, currentTabView, setTabViewProvider, cycleTab, setTabExternalChange,
  doc, theme, sourceMode, setSourceMode, sidebarOpen, setSidebarOpen,
  fileName, setActive, fileTree, folderName, THEMES, targetBlockIndex,
  spellcheckOn, smartPunctuation, preserveBreaks, lineEnding, copyImageToAssets,
  focusMode, typewriterMode, statusBarVisible, alwaysOnTop, zoom, tableFullWidth,
  mathAltDelimiters, mathFence, bumpMermaidEpoch, customScheme,
  emojiEnabled, highlightEnabled, subSupEnabled, autolinkEnabled,
  finalNewline, autosaveInterval,
} from "./store";
import {
  isTauri, isMac, setMenuChecked, setMenuEnabled, confirmDialog, IMAGE_EXTS,
  onExternalChange,
} from "./platform";
import {
  executeCommand, openFile, openFolder, insertImageFromPath,
} from "./commands";
import { BLOCK_TARGETED_IDS } from "./menudata";
import { makeMenuKeyHandler } from "./shortcuts";
import { startAutosave, findRecoverable, restoreSession, shadowBaseName, discardShadows, discardShadowFor } from "./autosave";

export default function App() {
  let editorEl: HTMLDivElement | undefined;

  const jumpTo = (blockIndex: number) => {
    setActive(-1);
    // Programmatic smooth scroll is silently dropped while the editor
    // re-renders, so set scrollTop directly after the deactivation settles.
    requestAnimationFrame(() => {
      const el = editorEl?.querySelectorAll<HTMLElement>(".block")[blockIndex];
      if (!el || !editorEl) return;
      const top = el.getBoundingClientRect().top - editorEl.getBoundingClientRect().top
        + editorEl.scrollTop - 16;
      editorEl.scrollTo({ top: Math.max(0, top) });
    });
  };

  // Browser fallback only: in Tauri these chords are native menu accelerators,
  // which dispatch through the "menu" event; handling both would double-fire.
  const onKey = (e: KeyboardEvent) => {
    // Already handled (e.g. a block ran Undo for Cmd/Ctrl+Z): running it again
    // here made every undo in the browser build go back two steps.
    if (e.defaultPrevented) return;
    if (document.querySelector('[aria-modal="true"]')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "n" && !e.shiftKey) { e.preventDefault(); executeCommand("file.new"); }
    if (k === "w") { e.preventDefault(); executeCommand("file.close"); }
    if (k === "z") { e.preventDefault(); executeCommand(e.shiftKey ? "edit.redo" : "edit.undo"); }
    if (k === "a") { e.preventDefault(); executeCommand("edit.select_all"); }
    if (k === "s") { e.preventDefault(); executeCommand("file.save"); }
    if (k === "o" && e.shiftKey) { e.preventDefault(); executeCommand("file.open_folder"); }
    else if (k === "o") { e.preventDefault(); executeCommand("file.open"); }
    if (k === "/") { e.preventDefault(); executeCommand("view.source_mode"); }
    if (k === "l" && e.shiftKey) { e.preventDefault(); executeCommand("view.sidebar"); }
    if (k === "e" && e.shiftKey) { e.preventDefault(); executeCommand("file.export.html"); }
    if (k === "p" && e.shiftKey) { e.preventDefault(); executeCommand("file.open_quickly"); }
    if (k === "f" && e.altKey) { e.preventDefault(); executeCommand("edit.replace"); }
    else if (k === "f" && !e.shiftKey) { e.preventDefault(); executeCommand("edit.find"); }
    if (k === "g") { e.preventDefault(); executeCommand("edit.find_next"); }
    if (k === "v" && e.shiftKey) { e.preventDefault(); executeCommand("edit.paste_plain"); }
  };

  onMount(() => {
    setTabViewProvider(() => {
      const source = editorEl?.querySelector<HTMLTextAreaElement>(".source-full");
      return { scrollTop: editorEl?.scrollTop ?? 0, sourceStart: source?.selectionStart ?? 0, sourceEnd: source?.selectionEnd ?? 0 };
    });
    const tabKeys = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (e.ctrlKey && e.key === "Tab" && !e.altKey && !e.metaKey) {
        e.preventDefault(); e.stopImmediatePropagation(); cycleTab(e.shiftKey ? -1 : 1);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t" && !e.altKey && !e.shiftKey) {
        e.preventDefault(); e.stopImmediatePropagation(); executeCommand("file.new");
      }
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!isTauri && openTabs().some((tab) => tab.dirty)) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("keydown", tabKeys, true);
    window.addEventListener("beforeunload", beforeUnload);
    onCleanup(() => {
      setTabViewProvider(null);
      window.removeEventListener("keydown", tabKeys, true);
      window.removeEventListener("beforeunload", beforeUnload);
    });
    void initSettings();
    // Safety net: no link anywhere may navigate the webview itself (it would
    // replace the whole app with the page). Components open links on purpose
    // through followLink/openExternal; any click they left unhandled, including
    // middle-clicks, stops here. Bubble phase, so their handlers run first.
    const stopNavigation = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (a && !e.defaultPrevented) e.preventDefault();
    };
    document.addEventListener("click", stopNavigation);
    document.addEventListener("auxclick", stopNavigation);
    onCleanup(() => {
      document.removeEventListener("click", stopNavigation);
      document.removeEventListener("auxclick", stopNavigation);
    });
    // Command palette (Cmd/Ctrl+K). Bound globally on every platform — it isn't
    // a menu accelerator, so there's no native-menu double-fire to avoid.
    const onPaletteKey = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        executeCommand("menu.command_palette");
      }
    };
    window.addEventListener("keydown", onPaletteKey);
    onCleanup(() => window.removeEventListener("keydown", onPaletteKey));
    // Keyboard accelerators for the in-app menu (Linux/Windows/browser). macOS
    // gets them from its native menu, so it's excluded to avoid double-firing.
    if (!isMac) {
      const handleMenuKey = makeMenuKeyHandler();
      const onMenuKey = (e: KeyboardEvent) => { if (!document.querySelector('[aria-modal="true"]')) handleMenuKey(e); };
      window.addEventListener("keydown", onMenuKey);
      onCleanup(() => window.removeEventListener("keydown", onMenuKey));
    }
    if (isTauri) {
      // Suppress the webview's native right-click menu (Inspect Element, Reload,
      // …). The app draws its own context menus (e.g. images), which run on the
      // target element before this document-level handler, so they still open.
      const onCtxMenu = (e: MouseEvent) => e.preventDefault();
      document.addEventListener("contextmenu", onCtxMenu);
      onCleanup(() => document.removeEventListener("contextmenu", onCtxMenu));

      let unlisten: (() => void) | undefined;
      import("@tauri-apps/api/event").then(async ({ listen }) => {
        unlisten = await listen<string>("menu", (e) => {
          if (!document.querySelector('[aria-modal="true"]')) executeCommand(e.payload);
        });
      });
      // Dropped image files insert through the same path as Insert Image….
      let undrop: (() => void) | undefined;
      import("@tauri-apps/api/webviewWindow").then(async ({ getCurrentWebviewWindow }) => {
        undrop = await getCurrentWebviewWindow().onDragDropEvent((e) => {
          if (e.payload.type !== "drop") return;
          for (const path of e.payload.paths) {
            const ext = path.split(".").pop()?.toLowerCase() ?? "";
            if (IMAGE_EXTS.includes(ext)) void insertImageFromPath(path);
            else if (["md", "markdown", "txt"].includes(ext)) void openFile(path);
          }
        });
      });
      // Confirm before closing a window with unsaved changes.
      let unclose: (() => void) | undefined;
      import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        unclose = await win.onCloseRequested(async (event) => {
          flushChatSaves();
          const dirty = openTabs().filter((tab) => tab.dirty);
          if (!dirty.length) return;
          event.preventDefault();
          if (await confirmDialog(`Close the window and discard unsaved changes to ${dirty.map((tab) => tab.name).join(", ")}?`)) {
            // Deliberately discarding — drop the autosave shadow so the next
            // launch doesn't offer to "recover" these changes. (A crash skips
            // this handler, so genuine crash recovery still works.)
            for (const tab of dirty) removeTab(tab.id);
            await Promise.all(dirty.map((tab) => discardShadowFor(tab.filePath)));
            await win.destroy();
          }
        });

        // Crash recovery runs once, in the initial window (new windows carry a
        // "main-<ts>" label), so user-opened windows don't re-prompt.
        if (win.label === "main") {
          const cands = await findRecoverable();
          if (cands.length) {
            const newest = cands[0];
            const extra = cands.length > 1
              ? ` (and ${cands.length - 1} more — open those files to recover them)`
              : "";
            const ok = await confirmDialog(
              `Unsaved changes from a previous session were found for ${shadowBaseName(newest.path)}${extra}. Restore them now?`,
            );
            // Restore the newest and keep the rest for per-file recovery; on
            // decline, discard every candidate so this never re-prompts.
            if (ok) await restoreSession(newest);
            else await discardShadows(cands);
          }

          // Once per launch (main window only, after any recovery prompt),
          // quietly check the updater endpoint; opens UpdateModal if a newer
          // release exists, stays silent otherwise.
          void autoCheckForUpdates();
        }
      });

      // Reload-or-keep conflict banner: surface the Rust watcher's events.
      let unwatch: (() => void) | undefined;
      onExternalChange((path, deleted) => setTabExternalChange(path, deleted)).then((u) => {
        unwatch = u;
      });

      // Autosave shadows of dirty (saved) documents.
      startAutosave();

      onCleanup(() => { unlisten?.(); undrop?.(); unclose?.(); unwatch?.(); });
    } else if (isMac) {
      // Browser dev on macOS has neither a native menu nor the in-app menubar,
      // so keep the minimal chord fallback there.
      window.addEventListener("keydown", onKey);
      onCleanup(() => window.removeEventListener("keydown", onKey));
    }
  });

  // The Custom theme has no hand-authored [data-theme] block — its tokens are
  // derived from the base16 scheme and injected as a stylesheet, so importing or
  // editing a swatch restyles the app without a reload.
  createEffect(() => {
    const scheme = customScheme();
    let el = document.getElementById("custom-theme") as HTMLStyleElement | null;
    if (!scheme) { el?.remove(); return; }
    if (!el) {
      el = document.createElement("style");
      el.id = "custom-theme";
      document.head.appendChild(el);
    }
    el.textContent = base16ToCss(scheme);
  });

  createEffect(() => {
    const id = activeTabId();
    const view = untrack(currentTabView);
    requestAnimationFrame(() => {
      if (activeTabId() === id && editorEl) editorEl.scrollTop = view.scrollTop;
    });
  });

  // Window title: "Notes.md — Edited".
  createEffect(() => {
    const title = `${fileName()}${doc.dirty ? " — Edited" : ""}`;
    if (isTauri) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow().setTitle(`${title} — Sarala`).catch(() => {})
      );
    } else {
      document.title = `${title} — Sarala`;
    }
  });

  // Keep native check/radio menu items in sync with frontend state.
  createEffect(() => setMenuChecked("view.source_mode", sourceMode()));
  createEffect(() => setMenuChecked("view.sidebar", sidebarOpen()));
  createEffect(() => {
    const current = theme();
    for (const id of THEMES) setMenuChecked(`themes.set.${id}`, id === current);
  });
  createEffect(() => setMenuChecked("edit.spellcheck", spellcheckOn()));
  createEffect(() => setMenuChecked("format.image.copy_to_folder", copyImageToAssets()));
  createEffect(() => setMenuChecked("view.focus_mode", focusMode()));
  createEffect(() => setMenuChecked("view.typewriter_mode", typewriterMode()));
  createEffect(() => setMenuChecked("view.status_bar", statusBarVisible()));
  createEffect(() => setMenuChecked("ai.toggle_panel", aiPanelOpen()));
  createEffect(() => setMenuChecked("view.always_on_top", alwaysOnTop()));

  // Selection-dependent enabling: block-targeted items are disabled until
  // some block has held the caret (then targetBlockIndex keeps them valid).
  // The in-app menubar reads BLOCK_TARGETED_IDS directly; this effect only
  // mirrors the state to the native macOS menu (a no-op elsewhere).
  let lastBlockEnabled: boolean | null = null;
  createEffect(() => {
    void doc.activeIndex;
    const enabled = targetBlockIndex() >= 0;
    if (enabled === lastBlockEnabled) return;
    lastBlockEnabled = enabled;
    for (const id of BLOCK_TARGETED_IDS) void setMenuEnabled(id, enabled);
  });

  // Typewriter mode: keep the line being edited vertically centered.
  createEffect(() => {
    if (!typewriterMode()) return;
    const i = doc.activeIndex;
    if (i < 0) return;
    void doc.blocks[i]?.text; // re-center as the user types
    requestAnimationFrame(() => {
      editorEl?.querySelectorAll(".block")[i]?.scrollIntoView({ block: "center" });
    });
  });
  createEffect(() => setMenuChecked("edit.smart_punctuation", smartPunctuation()));
  createEffect(() => setMenuChecked("edit.preserve_breaks", preserveBreaks()));
  createEffect(() => setMenuChecked("edit.math.alt_delimiters", mathAltDelimiters()));
  createEffect(() => setMenuChecked("edit.math.fence", mathFence()));
  createEffect(() => setMenuChecked("edit.ext.highlight", highlightEnabled()));
  createEffect(() => setMenuChecked("edit.ext.sub_sup", subSupEnabled()));
  createEffect(() => setMenuChecked("edit.ext.emoji", emojiEnabled()));
  createEffect(() => setMenuChecked("edit.ext.autolink", autolinkEnabled()));
  // Re-render mermaid diagrams when the theme switches (dark/light).
  createEffect(() => { theme(); bumpMermaidEpoch(); });
  createEffect(() => {
    const le = lineEnding();
    void setMenuChecked("edit.line_ending.lf", le === "lf");
    void setMenuChecked("edit.line_ending.crlf", le === "crlf");
  });
  createEffect(() => {
    const fn = finalNewline();
    void setMenuChecked("edit.final_newline.ensure", fn === "ensure");
    void setMenuChecked("edit.final_newline.preserve", fn === "preserve");
    void setMenuChecked("edit.final_newline.trim", fn === "trim");
  });
  createEffect(() => {
    const s = autosaveInterval();
    void setMenuChecked("edit.autosave.off", s === 0);
    void setMenuChecked("edit.autosave.5", s === 5);
    void setMenuChecked("edit.autosave.15", s === 15);
    void setMenuChecked("edit.autosave.30", s === 30);
  });
  // Reflect the open document's encoding in the Reopen-with-Encoding radio.
  createEffect(() => {
    const enc = doc.encoding.toLowerCase();
    void setMenuChecked("edit.encoding.utf-8", enc === "utf-8" && !doc.hadBom);
    void setMenuChecked("edit.encoding.utf8_bom", enc === "utf-8" && doc.hadBom);
  });

  return (
    <div
      class="app"
      data-theme={theme()}
      classList={{ "focus-mode": focusMode(), "tables-full": tableFullWidth(), "is-tauri": isTauri, "is-mac": isMac }}
      style={{ "--zoom": `${zoom()}%`, "--editor-scale": zoom() / 100 }}
    >
      {/* In-app menubar strip, replacing the OS menu bar (not on macOS). */}
      <Show when={!isMac}>
        <MenuBar />
      </Show>
      <div class="body">
        {/* Always mounted so the collapse can animate (margin-left slide);
            visibility is driven by sidebarOpen() inside Sidebar. */}
        <Sidebar
          tree={fileTree()}
          folderName={folderName()}
          onOpenFolder={openFolder}
          onOpenFile={openFile}
          onJump={jumpTo}
        />
        <main class="main">
          {/* The document's name is the page's top-level heading for screen
              readers (the visible title lives in the tab strip). */}
          <h1 class="sr-only">{fileName()}</h1>
          <header class="topfloat document-toolbar" aria-label="Documents and controls" data-tauri-drag-region="deep">
            {isTauri && isMac && <span class="topbar-traffic" aria-hidden="true" />}
            <button
              class="topbar-toggle icon-btn"
              title="Toggle sidebar (Shift+Cmd/Ctrl+L)"
              aria-label="Toggle sidebar" aria-expanded={sidebarOpen()} aria-controls="workspace-sidebar"
              onClick={() => setSidebarOpen(!sidebarOpen())}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />
              </svg>
            </button>
            <DocumentTabs />
            <div class="document-header-actions">
            <button
              class="topbar-search"
              title="Command palette (Cmd/Ctrl+K)" aria-label="Search commands"
              onClick={() => executeCommand("menu.command_palette")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
              </svg>
              <span class="topbar-search-label">Search commands…</span>
              <span class="kbd">{isMac ? "⌘K" : "Ctrl K"}</span>
            </button>
            {/* Divides the global action (command palette) from the controls
                that act on this view. Focus mode sits with Live/Source because
                it *is* a view mode; beside the palette it read as unrelated. */}
            <span class="topfloat-sep" aria-hidden="true" />
            {/* Voice typing sits with the writing controls (shown once it is
                turned on). */}
            <VoiceButton variant="topbar" />
            <button
              class="topbar-toggle icon-btn"
              classList={{ on: focusMode() }}
              title="Focus mode" aria-label="Focus mode" aria-pressed={focusMode()}
              onClick={() => executeCommand("view.focus_mode")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
              </svg>
            </button>
            <div class="view-toggle" role="group" aria-label="Editor view">
              <button aria-pressed={!sourceMode()} classList={{ on: !sourceMode() }} onClick={() => setSourceMode(false)}>Live</button>
              <button aria-pressed={sourceMode()} classList={{ on: sourceMode() }} onClick={() => setSourceMode(true)}>Source</button>
            </div>
            </div>
          </header>
          <FindBar />
          <ConflictBanner />
          <div class="scroll" ref={editorEl} id="document-panel" role="tabpanel" aria-labelledby={`document-tab-${activeTabId()}`}>
            <Show when={!sourceMode()} fallback={
              <Show when={activeTabId()} keyed>{(id) => id && <SourceView />}</Show>
            }>
              <Editor />
            </Show>
          </div>
          <Show when={statusBarVisible()}>
            <StatusBar />
          </Show>
          {/* Editor popups are fixed-position; they live inside <main> so
              assistive tech finds them in the editor's landmark. */}
          <EditorContextMenu />
          <VoiceHud />
          {/* Live view only — Source mode is a plain textarea with no block model. */}
          <Show when={!sourceMode()}>
            <SelectionToolbar />
            <SlashMenu />
            <EmojiMenu />
          </Show>
        </main>
        <AiPanel />
        <AiEditorMarks />
        {/* Focus mode quiets the rail (ai.css) instead of removing it:
            removing it widened the main area and shifted the whole top bar. */}
        <Show when={aiRailVisible()}>
          <AiRail />
        </Show>
      </div>
      <PaletteSwitcher />
      <QuickOpen />
      <CommandPalette />
      <TableDialog />
      <ImageContextMenu />
      <AboutModal />
      <SettingsModal />
      <ThemeEditor />
      <ThemePicker />
      <PandocDownloadModal />
      <VoiceSetup />
      <VoiceCommands />
      <UpdateModal />
      <ExportHtmlDialog />
    </div>
  );
}
