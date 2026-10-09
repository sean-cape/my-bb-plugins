import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import type { DiffSide } from "../../types";
import type { Cursor, NavRow } from "./nav";

/** What a mounted file renderer tells the keyboard about its diff. */
export interface FileNavModel {
  rows: readonly NavRow[];
  /** Comments on these rows go to GitHub, which needs a multi-line range inside one hunk. */
  cutToHunk: boolean;
  /** The element showing `row` on `side`, to scroll it into view; null when it is not rendered. */
  element: (row: number, side: DiffSide) => Element | null;
  /** Unfold more unchanged lines around the hunk holding `row`; absent where the renderer cannot. */
  moreContext?: (row: number) => void;
  /** Open the fold at `row` (an `expander` row); returns the lines the cursor goes to, which stay on the fold while it has more. */
  expand?: (row: number) => { left: number | null; right: number | null } | null;
  /** The identifiers on one side of `row`, and a peek at one of them under it; absent where the renderer has no peeks. */
  symbols?: { at: (row: number, side: DiffSide) => string[]; peek: (row: number, symbol: string) => void };
}

/** What a comment thread lets the keyboard do to it. */
export interface ThreadControls {
  toggle: () => void;
  reply: () => void;
  edit: (commentId: string) => void;
}

/** What a review finding lets the keyboard do to it. */
export interface FindingControls {
  toggle: () => void;
  edit: () => void;
}

/** The thread or finding under the cursor that the comment keys act on; several can share a line. */
export interface FocusedAnnotation {
  kind: "thread" | "finding";
  id: string;
  /** Reached by scrolling by hand rather than by a key, so it is not opened for reading. */
  passive?: boolean;
}

export interface ReviewKeysState {
  cursor: Cursor | null;
  /** Where `V` started; the selection runs from here to the cursor, within one file. */
  visual: Cursor | null;
  /** Keys typed toward an unfinished command, for the mode label. */
  pending: string;
  focused: FocusedAnnotation | null;
}

/** The cursor as one file sees it; the same object until the cursor or selection in that file changes. */
export interface FileCursor {
  cursor: Cursor;
  visual: Cursor | null;
}

const INITIAL: ReviewKeysState = { cursor: null, visual: null, pending: "", focused: null };

/**
 * The view's keyboard state, outside React so moving the cursor re-renders only the file it is in, plus the
 * registries renderers and threads publish into.
 */
export function createReviewKeys() {
  let state = INITIAL;
  let fileCursor: FileCursor | null = null;
  const listeners = new Set<() => void>();
  const models = new Map<string, FileNavModel>();
  const modelListeners = new Set<(path: string) => void>();
  const threads = new Map<string, ThreadControls>();
  const findings = new Map<string, FindingControls>();
  return {
    get: () => state,
    fileCursor: (path: string) => (state.cursor !== null && state.cursor.path === path ? fileCursor : null),
    set(patch: Partial<ReviewKeysState>) {
      const next = { ...state, ...patch };
      if (next.cursor !== state.cursor || next.visual !== state.visual) fileCursor = next.cursor === null ? null : { cursor: next.cursor, visual: next.visual };
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    models,
    setModel(path: string, model: FileNavModel | null) {
      if (model === null) models.delete(path);
      else models.set(path, model);
      for (const listener of modelListeners) listener(path);
    },
    onModel(listener: (path: string) => void) {
      modelListeners.add(listener);
      return () => modelListeners.delete(listener);
    },
    threads,
    findings,
  };
}

export type ReviewKeys = ReturnType<typeof createReviewKeys>;

export const ReviewKeysContext = createContext<ReviewKeys | null>(null);

const NO_SUBSCRIPTION = () => () => {};

export function useFileCursor(path: string): FileCursor | null {
  const keys = useContext(ReviewKeysContext);
  return useSyncExternalStore(keys?.subscribe ?? NO_SUBSCRIPTION, () => keys?.fileCursor(path) ?? null);
}

/**
 * The side of a row the cursor is on, or null. A row re-renders only when the cursor arrives or leaves, not on every
 * move within its file.
 */
export function useCursorSide(path: string, left: number | null, right: number | null): DiffSide | null {
  const keys = useContext(ReviewKeysContext);
  return useSyncExternalStore(keys?.subscribe ?? NO_SUBSCRIPTION, () => {
    const cursor = keys?.get().cursor;
    if (cursor == null || cursor.path !== path || cursor.line === null) return null;
    return (cursor.side === "LEFT" ? left : right) === cursor.line ? cursor.side : null;
  });
}

export function useCursorOnHeader(path: string): boolean {
  const keys = useContext(ReviewKeysContext);
  return useSyncExternalStore(keys?.subscribe ?? NO_SUBSCRIPTION, () => {
    const cursor = keys?.get().cursor;
    return cursor != null && cursor.path === path && cursor.line === null;
  });
}

/** The cursor in this file while `V` selects lines in it; null otherwise, so plain cursor moves leave the file be. */
export function useFileSelection(path: string): FileCursor | null {
  const keys = useContext(ReviewKeysContext);
  return useSyncExternalStore(keys?.subscribe ?? NO_SUBSCRIPTION, () => {
    const fileCursor = keys?.fileCursor(path) ?? null;
    return fileCursor?.visual != null ? fileCursor : null;
  });
}

export function useIsFocused(kind: FocusedAnnotation["kind"], id: string): boolean {
  const keys = useContext(ReviewKeysContext);
  return useSyncExternalStore(keys?.subscribe ?? NO_SUBSCRIPTION, () => {
    const focused = keys?.get().focused;
    return focused?.kind === kind && focused.id === id;
  });
}

/** Focused by a key, not by scrolling past: a folded annotation shows itself while this holds. */
export function useIsReading(kind: FocusedAnnotation["kind"], id: string): boolean {
  const keys = useContext(ReviewKeysContext);
  return useSyncExternalStore(keys?.subscribe ?? NO_SUBSCRIPTION, () => {
    const focused = keys?.get().focused;
    return focused?.kind === kind && focused.id === id && focused.passive !== true;
  });
}

export function useReviewKeysState(): ReviewKeysState {
  const keys = useContext(ReviewKeysContext);
  return useSyncExternalStore(keys?.subscribe ?? NO_SUBSCRIPTION, () => keys?.get() ?? INITIAL);
}

/**
 * Publishes a file's rows to the keyboard while the renderer is mounted. Pass null while the diff is still loading,
 * so the cursor waits at the file's header instead of skipping the file.
 */
export function usePublishNavModel(path: string, model: FileNavModel | null): void {
  const keys = useContext(ReviewKeysContext);
  const published = useRef<FileNavModel | null>(null);
  useEffect(() => {
    if (keys === null || published.current === model) return;
    published.current = model;
    keys.setModel(path, model);
  });
  useEffect(() => {
    if (keys === null) return;
    return () => {
      published.current = null;
      keys.setModel(path, null);
    };
  }, [keys, path]);
}

export function useThreadControls(id: string, controls: ThreadControls): void {
  const keys = useContext(ReviewKeysContext);
  const latest = useRef(controls);
  latest.current = controls;
  useEffect(() => {
    if (keys === null) return;
    keys.threads.set(id, {
      toggle: () => latest.current.toggle(),
      reply: () => latest.current.reply(),
      edit: (commentId) => latest.current.edit(commentId),
    });
    return () => {
      keys.threads.delete(id);
    };
  }, [keys, id]);
}

export function useFindingControls(id: string, controls: FindingControls): void {
  const keys = useContext(ReviewKeysContext);
  const latest = useRef(controls);
  latest.current = controls;
  useEffect(() => {
    if (keys === null) return;
    keys.findings.set(id, {
      toggle: () => latest.current.toggle(),
      edit: () => latest.current.edit(),
    });
    return () => {
      keys.findings.delete(id);
    };
  }, [keys, id]);
}

/** Hands focus from a comment box back to the diff around it, so the review keys work again. */
export function returnToDiff(from: Element | null): void {
  from?.closest<HTMLElement>("[data-diff-root]")?.focus({ preventScroll: true });
}
