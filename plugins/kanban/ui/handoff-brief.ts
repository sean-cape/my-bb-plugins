import { LOOP_ROUND_CAP, NEEDS_YOU_REASON_LABEL, effectiveLevel, type AttentionLevel, type LevelOverride, type CheckCommand, type ChecksOutcome, type Evidence, type LoopDispute, type LoopFinding, type LoopState } from "../shared/loop";
import { findingTallies, type Dispute, type Finding, type FindingSeverity, type Review, type ReviewReport } from "../shared/review";

export type BriefReview = Pick<Review, "id" | "status" | "createdAt" | "report">;

export interface BriefFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  /** Triage's reason for deferring or dropping it. */
  note: string;
}

export interface BriefRound {
  /** The loop's own round number, as its fix prompt gave it; null for a round the user started, which the cap doesn't count. */
  round: number | null;
  /** The user's diff comments it sent, for a round that sent them rather than findings. */
  comments: number;
  handed: number;
  /** What the re-review found addressed; null while no re-review has looked, when only the thread's answers are known. */
  resolved: Array<{ id: string; title: string }> | null;
  /** The thread's own answers, for a round no re-review has looked at yet. */
  claimed: { fixed: number; disputed: number };
}

export type BriefSection =
  /** `reasons` are the computed level's; `override` is the level the user set over it. */
  | { kind: "level"; level: AttentionLevel | null; reasons: string[]; override: LevelOverride | null; escalation: string | null; failedThreadId: string | null }
  /** `known` is false when no review ran, so nobody listed the gaps. */
  | { kind: "not-covered"; items: string[]; known: boolean }
  | { kind: "evidence"; reran: Array<ChecksOutcome & { command: string | null }>; reranBy: CheckCommand["source"] | null; claimed: Evidence["commands"]; screenshots: string[] }
  | { kind: "history"; rounds: BriefRound[]; acceptedDisputes: Array<{ id: string; title: string; dispute: Dispute }>; polish: Array<{ id: string; title: string }> }
  | { kind: "left-out"; deferred: BriefFinding[]; dropped: BriefFinding[]; preExisting: BriefFinding[]; leftOpen: LoopFinding[] }
  /** `decidable` is false for a dispute the loop doesn't hold, such as one from before monitoring; `decision` is the user's. */
  | { kind: "disputes"; disputes: Array<{ id: string; severity: FindingSeverity; title: string; agent: string; verifier: string; decidable: boolean; decision: LoopDispute["decision"] }> };

export type BriefSectionKind = BriefSection["kind"];

export const BRIEF_SECTION_TITLE: Record<BriefSectionKind, string> = {
  level: "Attention",
  "not-covered": "Not covered",
  evidence: "Evidence",
  history: "Loop history",
  "left-out": "Deferred, dropped and pre-existing",
  disputes: "Disputes awaiting you",
};

/** A monitored card waiting on the user: stopped at Needs you, or paused by its thread's question. */
export function briefShown(loop: LoopState | null): loop is LoopState {
  return loop !== null && loop.monitored && (loop.phase === "needs-you" || loop.phase === "paused");
}

function escalation(loop: LoopState, report: ReviewReport | null): string | null {
  const reason = loop.phase === "paused" ? "question" : loop.reason;
  if (reason === null || reason === "clean") return null;
  const last = loop.checks.at(-1);
  switch (reason) {
    case "cap":
      return `Stopped at the ${LOOP_ROUND_CAP}-round cap with serious findings still open`;
    case "not-converging": {
      const carried = report?.findings.filter((finding) => finding.carriedFrom !== null && finding.dispute === null && !finding.preExisting) ?? [];
      return `Not converging: a finding the agent marked fixed is still open${carried.length === 0 ? "" : ` (${carried.map((finding) => `${finding.id} ${finding.title}`).join(", ")})`}`;
    }
    case "checks":
      return `Checks failed twice in a row${last === undefined ? "" : `, last exit code ${last.exitCode} at ${last.commit.slice(0, 7)}`}`;
    case "dispute":
      return "The verifier rejected the agent's dispute of a serious finding";
    case "question":
      return "The card's thread is waiting on your answer; the loop resumes at its next ready";
    case "loop-error":
      return loop.failure === null ? "A checks or review thread failed twice" : `A checks or review thread failed: ${loop.failure}`;
    case "findings":
      return `The findings gate holds round ${loop.round + 1}: approve or deselect its findings before the fix prompt goes out`;
    default:
      return NEEDS_YOU_REASON_LABEL[reason];
  }
}

const briefFinding = (finding: Finding): BriefFinding => ({ id: finding.id, severity: finding.severity, title: finding.title, note: finding.triage?.reason ?? "" });

/**
 * What the handoff brief shows, section by section in reading order, or null when the card isn't waiting on the user.
 * The final report is the loop's current review, else the newest completed one; history reads only the loop's own
 * rounds, so reviews run by hand before monitoring don't show up in it.
 */
export function handoffBrief(loop: LoopState | null, reviews: readonly BriefReview[]): BriefSection[] | null {
  if (!briefShown(loop)) return null;
  const byId = new Map(reviews.map((review) => [review.id, review]));
  const latest = [...reviews].filter((review) => review.status === "completed" && review.report !== null).sort((a, b) => b.createdAt - a.createdAt)[0];
  const report = (loop.reviewId === null ? null : (byId.get(loop.reviewId)?.report ?? null)) ?? latest?.report ?? null;
  const sections: BriefSection[] = [];

  const reason = escalation(loop, report);
  sections.push({
    kind: "level",
    level: effectiveLevel(loop),
    reasons: loop.attention?.reasons ?? [],
    override: loop.levelOverride,
    escalation: reason,
    failedThreadId: loop.phase === "needs-you" && loop.reason === "loop-error" ? loop.failedThreadId : null,
  });

  sections.push({ kind: "not-covered", items: report?.notCovered ?? [], known: report !== null });

  const claimed = loop.evidence?.commands ?? [];
  const screenshots = loop.evidence?.screenshots ?? [];
  if (loop.checks.length > 0 || claimed.length > 0 || screenshots.length > 0) {
    sections.push({
      kind: "evidence",
      reran: loop.checks.map((outcome) => ({ ...outcome, command: loop.checkCommand?.command ?? null })),
      reranBy: loop.checkCommand?.source ?? null,
      claimed,
      screenshots,
    });
  }

  const resolvedEntries = reviews.flatMap((review) => review.report?.resolved ?? []);
  const acceptedDisputes: Array<{ id: string; title: string; dispute: Dispute }> = [];
  const polish: Array<{ id: string; title: string }> = [];
  let loopRounds = 0;
  const rounds = loop.rounds.map((round): BriefRound => {
    const answers = Object.values(round.answers);
    const claimedCounts = { fixed: answers.filter((answer) => answer.answer === "fixed").length, disputed: answers.filter((answer) => answer.answer === "disputed").length };
    const findings = new Map((byId.get(round.reviewId)?.report?.findings ?? []).map((finding) => [finding.id, finding]));
    const resolved = resolvedEntries
      .filter((entry) => entry.id.startsWith(`${round.reviewId}/`))
      .map((entry) => {
        const original = findings.get(entry.id.slice(round.reviewId.length + 1));
        return { entry, original, title: entry.title || original?.title || entry.id };
      });
    for (const { entry, original, title } of resolved) {
      if (entry.dispute?.outcome === "accepted") acceptedDisputes.push({ id: entry.id, title, dispute: entry.dispute });
      else if (original?.category === "style") polish.push({ id: entry.id, title });
    }
    return {
      round: round.owner === "user" ? null : (loopRounds += 1),
      comments: round.comments,
      handed: round.handed.length,
      resolved: resolved.length === 0 ? null : resolved.map(({ entry, title }) => ({ id: entry.id, title })),
      claimed: claimedCounts,
    };
  });
  if (rounds.length > 0) sections.push({ kind: "history", rounds, acceptedDisputes, polish });

  const own = report?.findings.filter((finding) => !finding.preExisting) ?? [];
  const rejected = own.filter((finding) => finding.dispute?.outcome === "rejected");
  const disputedIds = new Set(rejected.map((finding) => finding.id));
  const tallies = report === null ? null : findingTallies(report, {}, []);
  const leftOut = {
    deferred: tallies?.deferred.map(briefFinding) ?? [],
    dropped: tallies?.dropped.map(briefFinding) ?? [],
    preExisting: tallies?.preExisting.map(briefFinding) ?? [],
    leftOpen: loop.openFindings.filter((finding) => !disputedIds.has(finding.id)),
  };
  if (leftOut.deferred.length + leftOut.dropped.length + leftOut.preExisting.length + leftOut.leftOpen.length > 0) sections.push({ kind: "left-out", ...leftOut });

  if (rejected.length > 0) {
    sections.push({
      kind: "disputes",
      disputes: rejected.map((finding) => {
        const held = loop.disputes.find((dispute) => dispute.id === finding.id);
        return { id: finding.id, severity: finding.severity, title: finding.title, agent: finding.dispute!.reason, verifier: finding.dispute!.note, decidable: held !== undefined, decision: held?.decision ?? null };
      }),
    });
  }
  return sections;
}
