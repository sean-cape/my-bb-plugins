/** Height of a file's sticky header; keyboard jumps land content just below it. */
export const STICKY_HEADER_PX = 36;
/** Lines kept between the keyboard cursor and the edge of the scroller, like vim's `scrolloff`. */
const SCROLL_OFF_PX = 60;

/** Scroll the diff so `element` sits just below the sticky file header. */
export function scrollToElement(main: HTMLElement, element: Element): void {
  const offset = element.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
  main.scrollTo({ top: Math.max(0, offset - STICKY_HEADER_PX), behavior: "auto" });
}

/**
 * Scroll the diff so `element` is on screen: just enough to keep it `SCROLL_OFF_PX` inside the edges, or to put it at
 * the middle, top or bottom when `block` says so.
 */
export function revealElement(main: HTMLElement, element: Element, block?: "center" | "start" | "end"): void {
  const view = main.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  const top = view.top + STICKY_HEADER_PX;
  let delta = 0;
  if (block === "center") delta = box.top + box.height / 2 - (top + view.bottom) / 2;
  else if (block === "start") delta = box.top - top;
  else if (block === "end") delta = box.bottom - view.bottom;
  else if (box.top < top + SCROLL_OFF_PX) delta = box.top - (top + SCROLL_OFF_PX);
  else if (box.bottom > view.bottom - SCROLL_OFF_PX) delta = box.bottom - (view.bottom - SCROLL_OFF_PX);
  if (delta !== 0) main.scrollTo({ top: Math.max(0, main.scrollTop + delta), behavior: "auto" });
}
