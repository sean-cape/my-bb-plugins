import { useSyncExternalStore } from "react";

/** Every preference the view keeps in localStorage, under `diff-view:<name>`. */
export type PreferenceName = "diffMode" | "showFindings" | "tourOpen" | "fileTreeOpen" | "fileTreeWidth";

/** Reads a preference, falling back to the key kanban stored it under before the diff view became its own plugin. */
export function readPreference(name: PreferenceName): string | null {
  try {
    return window.localStorage.getItem(`diff-view:${name}`) ?? window.localStorage.getItem(`kanban:${name}`);
  } catch {
    return null;
  }
}

export function writePreference(name: PreferenceName, value: string): void {
  try {
    window.localStorage.setItem(`diff-view:${name}`, value);
  } catch {
    // Private mode or quota: keep the in-memory value for this session.
  }
}

export interface DiffPreferences {
  /** Text (Pierre) or structural (difftastic) rendering of a file's changes. */
  mode: "text" | "structural";
  layout: "unified" | "split";
  /** Show review findings inline in the diff. */
  showFindings: boolean;
}

function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next: T) => {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const preferences = createStore<DiffPreferences>({
  mode: readPreference("diffMode") === "text" ? "text" : "structural",
  layout: "split",
  showFindings: readPreference("showFindings") !== "false",
});

export function setDiffPreferences(patch: Partial<DiffPreferences>): void {
  preferences.set({ ...preferences.get(), ...patch });
  if (patch.mode !== undefined) writePreference("diffMode", patch.mode);
  if (patch.showFindings !== undefined) writePreference("showFindings", String(patch.showFindings));
}

export function useDiffPreferences(): DiffPreferences {
  return useSyncExternalStore(preferences.subscribe, preferences.get, preferences.get);
}

/**
 * Loading state and refresh requests per diff view instance. A toolbar can live in a different React tree than its view
 * (the host title bar renders `headerContent` separately from the page body), so they meet here by instance key.
 */
interface InstanceState {
  loading: boolean;
  /** Bumped by each refresh request; the view refetches when it changes. */
  reloadNonce: number;
  /** When something last asked the view to take the keyboard (a command, say), so a view mounting for it can take it too. */
  focusRequestedAt: number;
}

const IDLE: InstanceState = { loading: false, reloadNonce: 0, focusRequestedAt: 0 };

const instances = createStore<ReadonlyMap<string, InstanceState>>(new Map());

function patchInstance(key: string, patch: (current: InstanceState) => InstanceState): void {
  const next = new Map(instances.get());
  next.set(key, patch(next.get(key) ?? IDLE));
  instances.set(next);
}

export function setInstanceLoading(key: string, loading: boolean): void {
  if ((instances.get().get(key)?.loading ?? false) !== loading) patchInstance(key, (current) => ({ ...current, loading }));
}

export function requestReload(key: string): void {
  patchInstance(key, (current) => ({ ...current, reloadNonce: current.reloadNonce + 1 }));
}

export function requestFocus(key: string): void {
  patchInstance(key, (current) => ({ ...current, focusRequestedAt: Date.now() }));
}

export function useDiffInstance(key: string): InstanceState {
  const map = useSyncExternalStore(instances.subscribe, instances.get, instances.get);
  return map.get(key) ?? IDLE;
}

/** The view that last saw a pointer or focus; single-key shortcuts go only to it when several views are mounted. */
let keyboardOwner: symbol | null = null;
export function claimKeyboard(owner: symbol): void {
  keyboardOwner = owner;
}
export function releaseKeyboard(owner: symbol): void {
  if (keyboardOwner === owner) keyboardOwner = null;
}
export function ownsKeyboard(owner: symbol): boolean {
  keyboardOwner ??= owner;
  return keyboardOwner === owner;
}
