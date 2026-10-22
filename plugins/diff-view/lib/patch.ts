// Walking a unified patch's lines with their numbers. Pure, shared by the view and every host's server.

export const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

export interface HunkHeader {
  text: string;
  /** The hunk's place in the patch, from 0. */
  hunk: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** One counted line of a hunk: deleted, added, or context (on both sides). `text` is without its mark. */
export interface PatchLine {
  mark: "-" | "+" | " ";
  text: string;
  old: number | null;
  new: number | null;
  hunk: number;
}

export interface PatchVisitor {
  header?: (header: HunkHeader) => void;
  line: (line: PatchLine) => void;
  /**
   * A line that is not one of a hunk's counted lines: what comes before the first header (`hunk` is -1), a
   * `\ No newline at end of file` marker, or whatever follows a hunk's counts before the next header.
   */
  other?: (text: string, hunk: number) => void;
}

/** Calls the visitor for each of the patch's lines in order; a hunk's lines end where its header's counts say. */
export function walkPatch(patch: string, visitor: PatchVisitor): void {
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
      visitor.header?.({ text, hunk, oldStart: oldLine, oldCount: oldLeft, newStart: newLine, newCount: newLeft });
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      visitor.other?.(text, hunk);
      continue;
    }
    const mark = text[0];
    if (mark === "-") {
      visitor.line({ mark, text: text.slice(1), old: oldLine++, new: null, hunk });
      oldLeft -= 1;
    } else if (mark === "+") {
      visitor.line({ mark, text: text.slice(1), old: null, new: newLine++, hunk });
      newLeft -= 1;
    } else if (mark === " " || text === "") {
      // Some tools strip the space off blank context lines.
      visitor.line({ mark: " ", text: text.slice(1), old: oldLine++, new: newLine++, hunk });
      oldLeft -= 1;
      newLeft -= 1;
    } else {
      visitor.other?.(text, hunk);
    }
  }
}

/** The patch's counted lines in order. */
export function patchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  walkPatch(patch, { line: (line) => lines.push(line) });
  return lines;
}
