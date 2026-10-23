export const SLOT_ATTRIBUTE = "data-composer-status-slot";
export const ANCHOR_ATTRIBUTE = "data-composer-status-anchor";
/** Marks the plugin's own pieces so container queries can drop them by priority. */
export const PART_ATTRIBUTE = "data-composer-status-part";
/** On the composer while the footer shows its model picker, so bb's copy in the prompt box can step aside. */
export const PICKER_ATTRIBUTE = "data-composer-status-picker";
/** The badge in bb's changes bar saying whether the branch has landed. */
export const LANDED_ATTRIBUTE = "data-composer-status-landed";
export type PartName = "model-picker" | "model" | "effort-separator" | "effort" | "limit" | "tokens-used";
const STYLE_ATTRIBUTE = "data-composer-status-bar";
// Phone widths keep bb's touch-sized footer.
const WIDE_VIEWPORT = "(min-width: 768px)";

// bb's composer markup has no plugin contract, so these selectors and the
// stylesheet below follow the shipped DOM; a bb update that renames them just
// leaves bb's normal footer.
export const COMPOSER = "[data-app-composer]";
const FOOTER = "[data-follow-up-composer-footer]";
const PERMISSION_BUTTON = 'button[aria-label="Permission mode"]';
const CONTEXT_BUTTON = 'button[aria-label^="Context window"]';
const NATIVE_MODEL_PICKER = `button[aria-label^="Provider, model and reasoning"]:not([${PART_ATTRIBUTE}] > button)`;
const LEFT = `${FOOTER} > div:first-child`;
const RIGHT = `${FOOTER} > div:last-child`;
const PROJECT = `${LEFT} > div > div[data-option-display]`;
const ENVIRONMENT = `${LEFT} > div > div:not([data-option-display])`;
const BRANCH = `${LEFT} [data-promptbox-hide-branch-compact]`;
const NEW_THREAD = `${LEFT} button[aria-label="New thread in this environment"]`;
const PERMISSION = `${RIGHT} ${PERMISSION_BUTTON}`;
const CONTEXT = `${RIGHT} ${CONTEXT_BUTTON}`;
const part = (name: PartName) => `[${PART_ATTRIBUTE}="${name}"]`;
const MODEL_PICKER = `${part("model-picker")} > button`;

// Layout: where the work happens on the left (project / environment, branch);
// on the right, usage (limit, context) and then the agent (model · effort,
// permission), so permission sits under the send button. CSS order does the
// arranging because these are bb's React nodes.
// Buttons wear an outlined chip; labels are plain text. Instead of truncating,
// narrower footers drop detail in priority order.
export const FOOTER_CSS = `
@media ${WIDE_VIEWPORT} {
  ${COMPOSER} {
    container: composer-box / inline-size;
  }
  /* Matches the footer's 420px cutoff for its own picker, so one of the two is always there. bb's stays laid out but
     invisible and zero-width, rather than display: none, so its ⇧⌘M shortcut still anchors the menu in the composer. */
  @container composer-box (min-width: 421px) {
    ${COMPOSER}[${PICKER_ATTRIBUTE}] ${NATIVE_MODEL_PICKER} {
      visibility: hidden !important;
      width: 0 !important;
      min-width: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
      overflow: hidden !important;
    }
  }
  ${FOOTER} {
    container: composer-status / inline-size;
    gap: 0.5rem !important;
    /* Chips line up with the composer box's edges, not with its content. */
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
  ${LEFT} > div {
    gap: 0.375rem !important;
    padding-right: 0 !important;
  }
  ${RIGHT} {
    gap: 0.375rem !important;
  }

  /* Labels: no chip padding, no pointer, quiet icons. */
  ${PROJECT},
  ${ENVIRONMENT},
  ${ENVIRONMENT} > div[data-option-display] {
    cursor: default !important;
    flex-shrink: 0 !important;
    gap: 0.25rem !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
  ${PROJECT} [data-icon-root] {
    width: 0.875rem !important;
    height: 0.875rem !important;
    opacity: 0.6;
  }
  /* "my-bb-plugins / Worktree" reads as one location. */
  ${ENVIRONMENT} > [data-icon-root] {
    display: none !important;
  }
  ${ENVIRONMENT}::before {
    content: "/";
    color: var(--subtle-foreground);
  }

  /* Controls: an outlined chip at rest, bb's hover fill on hover. */
  ${BRANCH},
  ${PERMISSION},
  ${CONTEXT},
  ${MODEL_PICKER} {
    height: 1.375rem !important;
    margin: 0 !important;
    border-radius: 0.375rem !important;
    box-shadow: inset 0 0 0 1px var(--border-hairline);
    flex-shrink: 0 !important;
  }
  /* The branch is reference, not a control you reach for: quiet text until
     hovered, when it shows the same outline as the other chips. */
  ${BRANCH} {
    flex: 0 1 auto !important;
    min-width: 5rem !important;
    gap: 0.25rem !important;
    padding: 0 0.375rem !important;
    box-shadow: none;
    color: var(--subtle-foreground) !important;
  }
  ${BRANCH}:hover {
    box-shadow: inset 0 0 0 1px var(--border-hairline);
    color: var(--foreground) !important;
  }
  /* New threads start from the sidebar or the project picker. */
  ${NEW_THREAD} {
    display: none !important;
  }
  ${PERMISSION} {
    order: 4;
    padding: 0 0.25rem 0 0.5rem !important;
  }
  ${PERMISSION} [data-promptbox-full-label] {
    display: none !important;
  }
  ${PERMISSION} [data-promptbox-compact-label] {
    display: inline !important;
  }
  ${CONTEXT} {
    order: 2;
    width: auto !important;
    gap: 0.375rem !important;
    padding: 0 0.375rem 0 0.5rem !important;
  }
  /* The token count inside the chip says the same thing more precisely. */
  ${CONTEXT} > span[aria-hidden] {
    display: none !important;
  }
  ${CONTEXT} > svg {
    width: 0.875rem !important;
    height: 0.875rem !important;
  }

  [${SLOT_ATTRIBUTE}] {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    white-space: nowrap;
    font-size: 0.75rem;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  [${SLOT_ATTRIBUTE}="context"] {
    gap: 0;
  }
  [${SLOT_ATTRIBUTE}="usage"] {
    order: 1;
    color: var(--muted-foreground);
  }
  [${SLOT_ATTRIBUTE}="agent"] {
    order: 3;
    color: var(--muted-foreground);
  }
  /* bb's own model picker, dressed as the chip beside it: no provider logo, "model · effort". */
  ${MODEL_PICKER} {
    gap: 0.25rem !important;
    padding: 0 0.25rem 0 0.5rem !important;
  }
  ${MODEL_PICKER} > span > span[aria-hidden]:first-child {
    display: none !important;
  }
  ${MODEL_PICKER} > span > span:last-child::before {
    content: "· ";
  }
  ${MODEL_PICKER} > svg {
    width: 0.875rem !important;
    height: 0.875rem !important;
  }
  ${part("effort")} {
    color: var(--subtle-foreground);
  }
  ${part("limit")} {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--warning-text);
  }
  ${part("limit")}[data-blocked] {
    color: var(--destructive);
  }
  @container composer-status (max-width: 680px) {
    ${ENVIRONMENT} { display: none !important; }
  }
  @container composer-status (max-width: 540px) {
    ${PROJECT} [data-promptbox-full-label],
    ${PROJECT} [data-promptbox-compact-label] { display: none !important; }
  }
  @container composer-status (max-width: 480px) {
    ${part("effort")},
    ${part("effort-separator")},
    ${MODEL_PICKER} > span > span:last-child { display: none !important; }
  }
  @container composer-status (max-width: 420px) {
    [${SLOT_ATTRIBUTE}="agent"] { display: none !important; }
  }
}
${COMPOSER} *:has(> [${ANCHOR_ATTRIBUTE}]) {
  display: none !important;
}
/* Inside bb's changes bar, after its truncating label; the label gives way first. */
[${LANDED_ATTRIBUTE}] {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  font-size: 0.75rem;
  white-space: nowrap;
}
[${LANDED_ATTRIBUTE}] > span {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
}
[${LANDED_ATTRIBUTE}] > span::before {
  content: "·";
  margin-right: 0.25rem;
  color: var(--subtle-foreground);
}
[${LANDED_ATTRIBUTE}] > [data-tone="landed"] { color: var(--success); }
[${LANDED_ATTRIBUTE}] > [data-tone="unpushed"] { color: var(--warning-text); }
[${LANDED_ATTRIBUTE}] > [data-tone="pending"] { color: var(--muted-foreground); }
[${LANDED_ATTRIBUTE}] > [data-tone="conflicts"] { color: var(--destructive-text); }
/* bb's model picker (from this bar or ⇧⌘M) lays its reasoning levels out in one centred row sized for bb's own font;
   six levels in a wider font overflow both edges of the menu, so they go in a grid instead. */
[data-radix-popper-content-wrapper] [role="radiogroup"][aria-label="Reasoning"] {
  display: grid !important;
  grid-template-columns: repeat(auto-fit, minmax(5.5rem, 1fr));
}
`;

/** Installs the footer stylesheet; returns cleanup. */
export function mountComposerStatusBar(doc: Document): () => void {
  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = FOOTER_CSS;
  doc.head.append(style);
  return () => style.remove();
}

export type SlotName = "agent" | "usage" | "context";
export type FooterSlots = Partial<Record<SlotName, HTMLElement>>;

// Each slot keeps its place next to the bb control it belongs with: agent
// before permission mode, usage before the context ring, and the token count
// inside the ring's button.
export function ensureFooterSlots(composerRoot: Element): FooterSlots {
  const footer = composerRoot.querySelector(FOOTER);
  const left = footer?.firstElementChild;
  const right = footer?.lastElementChild;
  if (!(left instanceof HTMLElement) || !(right instanceof HTMLElement) || left === right) {
    return {};
  }
  const permission = right.querySelector(`:scope > ${PERMISSION_BUTTON}`);
  const context = right.querySelector<HTMLElement>(`:scope > ${CONTEXT_BUTTON}`);
  const slots: FooterSlots = {
    agent: placeSlot(right, "agent", permission ?? right.firstChild, "div"),
    usage: placeSlot(right, "usage", context, "div"),
  };
  if (context !== null) slots.context = placeSlot(context, "context", context.firstChild, "span");
  return slots;
}

function placeSlot(
  parent: HTMLElement,
  name: SlotName,
  before: Node | null,
  tag: "div" | "span",
): HTMLElement {
  let slot = parent.querySelector<HTMLElement>(`:scope > [${SLOT_ATTRIBUTE}="${name}"]`);
  if (slot === null) {
    slot = parent.ownerDocument.createElement(tag);
    slot.setAttribute(SLOT_ATTRIBUTE, name);
  }
  // Only move when out of place: each insert re-triggers the caller's observer.
  const placed = slot.parentNode === parent && slot.nextSibling === before;
  if (!placed && slot !== before) parent.insertBefore(slot, before);
  return slot;
}
