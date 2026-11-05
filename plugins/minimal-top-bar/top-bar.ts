export const TITLE_CLICK_DELAY_MS = 250;
const STYLE_ATTRIBUTE = "data-minimal-top-bar";
const HIDDEN_ATTRIBUTE = "data-minimal-top-bar-hidden";

// bb's top bar markup has no plugin contract, so these selectors and the
// stylesheet below follow the shipped DOM; a bb update that renames them just
// leaves bb's normal top bar.
const HEADER_ROW = '[data-testid="app-page-header-content-row"]';
const THREAD_TITLE = ".bb-thread-title";
// Matches while renaming too, when bb swaps the title for an input.
const TITLE_ROW = `${HEADER_ROW}:has(${THREAD_TITLE}, p input)`;
const TITLE_GROUP = `${TITLE_ROW} div:has(> div > p > ${THREAD_TITLE})`;
const MENU_TRIGGER = 'button[aria-label="Thread actions"]';
const WORKFLOW_ACTION =
  "[data-thread-header-workflow-actions] [data-thread-header-responsive-action]";
const RAIL_SIDEBAR = '[data-side="left"][data-collapsible="rail"]';
// The Settings, Plugins, and Skills pages mount their page list in the
// sidebar, even while it is collapsed to the rail.
const LIST_PAGES =
  '[data-testid="settings-sidebar-body"], [data-testid="plugins-sidebar-body"], [data-testid="skills-sidebar-body"]';
const LIST_PAGE_SIDEBAR = `${RAIL_SIDEBAR}:has(${LIST_PAGES})`;
const RAIL_ONLY_SIDEBAR = `${RAIL_SIDEBAR}:not(:has(${LIST_PAGES}))`;
const LIST_BODY = '[data-testid="nav-rail-sidebar-body"]';
const FOOTER_BODY = '[data-testid="sidebar-footer-body"]';
// One grid holds the rail and list over the footer: the rail column has the
// rail above the Settings cell, the list column the list above the footer's
// other icons.
const SIDEBAR_GRID = `[data-sidebar="sidebar"] > div:has(> ${FOOTER_BODY})`;
const SETTINGS_CELL = `${SIDEBAR_GRID} > div:not([data-sidebar])`;
// A footer icon's disclosure (Provider usage) and More → Customize footer
// open at the bottom of the thread list, which the rail hides.
const FOOTER_PANEL_CONTENT =
  ':is([data-testid^="plugin-sidebar-footer-disclosure-"], [data-testid="sidebar-footer-customize-inline"])';
const FOOTER_PANEL = `${RAIL_ONLY_SIDEBAR} [data-testid="app-sidebar-body"] > div:has(${FOOTER_PANEL_CONTENT})`;
const INERT_IN_RAIL = `${RAIL_SIDEBAR} :is(${LIST_BODY}, ${FOOTER_BODY})[inert]`;
const RAIL_COLUMN = "(var(--bb-sidebar-control-size) + 2 * var(--bb-sidebar-rail-padding))";
/** Wide enough that bb never folds a footer icon into its More menu. */
const FOOTER_MEASURE_WIDTH_PX = 400;
const FOOTER_ICON_PX = 32;
// bb only renders this element at desktop widths; compact windows get a
// drawer, which is itself the panel.
const EXPANDED_SIDEBAR =
  '[data-side="left"][data-variant="sidebar"][data-state="expanded"]:not([data-sidebar])';
const SIDEBAR_TRIGGER = '[data-sidebar="trigger"]';

export const MINIMAL_TOP_BAR_CSS = `
/* Top-bar clutter with keyboard equivalents: open in editor/terminal is
   Cmd+O, close pane is Cmd+W. */
button[aria-label^="Open workspace in "],
button[aria-label="Choose another app to open workspace"],
button[aria-label="Close pane"] {
  display: none !important;
}
/* The thread list is replaced by the Project switcher's picker, so nothing
   should open or close the sidebar (see collapseSidebar). */
${SIDEBAR_TRIGGER} {
  display: none !important;
}
/* Without the toggle a sidebar collapsed to the rail can't reopen, so the
   pages whose list is their navigation show it beside the rail anyway. */
${LIST_PAGE_SIDEBAR} > [data-sidebar="gap"],
${LIST_PAGE_SIDEBAR} > [data-sidebar="panel"] {
  width: var(--sidebar-width) !important;
}
${LIST_PAGE_SIDEBAR} ${LIST_BODY},
${LIST_PAGE_SIDEBAR} ${FOOTER_BODY} {
  visibility: visible !important;
}
/* Elsewhere the footer's own icons (Provider usage, More footer actions,
   update badges) sit beside Settings, in the column the rail hides, so they
   move into a row of the rail's column above it instead. */
${RAIL_ONLY_SIDEBAR} ${SIDEBAR_GRID} {
  grid-template-rows: minmax(0, 1fr) auto auto !important;
}
${RAIL_ONLY_SIDEBAR} ${SETTINGS_CELL} {
  grid-row: 3 !important;
}
/* Its own width, not its wide menu's, so the rail column keeps its size. */
${RAIL_ONLY_SIDEBAR} ${FOOTER_BODY} {
  grid-row: 2 !important;
  grid-column: 1 !important;
  width: calc(${RAIL_COLUMN}) !important;
  visibility: visible !important;
  border-color: transparent !important;
  border-radius: 0 !important;
  background-color: var(--surface-recessed);
}
[data-framed] ${RAIL_ONLY_SIDEBAR} ${FOOTER_BODY} {
  background-color: transparent;
}
${RAIL_ONLY_SIDEBAR} ${FOOTER_BODY} > div {
  width: auto !important;
}
/* bb shows as many footer icons as fit across the footer's width and folds
   the rest into a More menu. A wide, click-through list keeps them all
   visible while they stack. */
${RAIL_ONLY_SIDEBAR} ${FOOTER_BODY} [data-sidebar="footer"] {
  align-items: flex-start;
  padding: 8px 0 0 calc(${RAIL_COLUMN} / 2 - ${FOOTER_ICON_PX / 2}px);
}
${RAIL_ONLY_SIDEBAR} ${FOOTER_BODY} ul[data-sidebar="menu"] {
  flex-direction: column !important;
  align-items: flex-start !important;
  width: ${FOOTER_MEASURE_WIDTH_PX}px !important;
  max-width: none !important;
  pointer-events: none;
}
${RAIL_ONLY_SIDEBAR} ${FOOTER_BODY} li[data-sidebar="menu-item"] {
  flex: none;
  min-width: 0;
}
${RAIL_ONLY_SIDEBAR} ${FOOTER_BODY} :is(a, button) {
  pointer-events: auto;
}
/* The update badges are labelled pills sized for the full sidebar; in the
   rail they shrink to icon circles, and the tooltip still names the update. */
${RAIL_ONLY_SIDEBAR} ${FOOTER_BODY} :has(> [data-testid^="sidebar-updates-badge"]) {
  flex-direction: column;
  max-width: none;
}
${RAIL_ONLY_SIDEBAR} [data-testid^="sidebar-updates-badge"] {
  width: ${FOOTER_ICON_PX}px;
  height: ${FOOTER_ICON_PX}px;
  justify-content: center;
  gap: 0;
  padding: 0;
  font-size: 0;
}
${RAIL_ONLY_SIDEBAR} [data-testid="sidebar-updates-badge-providers"] > svg:not(.animate-spin),
${RAIL_ONLY_SIDEBAR} [data-testid="sidebar-updates-badge-providers"]:has(> svg.animate-spin) > span {
  display: none;
}
${RAIL_ONLY_SIDEBAR} [data-testid="sidebar-updates-badge-providers"] > span {
  flex-wrap: wrap;
  justify-content: center;
}
/* So it floats as a card beside the rail, above the footer. The list's
   clip-path would clip it even though it is fixed. */
${FOOTER_PANEL} {
  visibility: visible;
  position: fixed;
  left: calc(var(--sidebar-rail-width) + 4px);
  bottom: 8px;
  width: 280px;
  padding: 0 !important;
  overflow: hidden;
  border: 1px solid var(--sidebar-border);
  border-radius: 0.5rem;
  background: var(--sidebar);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
}
${FOOTER_PANEL} [data-testid^="plugin-sidebar-footer-disclosure-"] {
  border: 0;
  border-radius: 0;
}
${RAIL_ONLY_SIDEBAR}:has(${FOOTER_PANEL_CONTENT}) ${LIST_BODY} {
  clip-path: none !important;
}
[${HIDDEN_ATTRIBUTE}] {
  display: none !important;
}
/* Thread titles sit centered in the top bar. A click on the title opens
   the thread menu (see installTitleMenu), so bb's ⋯ trigger is hidden but
   kept at the title's end, where the menu anchors. */
${TITLE_ROW} > div:first-child {
  justify-content: center;
}
${TITLE_ROW} input {
  text-align: center;
}
${TITLE_GROUP} {
  gap: 0 !important;
}
${TITLE_GROUP} > span:has(> ${MENU_TRIGGER}) {
  width: 0;
  overflow: visible;
}
${TITLE_GROUP} ${MENU_TRIGGER} {
  opacity: 0;
  pointer-events: none;
}
${TITLE_ROW} ${THREAD_TITLE} {
  cursor: pointer;
  transition: transform var(--bbm-duration-fast) var(--bbm-ease-out);
}
/* The menu opens only once the double-click window has passed, so the
   title answers the press itself. Half the usual press depth, because the
   title is wide and a full one squeezes it visibly. */
${TITLE_ROW} ${THREAD_TITLE}:active {
  transform: scale(calc((1 + var(--bbm-scale-press)) / 2));
  transition-duration: var(--bbm-duration-instant);
}
`;

/**
 * bb's Commit button carries no label of its own, only its text, so it is
 * found by that inside the header's workflow actions.
 */
function hideCommitButtons(doc: Document, hide: boolean) {
  for (const action of doc.querySelectorAll(WORKFLOW_ACTION)) {
    const isCommit =
      action.querySelector("button")?.textContent?.trim() === "Commit";
    if (hide && isCommit) action.setAttribute(HIDDEN_ATTRIBUTE, "");
    else action.removeAttribute(HIDDEN_ATTRIBUTE);
  }
}

/**
 * Keeps the sidebar collapsed to the rail. bb remembers it open, opens it by
 * default, and opens it on its sidebar.toggle key, so the hidden toggle is
 * pressed whenever it shows; that also saves the collapsed state. Not while
 * something in it holds focus: bb's `/` on a settings page opens the sidebar
 * to focus its search box, and collapsing then would blur the box. It
 * collapses once focus leaves.
 */
function collapseSidebar(doc: Document) {
  const sidebar = doc.querySelector(EXPANDED_SIDEBAR);
  if (sidebar === null || sidebar.contains(doc.activeElement)) return;
  doc.querySelector<HTMLElement>(SIDEBAR_TRIGGER)?.click();
}

/**
 * bb marks the list and the footer's icons `inert` while the sidebar is
 * collapsed to the rail, which no stylesheet can undo, so the page lists, the
 * stacked footer icons, and a footer panel shown above would take no clicks.
 * What stays hidden is still unreachable, since it is `visibility: hidden`.
 */
function liftRailInert(doc: Document, lifted: Set<Element>) {
  for (const element of doc.querySelectorAll(INERT_IN_RAIL)) {
    element.removeAttribute("inert");
    lifted.add(element);
  }
}

function restoreRailInert(lifted: Set<Element>) {
  for (const element of lifted) {
    if (element.isConnected && element.closest(RAIL_SIDEBAR) !== null) element.setAttribute("inert", "");
  }
  lifted.clear();
}

/**
 * A single click on a header title opens the thread menu. It waits briefly so
 * a double-click still reaches bb's rename. Wide windows get a radix dropdown,
 * which opens on pointerdown; compact ones get a sheet, which opens on click.
 */
function installTitleMenu(doc: Document, win: Window): () => void {
  let timer = 0;
  const cancel = () => {
    if (timer !== 0) win.clearTimeout(timer);
    timer = 0;
  };
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const title = target?.closest(THREAD_TITLE);
    const row = title?.closest(HEADER_ROW);
    if (!title || !row) return;
    cancel();
    if (event.detail > 1) return;
    timer = win.setTimeout(() => {
      timer = 0;
      const trigger = row.querySelector<HTMLButtonElement>(MENU_TRIGGER);
      if (!trigger || title.closest("p")?.querySelector("input")) return;
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
      if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    }, TITLE_CLICK_DELAY_MS);
  };
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("dblclick", cancel, true);
  return () => {
    cancel();
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("dblclick", cancel, true);
  };
}

/** Installs the stylesheet and keeps the Commit button hidden; returns cleanup. */
export function mountMinimalTopBar(doc: Document, win: Window): () => void {
  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = MINIMAL_TOP_BAR_CSS;
  doc.head.append(style);
  const lifted = new Set<Element>();
  let frame = 0;
  const schedule = () => {
    if (frame !== 0) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      hideCommitButtons(doc, true);
      collapseSidebar(doc);
      liftRailInert(doc, lifted);
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state", "data-collapsible", "class", "inert"],
  });
  // Focus settles on its new target by the next frame, when schedule runs.
  doc.addEventListener("focusout", schedule);
  schedule();
  const removeTitleMenu = installTitleMenu(doc, win);
  return () => {
    observer.disconnect();
    doc.removeEventListener("focusout", schedule);
    if (frame !== 0) win.cancelAnimationFrame(frame);
    style.remove();
    hideCommitButtons(doc, false);
    restoreRailInert(lifted);
    removeTitleMenu();
  };
}
