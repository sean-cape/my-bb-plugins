import type { DiffDelta, Finding, FindingSeverity, Review } from "../../types";
import { rangesOverlap } from "../ranges";
import { originRound, reviewRounds, roundOf, sameSha } from "../rounds";

export const SEVERITY_LABEL: Record<FindingSeverity, string> = { critical: "Critical", important: "Important", minor: "Minor" };
export const SEVERITY_DOT: Record<FindingSeverity, string> = { critical: "bg-red-500", important: "bg-amber-500", minor: "bg-slate-400" };

/** `a.ts`, `a.ts:12` or `a.ts:12-18`, as the review's own report writes a location. */
export function findingLocationLabel(location: Finding["locations"][number]): string {
  if (location.startLine === null) return location.file;
  return location.endLine === null || location.endLine === location.startLine ? `${location.file}:${location.startLine}` : `${location.file}:${location.startLine}-${location.endLine}`;
}

/** A review finding placed in the diff, with the apply-round selection it carries. */
export interface InlineFinding {
  reviewId: string;
  finding: Finding;
  selected: boolean;
  overridden: boolean;
  edited: boolean;
  /** The round that first reported it, when it is not the only round and the finding was not carried into it. */
  newIn: number | null;
  /** Still open from an earlier review; the earlier finding's id. */
  carriedFrom: string | null;
  /** For a carried finding, the round that first reported it. */
  openSince: number | null;
  /** Its lines changed after the review that reported it read the code, so the lines it names may have moved. */
  touched: boolean;
}

/** A finding at one of its locations: a new-side line, or null for the whole file. */
export interface PlacedFinding {
  item: InlineFinding;
  line: number | null;
}

/** One finding is placed once per location, so the line is part of its identity. */
export function findingAnchorId(entry: PlacedFinding): string {
  return `${entry.item.reviewId}:${entry.item.finding.id}:${entry.line}`;
}

/**
 * The reviews whose findings still stand, oldest first: back from the newest up to and including the latest full review
 * or the latest re-review that carried every open finding forward. Re-reviews from before carry-over existed stack.
 */
export function activeReviews(reviews: Review[]): Review[] {
  const active: Review[] = [];
  for (const review of reviews.filter((entry) => entry.status === "completed").sort((a, b) => b.createdAt - a.createdAt)) {
    active.push(review);
    if (review.sinceCommitSha === null || review.report?.carriesForward === true) break;
  }
  return active.filter((review) => review.report !== null).reverse();
}

/**
 * The active reviews' open findings by file, once per location, tagged with the round that reported them. `delta`
 * marks the ones whose lines changed after their review: it counts from the review's commit, or, from a host that
 * records no commit, from wherever the host's delta starts. Findings an apply round fixed are left out.
 */
export function inlineFindingsByPath(reviews: Review[], delta: DiffDelta | null): Map<string, PlacedFinding[]> {
  const byPath = new Map<string, PlacedFinding[]>();
  const rounds = reviewRounds(reviews);
  const changedRanges = new Map((delta?.files ?? []).map((file) => [file.path, file.ranges]));
  for (const review of activeReviews(reviews)) {
    if (review.report === null) continue;
    const applied = new Set(review.appliedFindingIds ?? []);
    const round = roundOf(rounds, review.id)?.number ?? null;
    const deltaFromReview = delta !== null && (review.commitSha == null || sameSha(review.commitSha, delta.fromSha));
    for (const finding of review.report.findings) {
      if (applied.has(finding.id) || finding.preExisting === true) continue;
      const touched =
        deltaFromReview &&
        finding.locations.some((location) => {
          const ranges = changedRanges.get(location.file);
          return ranges !== undefined && location.startLine !== null && rangesOverlap(location.startLine, location.endLine ?? location.startLine, ranges);
        });
      const carried = (finding.carriedFrom ?? null) !== null;
      const item: InlineFinding = {
        reviewId: review.id,
        finding,
        selected: review.selection[finding.id] ?? false,
        overridden: finding.id in review.selectionOverrides,
        edited: finding.id in review.findingEdits,
        newIn: !carried && rounds.length > 1 ? round : null,
        carriedFrom: finding.carriedFrom?.split("/").pop() ?? null,
        openSince: carried ? originRound(rounds, review.id, finding) : null,
        touched,
      };
      for (const location of finding.locations) {
        const list = byPath.get(location.file) ?? [];
        list.push({ item, line: location.startLine });
        byPath.set(location.file, list);
      }
    }
  }
  return byPath;
}

/** A finding listed beside the diff rather than in it. */
export interface ListedFinding {
  reviewId: string;
  finding: Finding;
}

/** The active reviews' open pre-existing findings, which are not the change's, and the findings their verifiers filtered out. */
export function findingsOutsideDiff(reviews: Review[]): { preExisting: ListedFinding[]; filtered: ListedFinding[] } {
  const preExisting: ListedFinding[] = [];
  const filtered: ListedFinding[] = [];
  for (const review of activeReviews(reviews)) {
    const applied = new Set(review.appliedFindingIds ?? []);
    for (const finding of review.report?.findings ?? []) if (finding.preExisting === true && !applied.has(finding.id)) preExisting.push({ reviewId: review.id, finding });
    for (const finding of review.report?.filtered ?? []) filtered.push({ reviewId: review.id, finding });
  }
  return { preExisting, filtered };
}

/** The least severe finding shown in the diff, or none at all. */
export type FindingFilter = "all" | "important" | "critical" | "off";

export const DEFAULT_FINDING_FILTER: FindingFilter = "important";

/** `F` steps through these in order, from showing the most to the least. */
const FINDING_FILTERS: readonly FindingFilter[] = ["all", "important", "critical", "off"];

export const FINDING_FILTER_LABEL: Record<FindingFilter, string> = { all: "all", important: "important+", critical: "critical", off: "off" };

const SEVERITY_RANK: Record<FindingSeverity, number> = { minor: 1, important: 2, critical: 3 };
const FILTER_MIN_RANK: Record<FindingFilter, number> = { all: 1, important: 2, critical: 3, off: Number.POSITIVE_INFINITY };

export function nextFindingFilter(filter: FindingFilter): FindingFilter {
  return FINDING_FILTERS[(FINDING_FILTERS.indexOf(filter) + 1) % FINDING_FILTERS.length]!;
}

/** The stored filter, or the boolean it replaced: findings someone had hidden stay hidden. */
export function parseFindingFilter(stored: string | null, legacyShowFindings: string | null): FindingFilter {
  if (stored !== null && (FINDING_FILTERS as readonly string[]).includes(stored)) return stored as FindingFilter;
  return legacyShowFindings === "false" ? "off" : DEFAULT_FINDING_FILTER;
}

export function passesFindingFilter(severity: FindingSeverity, filter: FindingFilter): boolean {
  return SEVERITY_RANK[severity] >= FILTER_MIN_RANK[filter];
}

/** The placements whose finding passes the filter; files left with none drop out. */
export function filterFindings(byPath: ReadonlyMap<string, readonly PlacedFinding[]>, filter: FindingFilter): Map<string, PlacedFinding[]> {
  const filtered = new Map<string, PlacedFinding[]>();
  for (const [path, list] of byPath) {
    const kept = list.filter((entry) => passesFindingFilter(entry.item.finding.severity, filter));
    if (kept.length > 0) filtered.set(path, kept);
  }
  return filtered;
}

/** Findings placed at several locations count once. */
export function distinctFindings(placed: Iterable<PlacedFinding>): InlineFinding[] {
  const byId = new Map<string, InlineFinding>();
  for (const entry of placed) byId.set(`${entry.item.reviewId}:${entry.item.finding.id}`, entry.item);
  return [...byId.values()];
}
