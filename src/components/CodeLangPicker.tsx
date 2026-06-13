import { For, Show, createMemo, createSignal } from "solid-js";
import { listCodeLanguages } from "../markdown";

interface Props {
  /** Current fence language (may be ""). */
  current: string;
  /** Rewrite the fence line with the chosen language. */
  onSelect: (lang: string) => void;
  /** Esc / abandon: return focus to the editor without changing anything. */
  onCancel: () => void;
}

/**
 * Language selector anchored inside an active code block's top-right corner:
 * a quiet badge with the current language (or a </> glyph) that expands into
 * a filterable dropdown of the bundled highlighter's languages. Free-form
 * input is allowed — unknown languages fall back to plaintext.
 */
export default function CodeLangPicker(props: Props) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;

  const matches = createMemo(() => {
    const q = query().toLowerCase().trim();
    const all = listCodeLanguages();
    return q ? all.filter((l) => l.includes(q)) : all;
  });

  const openPicker = () => {
    setQuery("");
    setCursor(0);
    setOpen(true);
    queueMicrotask(() => inputEl?.focus());
  };

  const pick = (lang: string) => {
    setOpen(false);
    props.onSelect(lang);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      props.onCancel();
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, matches().length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === "Enter") {
      e.preventDefault();
      pick(matches()[cursor()] ?? query().trim());
    }
  };

  return (
    <div
      class="code-lang"
      onMouseDown={(e) => {
        // Keep the block's contenteditable focused: on WebKit clicking a
        // <button> doesn't focus it, so without this the mousedown blurs the
        // editor, deactivates the block, and unmounts the picker mid-click.
        // The input is exempt so it can still receive the caret.
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      <Show
        when={open()}
        fallback={
          <button class="cl-badge" title="Code language" onClick={openPicker}>
            <Show when={props.current} fallback={
              <svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M5.7 3.2 1.2 8l4.5 4.8 1.2-1.1L3.4 8l3.5-3.7zM10.3 3.2 9.1 4.3 12.6 8l-3.5 3.7 1.2 1.1L14.8 8z"/></svg>
            }>
              {props.current}
            </Show>
          </button>
        }
      >
        <input
          ref={inputEl}
          spellcheck={false}
          placeholder="language"
          value={query()}
          onInput={(e) => { setQuery(e.currentTarget.value); setCursor(0); }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
        />
        <Show when={matches().length}>
          <ul onMouseDown={(e) => e.preventDefault()}>
            <For each={matches()}>
              {(lang, i) => (
                <li
                  classList={{ selected: i() === cursor() }}
                  onMouseMove={() => setCursor(i())}
                  onClick={() => pick(lang)}
                >
                  {lang}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}
