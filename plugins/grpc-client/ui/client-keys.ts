import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { type ClientCommand, CTRL_KEYMAP, KEYMAP, type NavRow } from "./client-nav";

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);
// Radix menus and listboxes take letters for typeahead without always claiming them; the
// plugin's own panels are dialogs that step through their controls with usePanelKeys.
const OWN_KEYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"]';
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
/** Marks the client view: the place a keypress may come from. */
const SCOPE = "[data-grpc-keys]";
const PREFIX_TIMEOUT_MS = 500;

/** Whether keys typed at `element` are text, so j or Escape mean something there. */
export function isTextEntry(element: Element | null): boolean {
  if (element === null) return false;
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(element.type);
  return element.closest('textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

// The view mounts both as a page and as a thread panel; a key with no focused target goes to
// whichever the user last touched.
let lastActiveRoot: HTMLElement | null = null;

function isShown(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0;
}

/**
 * Single-key client shortcuts. Keys count only when they come from the view (or nowhere in
 * particular), so the thread list, the composer and other plugins keep theirs. `onCommand`
 * returns false when the key did nothing, so it keeps its default.
 */
export function useClientKeys(root: HTMLElement | null, enabled: boolean, onCommand: (command: ClientCommand) => boolean | void): void {
  const handler = useRef(onCommand);
  handler.current = onCommand;

  // Arriving from the sidebar leaves focus on its link, where client keys would be ignored.
  useEffect(() => {
    if (!enabled || root === null) return;
    const active = document.activeElement;
    if (active === null || active === document.body || (active.closest(SCOPE) === null && !isTextEntry(active) && active.closest(OWN_KEYS) === null)) {
      root.focus({ preventScroll: true });
    }
  }, [enabled, root]);

  useEffect(() => {
    if (!enabled || root === null) return;
    const claim = () => {
      lastActiveRoot = root;
    };
    claim();
    root.addEventListener("focusin", claim);
    root.addEventListener("pointerdown", claim);
    let pendingG = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.altKey || event.isComposing) return;
      if (!isShown(root)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target === null || target === document.body) {
        if (lastActiveRoot !== root && lastActiveRoot !== null && isShown(lastActiveRoot)) return;
      } else if (!root.contains(target)) {
        return;
      }
      if (target?.closest(OWN_KEYS) != null || document.querySelector(OPEN_DIALOG) !== null) return;
      let command: ClientCommand | undefined;
      if (isTextEntry(target)) {
        // vim-mode swallows Escape in text boxes unless it is set to let Escape leave them.
        if (event.key !== "Escape" || event.ctrlKey || event.shiftKey) return;
        command = { kind: "escape", fromField: true };
      } else if (event.ctrlKey) {
        command = event.shiftKey ? undefined : CTRL_KEYMAP[event.key];
      } else if (event.key === "g") {
        if (event.timeStamp - pendingG > PREFIX_TIMEOUT_MS) {
          pendingG = event.timeStamp;
          event.preventDefault();
          return;
        }
        command = { kind: "list", motion: "top" };
      } else {
        command = KEYMAP[event.key];
      }
      pendingG = 0;
      if (command === undefined) return;
      if (handler.current(command) !== false) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("focusin", claim);
      root.removeEventListener("pointerdown", claim);
      if (lastActiveRoot === root) lastActiveRoot = null;
    };
  }, [enabled, root]);
}

const PANEL_STOPS = "button:not(:disabled), input:not(:disabled), select:not(:disabled)";

/**
 * Moves focus into a panel as it opens, onto its current choice if it marks one, and lets
 * j/k or the arrows step through its controls. Returns the panel's keydown handler.
 */
export function usePanelKeys(panel: RefObject<HTMLElement | null>, open: boolean): (event: ReactKeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    const node = panel.current;
    if (!open || node === null) return;
    const initial = node.querySelector<HTMLElement>('[aria-current="true"]') ?? node.querySelector<HTMLElement>(PANEL_STOPS);
    initial?.focus({ preventScroll: true });
  }, [panel, open]);

  return (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const node = panel.current;
    const target = event.target as Element;
    // A select's arrows change its value.
    if (node === null || target instanceof HTMLSelectElement) return;
    const typing = isTextEntry(target);
    const step = event.key === "ArrowDown" || (event.key === "j" && !typing) ? 1 : event.key === "ArrowUp" || (event.key === "k" && !typing) ? -1 : 0;
    if (step === 0) return;
    const stops = [...node.querySelectorAll<HTMLElement>(PANEL_STOPS)].filter((stop) => stop.getClientRects().length > 0);
    const index = stops.findIndex((stop) => stop === target || stop.contains(target));
    const next = stops[index === -1 ? 0 : Math.min(Math.max(index + step, 0), stops.length - 1)];
    if (next === undefined) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
  };
}

/** Rows the list cursor moves over carry `data-nav-row` ("group" or "item") and a `data-nav-key`. */
export const NAV_ROW = "[data-nav-row]";

export function readRows(container: Element): { elements: HTMLElement[]; rows: NavRow[] } {
  const elements = [...container.querySelectorAll<HTMLElement>(NAV_ROW)];
  const rows = elements.map((element): NavRow =>
    element.dataset.navRow === "group" ? { kind: "group", expanded: element.getAttribute("aria-expanded") === "true" } : { kind: "item", child: element.dataset.navChild !== undefined },
  );
  return { elements, rows };
}

export function focusRow(element: HTMLElement): void {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest" });
}
