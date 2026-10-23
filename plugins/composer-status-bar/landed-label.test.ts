import { describe, expect, it } from "vitest";
import { landedLabel } from "./landed-label.js";

describe("landedLabel", () => {
  it("says nothing when the branch has no commits beyond its base", () => {
    expect(landedLabel({ state: "none" })).toBeNull();
  });

  it("calls a branch whose work is in its base, and its upstream or no upstream, landed", () => {
    expect(landedLabel({ state: "landed", base: "main", pushed: true })).toMatchObject({ text: "on main", tone: "landed", title: expect.stringContaining("main and its upstream") });
    expect(landedLabel({ state: "landed", base: "main", pushed: null })).toMatchObject({ text: "on main", tone: "landed" });
  });

  it("flags work on the base that isn't pushed", () => {
    expect(landedLabel({ state: "landed", base: "main", pushed: false })).toMatchObject({ text: "on main · not pushed", tone: "unpushed" });
  });

  it("counts the files a branch would still change, and says when merging it would conflict", () => {
    expect(landedLabel({ state: "unlanded", base: "main", files: 1, conflicts: false })).toMatchObject({ text: "1 file not on main", tone: "pending" });
    expect(landedLabel({ state: "unlanded", base: "main", files: 3, conflicts: true })).toMatchObject({ text: "3 files not on main · conflicts", tone: "conflicts" });
    expect(landedLabel({ state: "unlanded", base: "main", files: 0, conflicts: true })).toMatchObject({ text: "conflicts with main", tone: "conflicts" });
  });
});
