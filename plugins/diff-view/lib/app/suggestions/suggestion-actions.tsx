import type { ReactNode } from "react";
import type { SuggestionItem } from "../../types";
import { Badge } from "../ui/badge";
import { PRESS } from "../ui/motion";
import { cn } from "../utils";
import { applicableItem, isInBatch, type SuggestionActions } from "./actions";

export const SUGGESTION_BUTTON = cn("rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50", PRESS);

/** The suggestion's state as a badge: applied, in the batch, or `otherwise`. */
export function SuggestionBadge({ applied, inBatch, otherwise = null }: { applied: boolean; inBatch: boolean; otherwise?: ReactNode }) {
  if (applied) return <Badge tone="success">applied</Badge>;
  return inBatch ? <Badge tone="accent">in batch</Badge> : <>{otherwise}</>;
}

/** "Apply suggestion" and "Add to batch" for an item the view can apply; nothing otherwise. */
export function SuggestionButtons({ actions, item, applyTitle }: { actions: SuggestionActions; item: SuggestionItem | null; applyTitle: string }) {
  const applicable = applicableItem(actions, item);
  if (applicable === null) return null;
  const inBatch = isInBatch(actions.batch, applicable);
  return (
    <>
      <button type="button" className={SUGGESTION_BUTTON} disabled={actions.busy} title={applyTitle} onClick={() => void actions.apply?.([applicable])}>
        Apply suggestion
      </button>
      <button type="button" aria-pressed={inBatch} className={cn(SUGGESTION_BUTTON, inBatch && "bg-state-active text-foreground")} title="Apply it with others in one go: Commit N suggestions above the diff, or gB (B)" onClick={() => actions.toggleBatch(applicable)}>
        {inBatch ? "Remove from batch" : "Add to batch"}
      </button>
    </>
  );
}

