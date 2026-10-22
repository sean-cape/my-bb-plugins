import type { StructuralRow } from "./rows";

/**
 * Aligned rows as the unified layout draws them, GitHub-style: an unchanged row once, with both line numbers; in each
 * run of changed rows, every old line first, then every new line, so a modified pair reads as a deletion and an
 * addition. Each row keeps the aligned row's `index`, which folds, reveals and moved blocks are counted in.
 */
export function unifiedRows(rows: readonly StructuralRow[]): StructuralRow[] {
  const out: StructuralRow[] = [];
  let block: StructuralRow[] = [];
  const flush = () => {
    for (const row of block) if (row.lhs !== null) out.push({ index: row.index, lhs: row.lhs, rhs: null, changed: true });
    for (const row of block) if (row.rhs !== null) out.push({ index: row.index, lhs: null, rhs: row.rhs, changed: true });
    block = [];
  };
  for (const row of rows) {
    if (row.changed) {
      block.push(row);
      continue;
    }
    flush();
    out.push(row);
  }
  flush();
  return out;
}

/** Which half of a modified pair a unified row draws, the side it has a line on; null for a row drawn whole. */
export function unifiedHalf(row: Pick<StructuralRow, "lhs" | "rhs">, unified: boolean): "LEFT" | "RIGHT" | null {
  if (!unified || (row.lhs !== null && row.rhs !== null)) return null;
  return row.rhs === null ? "LEFT" : "RIGHT";
}

/**
 * One entry of the table, in display order: a drawn row, or a fold of hidden aligned rows `from` up to `to`. A hunk's
 * first row carries the hunk's lowest aligned index (`hunkStart`), which its `@@` header is computed from: in unified
 * layout that row may be a later aligned row's old half.
 */
export type TableEntry = { kind: "row"; row: StructuralRow; hunk: number; hunkStart: number | null } | { kind: "gap"; from: number; to: number; hunk: number };

/**
 * The table's rows and folds, from the rows in display order: the aligned rows in split, `unifiedRows` of them in
 * unified. Taking the drawn rows rather than reordering per hunk keeps each row the same object across reveals, so
 * memoised rows stay put; it holds because folds only hide unchanged rows, which no change block straddles.
 */
export function tableEntries(drawn: readonly StructuralRow[], visible: ReadonlySet<number>): TableEntry[] {
  const entries: TableEntry[] = [];
  let hunk = -1;
  let gapFrom: number | null = null;
  let gapTo = 0;
  let first: (TableEntry & { kind: "row" }) | null = null;
  for (const row of drawn) {
    if (!visible.has(row.index)) {
      first = null;
      gapFrom ??= row.index;
      gapTo = row.index + 1;
      continue;
    }
    if (gapFrom !== null) {
      entries.push({ kind: "gap", from: gapFrom, to: gapTo, hunk });
      gapFrom = null;
    }
    if (first === null) {
      hunk += 1;
      first = { kind: "row", row, hunk, hunkStart: row.index };
      entries.push(first);
      continue;
    }
    first.hunkStart = Math.min(first.hunkStart!, row.index);
    entries.push({ kind: "row", row, hunk, hunkStart: null });
  }
  if (gapFrom !== null) entries.push({ kind: "gap", from: gapFrom, to: gapTo, hunk });
  return entries;
}
