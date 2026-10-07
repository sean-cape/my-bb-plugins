export const MapMode = {
  Simple: 0,
  TrackDel: 1,
  TrackBefore: 2,
  TrackAfter: 3,
} as const;
export type MapMode = (typeof MapMode)[keyof typeof MapMode];

/** A single replacement of `[from, to)` in the old text with `insert`. */
export class Change {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly insert: string,
  ) {}

  /** Mirrors CodeMirror 6 `ChangeDesc.mapPos` for a single-section change. */
  mapPos(pos: number, assoc = -1, mode: MapMode = MapMode.Simple): number | null {
    const { from, to } = this;
    const inserted = this.insert.length;
    if (pos < from) return pos;
    if (pos > to || (pos === to && to > from)) {
      if (mode === MapMode.TrackBefore && pos === to && from < pos) return null;
      return pos + inserted - (to - from);
    }
    if (from === to) return assoc < 0 ? from : from + inserted;
    if (
      (mode === MapMode.TrackDel && from < pos) ||
      (mode === MapMode.TrackBefore && from < pos) ||
      mode === MapMode.TrackAfter
    ) {
      return null;
    }
    return pos === from || assoc < 0 ? from : from + inserted;
  }

  iterChanges(
    fn: (fromA: number, toA: number, fromB: number, toB: number, text: string[]) => void,
  ): void {
    fn(this.from, this.to, this.from, this.from + this.insert.length, this.insert.split("\n"));
  }

  apply(text: string): string {
    return text.slice(0, this.from) + this.insert + text.slice(this.to);
  }
}

/**
 * The smallest single change turning `before` into `after`. `cursorAfter`
 * resolves ambiguity for repeated characters (typing "a" before "a") so the
 * reported change ends where the caret landed.
 */
export function diffText(before: string, after: string, cursorAfter?: number): Change | null {
  if (before === after) return null;
  let limit = Math.min(before.length, after.length);
  if (cursorAfter !== undefined) {
    limit = Math.min(limit, Math.max(0, cursorAfter - Math.max(0, after.length - before.length)));
  }
  let start = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--;
    endAfter--;
  }
  return new Change(start, endBefore, after.slice(start, endAfter));
}

export interface Line {
  /** Offset of the first character. */
  from: number;
  /** Offset just past the last character, excluding the newline. */
  to: number;
  text: string;
}

/** Plain text split into `\n`-separated lines with offset lookup. */
export class TextDoc {
  readonly lineStarts: number[];

  constructor(readonly text: string) {
    const starts = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  get length(): number {
    return this.text.length;
  }

  get lines(): number {
    return this.lineStarts.length;
  }

  /** Zero-based line access. */
  line(index: number): Line {
    const from = this.lineStarts[index]!;
    const next = this.lineStarts[index + 1];
    const to = next === undefined ? this.text.length : next - 1;
    return { from, to, text: this.text.slice(from, to) };
  }

  /** Zero-based index of the line containing `offset`. */
  lineIndexAt(offset: number): number {
    const starts = this.lineStarts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  }
}
