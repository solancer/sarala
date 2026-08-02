/**
 * Floating helper for a rendered link: shows where it points, and the four
 * things you actually want to do with it.
 *
 * Until now the only affordance was Cmd/Ctrl+click to open — invisible unless
 * you already knew, and there was no way to see a link's target at all without
 * flipping the block to raw Markdown.
 *
 * Mirrors ImageHoverTools: anchored under the element, kept alive while the
 * pointer is over it, and swallowing mousedown so nothing here moves the caret
 * or activates the block underneath.
 */

import { Show, createSignal } from "solid-js";
import { clipboardWriteText } from "../platform";
import { followLink } from "../commands";
import { removeLink, setLinkUrl, type LinkTarget } from "../links";

const ICONS: Record<string, string> = {
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>',
  open: '<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  unlink: '<path d="M9 15l2-2M13 11l2-2M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1M4 4l16 16"/>',
};

function Icon(props: { name: string }) {
  return (
    <svg
      class="lht-ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      ref={(el) => (el.innerHTML = ICONS[props.name] ?? "")}
    />
  );
}

interface Props {
  target: LinkTarget;
  /** Absolute position within the block. */
  top: number;
  left: number;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}

export default function LinkHoverTools(props: Props) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [copied, setCopied] = createSignal(false);

  const startEdit = () => {
    setDraft(props.target.url);
    setEditing(true);
  };
  const commit = () => {
    setLinkUrl(props.target, draft());
    props.onClose();
  };
  const copy = async () => {
    await clipboardWriteText(props.target.url);
    // Confirm in place rather than firing a toast for a one-word action.
    setCopied(true);
    setTimeout(() => setCopied(false), 1100);
  };

  return (
    <div
      class="link-tools"
      contentEditable={false}
      style={{ top: `${props.top}px`, left: `${props.left}px` }}
      onMouseEnter={() => props.onEnter()}
      onMouseLeave={() => props.onLeave()}
      // Let the input take focus; block everything else from moving the caret.
      onMouseDown={(e) => {
        e.stopPropagation();
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      <div class="lht-card">
      <Show
        when={editing()}
        fallback={
          <div class="lht-bar">
            <Icon name="globe" />
            <a
              class="lht-url"
              href={props.target.url}
              title={props.target.url}
              onClick={(e) => { e.preventDefault(); void followLink(props.target.url); }}
            >
              {props.target.url}
            </a>
            <span class="lht-sep" />
            <button class="lht-btn" title="Open link" onClick={() => void followLink(props.target.url)}>
              <Icon name="open" />
            </button>
            <button class="lht-btn" title="Edit link" onClick={startEdit}>
              <Icon name="edit" />
            </button>
            <button
              class="lht-btn"
              classList={{ ok: copied() }}
              title={copied() ? "Copied" : "Copy link"}
              onClick={() => void copy()}
            >
              <Icon name="copy" />
            </button>
            <button
              class="lht-btn danger"
              title={props.target.kind === "bare" ? "Remove link (keeps the URL text)" : "Remove link (keeps the text)"}
              onClick={() => { removeLink(props.target); props.onClose(); }}
            >
              <Icon name="unlink" />
            </button>
          </div>
        }
      >
        <div class="lht-field">
          <input
            class="lht-input"
            autofocus
            spellcheck={false}
            autocomplete="off"
            placeholder="https://…"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
            }}
          />
          <button class="lht-ok" onClick={commit}>Save</button>
        </div>
      </Show>
      </div>
    </div>
  );
}
