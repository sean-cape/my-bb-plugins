import { memo } from "react";
import type { ExcerptGap, PatchLine } from "../../narrative";
import { cn } from "../utils";
import { CURSOR_RING, useCursorSide } from "../keys/review-keys-context";
import { FOLD_BAND, FoldControls } from "./fold-controls";
import { gapCursorLine, gapPart } from "./patch-gaps";

function span(lines: readonly PatchLine[]): string | null {
  const numbers = lines.flatMap((line) => (line.new === null ? [] : [line.new]));
  const [side, values] = numbers.length > 0 ? ["", numbers] : ["old ", lines.flatMap((line) => (line.old === null ? [] : [line.old]))];
  if (values.length === 0) return null;
  const first = Math.min(...values);
  const last = Math.max(...values);
  return first === last ? `${side}L${first}` : `${side}L${first}–${last}`;
}

/**
 * A gap's band, so lines either side of it never read as one run: the patch rows it hides (other steps' changes and
 * the context between them) open from its buttons or Enter; the lines between hunks only show their count, as no
 * patch holds them.
 */
export const GapBand = memo(function GapBand({ path, gap, index, onReveal }: { path: string; gap: ExcerptGap; index: number; onReveal: (lines: readonly PatchLine[]) => void }) {
  const at = gapCursorLine(gap);
  const atCursor = useCursorSide(path, at?.old ?? null, at?.new ?? null) !== null;
  const count = gap.hidden.length;
  const changed = gap.hidden.filter((line) => line.old === null || line.new === null).length;
  const range = span(gap.hidden);
  const parts = [
    count === 0 ? null : `${count} ${count === 1 ? "line" : "lines"} not in this step${range === null ? "" : ` (${range}${changed === 0 ? "" : `, ${changed} changed`})`}`,
    gap.unchanged === 0 ? null : `${gap.unchanged} unchanged ${gap.unchanged === 1 ? "line" : "lines"}`,
  ].filter((part) => part !== null);
  return (
    <div data-excerpt-gap={index} className={cn(FOLD_BAND, "border-y border-border/60 px-2 py-0.5", atCursor && CURSOR_RING)} data-cursor={atCursor ? "" : undefined}>
      <FoldControls count={count} leading={gap.after === null} trailing={gap.before === null} noun={count === 1 ? "line" : "lines"} atCursor={atCursor} onReveal={(part) => onReveal(gapPart(gap, part))}>
        {parts.join(" · ")}
      </FoldControls>
    </div>
  );
});
