/** In cycling order: `⌥D` and a click on the composer chip step through these. */
export const ACTIONS = ["land", "commit", "none"] as const;
export type FinishAction = (typeof ACTIONS)[number];

/** Where a thread's action came from: its own pick, its project's default, or the built-in default. */
export const SOURCES = ["thread", "project", "default"] as const;
export type ActionSource = (typeof SOURCES)[number];

export const ACTION_LABEL: Record<FinishAction, string> = {
  land: "Merge to main",
  commit: "Commit to branch",
  none: "Leave uncommitted",
};

/** The composer chip's text, which has to fit beside the send button. */
export const ACTION_SHORT_LABEL: Record<FinishAction, string> = {
  land: "Merge",
  commit: "Commit",
  none: "Leave",
};

export const ACTION_ICON = {
  land: "GitMerge",
  commit: "GitBranch",
  none: "Edit",
} as const satisfies Record<FinishAction, string>;

export const isAction = (value: unknown): value is FinishAction => typeof value === "string" && (ACTIONS as readonly string[]).includes(value);

export function cycleAction(action: FinishAction, step: 1 | -1): FinishAction {
  const index = ACTIONS.indexOf(action);
  return ACTIONS[(index + step + ACTIONS.length) % ACTIONS.length]!;
}
