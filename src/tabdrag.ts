export interface TabGeometry { id: number; left: number; width: number }

/** Visual bounds must not prevent reaching either end of the tab order. */
export function tabDragPosition(tabs: TabGeometry[], id: number, delta: number) {
  const moving = tabs.find((tab) => tab.id === id);
  if (!moving) return null;
  const first = tabs[0];
  const last = tabs[tabs.length - 1];
  const min = first.left - moving.left;
  const max = last.left + last.width - moving.width - moving.left;
  const offset = Math.max(min, Math.min(max, delta));
  const others = tabs.filter((tab) => tab.id !== id);
  // At the left boundary equal-width centers are identical, and a wider
  // dragged tab's center can never cross a narrow first tab's center.
  // Resolve the edges explicitly rather than using that impossible test.
  if (delta <= min) return { offset, index: 0 };
  if (delta >= max) return { offset, index: others.length };
  const center = moving.left + offset + moving.width / 2;
  const next = others.findIndex((tab) => center < tab.left + tab.width / 2);
  return { offset, index: next < 0 ? others.length : next };
}
