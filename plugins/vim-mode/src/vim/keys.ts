import { Vim, VimEditor } from "./adapter";

export interface VimState {
  insertMode: boolean;
  visualMode: boolean;
  visualLine: boolean;
  visualBlock: boolean;
  status: string;
  expectLiteralNext?: boolean;
  inputState: {
    operator?: string | null;
    motion?: string | null;
    keyBuffer: string[];
    prefixRepeat: string[];
    motionRepeat: string[];
    registerName?: string;
  };
}

export function vimState(cm: VimEditor): VimState | null {
  return (cm.state.vim as VimState | null | undefined) ?? null;
}

/** True when normal mode has no partially typed command. */
export function isIdleNormalMode(vim: VimState): boolean {
  const input = vim.inputState;
  return (
    !vim.insertMode &&
    !vim.visualMode &&
    !vim.expectLiteralNext &&
    !input.operator &&
    !input.motion &&
    !input.registerName &&
    input.keyBuffer.length === 0 &&
    input.prefixRepeat.length === 0 &&
    input.motionRepeat.length === 0
  );
}

function isPrintable(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey;
}

/**
 * Feeds one keydown to the vim engine, mirroring @replit/codemirror-vim's key
 * handler. Returns true when vim consumed the key; the caller should then stop
 * the event from reaching the editor and the app.
 */
export function handleVimKey(cm: VimEditor, event: KeyboardEvent): boolean {
  let vim = vimState(cm);
  if (!vim) return false;
  const key = Vim.vimKeyFromEvent(event, vim as never);
  if (!key) return false;
  if (!vim.insertMode) cm.beginCommand();
  vim.status = (vim.status || "") + key;
  let handled = !!Vim.multiSelectHandleKey(cm as never, key, "user");
  vim = Vim.maybeInitVimState_(cm as never) as unknown as VimState;
  if (!handled && vim.insertMode && cm.state.overwrite) {
    if (event.key.length === 1 && !/\n/.test(event.key)) {
      handled = true;
      cm.overWriteSelection(event.key);
    } else if (event.key === "Backspace") {
      handled = true;
      VimEditor.commands.cursorCharLeft!(cm);
    }
  }
  // Normal and visual mode never insert text, even for keys vim leaves unmapped.
  if (!handled && !vim.insertMode && (isPrintable(event) || event.key === "Enter")) handled = true;
  if (handled) {
    cm.signal("vim-keypress", key);
    event.preventDefault();
    event.stopPropagation();
  }
  return handled;
}
