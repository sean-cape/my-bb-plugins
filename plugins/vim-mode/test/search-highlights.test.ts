import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSearchHighlights } from "../lib/index.ts";

// jsdom has no CSS Custom Highlight API; a registry that records what was set is enough.
class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

const registry = new Map<string, FakeHighlight>();
const view = window as unknown as { Highlight?: unknown; CSS?: { highlights?: unknown } };

beforeEach(() => {
  registry.clear();
  view.Highlight = FakeHighlight;
  view.CSS = { ...(view.CSS ?? {}), highlights: registry };
});

afterEach(() => {
  delete view.Highlight;
  document.head.querySelectorAll("style").forEach((sheet) => sheet.remove());
});

function ranges(count: number): Range[] {
  return Array.from({ length: count }, () => document.createRange());
}

describe("createSearchHighlights", () => {
  it("adds its rules to the head and takes the current match by index, as before", () => {
    const highlights = createSearchHighlights(document, "t");
    const [a, b] = ranges(2);
    highlights.show([a!, b!], 1);
    const names = [...registry.keys()];
    expect(names).toHaveLength(2);
    expect(registry.get(names.find((name) => name.endsWith("-current"))!)?.ranges).toEqual([b]);
    expect(document.head.querySelector("style")?.textContent).toBe(highlights.css);
    highlights.show([a!], -1);
    expect([...registry.keys()].some((name) => name.endsWith("-current"))).toBe(false);
  });

  it("exposes its rules for other roots, leaves the head alone without a sheet, and takes the current match as a Range", () => {
    const highlights = createSearchHighlights(document, "t", undefined, { sheet: false });
    expect(highlights.css).toMatch(/::highlight\(t-\d+-match\) \{ background-color: rgb\(245 158 11 \/ 0\.3\); \}/u);
    const [a, b] = ranges(2);
    const elsewhere = document.createRange();
    highlights.show([a!, b!], elsewhere);
    expect(document.head.querySelector("style")).toBeNull();
    const current = [...registry].find(([name]) => name.endsWith("-current"))?.[1];
    expect(current?.ranges).toEqual([elsewhere]);
    highlights.show([a!], null);
    expect([...registry.keys()].some((name) => name.endsWith("-current"))).toBe(false);
    highlights.clear();
    expect(registry.size).toBe(0);
  });
});
