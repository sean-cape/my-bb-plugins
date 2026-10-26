import { COLUMN } from "./columns";
import { plural, shortSha } from "./format";
import {
  ATTENTION_LEVEL_LABEL,
  LOOP_ROUND_CAP,
  NEEDS_YOU_REASON_LABEL,
  effectiveLevel,
  failuresInARow,
  fixingRound,
  openFindingsClause,
  reasonBucket,
  workingPhase,
  type LoopDirective,
  type LoopRound,
  type LoopState,
  type NeedsYouReason,
} from "./loop";

export type StageId = "plan" | "build" | "checks" | "review" | "fix" | "needs-you" | "land";
type StageStatus = "done" | "current" | "upcoming" | "skipped";
export type Tone = "neutral" | "accent" | "warning" | "danger" | "success";

export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  /** A word or two on how the step went: `failed`, `not run`, `waiting for approval`. */
  detail?: string;
}

/** Who holds the ball: the card's thread, the board's hidden threads, or the user. */
export type Holder = "agent" | "board" | "you";

/** Which thread runs the current step, so the panel can link to it: the card's own, or one of the board's hidden ones. */
type ThreadRole = "card" | "checks" | "classify" | "review";

/** A short label with a tone and a tooltip: the board's chip for a monitored card, and the strip's pill for a round. */
export interface Chip {
  label: string;
  tone: Tone;
  title: string;
}

export interface LoopStages {
  steps: Stage[];
  holder: Holder | null;
  current: {
    /** One sentence on what the current step is doing, or why the loop waits. */
    text: string;
    commit: string | null;
    /** Since the phase began; null for state stored before the stamp existed. */
    elapsedMs: number | null;
    threadRole: ThreadRole | null;
  };
  rounds: Chip[];
  cap: { used: number; max: number };
  checks: { passed: boolean; command: string | null; exitCode: number; commit: string } | null;
  directive: { kind: LoopDirective; text: string } | null;
  manualRetries: number;
}

const STAGE_LABEL: Record<StageId, string> = {
  plan: "Plan",
  build: "Build",
  checks: "Checks",
  review: "Review",
  fix: "Fix",
  "needs-you": "Needs you",
  land: "Land",
};

const STAGE_ORDER: StageId[] = ["plan", "build", "checks", "review", "fix", "needs-you", "land"];

export const DIRECTIVE_TEXT: Record<LoopDirective, string> = {
  "hand-off-at-ready": "Hand to you at the next ready: no checks, no review",
  "hand-off-after-step": "Hand to you after this step; its result is kept",
  "skip-review-once": "Skip the next review: the checks run, then it comes to you",
};

/** The chip's suffix while a directive is pending: every directive ends with the card coming to the user. */
const DIRECTIVE_SUFFIX = "→ you";

/** The who-holds-the-ball word under a column's name, keyed by column id. */
export const COLUMN_HOLDER: Partial<Record<string, Holder>> = {
  [COLUMN.inProgress]: "agent",
  [COLUMN.checking]: "board",
  [COLUMN.review]: "you",
};

/** `12m`, `3h 20m`, `2d 4h`; under a minute reads `<1m`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 === 0 ? "" : ` ${minutes % 60}m`}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 === 0 ? "" : ` ${hours % 24}h`}`;
}

const WAITING_SHOWN_AFTER_MS = 60 * 60 * 1000;

const short = (commit: string | null) => (commit === null ? "" : ` ${shortSha(commit)}`);

/** The review's round number as the chip and the pills name it: the round under way, or the last one being re-checked at the cap. */
function reviewNumber(loop: LoopState): number {
  return loop.round >= LOOP_ROUND_CAP ? loop.round : loop.round + 1;
}

function currentText(loop: LoopState): string {
  const commit = short(loop.commit);
  switch (loop.phase) {
    case "planning":
      return loop.proposedPlan === null ? "The card's thread proposes a plan before building" : "Needs you: approve or edit the plan the card's thread proposed";
    case "idle":
    case "building":
      return "The card's thread builds; the board checks the work when it reports ready";
    case "checking":
      return `Re-running \`${loop.checkCommand?.command ?? "the checks"}\`${loop.checkCommand?.source === "agent" ? " (the agent's choice)" : ""} at${commit}`;
    case "classifying":
      return `Scoring the risk of each file changed at${commit}, which picks the review's depth`;
    case "reviewing":
      return loop.round >= LOOP_ROUND_CAP ? `Re-reviewing the last round's fixes at${commit}` : `Reviewing${commit} at ${loop.depth} depth`;
    case "fixing":
      return fixingRound(loop)?.owner === "user"
        ? "The card's thread is fixing the findings you sent back; this round doesn't count toward the cap"
        : `The card's thread is fixing round ${loop.round}'s findings`;
    case "paused":
      return "The card's thread is waiting on you; the loop resumes when it reports ready";
    case "needs-you":
      return needsYouText(loop);
    case "accepted":
      return `Monitored; ${loop.autoAccepted ? "auto-accepted at Glance" : "accepted"}${openSuffix(loop)}`;
    case "landed":
      return `Monitored; ${loop.autoAccepted ? "auto-accepted at Glance" : "accepted"} and landed${openSuffix(loop)}`;
  }
}

const openSuffix = (loop: LoopState) => (loop.openFindings.length === 0 ? "" : `; ${openFindingsClause(loop.openFindings)}`);

function needsYouText(loop: LoopState): string {
  const commit = short(loop.commit);
  const reason = loop.reason ?? "clean";
  switch (reason) {
    case "clean": {
      const effective = effectiveLevel(loop);
      const why = loop.levelOverride === null ? (loop.attention?.reasons ?? []) : [`you set it: ${loop.levelOverride.reason}`];
      const reasons = effective === null || why.length === 0 ? "" : `. ${ATTENTION_LEVEL_LABEL[effective]}: ${why.join("; ")}`;
      return `Checked and reviewed clean at${commit}${openSuffix(loop)}; needs you${reasons}`;
    }
    case "handed-off":
      return `Needs you: handed off at${commit} as you asked; not reviewed`;
    case "stopped":
      return `Needs you: you stopped the board's step at${commit}; not reviewed`;
    case "loop-error":
      return `Needs you: ${loop.failure ?? "a checks or review thread failed twice"}; open it from the card`;
    case "findings":
      return `Needs you: approve or deselect the ${plural(loop.awaitingFindings.length, "finding")} of the next round before the fix prompt goes out`;
    case "checks": {
      const last = loop.checks.at(-1);
      return `Needs you: ${NEEDS_YOU_REASON_LABEL.checks}${last === undefined ? "" : `, exit code ${last.exitCode}`}`;
    }
    default:
      return `Needs you: ${NEEDS_YOU_REASON_LABEL[reason]}`;
  }
}

/** How a step behind the current one went, where the strip's order alone would say done. */
type StepOutcome = Pick<Stage, "status" | "detail">;

const DONE: StepOutcome = { status: "done" };
const NOT_RUN: StepOutcome = { status: "skipped", detail: "not run" };
const STOPPED: StepOutcome = { status: "skipped", detail: "stopped" };
const FAILED: StepOutcome = { status: "done", detail: "failed" };

/**
 * Whether the ready commit got as far as a check, a review and a fix before the loop stopped, or ended: what the strip
 * marks done, skipped or failed at Needs you and after, where the order alone would call every earlier step done.
 */
function stepOutcomes(loop: LoopState): Partial<Record<StageId, StepOutcome>> {
  const reason: NeedsYouReason = loop.reason ?? "clean";
  const last = loop.checks.at(-1);
  const checked = last !== undefined && last.commit === loop.commit;
  const checks = checked ? (last.passed ? DONE : FAILED) : NOT_RUN;
  const fix = loop.rounds.length > 0 ? DONE : { status: "skipped" as const, detail: "no rounds" };
  switch (reason) {
    case "handed-off":
      // Only a review's completion leaves a level behind: a hand-off at a ready or after a check clears it.
      return { checks, review: checked && loop.attention !== null ? DONE : NOT_RUN, fix };
    case "stopped":
      return { checks: checked ? checks : STOPPED, review: checked ? STOPPED : NOT_RUN, fix };
    case "checks": {
      const failures = failuresInARow(loop);
      return { checks: { status: "done", detail: failures === 1 ? "failed" : `failed ${failures === 2 ? "twice" : `${failures} times`} in a row` }, review: NOT_RUN, fix };
    }
    case "loop-error":
      // The review comes after the checks, so a failed check means no review of this commit, whatever `reviewId` still names.
      return { checks: loop.failedStep === "checks" ? FAILED : checks, review: loop.failedStep === "review" ? FAILED : NOT_RUN, fix };
    case "findings":
      return { checks, review: DONE, fix: { status: "upcoming" } };
    default:
      return { checks, review: DONE, fix };
  }
}

/** The strip's step for the phase: everything before it done, everything after upcoming. */
function linearSteps(currentId: StageId, planSkipped: boolean, outcomes: Partial<Record<StageId, StepOutcome>> = {}): Stage[] {
  const at = STAGE_ORDER.indexOf(currentId);
  return STAGE_ORDER.map((id, index): Stage => {
    const outcome = outcomes[id];
    if (outcome !== undefined && index < at) return { id, label: STAGE_LABEL[id], ...outcome };
    if (id === "plan" && planSkipped) return { id, label: STAGE_LABEL[id], status: "skipped", detail: "gate off" };
    return { id, label: STAGE_LABEL[id], status: index < at ? "done" : index === at ? "current" : "upcoming" };
  });
}

function roundPills(loop: LoopState): Chip[] {
  const fixing = fixingRound(loop);
  let number = 0;
  const pills = loop.rounds.map((round: LoopRound): Chip => {
    if (round.owner === "loop") number += 1;
    const name = round.owner === "user" ? "yours" : `r${number}`;
    const answers = Object.values(round.answers);
    const fixed = answers.filter((answer) => answer.answer === "fixed").length;
    const disputed = answers.filter((answer) => answer.answer === "disputed").length;
    if (round === fixing) {
      return { label: `${name} · fixing`, tone: "accent", title: round.owner === "user" ? "The card's thread is fixing what you sent back" : `The card's thread is fixing round ${number}'s ${plural(round.handed.length, "finding")}` };
    }
    if (round.owner === "user" && round.handed.length === 0) {
      return { label: round.comments === 0 ? "yours" : `yours · ${plural(round.comments, "comment")}`, tone: "neutral", title: "A round you started; it doesn't count toward the cap" };
    }
    const parts = [fixed > 0 ? `${fixed} fixed` : null, disputed > 0 ? `${disputed} disputed` : null].filter((part) => part !== null);
    return {
      label: `${name} · ${parts.length === 0 ? `${round.handed.length} handed` : parts.join(", ")}${round.polish ? " · polish" : ""}`,
      tone: disputed > 0 ? "warning" : "neutral",
      title: `${round.owner === "user" ? "Your round" : `Round ${number}`}: ${plural(round.handed.length, "finding")} handed, ${fixed} fixed, ${disputed} disputed${round.polish ? "; a polish round, checked but not reviewed again" : ""}`,
    };
  });
  if (loop.phase === "reviewing" || loop.phase === "classifying") {
    pills.push({ label: `r${reviewNumber(loop)} · reviewing`, tone: "accent", title: currentText(loop) });
  }
  return pills;
}

/**
 * The loop as a strip of steps with who holds the ball, the current step's detail, a pill per round and the last checks
 * result: a pure function of loop state and the clock, which the card panel, the board chip and the CLI all read.
 */
export function loopStages(loop: LoopState, now: number): LoopStages {
  const phase = workingPhase(loop);
  // The gate may have been turned on past planning, when it holds nothing until a rethink; what counts is whether a plan ran.
  const planSkipped = phase !== "planning" && loop.plan === null && loop.proposedPlan === null;
  const last = loop.checks.at(-1);
  const base = {
    rounds: roundPills(loop),
    cap: { used: loop.round, max: LOOP_ROUND_CAP },
    checks: last === undefined ? null : { passed: last.passed, command: last.command ?? loop.checkCommand?.command ?? null, exitCode: last.exitCode, commit: last.commit },
    directive: loop.directive === null ? null : { kind: loop.directive, text: DIRECTIVE_TEXT[loop.directive] },
    manualRetries: loop.manualRetries,
  };
  const current = (threadRole: ThreadRole | null) => ({ text: currentText(loop), commit: loop.commit, elapsedMs: loop.phaseSince === null ? null : Math.max(0, now - loop.phaseSince), threadRole });
  const paused = loop.phase === "paused";
  switch (phase) {
    case "planning":
      return { ...base, steps: linearSteps("plan", false), holder: paused || loop.proposedPlan !== null ? "you" : "agent", current: current("card") };
    case "idle":
    case "building":
      return { ...base, steps: linearSteps("build", planSkipped), holder: paused ? "you" : "agent", current: current("card") };
    case "checking":
      return { ...base, steps: linearSteps("checks", planSkipped), holder: "board", current: current("checks") };
    case "classifying":
      return { ...base, steps: linearSteps("review", planSkipped), holder: "board", current: current("classify") };
    case "reviewing":
      return { ...base, steps: linearSteps("review", planSkipped), holder: "board", current: current("review") };
    case "fixing":
      return { ...base, steps: linearSteps("fix", planSkipped), holder: paused ? "you" : "agent", current: current("card") };
    case "needs-you":
      return { ...base, steps: linearSteps("needs-you", planSkipped, stepOutcomes(loop)), holder: "you", current: current(loop.reason === "loop-error" && loop.failedThreadId !== null ? (loop.failedStep ?? null) : null) };
    case "accepted":
      return { ...base, steps: linearSteps("land", planSkipped, stepOutcomes(loop)), holder: "agent", current: current("card") };
    case "landed":
      return { ...base, steps: linearSteps("land", planSkipped, stepOutcomes(loop)).map((step) => (step.id === "land" ? { ...step, status: "done" } : step)), holder: null, current: current(null) };
    case "paused":
      // workingPhase never answers paused without a paused phase; a stored state that does is treated as waiting on the user while building.
      return { ...base, steps: linearSteps("build", planSkipped), holder: "you", current: current("card") };
  }
}

/** How long the card has waited for the user, once that passes an hour; `phaseSince` is the moment it reached them. */
function waitingSuffix(loop: LoopState, now: number): string {
  if (loop.phaseSince === null) return "";
  const waited = now - loop.phaseSince;
  return waited >= WAITING_SHOWN_AFTER_MS ? ` · ${formatDuration(waited)}` : "";
}

/**
 * The chip a monitored card shows on the board, in the strip's words: the step under way (`build`, `checks`,
 * `review 2`, `fix 2`), the plan waiting (`plan?`), or at Needs you the bucket and its detail (`approve · r2`,
 * `needs you · clean`, `stuck · cap reached`), with how long it has waited past an hour and `→ you` while a directive is pending.
 */
export function chipFor(loop: LoopState, now: number): Chip | null {
  if (!loop.monitored) return null;
  const chip = bareChip(loop, now);
  return loop.directive === null ? chip : { ...chip, label: `${chip.label} ${DIRECTIVE_SUFFIX}`, title: `${chip.title}. Pending: ${DIRECTIVE_TEXT[loop.directive]}` };
}

function bareChip(loop: LoopState, now: number): Chip {
  const title = currentText(loop);
  switch (loop.phase) {
    case "planning":
      return loop.proposedPlan === null ? { label: "plan", tone: "neutral", title } : { label: `plan?${waitingSuffix(loop, now)}`, tone: "warning", title };
    case "idle":
    case "building":
      return { label: "build", tone: "neutral", title };
    case "checking":
      return { label: "checks", tone: "accent", title };
    case "classifying":
    case "reviewing":
      return { label: `review ${reviewNumber(loop)}`, tone: "accent", title };
    case "fixing":
      return { label: fixingRound(loop)?.owner === "user" ? "fix · yours" : `fix ${loop.round}`, tone: "accent", title };
    case "paused":
      return { label: `stuck · question${waitingSuffix(loop, now)}`, tone: "warning", title };
    case "needs-you": {
      const reason = loop.reason ?? "clean";
      const { bucket, detail } = reasonBucket(reason);
      const waiting = waitingSuffix(loop, now);
      if (bucket === "approve") return { label: `approve · r${loop.round + 1}${waiting}`, tone: "warning", title };
      if (bucket === "stuck") return { label: `stuck · ${detail}${waiting}`, tone: "danger", title };
      return { label: `needs you · ${detail}${waiting}`, tone: reason === "clean" ? "success" : "warning", title };
    }
    case "accepted":
      return { label: loop.autoAccepted ? "auto-accepted" : "accepted", tone: "success", title };
    case "landed":
      return { label: "landed", tone: "success", title };
  }
}

/** The chip as of now; for callers without a clock of their own, such as the CLI and the loop's alerts. */
export function phaseChip(loop: LoopState): Chip | null {
  return chipFor(loop, Date.now());
}
