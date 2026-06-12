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
 * Typora-style language selector under an active code block: an input that
 * filters the bundled highlighter's languages. Free-form input is allowed —
 * unknown languages fall back to plaintext highlighting.
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
    <div class="code-lang">
      <input
        ref={inputEl}
        spellcheck={false}
        placeholder="language"
        value={open() ? query() : props.current}
        onFocus={() => { setOpen(true); setQuery(""); setCursor(0); }}
        onInput={(e) => { setQuery(e.currentTarget.value); setCursor(0); }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      <Show when={open() && matches().length}>
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
    </div>
  );
}
