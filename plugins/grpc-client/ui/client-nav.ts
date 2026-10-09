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
  { keys: ["j", "k"], action: "Next / previous row in the list" },
  { keys: ["gg", "G"], action: "First / last row" },
  { keys: ["l"], action: "Expand the service, or open the method" },
  { keys: ["h"], action: "Collapse the service, or go to the method's service" },
  { keys: ["o", "Enter"], action: "Open the method or call, or toggle the service" },
  { keys: ["/"], action: "Search methods (Enter opens the first match)" },
  { keys: ["f"], action: "Filter methods" },
  { keys: ["e"], action: "Switch endpoint or protos" },
  { keys: ["c"], action: "Toggle call history" },
  { keys: ["b"], action: "Show / hide the method list" },
  { keys: ["i"], action: "Edit the request" },
  { keys: ["[", "]"], action: "Previous / next request tab" },
  { keys: ["{", "}"], action: "Previous / next response tab" },
  { keys: ["m"], action: "Switch between form and JSON" },
  { keys: ["y"], action: "Copy as grpcurl command" },
  { keys: ["Ctrl-d", "Ctrl-u"], action: "Scroll the response down / up" },
  { keys: ["⌘↵"], action: "Send" },
  { keys: ["Esc"], action: "Leave a text box, then clear the search" },
  { keys: ["?"], action: "Show these shortcuts" },
];

/** A row of the method or history list, in display order. `child` rows sit under the group before them. */
export type NavRow = { kind: "group"; expanded: boolean } | { kind: "item"; child: boolean };

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
      if (row.kind === "item") return { kind: "activate", index: current };
      if (!row.expanded) return { kind: "activate", index: current };
      const next = rows[current + 1];
      return next?.kind === "item" && next.child ? { kind: "focus", index: current + 1 } : null;
    }
    case "left": {
      if (row.kind === "group") return row.expanded ? { kind: "activate", index: current } : null;
      if (!row.child) return null;
      for (let index = current - 1; index >= 0; index -= 1) {
        if (rows[index]!.kind === "group") return { kind: "focus", index };
      }
      return null;
    }
  }
}

/** The tab `step` places from `current`, wrapping. */
export function cycle<T>(options: readonly T[], current: T, step: 1 | -1): T {
  const index = options.indexOf(current);
  return options[(index + step + options.length) % options.length]!;
}
