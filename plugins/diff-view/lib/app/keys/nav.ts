import type { DiffSide, LineRange } from "../../types";
import { checkedLineRange } from "../../line-range";

/** One display row of a file's diff: the old and new line it shows (null for a blank side) and the hunk it sits in. */
export interface NavRow {
  left: number | null;
  right: number | null;
  hunk: number;
  changed: boolean;
}

/**
 * Where the keyboard cursor is: a line on one side of a file, or the file's header (`line` null), which is where
 * file-level comments live. `want` is the side the reader last chose, so stepping across a one-sided row and back
 * returns to it, like vim's remembered column.
 */
export interface Cursor {
  path: string;
  side: DiffSide;
  line: number | null;
  want: DiffSide;
}

/** A file as the cursor sees it: its rows once its diff has rendered, `null` while it is still loading or unmounted. */
export interface NavFile {
  path: string;
  collapsed: boolean;
  rows: readonly NavRow[] | null;
}

export interface NavPosition {
  fileIndex: number;
  /** -1 for the file header. */
  row: number;
}

export function lineOn(row: NavRow, side: DiffSide): number | null {
  return side === "LEFT" ? row.left : row.right;
}

function sideFor(row: NavRow, want: DiffSide): DiffSide {
  if (lineOn(row, want) !== null) return want;
  return want === "LEFT" ? "RIGHT" : "LEFT";
}

export function rowIndexOf(rows: readonly NavRow[], side: DiffSide, line: number): number {
  return rows.findIndex((row) => lineOn(row, side) === line);
}

/** The cursor's row in its file: -1 on the header, or when its line is no longer shown. */
export function cursorPosition(files: readonly NavFile[], cursor: Cursor): NavPosition | null {
  const fileIndex = files.findIndex((file) => file.path === cursor.path);
  if (fileIndex === -1) return null;
  const rows = visibleRows(files[fileIndex]!);
  if (cursor.line === null || rows.length === 0) return { fileIndex, row: -1 };
  const row = rowIndexOf(rows, cursor.side, cursor.line);
  if (row !== -1) return { fileIndex, row };
  // A fold or a refresh hid the line: land on the nearest row before it on the same side.
  let nearest = -1;
  rows.forEach((candidate, index) => {
    const line = lineOn(candidate, cursor.side);
    if (line !== null && line < cursor.line!) nearest = index;
  });
  return { fileIndex, row: nearest };
}

function visibleRows(file: NavFile): readonly NavRow[] {
  return file.collapsed ? [] : (file.rows ?? []);
}

export function cursorAt(files: readonly NavFile[], position: NavPosition, want: DiffSide): Cursor {
  const file = files[position.fileIndex]!;
  const row = position.row === -1 ? undefined : visibleRows(file)[position.row];
  if (row === undefined) return { path: file.path, side: want, line: null, want };
  const side = sideFor(row, want);
  return { path: file.path, side, line: lineOn(row, side), want };
}

function compare(a: NavPosition, b: NavPosition): number {
  return a.fileIndex === b.fileIndex ? a.row - b.row : a.fileIndex - b.fileIndex;
}

/**
 * Every position in reading order. A file still loading contributes only its header and ends the list there when
 * `stopAtPending`, so holding `j` waits at a file's header for its lines instead of skipping past it.
 */
function positions(files: readonly NavFile[], from: number, stopAtPending: boolean): NavPosition[] {
  const list: NavPosition[] = [];
  for (let fileIndex = from; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex]!;
    list.push({ fileIndex, row: -1 });
    if (!file.collapsed && file.rows === null && stopAtPending) break;
    visibleRows(file).forEach((_, row) => list.push({ fileIndex, row }));
  }
  return list;
}

/** `count` rows down (or up, when negative), through file headers, stopping at the ends. */
export function moveLines(files: readonly NavFile[], cursor: Cursor, count: number): Cursor {
  const here = cursorPosition(files, cursor);
  if (here === null) return cursor;
  if (count > 0) {
    const ahead = positions(files, here.fileIndex, true).filter((position) => compare(position, here) > 0);
    const target = ahead[Math.min(count, ahead.length) - 1];
    return target === undefined ? cursor : cursorAt(files, target, cursor.want);
  }
  const behind = positions(files, 0, false).filter((position) => compare(position, here) < 0);
  const target = behind[Math.max(0, behind.length + count)];
  return target === undefined ? cursor : cursorAt(files, target, cursor.want);
}

export function firstPosition(files: readonly NavFile[], want: DiffSide): Cursor | null {
  return files.length === 0 ? null : cursorAt(files, { fileIndex: 0, row: -1 }, want);
}

export function lastPosition(files: readonly NavFile[], want: DiffSide): Cursor | null {
  const all = positions(files, 0, false);
  const last = all.at(-1);
  return last === undefined ? null : cursorAt(files, last, want);
}

/** The next (or previous) position after the cursor that `matches`, `count` times over; the cursor when there is none. */
function seek(files: readonly NavFile[], cursor: Cursor, direction: 1 | -1, count: number, matches: (position: NavPosition) => boolean): Cursor {
  const here = cursorPosition(files, cursor);
  if (here === null) return cursor;
  const all = positions(files, 0, false).filter(matches);
  const candidates = direction === 1 ? all.filter((position) => compare(position, here) > 0) : all.filter((position) => compare(position, here) < 0).reverse();
  const target = candidates[Math.min(count, candidates.length) - 1];
  return target === undefined ? cursor : cursorAt(files, target, cursor.want);
}

/** File headers: `]f` / `[f`. Going back from inside a file stops at its own header first. */
export function moveFile(files: readonly NavFile[], cursor: Cursor, direction: 1 | -1, count: number): Cursor {
  return seek(files, cursor, direction, count, (position) => position.row === -1);
}

/** Starts of a run of changed rows: `]c` / `[c`, as in vimdiff. */
export function moveChange(files: readonly NavFile[], cursor: Cursor, direction: 1 | -1, count: number): Cursor {
  return seek(files, cursor, direction, count, ({ fileIndex, row }) => {
    if (row === -1) return false;
    const rows = visibleRows(files[fileIndex]!);
    return rows[row]!.changed && (row === 0 || !rows[row - 1]!.changed || rows[row - 1]!.hunk !== rows[row]!.hunk);
  });
}

/** First rows of hunks: `}` / `{`. */
export function moveHunk(files: readonly NavFile[], cursor: Cursor, direction: 1 | -1, count: number): Cursor {
  return seek(files, cursor, direction, count, ({ fileIndex, row }) => {
    if (row === -1) return false;
    const rows = visibleRows(files[fileIndex]!);
    return row === 0 || rows[row - 1]!.hunk !== rows[row]!.hunk;
  });
}

/** Something anchored in the diff: a comment thread or a finding, on a line or (a null line) the whole file. */
export interface NavAnchor {
  id: string;
  path: string;
  side: DiffSide;
  line: number | null;
}

/** Where an anchor sits in reading order; a line the file does not show (yet) counts as its header. */
export function anchorPosition(files: readonly NavFile[], anchor: NavAnchor): NavPosition | null {
  const fileIndex = files.findIndex((file) => file.path === anchor.path);
  if (fileIndex === -1) return null;
  if (anchor.line === null) return { fileIndex, row: -1 };
  return { fileIndex, row: rowIndexOf(visibleRows(files[fileIndex]!), anchor.side, anchor.line) };
}

/**
 * The next (or previous) anchor past the cursor, `count` times over. `from` names the anchor the reader is on, so
 * several on one line are stepped through one at a time.
 */
export function nextAnchor<T extends NavAnchor>(files: readonly NavFile[], cursor: Cursor, anchors: readonly T[], direction: 1 | -1, count: number, from: string | null = null): T | null {
  const here = cursorPosition(files, cursor);
  if (here === null) return null;
  const placed = anchors
    .map((anchor) => ({ anchor, position: anchorPosition(files, anchor) }))
    .filter((entry): entry is { anchor: T; position: NavPosition } => entry.position !== null)
    .sort((a, b) => compare(a.position, b.position));
  const at = from === null ? -1 : placed.findIndex((entry) => entry.anchor.id === from && compare(entry.position, here) === 0);
  const candidates =
    at !== -1
      ? direction === 1
        ? placed.slice(at + 1)
        : placed.slice(0, at).reverse()
      : direction === 1
        ? placed.filter((entry) => compare(entry.position, here) > 0)
        : placed.filter((entry) => compare(entry.position, here) < 0).reverse();
  return candidates[Math.min(count, candidates.length) - 1]?.anchor ?? null;
}

/** The cursor on an anchor's line: its side, or its file's header. */
export function cursorOnAnchor(files: readonly NavFile[], anchor: NavAnchor, want: DiffSide): Cursor {
  const position = anchorPosition(files, anchor);
  if (position === null || anchor.line === null || position.row === -1) return { path: anchor.path, side: want, line: null, want };
  return { path: anchor.path, side: anchor.side, line: anchor.line, want };
}

/** Anchors on the cursor's row (the same displayed line, whichever side's number they use), or on the file when it is on the header. */
export function anchorsAtCursor<T extends NavAnchor>(files: readonly NavFile[], cursor: Cursor, anchors: readonly T[]): T[] {
  const here = cursorPosition(files, cursor);
  if (here === null) return [];
  return anchors.filter((anchor) => {
    if (anchor.path !== cursor.path) return false;
    const position = anchorPosition(files, anchor);
    return position !== null && (cursor.line === null ? anchor.line === null : position.row === here.row && anchor.line !== null);
  });
}

/**
 * The comment range between the visual anchor and the cursor, in display order, each end on the side its row is
 * numbered by. With `cutToHunk` (patches GitHub will receive) it is cut to the hunk the range ends in, since GitHub
 * rejects multi-line comments that span hunks. Null on a header.
 */
export function visualRange(rows: readonly NavRow[], anchor: Cursor, cursor: Cursor, cutToHunk: boolean): LineRange | null {
  if (anchor.line === null || cursor.line === null) return null;
  let start = rowIndexOf(rows, anchor.side, anchor.line);
  let end = rowIndexOf(rows, cursor.side, cursor.line);
  if (start === -1 || end === -1) return null;
  let startSide = anchor.side;
  let endSide = cursor.side;
  if (start > end) {
    [start, end] = [end, start];
    [startSide, endSide] = [endSide, startSide];
  }
  if (cutToHunk) {
    while (start < end && rows[start]!.hunk !== rows[end]!.hunk) {
      start += 1;
      startSide = sideFor(rows[start]!, endSide);
    }
  }
  return checkedLineRange({ line: lineOn(rows[end]!, endSide)!, side: endSide, startLine: start === end ? null : lineOn(rows[start]!, startSide)!, startSide });
}

/** The rows of the hunk holding `row`, as a span on the side it is numbered by: new, unless it only deletes. */
export function hunkSpanAt(rows: readonly NavRow[], row: number): { side: "old" | "new"; start: number; stop: number } | null {
  const hunk = rows[row]?.hunk;
  if (hunk === undefined) return null;
  const members = rows.filter((entry) => entry.hunk === hunk);
  const news = members.map((entry) => entry.right).filter((line): line is number => line !== null);
  const olds = members.map((entry) => entry.left).filter((line): line is number => line !== null);
  const side = news.length > 0 ? "new" : "old";
  const lines = side === "new" ? news : olds;
  return { side, start: Math.min(...lines), stop: Math.max(...lines) };
}
