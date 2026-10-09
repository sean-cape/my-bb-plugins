/** Where editing a field puts the caret: vim's i and a. */
export type Caret = "start" | "end";

export type ListMotion = "up" | "down" | "top" | "bottom" | "left" | "right" | "open";

export type ClientCommand =
  | { kind: "list"; motion: ListMotion }
  | { kind: "search" }
  | { kind: "searchNext"; step: 1 | -1 }
  | { kind: "filters" }
  | { kind: "endpoint" }
  | { kind: "history" }
  | { kind: "toggleList" }
  | { kind: "edit"; caret: Caret }
  | { kind: "requestTab"; step: 1 | -1 }
  | { kind: "responseTab"; step: 1 | -1 }
  | { kind: "mode" }
  | { kind: "copyCommand" }
  | { kind: "delete" }
  | { kind: "scroll"; step: 1 | -1; amount: "half" | "page" }
  | { kind: "escape"; fromField: boolean }
  | { kind: "help" };

export const KEYMAP: Record<string, ClientCommand> = {
  j: { kind: "list", motion: "down" },
  ArrowDown: { kind: "list", motion: "down" },
  k: { kind: "list", motion: "up" },
  ArrowUp: { kind: "list", motion: "up" },
  G: { kind: "list", motion: "bottom" },
  l: { kind: "list", motion: "right" },
  ArrowRight: { kind: "list", motion: "right" },
  h: { kind: "list", motion: "left" },
  ArrowLeft: { kind: "list", motion: "left" },
  o: { kind: "list", motion: "open" },
  "/": { kind: "search" },
  n: { kind: "searchNext", step: 1 },
  N: { kind: "searchNext", step: -1 },
  f: { kind: "filters" },
  e: { kind: "endpoint" },
  c: { kind: "history" },
  b: { kind: "toggleList" },
  i: { kind: "edit", caret: "start" },
  I: { kind: "edit", caret: "start" },
  a: { kind: "edit", caret: "end" },
  A: { kind: "edit", caret: "end" },
  "]": { kind: "requestTab", step: 1 },
  "[": { kind: "requestTab", step: -1 },
  "}": { kind: "responseTab", step: 1 },
  "{": { kind: "responseTab", step: -1 },
  m: { kind: "mode" },
  y: { kind: "copyCommand" },
  Escape: { kind: "escape", fromField: false },
  "?": { kind: "help" },
};

/** Two-key commands; their first keys wait for the second instead of acting. */
export const PREFIX_KEYMAP: Record<string, ClientCommand> = {
  gg: { kind: "list", motion: "top" },
  dd: { kind: "delete" },
};

/** Vim's scroll keys keep their Ctrl. */
export const CTRL_KEYMAP: Record<string, ClientCommand> = {
  d: { kind: "scroll", step: 1, amount: "half" },
  u: { kind: "scroll", step: -1, amount: "half" },
  f: { kind: "scroll", step: 1, amount: "page" },
  b: { kind: "scroll", step: -1, amount: "page" },
};

/** What the shortcuts dialog lists, in display order. */
export const KEY_HELP: readonly { keys: readonly string[]; action: string }[] = [
  { keys: ["j", "k"], action: "Next / previous method, call, or request field; scroll the response" },
  { keys: ["gg", "G"], action: "First / last row" },
  { keys: ["l"], action: "Expand, open the method into its fields, step to a field's buttons (like Now), then on to the response" },
  { keys: ["h"], action: "Step back: collapse, go up a level, or from the response to the fields and on to the list" },
  { keys: ["o", "Enter"], action: "Open the method or call, toggle the section, or edit the field" },
  { keys: ["i", "I"], action: "Edit the field, with the caret at the start" },
  { keys: ["a", "A"], action: "Edit the field, with the caret at the end" },
  { keys: ["j", "k", "/", "Enter", "Esc"], action: "In an open enum or bool list: move, filter, pick, or close it unchanged" },
  { keys: ["dd"], action: "Remove the list item or optional field, or empty the field" },
  { keys: ["/"], action: "Search methods (Enter opens the first match), or the response when you're in it" },
  { keys: ["n", "N"], action: "Next / previous match in the response" },
  { keys: ["f"], action: "Filter methods" },
  { keys: ["e"], action: "Switch endpoint or protos" },
  { keys: ["c"], action: "Toggle call history" },
  { keys: ["b"], action: "Show / hide the method list" },
  { keys: ["[", "]"], action: "Previous / next request tab" },
  { keys: ["{", "}"], action: "Previous / next response tab" },
  { keys: ["m"], action: "Switch between form and JSON" },
  { keys: ["y"], action: "Copy as grpcurl command, or the response when you're in it" },
  { keys: ["Ctrl-d", "Ctrl-u"], action: "Half a page down / up in the pane you're in" },
  { keys: ["Ctrl-f", "Ctrl-b"], action: "A page down / up in the pane you're in" },
  { keys: ["⌘↵"], action: "Send" },
  { keys: ["Esc"], action: "Stop editing a field, then clear the search" },
  { keys: ["?"], action: "Show these shortcuts" },
];

/** A row of a list or the request form, in display order; `parent` is the index of the group it sits in. */
export type NavRow = { kind: "group"; expanded: boolean; parent: number | null; fixed?: boolean } | { kind: "item"; parent: number | null };

export type ListAction = { kind: "focus"; index: number } | { kind: "activate"; index: number };

/**
 * What a motion does from row `current`: move the cursor, or activate a row (open a method,
 * toggle a service). Left and right walk the tree the way file trees do; a `fixed` group (a
 * message in a list) is always open, so h leaves it instead of collapsing it. With no cursor
 * yet, any motion lands on `start`.
 */
export function listAction(rows: readonly NavRow[], current: number | null, motion: ListMotion, start: number): ListAction | null {
  if (rows.length === 0) return null;
  if (current === null || current < 0 || current >= rows.length) return { kind: "focus", index: Math.min(Math.max(start, 0), rows.length - 1) };
  const row = rows[current]!;
  switch (motion) {
    case "up":
      return { kind: "focus", index: Math.max(current - 1, 0) };
    case "down":
      return { kind: "focus", index: Math.min(current + 1, rows.length - 1) };
    case "top":
      return { kind: "focus", index: 0 };
    case "bottom":
      return { kind: "focus", index: rows.length - 1 };
    case "open":
      if (row.kind === "group" && row.fixed) return rows[current + 1]?.parent === current ? { kind: "focus", index: current + 1 } : null;
      return { kind: "activate", index: current };
    case "right": {
      if (row.kind === "item" || !row.expanded) return { kind: "activate", index: current };
      return rows[current + 1]?.parent === current ? { kind: "focus", index: current + 1 } : null;
    }
    case "left":
      if (row.kind === "group" && row.expanded && !row.fixed) return { kind: "activate", index: current };
      return row.parent === null ? null : { kind: "focus", index: row.parent };
  }
}

/** The tab `step` places from `current`, wrapping. */
export function cycle<T>(options: readonly T[], current: T, step: 1 | -1): T {
  const index = options.indexOf(current);
  return options[(index + step + options.length) % options.length]!;
}
