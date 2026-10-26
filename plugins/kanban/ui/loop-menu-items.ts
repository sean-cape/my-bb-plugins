import type { Ticket } from "../shared/board";
import { boardRunning, workingPhase, type LoopDirective, type LoopGates, type LoopState } from "../shared/loop";
import { DIRECTIVE_TEXT } from "../shared/stages";
import { HOLDS, SKIPS, type GateOption } from "./gates";

export type LoopGateItemId = `gate:${keyof LoopGates}`;
export type LoopMenuItemId = "steer" | "hand-off" | "skip-review" | "stop" | "retry" | "resume" | LoopGateItemId | "monitor";

export interface LoopMenuItem {
  id: LoopMenuItemId;
  label: string;
  key?: "s" | "f" | "x";
  /** Why the server would refuse it now, in the menu's words; null when it would take it. */
  disabled: string | null;
  /** What picking it does, shown under the label. */
  hint?: string;
  /** A gate's state; the item ticks it. */
  checked?: boolean;
}

const OFF = "The loop is off; turn it on first";
const OVER = "The change was accepted; the loop is over";
const WITH_YOU = "The card is already with you";
const NO_RETRY = "Only after a loop error stopped the loop";
const CANNOT_RETRY = "The failed step can't be started again; send the card back or rethink instead";
export const PAUSED_ON_QUESTION = "The thread is waiting on a question; answer it in the thread";
/** The plan gate turned on past planning holds nothing until a Rethink starts the loop over. */
export const PLAN_GATE_LATER = "Takes effect at the next Rethink";

/** Why no intervention can reach the loop at all, or null while it runs. */
function unreachable(loop: LoopState | null): string | null {
  if (loop === null || !loop.monitored || loop.phase === "idle") return OFF;
  if (loop.phase === "accepted" || loop.phase === "landed") return OVER;
  return null;
}

/** What `f` does now: hand off at the thread's next ready while it works, after the step while the board does; nothing at Needs you. */
export function handOffDirective(loop: LoopState): Extract<LoopDirective, "hand-off-at-ready" | "hand-off-after-step"> | null {
  if (unreachable(loop) !== null || loop.phase === "needs-you") return null;
  return boardRunning(loop) ? "hand-off-after-step" : "hand-off-at-ready";
}

/** Whether the composer steers the thread, resumes the loop from Needs you, waits on a question, or isn't shown. */
export function composerMode(loop: LoopState | null): "steer" | "resume" | "paused" | null {
  if (unreachable(loop) !== null) return null;
  if (loop!.phase === "paused") return "paused";
  return loop!.phase === "needs-you" ? "resume" : "steer";
}

/** Whether turning the plan gate on now would wait for a Rethink: the loop is past planning and the gate is off. */
export function planGateLater(loop: LoopState | null): boolean {
  return loop !== null && loop.monitored && !loop.gates.plan && loop.phase !== "idle" && loop.phase !== "planning";
}

/** Why a retry would be refused: the server retries only the step a loop error named, at a commit it still holds. */
function retryRefused(loop: LoopState): string | null {
  if (loop.phase !== "needs-you" || loop.reason !== "loop-error") return NO_RETRY;
  if (loop.failedStep === null || loop.commit === null || (loop.failedStep === "checks" && loop.checkCommand === null)) return CANNOT_RETRY;
  return null;
}

/**
 * Every intervention, in menu order, each enabled exactly when the server would take it: the loop service's
 * `liveState`, `setDirective`, `stopNow`, `retry`, `resume` and `steer` rules, in the menu's words.
 */
export function loopMenuItems(ticket: Ticket): LoopMenuItem[] {
  const loop = ticket.loop;
  const blocked = unreachable(loop);
  const noThread = ticket.threadId === null;
  const running = loop !== null && boardRunning(loop);
  const withYou = loop?.phase === "needs-you";
  const paused = loop?.phase === "paused";
  const handOff = loop === null ? null : handOffDirective(loop);
  const failedStep = loop?.failedStep ?? null;
  /** The first reason that applies, after the ones that block every item. */
  const refused = (...reasons: Array<string | null>): string | null => blocked ?? reasons.find((reason) => reason !== null) ?? null;
  const gate = ({ gate: id, label, hint }: GateOption): LoopMenuItem => ({
    id: `gate:${id}`,
    label,
    checked: loop?.gates[id] === true,
    disabled: loop === null || !loop.monitored ? "Chosen as the loop turns on, in the Review loop section" : null,
    hint: id === "plan" && planGateLater(loop) ? PLAN_GATE_LATER : hint,
  });
  return [
    {
      id: "steer",
      label: "Steer",
      key: "s",
      disabled: refused(noThread ? "The card has no thread to steer" : null, paused ? PAUSED_ON_QUESTION : null),
      hint: running ? "Type a message to the card's thread; a ready it reports supersedes the step the board is running" : "Type a message to the card's thread; it carries on and reports ready as before",
    },
    {
      id: "hand-off",
      label: handOff === "hand-off-after-step" ? "Hand to me after this step" : "Hand to me at the next ready",
      key: "f",
      disabled: refused(withYou ? WITH_YOU : null),
      hint: handOff === null ? undefined : DIRECTIVE_TEXT[handOff],
    },
    {
      id: "skip-review",
      label: "Skip review once",
      disabled: refused(withYou ? WITH_YOU : null, running ? `The board is ${workingPhase(loop!)} the card; hand off after this step instead` : null),
      hint: DIRECTIVE_TEXT["skip-review-once"],
    },
    {
      id: "stop",
      label: "Stop now",
      key: "x",
      disabled: refused(running ? null : "The board isn't running a step"),
      hint: "Stops the board's thread and discards the step; the card comes to you as stopped",
    },
    {
      id: "retry",
      label: loop === null || loop.manualRetries === 0 ? "Retry" : `Retry (${loop.manualRetries} so far)`,
      disabled: refused(loop === null ? NO_RETRY : retryRefused(loop)),
      hint: failedStep === null ? "Runs the failed step again at the same commit" : `Runs the ${failedStep} again at the same commit`,
    },
    {
      id: "resume",
      label: "Resume with a message",
      disabled: refused(withYou ? null : "Only at Needs you", noThread ? "The card has no thread to resume" : null),
      hint: "Back to building with your words, as a round of yours",
    },
    ...HOLDS.map(gate),
    ...SKIPS.map(gate),
    // The menu opens only with the loop on, so its last item only ever turns the loop off.
    {
      id: "monitor",
      label: "Loop off",
      disabled: null,
      hint: "Stops after the current step; its result is kept but drives nothing",
    },
  ];
}
