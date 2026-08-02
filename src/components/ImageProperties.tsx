/**
 * Image Properties panel — the full `<img>` attribute set for one image.
 *
 * Opened from the image hover toolbar. Src and Alt are always shown; everything
 * markdown cannot express lives behind an Advanced disclosure, grouped by what
 * it actually does (Layout / Responsive / Loading / Security) rather than as
 * one flat run of ten fields.
 *
 * Edits apply **live**. Typed fields commit on a short debounce rather than per
 * keystroke: each commit rewrites the block's markdown, so a rewrite per
 * character would flood the undo stack with one entry per letter. Selects and
 * the size slider commit immediately — they are single, deliberate gestures.
 *
 * Editing a value promotes the occurrence from `![alt](src)` to `<img>` (see
 * `imageattrs.ts`) — the panel says so, rather than silently rewriting syntax.
 *
 * A floating card anchored to the image rather than a docked side panel:
 * Sarala has no right rail, and every other image affordance here
 * (ImageHoverTools, ImageContextMenu) is already a floating surface.
 */

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { IMG_FIELDS, needsHtmlSyntax, type ImgField } from "../imageattrs";
import { setImageProps, type ImageTarget } from "../imageactions";
import { pickImageFile } from "../platform";
import { imageInsertRef } from "../commands";

interface Props {
  target: ImageTarget;
  /** Intrinsic size of the rendered image (0 when not yet decoded). */
  natural: { w: number; h: number };
  /** Resolved URL of the rendered image, for the panel's own thumbnail. */
  preview: string;
  /** Absolute position within the block. */
  top: number;
  left: number;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}

/** How long a typed field waits before rewriting the block. */
const COMMIT_MS = 140;

const BASIC = IMG_FIELDS.filter((f) => !f.advanced);
const baseName = (p: string) => {
  const clean = p.split(/[?#]/)[0];
  return clean.split("/").pop() || clean || "image";
};
const byName = (n: string) => IMG_FIELDS.find((f) => f.name === n)!;

/**
 * Advanced fields grouped by purpose. Ten undifferentiated inputs is a wall;
 * four small named groups is a menu you can scan.
 */
const GROUPS: { label: string; fields: ImgField[]; pair?: boolean }[] = [
  // srcset/sizes hold long values, so they stay full width. The enums are short
  // and pack two-up — four of them stacked was most of the panel's height.
  { label: "Responsive", fields: [byName("srcset"), byName("sizes")] },
  // Named "Performance", not "Loading": the old heading was the same word as
  // the first field under it, which read as a mistake.
  { label: "Performance", fields: [byName("loading"), byName("decoding"), byName("fetchpriority")], pair: true },
  { label: "Security", fields: [byName("crossorigin"), byName("referrerpolicy")], pair: true },
  { label: "Metadata", fields: [byName("title")] },
];
const ADVANCED = IMG_FIELDS.filter((f) => f.advanced);

export default function ImageProperties(props: Props) {
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  let hostEl: HTMLDivElement | undefined;

  const valueOf = (name: string) => {
    if (name === "src") return props.target.src;
    if (name === "alt") return props.target.alt;
    return props.target.attrs?.[name] ?? "";
  };

  const advancedSet = createMemo(() => ADVANCED.filter((f) => valueOf(f.name) !== "").length);
  const isHtml = createMemo(
    () => props.target.kind === "html" || needsHtmlSyntax(props.target.attrs ?? {}),
  );

  const commit = (name: string, value: string) => {
    if (value === valueOf(name)) return;
    setImageProps(props.target, { [name]: value });
  };

  // Debounced commit for typed fields, so a rewrite lands once per pause rather
  // than once per character. One timer *per field*: a shared one lets a second
  // field cancel the first one's pending commit, and that edit is then only in
  // the input's local draft state — it never reaches the source. (`timer` below
  // is the size control's own; width and height are a single control there.)
  const fieldTimers = new Map<string, number>();
  const clearFieldTimer = (name: string) => {
    const t = fieldTimers.get(name);
    if (t !== undefined) clearTimeout(t);
    fieldTimers.delete(name);
  };
  const commitSoon = (name: string, value: string) => {
    clearFieldTimer(name);
    // Deliberate imperative read: the target must be re-read when the timer
    // fires, not captured now, so a commit lands against the occurrence's
    // current offsets rather than the ones it had when the keystroke happened.
    // (The directive must sit immediately above the statement — with the prose
    // after it, it was disabling the following *comment* line and the real
    // warning went unsuppressed.)
    // eslint-disable-next-line solid/reactivity
    fieldTimers.set(name, window.setTimeout(() => {
      fieldTimers.delete(name);
      commit(name, value);
    }, COMMIT_MS));
  };
  const commitNow = (name: string, value: string) => {
    clearFieldTimer(name);
    commit(name, value);
  };

  // The size control's timer: width and height are one control, so one timer.
  let timer: number | undefined;
  onCleanup(() => {
    clearTimeout(timer);
    fieldTimers.forEach((t) => clearTimeout(t));
  });

  /* --- dismissal: Escape, or a click anywhere outside the card --- */
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (hostEl && !hostEl.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("keydown", onKey, true);
    // Capture, so the block's own mousedown handling doesn't swallow it first.
    document.addEventListener("mousedown", onDown, true);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    });
  });

  const upload = async () => {
    const path = await pickImageFile();
    if (!path) return;
    setImageProps(props.target, { src: await imageInsertRef(path) });
    props.onClose();
  };

  /* --- size ---
     Width and Height are one idea, so they are one control: a slider for the
     coarse pass and a matched pair of number inputs for an exact value. Before,
     width was slider-only (no way to type a figure) and height was a lone
     stepper sitting inside the width card. */
  const [linked, setLinked] = createSignal(true);
  const naturalW = () => props.natural.w || 0;
  const naturalH = () => props.natural.h || 0;
  const ratio = () => (naturalW() && naturalH() ? naturalH() / naturalW() : 0);
  const widthValue = () => Number(valueOf("width")) || naturalW();
  const sliderMax = () => Math.max(naturalW() * 2, 1200);

  /** Set one dimension, carrying the other along while the ratio is locked. */
  const setDim = (which: "width" | "height", raw: string, immediate: boolean) => {
    const n = Number(raw);
    const patch: Record<string, string> = { [which]: raw.trim() === "" ? "" : String(n) };
    if (linked() && ratio() && raw.trim() !== "" && n > 0) {
      patch[which === "width" ? "height" : "width"] = String(
        Math.round(which === "width" ? n * ratio() : n / ratio()),
      );
    }
    const run = () => setImageProps(props.target, patch);
    if (immediate) { clearTimeout(timer); run(); }
    else { clearTimeout(timer); timer = window.setTimeout(run, COMMIT_MS); }
  };
  const clearSize = () => {
    clearTimeout(timer);
    setImageProps(props.target, { width: "", height: "" });
  };

  return (
    <div
      class="img-props"
      ref={hostEl}
      contentEditable={false}
      style={{ top: `${props.top}px`, left: `${props.left}px` }}
      onMouseEnter={() => props.onEnter()}
      onMouseLeave={() => props.onLeave()}
      // Let inputs take focus, but never move the caret into the block.
      onMouseDown={(e) => {
        e.stopPropagation();
        const t = e.target as HTMLElement;
        if (!(t instanceof HTMLInputElement) && !(t instanceof HTMLSelectElement)) {
          e.preventDefault();
        }
      }}
    >
      <div class="ip-head">
        <span class="ip-title">Image Properties</span>
        <button class="ip-close" title="Close (Esc)" onClick={() => props.onClose()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      {/* The panel floats over the document and often covers the very image it
          is editing, so it carries its own thumbnail. The filename and
          intrinsic size sit beside it — the identifying facts, previously
          available only by reading a truncated path out of the Src field. */}
      <div class="ip-preview">
        <span class="ip-thumb">
          <img src={props.preview} alt="" />
        </span>
        <span class="ip-ident">
          <span class="ip-filename" title={props.target.src}>{baseName(props.target.src)}</span>
          <Show when={naturalW()} fallback={<span class="ip-meta">Not loaded</span>}>
            <span class="ip-meta">{props.natural.w} × {props.natural.h}</span>
          </Show>
        </span>
        <button class="ip-replace" onClick={() => void upload()}>Replace…</button>
      </div>

      <div class="ip-section">Source</div>
      <For each={BASIC}>
        {(f) => (
          <Field field={f} value={valueOf(f.name)} onType={commitSoon} onPick={commitNow} />
        )}
      </For>
      {/* An image with no alt text is invisible to a screen reader and exports
          with nothing to fall back on. Worth saying at the point of editing. */}
      <Show when={!valueOf("alt").trim()}>
        <p class="ip-warn">No alt text — screen readers and broken-image
          fallbacks will have nothing to read.</p>
      </Show>

      <div class="ip-section">Size</div>
      <div class="ip-size">
        <div class="ip-size-row">
          <input
            class="ip-range"
            type="range"
            min={40}
            max={sliderMax()}
            step={10}
            value={widthValue()}
            aria-label="Width"
            onInput={(e) => setDim("width", e.currentTarget.value, true)}
          />
          <button
            class="ip-size-reset"
            title="Clear both dimensions (use natural size)"
            disabled={!valueOf("width") && !valueOf("height")}
            onClick={clearSize}
          >
            Auto
          </button>
        </div>
        <div class="ip-dims">
          <label class="ip-dim">
            <span class="ip-dim-tag">W</span>
            <input
              class="ip-input"
              type="number"
              min="1"
              placeholder={naturalW() ? String(naturalW()) : "auto"}
              value={valueOf("width")}
              onInput={(e) => setDim("width", e.currentTarget.value, false)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </label>
          <button
            class="ip-link"
            classList={{ on: linked() }}
            title={linked() ? "Aspect ratio locked" : "Aspect ratio unlocked"}
            aria-pressed={linked()}
            disabled={!ratio()}
            onClick={() => setLinked(!linked())}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
              stroke-linecap="round" aria-hidden="true">
              <Show
                when={linked()}
                fallback={<path d="M9 15l2-2M13 11l2-2M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1" />}
              >
                <path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1" />
              </Show>
            </svg>
          </button>
          <label class="ip-dim">
            <span class="ip-dim-tag">H</span>
            <input
              class="ip-input"
              type="number"
              min="1"
              placeholder={naturalH() ? String(naturalH()) : "auto"}
              value={valueOf("height")}
              onInput={(e) => setDim("height", e.currentTarget.value, false)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </label>
        </div>
      </div>

      <button
        class="ip-adv-toggle"
        classList={{ open: advancedOpen() }}
        onClick={() => setAdvancedOpen(!advancedOpen())}
      >
        <svg class="ip-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span>Advanced</span>
        <Show when={advancedSet() > 0}>
          <span class="ip-adv-count">{advancedSet()}</span>
        </Show>
      </button>

      <Show when={advancedOpen()}>
        <div class="ip-adv">
          <Show when={!isHtml()}>
            <p class="ip-note">
              Setting any of these rewrites the image as an <code>&lt;img&gt;</code> tag —
              markdown can only carry src and alt.
            </p>
          </Show>
          <For each={GROUPS}>
            {(g) => (
              <>
                <div class="ip-group">{g.label}</div>
                <div classList={{ "ip-pair": !!g.pair }}>
                  <For each={g.fields}>
                    {(f) => (
                      <Field field={f} value={valueOf(f.name)} onType={commitSoon} onPick={commitNow} />
                    )}
                  </For>
                </div>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function Field(props: {
  field: ImgField;
  value: string;
  onType: (name: string, value: string) => void;
  onPick: (name: string, value: string) => void;
}) {
  const [draft, setDraft] = createSignal<string | null>(null);
  // Drop the local draft when the value changes underneath (an undo, or another
  // surface editing the same image), so the field never shows stale text.
  createEffect(on(() => props.value, () => setDraft(null), { defer: true }));
  const shown = () => draft() ?? props.value;

  return (
    <label class="ip-field">
      <span class="ip-label">{props.field.label}</span>
      <Show
        when={props.field.kind === "enum"}
        fallback={
          <input
            class="ip-input"
            type={props.field.kind === "number" ? "number" : "text"}
            spellcheck={props.field.name === "alt"}
            autocomplete="off"
            placeholder={props.field.placeholder ?? ""}
            value={shown()}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              props.onType(props.field.name, e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
            }}
          />
        }
      >
        <select
          class="ip-input ip-select"
          value={props.value}
          onChange={(e) => props.onPick(props.field.name, e.currentTarget.value)}
        >
          <For each={props.field.options}>
            {(o) => <option value={o}>{o === "" ? "—" : o}</option>}
          </For>
        </select>
      </Show>
    </label>
  );
}
