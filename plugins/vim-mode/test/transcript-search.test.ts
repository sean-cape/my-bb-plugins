import { afterEach, expect, test } from "vitest";
import { compilePattern, isClipped, realizedRows, rowMatches } from "../src/vim/transcript-search";

afterEach(() => {
  document.body.replaceChildren();
});

function row(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

function matches(html: string, source: string): string[] {
  return rowMatches(row(html), compilePattern(source)!).map((range) => range.toString());
}

test("lowercase patterns ignore case and patterns with capitals do not", () => {
  expect(matches("Foo foo FOO", "foo")).toEqual(["Foo", "foo", "FOO"]);
  expect(matches("Foo foo FOO", "Foo")).toEqual(["Foo"]);
});

test("patterns are regexes with vim word boundaries, and broken regexes match literally", () => {
  expect(matches("cat concat cats", "\\<cat\\>")).toEqual(["cat"]);
  expect(matches("a(b a(b", "a(b")).toEqual(["a(b", "a(b"]);
  expect(matches("ab", "x*")).toEqual([]);
  expect(compilePattern("")).toBeNull();
});

test("matches span inline formatting but not separate blocks", () => {
  expect(matches("a <b>nee</b>dle here", "needle")).toEqual(["needle"]);
  expect(matches("<p>nee</p><p>dle</p>", "needle")).toEqual([]);
  expect(matches("<p>one</p><p>two</p>", "one\\ntwo")).toEqual(["onetwo"]);
});

test("the plugin's own UI inside a row is not searched", () => {
  expect(matches('text <span data-bb-vim-ui="">text</span>', "text")).toEqual(["text"]);
});

test("rows are keyed by their conversation index, including inside the virtualized items", () => {
  const viewport = document.createElement("div");
  viewport.innerHTML = `
    <div data-timeline-row-list="top-level">
      <div data-timeline-items="">
        <div data-timeline-row-id="a" data-index="7"><div data-timeline-row-id="nested"></div></div>
        <div data-timeline-row-id="b" data-index="8"></div>
      </div>
    </div>`;
  const rows = realizedRows(viewport);
  expect([...rows.keys()]).toEqual([7, 8]);
  expect(rows.get(8)!.getAttribute("data-timeline-row-id")).toBe("b");
});

test("a match cut off by an overflow-hidden ancestor counts as clipped", () => {
  const element = row('<div style="overflow: hidden">visible <span>hidden</span></div>');
  const clip = element.firstElementChild as HTMLElement;
  clip.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
  const [shown, cut] = rowMatches(element, compilePattern("visible|hidden")!);
  shown!.getBoundingClientRect = () => new DOMRect(0, 0, 50, 20);
  cut!.getBoundingClientRect = () => new DOMRect(120, 0, 50, 20);
  expect(isClipped(shown!, element)).toBe(false);
  expect(isClipped(cut!, element)).toBe(true);
});
