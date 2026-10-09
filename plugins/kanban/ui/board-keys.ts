import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { type BoardCommand, CTRL_KEYMAP, KEYMAP, PREFIXED_KEYMAP } from "./board-nav";
import { KANBAN_MENU, stepMenu } from "./primitives";

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
// Radix menus and listboxes take letters for typeahead without always claiming them.
const OWN_KEYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"]';
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
/** The plugin's own menus; bb's are left alone. */
const OPEN_MENU = `.${KANBAN_MENU}[data-state="open"]`;
/** Marks the board, its header and its card panel: the places a keypress may come from. */
const SCOPE = "[data-kanban-keys]";
const PREFIX_TIMEOUT_MS = 500;

function isEditable(element: Element | null): boolean {
  return element !== null && element.closest(EDITABLE) !== null;
}

/**
 * Single-key board shortcuts. Keys count only when they come from the board's own surfaces (or
 * nowhere in particular), so the thread list, other plugins' panels and every text box keep theirs.
 */
export function useBoardKeys(rootRef: RefObject<HTMLElement | null>, enabled: boolean, onCommand: (command: BoardCommand) => void): void {
  const handler = useRef(onCommand);
  handler.current = onCommand;

  // Arriving from the sidebar leaves focus on its link, where board keys would be ignored.
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || root === null) return;
    const active = document.activeElement;
    if (active === null || active === document.body || (active.closest(SCOPE) === null && !isEditable(active) && active.closest(OWN_KEYS) === null)) {
      root.focus({ preventScroll: true });
    }
  }, [enabled, rootRef]);

  useEffect(() => {
    if (!enabled) return;
    let pending: { key: string; at: number } | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.altKey || event.isComposing) return;
      const chord = event.ctrlKey ? (event.shiftKey ? undefined : CTRL_KEYMAP[event.key]) : null;
      if (chord === undefined) return;
      // A menu opened with the mouse can leave focus on its trigger or the page; j and k still belong to the menu.
      const menu = document.querySelector<HTMLElement>(OPEN_MENU);
      if (menu !== null && !isEditable(event.target instanceof Element ? event.target : null)) {
        if (chord !== null || (event.key !== "j" && event.key !== "k")) return;
        event.preventDefault();
        stepMenu(menu, event.key === "j" ? 1 : -1);
        return;
      }
      const root = rootRef.current;
      if (root === null || root.getClientRects().length === 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && target !== document.body && target.closest(SCOPE) === null) return;
      if (isEditable(target) || target?.closest(OWN_KEYS) != null) return;
      if (document.querySelector(OPEN_DIALOG) !== null) return;
      if (chord !== null) {
        pending = null;
        event.preventDefault();
        handler.current(chord);
        return;
      }
      const prefix = pending !== null && event.timeStamp - pending.at <= PREFIX_TIMEOUT_MS ? pending.key : "";
      pending = null;
      // A key that doesn't complete the pending prefix counts on its own.
      let command: BoardCommand | undefined = prefix === "" ? undefined : PREFIXED_KEYMAP[prefix + event.key];
      if (command === undefined && Object.keys(PREFIXED_KEYMAP).some((keys) => keys.startsWith(event.key))) {
        pending = { key: event.key, at: event.timeStamp };
        event.preventDefault();
        return;
      }
      command ??= KEYMAP[event.key];
      if (command === undefined) return;
      event.preventDefault();
      handler.current(command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, rootRef]);
}
