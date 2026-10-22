import { describe, expect, it } from "vitest";
import type { Ticket } from "../shared/board";
import { reviewReportSchema, type Review } from "../shared/review";
import { parseReviewReport } from "./agent-output";
import { applyFindingEdits, earlierFindings } from "./reviews/findings";
import { reviewPrompt } from "./reviews/prompts";
import { localSubject } from "./reviews/subject";

const SUGGESTION = { file: "src/a.ts", startLine: 3, endLine: 4, replacement: "const a = 1;\nconst b = 2;" };

function finding(overrides: Record<string, unknown> = {}) {
  return { id: "F1", severity: "important", title: "Off by one", description: "The loop stops early.", fix: "Use <=", locations: [{ file: "src/a.ts", startLine: 3, endLine: 4 }], ...overrides };
}

function body(version: number, findings: unknown[]): string {
  return ["## Review Findings", "", "```json review-findings", JSON.stringify({ version, summary: "s", findings }), "```"].join("\n");
}

function storedReview(overrides: Partial<Review> = {}): Review {
  return {
    id: "r1",
    ticketId: "t1",
    threadId: "thr_review",
    subjectKind: "local",
    status: "completed",
    commitSha: "fedcba9876543210fedcba9876543210fedcba98",
    baseRef: "main",
    headRef: null,
    sinceCommitSha: null,
    depth: "standard",
    body: null,
    report: reviewReportSchema.parse({ version: 6, findings: [finding({ suggestion: SUGGESTION })] }),
    selection: {},
    selectionOverrides: {},
    findingEdits: {},
    appliedFindingIds: [],
    createdAt: 0,
    completedAt: 0,
    apply: null,
    ...overrides,
  };
}

describe("finding suggestions in review reports", () => {
  it("reads a finding without a suggestion field, as reports before version 6 have, as having none", () => {
    const report = parseReviewReport(body(5, [finding()]));
    expect(report?.findings[0]?.suggestion).toBeNull();
  });

  it("keeps a version 6 finding's suggestion, a deletion's empty replacement included", () => {
    expect(parseReviewReport(body(6, [finding({ suggestion: SUGGESTION })]))?.findings[0]?.suggestion).toEqual(SUGGESTION);
    const deletion = { ...SUGGESTION, replacement: "" };
    expect(parseReviewReport(body(6, [finding({ suggestion: deletion })]))?.findings[0]?.suggestion).toEqual(deletion);
    expect(parseReviewReport(body(6, [finding({ suggestion: null })]))?.findings[0]?.suggestion).toBeNull();
  });

  it("drops a malformed suggestion or one outside the finding's files, keeping the report", () => {
    const bad = [
      { ...SUGGESTION, file: "src/other.ts" },
      { ...SUGGESTION, startLine: 1.5 },
      { ...SUGGESTION, startLine: 0 },
      { ...SUGGESTION, startLine: 5, endLine: 4 },
      { file: "src/a.ts", startLine: 3 },
      "replace line 3",
    ];
    for (const suggestion of bad) {
      const report = parseReviewReport(body(6, [finding({ suggestion })]));
      expect(report?.findings).toHaveLength(1);
      expect(report?.findings[0]?.suggestion).toBeNull();
    }
  });

  it("keeps the suggestion through a reworded finding and into a re-review's earlier findings", () => {
    const review = storedReview();
    const edited = applyFindingEdits(review.report, { F1: { title: "Reworded" } });
    expect(edited?.findings[0]).toMatchObject({ title: "Reworded", suggestion: SUGGESTION });
    expect(earlierFindings([review])[0]).toMatchObject({ handle: "r1/F1", suggestion: SUGGESTION });
  });

  it("tells a re-review to carry the suggestion forward, renumbered or nulled", () => {
    const review = storedReview();
    const ticket = { id: "t1", title: "Cache lookups", description: "", pr: null, loop: null } as unknown as Ticket;
    const prompt = reviewPrompt(localSubject("0123456789abcdef0123456789abcdef01234567", "main"), ticket, review, [review], { plan: null, branch: null }, "standard");
    expect(prompt).toContain('keeps the `"suggestion"` field');
    expect(prompt).toContain('"suggestion": null');
    expect(prompt).toContain('"replacement": "const a = 1;\\nconst b = 2;"');
  });
});
