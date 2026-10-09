import { describe, expect, it } from "vitest";
import { loadRecentThreads, recordThreadVisit, returnTarget } from "./recent-thread.js";

describe("recordThreadVisit", () => {
  it("keeps the two most recent distinct threads and ignores other pages", () => {
    let recent = recordThreadVisit([], "a");
    recent = recordThreadVisit(recent, null);
    recent = recordThreadVisit(recent, "b");
    recent = recordThreadVisit(recent, "c");
    expect(recent).toEqual(["c", "b"]);
    expect(recordThreadVisit(recent, "b")).toEqual(["b", "c"]);
    expect(recordThreadVisit(recent, "c")).toBe(recent);
  });
});

describe("returnTarget", () => {
  it("returns to the last thread from a page that isn't one", () => {
    expect(returnTarget(["a", "b"], null)).toBe("a");
  });

  it("toggles to the thread before the current one", () => {
    expect(returnTarget(["b", "a"], "b")).toBe("a");
  });

  it("has nowhere to go with no other thread", () => {
    expect(returnTarget([], null)).toBeNull();
    expect(returnTarget(["a"], "a")).toBeNull();
  });
});

describe("loadRecentThreads", () => {
  it("reads a saved trail and ignores anything malformed", () => {
    const storage = (value: string | null) => ({ getItem: () => value });
    expect(loadRecentThreads(storage('["a","b","c"]'), "k")).toEqual(["a", "b"]);
    expect(loadRecentThreads(storage("{nope"), "k")).toEqual([]);
    expect(loadRecentThreads(storage('[1,"a"]'), "k")).toEqual(["a"]);
    expect(loadRecentThreads(null, "k")).toEqual([]);
  });
});
