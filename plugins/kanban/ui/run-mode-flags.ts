import type { LoopGates } from "../shared/loop";

/** How a new card runs: on the board alone, with a thread that moves it itself, or with a thread the review loop drives. */
export type RunMode = "card" | "thread" | "loop";

/**
 * The create call's flags for a mode. Card only leaves monitoring to the tags' default, Thread turns it off so a
 * monitor tag can't put a thread started under the plain contract into the loop, and Review loop turns it on with the gates.
 */
export function runModeFlags(mode: RunMode, gates: LoopGates): { startThread: boolean; monitored?: boolean; gates?: LoopGates } {
  switch (mode) {
    case "card":
      return { startThread: false };
    case "thread":
      return { startThread: true, monitored: false };
    case "loop":
      return { startThread: true, monitored: true, gates };
  }
}
