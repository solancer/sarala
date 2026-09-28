import { For, createMemo, createEffect, createSignal, onCleanup } from "solid-js";
import { cellRanges, moveTablePart, tableDims } from "../tabletools";

interface Handle { axis: "row" | "column"; index: number; left: number; top: number; center: number }
export default function TableReorder(props: { text: string; onMove: (text: string, caret: number) => void }) {
  let root!: HTMLDivElement;
  const [handles, setHandles] = createSignal<Handle[]>([]);
  const [drag, setDrag] = createSignal<{ handle: Handle; target: number; source: string } | null>(null);
  const handleKeys = createMemo(() => handles().map(h => `${h.axis}:${h.index}`));
  const [status, setStatus] = createSignal("");
  const measure = () => {
    const block = root?.parentElement;
    const table = block?.querySelector(".source .md-table");
    if (!block || !table) return;
    const origin = block.getBoundingClientRect();
    const rows = [...table.querySelectorAll<HTMLElement>(".md-trow:not(.md-tsep)")];
    const next: Handle[] = [];
    rows.forEach((row, index) => {
      const rect = row.getBoundingClientRect();
      if (index) next.push({ axis: "row", index, left: rect.left - origin.left - 20, top: rect.top - origin.top + rect.height / 2 - 8, center: rect.top + rect.height / 2 });
    });
    rows[0]?.querySelectorAll<HTMLElement>(".md-tcell").forEach((cell, index) => {
      const rect = cell.getBoundingClientRect();
      next.push({ axis: "column", index, left: rect.left - origin.left + rect.width / 2 - 8, top: rect.top - origin.top - 19, center: rect.left + rect.width / 2 });
    });
    setHandles(next);
  };
  createEffect(() => { void props.text; const frame = requestAnimationFrame(measure); onCleanup(() => cancelAnimationFrame(frame)); });
  createEffect(() => {
    const observer = new ResizeObserver(measure);
    if (root.parentElement) observer.observe(root.parentElement);
    window.addEventListener("scroll", measure, true);
    onCleanup(() => { observer.disconnect(); window.removeEventListener("scroll", measure, true); });
  });
  const move = (handle: Handle, target: number) => {
    const text = moveTablePart(props.text, handle.axis, handle.index, target);
    if (!text || text === props.text) return;
    const cols = tableDims(text)!.cols;
    const cell = cellRanges(text)[handle.axis === "row" ? target * cols : target];
    props.onMove(text, cell?.start ?? 0);
    setStatus(`Moved ${handle.axis} ${handle.index + 1} to ${target + 1}`);
    requestAnimationFrame(() => root.querySelector<HTMLButtonElement>(`[data-handle="${handle.axis}:${target}"]`)?.focus({ preventScroll: true }));
  };
  return <div ref={root} class="table-reorder">
    <span class="sr-only" role="status">{status()}</span>
    <For each={handleKeys()}>{key => {
      const handle = () => handles().find(h => `${h.axis}:${h.index}` === key)!;
      return <button data-handle={key} type="button" class="table-drag-handle" classList={{ "drop-target": drag()?.handle.axis === handle().axis && drag()?.target === handle().index }}
      style={{ left: `${handle().left}px`, top: `${handle().top}px` }}
      aria-label={`Move ${handle().axis} ${handle().index + 1}. Drag or use arrow keys.`}
      title={`Drag ${handle().axis} ${handle().index + 1} to reorder`}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDrag({ handle: handle(), target: handle().index, source: props.text }); }}
      onPointerMove={event => {
        const current = drag(); if (!current) return;
        const coordinate = handle().axis === "row" ? event.clientY : event.clientX;
        const candidates = handles().filter(h => h.axis === handle().axis);
        const target = candidates.reduce((best, item) => Math.abs(item.center - coordinate) < Math.abs(best.center - coordinate) ? item : best, current.handle);
        setDrag({ ...current, target: target.index });
      }}
      onPointerUp={() => { const current = drag(); setDrag(null); if (current && current.source === props.text) move(current.handle, current.target); }}
      onPointerCancel={() => setDrag(null)}
      onLostPointerCapture={() => setDrag(null)}
      onKeyDown={event => {
        const keys = handle().axis === "row" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
        const delta = event.key === keys[0] ? -1 : event.key === keys[1] ? 1 : 0;
        if (delta) { event.preventDefault(); move(handle(), handle().index + delta); }
        if (event.key === "Escape") setDrag(null);
      }}>⠿</button>; }}</For>
  </div>;
}
