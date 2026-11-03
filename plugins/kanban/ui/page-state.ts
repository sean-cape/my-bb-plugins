import { useSyncExternalStore } from "react";

/**
 * Collapse the host's right panel. The SDK can open fixed tabs but has no close
 * call, so this presses the host's own toggle, found by its accessible label.
 * If the host renames it, the card still clears; only the collapse is lost.
 */
export function collapseRightPanel(): void {
  document.querySelector<HTMLButtonElement>('button[aria-label^="Hide right panel"]')?.click();
}

/**
 * Page-level UI state shared between the host title bar (`headerContent`) and
 * the page body, which the host mounts as separate React trees.
 */
interface PageUiState {
  dialog: "new" | "columns" | "sources" | "keys" | null;
  /** Show subtasks as their own cards on the board (default: only in their parent's panel). */
  showSubtasks: boolean;
  newTicketColumn: string | null;
}
export const pageUi = (() => {
  let showSubtasks = false;
  try {
    showSubtasks = window.localStorage.getItem("kanban:showSubtasks") === "true";
  } catch {
    showSubtasks = false;
  }
  let state: PageUiState = { dialog: null, newTicketColumn: null, showSubtasks };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (patch: Partial<PageUiState>) => {
      state = { ...state, ...patch };
      if (patch.showSubtasks !== undefined) {
        try {
          window.localStorage.setItem("kanban:showSubtasks", String(patch.showSubtasks));
        } catch {
          // ignore
        }
      }
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
export function usePageUi(): PageUiState {
  return useSyncExternalStore(pageUi.subscribe, pageUi.get, pageUi.get);
}

export type BoardView = "board" | "todo";

/** The view the page last showed, which it opens on when the sidebar link brings it up again. */
export const lastView = {
  get: (): BoardView => {
    try {
      return window.localStorage.getItem("kanban:view") === "todo" ? "todo" : "board";
    } catch {
      return "board";
    }
  },
  set: (view: BoardView) => {
    try {
      window.localStorage.setItem("kanban:view", view);
    } catch {
      // ignore
    }
  },
};

/** The right-panel tab that shows the selected card; targeted by ticket id. */
export const TICKET_TAB = {
  panelId: "board",
  id: "ticket",
  experimental_target: {
    validate: (value: unknown): value is { ticketId: string } =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { ticketId?: unknown }).ticketId === "string",
  },
} as const;
