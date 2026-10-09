import type { DiffSide, LineRange } from "../../types";
import { checkedLineRange } from "../../line-range";
import type { NavRow } from "../keys/nav";

interface PatchRow {
  hunk: number;
  left: number | null;
  right: number | null;
}

/** A unified patch's lines in display order; `at` finds a line's row, and a context line is found from either side. */
export interface PatchRows {
  rows: PatchRow[];
  at: Map<string, number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

function rowKey(side: DiffSide, line: number): string {
  return `${side}:${line}`;
}

export function patchRows(patch: string): PatchRows {
  const rows: PatchRow[] = [];
  const at = new Map<string, number>();
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of patch.split("\n")) {
    const header = HUNK_HEADER.exec(text);
    if (header !== null) {
      hunk += 1;
      oldLine = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    const mark = text[0];
    let row: PatchRow;
    if (mark === "-") {
      row = { hunk, left: oldLine++, right: null };
      oldLeft -= 1;
    } else if (mark === "+") {
      row = { hunk, left: null, right: newLine++ };
      newLeft -= 1;
    } else if (mark === " " || text === "") {
      // Some tools strip the space off blank context lines.
      row = { hunk, left: oldLine++, right: newLine++ };
      oldLeft -= 1;
      newLeft -= 1;
    } else {
      continue;
    }
    if (row.left !== null) at.set(rowKey("LEFT", row.left), rows.length);
    if (row.right !== null) at.set(rowKey("RIGHT", row.right), rows.length);
    rows.push(row);
  }
  return { rows, at };
}

type Point = { line: number; side: DiffSide };

/**
 * A selection as a comment range: in display order (selections run from where the drag started, so may point up),
 * and cut to the hunk it ends in, since GitHub rejects multi-line comments that span hunks.
 */
export function selectionRange(patch: PatchRows, anchor: Point, current: Point): LineRange {
  let start = anchor;
  let end = current;
  let startRow = patch.at.get(rowKey(start.side, start.line));
  let endRow = patch.at.get(rowKey(end.side, end.line));
  if (startRow === undefined || endRow === undefined) {
    if (start.side === end.side && start.line > end.line) [start, end] = [end, start];
    return checkedLineRange({ line: end.line, side: end.side, startLine: start.line, startSide: start.side });
  }
  if (startRow > endRow) {
    [start, end] = [end, start];
    [startRow, endRow] = [endRow, startRow];
  }
  if (startRow === endRow) return checkedLineRange({ line: end.line, side: end.side });
  const { hunk } = patch.rows[endRow]!;
  if (patch.rows[startRow]!.hunk !== hunk) {
    let first = endRow;
    while (first > 0 && patch.rows[first - 1]!.hunk === hunk) first -= 1;
    const row = patch.rows[first]!;
    start = row.right !== null && (end.side === "RIGHT" || row.left === null) ? { line: row.right, side: "RIGHT" } : { line: row.left!, side: "LEFT" };
  }
  return checkedLineRange({ line: end.line, side: end.side, startLine: start.line, startSide: start.side });
}

/**
 * The patch's rows as the keyboard steps through them: one per displayed line in unified layout; in split layout a
 * run of deletions and the additions after it share rows pairwise, as they sit side by side.
 */
export function navRows(patch: PatchRows, layout: "unified" | "split"): NavRow[] {
  const rows: NavRow[] = [];
  const { rows: lines } = patch;
  for (let index = 0; index < lines.length; ) {
    const row = lines[index]!;
    if (layout === "unified" || row.left === null || row.right !== null) {
      rows.push({ left: row.left, right: row.right, hunk: row.hunk, changed: row.left === null || row.right === null });
      index += 1;
      continue;
    }
    const deletions: number[] = [];
    while (index < lines.length && lines[index]!.right === null && lines[index]!.hunk === row.hunk) deletions.push(lines[index++]!.left!);
    const additions: number[] = [];
    while (index < lines.length && lines[index]!.left === null && lines[index]!.hunk === row.hunk) additions.push(lines[index++]!.right!);
    for (let pair = 0; pair < Math.max(deletions.length, additions.length); pair++) {
      rows.push({ left: deletions[pair] ?? null, right: additions[pair] ?? null, hunk: row.hunk, changed: true });
    }
  }
  return rows;
}
