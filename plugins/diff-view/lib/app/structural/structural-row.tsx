import { memo } from "react";
import type { DiffSide, SemanticChange, StructuralDiff } from "../../types";
import { cn } from "../utils";
import { FAST, PRESS, enter } from "../ui/motion";
import { rangesOverlap } from "../ranges";
import { useCursorSide } from "../keys/review-keys-context";
import type { MovedRow } from "./moves";
import type { StructuralRow } from "./rows";
import { StructuralLine } from "./structural-line";
import type { LineTokens } from "./syntax";

type LineChanges = StructuralDiff["oldChanges"][number];

/** What every row of one file's table reads, kept as one stable object so a row re-renders only for its own reasons. */
export interface RowContext {
  path: string;
  oldLines: string[];
  newLines: string[];
  oldChanges: ReadonlyMap<number, LineChanges>;
  newChanges: ReadonlyMap<number, LineChanges>;
  oldTokens: LineTokens[] | null;
  newTokens: LineTokens[] | null;
  moved: ReadonlyMap<number, MovedRow>;
  semantics: SemanticChange[];
  changedRanges: Array<[number, number]>;
  /** A press on a line number, which starts a drag over line numbers (or extends the open comment's range). */
  onLinePress: (side: DiffSide, line: number, extend: boolean) => void;
  /** Enter or Space on a line number. */
  onLineActivate: (side: DiffSide, line: number) => void;
  /** The pointer entering a row while a line-number drag is in progress. */
  onDragOver: (row: StructuralRow) => void;
  jumpToRow: (index: number) => void;
  onSymbol: (symbol: string, anchor: HTMLElement) => void;
  onSymbolHover: (symbol: string | null, anchor: HTMLElement | null) => void;
}

function semanticAt(semantics: SemanticChange[], side: DiffSide, line: number): SemanticChange | null {
  return (
    semantics.find((change) => {
      if (change.kind === "logic") return false;
      const range = side === "LEFT" ? change.oldLines : change.newLines;
      return range !== null && line >= range[0] && line <= range[1];
    }) ?? null
  );
}

function LineCells({ context, line, side, rowChanged, movedRow, selected, atCursor }: { context: RowContext; line: number | null; side: DiffSide; rowChanged: boolean; movedRow: MovedRow | null; selected: boolean; atCursor: boolean }) {
  if (line === null) {
    return <td className="bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,var(--color-border)_6px,var(--color-border)_7px)] opacity-40" colSpan={2} />;
  }
  const lines = side === "LEFT" ? context.oldLines : context.newLines;
  const sideLine = movedRow !== null ? null : ((side === "LEFT" ? context.oldChanges : context.newChanges).get(line) ?? null);
  const text = lines[line - 1] ?? "";
  const lineTokens = (side === "LEFT" ? context.oldTokens : context.newTokens)?.[line - 1] ?? null;
  const semantic = rowChanged && movedRow === null ? semanticAt(context.semantics, side, line) : null;
  const neutral = movedRow !== null || semantic !== null;
  const tint = selected ? "bg-amber-400/20" : neutral ? "bg-violet-500/10" : rowChanged && (side === "LEFT" ? "bg-red-500/10" : "bg-emerald-500/10");
  const gutterTint = selected ? "bg-amber-400/35" : neutral ? "bg-violet-500/20" : rowChanged && (side === "LEFT" ? "bg-red-500/20" : "bg-emerald-500/20");
  const changedSince = side === "RIGHT" && rangesOverlap(line, line, context.changedRanges);
  const movedLabel =
    movedRow !== null && movedRow.first ? (
      <button
        type="button"
        className={cn("float-right ml-2 rounded border border-violet-500/40 px-1.5 font-sans text-[10px] text-violet-700 hover:bg-violet-500/20 dark:text-violet-300", PRESS)}
        title={side === "LEFT" ? "This block moved; jump to where it went" : "This block moved; jump to where it came from"}
        onClick={() => context.jumpToRow(movedRow.counterpart)}
      >
        moved {side === "LEFT" ? "to" : "from"} line {movedRow.counterpartLine}
      </button>
    ) : null;
  return (
    <>
      <td
        className={cn("group/ln select-none border-r border-border/60 pr-2 text-right align-top text-muted-foreground/70", gutterTint, changedSince && "shadow-[inset_2px_0_0_0_theme(colors.sky.500)]", atCursor && "bg-primary/25 font-medium text-foreground")}
        title={changedSince ? "Changed since you last looked" : undefined}
      >
        <button
          type="button"
          className="relative w-full touch-none text-right tabular-nums hover:text-foreground"
          title="Comment on this line; drag or shift-click for several"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            // Keeps the drag from selecting text.
            event.preventDefault();
            context.onLinePress(side, line, event.shiftKey);
          }}
          onClick={(event) => {
            // Pointer clicks start from pointerdown; this is the keyboard's Enter or Space.
            if (event.detail === 0) context.onLineActivate(side, line);
          }}
        >
          <span className="group-hover/ln:invisible">{line}</span>
          <span className="absolute inset-0 hidden items-center justify-end pr-0.5 text-primary group-hover/ln:flex">+</span>
        </button>
      </td>
      <td className={cn("whitespace-pre-wrap break-words pl-2 pr-3 align-top", tint, atCursor && "ring-1 ring-inset ring-primary/70")} data-cursor={atCursor ? "" : undefined}>
        {movedLabel}
        <StructuralLine text={text} changes={sideLine} tokens={lineTokens} side={side} onSymbol={context.onSymbol} onSymbolHover={context.onSymbolHover} />
      </td>
    </>
  );
}

/** One side-by-side row of the table. It watches the cursor itself, so moving the cursor re-renders only the rows it leaves and enters. */
export const StructuralRowView = memo(function StructuralRowView({
  row,
  context,
  selectedLeft,
  selectedRight,
  unfolded,
  dragging,
}: {
  row: StructuralRow;
  context: RowContext;
  selectedLeft: boolean;
  selectedRight: boolean;
  /** Unfolded by the reader, so it fades in. */
  unfolded: boolean;
  dragging: boolean;
}) {
  const cursorSide = useCursorSide(context.path, row.lhs, row.rhs);
  const movedRow = context.moved.get(row.index) ?? null;
  return (
    <tr className={cn("hover:bg-state-hover/40", unfolded && [enter.fade, FAST])} data-row={row.index} onPointerEnter={dragging ? () => context.onDragOver(row) : undefined}>
      <LineCells context={context} line={row.lhs} side="LEFT" rowChanged={row.changed} movedRow={movedRow} selected={selectedLeft} atCursor={cursorSide === "LEFT"} />
      <LineCells context={context} line={row.rhs} side="RIGHT" rowChanged={row.changed} movedRow={movedRow} selected={selectedRight} atCursor={cursorSide === "RIGHT"} />
    </tr>
  );
});

/** Folded runs up to this long expand in one click; longer ones expand this many lines per click. */
export const EXPAND_STEP_LINES = 20;

function ExpanderButton({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} aria-label={title} className={cn("rounded px-1.5 py-0.5 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300", PRESS)} onClick={onClick}>
      {label}
    </button>
  );
}

/** A fold of unchanged rows `from` up to `to`; `at` is the hidden row whose lines the cursor takes on it. */
export const GapRow = memo(function GapRow({ path, from, to, total, first, last, at, onReveal }: { path: string; from: number; to: number; total: number; first: StructuralRow; last: StructuralRow; at: StructuralRow; onReveal: (from: number, to: number) => void }) {
  const atCursor = useCursorSide(path, at.lhs, at.rhs) !== null;
  const count = to - from;
  const leading = from === 0;
  const trailing = to === total;
  const range = `${first.rhs ?? first.lhs}–${last.rhs ?? last.lhs}`;
  return (
    <tr data-gap={from} className="bg-sky-500/10 text-[11px] text-muted-foreground">
      <td colSpan={4} className={cn("px-2 py-0.5", atCursor && "ring-1 ring-inset ring-primary/70")} data-cursor={atCursor ? "" : undefined}>
        <div className="flex items-center gap-1">
          {count <= EXPAND_STEP_LINES ? (
            <ExpanderButton label="↕" title={`Show ${count} unchanged lines`} onClick={() => onReveal(from, to)} />
          ) : (
            <>
              {!leading ? <ExpanderButton label="↓" title={`Show ${EXPAND_STEP_LINES} lines below`} onClick={() => onReveal(from, from + EXPAND_STEP_LINES)} /> : null}
              {!trailing ? <ExpanderButton label="↑" title={`Show ${EXPAND_STEP_LINES} lines above`} onClick={() => onReveal(to - EXPAND_STEP_LINES, to)} /> : null}
            </>
          )}
          <span className="ml-2 font-sans">
            {count} unchanged {count === 1 ? "line" : "lines"} ({range})
          </span>
          {/* Hidden rather than unmounted: inserting an element as the cursor passes restyles the whole page under bb themes with broad :has() rules. */}
          <span className={cn("ml-auto font-mono text-[10px]", enter.fade, FAST, !atCursor && "hidden")}>↩ show {count <= EXPAND_STEP_LINES ? "them" : `${EXPAND_STEP_LINES} more`}</span>
        </div>
      </td>
    </tr>
  );
});

/** The bar under a long new or deleted file's preview; `at` is the first row it hides. */
export const PreviewMoreRow = memo(function PreviewMoreRow({ path, at, remaining, deleted, onShowAll }: { path: string; at: StructuralRow; remaining: number; deleted: boolean; onShowAll: () => void }) {
  const atCursor = useCursorSide(path, at.lhs, at.rhs) !== null;
  return (
    <tr data-preview-more="" className="bg-sky-500/10 text-xs text-muted-foreground">
      <td colSpan={4} className={cn("px-3 py-1.5", atCursor && "ring-1 ring-inset ring-primary/70")} data-cursor={atCursor ? "" : undefined}>
        <button type="button" className={cn("rounded px-1.5 py-0.5 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300", PRESS)} onClick={onShowAll}>
          Show {remaining} more {remaining === 1 ? "line" : "lines"} of this {deleted ? "deleted" : "new"} file
        </button>
      </td>
    </tr>
  );
});
