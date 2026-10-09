import { useEffect, useState, type RefObject } from "react";

// bb portals its own dialogs (delete and archive confirmations) to the body
// at z-50, under the picker's layer.
const HOST_DIALOG = 'body > [data-bb-portaled-overlay][role="dialog"]';

/**
 * Whether one of bb's dialogs is open, so the picker can drop beneath it.
 * bb doesn't hand focus back when it closes, so the picker takes it back.
 */
export function useHostDialogOpen(
  root: RefObject<HTMLElement | null>,
): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let wasOpen = false;
    const sync = () => {
      const isOpen = document.querySelector(HOST_DIALOG) !== null;
      if (wasOpen && !isOpen) {
        const active = document.activeElement;
        if (active === null || active === document.body) root.current?.focus();
      }
      wasOpen = isOpen;
      setOpen(isOpen);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true });
    sync();
    return () => observer.disconnect();
  }, [root]);
  return open;
}

// bb's dialogs, menus, and toasts portal outside the picker and need focus.
const FOCUS_ALLOWED_OUTSIDE =
  "[data-bb-portaled-overlay], [data-radix-popper-content-wrapper], [data-sonner-toaster]";

/**
 * bb moves focus on its own while the picker is up: archiving the open thread
 * routes to the new-thread screen, whose prompt autofocuses and would take the
 * picker's keys. The picker covers the page, so focus landing outside it is
 * never a click of yours; take it back, except for bb's own overlays.
 */
export function useHoldFocus(
  root: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const onFocusIn = (event: FocusEvent) => {
      const element = root.current;
      const target = event.target;
      if (element === null || !(target instanceof Element)) return;
      if (element.contains(target)) return;
      if (target.closest(FOCUS_ALLOWED_OUTSIDE) !== null) return;
      element.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [active, root]);
}
