import type { Direction, KeyHelpSection, Keymap } from "bb-vim-keys";
import type { Ticket } from "../shared/board";
import { effectiveLevel, type AttentionLevel } from "../shared/loop";

/** Ticket ids per column, left to right, top to bottom, as the board shows them. */
export type BoardLayout = readonly (readonly string[])[];

export type Motion = Direction | "top" | "bottom" | "first-column" | "last-column";

export type BoardCommand =
  | { kind: "cursor"; motion: Motion }
  | { kind: "move"; direction: Direction }
  | { kind: "open" }
  | { kind: "thread" }
  | { kind: "diff" }
  /** The focused card's loop menu, as the card's own `m`. */
  | { kind: "loop"; action: "menu" }
  | { kind: "delete" }
  | { kind: "undo" }
  | { kind: "add" }
  | { kind: "help" }
  | { kind: "toggle-hidden" }
  | { kind: "toggle-view" }
  | { kind: "toggle-done" }
  | TodoKeyCommand
  | { kind: "focus-input" }
  | { kind: "scroll"; direction: 1 | -1 };

export type TodoKeyCommand = { kind: "priority"; priority: number | null } | { kind: "snooze"; until: "tomorrow" | "next-week" };

export const KEYMAP: Keymap<BoardCommand> = {
  h: { kind: "cursor", motion: "left" },
  "<Left>": { kind: "cursor", motion: "left" },
  l: { kind: "cursor", motion: "right" },
  "<Right>": { kind: "cursor", motion: "right" },
  j: { kind: "cursor", motion: "down" },
  "<Down>": { kind: "cursor", motion: "down" },
  k: { kind: "cursor", motion: "up" },
  "<Up>": { kind: "cursor", motion: "up" },
  G: { kind: "cursor", motion: "bottom" },
  "0": { kind: "cursor", motion: "first-column" },
  $: { kind: "cursor", motion: "last-column" },
  H: { kind: "move", direction: "left" },
  L: { kind: "move", direction: "right" },
  J: { kind: "move", direction: "down" },
  K: { kind: "move", direction: "up" },
  o: { kind: "open" },
  t: { kind: "thread" },
  D: { kind: "diff" },
  m: { kind: "loop", action: "menu" },
  d: { kind: "delete" },
  u: { kind: "undo" },
  a: { kind: "add" },
  T: { kind: "toggle-view" },
  x: { kind: "toggle-done" },
  i: { kind: "focus-input" },
  "?": { kind: "help" },
  gg: { kind: "cursor", motion: "top" },
  za: { kind: "toggle-hidden" },
  zs: { kind: "snooze", until: "tomorrow" },
  zw: { kind: "snooze", until: "next-week" },
  p1: { kind: "priority", priority: 1 },
  p2: { kind: "priority", priority: 2 },
  p3: { kind: "priority", priority: 3 },
  p4: { kind: "priority", priority: 4 },
  p0: { kind: "priority", priority: null },
  "<C-d>": { kind: "scroll", direction: 1 },
  "<C-u>": { kind: "scroll", direction: -1 },
};

export type CardCommand =
  | { kind: "step"; direction: Direction }
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "press" }
  | { kind: "type" }
  | { kind: "thread" }
  | { kind: "diff" }
  /** A loop intervention: steer, hand to me, stop now, or the loop menu holding every one. */
  | { kind: "loop"; action: LoopKeyAction }
  /** A handoff brief action: the brief's own button, or the one on the finding under the cursor. */
  | { kind: "brief"; action: BriefAction }
  | { kind: "help" }
  | { kind: "close" }
  | { kind: "scroll"; direction: 1 | -1 };

export type BriefAction = "accept" | "send-back" | "rethink" | "pull-in" | "uphold" | "close-dispute" | "open-plan" | "change-level" | "approve";

export type LoopKeyAction = "steer" | "hand-off" | "stop" | "menu";

/** Inside the open loop menu the plain keys pick their item; j/k, Enter and Escape are the menu's own. */
export const LOOP_MENU_KEYMAP: Keymap<Exclude<LoopKeyAction, "menu">> = { s: "steer", f: "hand-off", x: "stop" };

/** The brief actions that act on the finding under the cursor rather than the whole card. */
export const FINDING_ACTIONS: ReadonlySet<BriefAction> = new Set(["pull-in", "uphold", "close-dispute"]);

/** Keys inside an open card, which take them before the board does. */
/** In the diff's send bar, `i` opens the review box on its comment; the diff's own `i` (a line comment) stays out of it. */
export const SEND_BAR_KEYS: Keymap<"review"> = { i: "review" };

/** The review box's keys: j/k walk Comment / Approve / Request changes, i goes to the comment, Escape closes. */
export type ReviewPopoverCommand = 1 | -1 | "comment" | "close";
export const REVIEW_POPOVER_KEYS: Keymap<ReviewPopoverCommand> = { j: 1, k: -1, "<Down>": 1, "<Up>": -1, i: "comment", "<Esc>": "close" };

export const CARD_KEYMAP: Keymap<CardCommand> = {
  j: { kind: "step", direction: "down" },
  "<Down>": { kind: "step", direction: "down" },
  k: { kind: "step", direction: "up" },
  "<Up>": { kind: "step", direction: "up" },
  l: { kind: "step", direction: "right" },
  "<Right>": { kind: "step", direction: "right" },
  h: { kind: "step", direction: "left" },
  "<Left>": { kind: "step", direction: "left" },
  gg: { kind: "first" },
  G: { kind: "last" },
  "<CR>": { kind: "press" },
  "<Space>": { kind: "press" },
  i: { kind: "type" },
  t: { kind: "thread" },
  D: { kind: "diff" },
  m: { kind: "loop", action: "menu" },
  s: { kind: "loop", action: "steer" },
  f: { kind: "loop", action: "hand-off" },
  x: { kind: "loop", action: "stop" },
  A: { kind: "brief", action: "accept" },
  S: { kind: "brief", action: "send-back" },
  R: { kind: "brief", action: "rethink" },
  p: { kind: "brief", action: "pull-in" },
  u: { kind: "brief", action: "uphold" },
  c: { kind: "brief", action: "close-dispute" },
  P: { kind: "brief", action: "open-plan" },
  L: { kind: "brief", action: "change-level" },
  Y: { kind: "brief", action: "approve" },
  "?": { kind: "help" },
  "<Esc>": { kind: "close" },
  "<C-d>": { kind: "scroll", direction: 1 },
  "<C-u>": { kind: "scroll", direction: -1 },
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
      { keys: ["D"], action: "View the card's changes" },
      { keys: ["m"], action: "Open the card's loop menu: steer, hand to me, skip a review, stop, retry, resume, the gates, loop off; with the loop off, turns it on" },
      { keys: ["x"], action: "Mark done / reopen" },
      { keys: ["p1", "p2", "p3", "p4"], action: "Set the card's priority (p1 is the most urgent); p0 clears it" },
      { keys: ["zs", "zw"], action: "Snooze the card until tomorrow / next Monday; on a snoozed card, wake it" },
      { keys: ["d"], action: "Delete card" },
      { keys: ["u"], action: "Undo the last delete" },
      { keys: ["a"], action: "New card in this column" },
      { keys: ["za"], action: "Show / hide the column's snoozed cards and cards past its hide-after days" },
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
      { keys: ["p1", "p2", "p3", "p4"], action: "Set the todo's priority; p0 clears it" },
      { keys: ["zs", "zw"], action: "Snooze until tomorrow / next Monday; on a snoozed todo, wake it" },
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
      { keys: ["j", "k"], action: "Inside a menu: next / previous item" },
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
      { keys: ["t", "D"], action: "Open the card's thread / changes" },
      { keys: ["m"], action: "Open the loop menu: every intervention with its key, the gates, and loop off, with greyed items saying why; with the loop off, turns it on" },
      { keys: ["s"], action: "Steer: type a message to the card's thread; at Needs you it resumes the loop with it. Enter sends, Shift-Enter breaks a line" },
      { keys: ["f"], action: "Hand to me: at the thread's next ready while it builds or fixes, or after the step the board is running" },
      { keys: ["x"], action: "Stop the step the board is running now; the card comes to you as stopped" },
      { keys: ["Y"], action: "Approve what the loop holds for you: the plan, as edited, or the round's ticked findings" },
      { keys: ["A"], action: "Handoff brief: accept; a local card's thread lands the change, a PR card is marked accepted" },
      { keys: ["S"], action: "Handoff brief: send your unsent diff comments back to the card's thread" },
      { keys: ["R"], action: "Handoff brief: stop the loop and have the card's thread rethink the approach" },
      { keys: ["p"], action: "Handoff brief, on a deferred or dropped finding: pull it back in to fix" },
      { keys: ["u", "c"], action: "Handoff brief, on a dispute: uphold it, sending it to fix, or close it" },
      { keys: ["P"], action: "Handoff brief: open the reading plan, in the narrative stepper when there is one" },
      { keys: ["L"], action: "Handoff brief: change the attention level, with a reason; h/l choose it, Enter saves" },
      { keys: ["h", "l", "Enter"], action: "On the review depth picker: choose Quick, Standard or Deep, then start the review" },
    ],
  },
  {
    title: "Loop menu",
    keys: [
      { keys: ["j", "k"], action: "Next / previous item" },
      { keys: ["s", "f", "x"], action: "Pick Steer, Hand to me or Stop now" },
      { keys: ["Enter"], action: "Pick the item; a gate stays open to tick more" },
      { keys: ["Esc"], action: "Close the menu" },
    ],
  },
  {
    title: "Open project list",
    keys: [
      { keys: ["j", "k"], action: "Next / previous project" },
      { keys: ["gg", "G"], action: "First / last project" },
      { keys: ["Ctrl-d", "Ctrl-u"], action: "Half a list down / up" },
      { keys: ["Enter"], action: "Pick the project" },
      { keys: ["/", "i"], action: "Filter; Esc returns to the list with the filter kept" },
      { keys: ["Esc"], action: "Close the list" },
    ],
  },
];

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

const LEVEL_RANK: Record<AttentionLevel, number> = { scrutinize: 0, read: 1, glance: 2 };

/** Needs you's order: Scrutinize, then Read, then Glance, then cards with no level, each longest-waiting first. */
export function byAttention(a: Ticket, b: Ticket): number {
  const rank = (ticket: Ticket) => {
    const level = ticket.loop === null ? null : effectiveLevel(ticket.loop);
    return level === null ? 3 : LEVEL_RANK[level];
  };
  return rank(a) - rank(b) || a.columnEnteredAt - b.columnEnteredAt || a.position - b.position;
}
