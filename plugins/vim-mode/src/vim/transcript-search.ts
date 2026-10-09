import { TIMELINE_ROW_INDEX_ATTRIBUTE, TIMELINE_ROW_LIST, TIMELINE_ROWS, UI_ATTRIBUTE } from "./selectors";

/** A match's place in the conversation: its row's index, then its order within the row. */
export interface MatchPosition {
  row: number;
  ordinal: number;
}

export function comparePositions(a: MatchPosition, b: MatchPosition): number {
  return a.row - b.row || a.ordinal - b.ordinal;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a `/` pattern. JavaScript regex syntax plus vim's `\<` and `\>`
 * word boundaries; a pattern that does not compile is searched literally.
 * Like vim's smartcase, an all-lowercase pattern ignores case.
 */
export function compilePattern(source: string): RegExp | null {
  if (!source) return null;
  const flags = /[A-Z]/.test(source) ? "g" : "gi";
  try {
    return new RegExp(source.replace(/\\[<>]/g, "\\b"), flags);
  } catch {
    return new RegExp(escapeRegExp(source), flags);
  }
}

/** The conversation's own rows, keyed by their index in the whole conversation. */
export function realizedRows(viewport: Element): Map<number, Element> {
  const rows = new Map<number, Element>();
  const list = viewport.querySelector(TIMELINE_ROW_LIST);
  if (!list) return rows;
  list.querySelectorAll(TIMELINE_ROWS).forEach((row, position) => {
    const index = Number(row.getAttribute(TIMELINE_ROW_INDEX_ATTRIBUTE) ?? position);
    rows.set(Number.isFinite(index) ? index : position, row);
  });
  return rows;
}

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
  "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "SUMMARY", "TABLE", "TD", "TH", "TR", "UL",
]);

function blockOf(node: Node, row: Element): Element {
  for (let element = node.parentElement; element && element !== row; element = element.parentElement) {
    if (BLOCK_TAGS.has(element.tagName)) return element;
  }
  return row;
}

interface Segment {
  node: Text;
  start: number;
}

/** The row's visible text, with a line break wherever text crosses into another block. */
function rowText(row: Element): { text: string; segments: Segment[] } {
  const visible = new Map<Element, boolean>();
  const isVisible = (element: Element): boolean => {
    let result = visible.get(element);
    if (result === undefined) {
      result = !element.closest(`[${UI_ATTRIBUTE}], script, style, template`) && (element.checkVisibility?.() ?? true);
      visible.set(element, result);
    }
    return result;
  };
  const segments: Segment[] = [];
  let text = "";
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!node.data || !node.parentElement || !isVisible(node.parentElement)) continue;
    const block = blockOf(node, row);
    if (lastBlock && block !== lastBlock) text += "\n";
    lastBlock = block;
    segments.push({ node, start: text.length });
    text += node.data;
  }
  return { text, segments };
}

/** The text node and offset at `offset`; a separator maps to the start of the next node. */
function locate(segments: Segment[], offset: number, isEnd: boolean): { node: Text; offset: number } {
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (segments[middle]!.start < offset || (!isEnd && segments[middle]!.start === offset)) low = middle;
    else high = middle - 1;
  }
  const segment = segments[low]!;
  return { node: segment.node, offset: Math.min(Math.max(0, offset - segment.start), segment.node.data.length) };
}

/** Every match of `pattern` in the row's visible text, in reading order. */
export function rowMatches(row: Element, pattern: RegExp): Range[] {
  const { text, segments } = rowText(row);
  if (!segments.length) return [];
  const ranges: Range[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (!match[0]) {
      pattern.lastIndex++;
      continue;
    }
    const start = locate(segments, match.index, false);
    const end = locate(segments, match.index + match[0].length, true);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  return ranges;
}

/**
 * True when an ancestor inside the row clips the match out of sight, such as
 * the tail of a one-line command that ends in an ellipsis.
 */
export function isClipped(range: Range, row: Element): boolean {
  const rect = range.getBoundingClientRect();
  const common = range.commonAncestorContainer;
  let element = common instanceof Element ? common : common.parentElement;
  for (; element && element !== row; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const clip = element.getBoundingClientRect();
    if (rect.left >= clip.right || rect.right <= clip.left) return true;
    if (rect.top >= clip.bottom || rect.bottom <= clip.top) return true;
  }
  return false;
}
