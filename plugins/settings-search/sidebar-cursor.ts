import { CURSOR_ATTRIBUTE } from "./page-cursor.js";

export const SETTINGS_LINK = 'a[href^="/settings"]';
const G_TIMEOUT_MS = 1000;
const FALLBACK_ROW_HEIGHT_PX = 28;

export interface SidebarCursor {
  /** Handles a keydown while the page list has the keys; returns true when it was a cursor key. */
  handleKey(event: KeyboardEvent): boolean;
  /** Shows the cursor on the open page's link. */
  show(): void;
  hide(): void;
  /** Keeps a showing cursor on the open page's link after a navigation it didn't make. */
  sync(): void;
  dispose(): void;
}

/**
 * A cursor over the settings sidebar's page list. Moving it opens the page
 * under it, so the page beside it is always the one it points at.
 */
export function createSidebarCursor(win: Window, nav: () => Element | null): SidebarCursor {
  let ring: Element | null = null;
  let pendingG = 0;

  const links = () => [...(nav()?.querySelectorAll<HTMLAnchorElement>(SETTINGS_LINK) ?? [])];

  /** The open page's link: the longest one the path starts with, so a project's page counts as Projects. */
  const here = (list: HTMLAnchorElement[]): number => {
    const path = win.location.pathname;
    let found = -1;
    let length = -1;
    list.forEach((link, at) => {
      const href = link.getAttribute("href")!;
      const matches = path === href || path.startsWith(`${href}/`);
      if (matches && href.length > length) [found, length] = [at, href.length];
    });
    return found;
  };

  const mark = (link: Element | undefined) => {
    ring?.removeAttribute(CURSOR_ATTRIBUTE);
    ring = link ?? null;
    if (!link) return;
    link.setAttribute(CURSOR_ATTRIBUTE, "");
    link.scrollIntoView({ block: "nearest" });
  };

  const go = (target: number) => {
    const list = links();
    if (list.length === 0) return;
    const link = list[Math.max(0, Math.min(list.length - 1, target))]!;
    if (link.getAttribute("href") !== win.location.pathname) link.click();
    mark(link);
  };

  const halfList = (): number => {
    const list = nav();
    const rowHeight = links()[0]?.getBoundingClientRect().height || FALLBACK_ROW_HEIGHT_PX;
    return Math.max(1, Math.floor((list?.clientHeight ?? 0) / rowHeight / 2));
  };

  const handleKey = (event: KeyboardEvent): boolean => {
    const wasG = pendingG !== 0;
    if (pendingG !== 0) win.clearTimeout(pendingG);
    pendingG = 0;
    if (event.ctrlKey) {
      if (event.shiftKey || (event.key !== "d" && event.key !== "u")) return false;
      go(here(links()) + (event.key === "d" ? 1 : -1) * halfList());
      return true;
    }
    switch (event.key) {
      case "j":
      case "k":
        go(here(links()) + (event.key === "j" ? 1 : -1));
        return true;
      case "g":
        if (wasG) go(0);
        else pendingG = win.setTimeout(() => (pendingG = 0), G_TIMEOUT_MS);
        return true;
      case "G":
        go(Infinity);
        return true;
      case "Escape":
        if (!ring) return false;
        mark(undefined);
        return true;
      default:
        return false;
    }
  };

  return {
    handleKey,
    show: () => {
      const list = links();
      mark(list[here(list)]);
    },
    hide: () => mark(undefined),
    sync() {
      if (!ring) return;
      const list = links();
      const link = list[here(list)];
      if (link !== ring) mark(link);
    },
    dispose() {
      if (pendingG !== 0) win.clearTimeout(pendingG);
      mark(undefined);
    },
  };
}
