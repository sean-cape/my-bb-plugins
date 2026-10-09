import { extractEntries, PAGE_VIEWPORT, type SettingEntry, type SettingsPage } from "./settings-index.js";

export type PageLoader = (page: SettingsPage, signal: AbortSignal) => Promise<SettingEntry[]>;

export const FRAME_ATTRIBUTE = "data-settings-search-frame";
const POLL_MS = 100;
// A page counts as rendered once its text stops changing for this many polls;
// plugin pages fill in their settings after an RPC.
const STABLE_POLLS = 3;
const PAGE_TIMEOUT_MS = 6000;

const sleep = (win: Window, ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = win.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      win.clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Renders settings pages in one hidden same-origin iframe running bb itself,
 * since nothing exposes what another settings page contains. The first page
 * loads the app; later ones go through the frame's own sidebar links, which is
 * bb's client-side router and far cheaper than a reload.
 */
export function createFrameLoader(doc: Document, win: Window): { load: PageLoader; dispose(): void } {
  let frame: HTMLIFrameElement | null = null;
  let previous: { viewport: Element; text: string } | null = null;

  const open = (href: string) => {
    frame = doc.createElement("iframe");
    frame.setAttribute(FRAME_ATTRIBUTE, "");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.inert = true;
    // Off screen rather than display:none, so bb lays its pages out as usual.
    frame.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;pointer-events:none";
    frame.src = href;
    doc.body.append(frame);
  };

  const navigate = (href: string) => {
    if (!frame) return open(href);
    const frameDoc = frame.contentDocument;
    const link = [...(frameDoc?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [])].find(
      (anchor) => anchor.getAttribute("href") === href,
    );
    if (link) link.click();
    else frame.contentWindow?.location.assign(href);
  };

  const load: PageLoader = async (page, signal) => {
    navigate(page.href);
    const deadline = Date.now() + PAGE_TIMEOUT_MS;
    let lastText: string | null = null;
    let stable = 0;
    for (;;) {
      await sleep(win, POLL_MS, signal);
      const frameDoc = frame?.contentDocument;
      const viewport = frameDoc?.querySelector(PAGE_VIEWPORT);
      const onPage = frameDoc?.location.pathname === page.href;
      const text = viewport?.textContent ?? "";
      const arrived =
        onPage && viewport && text !== "" && (viewport !== previous?.viewport || text !== previous.text);
      if (arrived) {
        stable = text === lastText ? stable + 1 : 0;
        lastText = text;
      }
      const settled = arrived && stable >= STABLE_POLLS;
      if (settled || Date.now() > deadline) {
        if (!arrived) return [];
        previous = { viewport, text };
        return extractEntries(viewport, page);
      }
    }
  };

  return {
    load,
    dispose() {
      frame?.remove();
      frame = null;
      previous = null;
    },
  };
}

/** Loads each page in turn, reporting as it goes; stops quietly when aborted. */
export async function crawlPages(
  pages: readonly SettingsPage[],
  load: PageLoader,
  onPage: (page: SettingsPage, entries: SettingEntry[]) => void,
  signal: AbortSignal,
): Promise<void> {
  for (const page of pages) {
    if (signal.aborted) return;
    let entries: SettingEntry[];
    try {
      entries = await load(page, signal);
    } catch (error) {
      if (signal.aborted) return;
      console.warn(`[settings-search] couldn't index ${page.href}`, error);
      continue;
    }
    if (!signal.aborted) onPage(page, entries);
  }
}
