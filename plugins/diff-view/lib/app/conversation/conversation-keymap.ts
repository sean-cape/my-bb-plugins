import type { KeyHelpSection, Keymap } from "../ui/vim-keys-core";
import { REVIEW_KEYMAP, type ReviewCommand } from "../keys/keymap";

/** The review keys that mean the same over the conversation's rows as over the diff's lines. */
const SHARED_KEYS = [
  "j", "<Down>", "k", "<Up>", "gg", "G", "<C-d>", "<C-u>", "<C-f>", "<C-b>", "c", "C", "zz", "zt", "zb", "za", "<CR>",
  "a", "r", "e", "dd", "M", "gx", "go", "i", "A", "B", "gB", "T", "R", "s", "S", "?", "<Esc>", "H", "gr", "gl",
];

export type ConversationCommand =
  | ReviewCommand
  /** The files view at the row: a thread's line, or the commit alone. */
  | { kind: "openInFiles" }
  /** The reaction picker for the comment under the cursor. */
  | { kind: "react" }
  /** The comment under the cursor, quoted into the comment box. */
  | { kind: "quote" };

export const CONVERSATION_KEYMAP: Keymap<ConversationCommand> = {
  ...Object.fromEntries(SHARED_KEYS.map((key) => [key, REVIEW_KEYMAP[key]!])),
  gf: { kind: "openInFiles" },
  "+": { kind: "react" },
  Q: { kind: "quote" },
};

export const CONVERSATION_KEY_HELP: readonly KeyHelpSection[] = [
  {
    title: "Conversation",
    keys: [
      { keys: ["j", "k"], action: "Next / previous entry: the summary, a linked issue, a comment, review, commit, thread, the status or a check (a count repeats: 5j)" },
      { keys: ["c", "C"], action: "Next / previous comment thread" },
      { keys: ["gg", "G"], action: "First / last entry" },
      { keys: ["Ctrl-d", "Ctrl-u"], action: "Half a page down / up (Ctrl-f / Ctrl-b a whole page)" },
      { keys: ["zz", "zt", "zb"], action: "Scroll the entry to the middle / top / bottom" },
      { keys: ["Enter", "za"], action: "Open or close the thread or comment (a hidden one opens); on a commit, show that commit's changes; on a check or issue, open it" },
      { keys: ["gf"], action: "Open the files view at the thread's line, or at the commit's changes" },
      { keys: ["gx"], action: "Open the entry on GitHub: the pull request, a comment, a commit, a force-push's compare, a check's run" },
      { keys: ["gr"], action: "Pick commits to read in the files view" },
      { keys: ["S"], action: "Next view: back to the files, where you were" },
    ],
  },
  {
    title: "Write",
    keys: [
      { keys: ["i"], action: "Comment on the pull request: the box at the end (⌘↩ posts to GitHub, Esc keeps the draft; with vim mode the first Esc is its normal mode)" },
      { keys: ["Q"], action: "Quote the comment under the cursor into the box" },
      { keys: ["+"], action: "React to the comment under the cursor (pick one; again takes yours back)" },
      { keys: ["e"], action: "Edit your comment, review summary or description under the cursor (⌘↩ saves, Esc cancels)" },
      { keys: ["dd"], action: "Delete your comment under the cursor (dd twice)" },
    ],
  },
  {
    title: "Thread",
    keys: [
      { keys: ["a"], action: "Reply to the thread" },
      { keys: ["r"], action: "Resolve or reopen it on GitHub" },
      { keys: ["e"], action: "Edit your unsent comment in it" },
      { keys: ["dd"], action: "Delete your unsent comment in it" },
      { keys: ["M"], action: "Move that comment between local and the GitHub PR" },
      { keys: ["go"], action: "Open the agent thread that replied" },
      { keys: ["A"], action: "Apply the thread's suggested change now" },
      { keys: ["B", "gB"], action: "Add it to the batch or take it out / apply the batch" },
      { keys: ["T"], action: "Switch where replies go: local or the GitHub PR" },
      { keys: ["s"], action: "Go to the send bar" },
      { keys: ["H"], action: "Hide or show the threads in the files and narrative views" },
      { keys: ["gl"], action: "Split or unified" },
      { keys: ["R"], action: "Refresh" },
      { keys: ["?"], action: "This sheet" },
    ],
  },
];
