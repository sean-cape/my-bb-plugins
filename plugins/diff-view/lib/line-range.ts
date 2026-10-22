import type { DiffSide, LineRange } from "./types";

/** A range that collapses to one line is stored as that line. Throws on a start with no end, or a same-side range that runs backwards. */
export function checkedLineRange({ line, side, startLine, startSide }: { line: number | null; side: DiffSide; startLine?: number | null | undefined; startSide?: DiffSide | null | undefined }): LineRange {
  if (startLine === null || startLine === undefined) return { line, side, startLine: null, startSide: null };
  if (line === null) throw new Error("A multi-line comment needs an end line");
  const from = startSide ?? side;
  if (from === side && startLine === line) return { line, side, startLine: null, startSide: null };
  if (from === side && startLine > line) throw new Error("A multi-line comment's start line must come before its end line");
  return { line, side, startLine, startSide: from };
}

function sidePrefix(side: DiffSide): string {
  return side === "LEFT" ? "old " : "";
}

/** `L12`, `L12–18`, `old L4–6`, or `old L4 – new L6` across sides; null for the whole file. */
export function shortLineLabel(range: LineRange): string | null {
  if (range.line === null) return null;
  if (range.startLine === null || range.startSide === null) return `${sidePrefix(range.side)}L${range.line}`;
  if (range.startSide === range.side) return `${sidePrefix(range.side)}L${range.startLine}–${range.line}`;
  return `${range.startSide === "LEFT" ? "old" : "new"} L${range.startLine} – ${range.side === "LEFT" ? "old" : "new"} L${range.line}`;
}

/** `line 12`, `lines 12–18`, `old lines 4–6`, or `old line 4 to new line 6`; null for the whole file. */
export function longLineLabel(range: LineRange): string | null {
  if (range.line === null) return null;
  if (range.startLine === null || range.startSide === null) return `${sidePrefix(range.side)}line ${range.line}`;
  if (range.startSide === range.side) return `${sidePrefix(range.side)}lines ${range.startLine}–${range.line}`;
  return `${range.startSide === "LEFT" ? "old" : "new"} line ${range.startLine} to ${range.side === "LEFT" ? "old" : "new"} line ${range.line}`;
}

/** Where a comment sits, for messages to agents and review bodies: `a.ts`, `a.ts:12`, `a.ts:12-18`, `a.ts:4 (old side)`, `a.ts (old line 4 to new line 6)`. */
export function locationLabel(path: string, range: LineRange): string {
  if (range.line === null) return path;
  if (range.startLine !== null && range.startSide !== null && range.startSide !== range.side) return `${path} (${longLineLabel(range)})`;
  const span = range.startLine === null ? `${range.line}` : `${range.startLine}-${range.line}`;
  return `${path}:${span}${range.side === "LEFT" ? " (old side)" : ""}`;
}

/** `12`, or `12-18` for lines 12 to 18 of one side. */
export function lineSpan(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

/** `L12` or `L12-18`. */
export function lineSpanLabel(start: number, end: number): string {
  return `L${lineSpan(start, end)}`;
}
