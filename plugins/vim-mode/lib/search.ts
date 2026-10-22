import { createKeyHandler, type KeyHandler } from "./handler.ts";
import type { KeyHelpSection, Keymap } from "./reader.ts";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles what was typed after `/`: JavaScript regex syntax plus vim's `\<` and `\>` word
 * boundaries, searched literally when it doesn't compile. Like vim's smartcase, a query with no
 * capital ignores case. Null for an empty query.
 */
export function compileSearch(query: string, options: { regex?: boolean } = {}): RegExp | null {
  if (query === "") return null;
  const flags = /[A-Z]/.test(query) ? "g" : "gi";
  if (options.regex === false) return new RegExp(escapeRegExp(query), flags);
  try {
    return new RegExp(query.replace(/\\[<>]/g, "\\b"), flags);
  } catch {
    return new RegExp(escapeRegExp(query), flags);
  }
}

/**
 * The entries of a shortcuts list whose action or keys contain `query` (smartcase, literal), and
 * every entry of a section whose title does; sections left empty are dropped.
 */
export function filterKeyHelp(sections: readonly KeyHelpSection[], query: string): KeyHelpSection[] {
  const pattern = compileSearch(query, { regex: false });
  if (pattern === null) return [...sections];
  const matches = (text: string) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  };
  return sections.flatMap((section) => {
    if (section.title !== "" && matches(section.title)) return [section];
    const keys = section.keys.filter(({ keys, action }) => matches(action) || keys.some(matches));
    return keys.length === 0 ? [] : [{ ...section, keys }];
  });
}

/** Where `pattern` matches in `text`, as [start, end) offsets; empty matches are skipped. */
export function matchOffsets(text: string, pattern: RegExp): [number, number][] {
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  global.lastIndex = 0;
  const offsets: [number, number][] = [];
  for (let match = global.exec(text); match !== null; match = global.exec(text)) {
    if (match[0] === "") {
      global.lastIndex += 1;
      continue;
    }
    offsets.push([match.index, match.index + match[0].length]);
  }
  return offsets;
}

/**
 * A Range for every match of `pattern` in the text under `root`, across element boundaries (a
 * match can span syntax colouring). `skip` leaves out text inside elements it accepts.
 */
export function textRanges(root: Node, pattern: RegExp, options: { skip?: (element: Element) => boolean } = {}): Range[] {
  const doc = root.ownerDocument ?? (root as Document);
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
    if (options.skip !== undefined && node.parentElement !== null && options.skip(node.parentElement)) continue;
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  if (nodes.length === 0) return [];
  const locate = (offset: number, end: boolean) => {
    let index = nodes.length - 1;
    // An end offset at a node boundary stays in the earlier node, so a match never ends in a node it doesn't touch.
    while (index > 0 && (end ? nodes[index]!.start >= offset : nodes[index]!.start > offset)) index -= 1;
    return { node: nodes[index]!.node, offset: offset - nodes[index]!.start };
  };
  return matchOffsets(text, pattern).map(([from, to]) => {
    const range = doc.createRange();
    const start = locate(from, false);
    const end = locate(to, true);
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  });
}

/** Scrolls `scroller` so `range` sits `at` of the way down it (a third, by default). */
export function revealRange(scroller: HTMLElement, range: Range, at = 1 / 3): void {
  const top = range.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += top - scroller.clientHeight * at;
}

export interface SearchHighlights {
  /**
   * Paints every match, and the current one brighter: an index into `ranges` (-1 or null for none current), or a Range
   * of its own, for a caller that finds the current match apart from the list.
   */
  show(ranges: readonly Range[], current: number | Range | null): void;
  clear(): void;
  /** The `::highlight()` rules, for roots the document's own sheet doesn't reach (a shadow root) or a caller that renders its own. */
  readonly css: string;
}

export interface SearchHighlightOptions {
  /** Adds the rules to the document's head on the first `show`; false leaves them to the caller, through `css`. Default true. */
  sheet?: boolean;
}

let highlightCount = 0;

/**
 * Match highlights painted with the CSS Custom Highlight API, so the page's DOM is untouched.
 * Highlight names are global to a document, so each call gets its own: two mounted views of one
 * plugin don't repaint each other's matches. `match` and `current` are CSS declarations.
 */
export function createSearchHighlights(
  doc: Document,
  prefix: string,
  style: { match: string; current: string } = { match: "background-color: rgb(245 158 11 / 0.3);", current: "background-color: rgb(245 158 11 / 0.8); color: black;" },
  options: SearchHighlightOptions = {},
): SearchHighlights {
  const id = `${prefix}-${++highlightCount}`;
  const matchName = `${id}-match`;
  const currentName = `${id}-current`;
  const css = `::highlight(${matchName}) { ${style.match} } ::highlight(${currentName}) { ${style.current} }`;
  // Typed by hand: the registry's map methods come from DOM.Iterable, which some plugins' tsconfigs leave out.
  const registry = doc.defaultView?.CSS?.highlights as { set(name: string, highlight: Highlight): unknown; delete(name: string): unknown } | undefined;
  const Highlight = (doc.defaultView as (Window & { Highlight?: typeof globalThis.Highlight }) | null)?.Highlight;
  let sheet: HTMLStyleElement | null = null;
  const clear = () => {
    registry?.delete(matchName);
    registry?.delete(currentName);
  };
  return {
    css,
    show(ranges, current) {
      if (registry === undefined || Highlight === undefined) return;
      if (options.sheet !== false && (sheet === null || !sheet.isConnected)) {
        sheet = doc.createElement("style");
        sheet.textContent = css;
        doc.head.append(sheet);
      }
      if (ranges.length === 0) {
        clear();
        return;
      }
      registry.set(matchName, new Highlight(...ranges));
      const now = current === null ? undefined : typeof current === "number" ? ranges[current] : current;
      if (now === undefined) registry.delete(currentName);
      else registry.set(currentName, new Highlight(now));
    },
    clear() {
      clear();
      sheet?.remove();
      sheet = null;
    },
  };
}

export interface SearchBoxKeysOptions {
  /** Enter: keep the search and go back to the keys. */
  commit: (event: KeyboardEvent) => void;
  /** Escape: drop or keep the search, then go back to the keys. False leaves it. */
  cancel: (event: KeyboardEvent) => boolean | void;
  /** Arrows and Ctrl-n/p, to step through matches while typing; unbound without it. */
  step?: (step: 1 | -1) => void;
  /** Backspace in an empty box cancels, as in vim's `/` and `:` lines. */
  cancelOnEmptyBackspace?: boolean;
}

type SearchBoxCommand = "commit" | "cancel" | "next" | "previous" | "backspace";

/**
 * Keys for the box `/` opens: Enter commits, Escape cancels, and with `step`, arrows and
 * Ctrl-n/p move between matches. Everything else is typing. Hand it the box's keydowns and stop
 * them from reaching outer surfaces when it returns true.
 */
export function createSearchBoxKeys(options: SearchBoxKeysOptions): KeyHandler {
  const keymap: Keymap<SearchBoxCommand> = {
    "<CR>": "commit",
    "<Esc>": "cancel",
    ...(options.step === undefined ? {} : { "<Down>": "next", "<C-n>": "next", "<Up>": "previous", "<C-p>": "previous" }),
    ...(options.cancelOnEmptyBackspace === true ? { "<BS>": "backspace" as const } : {}),
  };
  return createKeyHandler<SearchBoxCommand>({
    keymap,
    isText: () => false,
    leaveToPressables: false,
    onCommand: (command, { event }) => {
      if (command === "backspace") {
        const box = event.target;
        if (!(box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) || box.value !== "") return false;
        return options.cancel(event);
      }
      if (command === "commit") options.commit(event);
      else if (command === "cancel") return options.cancel(event);
      else options.step?.(command === "next" ? 1 : -1);
    },
  });
}
