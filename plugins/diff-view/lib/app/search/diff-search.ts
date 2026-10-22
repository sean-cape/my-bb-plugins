import { patchLines, type PatchLine } from "../../patch";
import type { DiffSide } from "../../types";
import type { Cursor } from "../keys/nav";
import { matchOffsets } from "../ui/vim-keys-core";

/** A file as `/` reads it: its patch as drawn (null when nothing is drawn, so it has nothing to find). */
export interface SearchedFile {
  path: string;
  patch: string | null;
}

/**
 * One hit on a patch line. A context line is one patch line carrying both numbers, so it counts once and `n` stops on
 * it once, though a split diff draws it on both sides.
 */
export interface DiffMatch {
  path: string;
  fileIndex: number;
  /** The patch line's place in its file, in display order. */
  row: number;
  left: number | null;
  right: number | null;
  /** Which hit on its line this is; `start` and `end` are offsets into the line's text, without the +/-/space mark. */
  occurrence: number;
  start: number;
  end: number;
}

export interface DiffSearch {
  matches: DiffMatch[];
  /** Where a cursor sits in the order of the matches; a header sits before its file's lines. Null outside the searched files. */
  locate: (cursor: Cursor) => { fileIndex: number; row: number } | null;
}

/** Every hit of `pattern` in the files' patch lines (old and new side), in file order and then display order. */
export function searchDiff(files: readonly SearchedFile[], pattern: RegExp): DiffSearch {
  const matches: DiffMatch[] = [];
  const linesByPath = new Map<string, { fileIndex: number; lines: PatchLine[] }>();
  files.forEach((file, fileIndex) => {
    if (file.patch === null) return;
    const lines = patchLines(file.patch);
    linesByPath.set(file.path, { fileIndex, lines });
    lines.forEach((line, row) => {
      matchOffsets(line.text, pattern).forEach(([start, end], occurrence) => {
        matches.push({ path: file.path, fileIndex, row, left: line.old, right: line.new, occurrence, start, end });
      });
    });
  });
  const locate = (cursor: Cursor) => {
    const file = linesByPath.get(cursor.path);
    if (file === undefined) {
      const fileIndex = files.findIndex((entry) => entry.path === cursor.path);
      return fileIndex === -1 ? null : { fileIndex, row: -0.5 };
    }
    if (cursor.line === null) return { fileIndex: file.fileIndex, row: -0.5 };
    const number = (line: PatchLine) => (cursor.side === "LEFT" ? line.old : line.new);
    const row = file.lines.findIndex((line) => number(line) === cursor.line);
    if (row !== -1) return { fileIndex: file.fileIndex, row };
    // A line the patch leaves out (unfolded context in a structural diff) sits between the patch lines around it.
    let before = -1;
    file.lines.forEach((line, index) => {
      const at = number(line);
      if (at !== null && at < cursor.line!) before = index;
    });
    return { fileIndex: file.fileIndex, row: before + 0.5 };
  };
  return { matches, locate };
}

/** Whether the cursor stands on the match's line. */
export function onMatch(cursor: Cursor, match: DiffMatch): boolean {
  return cursor.path === match.path && cursor.line !== null && (cursor.side === "LEFT" ? match.left : match.right) === cursor.line;
}

/**
 * The match `n` (direction 1) or `N` (-1) reaches from the cursor, `count` matches on, wrapping like vim; null when
 * nothing matches. From the match last reached, while the cursor is still on its line, it steps one hit at a time;
 * otherwise it starts past the cursor's line, or at it when `inclusive` (a search just typed).
 */
export function stepMatch(search: DiffSearch, cursor: Cursor | null, current: number | null, direction: 1 | -1, count: number, inclusive = false): { index: number; wrapped: boolean } | null {
  const total = search.matches.length;
  if (total === 0) return null;
  const wrap = (index: number) => ((index % total) + total) % total;
  const steps = Math.max(1, count);
  if (current !== null && cursor !== null && search.matches[current] !== undefined && onMatch(cursor, search.matches[current]!)) {
    const raw = current + direction * steps;
    return { index: wrap(raw), wrapped: raw < 0 || raw >= total };
  }
  const at = (cursor === null ? null : search.locate(cursor)) ?? { fileIndex: -1, row: 0 };
  const compare = (match: DiffMatch) => match.fileIndex - at.fileIndex || match.row - at.row;
  let first: number;
  let wrapped = false;
  if (direction === 1) {
    first = search.matches.findIndex((match) => (inclusive ? compare(match) >= 0 : compare(match) > 0));
    if (first === -1) {
      first = 0;
      wrapped = true;
    }
  } else {
    first = -1;
    search.matches.forEach((match, index) => {
      if (compare(match) < 0) first = index;
    });
    if (first === -1) {
      first = total - 1;
      wrapped = true;
    }
  }
  const raw = first + direction * (steps - 1);
  return { index: wrap(raw), wrapped: wrapped || raw < 0 || raw >= total };
}

/** The cursor on a match: on the side the reader wants when the line is on both, else on the side it is on. */
export function cursorOnMatch(match: DiffMatch, want: DiffSide): Cursor {
  const side: DiffSide = match.left !== null && match.right !== null ? want : match.left !== null ? "LEFT" : "RIGHT";
  return { path: match.path, side, line: side === "LEFT" ? match.left : match.right, want };
}
