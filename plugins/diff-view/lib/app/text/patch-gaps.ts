// The gaps an excerpt cuts between its rows, which `GapBand` draws: where they sit among the cursor's rows, and what
// each press opens. Pure, for the tests.
import type { ExcerptGap, PatchLine } from "../../narrative";
import type { NavRow } from "../keys/nav";

/** Folded runs up to this long expand in one click; longer ones expand this many lines per click. */
export const EXPAND_STEP_LINES = 20;

/** Which of a fold's lines to show: all of them, the first step's (under the code above), or the last step's. */
export type FoldPart = "all" | "first" | "last";

/** What the view lets the reader open of a patch's gaps, and how; `reveal` adds rows to the patch. */
export interface PatchGaps {
  list: readonly ExcerptGap[];
  reveal: (lines: readonly PatchLine[]) => void;
}

/** The hidden row the cursor takes on a gap: the one a press shows first, next to the code it grows from. */
export function gapCursorLine(gap: ExcerptGap): PatchLine | null {
  return (gap.after === null ? gap.hidden.at(-1) : gap.hidden[0]) ?? null;
}

/** A gap's hidden rows split where the line numbers jump, between two of the patch's hunks. */
export function gapRuns(gap: ExcerptGap): PatchLine[][] {
  const runs: PatchLine[][] = [];
  let old: number | null = null;
  let added: number | null = null;
  for (const line of gap.hidden) {
    const jumps = (line.old !== null && old !== null && line.old !== old + 1) || (line.new !== null && added !== null && line.new !== added + 1);
    if (jumps || runs.length === 0) runs.push([]);
    runs.at(-1)!.push(line);
    old = line.old ?? old;
    added = line.new ?? added;
  }
  return runs;
}

/**
 * The rows a press opens: all, or a step's worth under the code above (`first`) or over the code below (`last`), which
 * stops where the patch's hunk does, so a press never spans the unchanged lines between two hunks.
 */
export function gapPart(gap: ExcerptGap, part: FoldPart): PatchLine[] {
  if (part === "all") return gap.hidden;
  const runs = gapRuns(gap);
  return part === "first" ? (runs[0] ?? []).slice(0, EXPAND_STEP_LINES) : (runs.at(-1) ?? []).slice(-EXPAND_STEP_LINES);
}

/**
 * Enter on a gap, like a press of its buttons: a short gap opens whole, a long one a step at a time toward the code it
 * borders (up from the bottom for one at the top). `cursor` is where the cursor goes: onto what remains of the gap
 * while it has more, else the opened row nearest the code.
 */
export function gapEnter(gap: ExcerptGap): { reveal: PatchLine[]; cursor: PatchLine | null } {
  const { hidden } = gap;
  const leading = gap.after === null;
  if (hidden.length <= EXPAND_STEP_LINES) return { reveal: hidden, cursor: (leading ? hidden.at(-1) : hidden[0]) ?? null };
  const reveal = gapPart(gap, leading ? "last" : "first");
  return { reveal, cursor: hidden[leading ? hidden.length - reveal.length - 1 : reveal.length]! };
}

function holds(row: NavRow, line: PatchLine): boolean {
  return (line.old !== null && row.left === line.old) || (line.new !== null && row.right === line.new);
}

/**
 * The cursor's rows with a fold row for each gap that hides patch rows, after the last row showing the line the gap
 * follows (first for one at the top). A fold takes its hidden line's numbers, as the structural view's folds do, and
 * the hunk of the row above it (none at the top), so the hunk after it still starts one. `gapAt` maps a fold row to
 * its gap's index in `gaps`.
 */
export function navWithGaps(rows: readonly NavRow[], gaps: readonly ExcerptGap[]): { rows: NavRow[]; gapAt: Map<number, number> } {
  const after = new Map<number, number>();
  let leading: number | null = null;
  for (const [index, gap] of gaps.entries()) {
    if (gapCursorLine(gap) === null) continue;
    if (gap.after === null) {
      leading = index;
      continue;
    }
    for (let row = rows.length - 1; row >= 0; row--) {
      if (!holds(rows[row]!, gap.after)) continue;
      after.set(row, index);
      break;
    }
  }
  const out: NavRow[] = [];
  const gapAt = new Map<number, number>();
  const fold = (index: number, hunk: number) => {
    const at = gapCursorLine(gaps[index]!)!;
    gapAt.set(out.length, index);
    out.push({ left: at.old, right: at.new, hunk, changed: false, expander: true });
  };
  if (leading !== null) fold(leading, -1);
  rows.forEach((row, index) => {
    out.push(row);
    const gap = after.get(index);
    if (gap !== undefined) fold(gap, row.hunk);
  });
  return { rows: out, gapAt };
}
