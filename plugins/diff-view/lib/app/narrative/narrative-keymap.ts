import type { KeyHelpSection, Keymap } from "../ui/vim-keys-core";
import { KEY_HELP, REVIEW_KEYMAP, type ReviewCommand } from "../keys/keymap";

/** What the narrative view does beyond the review keys, which it shares with the files view. */
export type NarrativeOnlyCommand =
  | { kind: "step"; direction: 1 | -1 }
  | { kind: "chapter"; direction: 1 | -1 }
  /** Open the files view at the cursor's line (or the excerpt's first line). */
  | { kind: "openInFiles" }
  /** In a revision step: go to the current narrative's step the change shows up in. */
  | { kind: "affected" }
  /** Mark viewed the files every one of whose steps has been read. */
  | { kind: "narratedViewed" }
  | { kind: "generate" };

export type NarrativeCommand = ReviewCommand | NarrativeOnlyCommand;

/**
 * The review keys, so the cursor, comments and findings work over a step's excerpts exactly as over the files, plus
 * the step keys. `h` and `l` turn pages, the surface's main motion; the arrows keep the old and new side (← past the
 * old side reaches the outline, as `h` does in the files view). `/`, `n`, `N` search steps, `t` shows the outline,
 * and `S` returns to the files.
 */
export const NARRATIVE_KEYMAP: Keymap<NarrativeCommand> = {
  ...REVIEW_KEYMAP,
  l: { kind: "step", direction: 1 },
  h: { kind: "step", direction: -1 },
  "]]": { kind: "chapter", direction: 1 },
  "[[": { kind: "chapter", direction: -1 },
  gf: { kind: "openInFiles" },
  ga: { kind: "affected" },
  gv: { kind: "narratedViewed" },
  U: { kind: "generate" },
};

/** The files view's `h`/`l` line, listed under the arrows, which keep the sides here. */
function arrowsForSides(section: KeyHelpSection): KeyHelpSection {
  return { ...section, keys: section.keys.map((entry) => (entry.keys.join(" ") === "h l" ? { ...entry, keys: ["←", "→"] } : entry)) };
}

/** The sheet's shared sections with a line reworded, by the keys it lists. */
function reworded(section: KeyHelpSection, actions: Record<string, string>): KeyHelpSection {
  return { ...section, keys: section.keys.map((entry) => ({ ...entry, action: actions[entry.keys.join(" ")] ?? entry.action })) };
}

const SHARED_HELP = KEY_HELP.filter((section) => section.title !== "File list").map((section) =>
  reworded(arrowsForSides(section), {
    "j k": "Next / previous line; past the step's code it reads on through the step, and past the step's end into the next (a count repeats: 5j)",
    "← →": "Old / new side; ← past the old side (or on an excerpt header) goes to the outline",
    "]f [f": "Next / previous excerpt",
    "gg G": "First / last line of the step",
    "Ctrl-d Ctrl-u": "Half a page down / up (Ctrl-f / Ctrl-b a whole page)",
    "/": "Search steps by title and text and jump to one",
    "n N": "Next / previous step matching the search",
    f: "Find a file by name and open it in the files view",
    v: "Mark the excerpt's file viewed or not",
    zr: "Show 20 more of the lines the excerpt leaves out either side of the cursor's run (Enter on a band shows its lines)",
    gd: "Not in excerpts: they are line diffs",
    gl: "Split or unified, for the excerpts (remembered apart from the files view's)",
    S: "Back to the files view, cursor where it was (S there comes back)",
  }),
);

export const NARRATIVE_KEY_HELP: readonly KeyHelpSection[] = [
  {
    title: "Step",
    keys: [
      { keys: ["l", "h"], action: "Next / previous step, across chapters (a count repeats: 3l)" },
      { keys: ["]]", "[["], action: "Next / previous chapter: an earlier narrative, what changed since, the current one" },
      { keys: ["gf"], action: "Open the files view at the cursor's line" },
      { keys: ["ga"], action: "In a revision step: go to the current narrative's step it shows up in" },
      { keys: ["gv"], action: "Mark viewed the files every one of whose steps you have read" },
      { keys: ["U"], action: "Write a narrative, or an update that explains what changed since the last one" },
      { keys: ["Tab"], action: "Move between the step's links and excerpt headers; Enter follows one" },
    ],
  },
  ...SHARED_HELP,
  {
    title: "Outline",
    keys: [
      { keys: ["t"], action: "Show or hide the outline" },
      { keys: ["j", "k"], action: "Next / previous step or chapter" },
      { keys: ["gg", "G"], action: "First / last row" },
      { keys: ["Ctrl-d", "Ctrl-u"], action: "Half a list down / up" },
      { keys: ["Enter", "o", "l"], action: "Open the step" },
      { keys: ["Esc"], action: "Back to the step" },
    ],
  },
];
