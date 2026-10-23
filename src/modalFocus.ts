/** Shared focus containment for mounted modal surfaces, including nested dialogs. */
const stack: HTMLElement[] = [];
const inertBefore = new Map<HTMLElement, boolean>();
const focusable = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(
  'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]',
)].filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') &&
  !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
  getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' &&
  isRadioStop(el, root));
/** A radio group is one Tab stop (its checked option, else its first); arrow
 *  keys move within it. Same as the browser's own tab order. */
function isRadioStop(el: HTMLElement, root: HTMLElement): boolean {
  const input = el as HTMLInputElement;
  if (el.tagName !== 'INPUT' || input.type !== 'radio' || !input.name) return true;
  const group = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((r) => r.name === input.name);
  return el === (group.find((r) => r.checked) ?? group[0]);
}
function isolateTop() {
  for (const [el, inert] of inertBefore) el.inert = inert;
  inertBefore.clear();
  let branch = stack.at(-1);
  while (branch && branch !== document.body) {
    for (const sibling of branch.parentElement?.children ?? []) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        inertBefore.set(sibling, sibling.inert);
        sibling.inert = true;
      }
    }
    branch = branch.parentElement ?? undefined;
  }
}
export function containModalFocus(el: HTMLElement, close: () => void): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  stack.push(el);
  isolateTop();
  const focusFirst = () => (focusable(el)[0] ?? el).focus({ preventScroll: true });
  const onFocus = (e: FocusEvent) => {
    if (stack.at(-1) === el && !el.contains(e.target as Node)) focusFirst();
  };
  const onKey = (e: KeyboardEvent) => {
    if (stack.at(-1) !== el) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // Move focus ourselves on every Tab, wrapping at both ends. Waiting for
    // focus to reach the last control isn't enough in WebKit (the macOS app):
    // by default its Tab skips buttons and links, so from the last text field
    // it jumps straight past the dialog's buttons and out to <body>.
    const items = focusable(el);
    if (!items.length) { e.preventDefault(); el.focus(); return; }
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0
      ? (e.shiftKey ? items.length - 1 : 0)
      : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    e.preventDefault();
    items[next].focus();
  };
  // Clicking the inert page behind a modal drops focus to <body>, where the
  // modal's own listener never hears Escape; still close the topmost modal.
  const onStrayKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || stack.at(-1) !== el || el.contains(e.target as Node)) return;
    e.preventDefault(); close();
  };
  el.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onStrayKey);
  document.addEventListener('focusin', onFocus);
  focusFirst();
  return () => {
    el.removeEventListener('keydown', onKey);
    document.removeEventListener('keydown', onStrayKey);
    document.removeEventListener('focusin', onFocus);
    const wasTop = stack.at(-1) === el;
    const index = stack.indexOf(el);
    if (index >= 0) stack.splice(index, 1);
    isolateTop();
    if (wasTop) {
      const target = previous?.isConnected && !previous.closest('[inert]') ? previous
        : stack.at(-1) ?? document.querySelector<HTMLElement>('.editor[tabindex], .source-full');
      target?.focus({ preventScroll: true });
    }
  };
}
