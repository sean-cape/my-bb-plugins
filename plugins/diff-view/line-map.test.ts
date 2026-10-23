import { describe, expect, it } from "vitest";
import { changeBlocks, mapLines } from "./lib/line-map";

describe("line map", () => {
  // Old 1–10 → new: line 2 changed, two lines inserted before old 6, old 9 deleted.
  const patch = ["@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", " d", "@@ -5,6 +5,7 @@", " e", "+x", "+y", " f", " g", " h", "-i", " j"].join("\n");

  it("collects each run of deletions and additions", () => {
    expect(changeBlocks(patch)).toEqual([
      [2, 1, 2, 1],
      [6, 0, 6, 2],
      [9, 1, 11, 0],
    ]);
  });

  it("reads a hunk with no lines on one side as at the line after the one it names", () => {
    expect(changeBlocks("@@ -4,0 +5,2 @@\n+x\n+y")).toEqual([[5, 0, 5, 2]]);
    expect(changeBlocks("@@ -7,2 +6,0 @@\n-x\n-y")).toEqual([[7, 2, 7, 0]]);
  });

  it("moves untouched lines by what changed above them and calls touched ones outdated", () => {
    const blocks = changeBlocks(patch);
    expect(mapLines(blocks, 1, 1)).toEqual({ start: 1, end: 1 });
    expect(mapLines(blocks, 2, 2)).toBeNull();
    expect(mapLines(blocks, 3, 5)).toEqual({ start: 3, end: 5 });
    expect(mapLines(blocks, 6, 8)).toEqual({ start: 8, end: 10 });
    expect(mapLines(blocks, 5, 6)).toBeNull();
    expect(mapLines(blocks, 9, 9)).toBeNull();
    expect(mapLines(blocks, 10, 10)).toEqual({ start: 11, end: 11 });
  });
});
