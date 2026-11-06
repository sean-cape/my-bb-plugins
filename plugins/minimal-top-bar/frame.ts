const TOP_BAR_HEIGHT_PX = 50;
const HEADER_GAP_PX = 20;
const PANEL_TOGGLE_GAP_PX = 8;
// Phone-width windows keep bb's stock layout.
const WIDE_VIEWPORT = "(min-width: 768px)";
const STYLE_ATTRIBUTE = "data-minimal-top-bar-frame";
const FRAME_ATTRIBUTE = "data-minimal-top-bar-framed";
const CLEAR_LEFT = "--minimal-top-bar-clear-left";
const CLEAR_RIGHT = "--minimal-top-bar-clear-right";
const ZOOM_PROPERTY = "--minimal-top-bar-zoom";
const TOP_BAR_PROPERTY = "--minimal-top-bar-height";
// bb's zoom commands step in 10% increments.
const ZOOM_STEPS_PER_UNIT = 10;
// The top bar stays the same size at any zoom so it keeps lining up with the
// macOS window buttons, which the page zoom never scales.
const ZOOM = `var(${ZOOM_PROPERTY}, 1)`;
const UNZOOM = `zoom: calc(1 / ${ZOOM});`;
const unzoomed = (px: number) => `calc(${px}px / ${ZOOM})`;
// bb's page header paints bg-surface-scrim over the page's bg-background.
const HEADER_SURFACE = "linear-gradient(var(--surface-scrim), var(--surface-scrim)), var(--background)";

// bb's window frame and header markup has no plugin contract, so these
// selectors and the stylesheet below follow the shipped DOM; a bb update that
// renames them just leaves bb's normal title bar.
const LAYOUT_ROOT = '[data-testid="app-layout-root"]';
// On macOS bb frames the page below a title bar holding back, forward, the
// sidebar toggle, and the right panel toggle.
const FRAMED = `${LAYOUT_ROOT}[data-framed]`;
const SIDEBAR = '[data-side="left"][data-variant="sidebar"]';
const RAIL = '[data-testid="app-nav-rail"]';
const TITLE_BAR = '[data-testid="app-window-title-bar"]';
const TITLE_BAR_CONTROLS = `${TITLE_BAR} > div:has([data-sidebar="trigger"])`;
const PANEL_TOGGLE = '[data-testid="window-right-panel-toggle"]';
const SIDEBAR_TRIGGER_OVERLAY = '[data-testid="app-sidebar-trigger-overlay"]';
const HEADER_ROW = '[data-testid="app-page-header-content-row"]';
// A side panel's tab strip, whose right end (bb's Full Screen button) sits
// under the floating panel toggle once the title bar row is gone.
const PANEL_CHROME = '[data-testid="thread-secondary-panel-top-chrome"]';

export const TOP_BAR_FRAME_CSS = `
@media ${WIDE_VIEWPORT} {
  /* No title bar row: the page header is the top bar, so the thread title and
     its buttons share the window buttons' row and a side panel reaches the
     top of the window. */
  ${FRAMED} {
    --bb-window-title-bar-height: 0px !important;
    --bb-window-frame-lip: 0px !important;
  }
  /* The rail is as wide as the top bar is tall, so they meet in a square
     corner. bb sizes the rail, and everything lined up with it, from its
     padding around one control. */
  ${FRAMED} {
    --bb-sidebar-rail-padding: max(0px, calc((${unzoomed(TOP_BAR_HEIGHT_PX)} - var(--bb-sidebar-control-size)) / 2)) !important;
  }
  /* The page's card outline is a ::before inside a 1px padding, with its
     rounded corners cut by a clip-path and mask. */
  ${FRAMED} > main[data-sidebar="inset"] {
    border: 0 !important;
    border-radius: 0 !important;
    padding: 0 !important;
    clip-path: none !important;
    mask-image: none !important;
  }
  ${FRAMED} > main[data-sidebar="inset"]::before {
    border-color: transparent !important;
    border-radius: 0 !important;
  }
  /* The title bar's controls float over the top bar. Back and forward hide
     but stay mounted, because History keys' Ctrl+O / Ctrl+I click them and
     their box marks where the window buttons end. */
  /* The title bar spans the whole top bar but must not drag the window:
     Electron drag regions ignore pointer-events, and the title bar paints
     over the page header, so it would swallow clicks on the header's buttons.
     The header drags the window itself, leaving its buttons clickable. */
  ${TITLE_BAR} {
    ${UNZOOM}
    --bb-window-title-bar-height: ${TOP_BAR_HEIGHT_PX}px !important;
    pointer-events: none;
    app-region: initial !important;
    -webkit-app-region: initial !important;
  }
  /* With the title bar no longer dragging, the window buttons' corner above
     the sidebar needs a drag strip of its own. */
  ${FRAMED} ${SIDEBAR} > [data-sidebar="panel"]::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: ${unzoomed(TOP_BAR_HEIGHT_PX)};
    pointer-events: none;
    app-region: drag;
    -webkit-app-region: drag;
  }
  ${TITLE_BAR} > div {
    pointer-events: auto;
  }
  ${TITLE_BAR_CONTROLS},
  ${SIDEBAR_TRIGGER_OVERLAY} {
    visibility: hidden !important;
    pointer-events: none !important;
  }
  /* The rail, and the Settings, Plugins, and Skills lists beside it, start
     below the window buttons. */
  ${FRAMED} ${RAIL} {
    padding-top: ${unzoomed(TOP_BAR_HEIGHT_PX)};
  }
  ${FRAMED} [data-testid="nav-rail-sidebar-body"] {
    margin-top: ${unzoomed(TOP_BAR_HEIGHT_PX)};
  }
  /* One seamless frame: the sidebar wears the page header's surface, and the
     lines between sidebar, top bar, and page go away. */
  ${FRAMED} ${SIDEBAR} > [data-sidebar="panel"] {
    background: ${HEADER_SURFACE} !important;
    border-right-color: transparent !important;
  }
  ${FRAMED} ${SIDEBAR} ${RAIL} {
    background: transparent !important;
  }
  [${FRAME_ATTRIBUTE}] {
    height: ${unzoomed(TOP_BAR_HEIGHT_PX)} !important;
    border-bottom-color: transparent !important;
    background: ${HEADER_SURFACE} !important;
  }
  /* The new-thread page has no page header, only a see-through drag strip
     over its backdrop, so the strip stands in as the top bar. */
  [data-testid="root-compose-main-window-drag-strip"] {
    background: ${HEADER_SURFACE};
  }
  /* One top-bar height for every page, centered on the macOS window buttons
     (about 25px down). The root value is a plain length, set from script,
     because bb parses it as a number to place its find bar. */
  :root {
    --bb-app-chrome-row-height: var(${TOP_BAR_PROPERTY}, ${TOP_BAR_HEIGHT_PX}px) !important;
  }
  [${FRAME_ATTRIBUTE}] ${HEADER_ROW} {
    ${UNZOOM}
    --bb-app-chrome-row-height: ${TOP_BAR_HEIGHT_PX}px !important;
    height: ${TOP_BAR_HEIGHT_PX}px !important;
    transform: none !important;
    padding-left: var(${CLEAR_LEFT}, 0px) !important;
    padding-right: var(${CLEAR_RIGHT}, 0px) !important;
  }
  ${FRAMED} ${PANEL_CHROME} {
    padding-right: var(${CLEAR_RIGHT}, var(--bb-panel-chrome-padding)) !important;
  }
}
`;

/**
 * bb's zoom factor, read from how much wider the window is than its CSS
 * viewport since bb only reports zoom when it changes. Browsers put their own
 * chrome in that difference, so only bb's desktop app is measured.
 */
export function pageZoom(win: Window): number {
  if (!("bbDesktop" in win) || win.innerWidth <= 0) return 1;
  const steps = Math.round((win.outerWidth / win.innerWidth) * ZOOM_STEPS_PER_UNIT);
  return steps > 0 ? steps / ZOOM_STEPS_PER_UNIT : 1;
}

function applyZoom(doc: Document, zoom: number) {
  const root = doc.documentElement.style;
  if (zoom === 1) {
    root.removeProperty(ZOOM_PROPERTY);
    root.removeProperty(TOP_BAR_PROPERTY);
    return;
  }
  root.setProperty(ZOOM_PROPERTY, String(zoom));
  root.setProperty(TOP_BAR_PROPERTY, `${TOP_BAR_HEIGHT_PX / zoom}px`);
}

/**
 * How far a top-bar row must indent from each side so its content clears the
 * controls floating over the top bar: the macOS window buttons on the left,
 * the right panel toggle on the right. Positions are in page pixels; the
 * indents are in the row's own, which zoom keeps at screen size.
 */
export function headerClearance(
  header: { left: number; right: number },
  padding: { left: number; right: number },
  controls: { leftEnd: number | null; rightStart: number | null },
  zoom = 1,
): { left: number; right: number } {
  const clear = (overlap: number, gap: number) => Math.max(0, Math.ceil(overlap * zoom + gap));
  return {
    left: controls.leftEnd === null ? 0 : clear(controls.leftEnd - (header.left + padding.left), HEADER_GAP_PX),
    right:
      controls.rightStart === null
        ? 0
        : clear(header.right - padding.right - controls.rightStart, PANEL_TOGGLE_GAP_PX),
  };
}

function setClearance(row: HTMLElement, property: string, px: number) {
  if (px > 0) row.style.setProperty(property, `${px}px`);
  else row.style.removeProperty(property);
}

const headerOf = (row: HTMLElement) => row.parentElement ?? row;

function clearRow(row: HTMLElement) {
  headerOf(row).removeAttribute(FRAME_ATTRIBUTE);
  row.style.removeProperty(CLEAR_LEFT);
  row.style.removeProperty(CLEAR_RIGHT);
}

/** Where a visible control floating over the top bar starts and ends, in page pixels. */
function controlBox(doc: Document, selector: string): DOMRect | null {
  const control = doc.querySelector(selector);
  if (control === null || control.getClientRects().length === 0) return null;
  return control.getBoundingClientRect();
}

/** The boxes whose size decides the top bar's indents. */
function topBarBoxes(doc: Document): HTMLElement[] {
  return [
    ...[...doc.querySelectorAll<HTMLElement>(HEADER_ROW)].map(headerOf),
    ...doc.querySelectorAll<HTMLElement>(PANEL_CHROME),
  ];
}

/**
 * Marks the page headers in the top row as the top bar and indents them, and
 * side panels' tab strips, clear of the controls that float over them.
 */
export function arrangeHeaders(doc: Document, isWide: boolean, zoom = 1): void {
  const rows = [...doc.querySelectorAll<HTMLElement>(HEADER_ROW)];
  const chromes = [...doc.querySelectorAll<HTMLElement>(PANEL_CHROME)];
  if (!isWide) {
    rows.forEach(clearRow);
    chromes.forEach((chrome) => chrome.style.removeProperty(CLEAR_RIGHT));
    return;
  }
  const topRowBottom = TOP_BAR_HEIGHT_PX / zoom;
  // The hidden back button sits just past the window buttons, so its left
  // edge is where header content may start.
  const back = controlBox(doc, `${FRAMED} ${TITLE_BAR_CONTROLS}`);
  const panelToggle = controlBox(doc, `${FRAMED} ${PANEL_TOGGLE}`);
  for (const row of rows) {
    const header = headerOf(row);
    const box = header.getBoundingClientRect();
    if (box.top >= topRowBottom) {
      clearRow(row);
      continue;
    }
    header.setAttribute(FRAME_ATTRIBUTE, "");
    const style = getComputedStyle(header);
    const clearance = headerClearance(
      box,
      { left: Number.parseFloat(style.paddingLeft) || 0, right: Number.parseFloat(style.paddingRight) || 0 },
      {
        leftEnd: back?.left ?? null,
        rightStart: panelToggle !== null && panelToggle.left < box.right ? panelToggle.left : null,
      },
      zoom,
    );
    setClearance(row, CLEAR_LEFT, clearance.left);
    setClearance(row, CLEAR_RIGHT, clearance.right);
  }
  // A tab strip's own padding is replaced rather than added to, and it is not
  // unzoomed, so it is measured without either.
  for (const chrome of chromes) {
    const box = chrome.getBoundingClientRect();
    const overlapsToggle =
      panelToggle !== null && box.top < topRowBottom && panelToggle.left < box.right && panelToggle.right > box.left;
    const { right } = headerClearance(
      box,
      { left: 0, right: 0 },
      { leftEnd: null, rightStart: overlapsToggle ? panelToggle.left : null },
    );
    setClearance(chrome, CLEAR_RIGHT, right);
  }
}

/**
 * Observes exactly these boxes. Each box is observed once: observing it again
 * reports its size again, which would re-arrange every frame.
 */
function observeOnly(observer: ResizeObserver, observed: Set<Element>, boxes: Element[]) {
  const wanted = new Set(boxes);
  for (const box of observed) {
    if (!wanted.has(box)) {
      observer.unobserve(box);
      observed.delete(box);
    }
  }
  for (const box of wanted) {
    if (!observed.has(box)) {
      observer.observe(box);
      observed.add(box);
    }
  }
}

/** Installs the stylesheet and keeps the top bar sized and indented; returns cleanup. */
export function mountTopBarFrame(doc: Document, win: Window): () => void {
  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = TOP_BAR_FRAME_CSS;
  doc.head.append(style);
  const wide = win.matchMedia(WIDE_VIEWPORT);
  let frame = 0;
  const schedule = () => {
    if (frame !== 0) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      const zoom = pageZoom(win);
      applyZoom(doc, zoom);
      arrangeHeaders(doc, wide.matches, zoom);
      if (resized !== null) observeOnly(resized, observed, topBarBoxes(doc));
    });
  };
  const observer = new MutationObserver(schedule);
  // A side panel opening or closing animates the page's width after the
  // mutation that starts it, so the indents are measured again once it settles.
  const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  const observed = new Set<Element>();
  // data-state and class changes move headers: the sidebar collapsing, a
  // panel opening.
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state", "class"],
  });
  win.addEventListener("resize", schedule);
  wide.addEventListener("change", schedule);
  schedule();
  return () => {
    observer.disconnect();
    resized?.disconnect();
    win.removeEventListener("resize", schedule);
    wide.removeEventListener("change", schedule);
    if (frame !== 0) win.cancelAnimationFrame(frame);
    style.remove();
    applyZoom(doc, 1);
    doc.querySelectorAll<HTMLElement>(HEADER_ROW).forEach(clearRow);
    doc.querySelectorAll<HTMLElement>(PANEL_CHROME).forEach((chrome) => chrome.style.removeProperty(CLEAR_RIGHT));
  };
}
