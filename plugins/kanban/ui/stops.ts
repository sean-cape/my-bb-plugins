import type { Motion } from "./board-nav";

/**
 * Rows of buttons the keyboard reaches outside the cards: the title bar (a separate React tree,
 * so only the DOM connects it to the page), each column's add button, and the todo tag filters.
 */
export type Band = "header" | "columns" | "filters";

const BAND_STOPS: Record<Band, string> = {
  header: "[data-kanban-header] button:not(:disabled)",
  columns: "[data-kanban-column-add]",
  filters: "[data-kanban-filters] button:not(:disabled)",
};

/** A band's visible stops, left to right. */
export function bandStops(band: Band): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(BAND_STOPS[band]))
    .filter((stop) => stop.getClientRects().length > 0)
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
}

/** The band stop holding focus, if any. */
export function focusedStop(): { band: Band; stop: HTMLElement } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  for (const band of Object.keys(BAND_STOPS) as Band[]) {
    const stop = active.closest<HTMLElement>(BAND_STOPS[band]);
    if (stop !== null) return { band, stop };
  }
  return null;
}

export function focusStop(stop: HTMLElement): void {
  stop.focus({ preventScroll: true });
  stop.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** The stop in `band` whose centre lines up best with `from`. */
export function nearestStop(band: Band, from: Element): HTMLElement | null {
  const centre = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return (rect.left + rect.right) / 2;
  };
  const target = centre(from);
  let best: HTMLElement | null = null;
  for (const stop of bandStops(band)) {
    if (best === null || Math.abs(centre(stop) - target) < Math.abs(centre(best) - target)) best = stop;
  }
  return best;
}

/** Follows h, l, 0 and $ along the stop's band; false for any other motion. */
export function moveAlongBand(band: Band, stop: HTMLElement, motion: Motion): boolean {
  if (motion !== "left" && motion !== "right" && motion !== "first-column" && motion !== "last-column") return false;
  const stops = bandStops(band);
  const at = stops.indexOf(stop);
  const next = motion === "first-column" ? stops[0] : motion === "last-column" ? stops[stops.length - 1] : stops[at + (motion === "left" ? -1 : 1)];
  if (next !== undefined) focusStop(next);
  return true;
}

/** Presses a stop as Enter does: menu triggers open on a key, not on a click. */
export function pressStop(stop: HTMLElement): void {
  if (stop.hasAttribute("aria-haspopup")) stop.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  else stop.click();
}

/**
 * Scrolls half a page and, like vim, moves the cursor only when the scroll took it out of view:
 * to the first item now in view going down, the last going up. Returns where the cursor goes.
 */
export function scrollHalfPage(scroller: HTMLElement, items: readonly HTMLElement[], current: HTMLElement | null, direction: 1 | -1): HTMLElement | null {
  scroller.scrollBy({ top: (direction * scroller.clientHeight) / 2, behavior: "instant" });
  const view = scroller.getBoundingClientRect();
  const inView = items.filter((item) => {
    const rect = item.getBoundingClientRect();
    return rect.top >= view.top && rect.bottom <= view.bottom;
  });
  if (current !== null && inView.includes(current)) return current;
  return (direction === 1 ? inView[0] : inView[inView.length - 1]) ?? current;
}
