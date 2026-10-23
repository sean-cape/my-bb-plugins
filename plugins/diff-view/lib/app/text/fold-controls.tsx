import type { ReactNode } from "react";
import { cn } from "../utils";
import { FAST, PRESS, enter } from "../ui/motion";
import { CURSOR_SHOWN } from "../keys/review-keys-context";
import { EXPAND_STEP_LINES, type FoldPart } from "./patch-gaps";

/**
 * A fold's band: neutral and lighter than a file's header, since the lines behind it are not what the reader is
 * looking at; nothing about it is coloured but the way to show them.
 */
export const FOLD_BAND = "bg-muted/20 text-[11px] text-muted-foreground";

function ExpanderButton({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} aria-label={title} className={cn("rounded px-1.5 py-0.5 text-primary hover:bg-state-hover", PRESS)} onClick={onClick}>
      {label}
    </button>
  );
}

/**
 * A fold's buttons and label, as GitHub draws them: a short fold opens in one press, a long one a step at a time
 * from either end, except that a fold at the top of the file has no code above it to grow down from (nor one at the
 * bottom up from). `count` 0 is a gap with nothing to open.
 */
export function FoldControls({ count, leading, trailing, noun, atCursor, onReveal, children }: { count: number; leading: boolean; trailing: boolean; noun: string; atCursor: boolean; onReveal: (part: FoldPart) => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      {count === 0 ? null : count <= EXPAND_STEP_LINES ? (
        <ExpanderButton label="↕" title={`Show ${count} ${noun}`} onClick={() => onReveal("all")} />
      ) : (
        <>
          {!leading ? <ExpanderButton label="↓" title={`Show ${EXPAND_STEP_LINES} lines below`} onClick={() => onReveal("first")} /> : null}
          {!trailing ? <ExpanderButton label="↑" title={`Show ${EXPAND_STEP_LINES} lines above`} onClick={() => onReveal("last")} /> : null}
        </>
      )}
      <span className="ml-2 font-sans">{children}</span>
      {/* Hidden rather than unmounted: inserting an element as the cursor passes restyles the whole page under bb themes with broad :has() rules. */}
      {count === 0 ? null : <span className={cn("ml-auto hidden font-mono text-[10px]", enter.fade, FAST, atCursor && `${CURSOR_SHOWN}inline`)}>↩ show {count <= EXPAND_STEP_LINES ? "them" : `${EXPAND_STEP_LINES} more`}</span>}
    </div>
  );
}
