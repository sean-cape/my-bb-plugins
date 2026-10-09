/** What a key sequence asks the view to do. Motions repeat by the count typed before them. */
export type ReviewCommand =
  | { kind: "line"; direction: 1 | -1 }
  | { kind: "side"; side: "LEFT" | "RIGHT" }
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "page"; fraction: number }
  | { kind: "change"; direction: 1 | -1 }
  | { kind: "hunk"; direction: 1 | -1 }
  | { kind: "file"; direction: 1 | -1 }
  | { kind: "thread"; direction: 1 | -1 }
  | { kind: "finding"; direction: 1 | -1 }
  | { kind: "scroll"; block: "center" | "start" | "end" }
  | { kind: "fold"; action: "toggle" | "annotation" | "open" | "close" | "openAll" | "closeAll" | "moreContext" }
  | { kind: "visual" }
  | { kind: "comment" }
  | { kind: "commentFile" }
  | { kind: "reply" }
  | { kind: "edit" }
  | { kind: "delete" }
  | { kind: "move" }
  | { kind: "openGithub" }
  | { kind: "openThread" }
  | { kind: "toggleFinding" }
  | { kind: "findingFilter" }
  | { kind: "explain" }
  | { kind: "viewed" }
  | { kind: "target" }
  | { kind: "fileTree" }
  | { kind: "layout" }
  | { kind: "refresh" }
  | { kind: "send" }
  | { kind: "findFile" }
  | { kind: "searchNext"; direction: 1 | -1 }
  | { kind: "peek" }
  | { kind: "help" }
  | { kind: "escape" }
  /** No key: the reader scrolled by hand, and the cursor moves to the line now in the middle. */
  | { kind: "follow" };

/** Keys as typed: printable characters as themselves, the rest as `<C-d>`, `<Esc>`, `<CR>`, `<Down>`. */
export function keyToken(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
  if (event.metaKey || event.altKey) return null;
  if (event.ctrlKey) return event.key.length === 1 ? `<C-${event.key.toLowerCase()}>` : null;
  switch (event.key) {
    case "Escape":
      return "<Esc>";
    case "Enter":
      return "<CR>";
    case "ArrowDown":
      return "<Down>";
    case "ArrowUp":
      return "<Up>";
    case "ArrowLeft":
      return "<Left>";
    case "ArrowRight":
      return "<Right>";
    default:
      return event.key.length === 1 ? event.key : null;
  }
}

const SEQUENCES: Record<string, ReviewCommand> = {
  j: { kind: "line", direction: 1 },
  "<Down>": { kind: "line", direction: 1 },
  k: { kind: "line", direction: -1 },
  "<Up>": { kind: "line", direction: -1 },
  h: { kind: "side", side: "LEFT" },
  "<Left>": { kind: "side", side: "LEFT" },
  l: { kind: "side", side: "RIGHT" },
  "<Right>": { kind: "side", side: "RIGHT" },
  gg: { kind: "top" },
  G: { kind: "bottom" },
  "<C-d>": { kind: "page", fraction: 0.5 },
  "<C-u>": { kind: "page", fraction: -0.5 },
  "<C-f>": { kind: "page", fraction: 1 },
  "<C-b>": { kind: "page", fraction: -1 },
  "]c": { kind: "change", direction: 1 },
  "[c": { kind: "change", direction: -1 },
  "}": { kind: "hunk", direction: 1 },
  "{": { kind: "hunk", direction: -1 },
  "]f": { kind: "file", direction: 1 },
  "[f": { kind: "file", direction: -1 },
  c: { kind: "thread", direction: 1 },
  C: { kind: "thread", direction: -1 },
  "]d": { kind: "finding", direction: 1 },
  "[d": { kind: "finding", direction: -1 },
  zz: { kind: "scroll", block: "center" },
  zt: { kind: "scroll", block: "start" },
  zb: { kind: "scroll", block: "end" },
  za: { kind: "fold", action: "toggle" },
  zo: { kind: "fold", action: "open" },
  zc: { kind: "fold", action: "close" },
  zR: { kind: "fold", action: "openAll" },
  zM: { kind: "fold", action: "closeAll" },
  zr: { kind: "fold", action: "moreContext" },
  V: { kind: "visual" },
  i: { kind: "comment" },
  O: { kind: "commentFile" },
  a: { kind: "reply" },
  "<CR>": { kind: "fold", action: "annotation" },
  e: { kind: "edit" },
  dd: { kind: "delete" },
  M: { kind: "move" },
  gx: { kind: "openGithub" },
  go: { kind: "openThread" },
  x: { kind: "toggleFinding" },
  F: { kind: "findingFilter" },
  K: { kind: "explain" },
  v: { kind: "viewed" },
  T: { kind: "target" },
  t: { kind: "fileTree" },
  gl: { kind: "layout" },
  R: { kind: "refresh" },
  s: { kind: "send" },
  "/": { kind: "findFile" },
  n: { kind: "searchNext", direction: 1 },
  N: { kind: "searchNext", direction: -1 },
  gd: { kind: "peek" },
  "?": { kind: "help" },
  "<Esc>": { kind: "escape" },
};

const PREFIXES = new Set(Object.keys(SEQUENCES).flatMap((sequence) => (sequence.startsWith("<") ? [] : [...sequence].slice(0, -1).map((_, index) => sequence.slice(0, index + 1)))));

export type ParseResult = { status: "pending" } | { status: "none" } | { status: "command"; command: ReviewCommand; count: number };

/**
 * Reads the keys typed so far: an optional count, then a sequence. `pending` means more keys may complete one
 * (a count, or a prefix such as `g`, `z`, `]`, `d`); `none` means nothing will, and the caller drops the keys.
 */
export function parseKeys(tokens: readonly string[]): ParseResult {
  let index = 0;
  let digits = "";
  while (index < tokens.length && /^[0-9]$/u.test(tokens[index]!) && !(digits === "" && tokens[index] === "0")) {
    digits += tokens[index];
    index += 1;
  }
  const rest = tokens.slice(index);
  if (rest.length === 0) return digits === "" ? { status: "none" } : { status: "pending" };
  const sequence = rest.join("");
  const command = SEQUENCES[sequence];
  if (command !== undefined) return { status: "command", command, count: digits === "" ? 1 : Math.min(Number(digits), 9999) };
  if (rest.every((token) => !token.startsWith("<")) && PREFIXES.has(sequence)) return { status: "pending" };
  return { status: "none" };
}

/** The `?` sheet, in the order a review goes. */
export const KEY_HELP: ReadonlyArray<{ group: string; keys: ReadonlyArray<{ keys: string[]; action: string }> }> = [
  {
    group: "Move",
    keys: [
      { keys: ["j", "k"], action: "Next / previous line, stopping at each comment when a line has several (a count repeats: 5j)" },
      { keys: ["h", "l"], action: "Old / new side; h past the old side (or on a file header) goes to the file list" },
      { keys: ["]c", "[c"], action: "Next / previous change" },
      { keys: ["}", "{"], action: "Next / previous hunk" },
      { keys: ["]f", "[f"], action: "Next / previous file" },
      { keys: ["c", "C"], action: "Next / previous comment or review finding, one at a time on a shared line" },
      { keys: ["]d", "[d"], action: "Next / previous review finding" },
      { keys: ["gg", "G"], action: "First / last line" },
      { keys: ["⌃d", "⌃u"], action: "Half a page down / up (⌃f / ⌃b a whole page)" },
      { keys: ["zz", "zt", "zb"], action: "Scroll the cursor to the middle / top / bottom" },
      { keys: ["/"], action: "Search file names and jump to one" },
      { keys: ["n", "N"], action: "Next / previous file matching the search" },
    ],
  },
  {
    group: "Comment",
    keys: [
      { keys: ["i"], action: "Comment on the line (or the selected lines); on a file header, on the file" },
      { keys: ["V"], action: "Select lines; move, then i to comment on them" },
      { keys: ["O"], action: "Comment on the file" },
      { keys: ["a"], action: "Reply to the comment thread under the cursor" },
      { keys: ["↩", "za"], action: "Open or close the comment or finding under the cursor, or open a fold of hidden lines (za on a bare line folds the file)" },
      { keys: ["e"], action: "Edit your unsent comment in that thread, or the finding's wording" },
      { keys: ["dd"], action: "Delete your unsent comment in that thread" },
      { keys: ["M"], action: "Move that comment between local and the GitHub PR" },
      { keys: ["gx", "go"], action: "Open the thread on GitHub / the agent thread that replied" },
      { keys: ["T"], action: "Switch where new comments go: local or the GitHub PR" },
      { keys: ["s"], action: "Go to the send bar (↩ sends, Tab for the next action)" },
      { keys: ["⌘↩"], action: "In a comment box: add it; editing a finding: save" },
      { keys: ["Esc"], action: "In a comment box: back to the diff (an empty one closes); editing a comment or finding: cancel the edit" },
    ],
  },
  {
    group: "File list",
    keys: [
      { keys: ["t"], action: "Show or hide the file list" },
      { keys: ["j", "k"], action: "Next / previous file or folder" },
      { keys: ["h", "l"], action: "Close / open a folder (h on a file goes to its folder)" },
      { keys: ["gg", "G"], action: "First / last row" },
      { keys: ["⌃d", "⌃u"], action: "Half a list down / up" },
      { keys: ["↩", "l"], action: "Jump to the file (↩ on a folder opens or closes it)" },
      { keys: ["Esc"], action: "Back to the diff" },
    ],
  },
  {
    group: "Review",
    keys: [
      { keys: ["v"], action: "Mark the file viewed (collapses it) or not" },
      { keys: ["zo", "zc"], action: "Expand / collapse the file" },
      { keys: ["zR", "zM"], action: "Expand / collapse every file" },
      { keys: ["zr"], action: "Show more unchanged lines around the hunk, or the rest of a long new file (structural)" },
      { keys: ["x"], action: "Include or exclude the review finding under the cursor in the apply round" },
      { keys: ["F"], action: "Which review findings show: all, important and up, critical only, or none" },
      { keys: ["K"], action: "Ask an agent to explain the hunk" },
      { keys: ["gd"], action: "Peek a symbol on the line: its definition and uses (structural)" },
      { keys: ["gl"], action: "Split or unified, for files shown as a line diff" },
      { keys: ["R"], action: "Refresh the diff" },
      { keys: ["Esc"], action: "Leave line selection" },
      { keys: ["?"], action: "This sheet" },
    ],
  },
];
