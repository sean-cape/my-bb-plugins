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
  /** The identifiers on one side of `row`, and a peek at one of them under it; absent where the renderer has no peeks. */
  symbols?: { at: (row: number, side: DiffSide) => string[]; peek: (row: number, symbol: string) => void };
}

/** What a comment thread lets the keyboard do to it. */
export interface ThreadControls {
  toggle: () => void;
  reply: () => void;
  edit: (commentId: string) => void;
}

export interface ReviewKeysState {
  cursor: Cursor | null;
  /** Where `V` started; the selection runs from here to the cursor, within one file. */
  visual: Cursor | null;
  /** Keys typed toward an unfinished command, for the mode label. */
  pending: string;
  focusedThread: string | null;
}

/** The cursor as one file sees it; the same object until the cursor or selection in that file changes. */
export interface FileCursor {
  cursor: Cursor;
  visual: Cursor | null;
}

const INITIAL: ReviewKeysState = { cursor: null, visual: null, pending: "", focusedThread: null };

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
  };
}

export type ReviewKeys = ReturnType<typeof createReviewKeys>;

export const ReviewKeysContext = createContext<ReviewKeys | null>(null);

const NO_SUBSCRIPTION = () => () => {};

export function useFileCursor(path: string): FileCursor | null {
  const keys = useContext(ReviewKeysContext);
  return useSyncExternalStore(keys?.subscribe ?? NO_SUBSCRIPTION, () => keys?.fileCursor(path) ?? null);
}

export function useIsFocusedThread(id: string): boolean {
  const keys = useContext(ReviewKeysContext);
  return useSyncExternalStore(keys?.subscribe ?? NO_SUBSCRIPTION, () => keys?.get().focusedThread === id);
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

/** Hands focus from a comment box back to the diff around it, so the review keys work again. */
export function returnToDiff(from: Element | null): void {
  from?.closest<HTMLElement>("[data-diff-root]")?.focus({ preventScroll: true });
}
