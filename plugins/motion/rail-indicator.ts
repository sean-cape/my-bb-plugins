// Slides one shared fill between the items of bb's icon rail as the current
// page changes, where bb fills the current item in place. The fill sits under
// the buttons (z-index -1 inside the rail's stacking context), and shell.css
// clears bb's own fill on the current item only while the rail carries
// GLIDE_ATTR, so the rail looks stock if this script stops.

export const INDICATOR_ATTR = "data-bbm-rail-indicator";
export const GLIDE_ATTR = "data-bbm-rail-glide";
export const SNAP_ATTR = "data-bbm-snap";

const RAIL = '[data-testid="app-nav-rail"]';
const CURRENT = 'button[aria-current="page"]';

export interface IndicatorState {
  x: number;
  y: number;
  visible: boolean;
  /** False when appearing from hidden, so it fades in under the item instead of sliding from wherever it last was. */
  slide: boolean;
}

export type Target = { x: number; y: number } | null;

export function nextIndicator(previous: IndicatorState | null, target: Target): IndicatorState {
  if (!target) {
    return { x: previous?.x ?? 0, y: previous?.y ?? 0, visible: false, slide: false };
  }
  return { ...target, visible: true, slide: previous?.visible === true };
}

export function watchRailIndicator(root: Node = document.body): () => void {
  let rail: HTMLElement | null = null;
  let indicator: HTMLElement | null = null;
  let state: IndicatorState | null = null;
  let detachRail: (() => void) | null = null;

  const place = (snap = false) => {
    if (!rail || !indicator) return;
    const current = rail.querySelector<HTMLElement>(CURRENT);
    let target: Target = null;
    if (current) {
      const box = current.getBoundingClientRect();
      const railBox = rail.getBoundingClientRect();
      target = { x: box.left - railBox.left - rail.clientLeft, y: box.top - railBox.top - rail.clientTop };
      indicator.style.width = `${box.width}px`;
      indicator.style.height = `${box.height}px`;
      indicator.style.borderRadius = getComputedStyle(current).borderRadius;
    }
    const next = nextIndicator(state, target);
    if (state && next.visible === state.visible && next.x === state.x && next.y === state.y) return;
    state = next;
    const glide = next.slide && !snap;
    indicator.toggleAttribute(SNAP_ATTR, !glide);
    indicator.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
    // Commits the position before the transition comes back, so an indicator
    // appearing from hidden lands under its item rather than sliding there.
    if (!glide) void indicator.offsetWidth;
    indicator.toggleAttribute(SNAP_ATTR, false);
    indicator.style.opacity = next.visible ? "1" : "0";
  };

  const attach = (found: HTMLElement) => {
    rail = found;
    state = null;
    indicator = document.createElement("span");
    indicator.setAttribute(INDICATOR_ATTR, "");
    indicator.setAttribute("aria-hidden", "true");
    indicator.style.opacity = "0";
    rail.append(indicator);
    rail.setAttribute(GLIDE_ATTR, "");

    const changes = new MutationObserver(() => place());
    changes.observe(rail, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current"] });
    const onScroll = () => place(true);
    rail.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place(true));
    resize?.observe(rail);
    place();

    const attached = rail;
    const own = indicator;
    detachRail = () => {
      changes.disconnect();
      resize?.disconnect();
      attached.removeEventListener("scroll", onScroll, { capture: true });
      attached.removeAttribute(GLIDE_ATTR);
      own.remove();
    };
  };

  const detach = () => {
    detachRail?.();
    detachRail = null;
    rail = null;
    indicator = null;
    state = null;
  };

  const sync = () => {
    if (rail?.isConnected) return;
    if (rail) detach();
    const found = document.querySelector<HTMLElement>(RAIL);
    if (found) attach(found);
  };

  const mounts = new MutationObserver(sync);
  mounts.observe(root, { childList: true, subtree: true });
  sync();

  return () => {
    mounts.disconnect();
    detach();
  };
}
