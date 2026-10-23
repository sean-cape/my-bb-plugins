// The sink: one set of window listeners that turns clicks, keys, and page changes anywhere in bb
// into activity events, attributed to the plugin whose root they happened under.
import { chordToken, isTextEntry, KEY_COMMAND_EVENT, type KeyCommandDetail, PRESSABLE, tokenize } from "bb-vim-keys";
import { type ActivityEvent, MAX_TEXT } from "./contract";

export interface CollectorOptions {
  /** Delivers a batch; a rejection keeps the batch for the next flush. */
  send: (events: ActivityEvent[]) => Promise<void>;
  now?: () => number;
  /** How often buffered events go out. */
  flushMs?: number;
  /** Oldest events are dropped past this while `send` keeps failing. */
  maxBuffer?: number;
  route?: () => string;
}

export interface Collector {
  flush(): Promise<void>;
  dispose(): void;
}

const PLUGIN_ROOT = "[data-bb-plugin]";
/** What a click lands on: bb's pressables plus menu, list, and tree items and the rows plugin cursors move over. */
const CONTROL = `${PRESSABLE}, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="treeitem"], [role="row"], [role="link"], [data-nav-row], label, summary`;
/** Rows whose text is content (a thread's title) rather than a name; they group by the list they sit in. */
const CONTENT_ROLES = new Set(["option", "treeitem", "row", "gridcell", "listitem", "article"]);
/** Roles that name a part of a page a control can sit in. */
const STRUCTURAL_ROLES = new Set(["list", "listbox", "tree", "grid", "table", "menu", "menubar", "tablist", "tabpanel", "toolbar", "dialog", "alertdialog", "navigation", "region", "log", "feed", "form", "search", "group", "radiogroup", "main", "complementary", "banner"]);
/** `data-*` names (after the prefix) that carry state or belong to bb, the key library, or a UI kit, never a kind of thing. */
const NOT_A_TYPE = /^(?:bb-|nav-|vim-|aura-|radix-|escape-|lazy-|bbm-|testid$|state$|slot$|index$|value$|cursor$|row$|line$|alt-line$|orientation$|side$|align$|highlighted$|disabled$|selected$|open$)/u;
const LIST = '[role="list"], [role="listbox"], [role="tree"], [role="grid"], [role="menu"], [role="tablist"], [role="radiogroup"], [data-nav-group], ul, ol, table, nav, section, aside, main, dialog, [role="dialog"]';
const HEADING = "h1, h2, h3, h4, h5, h6, legend, caption";
/** bb's conversation: the timeline and the question, approval, and plan banners, whose text the agent or the user wrote. */
const CONVERSATION = '[data-timeline-row-list], [data-testid="user-question-banner"], [data-testid="approval-banner"], [data-testid="plan-review-banner"]';
const POINTER_CLICK_MS = 500;
/** Segments that are ids or file names, not page names. */
const ID_SEGMENT = /^(?:[a-z]+_[A-Za-z0-9]+|[0-9a-f]{8,}|\d+|.+\.[A-Za-z0-9]{1,5})$/u;
const ROUTE_DEPTH = 3;
/** Longer than any control's name; past it a button's text is the content it shows. */
const NAME_LENGTH = 48;
/** A heading longer than this, or with a digit in it, is a title or a date rather than a section's name. */
const HEADING_LENGTH = 24;
/** Labels at least this long get their digits blanked; shorter ones (7d, 24h) are nothing without them. */
const BLANK_DIGITS_FROM = 5;
/** A button with this many text-bearing parts is a row of badges and fields, not a named control. */
const COMPOSITE_PARTS = 3;

export function clip(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_TEXT ? `${collapsed.slice(0, MAX_TEXT - 1)}…` : collapsed;
}

/** A thread's file page becomes `/threads/⁎/files/⁎` (with asterisks): ids and file names blanked, cut after three segments. */
export function normalizeRoute(pathname: string): string {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const kept = segments.slice(0, ROUTE_DEPTH).map((segment) => (ID_SEGMENT.test(segment) ? "*" : decodeURIComponent(segment)));
  if (segments.length > ROUTE_DEPTH) kept.push("…");
  return `/${kept.join("/")}`;
}

/** The plugin whose panel a route shows, from bb's `/plugins/<id>/…` routes. */
export function routePlugin(pathname: string): string | null {
  const match = /^\/plugins\/([^/]+)/u.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1]!);
}

/** `closest` that keeps going out of shadow roots (bb's diff renderer draws lines inside one). */
function closestThrough(start: Element | null, selector: string): Element | null {
  for (let node: Element | null = start; node !== null; ) {
    const found = node.closest(selector);
    if (found !== null) return found;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

export function pluginOf(element: Element | null): string | null {
  return closestThrough(element, PLUGIN_ROOT)?.getAttribute("data-bb-plugin") ?? null;
}

function ownText(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/u)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (text.trim() !== "") return text;
  }
  const text = element.textContent ?? "";
  if (text.trim() !== "") return text;
  const image = element.querySelector("img[alt], svg[aria-label], [aria-label]");
  return image?.getAttribute("alt") ?? image?.getAttribute("aria-label") ?? "";
}

/** A word that is a file name: a base, optional dotted parts, and an extension that isn't a web domain. */
const FILE_NAME = /^[\w-]{2,}(?:\.[\w-]+)*\.(?!(?:com|org|net|io|dev|app|co)$)[a-z][a-z0-9]{0,4}$/iu;
const PUNCTUATION = /^[(["'“‘]+|[)\]"'”’,.;:!?]+$/gu;

/**
 * Text with its content taken out: file names and paths blanked, and, when `digits` is set and the
 * text is long enough to still read, numbers too. Short labels (7d, 24h) keep their digits.
 */
export function generalize(text: string, digits: boolean): string {
  const words = clip(text)
    .split(" ")
    .map((word) => {
      const bare = word.replace(PUNCTUATION, "");
      if (bare.includes("/") && /\w/u.test(bare)) return word.replace(bare, "<path>");
      if (FILE_NAME.test(bare)) return word.replace(bare, "<file>");
      return word;
    })
    .join(" ");
  return digits && words.length >= BLANK_DIGITS_FROM ? words.replace(/\d[\d,.]*/gu, "#") : words;
}

/**
 * The kind of thing an element is, from a `data-*` attribute of its own that names a type: a marker
 * with no value (`data-kanban-card`) or an identity (`data-ticket-id`). Attributes carrying state or
 * belonging to bb, the key library, or a UI kit don't count.
 */
export function typeOf(element: Element): string | null {
  for (const { name, value } of Array.from(element.attributes)) {
    if (!name.startsWith("data-")) continue;
    const bare = name.slice(5);
    if (NOT_A_TYPE.test(bare)) continue;
    if (value !== "" && !bare.endsWith("-id")) continue;
    return bare.replace(/-id$/u, "").replace(/-/gu, " ");
  }
  return null;
}

/** A heading names its section only when it reads as a name, not a date or a title. */
function headingName(container: Element): string | null {
  const heading = container.querySelector(HEADING);
  const text = clip(heading?.textContent ?? "");
  if (text === "" || text.length > HEADING_LENGTH || /\d/u.test(text)) return null;
  return text;
}

/**
 * What a control sits in, below its plugin's root: the nearest ancestor with a label, a test id, a
 * type of its own, or a structural role; failing those, the nearest list-like ancestor's heading.
 * Null when nothing below the root says.
 */
export function containerOf(element: Element): string | null {
  const ancestors: Element[] = [];
  for (let node = element.parentElement; node !== null && !node.hasAttribute("data-bb-plugin") && node !== node.ownerDocument.body; node = node.parentElement) ancestors.push(node);
  // A message's headings are the conversation's, not a section's name.
  const headings = closestThrough(element, CONVERSATION) === null;
  for (const node of ancestors) {
    const named = node.getAttribute("aria-label");
    if (named !== null && named.trim() !== "") {
      // "Browser preview controls: <page title>" names the region before the colon and the thing it shows after.
      const name = generalize(named.split(": ")[0]!, true);
      if (name.length <= NAME_LENGTH) return name;
    }
    const testId = node.getAttribute("data-testid");
    if (testId !== null && testId !== "") return testId;
    const type = typeOf(node);
    if (type !== null) return type;
    const role = node.getAttribute("role");
    if (role !== null && STRUCTURAL_ROLES.has(role)) {
      const heading = headings ? headingName(node) : null;
      return heading === null ? role : `${role} ${heading}`;
    }
  }
  if (!headings) return null;
  for (const node of ancestors) {
    if (!node.matches(LIST)) continue;
    const heading = headingName(node);
    if (heading !== null) return heading;
  }
  return null;
}

/** Whether the element is itself a row whose text is content: an option, a tree or table row, a cursor row, a list item. */
function isContentRow(element: Element): boolean {
  const role = element.getAttribute("role");
  if (role !== null && CONTENT_ROLES.has(role)) return true;
  if (element.hasAttribute("data-nav-row")) return element.getAttribute("data-nav-row") !== "toolbar";
  return element.matches("li, tr");
}

/** How many descendants carry text of their own; a row made of badges and fields reads as content, a labelled button doesn't. */
function textBearingDescendants(element: Element): number {
  let count = 0;
  for (const child of Array.from(element.querySelectorAll("*"))) {
    if (Array.from(child.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? "").trim() !== "")) count++;
  }
  return count;
}

export interface ControlDescription {
  /** What groups the same control across clicks. */
  key: string;
  /** How it reads; carries no content, only digits a short label keeps. */
  label: string;
}

/**
 * A control described without its content: a test id; a link's page; a row by its kind and the list
 * it sits in; a long or badge-filled button, or one in the conversation without an aria-label, by its tag
 * and container; else its name with numbers and file names blanked, plus the thing it sits in
 * (`Cancel in kanban card`) when one is marked.
 */
export function describeControl(element: Element): ControlDescription {
  const tag = element.tagName.toLowerCase();
  const testId = element.getAttribute("data-testid");
  if (testId !== null) return { key: `#${testId}`, label: `#${testId}` };
  if (element instanceof HTMLAnchorElement && element.getAttribute("href") !== null) {
    const href = element.getAttribute("href")!;
    if (href.startsWith("/")) {
      const key = `link ${normalizeRoute(href.split(/[?#]/u)[0]!)}`;
      return { key, label: key };
    }
    if (!href.startsWith("#")) return { key: "external link", label: "external link" };
  }
  const container = containerOf(element) ?? "page";
  // A thing with an identity or a marker of its own (a card, a thread) is content whatever its role.
  const type = typeOf(element);
  if (type !== null || isContentRow(element)) {
    const role = element.getAttribute("role");
    const kind = type ?? element.getAttribute("data-nav-row") ?? (role !== null && CONTENT_ROLES.has(role) ? role : tag);
    const key = `${kind} in ${container}`;
    return { key, label: key };
  }
  // In the conversation a button's text and its tooltip are what it shows (a command bb ran, a question the agent asked); only a label names it.
  const conversation = closestThrough(element, CONVERSATION) !== null;
  const named = element.getAttribute("aria-label") ?? (conversation ? null : element.getAttribute("title"));
  const raw = named ?? ownText(element);
  const label = generalize(raw, false);
  const composite = named === null && textBearingDescendants(element) >= COMPOSITE_PARTS;
  if (label === "" || label.length > NAME_LENGTH || composite || (conversation && named === null)) {
    const key = `<${tag}> in ${container}`;
    return { key, label: key };
  }
  const where = containerOf(element) === null ? "" : ` in ${container}`;
  return { key: `${generalize(raw, true)}${where}`, label: `${label}${where}` };
}

export function controlKey(element: Element): string {
  return describeControl(element).key;
}

export function controlLabel(element: Element): string {
  return describeControl(element).label;
}

function controlOf(target: Element | null, win: Window): Element | null {
  if (target === null) return null;
  const control = closestThrough(target, CONTROL);
  if (control !== null) return control;
  // A React onClick on a plain div: the cursor is the only sign it's a control.
  for (let node: Element | null = target, depth = 0; node !== null && depth < 5; node = node.parentElement, depth++) {
    if (win.getComputedStyle(node).cursor === "pointer") return node;
  }
  return null;
}

function eventTarget(event: Event): Element | null {
  const first = event.composedPath()[0];
  return first instanceof Element ? first : event.target instanceof Element ? event.target : null;
}

export function mountCollector(doc: Document, win: Window, options: CollectorOptions): Collector {
  const now = options.now ?? Date.now;
  const flushMs = options.flushMs ?? 5000;
  const maxBuffer = options.maxBuffer ?? 500;
  const currentRoute = options.route ?? (() => win.location.pathname);

  let buffer: ActivityEvent[] = [];
  let sending = false;
  /** Raw key records that a command announcement may turn out to be. */
  const pendingKeys = new WeakMap<KeyboardEvent, ActivityEvent>();
  let lastKey: { record: ActivityEvent; token: string; at: number } | null = null;
  let lastPointerDown = -Infinity;
  let lastRoute = "";

  const push = (record: ActivityEvent) => {
    buffer.push(record);
    if (buffer.length > maxBuffer) buffer.splice(0, buffer.length - maxBuffer);
  };

  const drop = (record: ActivityEvent) => {
    const index = buffer.lastIndexOf(record);
    if (index !== -1) buffer.splice(index, 1);
  };

  const flush = async () => {
    if (sending || buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    sending = true;
    try {
      await options.send(batch);
    } catch {
      buffer = [...batch, ...buffer].slice(-maxBuffer);
    } finally {
      sending = false;
    }
  };

  const route = () => normalizeRoute(currentRoute());

  const onPointerDown = () => {
    lastPointerDown = now();
  };

  const onClick = (event: Event) => {
    const target = eventTarget(event);
    const control = controlOf(target, win);
    if (control === null) return;
    const keyboard = (event as MouseEvent).detail === 0 && now() - lastPointerDown > POINTER_CLICK_MS;
    // Enter or Space on a button fires this click; the click is the record, with how it was made.
    if (keyboard && lastKey !== null && now() - lastKey.at < POINTER_CLICK_MS && (lastKey.token === "<CR>" || lastKey.token === "<Space>")) drop(lastKey.record);
    const { key, label } = describeControl(control);
    push({ at: now(), kind: "click", plugin: pluginOf(control), route: route(), key, label, via: keyboard ? "keyboard" : "pointer", count: null });
  };

  const onKeyDown = (event: Event) => {
    const keydown = event as KeyboardEvent;
    if (keydown.repeat || keydown.isComposing) return;
    const target = eventTarget(keydown);
    if (isTextEntry(target)) return;
    const token = chordToken(keydown);
    if (token === null) return;
    const record: ActivityEvent = { at: now(), kind: "key", plugin: pluginOf(target), route: route(), key: token, label: token, via: null, count: null };
    push(record);
    pendingKeys.set(keydown, record);
    lastKey = { record, token, at: record.at };
    const pressed = token === "<CR>" || token === "<Space>" ? closestThrough(target, CONTROL) : null;
    win.setTimeout(() => {
      if (record.kind !== "key" || !buffer.includes(record)) return;
      if (pressed !== null) {
        // A role="button" element that opens on its own keydown (a board card) fires no click; the key pressed it all the same.
        Object.assign(record, describeControl(pressed), { kind: "click", plugin: pluginOf(pressed), via: "keyboard" });
        return;
      }
      // A type-to-search box (bb's settings search, a palette) takes a key pressed on the page and
      // then holds focus; that key was text, not a shortcut, so it goes once the box has focus.
      if (isTextEntry(doc.activeElement)) drop(record);
    }, 0);
  };

  /** The raw keys a sequence or count was typed as, sitting just before `record` in the buffer. */
  const trimSequence = (record: ActivityEvent, keys: string, count: number | null) => {
    const typed = [...(count === null ? [] : [...String(count)]), ...tokenize(keys)];
    let index = buffer.lastIndexOf(record) - 1;
    for (let position = typed.length - 2; position >= 0 && index >= 0; position--, index--) {
      const earlier = buffer[index]!;
      if (earlier.kind !== "key" || earlier.key !== typed[position]) break;
      buffer.splice(index, 1);
    }
  };

  const onCommand = (event: Event) => {
    const { detail } = event as CustomEvent<KeyCommandDetail>;
    if (detail === null || typeof detail !== "object" || typeof detail.keys !== "string") return;
    const plugin = detail.plugin ?? pluginOf(event.target instanceof Element ? event.target : null);
    const pending = detail.event instanceof KeyboardEvent ? pendingKeys.get(detail.event) : undefined;
    const record = pending ?? { at: now(), kind: "command", plugin, route: route(), key: detail.keys, label: detail.keys, via: null, count: detail.count };
    if (pending !== undefined) {
      pending.kind = "command";
      pending.key = detail.keys;
      pending.label = detail.keys;
      pending.count = detail.count;
      if (plugin !== null) pending.plugin = plugin;
    } else push(record);
    trimSequence(record, detail.keys, detail.count);
  };

  const noteRoute = () => {
    const path = currentRoute();
    const normalized = normalizeRoute(path);
    if (normalized === lastRoute) return;
    lastRoute = normalized;
    push({ at: now(), kind: "route", plugin: routePlugin(path), route: normalized, key: normalized, label: normalized, via: null, count: null });
  };

  const onHidden = () => {
    if (doc.visibilityState === "hidden") void flush();
  };

  win.addEventListener("pointerdown", onPointerDown, true);
  win.addEventListener("click", onClick, true);
  win.addEventListener("keydown", onKeyDown, true);
  win.addEventListener(KEY_COMMAND_EVENT, onCommand);
  win.addEventListener("popstate", noteRoute);
  doc.addEventListener("visibilitychange", onHidden);
  win.addEventListener("pagehide", () => void flush());
  const navigation = (win as Window & { navigation?: EventTarget }).navigation;
  const onNavigate = () => void win.setTimeout(noteRoute, 0);
  navigation?.addEventListener("navigatesuccess", onNavigate);
  // Not every route change is a navigation event (bb swaps panels in place), so look now and then.
  const routeTimer = win.setInterval(noteRoute, 1000);
  const flushTimer = win.setInterval(() => void flush(), flushMs);
  noteRoute();

  return {
    flush,
    dispose() {
      win.removeEventListener("pointerdown", onPointerDown, true);
      win.removeEventListener("click", onClick, true);
      win.removeEventListener("keydown", onKeyDown, true);
      win.removeEventListener(KEY_COMMAND_EVENT, onCommand);
      win.removeEventListener("popstate", noteRoute);
      doc.removeEventListener("visibilitychange", onHidden);
      navigation?.removeEventListener("navigatesuccess", onNavigate);
      win.clearInterval(routeTimer);
      win.clearInterval(flushTimer);
      void flush();
    },
  };
}
