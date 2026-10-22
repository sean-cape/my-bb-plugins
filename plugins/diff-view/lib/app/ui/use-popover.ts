import { useEffect, useRef, type FocusEvent } from "react";
import { focusRow } from "./vim-keys";

export interface PopoverOptions {
  /** Whether the popover is showing; focus moves in each time it opens. */
  open?: boolean;
  /**
   * The rows focus starts on, the first that is there; without one the popover itself takes focus (a list holding
   * `aria-activedescendant`, or a popover still loading its rows). `ready` changing looks again, once rows arrive.
   */
  firstRow?: string;
  ready?: unknown;
  /** Focus left the popover for somewhere else. */
  onDismiss: () => void;
  /** Elements focus may move onto without closing it: the button that toggles it, which closes it itself. */
  keepOpenFor?: string;
}

/**
 * A keyboard popover's focus: into its first row as it opens (or once its rows load), and closed when focus moves out.
 * Spread `ref` and `onBlur` onto the element that holds focus; keys are the popover's own, on the same element.
 */
export function usePopover<E extends HTMLElement>({ open = true, firstRow = "[data-nav-row]", ready, onDismiss, keepOpenFor }: PopoverOptions) {
  const ref = useRef<E | null>(null);
  useEffect(() => {
    const popover = ref.current;
    if (!open || popover === null) return;
    const row = popover.querySelector<HTMLElement>(firstRow);
    if (row !== null) focusRow(row);
    else popover.focus({ preventScroll: true });
  }, [open, ready, firstRow]);
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (keepOpenFor !== undefined && next instanceof Element && next.closest(keepOpenFor) !== null) return;
    onDismiss();
  };
  return { ref, onBlur };
}
