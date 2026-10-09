import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { claimKeyboard, ownsKeyboard, releaseKeyboard } from "./state";
import { keyToken, parseKeys, type ReviewCommand } from "./keys/keymap";
import type { ReviewKeys } from "./keys/review-keys-context";

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/** Enter on these presses them (the send bar's buttons after `s`, say) rather than starting a comment. */
const PRESSABLE = 'button, a[href], [role="button"], [role="radio"], [role="checkbox"], [role="tab"]';
/** As vim's `timeoutlen`: how long a half-typed command (`g`, `]`, a count) waits for its next key. */
const PENDING_TIMEOUT_MS = 1000;

/**
 * Vim-style review keys, sent only to the view that last saw a pointer or focus when several are mounted, and only
 * when the key comes from inside the view (or from nowhere in particular), so text boxes, the thread list and other
 * panels keep theirs. Spread the returned props on the view's root so it can claim the keyboard.
 */
export function useReviewKeys(
  rootRef: RefObject<HTMLElement | null>,
  keys: ReviewKeys,
  enabled: boolean,
  onCommand: (command: ReviewCommand, count: number) => void,
): { onPointerDownCapture: () => void; onFocusCapture: () => void } {
  const [owner] = useState(() => Symbol("diff-view"));
  const handler = useRef(onCommand);
  handler.current = onCommand;
  useEffect(() => () => releaseKeyboard(owner), [owner]);
  useEffect(() => {
    if (!enabled) return;
    let typed: string[] = [];
    let timer = 0;
    const reset = () => {
      typed = [];
      window.clearTimeout(timer);
      if (keys.get().pending !== "") keys.set({ pending: "" });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const root = rootRef.current;
      if (root === null || root.getClientRects().length === 0 || !ownsKeyboard(owner)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && target !== document.body && !root.contains(target)) return;
      if (target?.closest(EDITABLE) != null) return;
      const token = keyToken(event);
      if (token === null || (token === "<CR>" && target?.closest(PRESSABLE) != null)) return;
      let sequence = [...typed, token];
      let result = parseKeys(sequence);
      // A key that cannot finish the half-typed command starts a new one, as in vim.
      if (result.status === "none" && typed.length > 0) {
        sequence = [token];
        result = parseKeys(sequence);
      }
      window.clearTimeout(timer);
      if (result.status === "none") {
        reset();
        return;
      }
      event.preventDefault();
      if (result.status === "pending") {
        typed = sequence;
        keys.set({ pending: typed.join("") });
        timer = window.setTimeout(reset, PENDING_TIMEOUT_MS);
        return;
      }
      reset();
      handler.current(result.command, result.count);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(timer);
    };
  }, [enabled, keys, owner, rootRef]);
  return { onPointerDownCapture: () => claimKeyboard(owner), onFocusCapture: () => claimKeyboard(owner) };
}
