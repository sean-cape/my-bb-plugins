// The keys' view of a pane that scrolls through excerpts (the narrative's step): what is in view,
// a page of scrolling, and going to a section. The files view shares the page scroll.
import type { RevealBlock } from "../scroll";
import { cursorAt, firstPosition, type Cursor, type NavFile } from "./nav";
import type { ReviewEnv } from "./review-commands";
import type { ReviewKeys } from "./review-keys-context";

/** Approximate height of one diff line, for turning a page scroll into cursor rows, and a `j` over prose into a scroll. */
export const LINE_PX = 20;

/** Scrolls `scroller` by a fraction of its height; the rows that is, about. */
export function scrollPageBy(scroller: HTMLElement | null, fraction: number): number {
  if (scroller === null) return 0;
  scroller.scrollBy({ top: fraction * scroller.clientHeight, behavior: "auto" });
  return Math.round((fraction * scroller.clientHeight) / LINE_PX);
}

export interface ScrollerPane {
  keys: ReviewKeys;
  scroller: () => HTMLElement | null;
  files: () => NavFile[];
  section: (path: string) => HTMLElement | undefined;
  reveal: (cursor: Cursor, block?: RevealBlock) => void;
  /** Puts the cursor on a file's header. */
  park: (path: string) => void;
}

/** The first (or, going up, last) section header or line in view; null when the pane shows no code on screen. */
export function visibleCursor({ keys, scroller: scrollerOf, files: filesOf, section }: ScrollerPane, direction: 1 | -1): Cursor | null {
  const scroller = scrollerOf();
  const files = filesOf();
  if (scroller === null || files.length === 0) return null;
  const view = scroller.getBoundingClientRect();
  const want = keys.get().cursor?.want ?? "RIGHT";
  const other = want === "LEFT" ? "RIGHT" : "LEFT";
  const shown = (box: DOMRect | undefined) => box !== undefined && box.bottom > view.top && box.top < view.bottom;
  let found: Cursor | null = null;
  for (const [fileIndex, file] of files.entries()) {
    if (shown(section(file.path)?.getBoundingClientRect())) {
      found = cursorAt(files, { fileIndex, row: -1 }, want);
      if (direction === 1) return found;
    }
    const model = file.collapsed ? undefined : keys.models.get(file.path);
    if (model === undefined) continue;
    for (let row = 0; row < model.rows.length; row++) {
      if (!shown((model.element(row, want) ?? model.element(row, other))?.getBoundingClientRect())) continue;
      found = cursorAt(files, { fileIndex, row }, want);
      if (direction === 1) return found;
    }
  }
  return found;
}

/**
 * The keys' seat, reveal, page scroll and jump for a pane read top to bottom: the cursor rests on what is in view and
 * scrolls only when it would leave the screen.
 */
export function scrollerEnv(pane: ScrollerPane): Pick<ReviewEnv, "files" | "seat" | "reveal" | "scrollPage" | "jump"> {
  return {
    files: pane.files(),
    seat: () => visibleCursor(pane, 1) ?? firstPosition(pane.files(), pane.keys.get().cursor?.want ?? "RIGHT"),
    reveal: (cursor, block) => pane.reveal(cursor, block ?? "nearest"),
    scrollPage: (fraction) => scrollPageBy(pane.scroller(), fraction),
    jump: (path) => {
      pane.section(path)?.scrollIntoView({ block: "start" });
      pane.park(path);
    },
  };
}
