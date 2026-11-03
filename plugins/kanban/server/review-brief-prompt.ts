import type { Column, Ticket } from "../shared/board";
import { locationLabel } from "../shared/finding-location";
import type { Finding, Review } from "../shared/review";
import type { NarrativeReport } from "../shared/tour";

const MAX_FINDINGS = 15;
const MAX_FILES = 12;
const MAX_WATCH_OUTS = 6;
const DESCRIPTION_LIMIT = 1500;
const SEVERITY_ORDER: Record<Finding["severity"], number> = { critical: 0, important: 1, minor: 2 };

function openFindings(review: Review): Finding[] {
  if (review.report === null) return [];
  const closed = new Set([...review.appliedFindingIds, ...review.resolvedFindingIds]);
  return review.report.findings
    .filter((finding) => !closed.has(finding.id) && !finding.preExisting && finding.triage?.decision !== "drop")
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function findingLine(finding: Finding): string {
  const where = finding.locations.map(locationLabel).join(", ");
  const fix = finding.fix === null ? "" : ` Fix: ${finding.fix.split(/(?<=\.)\s/u)[0]}`;
  return `- [${finding.severity}] ${finding.id} ${finding.title} (${where}).${fix}`;
}

function reviewSection(ticket: Ticket, review: Review): string[] {
  const findings = openFindings(review);
  const at = review.commitSha === null ? "" : ` at ${review.commitSha.slice(0, 7)}`;
  const depth = review.depth === null ? "" : ` (${review.depth})`;
  const lines = [`## Code review${depth}${at}: ${findings.length} open finding${findings.length === 1 ? "" : "s"}`];
  if (review.report === null) lines.push("The review left no structured report; `bb kanban review-show " + ticket.id + "` prints what it wrote.");
  lines.push(...findings.slice(0, MAX_FINDINGS).map(findingLine));
  if (findings.length > MAX_FINDINGS) lines.push(`- and ${findings.length - MAX_FINDINGS} more: \`bb kanban review-show ${ticket.id}\``);
  const notCovered = review.report?.notCovered ?? [];
  if (notCovered.length > 0) lines.push("Not covered by the review:", ...notCovered.slice(0, MAX_WATCH_OUTS).map((entry) => `- ${entry}`));
  return lines;
}

function narrativeSection(report: NarrativeReport): string[] {
  const lines = ["## Narrative", report.summary.trim()];
  const files = report.readingOrder.filter((file) => file.role !== "mechanical").slice(0, MAX_FILES);
  if (files.length > 0) {
    lines.push("Reading order:");
    lines.push(...files.map((file) => `- ${file.path} (${file.role}${file.risk === null ? "" : `, risk ${file.risk}`})${file.note === "" ? "" : `: ${file.note}`}`));
  }
  if (report.watchOut.length > 0) lines.push("Watch out:", ...report.watchOut.slice(0, MAX_WATCH_OUTS).map((entry) => `- ${entry}`));
  return lines;
}

export interface ReviewRequestBrief {
  review: Review | null;
  narrative: NarrativeReport | null;
  /** The board's review ran and failed, so there is none to brief from. */
  reviewFailed: boolean;
}

/**
 * The first prompt of a review-request card's thread. The board has already reviewed the pull request (and narrated
 * it, when the source asked), so the thread doesn't review again: it turns what the board found into a brief for the
 * reviewer and then answers their questions. Without a review yet, it reads enough to answer and waits.
 */
export function reviewRequestPrompt(ticket: Ticket, columns: readonly Column[], brief: ReviewRequestBrief): string {
  if (ticket.pr === null) throw new Error("Not a PR card");
  const { repo, number, url } = ticket.pr;
  const head = [`You were asked to review pull request ${repo}#${number}: "${ticket.title}" (${url}).`, ""];
  const context: string[] = [];
  if (brief.review !== null) context.push(...reviewSection(ticket, brief.review), "");
  if (brief.narrative !== null) context.push(...narrativeSection(brief.narrative), "");
  const description = ticket.pr.body?.trim() ?? "";
  if (description !== "") context.push("## PR description", description.length > DESCRIPTION_LIMIT ? `${description.slice(0, DESCRIPTION_LIMIT)}…` : description, "");
  const open = ticket.comments?.open ?? 0;
  if (open > 0) context.push(`${open} comment${open === 1 ? "" : "s"} from others are open on the PR: \`bb kanban comments --ticket ${ticket.id}\` lists them.`, "");
  const task =
    brief.review === null
      ? [
          (brief.reviewFailed
            ? "The board's review of it failed (its thread is in the card's Threads menu; Retry on the card runs it again). "
            : "The board hasn't reviewed it yet (Review PR on the card runs the code-review skill). ") +
            "Read `gh pr view " +
            `${number} --repo ${repo}` +
            "` and enough of `gh pr diff " +
            `${number} --repo ${repo}` +
            "` to say in at most five lines what the change does and where its risk is, then stop and wait for questions. Don't run a review of your own unless asked.",
        ]
      : [
          "Write one message, the reviewer's brief, in under 25 lines: what to read first and why, in order; which findings matter most and which you'd let go, with a reason each; the questions worth putting to the author; and anything the narrative's watch-outs flag. Don't review the code again from scratch; read it (`gh pr diff " +
            `${number} --repo ${repo}` +
            "`, or check the PR out) only as far as the brief needs. Then stop and wait: the user will ask questions here.",
        ];
  return [...head, ...context, ...task, reviewRequestFooter(ticket, columns)].join("\n");
}

/**
 * A review completing while the card already has a thread: a re-review updates the brief, a first review (the thread
 * was started before the board's review finished) asks for the brief itself.
 */
export function reviewRequestUpdatePrompt(ticket: Ticket, review: Review, narrative: NarrativeReport | null): string {
  const first = review.sinceCommitSha === null;
  const resolved = review.report?.resolved ?? [];
  return [
    first ? "The board's review of this pull request is done." : `The board re-reviewed this pull request of the commits since ${review.sinceCommitSha!.slice(0, 7)}.`,
    "",
    ...reviewSection(ticket, review),
    ...(resolved.length === 0 ? [] : ["Resolved since the last review:", ...resolved.map((entry) => `- ${entry.id} ${entry.title}`)]),
    ...(narrative === null ? [] : ["", ...narrativeSection(narrative)]),
    "",
    first
      ? "Write the reviewer's brief in one short message: what to read first and why, which findings matter most and which you'd let go, and the questions worth putting to the author. Then wait."
      : "Update your brief in one short message: what changed, what to look at now, and which earlier points still stand. Then wait.",
  ].join("\n");
}

/** What every review-request thread is told about the card: the card moves when the user submits their review, not when the agent decides. */
export function reviewRequestFooter(ticket: Ticket, columns: readonly Column[]): string {
  const columnList = columns.map((column) => `\`${column.id}\` (${column.name})`).join(", ");
  return [
    "",
    `This thread is kanban ticket ${ticket.id}. Columns: ${columnList}.`,
    "Don't move the card: it moves when the user submits their review from the card's changes page.",
    "Do not post comments or reviews on GitHub unless the user explicitly asks.",
  ].join("\n");
}
