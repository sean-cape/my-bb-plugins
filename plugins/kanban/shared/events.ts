/** Realtime channel: the board changed, refetch. */
export const BOARD_CHANGED = "board-changed";

/** A diff subject is a card id, or this prefix plus the id of a thread that has no card yet. */
export const THREAD_SUBJECT_PREFIX = "thread:";

/** Realtime channel: a monitored card's loop stopped for the user; open windows show a desktop notification. */
export const LOOP_STOPPED = "loop-stopped";

export interface LoopStoppedPayload {
  threadId: string;
  title: string;
  body: string;
}
