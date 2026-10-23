import { type KeyToken, keyToken } from "./keys.ts";
import { createKeyReader, type Keymap, type KeyReader, SEQUENCE_TIMEOUT_MS } from "./reader.ts";
import { isTextEntry, PRESSABLE } from "./targets.ts";

declare const __BB_PLUGIN_ID__: string | undefined;

/**
 * Dispatched (bubbling, composed) on the handler's root or the key's target after a bound command
 * runs, so one listener can see every plugin's key commands: the resolved sequence, its count, the
 * keydown that typed it, and the plugin whose bundle the handler came from.
 */
export const KEY_COMMAND_EVENT = "bb-vim-keys:command";

export interface KeyCommandDetail {
  keys: string;
  count: number | null;
  event: KeyboardEvent;
  /** `bb plugin build` defines the id into each bundle; undefined outside a build. */
  plugin: string | undefined;
}

export interface KeyContext {
  event: KeyboardEvent;
  /** Where the key came from; null when focus was on the page itself. */
  target: Element | null;
  keys: string;
  count: number | null;
}

export interface KeyHandlerOptions<C> {
  /**
   * A function picks the map by state (a pane, a picker column, a mode) or by where the key came
   * from (a select keeps its arrows); switching maps drops a half-typed sequence.
   */
  keymap: Keymap<C> | ((target: Element | null, event: KeyboardEvent) => Keymap<C>);
  /** Runs a command; false leaves the key to the page, as if unbound. */
  onCommand: (command: C, context: KeyContext) => boolean | void;
  /** Whether the handler is live at all, checked before `intercept`: say, while its surface is shown. */
  active?: () => boolean;
  /** Whether a key from `target` (null: the page body) is this handler's at all. */
  accepts?: (target: Element | null, event: KeyboardEvent) => boolean;
  /** Turns the keys off while true, such as while a dialog is up. */
  blocked?: () => boolean;
  /**
   * Whether keys typed at an element are text, which the handler leaves alone. Defaults to
   * `isTextEntry`; a search box's own handler passes `() => false` to take its keys.
   */
  isText?: (element: Element) => boolean;
  /** Escape typed in a text box; false leaves it. Without it, text boxes keep every key. */
  onTextEscape?: (field: HTMLElement, event: KeyboardEvent) => boolean | void;
  /** Enter and Space stay with a focused button or link unless this is false. */
  leaveToPressables?: boolean;
  /** The element the keys belong to, such as a scope's root; focus on it is never a button's. */
  self?: Element | (() => Element | null);
  /**
   * Sees every keydown before any check, even one another listener already took (vim-mode's
   * Escape out of a text box): for passive taps, such as noting when Escape was last pressed.
   */
  observe?: (event: KeyboardEvent) => void;
  /** Sees every key before the checks on where it came from. True takes it. */
  intercept?: (event: KeyboardEvent, token: KeyToken) => boolean;
  /** Sees each key the handler accepts, bound or not, before it is read: for work any key interrupts. */
  onKey?: (event: KeyboardEvent, token: KeyToken) => void;
  /** A key that is neither bound nor the rest of a sequence; it is left to the page. */
  onUnbound?: (event: KeyboardEvent, token: KeyToken) => void;
  /** Told the count and keys waiting for the rest of a sequence, and "" when the wait ends. */
  onPending?: (keys: string) => void;
  counts?: boolean;
  timeoutMs?: number;
  /** Keeps a key the handler takes from every later listener, not just the page's default. */
  stopImmediate?: boolean;
}

export interface KeyHandler {
  /** Handles a keydown; true when the handler took it (and prevented its default). */
  handle(event: KeyboardEvent): boolean;
  /** Drops a half-typed sequence or count. */
  reset(): void;
  readonly pending: string;
  /** Stops the pending-sequence timer and reports the wait over. */
  dispose(): void;
}

/**
 * The key engine every listener here is built on. It holds no listener of its own, so the same
 * handler can sit on the window (a page surface), on an element (a nested list that must run
 * before the page's keys), or in a React `onKeyDown` (a picker's filter box).
 */
export function createKeyHandler<C>(options: KeyHandlerOptions<C>): KeyHandler {
  const timeout = options.timeoutMs ?? SEQUENCE_TIMEOUT_MS;
  const readers = new WeakMap<object, KeyReader<C>>();
  let reader: KeyReader<C> | null = null;
  let shownPending = "";
  let expiry = 0;
  let view: (Window & typeof globalThis) | null = null;

  const readerFor = (keymap: Keymap<C>): KeyReader<C> => {
    let next = readers.get(keymap);
    if (next === undefined) {
      next = createKeyReader(keymap, { timeoutMs: timeout, counts: options.counts });
      readers.set(keymap, next);
    }
    if (reader !== null && reader !== next) reader.reset();
    reader = next;
    return next;
  };

  const pending = () => reader?.pending ?? "";

  const publish = () => {
    if (view !== null) view.clearTimeout(expiry);
    // The reader drops a stale sequence only on the next key; a mode label shouldn't wait for one.
    if (pending() !== "" && Number.isFinite(timeout) && view !== null) {
      expiry = view.setTimeout(() => {
        reader?.reset();
        publish();
      }, timeout);
    }
    if (pending() === shownPending) return;
    shownPending = pending();
    options.onPending?.(shownPending);
  };

  const reset = () => {
    if (pending() === "") return;
    reader?.reset();
    publish();
  };

  const take = (event: KeyboardEvent) => {
    event.preventDefault();
    if (options.stopImmediate === true) event.stopImmediatePropagation();
    return true;
  };

  const selfElement = () => (typeof options.self === "function" ? options.self() : (options.self ?? null));

  const handle = (event: KeyboardEvent): boolean => {
    options.observe?.(event);
    if (event.defaultPrevented) return false;
    const token = keyToken(event);
    if (token === null) return false;
    const raw = event.target instanceof Element ? event.target : null;
    view ??= raw?.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);
    if (options.active?.() === false) return false;
    if (options.intercept?.(event, token) === true) {
      reader?.reset();
      publish();
      return take(event);
    }
    const doc = raw?.ownerDocument;
    const target = raw === null || raw === doc?.body || raw === doc?.documentElement ? null : raw;
    if (options.accepts !== undefined && !options.accepts(target, event)) return false;
    if (options.blocked?.() === true) return false;
    if (target !== null && (options.isText ?? isTextEntry)(target)) {
      if (token !== "<Esc>" || options.onTextEscape === undefined) return false;
      const field = target instanceof HTMLElement ? target : target.closest<HTMLElement>("[contenteditable]");
      const self = selfElement();
      const box = field ?? (self instanceof HTMLElement ? self : null);
      if (box === null || options.onTextEscape(box, event) === false) return false;
      return take(event);
    }
    if (options.leaveToPressables !== false && (token === "<CR>" || token === "<Space>") && target !== null && target !== selfElement() && target !== event.currentTarget && target.closest(PRESSABLE) !== null) {
      return false;
    }
    options.onKey?.(event, token);
    const keymap = typeof options.keymap === "function" ? options.keymap(target, event) : options.keymap;
    const read = readerFor(keymap).read(token, event.timeStamp);
    publish();
    if (read.kind === "none") {
      options.onUnbound?.(event, token);
      return false;
    }
    if (read.kind === "pending") return take(event);
    if (options.onCommand(read.command, { event, target, keys: read.keys, count: read.count }) === false) return false;
    take(event);
    announceKeyCommand(selfElement() ?? target ?? doc ?? null, { keys: read.keys, count: read.count, event });
    return true;
  };

  return {
    handle,
    reset,
    get pending() {
      return pending();
    },
    dispose() {
      if (view !== null) view.clearTimeout(expiry);
      if (shownPending !== "") options.onPending?.("");
      shownPending = "";
    },
  };
}

/**
 * Dispatches `KEY_COMMAND_EVENT` for a command a key ran, with this bundle's plugin id: for keys
 * a plugin handles outside `createKeyHandler`, such as its bb command shortcuts.
 */
export function announceKeyCommand(on: EventTarget | null, detail: Omit<KeyCommandDetail, "plugin">): void {
  if (on === null || typeof CustomEvent === "undefined") return;
  // A command that submits or closes its surface has removed `on` by now, and an event on a
  // detached node never reaches the window.
  const target = on instanceof Node && !on.isConnected ? on.ownerDocument : on;
  if (target === null) return;
  const plugin = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  target.dispatchEvent(new CustomEvent<KeyCommandDetail>(KEY_COMMAND_EVENT, { bubbles: true, composed: true, detail: { ...detail, plugin } }));
}

export interface BindKeysOptions<C> extends KeyHandlerOptions<C> {
  /** Listens before bb and vim-mode, and keeps a key it takes from reaching them. */
  capture?: boolean;
}

/**
 * A key handler listening on `on` (the window, a document, or an element) until the returned
 * function unbinds it: for keys over bb's own DOM, where there's no plugin root to scope to.
 * A click drops a half-typed sequence, as moving the cursor does in vim.
 */
export function bindKeys<C>(on: EventTarget, options: BindKeysOptions<C>): () => void {
  const capture = options.capture === true;
  const handler = createKeyHandler({ ...options, stopImmediate: options.stopImmediate ?? capture });
  const onKeyDown = (event: Event) => void handler.handle(event as KeyboardEvent);
  const forget = () => handler.reset();
  on.addEventListener("keydown", onKeyDown, capture);
  on.addEventListener("pointerdown", forget, true);
  return () => {
    on.removeEventListener("keydown", onKeyDown, capture);
    on.removeEventListener("pointerdown", forget, true);
    handler.dispose();
  };
}
