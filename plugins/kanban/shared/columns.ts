/** Column ids the plugin gives meaning to. Users can rename, reorder or remove these columns; cards and agents find them by id. */
export const COLUMN = {
  backlog: "backlog",
  todo: "todo",
  inProgress: "in-progress",
  /** Owned by the monitored review loop: cards wait here while the board re-runs their checks and reviews them. */
  checking: "checking",
  review: "review",
  /** Waiting on someone or something else; nothing moves cards here but you. */
  waiting: "waiting",
  done: "done",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a card has sat in a column longer than the column keeps cards on show. */
export function agedOut(column: { hideAfterDays?: number | null }, enteredAt: number, now: number): boolean {
  return column.hideAfterDays != null && now - enteredAt > column.hideAfterDays * DAY_MS;
}

/** Where finished cards go: the `done` column, else the last one. */
export function doneColumnId(columns: readonly { id: string }[]): string | null {
  return columns.find((column) => column.id === COLUMN.done)?.id ?? columns.at(-1)?.id ?? null;
}

/** Where new and reopened to-dos go: the `todo` column, else the first one. */
export function todoColumnId(columns: readonly { id: string }[]): string | null {
  return columns.find((column) => column.id === COLUMN.todo)?.id ?? columns[0]?.id ?? null;
}
