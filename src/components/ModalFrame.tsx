import { onMount, onCleanup, type JSX } from "solid-js";
import { containModalFocus } from "../modalFocus";

export default function ModalFrame(props: { class: string; label: string; onClose: () => void; children: JSX.Element }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const release = containModalFocus(el, props.onClose);
    onCleanup(release);
  });
  return <div ref={el} class={props.class} role="dialog" aria-modal="true" aria-label={props.label} tabIndex={-1}>
    {props.children}
  </div>;
}
