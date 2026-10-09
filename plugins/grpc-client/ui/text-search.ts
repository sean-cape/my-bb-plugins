import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { findMatches } from "./filter";

const MATCHES = "grpc-client-search";
const CURRENT = "grpc-client-search-current";
const STYLE_ID = "grpc-client-search-style";

// Custom highlights paint ranges without touching the DOM, so matches can span the JSON view's
// coloured spans. Their styles have to be global, keyed by highlight name.
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `::highlight(${MATCHES}) { background-color: rgb(245 158 11 / 0.3); } ::highlight(${CURRENT}) { background-color: rgb(245 158 11 / 0.8); color: black; }`;
  document.head.append(style);
}

function clearHighlights(): void {
  CSS.highlights?.delete(MATCHES);
  CSS.highlights?.delete(CURRENT);
}

/** Ranges for every match of `query` in the text under `root`, including across element boundaries. */
function rangesFor(root: Node, query: string): Range[] {
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += node.nodeValue ?? "";
  }
  const locate = (offset: number) => {
    let index = nodes.length - 1;
    while (index > 0 && nodes[index]!.start > offset) index -= 1;
    return { node: nodes[index]!.node, offset: offset - nodes[index]!.start };
  };
  return findMatches(text, query).map((at) => {
    const range = document.createRange();
    const start = locate(at);
    const end = locate(at + query.length);
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  });
}

/** Scrolls `scroller` so `range` sits a third of the way down it. */
function reveal(scroller: HTMLElement, range: Range): void {
  const top = range.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += top - scroller.clientHeight / 3;
}

/**
 * Vim's / over a scrolling pane's text: matches highlight as the query is typed and the view
 * jumps to the first one at or below where the search started; n/N step through them. `content`
 * changes whenever the pane shows something else, so the matches are found again.
 */
export function useTextSearch(scroller: () => HTMLElement | null, content: unknown) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(-1);
  const [count, setCount] = useState(0);
  const ranges = useRef<Range[]>([]);
  /** Where the search started, so cancelling goes back there and the first match is the next one down. */
  const origin = useRef(0);

  const paint = useCallback((index: number) => {
    const found = ranges.current;
    const range = found[index];
    if (range === undefined) {
      CSS.highlights?.delete(CURRENT);
      return;
    }
    CSS.highlights?.set(CURRENT, new Highlight(range));
    const pane = scroller();
    if (pane !== null) reveal(pane, range);
  }, [scroller]);

  useLayoutEffect(() => {
    const pane = scroller();
    if (pane === null || query === "" || typeof CSS.highlights === "undefined") {
      ranges.current = [];
      setCount(0);
      setCurrent(-1);
      clearHighlights();
      return;
    }
    ensureStyle();
    const found = rangesFor(pane, query);
    ranges.current = found;
    setCount(found.length);
    CSS.highlights.set(MATCHES, new Highlight(...found));
    const paneTop = pane.getBoundingClientRect().top - pane.scrollTop;
    const next = found.findIndex((range) => range.getBoundingClientRect().top - paneTop >= origin.current);
    const index = found.length === 0 ? -1 : next === -1 ? 0 : next;
    setCurrent(index);
    paint(index);
  }, [query, content, scroller, paint]);

  useEffect(() => clearHighlights, []);

  return {
    open,
    query,
    count,
    current,
    start: () => {
      origin.current = scroller()?.scrollTop ?? 0;
      setOpen(true);
    },
    setQuery,
    /** Enter: keep the matches and go back to the pane. */
    commit: () => setOpen(false),
    /** Escape in the box: drop the search and scroll back to where it started. */
    cancel: () => {
      setOpen(false);
      setQuery("");
      const pane = scroller();
      if (pane !== null) pane.scrollTop = origin.current;
    },
    next: (step: 1 | -1): boolean => {
      const total = ranges.current.length;
      if (total === 0) return false;
      const index = (current + step + total) % total;
      setCurrent(index);
      paint(index);
      return true;
    },
    /** Escape in the pane: clears the highlights, like :nohlsearch. False when there were none. */
    clear: (): boolean => {
      if (query === "") return false;
      setQuery("");
      return true;
    },
  };
}
