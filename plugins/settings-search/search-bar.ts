import { crawlPages, createFrameLoader, type PageLoader } from "./crawler.js";
import { createPageCursor, CURSOR_ATTRIBUTE, PAGE_ROOT } from "./page-cursor.js";
import {
  extractEntries,
  findEntryElement,
  markTerms,
  PAGE_VIEWPORT,
  pageEntry,
  queryTerms,
  searchEntries,
  type SettingEntry,
  type SettingsPage,
} from "./settings-index.js";

const ROOT_ATTRIBUTE = "data-settings-search";
const RESULTS_ATTRIBUTE = "data-settings-search-results";
const ACTIVE_ATTRIBUTE = "data-settings-search-active";
const NAV_ATTRIBUTE = "data-settings-search-nav";
const HIT_ATTRIBUTE = "data-settings-search-hit";
const STYLE_ATTRIBUTE = "data-settings-search-style";
const MAX_RESULTS = 60;
const REVEAL_TIMEOUT_MS = 4000;
const REVEAL_POLL_MS = 100;
// Tall enough for a setting row with a long description, short enough to rule
// out a whole card.
const MAX_ROW_HEIGHT_PX = 240;

// bb's settings sidebar markup has no plugin contract, so these selectors
// follow the shipped DOM; a bb update that renames them just leaves the
// sidebar without a search bar.
const SETTINGS_SIDEBAR = '[data-sidebar="sidebar"]:has(> [data-testid="settings-sidebar-top-reserve-row"])';
const BACK_ROW = ':scope > div:has(a[href="/"])';
const NAV_LIST = ":scope > .overflow-auto";
const SETTINGS_LINK = 'a[href^="/settings"]';
// Lists of threads and plugin cards, not settings. Installed plugins also has
// no page viewport, so indexing it only waits out the timeout.
const UNINDEXED_PAGES = new Set(["/settings/archived", "/settings/plugins"]);
// While one of these is open, the keys belong to it.
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]';
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="switch"], [tabindex]:not([tabindex="-1"])';

const KEYS: [string, string][] = [
  ["j  k", "Next or previous setting"],
  ["gg  G", "First or last setting"],
  ["Ctrl-D Ctrl-U", "Half a page down or up"],
  ["h  l", "Previous or next settings page"],
  ["Enter", "Use the setting: flip, open, or edit"],
  ["i", "Focus the setting's control"],
  ["Esc", "Back to the keys from a control"],
  ["/", "Search settings"],
  ["↑ ↓  Ctrl-N Ctrl-P", "Move through results"],
  ["n  N", "Open the next or previous result"],
  ["?", "Show these keys"],
];

const SEARCH_ICON = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 17L21 21"/><path d="M19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19C15.4183 19 19 15.4183 19 11Z"/></svg>`;

export const SETTINGS_SEARCH_CSS = `
[${ROOT_ATTRIBUTE}] {
  position: relative;
  flex-shrink: 0;
  padding: 0 8px 8px;
}
[${ROOT_ATTRIBUTE}] > svg {
  position: absolute;
  left: 17px;
  top: 7px;
  width: 14px;
  height: 14px;
  color: var(--muted-foreground);
  pointer-events: none;
}
[${ROOT_ATTRIBUTE}] input {
  display: block;
  width: 100%;
  height: var(--bb-sidebar-row-height, 1.75rem);
  padding: 0 28px 0 28px;
  border: 1px solid var(--input);
  border-radius: 6px;
  background: transparent;
  color: var(--sidebar-foreground);
  font: inherit;
  font-size: 13px;
  outline: none;
}
[${ROOT_ATTRIBUTE}] input::placeholder {
  color: var(--muted-foreground);
}
[${ROOT_ATTRIBUTE}] input:focus {
  border-color: var(--ring);
}
[${ROOT_ATTRIBUTE}] kbd {
  position: absolute;
  right: 15px;
  top: 5px;
  min-width: 18px;
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--muted-foreground);
  font: inherit;
  font-size: 11px;
  line-height: 14px;
  text-align: center;
  pointer-events: none;
  transition: opacity var(--bbm-duration-fast) var(--bbm-ease-out);
}
[${ROOT_ATTRIBUTE}]:focus-within kbd,
[${ROOT_ATTRIBUTE}][data-has-query] kbd {
  opacity: 0;
}
[${ROOT_ATTRIBUTE}] [data-keys] {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--muted-foreground);
}
[${ROOT_ATTRIBUTE}] [data-keys] div {
  display: flex;
  gap: 8px;
  padding: 2px 0;
}
[${ROOT_ATTRIBUTE}] [data-keys] span:first-child {
  flex: 0 0 auto;
  min-width: 96px;
  color: var(--sidebar-foreground);
  white-space: pre;
}
[${ACTIVE_ATTRIBUTE}] > [${NAV_ATTRIBUTE}] {
  display: none !important;
}
[${RESULTS_ATTRIBUTE}] {
  display: none;
  min-height: 0;
  flex: 1 1 0%;
  overflow: auto;
  padding: 0 8px 8px;
}
[${ACTIVE_ATTRIBUTE}] > [${RESULTS_ATTRIBUTE}] {
  display: block;
}
[${RESULTS_ATTRIBUTE}] [role="option"] {
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--sidebar-foreground);
}
[${RESULTS_ATTRIBUTE}] [role="option"]:hover {
  background: var(--state-hover);
}
[${RESULTS_ATTRIBUTE}] [role="option"][aria-selected="true"] {
  background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground);
}
[${RESULTS_ATTRIBUTE}] [data-label] {
  font-size: 13px;
  line-height: 18px;
}
[${RESULTS_ATTRIBUTE}] [data-where],
[${RESULTS_ATTRIBUTE}] [data-description],
[${RESULTS_ATTRIBUTE}] [data-note] {
  font-size: 11px;
  line-height: 15px;
  color: var(--subtle-foreground);
}
[${RESULTS_ATTRIBUTE}] [data-description] {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  color: var(--muted-foreground);
}
[${RESULTS_ATTRIBUTE}] [data-note] {
  padding: 6px 8px;
}
[${RESULTS_ATTRIBUTE}] mark {
  background: transparent;
  color: var(--ring);
  font-weight: 600;
}
[${HIT_ATTRIBUTE}],
[${CURSOR_ATTRIBUTE}] {
  position: relative;
}
[${CURSOR_ATTRIBUTE}]::before {
  content: "";
  position: absolute;
  inset: -6px -8px;
  border-radius: 8px;
  background: var(--state-hover);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ring) 45%, transparent);
  pointer-events: none;
  animation: bbm-fade-in var(--bbm-duration-fast) var(--bbm-ease-out) both;
}
/* A ring that fades in and out over the setting a search landed on, so the
   eye finds it after the page scrolls. */
[${HIT_ATTRIBUTE}]::after {
  content: "";
  position: absolute;
  inset: -6px -8px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--ring) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ring) 60%, transparent);
  pointer-events: none;
  opacity: 0;
  animation: settings-search-hit 1600ms var(--bbm-ease-out) both;
}
@keyframes settings-search-hit {
  12%, 55% { opacity: 1; }
  100% { opacity: 0; }
}
`;

export interface SettingsSearchOptions {
  /** Replaces the hidden-iframe page loader, for tests. */
  createLoader?: () => { load: PageLoader; dispose(): void };
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable ||
    !!target.closest("[contenteditable='true']")
  );
}

function appendMarked(parent: HTMLElement, text: string, terms: readonly string[]) {
  for (const run of markTerms(text, terms)) {
    if (!run.hit) parent.append(run.text);
    else parent.append(Object.assign(parent.ownerDocument.createElement("mark"), { textContent: run.text }));
  }
}

/** The block to ring for a found label: its settings row, or a short ancestor around label and description. */
function rowFor(element: Element): Element {
  const control = element.closest("[data-control-placement]");
  if (control) return control;
  if (element.tagName !== "P") return element.parentElement ?? element;
  const row = element.parentElement?.parentElement?.parentElement;
  return row && row.getBoundingClientRect().height <= MAX_ROW_HEIGHT_PX ? row : element;
}

/**
 * Adds a search bar under "Back to app" in bb's settings sidebar while it is
 * on screen. Results replace the page list while there is a query, and come
 * from every settings page: the open one is read straight away, the rest in a
 * hidden iframe each time settings open.
 */
export function mountSettingsSearch(doc: Document, win: Window, options: SettingsSearchOptions = {}): () => void {
  // The indexing iframe runs bb, and so this plugin, again.
  if (win.top !== win) return () => {};

  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = SETTINGS_SEARCH_CSS;
  doc.head.append(style);

  const indexed = new Map<string, SettingEntry[]>();
  let pages: SettingsPage[] = [];
  let progress = { done: 0, total: 0 };
  let results: SettingEntry[] = [];
  let selected = 0;
  let sidebar: Element | null = null;
  let root: HTMLElement | null = null;
  let input: HTMLInputElement | null = null;
  let list: HTMLElement | null = null;
  let keys: HTMLElement | null = null;
  let crawl: AbortController | null = null;
  let loader: { load: PageLoader; dispose(): void } | null = null;
  let reveal: { entry: SettingEntry; deadline: number; focus: boolean; timer: number } | null = null;
  let hit: Element | null = null;
  let frame = 0;

  const allEntries = () => {
    const found = pages.flatMap((page) => indexed.get(page.href) ?? []);
    // A heading every plugin page has, like Configuration, finds nothing useful.
    const headingPages = new Map<string, Set<string>>();
    for (const entry of found) {
      if (entry.kind !== "heading") continue;
      headingPages.set(entry.label, (headingPages.get(entry.label) ?? new Set()).add(entry.href));
    }
    const shared = (entry: SettingEntry) => entry.kind === "heading" && headingPages.get(entry.label)!.size > 1;
    return [...pages.map(pageEntry), ...found.filter((entry) => !shared(entry))];
  };

  const readPages = (nav: Element): SettingsPage[] =>
    [...nav.querySelectorAll<HTMLAnchorElement>(SETTINGS_LINK)]
      .map((link) => ({ href: link.getAttribute("href")!, title: link.textContent?.trim() ?? "" }))
      .filter((page) => page.title !== "" && !UNINDEXED_PAGES.has(page.href));

  const indexOpenPage = () => {
    const page = pages.find((candidate) => candidate.href === win.location.pathname);
    const viewport = doc.querySelector(PAGE_VIEWPORT);
    if (page && viewport) indexed.set(page.href, extractEntries(viewport, page));
  };

  const optionId = (index: number) => `settings-search-option-${index}`;

  const render = () => {
    if (!sidebar || !root || !input || !list) return;
    const query = input.value;
    const active = query.trim() !== "";
    root.toggleAttribute("data-has-query", query !== "");
    if (active && !sidebar.hasAttribute(ACTIVE_ATTRIBUTE)) {
      list.classList.add("bbm-fade-in", "bbm-fast");
    } else if (!active) {
      list.classList.remove("bbm-fade-in", "bbm-fast");
    }
    sidebar.toggleAttribute(ACTIVE_ATTRIBUTE, active);
    input.setAttribute("aria-expanded", String(active));
    list.replaceChildren();
    if (!active) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const terms = queryTerms(query);
    results.forEach((entry, index) => {
      const option = doc.createElement("div");
      option.id = optionId(index);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === selected));
      const label = doc.createElement("div");
      label.dataset.label = "";
      appendMarked(label, entry.label, terms);
      option.append(label);
      if (entry.kind !== "page") {
        const where = doc.createElement("div");
        where.dataset.where = "";
        where.textContent = entry.section ? `${entry.page} › ${entry.section}` : entry.page;
        option.append(where);
      }
      if (entry.description) {
        const description = doc.createElement("div");
        description.dataset.description = "";
        appendMarked(description, entry.description, terms);
        option.append(description);
      }
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => open(index, true));
      list!.append(option);
    });
    const indexing = progress.done < progress.total;
    if (results.length === 0 || indexing) {
      const note = doc.createElement("div");
      note.dataset.note = "";
      note.textContent = [
        results.length === 0 ? "No settings match." : "",
        indexing ? `Indexing ${progress.done} of ${progress.total} pages…` : "",
      ]
        .filter(Boolean)
        .join(" ");
      list.append(note);
    }
    if (results.length > 0) input.setAttribute("aria-activedescendant", optionId(selected));
    else input.removeAttribute("aria-activedescendant");
    doc.getElementById(optionId(selected))?.scrollIntoView({ block: "nearest" });
  };

  const refresh = (resetSelection: boolean) => {
    if (!input) return;
    const current = results[selected];
    results = searchEntries(allEntries(), input.value).slice(0, MAX_RESULTS);
    const kept = current && !resetSelection ? results.indexOf(current) : -1;
    selected = kept >= 0 ? kept : Math.min(resetSelection ? 0 : selected, Math.max(0, results.length - 1));
    render();
  };

  const move = (delta: number) => {
    if (results.length === 0) return;
    selected = (selected + delta + results.length) % results.length;
    render();
  };

  const flash = (row: Element) => {
    hit?.removeAttribute(HIT_ATTRIBUTE);
    hit = row;
    row.removeAttribute(HIT_ATTRIBUTE);
    void (row as HTMLElement).offsetWidth;
    row.setAttribute(HIT_ATTRIBUTE, "");
    row.addEventListener(
      "animationend",
      () => {
        row.removeAttribute(HIT_ATTRIBUTE);
        if (hit === row) hit = null;
      },
      { once: true },
    );
  };

  const stopReveal = () => {
    if (reveal) win.clearTimeout(reveal.timer);
    reveal = null;
  };

  const tryReveal = () => {
    if (!reveal) return;
    const { entry, focus, deadline } = reveal;
    const viewport = doc.querySelector(PAGE_VIEWPORT);
    if (win.location.pathname === entry.href && viewport) {
      if (entry.kind === "page") return stopReveal();
      const element = findEntryElement(viewport, entry);
      if (element) {
        stopReveal();
        const row = rowFor(element);
        row.scrollIntoView({ block: "center" });
        flash(row);
        cursor.place(row);
        if (focus && entry.kind === "setting") {
          row.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
        }
        return;
      }
    }
    if (Date.now() > deadline) return stopReveal();
    reveal.timer = win.setTimeout(tryReveal, REVEAL_POLL_MS);
  };

  const open = (index: number, focus: boolean) => {
    const entry = results[index];
    if (!entry || !sidebar) return;
    selected = index;
    render();
    if (win.location.pathname !== entry.href) {
      const link = [...sidebar.querySelectorAll<HTMLAnchorElement>(SETTINGS_LINK)].find(
        (anchor) => anchor.getAttribute("href") === entry.href,
      );
      link?.click();
    }
    stopReveal();
    reveal = { entry, focus, deadline: Date.now() + REVEAL_TIMEOUT_MS, timer: 0 };
    tryReveal();
  };

  const toggleKeys = (show = !keys) => {
    if (!root) return;
    keys?.remove();
    keys = null;
    if (!show) return;
    keys = doc.createElement("div");
    keys.dataset.keys = "";
    keys.classList.add("bbm-drop-in", "bbm-near", "bbm-fast");
    for (const [key, action] of KEYS) {
      const row = doc.createElement("div");
      row.append(
        Object.assign(doc.createElement("span"), { textContent: key }),
        Object.assign(doc.createElement("span"), { textContent: action }),
      );
      keys.append(row);
    }
    root.append(keys);
  };

  const onInputKey = (event: KeyboardEvent) => {
    if (event.isComposing || event.metaKey || event.altKey) return;
    const ctrl = event.ctrlKey && !event.shiftKey;
    let handled = true;
    if (event.key === "ArrowDown" || (ctrl && event.key === "n")) move(1);
    else if (event.key === "ArrowUp" || (ctrl && event.key === "p")) move(-1);
    else if (event.key === "Enter" && !event.ctrlKey) open(selected, true);
    else if (event.key === "Escape" && !event.ctrlKey) {
      if (input!.value !== "") {
        input!.value = "";
        refresh(true);
      } else {
        toggleKeys(false);
        input!.blur();
      }
    } else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const stepPage = (delta: number) => {
    if (!sidebar) return;
    const links = [...sidebar.querySelectorAll<HTMLAnchorElement>(`[${NAV_ATTRIBUTE}] ${SETTINGS_LINK}`)];
    const path = win.location.pathname;
    const here = links.reduce<{ at: number; length: number }>(
      (best, link, at) => {
        const href = link.getAttribute("href")!;
        const matches = path === href || path.startsWith(`${href}/`);
        return matches && href.length > best.length ? { at, length: href.length } : best;
      },
      { at: -1, length: -1 },
    ).at;
    links[Math.max(0, Math.min(links.length - 1, here + delta))]?.click();
  };

  const cursor = createPageCursor(doc, win, { stepPage });

  const onDocumentKey = (event: KeyboardEvent) => {
    if (!input || event.isComposing || event.metaKey || event.altKey) return;
    if (doc.querySelector(OVERLAY)) return;
    if (isEditable(event.target)) {
      // vim-mode marks the Escape that leaves a text box as handled, and only
      // leaves text boxes on thread pages itself; one it kept never gets here.
      const target = event.target as HTMLElement;
      const plain = !event.ctrlKey && !event.shiftKey;
      if (event.key === "Escape" && plain && target !== input && target.closest(PAGE_ROOT)) target.blur();
      return;
    }
    if (event.defaultPrevented) return;
    // Keyboard settings record a shortcut from the next key pressed anywhere.
    if (doc.querySelector('button[aria-pressed="true"][aria-label^="Record shortcut"]')) return;
    if (event.ctrlKey) {
      if (cursor.handleKey(event)) event.preventDefault();
      return;
    }
    const hasResults = input.value.trim() !== "" && results.length > 0;
    if (event.key === "/") {
      input.focus();
      input.select();
    } else if (event.key === "?") toggleKeys();
    else if (event.key === "Escape" && keys) toggleKeys(false);
    else if ((event.key === "n" || event.key === "N") && hasResults) {
      const delta = event.key === "n" ? 1 : -1;
      open((selected + delta + results.length) % results.length, true);
    } else if (!cursor.handleKey(event)) return;
    event.preventDefault();
  };

  const startIndexing = () => {
    crawl?.abort();
    loader?.dispose();
    crawl = new AbortController();
    loader = (options.createLoader ?? (() => createFrameLoader(doc, win)))();
    const todo = pages.filter((page) => page.href !== win.location.pathname);
    progress = { done: 0, total: todo.length };
    const { signal } = crawl;
    const pageLoader = loader;
    void crawlPages(
      todo,
      pageLoader.load,
      (page, entries) => {
        indexed.set(page.href, entries);
        progress = { ...progress, done: progress.done + 1 };
        refresh(false);
      },
      signal,
    ).finally(() => {
      if (signal.aborted) return;
      progress = { ...progress, done: progress.total };
      pageLoader.dispose();
      refresh(false);
    });
  };

  const attach = (target: Element) => {
    const back = target.querySelector(BACK_ROW);
    const nav = target.querySelector(NAV_LIST);
    if (!back || !nav) return;
    sidebar = target;
    nav.setAttribute(NAV_ATTRIBUTE, "");
    pages = readPages(nav);

    root = doc.createElement("div");
    root.setAttribute(ROOT_ATTRIBUTE, "");
    root.insertAdjacentHTML("afterbegin", SEARCH_ICON);
    input = doc.createElement("input");
    input.type = "text";
    input.placeholder = "Search settings";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Search settings");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", "settings-search-results");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("data-vim-ignore", "");
    input.addEventListener("input", () => refresh(true));
    input.addEventListener("keydown", onInputKey);
    const hint = doc.createElement("kbd");
    hint.textContent = "/";
    root.append(input, hint);

    list = doc.createElement("div");
    list.id = "settings-search-results";
    list.setAttribute(RESULTS_ATTRIBUTE, "");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Settings search results");
    back.after(root, list);

    indexOpenPage();
    startIndexing();
    refresh(true);
  };

  const detach = () => {
    crawl?.abort();
    crawl = null;
    loader?.dispose();
    loader = null;
    stopReveal();
    root?.remove();
    list?.remove();
    sidebar?.removeAttribute(ACTIVE_ATTRIBUTE);
    sidebar?.querySelector(`[${NAV_ATTRIBUTE}]`)?.removeAttribute(NAV_ATTRIBUTE);
    sidebar = root = input = list = keys = null;
    results = [];
    selected = 0;
  };

  const sync = () => {
    frame = 0;
    const target = doc.querySelector(SETTINGS_SIDEBAR);
    if (sidebar && (target !== sidebar || !root?.isConnected)) detach();
    if (target && !sidebar) attach(target);
    if (!sidebar) return;
    cursor.sync();
    const nav = sidebar.querySelector(NAV_LIST);
    nav?.setAttribute(NAV_ATTRIBUTE, "");
    if (nav) {
      const latest = readPages(nav);
      if (latest.map((page) => page.href).join() !== pages.map((page) => page.href).join()) {
        pages = latest;
        refresh(false);
      }
    }
  };

  const schedule = () => {
    if (frame === 0) frame = win.requestAnimationFrame(sync);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener("keydown", onDocumentKey);
  schedule();

  return () => {
    observer.disconnect();
    if (frame !== 0) win.cancelAnimationFrame(frame);
    doc.removeEventListener("keydown", onDocumentKey);
    detach();
    cursor.dispose();
    hit?.removeAttribute(HIT_ATTRIBUTE);
    style.remove();
  };
}
