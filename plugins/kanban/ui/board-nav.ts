/** Ticket ids per column, left to right, top to bottom, as the board shows them. */
export type BoardLayout = readonly (readonly string[])[];

export type Direction = "left" | "right" | "up" | "down";
export type Motion = Direction | "top" | "bottom" | "first-column" | "last-column";

export type BoardCommand =
  | { kind: "cursor"; motion: Motion }
  | { kind: "move"; direction: Direction }
  | { kind: "open" }
  | { kind: "thread" }
  | { kind: "diff" }
  | { kind: "add" }
  | { kind: "help" }
  | { kind: "toggle-hidden" }
  | { kind: "toggle-view" }
  | { kind: "toggle-done" }
  | { kind: "focus-input" }
  | { kind: "scroll"; direction: 1 | -1 };

export const KEYMAP: Record<string, BoardCommand> = {
  h: { kind: "cursor", motion: "left" },
  ArrowLeft: { kind: "cursor", motion: "left" },
  l: { kind: "cursor", motion: "right" },
  ArrowRight: { kind: "cursor", motion: "right" },
  j: { kind: "cursor", motion: "down" },
  ArrowDown: { kind: "cursor", motion: "down" },
  k: { kind: "cursor", motion: "up" },
  ArrowUp: { kind: "cursor", motion: "up" },
  G: { kind: "cursor", motion: "bottom" },
  "0": { kind: "cursor", motion: "first-column" },
  $: { kind: "cursor", motion: "last-column" },
  H: { kind: "move", direction: "left" },
  L: { kind: "move", direction: "right" },
  J: { kind: "move", direction: "down" },
  K: { kind: "move", direction: "up" },
  o: { kind: "open" },
  t: { kind: "thread" },
  d: { kind: "diff" },
  a: { kind: "add" },
  T: { kind: "toggle-view" },
  x: { kind: "toggle-done" },
  i: { kind: "focus-input" },
  "?": { kind: "help" },
};

/** Ctrl chords, which the single-key map can't hold because every other modifier turns keys off. */
export const CTRL_KEYMAP: Record<string, BoardCommand> = {
  d: { kind: "scroll", direction: 1 },
  u: { kind: "scroll", direction: -1 },
};

export interface KeyHelpSection {
  title: string;
  keys: readonly { keys: readonly string[]; action: string }[];
}

/** Two-key commands; their first key does nothing until the second arrives. */
export const PREFIXED_KEYMAP: Record<string, BoardCommand> = {
  gg: { kind: "cursor", motion: "top" },
  za: { kind: "toggle-hidden" },
};

/** What the shortcuts dialog lists, in display order. */
export const KEY_HELP: readonly KeyHelpSection[] = [
  {
    title: "Board",
    keys: [
      { keys: ["h", "l"], action: "Previous / next column" },
      { keys: ["j", "k"], action: "Next / previous card; k past the top card reaches the column's + and then the top bar" },
      { keys: ["gg", "G"], action: "First / last card in the column" },
      { keys: ["0", "$"], action: "First / last column" },
      { keys: ["H", "L"], action: "Move card to the previous / next column" },
      { keys: ["J", "K"], action: "Move card down / up" },
      { keys: ["o", "Enter"], action: "Open card" },
      { keys: ["t"], action: "Open the card's thread" },
      { keys: ["d"], action: "View the card's changes" },
      { keys: ["a"], action: "New card in this column" },
      { keys: ["za"], action: "Show / hide cards past the column's hide-after days" },
      { keys: ["Ctrl-d", "Ctrl-u"], action: "Scroll the column half a page" },
      { keys: ["T"], action: "Switch between the board and the todo list" },
      { keys: ["?"], action: "Show these shortcuts" },
    ],
  },
  {
    title: "Todo list",
    keys: [
      { keys: ["j", "k"], action: "Next / previous todo; k past the top reaches the tag filters and the top bar" },
      { keys: ["gg", "G"], action: "First / last todo" },
      { keys: ["x"], action: "Mark done / reopen" },
      { keys: ["o", "Enter"], action: "Open the card" },
      { keys: ["t"], action: "Open the card's thread" },
      { keys: ["i", "a"], action: "Type a new todo; Esc (twice with vim-mode) returns to the list" },
      { keys: ["Ctrl-d", "Ctrl-u"], action: "Scroll half a page" },
      { keys: ["T"], action: "Switch back to the board" },
    ],
  },
  {
    title: "Top bar, column + and filters",
    keys: [
      { keys: ["h", "l"], action: "Previous / next button" },
      { keys: ["0", "$"], action: "First / last button" },
      { keys: ["j", "k"], action: "Down to the cards / up to the top bar" },
      { keys: ["o", "Enter", "Space"], action: "Press the button" },
      { keys: ["j", "k"], action: "Inside the settings menu: next / previous item" },
    ],
  },
  {
    title: "Open card",
    keys: [
      { keys: ["j", "k"], action: "Field or button below / above" },
      { keys: ["h", "l"], action: "Left / right in a row; h past the left edge returns to the board" },
      { keys: ["gg", "G"], action: "First / last field or button" },
      { keys: ["Ctrl-d", "Ctrl-u"], action: "Scroll half a page" },
      { keys: ["Enter", "Space"], action: "Press the button, or start typing in the field" },
      { keys: ["i"], action: "Start typing in the field, or the description" },
      { keys: ["Esc"], action: "Leave the text box (twice with vim-mode), then close the card" },
      { keys: ["t", "d"], action: "Open the card's thread / changes" },
    ],
  },
];

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Groups stops, given in document order, into visual rows sorted left to right; a stop joins a row it overlaps vertically. */
function rowsOf(boxes: readonly Box[]): number[][] {
  const rows: number[][] = [];
  let top = 0;
  let bottom = 0;
  boxes.forEach((box, index) => {
    const row = rows[rows.length - 1];
    if (row !== undefined && box.top < bottom && box.bottom > top) {
      row.push(index);
      top = Math.min(top, box.top);
      bottom = Math.max(bottom, box.bottom);
    } else {
      rows.push([index]);
      top = box.top;
      bottom = box.bottom;
    }
  });
  return rows.map((row) => row.sort((a, b) => boxes[a]!.left - boxes[b]!.left));
}

function horizontalGap(a: Box, b: Box): number {
  return Math.max(0, a.left - b.right, b.left - a.right);
}

/**
 * The stop a cursor at `index` moves to: left and right within its row, up and down to the
 * neighbouring row's stop nearest horizontally (the leftmost of those it lines up with). Null at
 * an edge. From no stop (-1), any direction lands on the first.
 */
export function spatialStep(boxes: readonly Box[], index: number, direction: Direction): number | null {
  if (boxes.length === 0) return null;
  if (index === -1) return 0;
  const rows = rowsOf(boxes);
  const rowIndex = rows.findIndex((row) => row.includes(index));
  const row = rows[rowIndex]!;
  const at = row.indexOf(index);
  if (direction === "left") return row[at - 1] ?? null;
  if (direction === "right") return row[at + 1] ?? null;
  const target = rows[rowIndex + (direction === "down" ? 1 : -1)];
  if (target === undefined) return null;
  const from = boxes[index]!;
  return target.reduce((best, candidate) => (horizontalGap(boxes[candidate]!, from) < horizontalGap(boxes[best]!, from) ? candidate : best));
}

function locate(layout: BoardLayout, id: string): { column: number; row: number } | null {
  for (let column = 0; column < layout.length; column += 1) {
    const row = layout[column]!.indexOf(id);
    if (row !== -1) return { column, row };
  }
  return null;
}

/** The nearest non-empty column from `start` stepping by `step`, `start` included. */
function nonEmptyColumn(layout: BoardLayout, start: number, step: 1 | -1): number | null {
  for (let column = start; column >= 0 && column < layout.length; column += step) {
    if (layout[column]!.length > 0) return column;
  }
  return null;
}

/**
 * The card the cursor lands on. Sideways motions skip empty columns and keep the row where the
 * target column is long enough. With no cursor yet, any motion lands on the first card.
 */
export function cursorAfter(layout: BoardLayout, from: string | null, motion: Motion): string | null {
  const at = from === null ? null : locate(layout, from);
  if (at === null) {
    const first = nonEmptyColumn(layout, 0, 1);
    return first === null ? null : layout[first]![0]!;
  }
  const cards = layout[at.column]!;
  const inColumn = (column: number | null) => (column === null ? from : layout[column]![Math.min(at.row, layout[column]!.length - 1)]!);
  switch (motion) {
    case "up":
      return cards[Math.max(at.row - 1, 0)]!;
    case "down":
      return cards[Math.min(at.row + 1, cards.length - 1)]!;
    case "top":
      return cards[0]!;
    case "bottom":
      return cards[cards.length - 1]!;
    case "left":
      return inColumn(nonEmptyColumn(layout, at.column - 1, -1));
    case "right":
      return inColumn(nonEmptyColumn(layout, at.column + 1, 1));
    case "first-column":
      return inColumn(nonEmptyColumn(layout, 0, 1));
    case "last-column":
      return inColumn(nonEmptyColumn(layout, layout.length - 1, -1));
  }
}

/**
 * Where a card moved one step lands: a column index and its index among that column's visible
 * cards without it. Sideways moves keep the row and may land in an empty column. Null at an edge.
 */
export function movePlacement(layout: BoardLayout, id: string, direction: Direction): { column: number; index: number } | null {
  const at = locate(layout, id);
  if (at === null) return null;
  const length = layout[at.column]!.length;
  switch (direction) {
    case "up":
      return at.row === 0 ? null : { column: at.column, index: at.row - 1 };
    case "down":
      return at.row === length - 1 ? null : { column: at.column, index: at.row + 1 };
    case "left":
    case "right": {
      const column = at.column + (direction === "left" ? -1 : 1);
      if (column < 0 || column >= layout.length) return null;
      return { column, index: Math.min(at.row, layout[column]!.length) };
    }
  }
}

/**
 * Converts an index among a column's visible cards into the server's index among all of the
 * column's cards, which includes subtasks the board hides. The card goes just before the visible
 * card that will follow it, or last. Both lists exclude the card being moved.
 */
export function placementIndex(columnIds: readonly string[], visibleIds: readonly string[], visibleIndex: number): number {
  const next = visibleIds[visibleIndex];
  const index = next === undefined ? -1 : columnIds.indexOf(next);
  return index === -1 ? columnIds.length : index;
}
