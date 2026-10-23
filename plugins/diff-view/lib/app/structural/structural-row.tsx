import { memo } from "react";
import type { DiffSide, SemanticChange, StructuralDiff } from "../../types";
import { cn } from "../utils";
import { FAST, PRESS, enter } from "../ui/motion";
import { rangesOverlap } from "../ranges";
import { CURSOR_GUTTER, CURSOR_RING, useCursorSide } from "../keys/review-keys-context";
import type { MovedRow } from "./moves";
import type { StructuralRow } from "./rows";
import { StructuralLine } from "./structural-line";
import type { LineTokens } from "./syntax";
import { hangingIndent } from "../text/hanging-indent";
import { FOLD_BAND, FoldControls } from "../text/fold-controls";
import { EXPAND_STEP_LINES, type FoldPart } from "../text/patch-gaps";

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
  /** New-side lines changed since the point new code counts from, and that point's name ("r2"). */
  changedRanges: Array<[number, number]>;
  newLabel: string;
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

/** How one side's line is tinted: its code, its line number, and whether it is new since the last review. */
function lineLook(context: RowContext, side: DiffSide, line: number, rowChanged: boolean, movedRow: MovedRow | null, selected: boolean) {
  const semantic = rowChanged && movedRow === null ? semanticAt(context.semantics, side, line) : null;
  const neutral = movedRow !== null || semantic !== null;
  return {
    tint: selected ? "bg-amber-400/20" : neutral ? "bg-violet-500/10" : rowChanged && (side === "LEFT" ? "bg-red-500/10" : "bg-emerald-500/10"),
    gutterTint: selected ? "bg-amber-400/35" : neutral ? "bg-violet-500/20" : rowChanged && (side === "LEFT" ? "bg-red-500/20" : "bg-emerald-500/20"),
    changedSince: side === "RIGHT" && rangesOverlap(line, line, context.changedRanges),
  };
}

function LineNumberCell({ context, line, side, gutterTint, changedSince, atCursor }: { context: RowContext; line: number; side: DiffSide; gutterTint: string | false; changedSince: boolean; atCursor: boolean }) {
  return (
    <td
      className={cn(
        "group/ln select-none border-r border-border/60 pl-3 pr-2 text-right align-top text-muted-foreground/70",
        // The new-since mark replaces the gutter's red or green: the code beside it still says added or changed.
        changedSince ? "bg-sky-500/25 font-medium text-sky-800 shadow-[inset_3px_0_0_0_theme(colors.sky.500)] dark:text-sky-200" : gutterTint,
        atCursor && CURSOR_GUTTER,
      )}
      title={changedSince ? `New since ${context.newLabel}` : undefined}
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
        {line}
        <span aria-hidden="true" className="absolute -left-2.5 top-0 hidden text-primary group-hover/ln:inline">
          +
        </span>
      </button>
    </td>
  );
}

function CodeCell({ context, line, side, movedRow, tint, atCursor, bothSides = false }: { context: RowContext; line: number; side: DiffSide; movedRow: MovedRow | null; tint: string | false; atCursor: boolean; bothSides?: boolean }) {
  const lines = side === "LEFT" ? context.oldLines : context.newLines;
  const sideLine = movedRow !== null ? null : ((side === "LEFT" ? context.oldChanges : context.newChanges).get(line) ?? null);
  const text = lines[line - 1] ?? "";
  const lineTokens = (side === "LEFT" ? context.oldTokens : context.newTokens)?.[line - 1] ?? null;
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
    <td className={cn("whitespace-pre-wrap pl-2 pr-3 align-top", tint, atCursor && CURSOR_RING)} data-cursor={atCursor ? "" : undefined}>
      {movedLabel}
      <span className="block" data-line-text={bothSides ? "LEFT RIGHT" : side} style={hangingIndent(text)}>
        <StructuralLine text={text} changes={sideLine} tokens={lineTokens} side={side} onSymbol={context.onSymbol} onSymbolHover={context.onSymbolHover} />
      </span>
    </td>
  );
}

function LineCells({ context, line, side, rowChanged, movedRow, selected, atCursor }: { context: RowContext; line: number | null; side: DiffSide; rowChanged: boolean; movedRow: MovedRow | null; selected: boolean; atCursor: boolean }) {
  if (line === null) {
    return <td className="bg-muted/30" colSpan={2} />;
  }
  const { tint, gutterTint, changedSince } = lineLook(context, side, line, rowChanged, movedRow, selected);
  return (
    <>
      <LineNumberCell context={context} line={line} side={side} gutterTint={gutterTint} changedSince={changedSince} atCursor={atCursor} />
      <CodeCell context={context} line={line} side={side} movedRow={movedRow} tint={tint} atCursor={atCursor} />
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

/**
 * One row of the unified table: the old and new line numbers, then one line of code, the old text on a deleted half
 * and the new text otherwise. A half of a modified pair shares its aligned row's `data-row`, so it also carries `data-side`.
 */
export const UnifiedRowView = memo(function UnifiedRowView({
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
  unfolded: boolean;
  dragging: boolean;
}) {
  const cursorSide = useCursorSide(context.path, row.lhs, row.rhs);
  const movedRow = context.moved.get(row.index) ?? null;
  const side: DiffSide = row.rhs === null ? "LEFT" : "RIGHT";
  const line = (side === "LEFT" ? row.lhs : row.rhs)!;
  const { tint, gutterTint, changedSince } = lineLook(context, side, line, row.changed, movedRow, selectedLeft || selectedRight);
  const gutter = (gutterSide: DiffSide, number: number | null) =>
    number === null ? (
      <td className={cn("border-r border-border/60", gutterTint)} />
    ) : (
      <LineNumberCell context={context} line={number} side={gutterSide} gutterTint={gutterTint} changedSince={gutterSide === "RIGHT" && changedSince} atCursor={cursorSide === gutterSide} />
    );
  return (
    <tr
      className={cn("hover:bg-state-hover/40", unfolded && [enter.fade, FAST])}
      data-row={row.index}
      data-side={row.lhs === null || row.rhs === null ? side : undefined}
      onPointerEnter={dragging ? () => context.onDragOver(row) : undefined}
    >
      {gutter("LEFT", row.lhs)}
      {gutter("RIGHT", row.rhs)}
      <CodeCell context={context} line={line} side={side} movedRow={movedRow} tint={tint} atCursor={cursorSide !== null} bothSides={row.lhs !== null && row.rhs !== null} />
    </tr>
  );
});

/** A fold of unchanged rows `from` up to `to`; `at` is the hidden row whose lines the cursor takes on it. */
export const GapRow = memo(function GapRow({
  path,
  from,
  to,
  total,
  first,
  last,
  at,
  onReveal,
  columns = 4,
  older = null,
}: {
  path: string;
  from: number;
  to: number;
  total: number;
  first: StructuralRow;
  last: StructuralRow;
  at: StructuralRow;
  onReveal: (from: number, to: number) => void;
  columns?: number;
  /** The changes "Only new" folded in here, made before the point it counts from. */
  older?: { changed: number; label: string } | null;
}) {
  const atCursor = useCursorSide(path, at.lhs, at.rhs) !== null;
  const count = to - from;
  const range = `${first.rhs ?? first.lhs}–${last.rhs ?? last.lhs}`;
  const reveal = (part: FoldPart) => (part === "all" ? onReveal(from, to) : part === "first" ? onReveal(from, from + EXPAND_STEP_LINES) : onReveal(to - EXPAND_STEP_LINES, to));
  return (
    <tr data-gap={from} className={FOLD_BAND}>
      <td colSpan={columns} className={cn("px-2 py-0.5", atCursor && CURSOR_RING)} data-cursor={atCursor ? "" : undefined}>
        <FoldControls count={count} leading={from === 0} trailing={to === total} noun={older === null ? "unchanged lines" : "folded lines"} atCursor={atCursor} onReveal={reveal}>
          {older === null ? `${count} unchanged ${count === 1 ? "line" : "lines"}` : `${count} ${count === 1 ? "line" : "lines"}, ${older.changed} changed before ${older.label}`} ({range})
        </FoldControls>
      </td>
    </tr>
  );
});
