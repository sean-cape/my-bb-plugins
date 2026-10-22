import type { KeyHelpSection, Keymap } from "../ui/vim-keys-core";
import { REVIEW_KEYMAP, type ReviewCommand } from "../keys/keymap";

/** What the comments view does beyond the review keys, which it shares with the files view. */
export type CommentsOnlyCommand =
  /** Open the files view at the thread's line (or the file's header). */
  | { kind: "openInFiles" }
  /** Next filter: open, resolved, outdated, all. */
  | { kind: "threadFilter" };

export type CommentsCommand = ReviewCommand | CommentsOnlyCommand;

/** The review keys over the threads' lines, with `gf` leaving for the files view and `F` cycling the filter chips. */
export const COMMENTS_KEYMAP: Keymap<CommentsCommand> = {
  ...REVIEW_KEYMAP,
  gf: { kind: "openInFiles" },
  F: { kind: "threadFilter" },
};

export const COMMENTS_KEY_HELP: readonly KeyHelpSection[] = [
  {
    title: "Comments",
    keys: [
      { keys: ["j", "k"], action: "Next / previous line, stopping at each thread (a count repeats: 5j)" },
      { keys: ["c", "C"], action: "Next / previous thread" },
      { keys: ["]f", "[f"], action: "Next / previous file or stored hunk" },
      { keys: ["gg", "G"], action: "First / last line" },
      { keys: ["Ctrl-d", "Ctrl-u"], action: "Half a page down / up (Ctrl-f / Ctrl-b a whole page)" },
      { keys: ["F"], action: "Which threads show: open, resolved, outdated, or all" },
      { keys: ["gf"], action: "Open the files view at the thread's line" },
      { keys: ["gc"], action: "Back to the files or the narrative, where you were" },
      { keys: ["S"], action: "Switch to the narrative review" },
    ],
  },
  {
    title: "Thread",
    keys: [
      { keys: ["Enter", "za"], action: "Open or close the thread under the cursor" },
      { keys: ["a"], action: "Reply to it" },
      { keys: ["r"], action: "Resolve or reopen it on GitHub" },
      { keys: ["e"], action: "Edit your unsent comment in it" },
      { keys: ["dd"], action: "Delete your unsent comment in it" },
      { keys: ["M"], action: "Move that comment between local and the GitHub PR" },
      { keys: ["gx", "go"], action: "Open the thread on GitHub / the agent thread that replied" },
      { keys: ["i"], action: "Comment on the line (today's lines only)" },
      { keys: ["T"], action: "Switch where new comments go: local or the GitHub PR" },
      { keys: ["s"], action: "Go to the send bar" },
      { keys: ["H"], action: "Hide or show the threads in the files and narrative views" },
      { keys: ["gl"], action: "Split or unified" },
      { keys: ["R"], action: "Refresh" },
      { keys: ["A"], action: "Apply the thread's suggested change now" },
      { keys: ["B", "gB"], action: "Add it to the batch or take it out / apply the batch" },
      { keys: ["?"], action: "This sheet" },
    ],
  },
];
