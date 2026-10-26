import { useEffect, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { writePreference } from "bb-diff-view/app/state";
import type { Ticket } from "../shared/board";
import { BOARD_CHANGED } from "../shared/events";
import type { ReadingPlan } from "../shared/reading-plan";
import { briefShown, unassessed } from "./handoff-brief";
import type { Rpc } from "./data";

/** Opens the changes view in the narrative stepper; the diff view reads its mode from this preference as it mounts. */
export function openInStepper(): void {
  writePreference("viewMode", "narrative");
}

// The changes view and the brief are separate surfaces; this tells the brief a Viewed mark moved so its gate recounts.
const viewedListeners = new Set<() => void>();

export function notifyViewedChanged(): void {
  for (const listener of viewedListeners) listener();
}

/**
 * The card's reading plan while its brief shows, refetched as the board changes (a narrative finishing, say) and as
 * files are marked viewed. None after a hand-off or a stop: the change reaches the user unassessed, with no level to plan from.
 */
export function useReadingPlan(ticket: Ticket, rpc: Rpc): ReadingPlan | null {
  const [plan, setPlan] = useState<ReadingPlan | null>(null);
  const [changes, setChanges] = useState(0);
  const bump = () => setChanges((count) => count + 1);
  useRealtime(BOARD_CHANGED, bump);
  const shown = briefShown(ticket.loop) && !unassessed(ticket.loop);
  useEffect(() => {
    const listener = bump;
    viewedListeners.add(listener);
    return () => {
      viewedListeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!shown) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    rpc.call("loop_reading_plan", { id: ticket.id }).then(
      (result) => {
        if (!cancelled) setPlan(result);
      },
      () => {
        // The brief shows without a plan; the Accept gate still holds on the server.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [shown, ticket.id, changes, rpc]);
  return plan;
}
