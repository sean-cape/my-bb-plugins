// Where the view's fixed popovers (file menus, blame, the file filter, the symbol card) open beside what they are about.
// Pure, for the tests.

/** Between a popover and its anchor. */
export const POPOVER_GAP_PX = 4;
/** Kept clear at the screen's edges. */
export const VIEWPORT_MARGIN_PX = 8;
/** Room a popover needs below its anchor before it opens above instead; about the blame popover's tallest. */
export const FLIP_ABOVE_PX = 300;

export interface PopoverPlace {
  top?: number;
  bottom?: number;
  left: number;
}

type Box = Pick<DOMRect, "top" | "bottom" | "left" | "right">;

/**
 * Under the anchor (above it when the screen runs out below), starting at its left edge; one that would run off the
 * right of the screen ends at the anchor's right edge instead, so it stays over the anchor rather than sliding away
 * from it, and is then kept on screen.
 */
export function popoverPlace(
  anchor: Box,
  { width, flipAbovePx = FLIP_ABOVE_PX, gapPx = POPOVER_GAP_PX }: { width: number; flipAbovePx?: number; gapPx?: number },
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): PopoverPlace {
  const below = anchor.bottom + flipAbovePx < viewport.height;
  const fitsRight = anchor.left + width + VIEWPORT_MARGIN_PX <= viewport.width;
  const fitsLeft = anchor.right - width >= VIEWPORT_MARGIN_PX;
  // A narrow anchor (a symbol) that fits neither way is left to the clamp, which keeps the popover as near it as the screen allows.
  const start = fitsRight || !fitsLeft ? anchor.left : anchor.right - width;
  const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(start, viewport.width - width - VIEWPORT_MARGIN_PX));
  return below ? { top: anchor.bottom + gapPx, left } : { bottom: viewport.height - anchor.top + gapPx, left };
}

/** How far in from a view's top left corner a popover with no anchor of its own opens: past the view's padding and first row. */
const CORNER_INSET = { left: 12, top: 28 };

export function viewCorner(view: Pick<DOMRect, "top" | "left"> | undefined): DOMRect {
  return new DOMRect((view?.left ?? 0) + CORNER_INSET.left, (view?.top ?? 0) + CORNER_INSET.top, 0, 0);
}
