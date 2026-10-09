export type ListMotion = "up" | "down" | "top" | "bottom" | "left" | "right" | "open";

export type ClientCommand =
  | { kind: "list"; motion: ListMotion }
  | { kind: "search" }
  | { kind: "filters" }
  | { kind: "endpoint" }
  | { kind: "history" }
  | { kind: "toggleList" }
  | { kind: "edit" }
  | { kind: "requestTab"; step: 1 | -1 }
  | { kind: "responseTab"; step: 1 | -1 }
  | { kind: "mode" }
  | { kind: "copyCommand" }
  | { kind: "clear" }
  | { kind: "scroll"; step: 1 | -1 }
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
  f: { kind: "filters" },
  e: { kind: "endpoint" },
  c: { kind: "history" },
  b: { kind: "toggleList" },
  i: { kind: "edit" },
  "]": { kind: "requestTab", step: 1 },
  "[": { kind: "requestTab", step: -1 },
  "}": { kind: "responseTab", step: 1 },
  "{": { kind: "responseTab", step: -1 },
  m: { kind: "mode" },
  y: { kind: "copyCommand" },
  x: { kind: "clear" },
  Escape: { kind: "escape", fromField: false },
  "?": { kind: "help" },
};

/** Vim's scroll keys keep their Ctrl. */
export const CTRL_KEYMAP: Record<string, ClientCommand> = {
  d: { kind: "scroll", step: 1 },
  u: { kind: "scroll", step: -1 },
};

/** What the shortcuts dialog lists, in display order. */
export const KEY_HELP: readonly { keys: readonly string[]; action: string }[] = [
  { keys: ["j", "k"], action: "Next / previous method, call, or request field" },
  { keys: ["gg", "G"], action: "First / last row" },
  { keys: ["l"], action: "Expand, open the method and go to its fields, or edit the field" },
  { keys: ["h"], action: "Collapse, go up a level, or go from the fields back to the list" },
  { keys: ["o", "Enter"], action: "Open the method or call, toggle the section, or edit the field" },
  { keys: ["i"], action: "Edit the field under the cursor" },
  { keys: ["x"], action: "Clear the field, or remove the item" },
  { keys: ["/"], action: "Search methods (Enter opens the first match)" },
  { keys: ["f"], action: "Filter methods" },
  { keys: ["e"], action: "Switch endpoint or protos" },
  { keys: ["c"], action: "Toggle call history" },
  { keys: ["b"], action: "Show / hide the method list" },
  { keys: ["[", "]"], action: "Previous / next request tab" },
  { keys: ["{", "}"], action: "Previous / next response tab" },
  { keys: ["m"], action: "Switch between form and JSON" },
  { keys: ["y"], action: "Copy as grpcurl command" },
  { keys: ["Ctrl-d", "Ctrl-u"], action: "Scroll the response down / up" },
  { keys: ["⌘↵"], action: "Send" },
  { keys: ["Esc"], action: "Stop editing a field, then clear the search" },
  { keys: ["?"], action: "Show these shortcuts" },
];

/** A row of a list or the request form, in display order; `parent` is the index of the group it sits in. */
export type NavRow = { kind: "group"; expanded: boolean; parent: number | null } | { kind: "item"; parent: number | null };

export type ListAction = { kind: "focus"; index: number } | { kind: "activate"; index: number };

/**
 * What a motion does from row `current`: move the cursor, or activate a row (open a method,
 * toggle a service). Left and right walk the tree the way file trees do. With no cursor yet,
 * any motion lands on `start`.
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
      return { kind: "activate", index: current };
    case "right": {
      if (row.kind === "item" || !row.expanded) return { kind: "activate", index: current };
      return rows[current + 1]?.parent === current ? { kind: "focus", index: current + 1 } : null;
    }
    case "left":
      if (row.kind === "group" && row.expanded) return { kind: "activate", index: current };
      return row.parent === null ? null : { kind: "focus", index: row.parent };
  }
}

/** The tab `step` places from `current`, wrapping. */
export function cycle<T>(options: readonly T[], current: T, step: 1 | -1): T {
  const index = options.indexOf(current);
  return options[(index + step + options.length) % options.length]!;
}
