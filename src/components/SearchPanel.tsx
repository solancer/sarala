import { For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { folderPath } from "../store";
import { searchInFolder, type FolderSearchHit } from "../platform";
import { openFindWith } from "./FindBar";

interface Props {
  onOpenFile: (path: string) => void;
}

/**
 * Global folder search: text/regex across every markdown file in the open
 * folder, backed by the Rust `search_in_folder` command. Clicking a match
 * opens the file and re-runs the query in the in-document find bar so the hit
 * is highlighted and scrolled into view.
 */
export default function SearchPanel(props: Props) {
  const [query, setQuery] = createSignal("");
  const [regex, setRegex] = createSignal(false);
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [wholeWord, setWholeWord] = createSignal(false);
  const [hits, setHits] = createSignal<FolderSearchHit[]>([]);
  const [searching, setSearching] = createSignal(false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  // Debounced search; re-runs on query OR option changes.
  createEffect(() => {
    const q = query().trim();
    void regex();
    void caseSensitive();
    void wholeWord();
    const root = folderPath();
    clearTimeout(timer);
    if (!q || !root) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer = setTimeout(async () => {
      const opts = { regex: regex(), caseSensitive: caseSensitive(), wholeWord: wholeWord() };
      const res = await searchInFolder(root, q, opts);
      setHits(res);
      setSearching(false);
    }, 220);
  });

  const totalMatches = () => hits().reduce((sum, f) => sum + f.matches.length, 0);

  const openHit = (path: string) => {
    props.onOpenFile(path);
    if (query().trim()) openFindWith(query().trim());
  };

  return (
    <div class="search-panel">
      <input
        class="search-input"
        placeholder="Search in folder…"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <div class="search-toggles">
        <button class="find-toggle" classList={{ on: caseSensitive() }}
          title="Match case" onClick={() => setCaseSensitive(!caseSensitive())}>Aa</button>
        <button class="find-toggle" classList={{ on: wholeWord() }}
          title="Whole word" onClick={() => setWholeWord(!wholeWord())}>W</button>
        <button class="find-toggle mono" classList={{ on: regex() }}
          title="Use regular expression" onClick={() => setRegex(!regex())}>.*</button>
        <Show when={query().trim() && !searching()}>
          <span class="search-summary">{totalMatches()} in {hits().length}</span>
        </Show>
      </div>

      <Show when={query().trim() && !searching() && hits().length === 0}>
        <div class="search-empty">No matches</div>
      </Show>

      <For each={hits()}>
        {(file) => (
          <div class="search-file">
            <button class="search-file-head" onClick={() => openHit(file.path)} title={file.path}>
              <span class="search-file-name">{file.name}</span>
              <span class="search-file-count">{file.matches.length}</span>
            </button>
            <For each={file.matches}>
              {(m) => (
                <button class="search-hit" onClick={() => openHit(file.path)}>
                  <span class="search-hit-line">{m.line}</span>
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
