// Hiding whitespace changes from a unified patch, as `git diff -w` would. Pure, for the tests.
import { walkPatch } from "../../patch";
import type { DiffSide } from "../../types";

/** Above this many deleted × added lines in one block, only the block's matching ends pair up. */
const MAX_LCS_CELLS = 4_000_000;

interface Line {
  mark: "-" | "+" | " ";
  text: string;
  /** The `\ No newline at end of file` line after it, if any. */
  noNewline: string | null;
  old: number | null;
  new: number | null;
}

interface Hunk {
  header: string;
  lines: Line[];
  /** Lines after the hunk's counted lines and before the next header, kept as they are. */
  after: string[];
}

function parse(patch: string): { preamble: string[]; hunks: Hunk[] } {
  const preamble: string[] = [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  walkPatch(patch, {
    header: ({ text }) => {
      current = { header: text, lines: [], after: [] };
      hunks.push(current);
    },
    line: ({ mark, text, old, new: added }) => {
      current!.lines.push({ mark, text, noNewline: null, old, new: added });
    },
    other: (text) => {
      if (current === null) {
        preamble.push(text);
        return;
      }
      const last = current.lines.at(-1);
      if (text.startsWith("\\") && last !== undefined && last.noNewline === null && current.after.length === 0) last.noNewline = text;
      else current.after.push(text);
    },
  });
  return { preamble, hunks };
}

/** What a line compares as with whitespace ignored; a missing final newline still counts as a difference. */
function key(line: Line): string {
  return `${line.text.replace(/\s+/gu, "")}${line.noNewline === null ? "" : "\\"}`;
}

/** Index pairs of a longest common subsequence of `a` and `b`, in order. */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    pairs.push([start, start]);
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  const tail: Array<[number, number]> = [];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
    tail.unshift([endA, endB]);
  }
  const rows = endA - start;
  const cols = endB - start;
  if (rows > 0 && cols > 0 && rows * cols <= MAX_LCS_CELLS) {
    // lengths[i][j]: LCS of a[start + i..endA) and b[start + j..endB), flattened.
    const width = cols + 1;
    const lengths = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        lengths[i * width + j] = a[start + i] === b[start + j] ? lengths[(i + 1) * width + j + 1]! + 1 : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i += 1;
        j += 1;
      } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) i += 1;
      else j += 1;
    }
  }
  return [...pairs, ...tail];
}

/** A block's deletions and additions with each pair equal but for whitespace turned into one context line (the new text). */
function settleBlock(deleted: readonly Line[], added: readonly Line[]): Line[] {
  const pairs = lcsPairs(deleted.map(key), added.map(key));
  const out: Line[] = [];
  let d = 0;
  let a = 0;
  for (const [i, j] of pairs) {
    while (d < i) out.push(deleted[d++]!);
    while (a < j) out.push(added[a++]!);
    out.push({ ...added[j]!, mark: " ", old: deleted[i]!.old });
    d += 1;
    a += 1;
  }
  while (d < deleted.length) out.push(deleted[d++]!);
  while (a < added.length) out.push(added[a++]!);
  return out;
}

function settleHunk(lines: readonly Line[]): Line[] {
  const out: Line[] = [];
  for (let index = 0; index < lines.length; ) {
    if (lines[index]!.mark === " ") {
      out.push(lines[index++]!);
      continue;
    }
    const deleted: Line[] = [];
    const added: Line[] = [];
    while (index < lines.length && lines[index]!.mark === "-") deleted.push(lines[index++]!);
    while (index < lines.length && lines[index]!.mark === "+") added.push(lines[index++]!);
    out.push(...(deleted.length > 0 && added.length > 0 ? settleBlock(deleted, added) : [...deleted, ...added]));
  }
  return out;
}

function render(line: Line): string {
  return `${line.mark}${line.text}${line.noNewline === null ? "" : `\n${line.noNewline}`}`;
}

/**
 * The patch with whitespace-only changes shown as unchanged, `git diff -w` style: within each change block (a run of
 * deletions and the additions after it), lines equal once all whitespace is removed are paired by LCS and become one
 * context line showing the new text. A pair takes one line from each side, so every hunk keeps its header and every
 * line keeps its number on both sides. Hunks left with no change are dropped, unless `keep` holds one of their lines
 * (a comment or finding sits there). Null when nothing is left; a patch with no changes to begin with comes back as is.
 */
export function ignoreWhitespacePatch(patch: string, keep?: (side: DiffSide, line: number) => boolean): string | null {
  const { preamble, hunks } = parse(patch);
  if (!hunks.some((hunk) => hunk.lines.some((line) => line.mark !== " "))) return patch;
  const out = [...preamble];
  let kept = 0;
  for (const hunk of hunks) {
    const lines = settleHunk(hunk.lines);
    const changed = lines.some((line) => line.mark !== " ");
    const held = keep !== undefined && lines.some((line) => (line.old !== null && keep("LEFT", line.old)) || (line.new !== null && keep("RIGHT", line.new)));
    if (changed || held) {
      kept += 1;
      out.push(hunk.header, ...lines.map(render));
    }
    out.push(...hunk.after);
  }
  return kept === 0 ? null : out.join("\n");
}

/** Whether a patch has changes and every one of them is whitespace. */
export function onlyWhitespaceChanged(patch: string | null): boolean {
  return patch !== null && ignoreWhitespacePatch(patch) === null;
}

/** Whether a patch adds or deletes any line. */
export function patchHasChanges(patch: string): boolean {
  return parse(patch).hunks.some((hunk) => hunk.lines.some((line) => line.mark !== " "));
}
