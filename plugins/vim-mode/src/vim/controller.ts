import { Vim, VimEditor } from "./adapter";
import { CodeMirrorHost, codeMirrorViewFor } from "./codemirror-host";
import type { TextHost } from "./host";
import { handleVimKey, isIdleNormalMode, vimState } from "./keys";
import { ProseMirrorHost, tiptapEditorFor } from "./prosemirror-host";
import { TextFieldHost, type TextField } from "./text-field-host";
import { UI_ATTRIBUTE, VimUi } from "./ui";

export type VimScope = "all" | "composer";

export interface VimModeOptions {
  enabled: boolean;
  scope: VimScope;
  startInInsertMode: boolean;
}

export type Reporter = (level: "info" | "error", message: string) => void;

export const DEFAULT_OPTIONS: VimModeOptions = {
  enabled: true,
  scope: "all",
  startInInsertMode: true,
};

interface Session {
  element: HTMLElement;
  host: TextHost;
  owner: unknown;
  cm: VimEditor;
  ui: VimUi;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel"]);
// Terminals and Monaco handle their own keys; the helper textareas they focus
// must never become vim targets.
const EXCLUDED_CONTAINERS = `[${UI_ATTRIBUTE}], [data-vim-ignore], .xterm, .monaco-editor`;
const PROMPTBOX = "[data-promptbox]";
const TYPEAHEAD_MENU = "[data-promptbox-typeahead-menu]";
const CODEMIRROR_COMPLETION = ".cm-tooltip-autocomplete";
const TYPEAHEAD_KEYS = new Set(["Escape", "Enter", "Tab", "ArrowUp", "ArrowDown"]);

function isPickerInput(input: HTMLInputElement): boolean {
  // Command palettes and comboboxes give Escape and arrows a meaning vim would steal.
  return (
    input.getAttribute("role") === "combobox" ||
    input.hasAttribute("aria-autocomplete") ||
    input.hasAttribute("cmdk-input") ||
    input.getAttribute("aria-haspopup") === "listbox"
  );
}

function isVisibleField(field: TextField): boolean {
  const rect = field.getBoundingClientRect();
  return rect.width >= 24 && rect.height >= 12;
}

function editableTarget(target: EventTarget | null, scope: VimScope): HTMLElement | null {
  if (!(target instanceof HTMLElement) || target.closest(EXCLUDED_CONTAINERS)) return null;
  const codeMirror = target.closest<HTMLElement>(".cm-content");
  if (codeMirror) return scope === "all" && codeMirrorViewFor(codeMirror) ? codeMirror : null;
  // Inputs inside a CodeMirror editor (its search panel) belong to that editor.
  if (target.closest(".cm-editor")) return null;
  const proseMirror = target.closest<HTMLElement>(".ProseMirror");
  if (proseMirror) {
    if (!tiptapEditorFor(proseMirror)) return null;
    if (scope === "composer" && !proseMirror.closest(PROMPTBOX)) return null;
    return proseMirror;
  }
  if (scope === "composer") return null;
  if (target instanceof HTMLTextAreaElement) return isVisibleField(target) ? target : null;
  if (
    target instanceof HTMLInputElement &&
    TEXT_INPUT_TYPES.has(target.type) &&
    !isPickerInput(target) &&
    isVisibleField(target)
  ) {
    return target;
  }
  return null;
}

function describe(element: Element): string {
  const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
  return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
}

/** Why focus on `target` did not attach vim, for targets that look editable. */
function skipReason(target: EventTarget | null, options: VimModeOptions): string | null {
  if (!(target instanceof HTMLElement)) return null;
  const looksEditable =
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    !!target.closest(".cm-editor, .ProseMirror");
  if (!looksEditable) return null;
  if (!options.enabled) return "disabled in settings";
  const excluded = target.closest(EXCLUDED_CONTAINERS);
  if (excluded) return `inside excluded ${describe(excluded)}`;
  const content = target.closest(".cm-content");
  if (content && !codeMirrorViewFor(content)) {
    const keys = Object.keys(content).filter((key) => key.startsWith("cm")).join(",") || "none";
    return `no CodeMirror view reachable from .cm-content (cm* keys: ${keys})`;
  }
  if (content && options.scope !== "all") return "CodeMirror editor outside 'Prompt box only' scope";
  const proseMirror = target.closest(".ProseMirror");
  if (proseMirror && !tiptapEditorFor(proseMirror)) return "ProseMirror element without a TipTap editor";
  return "not a supported text box";
}

/** The editor object behind an element; a new one means a new session. */
function ownerOf(element: HTMLElement): unknown {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element;
  return codeMirrorViewFor(element) ?? tiptapEditorFor(element);
}

function createHost(element: HTMLElement): TextHost | null {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return new TextFieldHost(element);
  }
  const view = codeMirrorViewFor(element);
  if (view) return new CodeMirrorHost(view);
  const editor = tiptapEditorFor(element);
  return editor ? new ProseMirrorHost(editor) : null;
}

/**
 * Installs vim editing on every supported text box in the document. Returns
 * a disposer that removes all listeners, DOM, and classes it added.
 */
export function mountVimMode(getOptions: () => VimModeOptions, report: Reporter = () => {}): () => void {
  const sessions = new Map<HTMLElement, Session>();
  let active: Session | null = null;
  // The session that most recently had focus. Focus that returns to it from
  // outside the page (another window or app) keeps its mode.
  let lastActive: Session | null = null;
  // Set when focus moves from an editor into its own `:`/`/` prompt. The
  // prompt is removed before focus returns, so relatedTarget cannot say so.
  let returningFromPrompt: Session | null = null;
  let lastKey = "";

  function sessionFor(element: HTMLElement): Session | null {
    const existing = sessions.get(element);
    if (existing) {
      if (existing.owner === ownerOf(element)) return existing;
      dispose(existing);
    }
    const host = createHost(element);
    if (!host) return null;
    const cm = new VimEditor(host);
    Vim.enterVimMode(cm as never);
    const session = { element, host, owner: ownerOf(element), cm, ui: new VimUi(cm) };
    sessions.set(element, session);
    return session;
  }

  function dispose(session: Session): void {
    if (sessions.get(session.element) === session) sessions.delete(session.element);
    if (active === session) active = null;
    if (lastActive === session) lastActive = null;
    for (const step of [
      () => session.ui.destroy(),
      () => Vim.leaveVimMode(session.cm as never),
      () => session.cm.dispose(),
      () => session.host.destroy(),
    ]) {
      try {
        step();
      } catch (error) {
        console.error("[vim-mode]", error);
      }
    }
  }

  /**
   * Runs one handler step. An exception would otherwise leave vim's state
   * half-updated for the rest of the page's life, so the session is rebuilt
   * from the editor's current text instead.
   */
  function guarded(session: Session | null, step: () => void): void {
    try {
      step();
    } catch (error) {
      console.error("[vim-mode] recovering from an error", error);
      report("error", `recovered from: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!session) return;
      const element = session.element;
      const wasActive = active === session;
      dispose(session);
      if (wasActive && document.activeElement === element) {
        try {
          activate(element, null);
        } catch (retryError) {
          console.error("[vim-mode]", retryError);
        }
      }
    }
  }

  // Editors bb has unmounted (another thread's prompt box, a closed note)
  // are dropped here; their objects can throw on access, so only the element
  // captured at attach time and the editor's identity are consulted.
  function pruneDetached(): void {
    for (const session of [...sessions.values()]) {
      let stale = !session.element.isConnected;
      if (!stale) {
        try {
          stale = ownerOf(session.element) !== session.owner;
        } catch {
          stale = true;
        }
      }
      if (stale) dispose(session);
    }
  }

  function resetMode(session: Session): void {
    const { cm } = session;
    const vim = vimState(cm);
    if (!vim) return;
    cm.sync();
    if (vim.visualMode) Vim.exitVisualMode(cm as never, false);
    if (getOptions().startInInsertMode) {
      if (!vim.insertMode) Vim.handleKey(cm as never, "i", "mapping");
    } else if (vim.insertMode) {
      Vim.exitInsertMode(cm as never, true);
    }
  }

  function isOwnUi(node: EventTarget | null): boolean {
    return node instanceof Element && !!node.closest(`[${UI_ATTRIBUTE}]`);
  }

  function activate(target: EventTarget | null, relatedTarget: EventTarget | null): void {
    const options = getOptions();
    if (isOwnUi(target)) return;
    const element = options.enabled ? editableTarget(target, options.scope) : null;
    if (!element) {
      const reason = skipReason(target, options);
      if (reason && target instanceof Element) report("info", `skip ${describe(target)}: ${reason}`);
      active?.ui.hide();
      active = null;
      return;
    }
    pruneDetached();
    const isNew = !sessions.has(element);
    const session = sessionFor(element);
    if (!session) {
      report("info", `skip ${describe(element)}: could not create a host`);
      return;
    }
    if (isNew) report("info", `attach ${session.host.kind} ${describe(element)}`);
    if (active && active !== session) active.ui.hide();
    const returning =
      active === session ||
      returningFromPrompt === session ||
      isOwnUi(relatedTarget) ||
      (relatedTarget === null && lastActive === session);
    active = session;
    lastActive = session;
    returningFromPrompt = null;
    if (!returning) resetMode(session);
    session.ui.show();
  }

  function onFocusIn(event: FocusEvent): void {
    guarded(active, () => activate(event.target, event.relatedTarget));
  }

  function onFocusOut(event: FocusEvent): void {
    if (!active) return;
    if (isOwnUi(event.relatedTarget)) {
      if (event.target === active.element) returningFromPrompt = active;
      return;
    }
    if (isOwnUi(event.target)) return;
    if (event.target === active.element) {
      active.ui.hide();
      active = null;
    }
  }

  function passThrough(event: KeyboardEvent, session: Session): boolean {
    const vim = vimState(session.cm);
    if (!vim || event.metaKey) return true;
    const promptbox = session.element.closest(PROMPTBOX);
    if (promptbox?.querySelector(TYPEAHEAD_MENU) && TYPEAHEAD_KEYS.has(event.key)) return true;
    const codeMirror = session.element.closest(".cm-editor");
    if (codeMirror?.querySelector(CODEMIRROR_COMPLETION) && TYPEAHEAD_KEYS.has(event.key)) return true;
    if (event.key === "Escape" && promptbox?.hasAttribute("data-promptbox-voice-active")) return true;
    // With nothing pending, Escape and Enter keep their app meaning
    // (dismiss/blur, send) instead of vim's no-op and cursor-down.
    const plainKey = !event.shiftKey && !event.ctrlKey && !event.altKey;
    if (plainKey && (event.key === "Escape" || event.key === "Enter") && isIdleNormalMode(vim)) return true;
    return false;
  }

  function onKeyDown(event: KeyboardEvent): void {
    lastKey = event.key;
    if (!getOptions().enabled) {
      active?.ui.hide();
      active = null;
      return;
    }
    // Focus events can be missed (for example when the window regains focus
    // in Electron), so a key in an unattached text box attaches it.
    if (!active || event.target !== active.element) {
      guarded(active, () => activate(event.target, null));
    }
    const session = active;
    if (!session || event.target !== session.element) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (!session.host.isEditable()) return;
    guarded(session, () => {
      session.cm.sync();
      if (passThrough(event, session)) return;
      // Like vim, a message stays up only until the next command.
      if (!session.cm.state.dialog?.querySelector("input")) session.cm.state.currentNotificationClose?.();
      if (handleVimKey(session.cm, event)) event.stopImmediatePropagation();
      session.ui.schedule();
    });
  }

  // Normal mode must not insert text that arrives without a usable keydown
  // (dead keys, dictation). A dead-key character is fed to vim instead.
  function onBeforeInput(event: InputEvent): void {
    const session = active;
    if (!session || event.target !== session.element || session.cm.isApplying) return;
    const vim = vimState(session.cm);
    if (!vim || vim.insertMode) return;
    if (event.inputType !== "insertText" && event.inputType !== "insertCompositionText") return;
    event.preventDefault();
    if (event.data && [...event.data].length === 1 && (lastKey === "Dead" || lastKey === "Process")) {
      guarded(session, () => {
        Vim.handleKey(session.cm as never, event.data!, "user");
        session.ui.schedule();
      });
    }
  }

  const reposition = () => active?.ui.schedule();

  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("beforeinput", onBeforeInput, true);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  guarded(null, () => activate(document.activeElement, null));

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    window.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("beforeinput", onBeforeInput, true);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    for (const session of [...sessions.values()]) dispose(session);
  };
}
