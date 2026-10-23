/**
 * Keys in vim notation: a printable key is itself (`j`, `G`, `?`), anything else is bracketed
 * (`<C-d>`, `<Esc>`, `<CR>`, `<Space>`, `<Down>`, `<S-Tab>`). A sequence is tokens run together:
 * `gg`, `dd`, `<C-w>j`.
 */
export type KeyToken = string;

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "FnLock", "Hyper", "Super", "OS", "AltGraph"]);

const NAMED: Readonly<Record<string, string>> = {
  Escape: "Esc",
  Enter: "CR",
  " ": "Space",
  Tab: "Tab",
  Backspace: "BS",
  Delete: "Del",
  ArrowDown: "Down",
  ArrowUp: "Up",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
};

const FUNCTION_KEY = /^F\d{1,2}$/;

/**
 * The token a keydown types, or null when it can't be a plugin key: a ⌘ or ⌥ chord (bb's and the
 * system's), a bare modifier (Shift's own keydown arrives between `g` and `O`, and mustn't end a
 * sequence), or text still being composed.
 */
export function keyToken(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "isComposing">): KeyToken | null {
  const { key } = event;
  if (event.isComposing || event.metaKey || event.altKey || MODIFIER_KEYS.has(key) || key === "Dead" || key === "Unidentified" || key === "Process") return null;
  const named = NAMED[key] ?? (FUNCTION_KEY.test(key) ? key : undefined);
  if (named !== undefined) {
    // Of the named keys only Tab means something else with Shift; an arrow or Enter still counts with Shift held.
    const shift = event.shiftKey && key === "Tab" ? "S-" : "";
    return `<${event.ctrlKey ? "C-" : ""}${shift}${named}>`;
  }
  if ([...key].length !== 1) return null;
  if (event.ctrlKey) return `<C-${event.shiftKey ? "S-" : ""}${key.toLowerCase()}>`;
  return key;
}

/** `keyToken` that also names the ⌘ and ⌥ chords it leaves to bb: `<D-k>`, `<A-S-Left>`, `<D-C-f>`. */
export function chordToken(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "isComposing">): KeyToken | null {
  if (!event.metaKey && !event.altKey) return keyToken(event);
  const inner = keyToken({ key: event.key, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: false, metaKey: false, isComposing: event.isComposing });
  if (inner === null) return null;
  const body = inner.startsWith("<") ? inner.slice(1, -1) : inner.length === 1 && inner !== inner.toLowerCase() ? `S-${inner.toLowerCase()}` : inner;
  return `<${event.metaKey ? "D-" : ""}${event.altKey ? "A-" : ""}${body}>`;
}

const TOKEN = /<[^<>]+>|[^]/gu;

export function tokenize(sequence: string): KeyToken[] {
  return sequence.match(TOKEN) ?? [];
}

const DISPLAY: Readonly<Record<string, string>> = {
  Esc: "Esc",
  CR: "Enter",
  Space: "Space",
  BS: "Backspace",
  Del: "Delete",
  Down: "↓",
  Up: "↑",
  Left: "←",
  Right: "→",
};

/** How a token reads in a shortcuts list: `<C-d>` is Ctrl-d, `<CR>` is Enter. */
export function displayToken(token: KeyToken): string {
  if (!token.startsWith("<") || token.length < 3) return token;
  let name = token.slice(1, -1);
  const parts: string[] = [];
  if (name.startsWith("C-")) {
    parts.push("Ctrl");
    name = name.slice(2);
  }
  if (name.startsWith("S-")) {
    parts.push("Shift");
    name = name.slice(2);
  }
  parts.push(DISPLAY[name] ?? name);
  return parts.join("-");
}

/** How a sequence reads in a shortcuts list: `gg` stays `gg`, `<C-w>j` is `Ctrl-w j`. */
export function displaySequence(sequence: string): string {
  const tokens = tokenize(sequence);
  return tokens.every((token) => !token.startsWith("<") || token.length < 3) ? tokens.join("") : tokens.map(displayToken).join(" ");
}
