/**
 * Floating toolbar shown when hovering a rendered image, anchored to its
 * top-right corner (like the D2 controls). Lets the common image edits happen
 * in place — replace the file, retype the source path, edit alt text, or open
 * the full file-ops menu — so you never have to flip the block to raw ![](…)
 * markdown source just to tweak an image.
 */

import { Show, createSignal } from "solid-js";
import { pickImageFile } from "../platform";
import { imageInsertRef } from "../commands";
import { setImageSource, setImageAlt, type ImageTarget } from "../imageactions";
import { openImageMenu } from "./ImageContextMenu";

const ICONS: Record<string, string> = {
  replace: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  link: '<path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  alt: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
};

function Icon(props: { name: string }) {
  return (
    <svg
      class="iht-ic"
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
  target: ImageTarget;
  /** Absolute position within the block; right-aligned via CSS transform. */
  top: number;
  left: number;
  /** Keep the toolbar alive while the pointer is over it. */
  onEnter: () => void;
  onLeave: () => void;
  /** Dismiss after an action that mutated the document (block re-renders). */
  onClose: () => void;
  /** Flip the block to its raw ![alt](src) markdown source, caret on the image. */
  onShowSource: () => void;
}

export default function ImageHoverTools(props: Props) {
  const [edit, setEdit] = createSignal<"src" | "alt" | null>(null);
  const [value, setValue] = createSignal("");

  const openField = (mode: "src" | "alt") => {
    setValue(mode === "src" ? props.target.src : props.target.alt);
    setEdit(mode);
  };

  const commit = () => {
    const mode = edit();
    if (mode === "src") setImageSource(props.target, value().trim());
    else if (mode === "alt") setImageAlt(props.target, value());
    props.onClose();
  };

  const replace = async () => {
    const path = await pickImageFile();
    if (!path) return;
    setImageSource(props.target, await imageInsertRef(path));
    props.onClose();
  };

  const openMenu = (e: MouseEvent) => {
    openImageMenu(props.target, e.clientX, e.clientY);
    props.onClose();
  };

  return (
    <div
      class="img-tools"
      contentEditable={false}
      style={{ top: `${props.top}px`, left: `${props.left}px` }}
      onMouseEnter={() => props.onEnter()}
      onMouseLeave={() => props.onLeave()}
      // Swallow mousedown so clicking the toolbar never activates the block or
      // moves the caret — but let inputs receive focus (no preventDefault there).
      onMouseDown={(e) => {
        e.stopPropagation();
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      <div class="iht-bar">
        <button class="iht-btn" title="Replace image…" onClick={() => void replace()}>
          <Icon name="replace" />
        </button>
        <button class="iht-btn" title="Edit source" classList={{ on: edit() === "src" }} onClick={() => openField("src")}>
          <Icon name="link" />
        </button>
        <button class="iht-btn" title="Edit alt text" classList={{ on: edit() === "alt" }} onClick={() => openField("alt")}>
          <Icon name="alt" />
        </button>
        <button class="iht-btn" title="Show source code" onClick={() => props.onShowSource()}>
          <Icon name="code" />
        </button>
        <span class="iht-sep" />
        <button class="iht-btn" title="More…" onClick={openMenu}>
          <Icon name="more" />
        </button>
      </div>
      <Show when={edit()}>
        <div class="iht-field">
          <input
            class="iht-input"
            autofocus
            spellcheck={false}
            autocomplete="off"
            placeholder={edit() === "src" ? "Image URL or path" : "Describe this image"}
            value={value()}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              if (e.key === "Escape") { e.preventDefault(); setEdit(null); }
            }}
          />
          <button class="iht-ok" onClick={commit}>OK</button>
        </div>
      </Show>
    </div>
  );
}
