import { useEffect, useSyncExternalStore } from "react";

/** The left-column entry the picker starts on, and whether it starts in that entry's threads. */
export interface PickerStart {
  entry: "unread" | "pinned" | "recent";
  inThreads: boolean;
}

interface PickerState {
  open: boolean;
  /** Bumped by every open, so each one mounts a fresh dialog. */
  generation: number;
  start: PickerStart;
}

const DEFAULT_START: PickerStart = { entry: "unread", inThreads: false };

// The sidebar and the picker overlay render in separate React roots, so the
// open flag lives at module scope rather than in either tree.
let state: PickerState = { open: false, generation: 0, start: DEFAULT_START };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function closeProjectPicker() {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
}

/** Opens on `start`, or restarts there when the picker is already open. */
export function openProjectPicker(start: PickerStart) {
  state = { open: true, generation: state.generation + 1, start };
  emit();
}

export function toggleProjectPicker() {
  if (state.open) closeProjectPicker();
  else openProjectPicker(DEFAULT_START);
}

/**
 * Cross-plugin contract with Double Shift (double-shift-palette), which
 * defines the same constant in plugins/double-shift-palette/double-shift.ts.
 *
 * Plugins can't run each other's commands, so Double Shift dispatches a
 * cancelable CustomEvent with this name on `window`; this plugin toggles the
 * picker and calls preventDefault() to claim it. Unclaimed, Double Shift
 * opens bb's quick palette instead. Renaming it breaks installed copies of
 * the other plugin, so change both sides together or not at all.
 */
export const TOGGLE_PROJECT_PICKER_EVENT = "bb-project-switcher:toggle";

export function useToggleProjectPickerEvent() {
  useEffect(() => {
    const onToggle = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      toggleProjectPicker();
    };
    window.addEventListener(TOGGLE_PROJECT_PICKER_EVENT, onToggle);
    return () => {
      window.removeEventListener(TOGGLE_PROJECT_PICKER_EVENT, onToggle);
    };
  }, []);
}

export function useProjectPickerOpen(): boolean {
  return useSyncExternalStore(subscribe, () => state.open);
}

export function useProjectPickerState(): PickerState {
  return useSyncExternalStore(subscribe, () => state);
}

export function resetProjectPickerForTest() {
  state = { open: false, generation: 0, start: DEFAULT_START };
  emit();
}
