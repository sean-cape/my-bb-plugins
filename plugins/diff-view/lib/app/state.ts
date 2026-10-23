import { useSyncExternalStore } from "react";
import { parseFindingFilter, type FindingFilter } from "./findings/findings";

/** Every preference the view keeps in localStorage, under `diff-view:<name>`. */
export type PreferenceName = "findingFilter" | "showFindings" | "tourOpen" | "fileTreeOpen" | "fileTreeWidth" | "viewMode" | "narrativeOutline" | "narrativeLayout" | `narrativeAt:${string}` | `narrativeRead:${string}` | "hideWhitespace" | "hideThreads" | "layout";

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
  /** Layout of the files view's diffs, structural and line alike. */
  layout: "unified" | "split";
  /** Layout of the narrative's excerpts, kept apart from the files' so each view reads as the reader likes. */
  narrativeLayout: "unified" | "split";
  /** Which review findings show inline in the diff. */
  findingFilter: FindingFilter;
  /** The file list beside the diff, where the view is wide enough for one. */
  fileTreeOpen: boolean;
  /** Text diffs show whitespace-only changes as unchanged lines, as `git diff -w` does. */
  hideWhitespace: boolean;
  /** Comment threads are left out of the files and narrative views (the conversation still lists them). */
  hideThreads: boolean;
}

/** Split for unified and unified for split, for the layout toggles. */
export function otherLayout(layout: DiffPreferences["layout"]): DiffPreferences["layout"] {
  return layout === "split" ? "unified" : "split";
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
  layout: readPreference("layout") === "unified" ? "unified" : "split",
  narrativeLayout: readPreference("narrativeLayout") === "unified" ? "unified" : "split",
  findingFilter: parseFindingFilter(readPreference("findingFilter"), readPreference("showFindings")),
  fileTreeOpen: readPreference("fileTreeOpen") !== "false",
  hideWhitespace: readPreference("hideWhitespace") !== "false",
  hideThreads: readPreference("hideThreads") === "true",
});

export function setDiffPreferences(patch: Partial<DiffPreferences>): void {
  preferences.set({ ...preferences.get(), ...patch });
  if (patch.findingFilter !== undefined) writePreference("findingFilter", patch.findingFilter);
  if (patch.narrativeLayout !== undefined) writePreference("narrativeLayout", patch.narrativeLayout);
  if (patch.fileTreeOpen !== undefined) writePreference("fileTreeOpen", String(patch.fileTreeOpen));
  if (patch.hideWhitespace !== undefined) writePreference("hideWhitespace", String(patch.hideWhitespace));
  if (patch.hideThreads !== undefined) writePreference("hideThreads", String(patch.hideThreads));
  if (patch.layout !== undefined) writePreference("layout", patch.layout);
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
