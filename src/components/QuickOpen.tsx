import { For, Show, createMemo, createSignal, createEffect } from "solid-js";
import { fileTree, quickOpenVisible, setQuickOpenVisible } from "../store";
import type { FileNode } from "../platform";
import { openFile } from "../commands";

function flatten(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    if (n.is_dir) flatten(n.children ?? [], out);
    else out.push(n);
  }
  return out;
}

export default function QuickOpen() {
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;

  const files = createMemo(() => flatten(fileTree()));
  const matches = createMemo(() => {
    const q = query().toLowerCase().trim();
    const all = files();
    if (!q) return all.slice(0, 12);
    return all
      .filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 12);
  });

  createEffect(() => {
    if (quickOpenVisible()) {
      setQuery("");
      setCursor(0);
      queueMicrotask(() => inputEl?.focus());
    }
  });

  const close = () => setQuickOpenVisible(false);
  const pick = (path: string) => {
    close();
    void openFile(path);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, matches().length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === "Enter") {
      e.preventDefault();
      const m = matches()[cursor()];
      if (m) pick(m.path);
    }
  };

  return (
    <Show when={quickOpenVisible()}>
      <div class="quick-open-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div class="quick-open">
          <input
            ref={inputEl}
            placeholder="Open quickly…"
            value={query()}
            onInput={(e) => { setQuery(e.currentTarget.value); setCursor(0); }}
            onKeyDown={onKeyDown}
          />
          <Show when={matches().length} fallback={<div class="quick-open-empty">No matching files</div>}>
            <ul>
              <For each={matches()}>
                {(f, i) => (
                  <li
                    classList={{ selected: i() === cursor() }}
                    onMouseDown={() => pick(f.path)}
                    onMouseMove={() => setCursor(i())}
                  >
                    <span class="qo-name">{f.name}</span>
                    <span class="qo-path">{f.path}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Show>
  );
}
