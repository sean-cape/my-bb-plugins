import { ACTION_LABEL, type ActionSource, type FinishAction, isAction } from "./actions.js";

export const DEFAULT_ACTION: FinishAction = "none";

/** The thread's pick when it has a valid one, else its project's default, else the built-in default. */
export function resolveAction(threadPick: unknown, projectDefault: FinishAction | null): { action: FinishAction; source: ActionSource } {
  if (isAction(threadPick)) return { action: threadPick, source: "thread" };
  if (projectDefault !== null) return { action: projectDefault, source: "project" };
  return { action: DEFAULT_ACTION, source: "default" };
}

/** Plugin-started threads follow their owner's workflow, and a Personal project has no repository to commit to. */
export function settingApplies(thread: { originPluginId: string | null }, project: { kind: "personal" | "standard" }): boolean {
  return thread.originPluginId === null && project.kind === "standard";
}

const SOURCE_NOTE: Record<ActionSource, string> = {
  thread: "picked for this thread",
  project: "this project's default",
  default: "the default",
};

export interface FinishContext {
  action: FinishAction;
  source: ActionSource;
  /** The branch the thread's work merges into; null when bb doesn't know it. */
  base: string | null;
  /** Whether the checkout has `scripts/land.mjs`, which knows how to get this repository's work onto main. */
  hasLandScript: boolean;
}

/** What the `finish_action` tool tells the agent to do with its finished change. */
export function finishSteps({ action, source, base, hasLandScript }: FinishContext): string {
  const target = base ?? "main";
  const header = `The user's "when done" setting for this thread is "${ACTION_LABEL[action]}" (${SOURCE_NOTE[source]}).`;
  const steps: Record<FinishAction, string> = {
    land: hasLandScript
      ? [
          "Commit your changes on this thread's branch, then run `node scripts/land.mjs` from the checkout's root with the sandbox disabled: it signs commits and writes to the main checkout.",
          `It cherry-picks the branch's new commits onto ${target}, runs the checks of everything they touch, and builds and reloads it.`,
          `If it fails, fix the cause on the branch, commit, and run it again; it only picks up commits ${target} doesn't have yet. Don't push.`,
        ].join(" ")
      : [
          `Commit your changes on this thread's branch, then get them onto ${target} the way this repository's instructions describe.`,
          `If they describe nothing, merge the branch into ${target} in the project's main checkout. Don't push unless the user asks.`,
        ].join(" "),
    commit: "Commit your changes on this thread's branch with a message that says what changed and why. Don't merge, cherry-pick or push them anywhere.",
    none: "Leave your changes uncommitted in the working tree for the user to review. Don't commit, merge or push them.",
  };
  return [header, steps[action], "A message from the user that asks for something else wins over this setting."].join("\n\n");
}
