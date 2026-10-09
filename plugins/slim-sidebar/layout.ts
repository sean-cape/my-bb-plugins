const RAIL_WIDTH_PX = 52;
const TOP_BAR_HEIGHT_PX = 50;
const CUSTOMIZE_WIDTH_PX = 280;
const FOOTER_INSET_PX = 10;
const FOOTER_MEASURE_WIDTH_PX = 400;
const FOOTER_ICON_PX = 32;
const FOOTER_GLYPH_PX = 16;
const HEADER_GAP_PX = 20;
// Phone-width windows keep bb's stock chrome.
const WIDE_VIEWPORT = "(min-width: 768px)";
const STYLE_ATTRIBUTE = "data-slim-sidebar";
const CLEAR_ATTRIBUTE = "data-slim-sidebar-clear";
const CLEAR_PROPERTY = "--slim-sidebar-clear";
const FRAME_ATTRIBUTE = "data-slim-sidebar-frame";
// bb's page header paints bg-surface-scrim over the page's bg-background.
const HEADER_SURFACE =
  "linear-gradient(var(--surface-scrim), var(--surface-scrim)), var(--background)";

// bb's sidebar and header markup has no plugin contract, so these selectors
// and the stylesheet below follow the shipped DOM; a bb update that renames
// them just leaves the normal sidebar.
const ANY_SIDEBAR = '[data-side="left"][data-variant="sidebar"]';
// Settings, Plugins, and Skills swap their own navigation into the same
// sidebar element; only the main one carries the app resize handle.
export const SIDEBAR = `${ANY_SIDEBAR}:has([data-testid="app-sidebar-resize-handle"])`;
const SIDEBAR_TRIGGER = '[data-testid="app-desktop-sidebar-trigger"]';
const FALLBACK_SIDEBAR_TRIGGER = '[data-sidebar="trigger"]';
const HEADER_ROW = '[data-testid="app-page-header-content-row"]';

export const SLIM_SIDEBAR_CSS = `
@media ${WIDE_VIEWPORT} {
  ${SIDEBAR} > [data-sidebar="gap"],
  ${SIDEBAR} > [data-sidebar="panel"] {
    --sidebar-width: ${RAIL_WIDTH_PX}px !important;
  }
  ${SIDEBAR} [data-testid="app-sidebar-resize-handle"] {
    display: none !important;
  }
  /* Back/forward don't fit the rail's top row. The buttons stay mounted
     because History keys' Ctrl+O / Ctrl+I click them. */
  [data-testid="app-sidebar-top-reserve-row"] > div {
    display: none !important;
  }
  /* No sidebar toggle (Cmd+\ still works). Hidden rather than removed so its
     box still marks where macOS's window buttons end. */
  [data-testid="app-sidebar-trigger-overlay"],
  ${SIDEBAR_TRIGGER} {
    visibility: hidden !important;
    pointer-events: none !important;
  }
  /* One seamless frame: the rail wears the page header's surface (its scrim
     over the page background), bb's darker sidebar fills inside it go
     transparent, and the lines between rail, top bar, and page go away. */
  ${SIDEBAR} > [data-sidebar="panel"] {
    background: ${HEADER_SURFACE};
    border-right-color: transparent !important;
  }
  ${SIDEBAR} .bg-sidebar {
    background-color: transparent !important;
  }
  ${SIDEBAR} [data-overflow-fade-tone="sidebar"] {
    display: none;
  }
  /* Top-row headers drop their see-through scrim for the same solid surface
     as the rail. */
  [${FRAME_ATTRIBUTE}] {
    border-bottom-color: transparent !important;
    background: ${HEADER_SURFACE} !important;
  }
  /* The new-thread page has no page header, only a see-through drag strip
     over its backdrop, so the strip stands in as the top bar. */
  [data-testid="root-compose-main-window-drag-strip"] {
    background: ${HEADER_SURFACE};
  }
  /* bb's own editor renders inline in the navigation area, so give it the
     normal width while it is open. */
  ${SIDEBAR}:has([data-testid="sidebar-navigation-customize-inline"]) > [data-sidebar="gap"],
  ${SIDEBAR}:has([data-testid="sidebar-navigation-customize-inline"]) > [data-sidebar="panel"] {
    --sidebar-width: ${CUSTOMIZE_WIDTH_PX}px !important;
  }
  /* bb shows as many footer icons as fit across the footer's width and folds
     the rest into a More menu. A wide, click-through list keeps them all
     visible while they stack vertically. */
  ${SIDEBAR} [data-sidebar="footer"] {
    align-items: flex-start;
    padding-left: ${FOOTER_INSET_PX}px;
    padding-right: 0;
  }
  ${SIDEBAR} [data-sidebar="footer"] ul[data-sidebar="menu"] {
    flex-direction: column !important;
    align-items: flex-start !important;
    width: ${FOOTER_MEASURE_WIDTH_PX}px !important;
    max-width: none !important;
    pointer-events: none;
  }
  ${SIDEBAR} [data-sidebar="footer"] li[data-sidebar="menu-item"] {
    flex: none;
    pointer-events: none;
  }
  /* Settings and Mobile render as links rather than buttons. */
  ${SIDEBAR} [data-sidebar="footer"] :is(a, button) {
    pointer-events: auto;
  }
  /* The update badges are labelled pills sized for the full sidebar. In the
     rail they stack as icon-only circles in the footer's icon column, and the
     tooltip still names the update. */
  ${SIDEBAR} [data-sidebar="footer"] :has(> [data-testid^="sidebar-updates-badge"]) {
    flex-direction: column;
    max-width: none;
  }
  ${SIDEBAR} [data-testid^="sidebar-updates-badge"] {
    width: ${FOOTER_ICON_PX}px;
    height: ${FOOTER_ICON_PX}px;
    justify-content: center;
    gap: 0;
    padding: 0;
    font-size: 0;
  }
  ${SIDEBAR} [data-testid^="sidebar-updates-badge"] > svg {
    width: ${FOOTER_GLYPH_PX}px;
    height: ${FOOTER_GLYPH_PX}px;
  }
  /* The provider badge shows which agents need updating, or its spinner while
     one installs. */
  ${SIDEBAR} [data-testid="sidebar-updates-badge-providers"] > svg:not(.animate-spin),
  ${SIDEBAR} [data-testid="sidebar-updates-badge-providers"]:has(> svg.animate-spin) > span {
    display: none;
  }
  ${SIDEBAR} [data-testid="sidebar-updates-badge-providers"] > span {
    flex-wrap: wrap;
    justify-content: center;
  }
  /* bb nudges desktop header content 2px below the row's center; without it
     the title lines up with the macOS window buttons, which sit on the row's
     center line. */
  ${HEADER_ROW} {
    --bb-macos-chrome-control-y: 0px !important;
  }
  /* One top-bar height for every page, thread or plugin, centered on the
     macOS window buttons (about 25px down). */
  :root {
    --bb-app-chrome-row-height: ${TOP_BAR_HEIGHT_PX}px !important;
  }
  [${FRAME_ATTRIBUTE}],
  [${FRAME_ATTRIBUTE}] ${HEADER_ROW} {
    height: ${TOP_BAR_HEIGHT_PX}px !important;
    transform: none !important;
  }
  [${CLEAR_ATTRIBUTE}] {
    padding-left: var(${CLEAR_PROPERTY}) !important;
  }
}
`;

/**
 * How far a page header row must indent so its content starts past the macOS
 * window buttons that sit over the top-left corner. Rows that start right of
 * the controls, or below the top row, need nothing.
 */
export function headerClearance(
  header: { left: number; top: number },
  headerPaddingLeft: number,
  controlsRight: number,
  topRowBottom: number,
): number {
  if (header.top >= topRowBottom) return 0;
  const contentLeft = header.left + headerPaddingLeft;
  return Math.max(0, Math.ceil(controlsRight + HEADER_GAP_PX - contentLeft));
}

function clearRow(row: HTMLElement) {
  row.removeAttribute(CLEAR_ATTRIBUTE);
  row.style.removeProperty(CLEAR_PROPERTY);
}

function clearHeader(header: Element) {
  header.removeAttribute(FRAME_ATTRIBUTE);
}

const headerOf = (row: HTMLElement) => row.parentElement ?? row;

/**
 * Marks the page headers in the top row as part of the frame and indents
 * those that would start under the macOS window buttons.
 */
export function arrangeHeaders(doc: Document, isWide: boolean): void {
  const sidebar = doc.querySelector(ANY_SIDEBAR);
  const trigger =
    doc.querySelector(`${SIDEBAR_TRIGGER} button`) ??
    doc.querySelector(FALLBACK_SIDEBAR_TRIGGER);
  const headerRows = [...doc.querySelectorAll<HTMLElement>(HEADER_ROW)];
  for (const row of headerRows) {
    clearRow(row);
    clearHeader(headerOf(row));
  }
  const expanded = sidebar?.getAttribute("data-state") === "expanded";
  if (!isWide || !expanded) {
    return;
  }
  // The hidden toggle sits just past the window buttons, so its left edge is
  // where header content may start. It is centered in the top row, so the row
  // ends as far below it as it starts below the window's top.
  const triggerRect = trigger?.getBoundingClientRect() ?? null;
  const controlsRight = triggerRect?.left ?? 0;
  const topRowBottom =
    triggerRect && triggerRect.bottom > 0
      ? triggerRect.bottom + triggerRect.top
      : TOP_BAR_HEIGHT_PX;
  for (const row of headerRows) {
    const header = headerOf(row);
    const headerRect = header.getBoundingClientRect();
    if (headerRect.top >= topRowBottom) continue;
    header.setAttribute(FRAME_ATTRIBUTE, "");
    const padding =
      Number.parseFloat(getComputedStyle(header).paddingLeft) || 0;
    const clearance = headerClearance(
      headerRect,
      padding,
      controlsRight,
      topRowBottom,
    );
    if (clearance > 0) {
      row.setAttribute(CLEAR_ATTRIBUTE, "");
      row.style.setProperty(CLEAR_PROPERTY, `${clearance}px`);
    }
  }
}

/** Installs the stylesheet and keeps the page headers arranged; returns cleanup. */
export function mountSlimSidebar(doc: Document, win: Window): () => void {
  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = SLIM_SIDEBAR_CSS;
  doc.head.append(style);
  const wide = win.matchMedia(WIDE_VIEWPORT);
  let frame = 0;
  const schedule = () => {
    if (frame !== 0) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      arrangeHeaders(doc, wide.matches);
    });
  };
  const observer = new MutationObserver(schedule);
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
    win.removeEventListener("resize", schedule);
    wide.removeEventListener("change", schedule);
    if (frame !== 0) win.cancelAnimationFrame(frame);
    style.remove();
    doc.querySelectorAll<HTMLElement>(`[${CLEAR_ATTRIBUTE}]`).forEach(clearRow);
    doc.querySelectorAll(`[${FRAME_ATTRIBUTE}]`).forEach(clearHeader);
  };
}
