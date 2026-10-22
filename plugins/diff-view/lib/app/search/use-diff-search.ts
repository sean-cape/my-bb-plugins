import { createContext, useEffect, useMemo, useRef, useState } from "react";
import type { DiffSide } from "../../types";
import type { Cursor } from "../keys/nav";
import type { ReviewKeys } from "../keys/review-keys-context";
import { rowKey } from "../text/patch-rows";
import { compileSearch } from "../ui/vim-keys-core";
import { createSearchHighlights, textRanges } from "../ui/vim-keys";
import { cursorOnMatch, searchDiff, stepMatch, type DiffMatch, type SearchedFile } from "./diff-search";

/**
 * The `::highlight()` rules for the view's search, for renderers that draw into a shadow root (Pierre), where the
 * page's rules don't reach.
 */
export const SearchHighlightCss = createContext("");

/** What the review keys see of the search: `n`/`N` step it, Escape clears its highlights. */
export interface TextSearchEnv {
  query: string;
  /** The cursor on the match `n` (1) or `N` (-1) reaches; null when nothing matches. */
  step: (cursor: Cursor | null, direction: 1 | -1, count: number) => { cursor: Cursor; wrapped: boolean } | null;
  /** Hides the highlights, like vim's `:nohlsearch`; false when none were shown. `n` shows them again. */
  clear: () => boolean;
}

/**
 * Vim's `/` over the diff's text: the matches come from the files' patches (so files not mounted, collapsed or viewed
 * count), and those drawn on screen are highlighted with the CSS Custom Highlight API. `files` is what is searched, in
 * the order the diff shows it; keep it memoized.
 */
export function useDiffSearch({ keys, files, scroller, painting }: { keys: ReviewKeys; files: readonly SearchedFile[]; scroller: () => HTMLElement | null; painting: boolean }) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [typing, setTyping] = useState<{ saved: { query: string; highlighted: boolean; current: number | null }; from: Cursor | null } | null>(null);
  const typingRef = useRef(typing);
  typingRef.current = typing;
  // The next step is the first after a search was typed, which takes a match on the cursor's own line.
  const fresh = useRef(false);
  const pattern = useMemo(() => compileSearch(query), [query]);
  const search = useMemo(() => (pattern === null ? null : searchDiff(files, pattern)), [files, pattern]);
  const total = search?.matches.length ?? 0;
  const preview = typing !== null && search !== null ? (stepMatch(search, typing.from, null, 1, 1, true)?.index ?? null) : null;
  const shownIndex = typing !== null ? preview : current !== null && current < total ? current : null;

  // The view renders the rules itself, in its root and in each Pierre shadow root, so the library adds no sheet.
  const [highlights] = useState(() => createSearchHighlights(document, "diff-search", undefined, { sheet: false }));
  const css = highlights.css;

  const latest = useRef({ search, pattern, shownIndex, active: painting && (highlighted || typing !== null) });
  latest.current = { search, pattern, shownIndex, active: painting && (highlighted || typing !== null) };
  const frame = useRef(0);
  const observed = useRef(new WeakSet<Node>());
  const observer = useRef<MutationObserver | null>(null);

  const paint = () => {
    const { search: now, pattern: regex, shownIndex: at, active } = latest.current;
    if (!active || now === null || regex === null) {
      highlights.clear();
      return;
    }
    const want: DiffSide = keys.get().cursor?.want ?? "RIGHT";
    const all: Range[] = [];
    const seen = new Set<Range>();
    let currentRange: Range | null = null;
    const rangesOf = new Map<Element, Range[]>();
    const rowsOf = new Map<string, Map<string, number>>();
    now.matches.forEach((match: DiffMatch, index) => {
      const model = keys.models.get(match.path);
      if (model === undefined) return;
      let rows = rowsOf.get(match.path);
      if (rows === undefined) {
        rows = new Map();
        // A fold row takes a hidden line's numbers; that line is not drawn.
        model.rows.forEach((row, rowIndex) => {
          if (row.expander === true) return;
          if (row.left !== null) rows!.set(rowKey("LEFT", row.left), rowIndex);
          if (row.right !== null) rows!.set(rowKey("RIGHT", row.right), rowIndex);
        });
        rowsOf.set(match.path, rows);
      }
      const reached = index === at ? cursorOnMatch(match, want).side : null;
      for (const side of ["LEFT", "RIGHT"] as const) {
        const line = side === "LEFT" ? match.left : match.right;
        const row = line === null ? undefined : rows.get(rowKey(side, line));
        const element = row === undefined ? null : model.element(row, side);
        if (element === null) continue;
        // A structural row holds both sides and a "moved" label; its code is marked per side.
        const text = element.querySelector(`[data-line-text~="${side}"]`) ?? element;
        let ranges = rangesOf.get(text);
        if (ranges === undefined) rangesOf.set(text, (ranges = textRanges(text, regex)));
        const range = ranges[match.occurrence];
        if (range === undefined) continue;
        if (!seen.has(range)) {
          seen.add(range);
          all.push(range);
        }
        if (reached === side || (reached !== null && currentRange === null)) currentRange = range;
      }
    });
    highlights.show(all, currentRange);
    // Pierre and the syntax highlighter replace text nodes after they first draw, which leaves ranges pointing nowhere.
    const root = scroller();
    if (root !== null && observer.current !== null) {
      for (const host of Array.from(root.querySelectorAll("diffs-container"))) {
        const shadow = host.shadowRoot;
        if (shadow === null || observed.current.has(shadow)) continue;
        observed.current.add(shadow);
        observer.current.observe(shadow, { childList: true, characterData: true, subtree: true });
      }
    }
  };
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const schedule = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => paintRef.current());
  };

  const active = painting && (highlighted || typing !== null);
  useEffect(() => {
    schedule();
  }, [search, shownIndex, active]);
  useEffect(() => {
    if (!active) return;
    const root = scroller();
    const watcher = new MutationObserver(schedule);
    observer.current = watcher;
    observed.current = new WeakSet();
    if (root !== null) watcher.observe(root, { childList: true, characterData: true, subtree: true });
    const unsubscribe = keys.onModel(schedule);
    schedule();
    return () => {
      watcher.disconnect();
      observer.current = null;
      unsubscribe();
    };
    // The scroller is read when the files view shows; `painting` turns false while another view does.
  }, [active, keys]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      highlights.clear();
    },
    [highlights],
  );

  const env: TextSearchEnv | null =
    search === null
      ? null
      : {
          query,
          step: (cursor, direction, count) => {
            const inclusive = fresh.current;
            fresh.current = false;
            const reached = stepMatch(search, cursor, inclusive ? null : current, direction, count, inclusive);
            if (reached === null) return null;
            setCurrent(reached.index);
            setHighlighted(true);
            return { cursor: cursorOnMatch(search.matches[reached.index]!, cursor?.want ?? "RIGHT"), wrapped: reached.wrapped };
          },
          clear: () => {
            if (!highlighted) return false;
            setHighlighted(false);
            return true;
          },
        };

  return {
    env,
    query,
    css,
    total,
    /** Which match is current, counting from 0; null for none. */
    index: shownIndex,
    /** A search is showing its highlights, so its count belongs in the summary bar. */
    active: highlighted && typing === null && query !== "",
    /** The match the cursor was last sent to, so a structural diff can unfold the lines around it. */
    reached: highlighted && typing === null && shownIndex !== null ? (search?.matches[shownIndex] ?? null) : null,
    open: (from: Cursor | null) => setTyping({ saved: { query, highlighted, current }, from }),
    type: (next: string) => {
      setQuery(next);
      setHighlighted(true);
    },
    /** Enter in the box; false when it was empty, which leaves the last search as it was. */
    commit: (typed: string): boolean => {
      const was = typingRef.current;
      typingRef.current = null;
      setTyping(null);
      if (typed === "") {
        if (was !== null) {
          setQuery(was.saved.query);
          setHighlighted(was.saved.highlighted);
          setCurrent(was.saved.current);
        }
        return false;
      }
      setCurrent(null);
      fresh.current = true;
      return true;
    },
    /** Escape in the box, or leaving it: the search from before it opened comes back. */
    cancel: () => {
      const was = typingRef.current;
      if (was === null) return;
      typingRef.current = null;
      setTyping(null);
      setQuery(was.saved.query);
      setHighlighted(was.saved.highlighted);
      setCurrent(was.saved.current);
    },
    clear: () => setHighlighted(false),
  };
}
