// The monitored review loop as a pure function: no I/O, no clock. The loop service feeds it events from threads, the
// CLI and the board, stores the state it returns, and carries out its actions.
import { COLUMN } from "../../shared/columns";
import {
  DEPTH_FOR_LEVEL,
  LOOP_ROUND_CAP,
  MINOR_ROUNDS,
  boardRunning,
  effectiveLevel,
  failuresInARow,
  fixingRound,
  unansweredFindings,
  workingPhase,
  type AttentionLevel,
  type CheckCommand,
  type Classification,
  type Evidence,
  type FindingAnswer,
  type LoopDirective,
  type LoopFinding,
  type LoopGates,
  type LoopRound,
  type LoopState,
  type NeedsYouReason,
  type PathRule,
} from "../../shared/loop";
import type { Finding, ReviewDepth, SeverityFloor } from "../../shared/review";
import { attentionLevel } from "./attention";

/** Failing checks in a row that stop the loop rather than go back to the card's thread. */
const CHECK_FAILURES_TO_ESCALATE = 2;

/** Times a failed checks, classify or review thread is started again before the loop stops with a loop error. */
const THREAD_RETRIES = 1;

/** What the loop reads of a review's finding to route it. */
export type ReviewedFinding = LoopFinding &
  Pick<Finding, "preExisting" | "carriedFrom" | "category"> & { triage: Pick<NonNullable<Finding["triage"]>, "decision"> | null; dispute: Pick<NonNullable<Finding["dispute"]>, "outcome"> | null };

export type LoopEvent =
  | { type: "monitor"; hasThread: boolean; gates: LoopGates }
  | { type: "unmonitor" }
  | { type: "set-gates"; gates: LoopGates }
  /** The card's thread proposes a plan, which the plan gate holds for the user. */
  | { type: "plan-proposed"; plan: string }
  /** The user approves the plan, as proposed or edited. */
  | { type: "approve-plan"; plan: string }
  /** The card's thread committed its work and says it's verified. */
  | { type: "ready"; commit: string; evidence: Evidence; checkCommand: CheckCommand }
  | { type: "checks-result"; commit: string; exitCode: number; outputTail: string; pr: boolean }
  /** `pathRules` are the project's, at the time. */
  | { type: "classified"; commit: string; classification: Classification; pathRules: PathRule[] }
  | { type: "review-started"; reviewId: string }
  /** The card's thread answers findings of the round it is fixing, by finding id. */
  | { type: "answer"; answers: Record<string, FindingAnswer> }
  /** `findings` are the report's own, without the ones its verifier filtered out. */
  | { type: "review-completed"; reviewId: string; findings: ReviewedFinding[]; notCovered: string[]; pathRules: PathRule[]; pr: boolean }
  /** The card's thread is waiting on the user: a question, an approval. */
  | { type: "question" }
  /**
   * A thread the loop started failed, was deleted, or went idle without recording its result; `threadId` is null when
   * it couldn't be started. `failure` is set when the thread finished and its output says why it has no result, which
   * a retry would only repeat.
   */
  | { type: "thread-failed"; role: "checks" | "classify"; commit: string; threadId: string | null; failure?: string }
  /** `reviewId` is null for a review that couldn't be started. */
  | { type: "thread-failed"; role: "review"; reviewId: string | null; threadId: string | null; failure?: string }
  /** The user accepts the change at Needs you; a local card's thread then lands it. */
  | { type: "accept"; pr: boolean }
  /** The card's thread landed an accepted change. */
  | { type: "landed" }
  /** The user sends their `comments` unsent diff comments to the card's thread. */
  | { type: "send-back"; comments: number }
  | { type: "rethink" }
  /** The user pulls a finding of the last review that triage deferred or dropped back in. */
  | { type: "pull-in"; findingId: string }
  | { type: "decide-dispute"; findingId: string; decision: "uphold" | "close"; pr: boolean }
  /** The user approves the findings gate's round with `findingIds`, deselecting the rest, which stay open. */
  | { type: "approve-findings"; findingIds: string[]; pr: boolean }
  /** The user sets the attention level at Needs you, overriding the computed one until the head moves. */
  | { type: "set-level"; level: AttentionLevel; reason: string }
  /** The user asks for the loop's next step to come to them instead; a newer directive replaces the pending one. */
  | { type: "set-directive"; directive: LoopDirective }
  | { type: "clear-directive" }
  /** The user stops the step the board is running; its result is discarded. */
  | { type: "stop-now" }
  /** The user starts the step that failed twice again, at the same commit. */
  | { type: "retry" }
  /** The user sends the card back from Needs you with their own words, as a round of theirs. */
  | { type: "resume"; message: string };

/** What the card's thread is told; the service words it. */
export type CardPrompt =
  /** The thread already exists, so its instructions only pick the contract up at its next session. */
  | { kind: "monitoring" }
  /** `edited` when the user changed the plan the thread proposed, or wrote one it never proposed. */
  | { kind: "plan-approved"; plan: string; edited: boolean }
  | { kind: "checks-failed"; commit: string; command: string; exitCode: number; outputTail: string }
  /** `byUser` marks a round the user started, which `round` doesn't count; `polish` one the loop won't review again. */
  | { kind: "fix"; round: number; reviewId: string; findingIds: string[]; byUser?: true; polish?: true }
  /** The user's unsent diff comments, which the service reads when it sends them. */
  | { kind: "comments" }
  /** `auto` when the auto-accept gate accepted the change, not the user. */
  | { kind: "land"; auto: boolean }
  | { kind: "rethink" }
  /** The user's words from the board, which the thread carries on from. */
  | { kind: "resume"; message: string };

export type LoopColumn = typeof COLUMN.inProgress | typeof COLUMN.checking | typeof COLUMN.review | typeof COLUMN.done;

export type StopReason = "superseded" | "stopped";

export type LoopAction =
  /** Add any column the loop moves cards to that the board lacks. */
  | { type: "ensure-columns" }
  | { type: "move"; column: LoopColumn }
  | { type: "spawn-checks"; commit: string; checkCommand: CheckCommand }
  | { type: "spawn-classify"; commit: string }
  /** `answers` are the last fix round's, keyed by the `<reviewId>/<findingId>` handle the re-review knows each finding by. */
  | { type: "spawn-review"; commit: string; mode: "full" | "incremental"; depth: ReviewDepth; answers: Record<string, FindingAnswer>; severityFloor: SeverityFloor }
  | { type: "prompt-card"; prompt: CardPrompt }
  /** The card's thread committed its answer to a fix round's findings; the disputed ones stay open. */
  | { type: "record-fix"; reviewId: string; commit: string; findingIds: string[]; disputed: string[] }
  /** The fix round ended unfixed, its findings left open. */
  | { type: "end-fix"; reviewId: string; findingIds: string[] }
  /** The checks, classify or review threads of the step the board was running stop, their results discarded: a newer ready `superseded` the commit, or the user `stopped` the step. */
  | { type: "stop-step"; reason: StopReason }
  /** The narrative the reading plan steps through; the service skips it when one is current. */
  | { type: "spawn-narrative" }
  /** The loop stopped for the user, usually long after the card's thread last ended a turn, so nothing else tells them: back to unread, with an alert. */
  | { type: "alert" };

export interface LoopStep {
  state: LoopState;
  actions: LoopAction[];
}

const stay = (state: LoopState): LoopStep => ({ state, actions: [] });

/** Levels the reading plan needs a narrative for; it costs too much to spawn for a Glance. */
const narrated = (level: AttentionLevel | null): boolean => level === "read" || level === "scrutinize";

/**
 * Stops whose next step is fixing the setup or the code, not reading the change, so a narrative would be stale before
 * it's read; and the stops the user asked for, whose brief has no reading plan.
 */
const UNREAD_STOPS: ReadonlySet<NeedsYouReason> = new Set(["loop-error", "checks", "handed-off", "stopped"]);

/** Kept so a long-lived card's state stays small. */
const LEVEL_OVERRIDES_KEPT = 20;

/** A decision the user makes at Needs you can leave the card there, and they are already looking at it. */
const alertOnEntry = (state: LoopState): LoopAction[] => (state.phase === "needs-you" ? [] : [{ type: "alert" }]);

/** What a stop at Needs you or a question recorded, which every event that leaves them clears; a loop error's failed thread would otherwise stay linked while the card builds. */
const CLEARED_STOP = { reason: null, pausedPhase: null, failedThreadId: null, failedStep: null, failure: null } as const satisfies Partial<LoopState>;

/** A directive still pending at a stop would promise something the loop no longer does, so every stop clears it. */
function needsYou(state: LoopState, reason: NeedsYouReason): LoopStep {
  return {
    state: { ...state, phase: "needs-you", reason, directive: null },
    actions: [{ type: "move", column: COLUMN.review }, ...alertOnEntry(state), ...(narrated(effectiveLevel(state)) && !UNREAD_STOPS.has(reason) ? [{ type: "spawn-narrative" as const }] : [])],
  };
}

/** A PR card is left for the user to merge, and sync moves it to Done; a local card's thread lands the change. The reason stays, as what the loop stopped for. */
function accepted(state: LoopState, pr: boolean): LoopStep {
  const next = { ...state, phase: "accepted" as const, directive: null };
  return pr ? stay(next) : { state: next, actions: [{ type: "prompt-card", prompt: { kind: "land", auto: state.autoAccepted } }] };
}

/**
 * The loop ended clean. The auto-accept gate accepts it without stopping only at Glance, with no serious finding or
 * escalated dispute open; open minors don't block it and stay listed on the card.
 */
function finish(state: LoopState, pr: boolean): LoopStep {
  const serious = state.openFindings.some((finding) => finding.severity !== "minor") || state.disputes.some((dispute) => dispute.decision === null && dispute.severity !== "minor");
  if (!state.gates.autoAccept || effectiveLevel(state) !== "glance" || serious) return needsYou(state, "clean");
  const step = accepted({ ...state, autoAccepted: true }, pr);
  return { state: step.state, actions: [{ type: "move", column: pr ? COLUMN.review : COLUMN.inProgress }, ...step.actions] };
}

/** Stopped for the user, who can accept, send back, rethink or settle findings. */
const waiting = (state: LoopState): boolean => state.monitored && state.phase === "needs-you";

/** The board has the work, or the change landed, so the card thread's turn that handed it over needs nothing from the user. */
export const passiveIdle = (state: LoopState): boolean => state.monitored && (boardRunning(state) || state.phase === "landed");

/**
 * Deferred, dropped and pre-existing findings never enter a round; only triage's apply does, whatever the severity. A
 * disputed finding never goes back either: an accepted dispute closed it, and a rejected one is the user's to settle.
 */
function routed(findings: ReviewedFinding[]): ReviewedFinding[] {
  return findings.filter((finding) => !finding.preExisting && finding.triage?.decision === "apply" && finding.dispute === null);
}

const loopFinding = ({ id, severity, title }: ReviewedFinding): LoopFinding => ({ id, severity, title });

function lastRoundAnswers(state: LoopState): Record<string, FindingAnswer> {
  const round = state.rounds.at(-1);
  if (round === undefined) return {};
  return Object.fromEntries(Object.entries(round.answers).map(([id, answer]) => [`${round.reviewId}/${id}`, answer]));
}

/** Past the minor rounds a new minor can't start a round, so the re-review doesn't look for one. */
function reviewAction(state: LoopState, commit: string): LoopAction {
  return state.rounds.length === 0
    ? { type: "spawn-review", commit, mode: "full", depth: state.depth, answers: {}, severityFloor: null }
    : { type: "spawn-review", commit, mode: "incremental", depth: state.depth, answers: lastRoundAnswers(state), severityFloor: state.round >= MINOR_ROUNDS ? "important" : null };
}

function retryAction(state: LoopState, event: Extract<LoopEvent, { type: "thread-failed" }>): LoopAction | null {
  if (event.role === "classify") return { type: "spawn-classify", commit: event.commit };
  if (event.role === "checks") return state.checkCommand === null ? null : { type: "spawn-checks", commit: event.commit, checkCommand: state.checkCommand };
  return state.commit === null ? null : reviewAction(state, state.commit);
}

/** The first round reviews at the depth its attention level picks; without a classification there are no files for path rules to match, so it gets Standard. */
function classified(state: LoopState, commit: string, classification: Classification | null, pathRules: PathRule[]): LoopStep {
  const attention = attentionLevel({ ...loopSignals(state), files: classification?.files ?? null, pathRules, untested: 0, openScopeFindings: 0, deferredCritical: 0 });
  const next: LoopState = { ...state, phase: "reviewing", reason: null, retries: 0, reviewId: null, classification, attention, depth: DEPTH_FOR_LEVEL[attention.level] };
  return { state: next, actions: [reviewAction(next, commit)] };
}

/** A failure under a check command the thread later replaced was the command's, not the code's, so it isn't a signal. */
function loopSignals(state: LoopState): { rounds: number; disputes: number; checkFailures: number } {
  const command = state.checkCommand?.command ?? null;
  return {
    rounds: state.round,
    disputes: state.rounds.reduce((sum, round) => sum + Object.values(round.answers).filter((answer) => answer.answer === "disputed").length, 0),
    checkFailures: state.checks.filter((outcome) => !outcome.passed && (outcome.command === null || outcome.command === command)).length,
  };
}

/** The polish round the loop's current review ended with, whose check is the loop's last step. */
function polishRound(state: LoopState): LoopRound | undefined {
  const round = state.rounds.at(-1);
  return round !== undefined && round.polish && round.reviewId === state.reviewId ? round : undefined;
}

/**
 * A polish round's disputed findings stay open, since no re-review judges them, and so do the ones left open beside
 * it; any other round's findings a review carries, so none are left by it.
 */
function withLeftOpen(state: LoopState): LoopState {
  const round = polishRound(state);
  if (round === undefined) return state;
  const left = round.findings.filter((finding) => !round.handed.includes(finding.id) || round.answers[finding.id]?.answer === "disputed");
  return { ...state, openFindings: [...state.openFindings, ...left] };
}

/** A polish round's passing check ends the loop, with its left-open findings listed. */
function polished(state: LoopState, pr: boolean): LoopStep | null {
  return polishRound(state) === undefined ? null : finish(withLeftOpen(state), pr);
}

/** The level is recomputed when the loop stops after a review, with what the rounds and the last review showed. */
function reviewCompleted(base: LoopState, event: Extract<LoopEvent, { type: "review-completed" }>): LoopStep {
  const { reviewId, findings } = event;
  const own = findings.filter((finding) => !finding.preExisting);
  const attention = attentionLevel({
    ...loopSignals(base),
    files: base.classification?.files ?? null,
    pathRules: event.pathRules,
    untested: event.notCovered.filter((entry) => /^untested:/iu.test(entry.trim())).length,
    openScopeFindings: own.filter((finding) => finding.category === "scope" && finding.triage?.decision !== "drop" && finding.dispute?.outcome !== "accepted").length,
    deferredCritical: own.filter((finding) => finding.severity === "critical" && finding.triage?.decision === "defer").length,
  });
  const rejected = own.filter((finding) => finding.dispute?.outcome === "rejected");
  const state: LoopState = { ...base, attention, disputes: rejected.map((finding) => ({ ...loopFinding(finding), decision: null })), heldFindings: [] };
  // The user asked for the review's result and no fix round: everything it would have routed is listed as open.
  if (base.directive === "hand-off-after-step") return needsYou({ ...state, openFindings: [...rejected, ...routed(findings)].map(loopFinding) }, "handed-off");
  const answers = lastRoundAnswers(state);
  // A minor answered fixed but still there isn't worth stopping for, or handing back to the same fix; it stays listed as open.
  const unconverged = own.filter((finding) => finding.carriedFrom !== null && answers[finding.carriedFrom]?.answer === "fixed");
  if (unconverged.some((finding) => finding.severity !== "minor")) return needsYou(state, "not-converging");
  const keptOpen = [...rejected, ...unconverged].map(loopFinding);
  const open = routed(findings).filter((finding) => !unconverged.includes(finding)).map(loopFinding);
  if (rejected.some((finding) => finding.severity !== "minor")) return needsYou({ ...state, openFindings: keptOpen, heldFindings: open }, "dispute");
  return route(state, { ...base, disputes: state.disputes }, reviewId, open, keptOpen, event.pr);
}

/**
 * Hands `open` to the card's thread as the loop's next round, or stops at Needs you: clean when nothing is open or
 * only minors are left after the minor rounds, and for the findings gate's approval. A round starts from `base`, since
 * the level is only recomputed when the loop stops.
 */
function route(stopped: LoopState, base: LoopState, reviewId: string, open: LoopFinding[], keptOpen: LoopFinding[], pr: boolean): LoopStep {
  if (open.length === 0) return finish({ ...stopped, openFindings: keptOpen }, pr);
  if (stopped.round >= MINOR_ROUNDS && open.every((finding) => finding.severity === "minor")) return finish({ ...stopped, openFindings: [...open, ...keptOpen] }, pr);
  if (stopped.round >= LOOP_ROUND_CAP) return needsYou(stopped, "cap");
  // No narrative: the user only picks findings here, and the loop carries on once they have.
  if (stopped.gates.findings) {
    return { state: { ...stopped, phase: "needs-you", reason: "findings", reviewId, openFindings: keptOpen, awaitingFindings: open }, actions: [{ type: "move", column: COLUMN.review }, ...alertOnEntry(stopped)] };
  }
  return loopRound(stopped, base, reviewId, open, keptOpen);
}

/**
 * A round of only minor findings is a polish round: re-reviewing a few nits costs more than they are worth, so the
 * fix is checked and the loop then ends, with the level the review that found them computed.
 */
/** `leftOpen` are the findings already open beside the round's, which a polish round keeps listed since no review carries them. */
function loopRound(stopped: LoopState, base: LoopState, reviewId: string, open: LoopFinding[], leftOpen: LoopFinding[]): LoopStep {
  const round = stopped.round + 1;
  const findingIds = open.map((finding) => finding.id);
  const polish = open.every((finding) => finding.severity === "minor");
  return {
    state: {
      ...base,
      ...CLEARED_STOP,
      ...(polish ? { attention: stopped.attention } : {}),
      phase: "fixing",
      round,
      reviewId,
      heldFindings: [],
      awaitingFindings: [],
      rounds: [...stopped.rounds, { reviewId, handed: findingIds, answers: {}, owner: "loop", comments: 0, polish, findings: polish ? [...open, ...leftOpen] : [] }],
    },
    actions: [
      { type: "move", column: COLUMN.inProgress },
      { type: "prompt-card", prompt: { kind: "fix", round, reviewId, findingIds, ...(polish ? { polish: true as const } : {}) } },
    ],
  };
}

/** A round of the user's on review `reviewId`: the findings they `handed` back, or the `comments` they sent. */
const ownRound = (reviewId: string, handed: string[], comments: number): LoopRound => ({ reviewId, handed, answers: {}, owner: "user", comments, polish: false, findings: [] });

/** A fix round the user started on the last review's findings; it goes through the usual answers and re-review, but `round` doesn't count it. */
function userRound(state: LoopState, reviewId: string, findingIds: string[]): LoopStep {
  return {
    state: {
      ...state,
      ...CLEARED_STOP,
      phase: "fixing",
      humanRounds: state.humanRounds + 1,
      heldFindings: [],
      rounds: [...state.rounds, ownRound(reviewId, findingIds, 0)],
    },
    actions: [
      { type: "move", column: COLUMN.inProgress },
      { type: "prompt-card", prompt: { kind: "fix", round: state.round, reviewId, findingIds, byUser: true } },
    ],
  };
}

/**
 * The user sends the card back from Needs you with `prompt`: their diff comments, or their own words. Logged as a round
 * of theirs on the last review, so the next review is the incremental one of what the thread changed for them.
 */
function sentBack(state: LoopState, comments: number, prompt: CardPrompt): LoopStep {
  const rounds = state.reviewId === null ? state.rounds : [...state.rounds, ownRound(state.reviewId, [], comments)];
  return {
    state: { ...state, ...CLEARED_STOP, phase: "building", humanRounds: state.humanRounds + 1, heldFindings: [], awaitingFindings: [], rounds },
    actions: [
      { type: "move", column: COLUMN.inProgress },
      { type: "prompt-card", prompt },
    ],
  };
}

/** Once no serious dispute waits on the user, the upheld ones go to fix with what they held back, as the user's round. */
function decideDispute(state: LoopState, findingId: string, decision: "uphold" | "close", pr: boolean): LoopStep {
  const target = state.disputes.find((dispute) => dispute.id === findingId && dispute.decision === null);
  if (target === undefined || state.reviewId === null) return stay(state);
  const disputes = state.disputes.map((dispute) => (dispute === target ? { ...dispute, decision: decision === "uphold" ? ("upheld" as const) : ("closed" as const) } : dispute));
  const closed = new Set(disputes.filter((dispute) => dispute.decision === "closed").map((dispute) => dispute.id));
  const next = { ...state, disputes, openFindings: state.openFindings.filter((finding) => !closed.has(finding.id)) };
  if (disputes.some((dispute) => dispute.decision === null && dispute.severity !== "minor")) return stay(next);
  const upheld = disputes.filter((dispute) => dispute.decision === "upheld").map((dispute) => dispute.id);
  if (upheld.length > 0) return userRound(next, state.reviewId, [...upheld, ...next.heldFindings.map((finding) => finding.id)]);
  return route(next, next, state.reviewId, next.heldFindings, next.openFindings, pr);
}

/** The findings gate's round goes out with the approved findings; the deselected stay open, and with none approved the loop ends. */
function approveFindings(state: LoopState, findingIds: string[], pr: boolean): LoopStep {
  if (state.reason !== "findings" || state.reviewId === null) return stay(state);
  const approved = state.awaitingFindings.filter((finding) => findingIds.includes(finding.id));
  const next = { ...state, awaitingFindings: [], openFindings: [...state.openFindings, ...state.awaitingFindings.filter((finding) => !findingIds.includes(finding.id))] };
  if (approved.length === 0) return finish(next, pr);
  return loopRound(next, next, state.reviewId, approved, next.openFindings);
}

export function reduce(state: LoopState, event: LoopEvent): LoopStep {
  switch (event.type) {
    case "monitor":
      if (state.monitored) return stay(state);
      return {
        // A check or review still running from before the card was unmonitored carries on.
        state: {
          ...state,
          ...CLEARED_STOP,
          monitored: true,
          gates: event.gates,
          phase: boardRunning(state) ? state.phase : event.gates.plan && state.plan === null ? "planning" : "building",
        },
        actions: [{ type: "ensure-columns" }, ...(event.hasThread ? [{ type: "prompt-card" as const, prompt: { kind: "monitoring" as const } }] : [])],
      };
    case "set-gates":
      // Turning the plan gate on only takes effect at the next monitor or rethink; turning it off lets a held thread build.
      return stay({ ...state, gates: event.gates, phase: state.phase === "planning" && !event.gates.plan ? "building" : state.phase });
    case "plan-proposed":
      if (!state.monitored || state.phase !== "planning") return stay(state);
      return { state: { ...state, proposedPlan: event.plan }, actions: [{ type: "move", column: COLUMN.review }] };
    case "approve-plan":
      if (!state.monitored || state.phase !== "planning") return stay(state);
      return {
        state: { ...state, phase: "building", plan: event.plan, proposedPlan: null },
        actions: [
          { type: "move", column: COLUMN.inProgress },
          { type: "prompt-card", prompt: { kind: "plan-approved", plan: event.plan, edited: state.proposedPlan?.trim() !== event.plan.trim() } },
        ],
      };
    case "unmonitor": {
      // The loop stops after the current step, so a running check or review keeps its phase until its result arrives.
      const next: LoopState = { ...state, ...CLEARED_STOP, monitored: false, phase: boardRunning(state) ? state.phase : "idle", directive: null };
      const round = fixingRound(state);
      // The fix round is the review's apply round; ending it gives the review its manual Apply back.
      return round === undefined ? stay(next) : { state: next, actions: [{ type: "end-fix", reviewId: round.reviewId, findingIds: round.handed }] };
    }
    case "checks-result": {
      if (state.phase !== "checking" || state.commit !== event.commit) return stay(state);
      const passed = event.exitCode === 0;
      const recorded = { ...state, checks: [...state.checks, { commit: event.commit, exitCode: event.exitCode, passed, command: state.checkCommand?.command ?? null }] };
      if (!state.monitored) return stay({ ...recorded, phase: "idle" });
      // Before the polish check: a polish round's pass can auto-accept, and the user asked to see the change themselves. No review assessed this commit, so no level stands.
      if (passed && (state.directive === "hand-off-after-step" || state.directive === "skip-review-once")) return needsYou({ ...withLeftOpen(recorded), attention: null }, "handed-off");
      if (!passed && state.directive === "hand-off-after-step") return needsYou(recorded, "checks");
      // Only a change not yet classified is, so the user's rounds don't classify again; a rethink clears the level.
      const polish = passed ? polished(recorded, event.pr) : null;
      if (polish !== null) return polish;
      if (passed && state.attention === null) return { state: { ...recorded, phase: "classifying", reason: null, retries: 0 }, actions: [{ type: "spawn-classify", commit: event.commit }] };
      if (passed) {
        return { state: { ...recorded, phase: "reviewing", reason: null, reviewId: null, retries: 0 }, actions: [reviewAction(state, event.commit)] };
      }
      if (failuresInARow(recorded) >= CHECK_FAILURES_TO_ESCALATE) return needsYou(recorded, "checks");
      return {
        state: { ...recorded, phase: "building", reason: null },
        actions: [
          { type: "move", column: COLUMN.inProgress },
          {
            type: "prompt-card",
            prompt: { kind: "checks-failed", commit: event.commit, command: state.checkCommand?.command ?? "", exitCode: event.exitCode, outputTail: event.outputTail },
          },
        ],
      };
    }
    case "ready": {
      if (!state.monitored || state.phase === "accepted" || state.phase === "landed" || state.phase === "planning") return stay(state);
      if (boardRunning(state) && state.commit === event.commit) return stay(state);
      // The service refuses such a report with the ids; this only keeps the round from completing half-answered.
      if (unansweredFindings(state).length > 0) return stay(state);
      const handed = fixingRound(state);
      const next: LoopState = {
        ...state,
        ...CLEARED_STOP,
        phase: "checking",
        retries: 0,
        commit: event.commit,
        evidence: event.evidence,
        checkCommand: event.checkCommand,
        openFindings: [],
        awaitingFindings: [],
        levelOverride: state.levelOverride?.commit === event.commit ? state.levelOverride : null,
      };
      const settled: LoopAction[] = [
        ...(boardRunning(state) ? [{ type: "stop-step" as const, reason: "superseded" as const }] : []),
        ...(handed === undefined
          ? []
          : [
              {
                type: "record-fix" as const,
                reviewId: handed.reviewId,
                commit: event.commit,
                findingIds: handed.handed,
                disputed: handed.handed.filter((id) => handed.answers[id]?.answer === "disputed"),
              },
            ]),
      ];
      // The user asked to see this ready themselves: the commit and evidence are kept, and nothing checks or reviews it.
      if (state.directive === "hand-off-at-ready") {
        const step = needsYou({ ...withLeftOpen(next), attention: null }, "handed-off");
        return { state: step.state, actions: [...settled, ...step.actions] };
      }
      return {
        state: next,
        actions: [...settled, { type: "move", column: COLUMN.checking }, { type: "spawn-checks", commit: event.commit, checkCommand: event.checkCommand }],
      };
    }
    case "answer": {
      if (workingPhase(state) !== "fixing") return stay(state);
      const rounds = state.rounds.map((round) =>
        round.reviewId !== state.reviewId
          ? round
          : { ...round, answers: { ...round.answers, ...Object.fromEntries(Object.entries(event.answers).filter(([id]) => round.handed.includes(id))) } },
      );
      return stay({ ...state, rounds });
    }
    case "classified":
      if (state.phase !== "classifying" || state.commit !== event.commit) return stay(state);
      if (!state.monitored) return stay({ ...state, phase: "idle" });
      return classified(state, event.commit, event.classification, event.pathRules);
    case "review-started":
      if (state.phase !== "reviewing" || state.reviewId !== null) return stay(state);
      return stay({ ...state, reviewId: event.reviewId });
    case "review-completed":
      if (state.phase !== "reviewing" || state.reviewId !== event.reviewId) return stay(state);
      if (!state.monitored) return stay({ ...state, phase: "idle" });
      return reviewCompleted(state, event);
    case "thread-failed": {
      const ours =
        event.role === "review" ? state.phase === "reviewing" && state.reviewId === event.reviewId : state.phase === (event.role === "checks" ? "checking" : "classifying") && state.commit === event.commit;
      if (!ours) return stay(state);
      if (!state.monitored) return stay({ ...state, phase: "idle" });
      const retry = event.failure === undefined && state.retries < THREAD_RETRIES ? retryAction(state, event) : null;
      if (retry !== null) return { state: { ...state, retries: state.retries + 1, reviewId: null }, actions: [retry] };
      // Classifying only sets the depth, so the review goes ahead without it rather than stopping the loop.
      if (event.role === "classify") return classified(state, event.commit, null, []);
      return needsYou({ ...state, failedThreadId: event.threadId, failedStep: event.role, failure: event.failure ?? null }, "loop-error");
    }
    case "question":
      // A plan gate's own approval will arrive as an interaction too, so only the thread's working phases pause.
      if (!state.monitored || (state.phase !== "building" && state.phase !== "fixing")) return stay(state);
      return stay({ ...state, phase: "paused", reason: "question", pausedPhase: state.phase });
    case "accept":
      if (!waiting(state)) return stay(state);
      return accepted({ ...state, autoAccepted: false }, event.pr);
    case "landed":
      if (state.phase !== "accepted") return stay(state);
      return { state: { ...state, phase: "landed" }, actions: [{ type: "move", column: COLUMN.done }] };
    case "send-back":
      if (!waiting(state) || event.comments === 0) return stay(state);
      return sentBack(state, event.comments, { kind: "comments" });
    case "rethink":
      if (!waiting(state)) return stay(state);
      return {
        state: {
          ...state,
          ...CLEARED_STOP,
          phase: state.gates.plan ? "planning" : "building",
          directive: null,
          round: 0,
          rounds: [],
          reviewId: null,
          attention: null,
          levelOverride: null,
          classification: null,
          openFindings: [],
          disputes: [],
          heldFindings: [],
          awaitingFindings: [],
          plan: null,
          proposedPlan: null,
        },
        actions: [
          { type: "move", column: COLUMN.inProgress },
          { type: "prompt-card", prompt: { kind: "rethink" } },
        ],
      };
    case "pull-in":
      if (!waiting(state) || state.reviewId === null) return stay(state);
      return userRound(state, state.reviewId, [event.findingId]);
    case "decide-dispute":
      if (!waiting(state)) return stay(state);
      return decideDispute(state, event.findingId, event.decision, event.pr);
    case "approve-findings":
      if (!waiting(state)) return stay(state);
      return approveFindings(state, event.findingIds, event.pr);
    case "set-level": {
      if (!waiting(state)) return stay(state);
      const override = { level: event.level, reason: event.reason, from: state.attention?.level ?? null, commit: state.commit };
      return {
        state: { ...state, levelOverride: override, levelOverrides: [...state.levelOverrides, override].slice(-LEVEL_OVERRIDES_KEPT) },
        actions: narrated(event.level) ? [{ type: "spawn-narrative" }] : [],
      };
    }
    case "set-directive":
      // At Needs you the card is already with the user, so there is nothing to hand off.
      if (!state.monitored || state.phase === "idle" || state.phase === "needs-you" || state.phase === "accepted" || state.phase === "landed") return stay(state);
      return stay({ ...state, directive: event.directive });
    case "clear-directive":
      return stay({ ...state, directive: null });
    case "stop-now": {
      if (!state.monitored || !boardRunning(state)) return stay(state);
      // A stopped review is no review to pull findings from; a stopped check leaves the review the fix round answered.
      const step = needsYou({ ...withLeftOpen(state), reviewId: state.phase === "reviewing" ? null : state.reviewId }, "stopped");
      return { state: step.state, actions: [{ type: "stop-step", reason: "stopped" }, ...step.actions] };
    }
    case "retry": {
      if (!waiting(state) || state.reason !== "loop-error" || state.commit === null) return stay(state);
      const restarted = { ...state, ...CLEARED_STOP, retries: 0, manualRetries: state.manualRetries + 1 };
      if (state.failedStep === "checks") {
        if (state.checkCommand === null) return stay(state);
        return { state: { ...restarted, phase: "checking" }, actions: [{ type: "move", column: COLUMN.checking }, { type: "spawn-checks", commit: state.commit, checkCommand: state.checkCommand }] };
      }
      if (state.failedStep === "review") return { state: { ...restarted, phase: "reviewing", reviewId: null }, actions: [{ type: "move", column: COLUMN.checking }, reviewAction(state, state.commit)] };
      return stay(state);
    }
    case "resume":
      if (!waiting(state)) return stay(state);
      return sentBack(state, 0, { kind: "resume", message: event.message });
  }
}
