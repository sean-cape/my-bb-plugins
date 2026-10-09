import type { Rect } from "./host";
import { logError } from "./log";
import {
  FOLLOW_UP_COMPOSER,
  PAGE_SCROLL_VIEWPORT,
  PROMPTBOX,
  TIMELINE_ROW_ID_ATTRIBUTE,
  TIMELINE_ROW_LIST,
  UI_ATTRIBUTE,
} from "./selectors";
import {
  comparePositions,
  compilePattern,
  isClipped,
  realizedRows,
  rowMatches,
  type MatchPosition,
} from "./transcript-search";
import { placeBar, placeIndicator, promptToolbarRow } from "./ui";

const LINE_STEP = 60;
const SEARCH_HIGHLIGHT = "bb-vim-search";
const CURRENT_HIGHLIGHT = "bb-vim-search-current";
/** Frames to wait for the virtualizer to render rows after a scroll. */
const REALIZE_FRAMES = 4;

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

/** The thread page scroller holding `from`, or else the first one on the page. */
export function threadViewport(from?: Element | null): HTMLElement | null {
  const own = from?.closest<HTMLElement>(PAGE_SCROLL_VIEWPORT);
  if (own) return own.querySelector(TIMELINE_ROW_LIST) ? own : null;
  for (const viewport of document.querySelectorAll<HTMLElement>(PAGE_SCROLL_VIEWPORT)) {
    if (viewport.isConnected && viewport.querySelector(TIMELINE_ROW_LIST)) return viewport;
  }
  return null;
}

interface CurrentMatch extends MatchPosition {
  rowId: string | null;
}

interface Search {
  pattern: RegExp;
  source: string;
  backward: boolean;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Vim keys for the conversation once Escape has left the text box: j/k,
 * Ctrl-D/U, gg/G scroll it, / ? n N search it, and i goes back to the text
 * box. bb keeps the conversation pinned to the bottom unless it sees the user
 * scroll, so every programmatic scroll is announced with a synthetic wheel
 * event first; its direction tells bb whether to unpin.
 */
export class ScrollMode {
  private active = false;
  private anchor: Element | null = null;
  private pendingG = false;
  private search: Search | null = null;
  private current: CurrentMatch | null = null;
  private highlighting = false;
  /** Bumped by every key so a search scanning a long conversation stops. */
  private searchToken = 0;
  private frame = 0;
  private readonly indicator: HTMLDivElement;
  private readonly modeNode: HTMLSpanElement;
  private readonly keysNode: HTMLSpanElement;
  private readonly bar: HTMLDivElement;
  private prompt: HTMLInputElement | null = null;
  private readonly observer = new MutationObserver(() => this.schedule());
  private readonly onScroll = () => this.schedule();

  constructor(private readonly returnToTextBox: (viewport: HTMLElement) => void) {
    this.indicator = document.createElement("div");
    this.indicator.className = "bb-vim-indicator bbm-fade-in bbm-fast";
    this.indicator.setAttribute(UI_ATTRIBUTE, "");
    this.indicator.setAttribute("aria-hidden", "true");
    this.modeNode = document.createElement("span");
    this.modeNode.className = "bb-vim-mode";
    this.modeNode.textContent = "SCROLL";
    this.keysNode = document.createElement("span");
    this.keysNode.className = "bb-vim-keys";
    this.indicator.append(this.keysNode, this.modeNode);

    this.bar = document.createElement("div");
    this.bar.className = "bb-vim-bar bbm-rise-in bbm-fast bbm-near";
    this.bar.setAttribute(UI_ATTRIBUTE, "");
    this.bar.hidden = true;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** `anchor` is the text box that was left; its page is the one scrolled. */
  enter(anchor: Element): void {
    this.anchor = anchor;
    if (this.active) return;
    this.active = true;
    this.pendingG = false;
    document.body.append(this.indicator, this.bar);
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("resize", this.onScroll);
    this.render();
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.searchToken++;
    this.closePrompt();
    this.setHighlighting(false);
    this.observer.disconnect();
    window.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.onScroll);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.indicator.remove();
    this.bar.remove();
    this.bar.replaceChildren();
    this.bar.hidden = true;
  }

  /** True while focus on `target` keeps scroll mode: the page itself, or something inside the conversation. */
  keepsFocus(target: EventTarget | null): boolean {
    if (!(target instanceof Element) || target === document.body || target === document.documentElement) return true;
    if (target.closest(`[${UI_ATTRIBUTE}]`)) return true;
    if (isEditable(target)) return false;
    const viewport = this.viewport();
    return !!viewport && viewport.contains(target) && !target.closest(PROMPTBOX);
  }

  /** Handles one keydown aimed at the page; returns true when it was a scroll mode key. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.active || event.defaultPrevented || event.isComposing || event.metaKey || event.altKey) return false;
    if (MODIFIER_KEYS.has(event.key)) return false;
    const viewport = this.viewport();
    if (!viewport) {
      this.exit();
      return false;
    }
    this.searchToken++;
    if (!this.prompt) this.clearMessage();
    const key = event.ctrlKey ? (event.key === "d" || event.key === "u" ? `C-${event.key}` : null) : event.key;
    const pendingG = this.pendingG;
    this.pendingG = false;
    const handled = key !== null && this.run(key, pendingG, viewport);
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    this.render();
    return handled;
  }

  private run(key: string, pendingG: boolean, viewport: HTMLElement): boolean {
    const visible = visibleBox(viewport);
    const page = visible.bottom - visible.top;
    switch (key) {
      case "j":
        scrollViewport(viewport, viewport.scrollTop + LINE_STEP);
        return true;
      case "k":
        scrollViewport(viewport, viewport.scrollTop - LINE_STEP);
        return true;
      case "C-d":
        scrollViewport(viewport, viewport.scrollTop + page / 2);
        return true;
      case "C-u":
        scrollViewport(viewport, viewport.scrollTop - page / 2);
        return true;
      case "g":
        if (pendingG) scrollViewport(viewport, 0);
        else this.pendingG = true;
        return true;
      case "G":
        scrollViewport(viewport, viewport.scrollHeight);
        return true;
      case "/":
      case "?":
        this.openPrompt(key);
        return true;
      case "n":
      case "N":
        this.repeatSearch(key === "N");
        return true;
      case "i":
        this.exit();
        this.returnToTextBox(viewport);
        return true;
      case "Escape":
        if (!this.highlighting) return false;
        this.setHighlighting(false);
        return true;
      default:
        return false;
    }
  }

  private viewport(): HTMLElement | null {
    const anchored = this.anchor?.isConnected ? threadViewport(this.anchor) : null;
    return anchored ?? threadViewport();
  }

  private openPrompt(prefix: "/" | "?"): void {
    this.closePrompt();
    const label = document.createElement("span");
    label.className = "bb-vim-dialog bb-vim-prompt";
    label.textContent = prefix;
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    label.append(input);
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      const backspaceOut = event.key === "Backspace" && !input.value;
      if (event.key !== "Enter" && event.key !== "Escape" && !backspaceOut) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const source = input.value;
      this.closePrompt();
      if (event.key === "Enter") this.startSearch(source, prefix === "?");
      this.render();
    });
    input.addEventListener("blur", () => {
      if (this.prompt === input) {
        this.closePrompt();
        this.render();
      }
    });
    this.prompt = input;
    this.bar.replaceChildren(label);
    this.bar.hidden = false;
    this.render();
    input.focus();
  }

  private closePrompt(): void {
    const input = this.prompt;
    if (!input) return;
    this.prompt = null;
    this.bar.replaceChildren();
    this.bar.hidden = true;
    if (document.activeElement === input) input.blur();
  }

  private showMessage(text: string, error = false): void {
    if (this.prompt) return;
    const message = document.createElement("div");
    message.className = error ? "bb-vim-notification bb-vim-error" : "bb-vim-notification";
    message.textContent = text;
    this.bar.replaceChildren(message);
    this.bar.hidden = false;
    this.render();
  }

  private clearMessage(): void {
    this.bar.replaceChildren();
    this.bar.hidden = true;
  }

  private startSearch(source: string, backward: boolean): void {
    // An empty pattern repeats the last one, as in vim.
    const pattern = source ? compilePattern(source) : (this.search?.pattern ?? null);
    if (!pattern) {
      this.showMessage("E35: No previous regular expression", true);
      return;
    }
    this.search = { pattern, source: source || this.search!.source, backward };
    this.current = null;
    this.find(backward ? -1 : 1).catch(logError);
  }

  private repeatSearch(reverse: boolean): void {
    if (!this.search) {
      this.showMessage("E35: No previous regular expression", true);
      return;
    }
    this.find(this.search.backward !== reverse ? -1 : 1).catch(logError);
  }

  /**
   * Walks the conversation row by row from the current match, or from the
   * screen's edge, scrolling to make bb render rows it has virtualized away.
   */
  private async find(direction: 1 | -1): Promise<void> {
    const viewport = this.viewport();
    const search = this.search;
    if (!viewport || !search) return;
    const token = ++this.searchToken;
    const prefix = direction < 0 ? "?" : "/";
    const originalTop = viewport.scrollTop;
    const start = this.current ?? screenStart(viewport, search.pattern, direction);
    let budget = 2 * Math.ceil(viewport.scrollHeight / Math.max(1, viewport.clientHeight)) + 8;
    let wrapped = false;
    let row = start.row;
    for (;;) {
      const realized = await this.realize(viewport, row, () => budget--, token);
      if (realized === "cancelled" || token !== this.searchToken) return;
      if (realized === "end" || budget < 0) {
        if (wrapped || budget < 0) break;
        wrapped = true;
        const edge = await this.scrollToEdge(viewport, direction > 0 ? "top" : "bottom", token);
        if (edge === null || token !== this.searchToken) return;
        row = edge;
        if (direction > 0 ? row > start.row : row < start.row) break;
        continue;
      }
      const ranges = rowMatches(realized, search.pattern);
      const shown = ranges.flatMap((range, ordinal) => (isClipped(range, realized) ? [] : [ordinal]));
      const candidates = shown.filter((ordinal) => {
        const order = comparePositions({ row, ordinal }, start);
        if (!wrapped) return direction > 0 ? order > 0 : order < 0;
        return direction > 0 ? order <= 0 : order >= 0;
      });
      if (candidates.length) {
        const ordinal = direction > 0 ? candidates[0]! : candidates[candidates.length - 1]!;
        this.current = { row, ordinal, rowId: realized.getAttribute(TIMELINE_ROW_ID_ATTRIBUTE) };
        if (!wrapped) this.showMessage(`${prefix}${search.source}`);
        else if (direction > 0) this.showMessage("search hit BOTTOM, continuing at TOP", true);
        else this.showMessage("search hit TOP, continuing at BOTTOM", true);
        this.setHighlighting(true);
        await this.reveal(viewport, token);
        return;
      }
      row += direction;
      if (wrapped && (direction > 0 ? row > start.row : row < start.row)) break;
    }
    if (token !== this.searchToken) return;
    scrollViewport(viewport, originalTop);
    this.showMessage(`E486: Pattern not found: ${search.source}`, true);
  }

  /** Scrolls until the row at `index` is rendered; "end" when the conversation has no such row. */
  private async realize(
    viewport: HTMLElement,
    index: number,
    spend: () => number,
    token: number,
  ): Promise<Element | "end" | "cancelled"> {
    for (;;) {
      if (token !== this.searchToken || !viewport.isConnected) return "cancelled";
      const rows = realizedRows(viewport);
      const row = rows.get(index);
      if (row) return row;
      if (index < 0 || rows.size === 0) return "end";
      const range = visibleRange(viewport, rows);
      const down = index > range.max;
      if (!down && index >= range.min) return "end";
      const max = viewport.scrollHeight - viewport.clientHeight;
      if (down ? viewport.scrollTop >= max - 1 : viewport.scrollTop <= 0) return "end";
      if (spend() <= 0) return "end";
      const visible = visibleBox(viewport);
      const step = Math.max(LINE_STEP, visible.bottom - visible.top);
      await this.scrollAndWait(viewport, viewport.scrollTop + (down ? step : -step), rows);
    }
  }

  /** Scrolls to the top or bottom and returns the first or last row index there, or null when cancelled. */
  private async scrollToEdge(viewport: HTMLElement, edge: "top" | "bottom", token: number): Promise<number | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.scrollAndWait(viewport, edge === "top" ? 0 : viewport.scrollHeight, realizedRows(viewport));
      if (token !== this.searchToken) return null;
    }
    const indices = [...realizedRows(viewport).keys()];
    if (!indices.length) return 0;
    return edge === "top" ? Math.min(...indices) : Math.max(...indices);
  }

  private async scrollAndWait(viewport: HTMLElement, top: number, before: Map<number, Element>): Promise<void> {
    scrollViewport(viewport, top);
    const signature = [...before.keys()].join(",");
    for (let frame = 0; frame < REALIZE_FRAMES; frame++) {
      await nextFrame();
      if ([...realizedRows(viewport).keys()].join(",") !== signature) return;
    }
  }

  /** Centers the current match when it is off screen, again if bb re-measures rows under it. */
  private async reveal(viewport: HTMLElement, token: number): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const range = this.currentRange(viewport);
      if (!range) return;
      const rect = range.getBoundingClientRect();
      const visible = visibleBox(viewport);
      if (rect.top >= visible.top && rect.bottom <= visible.bottom) break;
      const middle = (visible.top + visible.bottom) / 2;
      scrollViewport(viewport, viewport.scrollTop + rect.top + rect.height / 2 - middle);
      await nextFrame();
      await nextFrame();
      if (token !== this.searchToken) return;
    }
    this.schedule();
  }

  private currentRange(viewport: HTMLElement): Range | null {
    const current = this.current;
    if (!current || !this.search) return null;
    const row = realizedRows(viewport).get(current.row);
    if (!row || (current.rowId !== null && row.getAttribute(TIMELINE_ROW_ID_ATTRIBUTE) !== current.rowId)) return null;
    return rowMatches(row, this.search.pattern)[current.ordinal] ?? null;
  }

  private setHighlighting(on: boolean): void {
    this.highlighting = on;
    if (on) this.schedule();
    else clearHighlights();
  }

  private schedule(): void {
    if (!this.active || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    if (!this.active) return;
    const viewport = this.viewport();
    if (!viewport) {
      this.indicator.hidden = true;
      this.bar.hidden = true;
      clearHighlights();
      return;
    }
    this.renderHighlights(viewport);
    this.keysNode.textContent = this.pendingG ? "g" : "";
    this.keysNode.hidden = !this.pendingG;
    const form = viewport.querySelector(PROMPTBOX);
    const toolbar = form ? promptToolbarRow(form) : null;
    const box = visibleBox(viewport);
    const hasBar = this.bar.childElementCount > 0;
    this.bar.hidden = !hasBar;
    // The search line takes over the indicator's spot while it is open.
    this.indicator.hidden = hasBar;
    if (!this.indicator.hidden) placeIndicator(this.indicator, toolbar, box);
    if (hasBar) placeBar(this.bar, toolbar, box, "inside");
  }

  private renderHighlights(viewport: HTMLElement): void {
    if (!this.highlighting || !this.search || typeof Highlight === "undefined" || !CSS.highlights) return;
    const all: Range[] = [];
    const current: Range[] = [];
    for (const [index, row] of realizedRows(viewport)) {
      const ranges = rowMatches(row, this.search.pattern);
      const isCurrentRow =
        this.current?.row === index &&
        (this.current.rowId === null || this.current.rowId === row.getAttribute(TIMELINE_ROW_ID_ATTRIBUTE));
      ranges.forEach((range, ordinal) => {
        (isCurrentRow && ordinal === this.current!.ordinal ? current : all).push(range);
      });
    }
    CSS.highlights.set(SEARCH_HIGHLIGHT, new Highlight(...all));
    CSS.highlights.set(CURRENT_HIGHLIGHT, new Highlight(...current));
  }

  dispose(): void {
    this.exit();
  }
}

/** Mirrors bb's own test for keys that belong to a text box rather than the page. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable ||
    !!target.closest("[contenteditable='true']")
  );
}

function clearHighlights(): void {
  if (typeof CSS === "undefined" || !CSS.highlights) return;
  CSS.highlights.delete(SEARCH_HIGHLIGHT);
  CSS.highlights.delete(CURRENT_HIGHLIGHT);
}

/** Moves the conversation, telling bb first that the user scrolled so it unpins from the bottom. */
function scrollViewport(viewport: HTMLElement, top: number): void {
  const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const target = Math.round(Math.min(max, Math.max(0, top)));
  if (target === viewport.scrollTop) return;
  viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: target - viewport.scrollTop }));
  viewport.scrollTop = target;
}

/** The part of the viewport the conversation shows through, above the pinned composer. */
function visibleBox(viewport: HTMLElement): Rect {
  const rect = viewport.getBoundingClientRect();
  const composer = viewport.querySelector(FOLLOW_UP_COMPOSER)?.getBoundingClientRect();
  const covered = composer && composer.height > 0 && composer.top > rect.top;
  const bottom = covered ? Math.min(rect.bottom, composer.top) : rect.bottom;
  return { left: rect.left, right: rect.right, top: rect.top, bottom };
}

/** The first and last row indices on screen, or every rendered row when none is. */
function visibleRange(viewport: HTMLElement, rows: Map<number, Element>): { min: number; max: number } {
  const visible = visibleBox(viewport);
  let min = Infinity;
  let max = -Infinity;
  for (const [index, row] of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= visible.top || rect.top >= visible.bottom) continue;
    min = Math.min(min, index);
    max = Math.max(max, index);
  }
  if (min === Infinity) {
    const indices = [...rows.keys()];
    return { min: Math.min(...indices), max: Math.max(...indices) };
  }
  return { min, max };
}

/**
 * Where a new search starts: just before the first match at or below the top
 * of the screen, or just after the last one at or above its bottom.
 */
function screenStart(viewport: HTMLElement, pattern: RegExp, direction: 1 | -1): MatchPosition {
  const rows = realizedRows(viewport);
  if (!rows.size) return { row: direction > 0 ? 0 : -1, ordinal: direction > 0 ? -1 : 0 };
  const visible = visibleBox(viewport);
  const range = visibleRange(viewport, rows);
  if (direction > 0) {
    const ranges = rowMatches(rows.get(range.min)!, pattern);
    const above = ranges.filter((match) => match.getBoundingClientRect().top < visible.top).length;
    return { row: range.min, ordinal: above - 1 };
  }
  const ranges = rowMatches(rows.get(range.max)!, pattern);
  const firstBelow = ranges.findIndex((match) => match.getBoundingClientRect().bottom > visible.bottom);
  return { row: range.max, ordinal: firstBelow === -1 ? ranges.length : firstBelow };
}
