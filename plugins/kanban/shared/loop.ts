import { z } from "zod";
import { DEFAULT_REVIEW_DEPTH, findingSeveritySchema, reviewDepthSchema, type ReviewDepth } from "./review";

/** Where a monitored card is in the review loop. */
export const loopPhaseSchema = z.enum(["idle", "planning", "building", "checking", "classifying", "reviewing", "fixing", "paused", "needs-you", "accepted", "landed"]);
export type LoopPhase = z.infer<typeof loopPhaseSchema>;

/** Why the loop stopped at Needs you: `clean` is the happy ending, every other reason an escalation. */
export const needsYouReasonSchema = z.enum(["clean", "cap", "not-converging", "checks", "dispute", "question", "loop-error", "findings"]);
export type NeedsYouReason = z.infer<typeof needsYouReasonSchema>;

export const NEEDS_YOU_REASON_LABEL: Record<NeedsYouReason, string> = {
  clean: "clean",
  cap: "cap reached",
  "not-converging": "not converging",
  checks: "checks failing",
  dispute: "dispute",
  question: "question",
  "loop-error": "loop error",
  findings: "findings to approve",
};

/** Kept short so a card's loop state stays small; the checks table keeps the full tail of a re-run. */
const OUTPUT_TAIL_MAX = 4000;
const outputTailSchema = z.string().transform((tail) => tail.slice(-OUTPUT_TAIL_MAX));

/** What the card's thread says it ran to verify its work. */
export const evidenceSchema = z.object({
  commands: z
    .array(z.object({ command: z.string().trim().min(1).max(2000), exitCode: z.number().int(), outputTail: outputTailSchema.default("") }).strict())
    .max(20)
    .default([]),
  screenshots: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
});
export type Evidence = z.infer<typeof evidenceSchema>;

/** How hard the user should look at a change; it picks the depth of the loop's reviews. */
export const attentionLevelSchema = z.enum(["glance", "read", "scrutinize"]);
export type AttentionLevel = z.infer<typeof attentionLevelSchema>;

export const ATTENTION_LEVEL_LABEL: Record<AttentionLevel, string> = { glance: "Glance", read: "Read", scrutinize: "Scrutinize" };

export const DEPTH_FOR_LEVEL: Record<AttentionLevel, ReviewDepth> = { glance: "quick", read: "standard", scrutinize: "deep" };

/** Changed files matching `glob` are looked at with at least `level` attention. */
export const pathRuleSchema = z.object({ glob: z.string().trim().min(1).max(500), level: attentionLevelSchema }).strict();
export type PathRule = z.infer<typeof pathRuleSchema>;

/** Path rules as the card panel writes them: `<glob> <level>`, comma-separated. */
export function formatPathRules(rules: PathRule[]): string {
  return rules.map((rule) => `${rule.glob} ${rule.level}`).join(", ");
}

/** The rules of `text`, or the entry that isn't one. */
export function parsePathRules(text: string): { rules: PathRule[] } | { invalid: string } {
  const rules: PathRule[] = [];
  for (const entry of text.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    const match = /^(\S+)\s+(\S+)$/u.exec(entry);
    const level = attentionLevelSchema.safeParse(match?.[2]?.toLowerCase());
    if (match === null || !level.success) return { invalid: entry };
    rules.push({ glob: match[1]!, level: level.data });
  }
  return { rules };
}

/** What the board knows about one project, set from the card panel. */
export const projectSettingsSchema = z.object({
  /** Re-run by the board at every ready commit; null leaves the choice to the card's agent. */
  checkCommand: z.string().trim().min(1).max(2000).nullable().default(null),
  pathRules: z.array(pathRuleSchema).max(50).default([]),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

/** The command the board re-runs, and whether the project set it or the agent chose it. */
export const checkCommandSchema = z.object({ command: z.string().min(1), source: z.enum(["project", "agent"]) });
export type CheckCommand = z.infer<typeof checkCommandSchema>;

/** One re-run of the checks, as the loop remembers it. */
/** `command` is the check command that ran; null in outcomes stored before it was kept. */
export const checksOutcomeSchema = z.object({ commit: z.string(), exitCode: z.number().int(), passed: z.boolean(), command: z.string().nullable().default(null) });
export type ChecksOutcome = z.infer<typeof checksOutcomeSchema>;

/** The classify thread's score of one changed file. */
export const classifiedFileSchema = z.object({
  path: z.string().min(1).max(1000),
  /** 1 (mechanical) to 5 (security-, data- or money-sensitive). */
  risk: z.number().int().min(1).max(5),
  role: z.enum(["key", "supporting", "mechanical"]),
  /** Lines added and removed. */
  lines: z.number().int().min(0).default(0),
  /** Why it scored that risk, in a few words; the attention level's reasons quote it. */
  note: z.string().max(300).default(""),
});
export type ClassifiedFile = z.infer<typeof classifiedFileSchema>;

/** What the classify thread hands back as a ```json kanban-classify block. */
export const classificationSchema = z.object({ files: z.array(classifiedFileSchema).max(2000) });
export type Classification = z.infer<typeof classificationSchema>;

export const attentionSchema = z.object({ level: attentionLevelSchema, reasons: z.array(z.string()) });
export type Attention = z.infer<typeof attentionSchema>;

/** A level the user set at Needs you, and why; `from` is the level the loop had computed, `commit` the head it holds for. */
export const levelOverrideSchema = z.object({
  level: attentionLevelSchema,
  reason: z.string().trim().min(1).max(2000),
  from: attentionLevelSchema.nullable(),
  commit: z.string().nullable(),
});
export type LevelOverride = z.infer<typeof levelOverrideSchema>;

/** Automatic fix rounds before the loop stops for the user. */
export const LOOP_ROUND_CAP = 3;

/**
 * Automatic rounds in which minor findings alone start another. Later reviews only start a round for a critical or
 * important finding, which the open minors ride along with; otherwise the loop ends with them listed.
 */
export const MINOR_ROUNDS = 1;

/** A finding the loop handed to the card's thread, or left open when it stopped. */
export const loopFindingSchema = z.object({ id: z.string(), severity: findingSeveritySchema, title: z.string() });
export type LoopFinding = z.infer<typeof loopFindingSchema>;

/** The card thread's answer to one finding of a fix round. */
export const findingAnswerSchema = z.discriminatedUnion("answer", [
  z.object({ answer: z.literal("fixed") }),
  z.object({ answer: z.literal("disputed"), reason: z.string().trim().min(1).max(4000) }),
]);
export type FindingAnswer = z.infer<typeof findingAnswerSchema>;

/**
 * One fix round: the review it answers, the findings it handed over, and the thread's answer to each, by finding id.
 * A round the user started never counts toward the cap; one that sent their diff comments hands no findings.
 */
export const loopRoundSchema = z.object({
  reviewId: z.string(),
  handed: z.array(z.string()),
  answers: z.record(z.string(), findingAnswerSchema).default({}),
  owner: z.enum(["loop", "user"]).default("loop"),
  comments: z.number().int().default(0),
  /** Only minor findings, so the fix is checked but not reviewed again, and the loop ends after it. */
  polish: z.boolean().default(false),
  /** A polish round's handed findings and the ones already open beside them, listed as left open when the loop ends: those not handed, and the handed ones disputed. */
  findings: z.array(loopFindingSchema).default([]),
});
export type LoopRound = z.infer<typeof loopRoundSchema>;

/** The phase the loop is in, or the one a question paused. */
export function workingPhase(state: LoopState): LoopPhase {
  return state.phase === "paused" && state.pausedPhase !== null ? state.pausedPhase : state.phase;
}

/** The round the card's thread is fixing, paused by a question or not; the newest, since a user's round can answer a review a loop round already did. */
export function fixingRound(state: LoopState): LoopRound | undefined {
  return workingPhase(state) === "fixing" ? [...state.rounds].reverse().find((entry) => entry.reviewId === state.reviewId) : undefined;
}

/** The handed findings of the round being fixed that the card's thread hasn't answered yet. */
export function unansweredFindings(state: LoopState): string[] {
  const round = fixingRound(state);
  return round === undefined ? [] : round.handed.filter((id) => round.answers[id] === undefined);
}

/** A dispute the verifier rejected, and what the user decided: upheld sends it to fix, closed settles it. */
export const loopDisputeSchema = loopFindingSchema.extend({ decision: z.enum(["upheld", "closed"]).nullable().default(null) });
export type LoopDispute = z.infer<typeof loopDisputeSchema>;

export const loopGatesSchema = z.object({
  /** Stop after the card's thread proposes a plan, until it's approved. */
  plan: z.boolean().default(false),
  /** Each round's findings wait for approval before the fix prompt goes out. */
  findings: z.boolean().default(false),
  /** A change that ends at Glance level with nothing serious open is accepted without stopping at Needs you. */
  autoAccept: z.boolean().default(false),
});
export type LoopGates = z.infer<typeof loopGatesSchema>;

/** The gates a card is monitored with unless they're chosen: a Jira ticket's plan waits for approval, an ad hoc card's doesn't. */
export function defaultGates(kind: "pr" | "jira" | "adhoc"): LoopGates {
  return { plan: kind === "jira", findings: false, autoAccept: false };
}

export const PLAN_MAX_LENGTH = 20_000;

/** Every field has a default, so state stored by an older version of the loop still parses. */
export const loopStateSchema = z.object({
  monitored: z.boolean().default(false),
  gates: loopGatesSchema.default({ plan: false, findings: false, autoAccept: false }),
  phase: loopPhaseSchema.default("idle"),
  /** The plan the card's thread proposed, waiting on the plan gate. */
  proposedPlan: z.string().nullable().default(null),
  /** The plan the user approved, possibly edited; the reviews hold the change to it. */
  plan: z.string().nullable().default(null),
  /** Set while the phase is needs-you, and to question while paused. */
  reason: needsYouReasonSchema.nullable().default(null),
  /** The phase a question paused, which the next ready resumes from. */
  pausedPhase: loopPhaseSchema.nullable().default(null),
  /** Times the current check or review was started again after its thread failed. */
  retries: z.number().int().default(0),
  /** The thread whose second failure stopped the loop with a loop error. */
  failedThreadId: z.string().nullable().default(null),
  /** What the failed thread's output says went wrong, when it says; such a failure isn't retried. */
  failure: z.string().nullable().default(null),
  /** Automatic fix rounds started; the cap counts these. */
  round: z.number().int().default(0),
  /** The depth the loop's reviews run at, picked by the attention level the first round classifies. */
  depth: reviewDepthSchema.default(DEFAULT_REVIEW_DEPTH),
  /** The first round's file scores; null before it, or when classifying failed. */
  classification: classificationSchema.nullable().default(null),
  /** Set when classifying ends, and recomputed when the loop stops at Needs you after a review. */
  attention: attentionSchema.nullable().default(null),
  /** The user's level, which wins over `attention` until the head moves. */
  levelOverride: levelOverrideSchema.nullable().default(null),
  /** Every level the user set, kept after the override is undone as a signal for tuning the classifier. */
  levelOverrides: z.array(levelOverrideSchema).default([]),
  /** The review running, or the one the current fix round answers. */
  reviewId: z.string().nullable().default(null),
  rounds: z.array(loopRoundSchema).default([]),
  /** The minor findings left open when the loop ended clean: after the minor rounds, or disputed and the dispute rejected. */
  openFindings: z.array(loopFindingSchema).default([]),
  /** The last review's rejected disputes, which the user upholds or closes. */
  disputes: z.array(loopDisputeSchema).default([]),
  /** Findings to fix that a serious dispute held back; they go to fix once every serious dispute is decided. */
  heldFindings: z.array(loopFindingSchema).default([]),
  /** A round's findings to fix, waiting on the findings gate for the user to approve or deselect them. */
  awaitingFindings: z.array(loopFindingSchema).default([]),
  /** Accepted by the auto-accept gate rather than by the user. */
  autoAccepted: z.boolean().default(false),
  /** Rounds the user started, which never count toward the cap. */
  humanRounds: z.number().int().default(0),
  /** The commit being checked or reviewed. */
  commit: z.string().nullable().default(null),
  checkCommand: checkCommandSchema.nullable().default(null),
  /** The evidence of the latest ready report. */
  evidence: evidenceSchema.nullable().default(null),
  checks: z.array(checksOutcomeSchema).default([]),
});
export type LoopState = z.infer<typeof loopStateSchema>;

/** The level the user set, else the one the loop computed. */
export function effectiveLevel(state: LoopState): AttentionLevel | null {
  return state.levelOverride?.level ?? state.attention?.level ?? null;
}

export const INITIAL_LOOP_STATE: LoopState = loopStateSchema.parse({});

/** Stored state, or the initial one when there is none or it doesn't parse. */
export function parseLoopState(raw: string | null): LoopState {
  if (raw === null) return INITIAL_LOOP_STATE;
  try {
    const parsed = loopStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : INITIAL_LOOP_STATE;
  } catch {
    return INITIAL_LOOP_STATE;
  }
}

const OPEN_MINORS_SHOWN = 3;

/** The open minor findings by id and title, the first three and then how many more. */
export function openMinorsList(findings: LoopFinding[]): string {
  const shown = findings.slice(0, OPEN_MINORS_SHOWN).map((finding) => `${finding.id} ${finding.title}`);
  const more = findings.length - shown.length;
  return more === 0 ? shown.join(", ") : `${shown.join(", ")}, +${more} more`;
}

/** The chip a monitored card shows on the board: the loop's phase, or why it needs you. */
export function phaseChip(loop: LoopState): { label: string; tone: "neutral" | "accent" | "warning" | "danger" | "success"; title: string } | null {
  if (!loop.monitored) return null;
  const commit = loop.commit === null ? "" : ` ${loop.commit.slice(0, 7)}`;
  switch (loop.phase) {
    case "checking":
      return { label: "checks", tone: "accent", title: `Re-running \`${loop.checkCommand?.command ?? "the checks"}\` at${commit}` };
    case "reviewing": {
      const recheck = loop.round >= LOOP_ROUND_CAP;
      return {
        label: `review r${recheck ? loop.round : loop.round + 1}`,
        tone: "accent",
        title: recheck ? `Re-reviewing the last round's fixes at${commit}` : `Reviewing${commit} at ${loop.depth} depth`,
      };
    }
    case "classifying":
      return { label: "classifying", tone: "accent", title: `Scoring the risk of each file changed at${commit}, which picks the review's depth` };
    case "fixing":
      if (fixingRound(loop)?.owner === "user") return { label: "fixing · yours", tone: "accent", title: "The card's thread is fixing the findings you sent back; this round doesn't count toward the cap" };
      return { label: `fixing r${loop.round}`, tone: "accent", title: `The card's thread is fixing round ${loop.round}'s findings` };
    case "needs-you":
      if (loop.reason === "clean" || loop.reason === null) {
        const minors = loop.openFindings.length === 0 ? "" : `; ${loop.openFindings.length} minor finding${loop.openFindings.length === 1 ? "" : "s"} left open: ${openMinorsList(loop.openFindings)}`;
        const effective = effectiveLevel(loop);
        const level = effective === null ? "" : ` · ${ATTENTION_LEVEL_LABEL[effective]}`;
        const why = loop.levelOverride === null ? (loop.attention?.reasons ?? []) : [`you set it: ${loop.levelOverride.reason}`];
        const reasons = effective === null || why.length === 0 ? "" : `. ${ATTENTION_LEVEL_LABEL[effective]}: ${why.join("; ")}`;
        return { label: `ready${level}`, tone: "success", title: `Checked and reviewed clean at${commit}${minors}; needs you${reasons}` };
      }
      if (loop.reason === "loop-error") return { label: "stuck · loop error", tone: "danger", title: `Needs you: ${loop.failure ?? "a checks or review thread failed twice"}; open it from the card` };
      if (loop.reason === "findings") {
        return { label: `approve r${loop.round + 1}`, tone: "warning", title: `Needs you: approve or deselect the ${loop.awaitingFindings.length} finding${loop.awaitingFindings.length === 1 ? "" : "s"} of the next round before the fix prompt goes out` };
      }
      return { label: `stuck · ${NEEDS_YOU_REASON_LABEL[loop.reason]}`, tone: "danger", title: `Needs you: ${NEEDS_YOU_REASON_LABEL[loop.reason]}` };
    case "paused":
      return { label: "stuck · question", tone: "warning", title: "The card's thread is waiting on you" };
    case "planning":
      return loop.proposedPlan === null
        ? { label: "planning", tone: "neutral", title: "Monitored with the plan gate: the card's thread proposes a plan before building" }
        : { label: "approve plan", tone: "warning", title: "Needs you: approve or edit the plan the card's thread proposed" };
    case "accepted":
    case "landed": {
      const minors = loop.openFindings.length === 0 ? "" : `; minor findings left open: ${loop.openFindings.map((finding) => `${finding.id} ${finding.title}`).join(", ")}`;
      return { label: loop.phase === "accepted" && loop.autoAccepted ? "auto-accepted" : loop.phase, tone: "success", title: `Monitored; ${loop.autoAccepted ? "auto-accepted at Glance" : "accepted"}${loop.phase === "landed" ? " and landed" : ""}${minors}` };
    }
    case "idle":
    case "building":
      return { label: "building", tone: "neutral", title: "Monitored: the board checks the work when the card's thread reports it ready" };
    default:
      return { label: loop.phase, tone: "accent", title: `Monitored: ${loop.phase}` };
  }
}
