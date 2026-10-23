import { locationLabel } from "../../shared/finding-location";
import type { FindingAnswer } from "../../shared/loop";
import { closedFindingIds, findingEditsSchema, selectionSchema, type Finding, type FindingEdit, type FindingSeverity, type Review, type ReviewReport, type ReviewScores, type ReviewSummary, type SeverityCounts } from "../../shared/review";

/**
 * Pre-selection for the apply round. Never a pre-existing finding, which is not this change's to fix. A triaged finding
 * is selected when triage says apply, whatever its severity. Without triage (older reports, unverified findings):
 * critical always; otherwise both scores must clear 3 so low-value or scope-expanding fixes stay unticked, and unscored
 * reports fall back to severity.
 */
export function defaultSelected(finding: Finding): boolean {
  if (finding.preExisting) return false;
  if (finding.triage !== null) return finding.triage.decision === "apply";
  if (finding.severity === "critical") return true;
  if (finding.importance !== null && finding.scopeFit !== null) {
    return finding.importance >= 3 && finding.scopeFit >= 3;
  }
  return finding.severity === "important";
}

/** Counts and scores say what the change itself has wrong, so they leave out what was already there. */
function introduced(report: ReviewReport): Finding[] {
  return report.findings.filter((finding) => !finding.preExisting);
}

export function rollupScores(report: ReviewReport | null): ReviewScores | null {
  if (report === null) return null;
  const scored = introduced(report).filter(
    (finding): finding is Finding & { importance: number; scopeFit: number } =>
      finding.importance !== null && finding.scopeFit !== null,
  );
  if (scored.length === 0) return null;
  const mean = (values: number[]) => Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
  return {
    maxImportance: Math.max(...scored.map((finding) => finding.importance)),
    meanScopeFit: mean(scored.map((finding) => finding.scopeFit)),
    meanImportance: mean(scored.map((finding) => finding.importance)),
    scored: scored.length,
  };
}

export function countSeverities(report: ReviewReport | null): SeverityCounts | null {
  if (report === null) return null;
  const counts: SeverityCounts = { critical: 0, important: 0, minor: 0 };
  for (const finding of introduced(report)) counts[finding.severity] += 1;
  return counts;
}

export function parseSelection(raw: string | null): Record<string, boolean> {
  try {
    const parsed = selectionSchema.safeParse(JSON.parse(raw ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function effectiveSelection(report: ReviewReport | null, overrides: Record<string, boolean>): Record<string, boolean> {
  if (report === null) return {};
  return Object.fromEntries(report.findings.map((finding) => [finding.id, finding.preExisting ? false : (overrides[finding.id] ?? defaultSelected(finding))]));
}

export function parseFindingEdits(raw: string | null): Record<string, FindingEdit> {
  try {
    const parsed = findingEditsSchema.safeParse(JSON.parse(raw ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function applyFindingEdits(report: ReviewReport | null, edits: Record<string, FindingEdit>): ReviewReport | null {
  if (report === null || Object.keys(edits).length === 0) return report;
  return {
    ...report,
    findings: report.findings.map((finding) => {
      const edit = edits[finding.id];
      if (edit === undefined) return finding;
      return {
        ...finding,
        title: edit.title ?? finding.title,
        description: edit.description ?? finding.description,
        fix: edit.fix === undefined ? finding.fix : edit.fix,
      };
    }),
  };
}

/** The findings the next apply round would get: the change's own, selected, and neither fixed by an earlier one nor resolved. */
export function pendingFindings(review: Review): Finding[] {
  const closed = closedFindingIds(review);
  return (review.report?.findings ?? []).filter((finding) => !finding.preExisting && review.selection[finding.id] === true && !closed.has(finding.id));
}

export function summarize(review: Review): ReviewSummary {
  const { body, report, selection: _selection, selectionOverrides: _overrides, findingEdits: _edits, appliedFindingIds: _applied, resolvedFindingIds: _resolved, ...rest } = review;
  const closed = closedFindingIds(review);
  const open = report === null ? null : { ...report, findings: report.findings.filter((finding) => !closed.has(finding.id)) };
  return {
    ...rest,
    hasBody: body !== null && body.trim() !== "",
    counts: countSeverities(open),
    appliedCount: report === null ? 0 : report.findings.length - open!.findings.length,
    selectedCount: report === null ? null : pendingFindings(review).length,
    scores: rollupScores(open),
  };
}

/**
 * The completed reviews whose findings still stand, oldest first: back from the newest up to and including the latest
 * full review or the latest re-review that already carried every open finding forward.
 */
export function standingReviews(reviews: Review[]): Review[] {
  const standing: Review[] = [];
  for (const review of reviews.filter((entry) => entry.status === "completed").sort((a, b) => b.createdAt - a.createdAt)) {
    standing.push(review);
    if (review.sinceCommitSha === null || review.report?.carriesForward === true) break;
  }
  return standing.reverse();
}

/**
 * The standing findings a re-review must re-check, keyed by the `<reviewId>/<findingId>` handle it carries them forward
 * under. `answers` are the card thread's answers to the last fix round, by handle.
 */
export function earlierFindings(
  standing: Review[],
  answers: Record<string, FindingAnswer> = {},
): Array<Omit<Finding, "id" | "carriedFrom"> & { handle: string; applyRound: string | null; answer: FindingAnswer | null }> {
  // A finding the reviewer resolved stays resolved, as a resolved GitHub thread does: it is not re-checked or carried.
  return standing.flatMap((review) =>
    (review.report?.findings ?? []).filter((finding) => !review.resolvedFindingIds.includes(finding.id)).map(({ id, carriedFrom: _carriedFrom, ...finding }) => {
      const handle = `${review.id}/${id}`;
      const answer = answers[handle] ?? null;
      const apply = review.apply;
      const applyRound = review.appliedFindingIds.includes(id)
        ? `an apply round committed a fix for it${apply?.pushedCommit == null ? "" : ` (the latest round's commit is ${apply.pushedCommit.slice(0, 7)})`}; verify it worked`
        : answer?.answer === "disputed"
          ? "the card's thread disputed it instead of fixing it; judge its answer"
          : apply === null || apply.completedAt === null
            ? null
            : "deliberately left out of the apply rounds";
      return { handle, ...finding, applyRound, answer };
    }),
  );
}

/** What the standing reviews said their checks don't cover, each entry once, for a re-review to re-check. */
export function earlierNotCovered(standing: Review[]): string[] {
  return [...new Set(standing.flatMap((review) => review.report?.notCovered ?? []))];
}

/** Findings as markdown, grouped under a heading per severity, worst first. */
export function findingLines(findings: Finding[]): string[] {
  const headings: Record<FindingSeverity, string> = {
    critical: "### Critical (Must Fix)",
    important: "### Important (Should Fix)",
    minor: "### Minor (Nice to Fix)",
  };
  const lines: string[] = [];
  for (const severity of ["critical", "important", "minor"] as const) {
    const group = findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    lines.push(headings[severity]);
    for (const finding of group) {
      const scores = [
        ...(finding.importance === null || finding.scopeFit === null ? [] : [`importance ${finding.importance}`, `scope ${finding.scopeFit}`]),
        ...(finding.confidence === null ? [] : [`confidence ${finding.confidence}`]),
      ];
      const where = finding.locations.map((location) => `\`${locationLabel(location)}\``).join(", ");
      const fix = finding.fix === null || finding.fix === "" ? "" : ` — ${finding.fix}`;
      const bugClass = finding.class === null || finding.class === "" ? "" : ` (class: ${finding.class})`;
      lines.push(
        `- **${finding.id}**${scores.length === 0 ? "" : ` (${scores.join(", ")})`} ${where} — ${finding.title}. ${finding.description}${fix}${bugClass} (flagged by: ${finding.flaggedBy.join(", ")})`,
      );
    }
    lines.push("");
  }
  return lines;
}

/** The review body trimmed to the selected findings, so the apply round never sees deselected ones. */
export function selectedFindingsBody(review: Review): { body: string; findingIds: string[] | null } {
  const { report } = review;
  if (report === null) return { body: review.body ?? "(the review body is empty; open the review thread for details)", findingIds: null };
  const selected = pendingFindings(review);
  const lines: string[] = ["## Change Summary", report.summary, "", "## Selected findings", ""];
  lines.push(
    `${selected.length} of ${report.findings.length} findings were selected on the Kanban board; the rest were deliberately left out or fixed by an earlier apply round. Apply only these.`,
    "A finding's locations are every instance of its bug class; fix them all.",
    "",
    ...findingLines(selected),
  );
  lines.push("```json review-findings", JSON.stringify({ ...report, findings: selected, filtered: [] }, null, 2), "```");
  return { body: lines.join("\n"), findingIds: selected.map((finding) => finding.id) };
}
