import { For, Show, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { folderPath, fileTree } from "../store";
import { searchInFolder, type FolderSearchHit, type FileNode } from "../platform";
import { openFindWith } from "./FindBar";

interface Props {
  onOpenFile: (path: string) => void;
}

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
 * folder, backed by the Rust `search_in_folder` command. Results lead with
 * files whose *name* matches the query (even when their contents don't), then
 * files that match only in their contents — so filenames come first, contents
 * after. Clicking a result opens the file and re-runs the query in the
 * in-document find bar so the hit is highlighted and scrolled into view.
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

  // Debounced content search; re-runs on query OR option changes.
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

  // A matcher mirroring the Rust query semantics, used to test *filenames*.
  const nameMatches = createMemo(() => {
    const q = query().trim();
    if (!q) return () => false;
    let pattern = regex() ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (wholeWord()) pattern = `\\b(?:${pattern})\\b`;
    let re: RegExp;
    try {
      re = new RegExp(pattern, caseSensitive() ? "" : "i");
    } catch {
      return () => false;
    }
    return (name: string) => re.test(name);
  });

  // Final ordered list: filename matches first (carrying any content matches
  // they also have), then content-only matches in the Rust-provided order.
  const results = createMemo<FolderSearchHit[]>(() => {
    const contentHits = hits();
    const matches = nameMatches();
    const byPath = new Map(contentHits.map((h) => [h.path, h]));

    const named: FolderSearchHit[] = [];
    const seen = new Set<string>();
    for (const f of flattenFiles(fileTree())) {
      if (seen.has(f.path) || !matches(f.name)) continue;
      named.push(byPath.get(f.path) ?? { path: f.path, name: f.name, matches: [] });
      seen.add(f.path);
    }

    const contentOnly = contentHits.filter((h) => !seen.has(h.path));
    return [...named, ...contentOnly];
  });

  const totalMatches = () => results().reduce((sum, f) => sum + f.matches.length, 0);

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
          <span class="search-summary">{totalMatches()} in {results().length}</span>
        </Show>
      </div>

      <Show when={query().trim() && !searching() && results().length === 0}>
        <div class="search-empty">No matches</div>
      </Show>

      <For each={results()}>
        {(file) => (
          <div class="search-file">
            <button class="search-file-head" onClick={() => openHit(file.path)} title={file.path}>
              <span class="search-file-name">{file.name}</span>
              <Show when={file.matches.length > 0}>
                <span class="search-file-count">{file.matches.length}</span>
              </Show>
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
