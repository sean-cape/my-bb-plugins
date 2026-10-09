export const CURSOR_ATTRIBUTE = "data-settings-search-cursor";
const G_TIMEOUT_MS = 1000;
// Taller than any list row, shorter than a section.
const MAX_ROW_HEIGHT_PX = 160;

// bb's settings markup has no plugin contract, so these selectors follow the
// shipped DOM. The page body is the shell's inner <main>; most pages scroll
// in the page viewport, Installed plugins in a radix scroll area.
export const PAGE_ROOT = "[data-app-content-shell] > main";
const SCROLLER = "[data-page-scroll-viewport], [data-radix-scroll-area-viewport]";
const CONTROLS =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [role="switch"]';
const TEXT_CONTROLS = "input, textarea, select";
// Radix menus and selects open from a key or pointer press on the trigger, never a click.
const POPUP_TRIGGER = '[aria-haspopup]:not([aria-haspopup="false"]), [role="combobox"]';
// dnd-kit drag handles, which do nothing on a click.
const DRAG_HANDLE = '[aria-roledescription="sortable"], [aria-label^="Reorder "]';

export interface PageCursor {
  /** Handles a keydown aimed at the page; returns true when it was a cursor key. */
  handleKey(event: KeyboardEvent): boolean;
  /** Puts the cursor on the item holding `element`, showing it. */
  place(element: Element): void;
  /** Shows the cursor where it was last hidden on this page, or on the first setting in view. */
  enter(): void;
  /** Hides the cursor, remembering its place for `enter`. */
  hide(): void;
  /** Drops a cursor left over from another page. */
  sync(): void;
  dispose(): void;
}

function isVisible(element: Element): boolean {
  if (element.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
  return typeof element.checkVisibility !== "function" || element.checkVisibility();
}

/**
 * The repeated row a control sits in: the nearest row-sized ancestor with a
 * sibling shaped like it (a settings row, a project in a list), or the control
 * itself when it stands alone.
 */
function itemFor(control: Element, root: Element): Element {
  const placed = control.closest("[data-control-placement]");
  if (placed && root.contains(placed)) return placed;
  for (let element = control.parentElement; element && element !== root; element = element.parentElement) {
    if (element.getBoundingClientRect().height > MAX_ROW_HEIGHT_PX) break;
    const parent = element.parentElement;
    if (!parent || parent === root) break;
    const className = element.getAttribute("class") ?? "";
    const repeated = [...parent.children].some(
      (sibling) =>
        sibling !== element && sibling.tagName === element.tagName && (sibling.getAttribute("class") ?? "") === className,
    );
    if (repeated) return element;
  }
  return control;
}

function primaryControl(item: Element): HTMLElement | null {
  const controls = [
    ...(item.matches(CONTROLS) ? [item] : []),
    ...item.querySelectorAll(CONTROLS),
  ].filter((control): control is HTMLElement => control instanceof HTMLElement && !control.matches(DRAG_HANDLE));
  return (
    controls.find((control) => control.matches('a[href], [role="switch"], input, select, textarea')) ??
    controls[0] ??
    null
  );
}

export function createPageCursor(doc: Document, win: Window): PageCursor {
  let current: Element | null = null;
  let index = -1;
  let path: string | null = null;
  let parked: { path: string; index: number } | null = null;
  let pendingG = 0;

  const root = () => doc.querySelector(PAGE_ROOT);

  const items = (): Element[] => {
    const page = root();
    if (!page) return [];
    const found: Element[] = [];
    for (const control of page.querySelectorAll(CONTROLS)) {
      if (!isVisible(control)) continue;
      const item = itemFor(control, page);
      if (found.at(-1) !== item && !found.includes(item)) found.push(item);
    }
    return found;
  };

  const clear = () => {
    current?.removeAttribute(CURSOR_ATTRIBUTE);
    current = null;
    index = -1;
    path = null;
  };

  const mark = (item: Element | undefined, list: Element[], scroll: boolean) => {
    if (!item) return;
    current?.removeAttribute(CURSOR_ATTRIBUTE);
    current = item;
    index = list.indexOf(item);
    path = win.location.pathname;
    item.setAttribute(CURSOR_ATTRIBUTE, "");
    if (scroll) item.scrollIntoView({ block: "nearest" });
  };
  const show = (item: Element | undefined, list: Element[]) => mark(item, list, true);

  /** Where the cursor is now, following it if bb re-rendered its row. */
  const position = (list: Element[]): number => {
    if (!current || path !== win.location.pathname) return -1;
    const at = list.indexOf(current);
    if (at >= 0) return at;
    return Math.min(index, list.length - 1);
  };

  const scroller = (): HTMLElement | null => root()?.querySelector<HTMLElement>(SCROLLER) ?? null;

  const firstVisible = (list: Element[], fromEnd: boolean): Element | undefined => {
    const box = scroller()?.getBoundingClientRect();
    const visible = box
      ? list.filter((item) => {
          const rect = item.getBoundingClientRect();
          return rect.bottom > box.top && rect.top < box.bottom;
        })
      : [];
    const pool = visible.length > 0 ? visible : list;
    return fromEnd ? pool.at(-1) : pool[0];
  };

  const move = (delta: number) => {
    const list = items();
    if (list.length === 0) return;
    const at = position(list);
    if (at < 0 && Number.isFinite(delta)) return show(firstVisible(list, delta < 0), list);
    show(list[Math.max(0, Math.min(list.length - 1, at + delta))], list);
  };

  const halfPage = (direction: 1 | -1) => {
    const viewport = scroller();
    if (!viewport) return;
    viewport.scrollTop += direction * Math.round(viewport.clientHeight / 2);
    const list = items();
    const box = viewport.getBoundingClientRect();
    const middle = (box.top + box.bottom) / 2;
    let nearest: Element | undefined;
    let distance = Infinity;
    for (const item of list) {
      const rect = item.getBoundingClientRect();
      const gap = Math.abs((rect.top + rect.bottom) / 2 - middle);
      if (gap < distance) [nearest, distance] = [item, gap];
    }
    mark(nearest, list, false);
  };

  const leaveControl = () => {
    const active = doc.activeElement;
    if (active instanceof HTMLElement && root()?.contains(active)) active.blur();
  };

  const focusIsOnPage = () => {
    const active = doc.activeElement;
    return !!active && active !== doc.body && !!root()?.contains(active);
  };

  const activate = (focusOnly: boolean): boolean => {
    const list = items();
    const at = position(list);
    const control = at >= 0 ? primaryControl(list[at]!) : null;
    if (!control) return false;
    if (focusOnly || control.matches(TEXT_CONTROLS)) control.focus();
    else if (control.matches(POPUP_TRIGGER)) {
      control.focus();
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    } else control.click();
    return true;
  };

  const handleKey = (event: KeyboardEvent): boolean => {
    const wasG = pendingG !== 0;
    if (pendingG !== 0) win.clearTimeout(pendingG);
    pendingG = 0;
    if (event.ctrlKey) {
      if (event.shiftKey || (event.key !== "d" && event.key !== "u")) return false;
      leaveControl();
      halfPage(event.key === "d" ? 1 : -1);
      return true;
    }
    switch (event.key) {
      case "j":
      case "k":
        leaveControl();
        move(event.key === "j" ? 1 : -1);
        return true;
      case "g":
        if (!wasG) {
          pendingG = win.setTimeout(() => (pendingG = 0), G_TIMEOUT_MS);
          return true;
        }
        leaveControl();
        move(-Infinity);
        return true;
      case "G":
        leaveControl();
        move(Infinity);
        return true;
      case "Enter":
      case "i":
        // A focused control keeps its own Enter.
        if (focusIsOnPage()) return false;
        return activate(event.key === "i");
      case "Escape":
        if (focusIsOnPage()) {
          leaveControl();
          return true;
        }
        if (!current) return false;
        clear();
        return true;
      default:
        return false;
    }
  };

  const place = (element: Element) => {
    const page = root();
    if (!page?.contains(element)) return;
    const control = element.matches(CONTROLS) ? element : element.querySelector(CONTROLS);
    const item = control ? itemFor(control, page) : element;
    show(item, items());
  };

  /** A click on the page moves a cursor that's showing, so the keys carry on from there. */
  const onPointerDown = (event: PointerEvent) => {
    if (!current || !(event.target instanceof Element)) return;
    const page = root();
    const control = event.target.closest(CONTROLS);
    if (page && control && page.contains(control)) mark(itemFor(control, page), items(), false);
  };
  doc.addEventListener("pointerdown", onPointerDown, true);

  const enter = () => {
    const list = items();
    if (parked?.path === win.location.pathname && list.length > 0) {
      show(list[Math.min(parked.index, list.length - 1)], list);
    } else move(1);
    parked = null;
  };

  const hide = () => {
    leaveControl();
    if (current && path === win.location.pathname) parked = { path, index: position(items()) };
    clear();
  };

  return {
    handleKey,
    place,
    enter,
    hide,
    sync() {
      if (!current) return;
      if (path !== win.location.pathname) return clear();
      if (current.isConnected) return;
      // bb re-rendered the row; the cursor stays at the same place in the list.
      const list = items();
      const at = Math.min(index, list.length - 1);
      if (at >= 0) mark(list[at], list, false);
      else clear();
    },
    dispose() {
      if (pendingG !== 0) win.clearTimeout(pendingG);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      clear();
    },
  };
}
