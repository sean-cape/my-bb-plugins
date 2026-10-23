// Line bookkeeping for narrative reviews, shared by the server (checking an agent's coverage) and the view (cutting
// each step's excerpts out of the file patches). Pure functions over unified patches; no React, no node.

/** Lines of one file a narrative step points at. A null `startLine` is the whole file. */
export interface NarrativeRef {
  path: string;
  side: "old" | "new";
  startLine: number | null;
  endLine: number | null;
}

/** The patch a narrative covers for one file; null for a binary or oversized file. */
export interface NarrativePatchFile {
  path: string;
  previousPath: string | null;
  patch: string | null;
}

/** Changed lines no step covers: whole-file when the file has no patch, else the line ranges per side. */
export interface UncoveredFile {
  path: string;
  wholeFile: boolean;
  old: Array<[number, number]>;
  new: Array<[number, number]>;
}

export interface NarrativeCoverage {
  uncovered: UncoveredFile[];
  /** Refs naming a path that is not in the diff. */
  unknownPaths: string[];
  changedLines: number;
  coveredLines: number;
}

interface Row {
  kind: "context" | "add" | "del";
  old: number | null;
  new: number | null;
  text: string;
}

interface Hunk {
  rows: Row[];
  /** The line before the hunk's first line on each side, which a side with no rows of its own starts after. */
  oldBase: number;
  newBase: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of patch.split("\n")) {
    const header = HUNK_HEADER.exec(text);
    if (header !== null) {
      oldLine = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      // An empty side's start is the line it follows; a non-empty side's is its first line.
      current = { rows: [], oldBase: oldLeft === 0 ? oldLine : oldLine - 1, newBase: newLeft === 0 ? newLine : newLine - 1 };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    // Belongs to the row before it, so it goes wherever that row goes.
    if (text.startsWith("\\")) {
      const last = current.rows.at(-1);
      if (last !== undefined) last.text += `\n${text}`;
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    const mark = text[0];
    if (mark === "-") {
      current.rows.push({ kind: "del", old: oldLine++, new: null, text });
      oldLeft -= 1;
    } else if (mark === "+") {
      current.rows.push({ kind: "add", old: null, new: newLine++, text });
      newLeft -= 1;
    } else if (mark === " " || text === "") {
      current.rows.push({ kind: "context", old: oldLine++, new: newLine++, text: text === "" ? " " : text });
      oldLeft -= 1;
      newLeft -= 1;
    }
  }
  return hunks;
}

/** Runs of consecutive numbers as `[start, end]` pairs. */
export function compressLines(lines: Iterable<number>): Array<[number, number]> {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const line of sorted) {
    const last = ranges.at(-1);
    if (last !== undefined && line === last[1] + 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

/** Deleted lines by old-side number and added lines by new-side number. */
export function changedLines(patch: string): { old: number[]; new: number[] } {
  const old: number[] = [];
  const added: number[] = [];
  for (const hunk of parseHunks(patch)) {
    for (const row of hunk.rows) {
      if (row.kind === "del") old.push(row.old!);
      else if (row.kind === "add") added.push(row.new!);
    }
  }
  return { old, new: added };
}

/** A ref names a file by its path, or by its old name unless another file in the diff now has that name. */
export function fileForRef(files: readonly NarrativePatchFile[], path: string): NarrativePatchFile | null {
  return files.find((file) => file.path === path) ?? files.find((file) => file.previousPath === path) ?? null;
}

function inRef(ref: NarrativeRef, line: number): boolean {
  if (ref.startLine === null) return true;
  const end = ref.endLine ?? ref.startLine;
  return line >= Math.min(ref.startLine, end) && line <= Math.max(ref.startLine, end);
}

/** Which changed lines of `files` no ref covers. A whole-file ref covers both sides of its file. */
export function narrativeCoverage(files: readonly NarrativePatchFile[], refs: readonly NarrativeRef[]): NarrativeCoverage {
  const uncovered: UncoveredFile[] = [];
  let changed = 0;
  let covered = 0;
  for (const file of files) {
    const mine = refs.filter((ref) => fileForRef(files, ref.path) === file);
    if (file.patch === null) {
      changed += 1;
      if (mine.length > 0) covered += 1;
      else uncovered.push({ path: file.path, wholeFile: true, old: [], new: [] });
      continue;
    }
    const lines = changedLines(file.patch);
    const missOld = lines.old.filter((line) => !mine.some((ref) => (ref.startLine === null || ref.side === "old") && inRef(ref, line)));
    const missNew = lines.new.filter((line) => !mine.some((ref) => (ref.startLine === null || ref.side === "new") && inRef(ref, line)));
    changed += lines.old.length + lines.new.length;
    covered += lines.old.length + lines.new.length - missOld.length - missNew.length;
    if (missOld.length > 0 || missNew.length > 0) uncovered.push({ path: file.path, wholeFile: false, old: compressLines(missOld), new: compressLines(missNew) });
  }
  const known = new Set(files.flatMap((file) => (file.previousPath === null ? [file.path] : [file.path, file.previousPath])));
  const unknownPaths = [...new Set(refs.map((ref) => ref.path).filter((path) => !known.has(path)))];
  return { uncovered, unknownPaths, changedLines: changed, coveredLines: covered };
}

/** The patch rows on the given old-side and new-side ranges, as `-12 text` / `+40 text`, for telling an agent what it missed. */
export function uncoveredText(patch: string, old: ReadonlyArray<[number, number]>, added: ReadonlyArray<[number, number]>, limit = 40): string[] {
  const within = (ranges: ReadonlyArray<[number, number]>, line: number | null) => line !== null && ranges.some(([start, end]) => line >= start && line <= end);
  const out: string[] = [];
  for (const hunk of parseHunks(patch)) {
    for (const row of hunk.rows) {
      const text = row.text.split("\n")[0]!.slice(1);
      if (row.kind === "del" && within(old, row.old)) out.push(`-${row.old} ${text}`);
      else if (row.kind === "add" && within(added, row.new)) out.push(`+${row.new} ${text}`);
    }
  }
  return out.length > limit ? [...out.slice(0, limit), `… ${out.length - limit} more`] : out;
}

/** Refs that would show every line `uncovered` lists, for the view's catch-all step. */
export function refsForUncovered(uncovered: readonly UncoveredFile[]): NarrativeRef[] {
  return uncovered.flatMap((file): NarrativeRef[] =>
    file.wholeFile
      ? [{ path: file.path, side: "new", startLine: null, endLine: null }]
      : [
          ...file.old.map(([start, end]): NarrativeRef => ({ path: file.path, side: "old", startLine: start, endLine: end })),
          ...file.new.map(([start, end]): NarrativeRef => ({ path: file.path, side: "new", startLine: start, endLine: end })),
        ],
  );
}

/** `old L4–6`, `L12`, or `whole file`. */
export function refLabel(ref: NarrativeRef): string {
  if (ref.startLine === null) return "whole file";
  const end = ref.endLine ?? ref.startLine;
  const prefix = ref.side === "old" ? "old " : "";
  return end === ref.startLine ? `${prefix}L${ref.startLine}` : `${prefix}L${Math.min(ref.startLine, end)}–${Math.max(ref.startLine, end)}`;
}

/** One row of a patch by its old and new line (one of them null on a change). */
export interface PatchLine {
  old: number | null;
  new: number | null;
}

/** The key a revealed row is held under. */
export function patchLineKey(line: PatchLine): string {
  return `${line.old ?? ""}:${line.new ?? ""}`;
}

/**
 * Lines of the file's patch an excerpt leaves out, between two rows it shows (or before the first, or after the last).
 * `hidden` are patch rows the reader can reveal, which may be other steps' changes; `unchanged` counts the lines between
 * the patch's hunks inside the gap, which no patch holds.
 */
export interface ExcerptGap {
  /** The shown row the gap follows; null before the excerpt's first row. */
  after: PatchLine | null;
  /** The shown row after the gap; null after the last. */
  before: PatchLine | null;
  hidden: PatchLine[];
  unchanged: number;
}

/**
 * The part of a file's patch that `refs` point at, as a patch of its own: every row on a referenced line, plus up to
 * `context` unchanged rows around each run, with hunk headers recounted, and every row in `revealed` (by
 * `patchLineKey`). Null when nothing is kept. A whole-file ref keeps the patch itself. A ref to an unchanged line
 * inside a hunk keeps that line, so a step can point at context it talks about.
 */
export function excerptCut(patch: string, refs: readonly NarrativeRef[], { context = 3, revealed = new Set() }: { context?: number; revealed?: ReadonlySet<string> } = {}): { patch: string | null; gaps: ExcerptGap[] } {
  if (refs.length === 0) return { patch: null, gaps: [] };
  const whole = refs.some((ref) => ref.startLine === null);
  const hunks = parseHunks(patch);
  const out: string[] = [];
  const gaps: ExcerptGap[] = [];
  let shown: PatchLine | null = null;
  let gap: { hidden: PatchLine[]; unchanged: number } = { hidden: [], unchanged: 0 };
  let previousEnd: number | null = null;
  for (const hunk of hunks) {
    if (previousEnd !== null && shown !== null) gap.unchanged += hunk.oldBase - previousEnd;
    previousEnd = hunk.oldBase + hunk.rows.filter((row) => row.kind !== "add").length;
    const hit = hunk.rows.map(
      (row) =>
        whole ||
        revealed.has(patchLineKey(row)) ||
        refs.some((ref) => {
          const line = ref.side === "old" ? row.old : row.new;
          return line !== null && inRef(ref, line);
        }),
    );
    // Unreferenced changes nearby are left out, splitting the excerpt, so a step never shows a line it does not cover.
    const keep = hit.map((value, index) => {
      if (value) return true;
      if (context === 0) return false;
      for (let distance = 1; distance <= context; distance++) {
        if (hit[index - distance] === true || hit[index + distance] === true) return hunk.rows[index]!.kind === "context";
      }
      return false;
    });
    let index = 0;
    while (index < hunk.rows.length) {
      if (!keep[index]) {
        const row = hunk.rows[index]!;
        gap.hidden.push({ old: row.old, new: row.new });
        index += 1;
        continue;
      }
      const start = index;
      while (index < hunk.rows.length && keep[index]) index += 1;
      const rows = hunk.rows.slice(start, index);
      const first = { old: rows[0]!.old, new: rows[0]!.new };
      if (gap.hidden.length > 0 || (shown !== null && gap.unchanged > 0)) gaps.push({ after: shown, before: first, ...gap });
      gap = { hidden: [], unchanged: 0 };
      shown = { old: rows.at(-1)!.old, new: rows.at(-1)!.new };
      const firstOld = rows.find((row) => row.old !== null)?.old ?? lastBefore(hunk.rows, start, "old", hunk.oldBase) + 1;
      const firstNew = rows.find((row) => row.new !== null)?.new ?? lastBefore(hunk.rows, start, "new", hunk.newBase) + 1;
      const oldCount = rows.filter((row) => row.kind !== "add").length;
      const newCount = rows.filter((row) => row.kind !== "del").length;
      out.push(`@@ -${oldCount === 0 ? firstOld - 1 : firstOld},${oldCount} +${newCount === 0 ? firstNew - 1 : firstNew},${newCount} @@`);
      for (const row of rows) out.push(row.text);
    }
  }
  if (out.length === 0) return { patch: null, gaps: [] };
  if (gap.hidden.length > 0) gaps.push({ after: shown, before: null, hidden: gap.hidden, unchanged: 0 });
  return { patch: whole ? patch : out.join("\n"), gaps };
}

export function excerptPatch(patch: string, refs: readonly NarrativeRef[], context = 3): string | null {
  return excerptCut(patch, refs, { context }).patch;
}

function lastBefore(rows: readonly Row[], index: number, side: "old" | "new", base: number): number {
  for (let at = index - 1; at >= 0; at--) {
    const line = rows[at]![side];
    if (line !== null) return line;
  }
  return base;
}
