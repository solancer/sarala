import { For, Show, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { folderPath, fileTree, openDocuments, openTabs, switchTab } from "../store";
import { isWeb, searchInFolder, web, type FolderSearchHit, type FileNode } from "../platform";
import { joinBlocks } from "../markdown";
import { buildSearchRegex, matchLines, MAX_PER_FILE, MAX_TOTAL } from "../search";
import { openFindWith } from "./FindBar";

interface Props {
  onOpenFile: (path: string) => void;
}

/** A result; `tabId` marks a draft, which has no path to open it by. */
type Hit = FolderSearchHit & { tabId?: number };

let inputEl: HTMLInputElement | undefined;

/** Put the caret in the search field, once the panel is showing. */
export function focusSearch() {
  queueMicrotask(() => {
    inputEl?.focus();
    inputEl?.select();
  });
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** Flatten the workspace tree to its files (depth-first, dirs dropped). */
function flattenFiles(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    if (n.is_dir) flattenFiles(n.children ?? [], out);
    else out.push(n);
  }
  return out;
}

/**
 * Global folder search: text/regex across every markdown file in the open
 * folder (on the web, the library and every added folder), backed by the Rust
 * `search_in_folder` command. An open document with unsaved changes is searched
 * as it stands, not as last saved. Results lead with files whose *name* matches
 * the query (even when their contents don't), then files that match only in
 * their contents — so filenames come first, contents after. Clicking a line
 * opens the file and re-runs the same search in the in-document find bar, at
 * that match, so the hit is highlighted and scrolled into view.
 */
const SCOPE = isWeb ? "Search all documents…" : "Search in folder…";

export default function SearchPanel(props: Props) {
  const [query, setQuery] = createSignal("");
  const [regex, setRegex] = createSignal(false);
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [wholeWord, setWholeWord] = createSignal(false);
  const [saved, setSaved] = createSignal<FolderSearchHit[]>([]);
  const [searching, setSearching] = createSignal(false);

  const options = () => ({ regex: regex(), caseSensitive: caseSensitive(), wholeWord: wholeWord() });
  const pattern = createMemo(() => buildSearchRegex(query().trim(), options()));
  const invalid = () => !!query().trim() && !pattern();
  const [failure, setFailure] = createSignal("");
  const blocked = () => web?.blockedFolders() ?? [];

  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = 0;
  onCleanup(() => clearTimeout(timer));

  // Debounced search of what's stored; re-runs on query OR option changes, and
  // when a save, a closed tab or a reconnected folder changes what's stored.
  createEffect(() => {
    const q = query().trim();
    const opts = options();
    const root = folderPath();
    void openTabs();
    void blocked();
    clearTimeout(timer);
    const run = ++latest;
    if (!q || !root || !pattern()) {
      setSaved([]);
      setFailure("");
      setSearching(false);
      return;
    }
    setSearching(true);
    timer = setTimeout(async () => {
      try {
        const res = await searchInFolder(root, q, opts);
        if (run !== latest) return;
        setSaved(res);
        setFailure("");
      } catch (e) {
        if (run !== latest) return;
        setSaved([]);
        // The find bar's engine accepted this pattern, or it wouldn't get here.
        setFailure(String(e).includes("Invalid pattern") ? "Pattern not supported in folder search" : "Couldn't search this folder");
      }
      setSearching(false);
    }, 220);
  });

  // The stored results, with each document that has unsaved changes searched
  // as it stands. A draft is one of the web's documents, but in no folder.
  const hits = createMemo<Hit[]>(() => {
    const re = pattern();
    if (!re || failure()) return [];
    const inWorkspace = new Set(flattenFiles(fileTree()).map((f) => f.path));
    const edited = new Map<string, Hit>();
    const drafts: Hit[] = [];
    for (const { id, document } of openDocuments()) {
      const path = document.filePath;
      if (path ? !document.dirty || !inWorkspace.has(path) : !isWeb) continue;
      const matches = matchLines(joinBlocks(document.blocks.map((b) => b.text)), re);
      if (path) edited.set(path, { path, name: path.split("/").pop() ?? path, matches });
      else if (matches.length) drafts.push({ path: "", name: "Untitled.md", matches, tabId: id });
    }
    const merged = saved().flatMap((h): Hit[] => {
      const hit = edited.get(h.path) ?? h;
      edited.delete(h.path);
      return hit.matches.length ? [hit] : [];
    });
    return [...merged, ...[...edited.values()].filter((h) => h.matches.length), ...drafts];
  });

  // Final ordered list: filename matches first (carrying any content matches
  // they also have), then content-only matches in the Rust-provided order.
  const results = createMemo<Hit[]>(() => {
    const contentHits = hits();
    const re = pattern();
    if (!re || failure()) return [];
    const byPath = new Map(contentHits.map((h) => [h.path, h]));

    const named: Hit[] = [];
    const seen = new Set<string>();
    for (const f of flattenFiles(fileTree())) {
      if (seen.has(f.path) || f.name.search(re) < 0) continue;
      named.push(byPath.get(f.path) ?? { path: f.path, name: f.name, matches: [] });
      seen.add(f.path);
    }

    const contentOnly = contentHits.filter((h) => !seen.has(h.path));
    return [...named, ...contentOnly];
  });

  const totalMatches = () => results().reduce((sum, f) => sum + f.matches.length, 0);

  // Says what the numbers are, for everyone and for screen readers.
  const summary = () => {
    if (invalid()) return "Invalid pattern";
    if (failure()) return failure();
    const total = totalMatches();
    const byName = results().filter((f) => !f.matches.length).length;
    const capped = total >= MAX_TOTAL || results().some((f) => f.matches.length >= MAX_PER_FILE);
    const parts: string[] = [];
    if (total) parts.push(`${total}${capped ? "+" : ""} ${total === 1 ? "match" : "matches"} in ${files(results().length - byName)}`);
    if (byName) parts.push(`${files(byName)} by name`);
    return parts.join(", ") || "No matches";
  };

  const openHit = (file: Hit, hit: number) => {
    if (file.tabId === undefined) props.onOpenFile(file.path);
    else switchTab(file.tabId);
    // A file found by its name alone has nothing to show in the find bar.
    if (file.matches.length) openFindWith(query().trim(), options(), { path: file.tabId === undefined ? file.path : null, hit });
  };

  return (
    <div class="search-panel">
      <div class="search-field">
        <svg class="search-field-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={inputEl}
          class="search-input"
          aria-label={SCOPE} placeholder={SCOPE}
          aria-invalid={invalid()}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
        />
      </div>
      <div class="search-toggles">
        <button class="find-toggle" classList={{ on: caseSensitive() }}
          title="Match case" aria-label="Match case" aria-pressed={caseSensitive()} onClick={() => setCaseSensitive(!caseSensitive())}>Aa</button>
        <button class="find-toggle" classList={{ on: wholeWord() }}
          title="Whole word" aria-label="Whole word" aria-pressed={wholeWord()} onClick={() => setWholeWord(!wholeWord())}>W</button>
        <button class="find-toggle mono" classList={{ on: regex() }}
          title="Use regular expression" aria-label="Use regular expression" aria-pressed={regex()} onClick={() => setRegex(!regex())}>.*</button>
        <Show when={query().trim() && !searching()}>
          <span class="search-summary" role="status">{summary()}</span>
        </Show>
      </div>

      <Show when={query().trim() && blocked().length}>
        <div class="search-blocked" role="status">
          <span>Not searched: {blocked().join(", ")}</span>
          <button class="table-insert" onClick={() => void web?.reconnectFolders()}>Reconnect</button>
        </div>
      </Show>

      <Show when={query().trim() && !searching() && results().length === 0}>
        <div class="search-empty" aria-hidden="true">{summary()}</div>
      </Show>

      <For each={results()}>
        {(file) => (
          <div class="search-file">
            <button class="search-file-head" onClick={() => openHit(file, 0)} title={file.path || file.name}>
              <span class="search-file-name">{file.name}</span>
              <Show when={file.matches.length > 0}>
                <span class="search-file-count">{file.matches.length}{file.matches.length >= MAX_PER_FILE ? "+" : ""}</span>
              </Show>
            </button>
            <For each={file.matches}>
              {(m, i) => (
                <button class="search-hit" onClick={() => openHit(file, i())}>
                  <span class="search-hit-line"><span class="sr-only">Line </span>{m.line}<span class="sr-only">:</span></span>
                  <span class="search-hit-text">{m.text}</span>
                </button>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
