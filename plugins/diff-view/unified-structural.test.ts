import { afterEach, describe, expect, it, vi } from "vitest";
import type { StructuralDiff } from "./lib/types";
import { detectMoves } from "./lib/app/structural/moves";
import { structuralRows, visibleRows, type StructuralRow } from "./lib/app/structural/rows";
import { tableEntries, unifiedRows } from "./lib/app/structural/unified-rows";
import { structural } from "./test-helpers";

/** Each row as `index:lhs/rhs`, `-` for a blank side. */
const shape = (rows: readonly StructuralRow[]) => rows.map((row) => `${row.index}:${row.lhs ?? "-"}/${row.rhs ?? "-"}`);

describe("unifiedRows", () => {
  it("keeps a pure insertion and a pure deletion in place", () => {
    expect(shape(unifiedRows(structuralRows(structural([[1, 1], [null, 2], [null, 3], [2, 4]]))))).toEqual(["0:1/1", "1:-/2", "2:-/3", "3:2/4"]);
    expect(shape(unifiedRows(structuralRows(structural([[1, 1], [2, null], [3, 2]]))))).toEqual(["0:1/1", "1:2/-", "2:3/2"]);
  });

  it("draws a modified pair as a deletion then an addition, each block's old lines first", () => {
    const rows = structuralRows(structural([[1, 1], [2, 2], [3, 3], [4, 4]], [2, 3], [2, 3]));
    const unified = unifiedRows(rows);
    expect(shape(unified)).toEqual(["0:1/1", "1:2/-", "2:3/-", "1:-/2", "2:-/3", "3:4/4"]);
    expect(unified.map((row) => row.changed)).toEqual([false, true, true, true, true, false]);
  });

  it("puts a block's deletions before an addition that comes first in the alignment", () => {
    const rows = structuralRows(structural([[null, 1], [1, 2], [2, 3]], [2], [1]));
    expect(shape(unifiedRows(rows))).toEqual(["1:1/-", "0:-/1", "1:-/2", "2:2/3"]);
  });

  it("shows every old and new line exactly once", () => {
    const rows = structuralRows(structural([[1, 1], [2, null], [3, 2], [null, 3], [4, 4], [5, 5]], [2, 5], [3, 5]));
    const unified = unifiedRows(rows);
    const olds = unified.map((row) => row.lhs).filter((line) => line !== null);
    const news = unified.map((row) => row.rhs).filter((line) => line !== null);
    expect(olds).toEqual([1, 2, 3, 4, 5]);
    expect(news).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps a moved block's aligned indexes, so the move labels still find their other half", () => {
    const aligned: StructuralDiff["aligned"] = [[1, null], [2, null], [3, null], [4, 1], [null, 2], [null, 3], [null, 4]];
    const rows = structuralRows(structural(aligned));
    const moved = detectMoves(rows, ["alpha();", "beta();", "gamma();", "keep();"], ["keep();", "alpha();", "beta();", "gamma();"]);
    const unified = unifiedRows(rows);
    expect(shape(unified)).toEqual(["0:1/-", "1:2/-", "2:3/-", "3:4/1", "4:-/2", "5:-/3", "6:-/4"]);
    for (const row of unified) {
      const move = moved.get(row.index);
      if (row.index === 3) {
        expect(move).toBeUndefined();
        continue;
      }
      const other = unified.filter((candidate) => candidate.index === move!.counterpart);
      expect(other).toHaveLength(1);
      expect(row.lhs !== null ? other[0]!.rhs : other[0]!.lhs).toBe(move!.counterpartLine);
    }
  });
});

describe("tableEntries", () => {
  const unchanged = (count: number): StructuralDiff["aligned"] => Array.from({ length: count }, (_, i) => [i + 1, i + 1]);
  const entriesOf = (rows: StructuralRow[], visible: ReadonlySet<number>, layout: "split" | "unified") => tableEntries(layout === "unified" ? unifiedRows(rows) : rows, visible);

  it("folds the same rows in either layout and numbers the hunks alike", () => {
    const rows = structuralRows(structural(unchanged(20), [10], [10]));
    const visible = visibleRows(rows, { revealed: new Set(), findingLines: [], threads: [] });
    const describe = (layout: "split" | "unified") =>
      entriesOf(rows, visible, layout).map((entry) => (entry.kind === "gap" ? `gap ${entry.from}-${entry.to} h${entry.hunk}` : `${shape([entry.row])[0]} h${entry.hunk}${entry.hunkStart !== null ? ` @${entry.hunkStart}` : ""}`));
    expect(describe("split")).toEqual(["gap 0-6 h-1", "6:7/7 h0 @6", "7:8/8 h0", "8:9/9 h0", "9:10/10 h0", "10:11/11 h0", "11:12/12 h0", "12:13/13 h0", "gap 13-20 h0"]);
    expect(describe("unified")).toEqual(["gap 0-6 h-1", "6:7/7 h0 @6", "7:8/8 h0", "8:9/9 h0", "9:10/- h0", "9:-/10 h0", "10:11/11 h0", "11:12/12 h0", "12:13/13 h0", "gap 13-20 h0"]);
  });

  it("starts a hunk's header at its lowest aligned row when unified draws a later row's deletion first", () => {
    const rows = structuralRows(structural([[null, 1], [1, 2], [2, 3]], [2], [1]));
    const entries = entriesOf(rows, new Set([0, 1, 2]), "unified");
    expect(entries[0]).toMatchObject({ kind: "row", row: { index: 1, lhs: 1, rhs: null }, hunkStart: 0 });
    expect(entries.slice(1).every((entry) => entry.kind === "row" && entry.hunkStart === null)).toBe(true);
  });

  it("starts a new hunk after each fold", () => {
    const aligned = unchanged(40);
    const rows = structuralRows(structural(aligned, [5, 30], [5, 30]));
    const visible = visibleRows(rows, { revealed: new Set(), findingLines: [], threads: [] });
    const starts = entriesOf(rows, visible, "unified").filter((entry) => entry.kind === "row" && entry.hunkStart !== null);
    expect(starts.map((entry) => (entry.kind === "row" ? [entry.hunk, entry.hunkStart] : null))).toEqual([
      [0, 1],
      [1, 26],
    ]);
  });

  it("keeps each drawn row the same object across reveals", () => {
    const rows = structuralRows(structural(unchanged(20), [10], [10]));
    const drawn = unifiedRows(rows);
    const before = tableEntries(drawn, visibleRows(rows, { revealed: new Set(), findingLines: [], threads: [] }));
    const after = tableEntries(drawn, visibleRows(rows, { revealed: new Set([2, 3, 4, 5]), findingLines: [], threads: [] }));
    const changedBefore = before.flatMap((entry) => (entry.kind === "row" && entry.row.changed ? [entry.row] : []));
    const changedAfter = after.flatMap((entry) => (entry.kind === "row" && entry.row.changed ? [entry.row] : []));
    expect(changedAfter).toHaveLength(2);
    changedAfter.forEach((row, i) => expect(row).toBe(changedBefore[i]));
  });
});

describe("layout preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("is remembered under diff-view:layout", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) } });
    vi.resetModules();
    // bb shims React into the bundle; the tests have none.
    vi.doMock("react", () => ({ useSyncExternalStore: () => null }));
    const state = await import("./lib/app/state");
    state.setDiffPreferences({ layout: "unified" });
    expect(store.get("diff-view:layout")).toBe("unified");
    expect(state.readPreference("layout")).toBe("unified");
  });
});
