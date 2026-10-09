import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { type ClientCommand, CTRL_KEYMAP, KEYMAP, type NavRow, PREFIX_KEYMAP } from "./client-nav";

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);
// Radix menus and listboxes take letters for typeahead without always claiming them; the
// plugin's own panels are dialogs that step through their controls with usePanelKeys.
const OWN_KEYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"]';
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
/** Marks the client view: the place a keypress may come from. */
const SCOPE = "[data-grpc-keys]";
const PREFIX_TIMEOUT_MS = 500;
const PREFIX_STARTS = new Set(Object.keys(PREFIX_KEYMAP).map((sequence) => sequence[0]!));

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
    let pending: { key: string; at: number } | null = null;
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
      } else if (event.key === "Enter") {
        // Buttons and form controls keep Enter; on a field row or the bare view it opens the cursor's row.
        if (event.ctrlKey || event.shiftKey || target?.closest("button, a[href], input, select, summary") != null) return;
        command = { kind: "list", motion: "open" };
      } else if (event.ctrlKey) {
        command = event.shiftKey ? undefined : CTRL_KEYMAP[event.key];
      } else {
        const sequence = pending !== null && event.timeStamp - pending.at <= PREFIX_TIMEOUT_MS ? PREFIX_KEYMAP[pending.key + event.key] : undefined;
        if (sequence === undefined && PREFIX_STARTS.has(event.key)) {
          pending = { key: event.key, at: event.timeStamp };
          event.preventDefault();
          return;
        }
        command = sequence ?? KEYMAP[event.key];
      }
      pending = null;
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

/** Rows the cursor moves over carry `data-nav-row` ("group" or "item"); list rows also a `data-nav-key`. */
export const NAV_ROW = "[data-nav-row]";
/** Wraps a group's row and everything nested under it. */
const NAV_GROUP = "[data-nav-group]";

/** Makes an element a stop for the request form's field cursor; pair it with FOCUS_RING. */
export const FIELD_ROW = { "data-nav-row": "item", tabIndex: -1 } as const;
/** A message in a list: a stop of its own (so dd can remove it) that holds its fields' rows. */
export const FIXED_GROUP_ROW = { "data-nav-row": "group", "data-nav-fixed": "", "data-nav-group": "", tabIndex: -1 } as const;

function isExpanded(element: Element): boolean {
  return (element.getAttribute("aria-expanded") ?? element.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")) === "true";
}

/** The row's own controls, not those of rows nested inside it. */
export function ownControls<T extends Element>(row: HTMLElement, selector: string): T[] {
  return [...row.querySelectorAll<T>(selector)].filter((control) => control.closest(NAV_ROW) === row);
}

export function readRows(container: Element): { elements: HTMLElement[]; rows: NavRow[] } {
  const elements = [...container.querySelectorAll<HTMLElement>(NAV_ROW)].filter((element) => element.closest("[inert]") === null);
  const headerOf = new Map<Element, number>();
  elements.forEach((element, index) => {
    const group = element.closest(NAV_GROUP);
    if (element.dataset.navRow === "group" && group !== null && !headerOf.has(group)) headerOf.set(group, index);
  });
  const rows = elements.map((element, index): NavRow => {
    let group = element.closest(NAV_GROUP);
    // A group's own row sits inside its wrapper, so its parent is the next wrapper out.
    if (group !== null && headerOf.get(group) === index) group = group.parentElement?.closest(NAV_GROUP) ?? null;
    const parent = group === null || !container.contains(group) ? null : (headerOf.get(group) ?? null);
    if (element.dataset.navRow !== "group") return { kind: "item", parent };
    const fixed = element.dataset.navFixed !== undefined;
    return { kind: "group", expanded: fixed || isExpanded(element), parent, ...(fixed ? { fixed } : {}) };
  });
  return { elements, rows };
}

const ROW_INPUTS = "input:not(:disabled), textarea:not(:disabled), select:not(:disabled)";

/** Opens a row: clicks a button row, else starts editing its first field, else clicks its first button. */
export function activateRow(row: HTMLElement): void {
  if (row instanceof HTMLButtonElement) {
    row.click();
    return;
  }
  // A list's message item has no box of its own; editing it starts at its first field.
  const inputs = row.dataset.navFixed !== undefined ? [...row.querySelectorAll<HTMLElement>(ROW_INPUTS)] : ownControls<HTMLElement>(row, ROW_INPUTS);
  const input = inputs.find(isTextEntry) ?? inputs[0];
  if (input !== undefined) {
    input.focus({ preventScroll: true });
    return;
  }
  // Removing and clearing are dd's; opening a row never does either.
  ownControls<HTMLElement>(row, 'button:not(:disabled):not([aria-label^="Remove "]):not([aria-label^="Clear "])')[0]?.click();
}

/** Sets a controlled input's value the way typing would, so React sees the change. */
function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set?.call(control, value);
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

/**
 * Removes what a row holds: its Remove button (list item, map entry, header), else its Clear
 * button (a set field, which unsets it), else empties its inputs. False when nothing changed.
 */
export function deleteRow(row: HTMLElement): boolean {
  const button =
    ownControls<HTMLButtonElement>(row, 'button[aria-label^="Remove "]')[0] ?? ownControls<HTMLButtonElement>(row, 'button[aria-label^="Clear "]')[0];
  if (button !== undefined) {
    button.click();
    return true;
  }
  let changed = false;
  for (const control of ownControls<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(row, ROW_INPUTS)) {
    if (!isTextEntry(control) || control.value === "") continue;
    if (control instanceof HTMLSelectElement && ![...control.options].some((option) => option.value === "")) continue;
    setNativeValue(control, "");
    changed = true;
  }
  return changed;
}

export function focusRow(element: HTMLElement): void {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest" });
}
