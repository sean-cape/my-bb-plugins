import type { DiffDelta, Finding, FindingSeverity, Review } from "../../types";
import { rangesOverlap } from "../ranges";
import { mapLines } from "../../line-map";
import { sameSha } from "../rounds";

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
  /** As it stands at the diff's head: its lines (and its suggestion's) moved to where they are now. */
  finding: Finding;
  selected: boolean;
  overridden: boolean;
  edited: boolean;
  /** Still open from an earlier review; the earlier finding's id. */
  carriedFrom: string | null;
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

/** A finding listed beside the diff rather than in it. */
export interface ListedFinding {
  reviewId: string;
  finding: Finding;
}

/**
 * Where a finding's lines are at the diff's head, the way GitHub keeps a comment on its line across pushes. `delta` is
 * what changed since some commit: a finding its review read at that commit moves with the lines added and removed
 * above it, and is null (outdated) when every line it names changed. From any other commit it stays where it was.
 */
export function findingAtHead(review: Review, finding: Finding, delta: DiffDelta | null): Finding | null {
  if (delta === null || review.commitSha == null || !sameSha(review.commitSha, delta.fromSha)) return finding;
  const files = new Map(delta.files.map((file) => [file.path, file]));
  const move = (file: string, start: number, end: number): { start: number; end: number } | null => {
    const changed = files.get(file);
    if (changed === undefined) return { start, end };
    return changed.blocks == null ? null : mapLines(changed.blocks, start, end);
  };
  const locations = finding.locations.flatMap((location) => {
    if (location.startLine === null) return [location];
    const moved = move(location.file, location.startLine, location.endLine ?? location.startLine);
    return moved === null ? [] : [{ file: location.file, startLine: moved.start, endLine: location.endLine === null ? null : moved.end }];
  });
  if (locations.length === 0 && finding.locations.length > 0) return null;
  const suggestion = finding.suggestion == null ? finding.suggestion : move(finding.suggestion.file, finding.suggestion.startLine, finding.suggestion.endLine);
  return {
    ...finding,
    locations,
    suggestion: finding.suggestion == null || suggestion == null ? null : { ...finding.suggestion, startLine: suggestion.start, endLine: suggestion.end },
  };
}

/**
 * The active reviews' open findings of the change's own, as GitHub shows review threads: inline at their lines at the
 * head while those lines stand (`inline`, by file, once per location), `outdated` once the code under them changed
 * after their review read it. Findings an apply round fixed and ones the reviewer resolved are left out.
 */
export function standingFindings(reviews: Review[], delta: DiffDelta | null): { inline: Map<string, PlacedFinding[]>; outdated: ListedFinding[] } {
  const inline = new Map<string, PlacedFinding[]>();
  const outdated: ListedFinding[] = [];
  for (const review of activeReviews(reviews)) {
    if (review.report === null) continue;
    const closed = new Set([...(review.appliedFindingIds ?? []), ...(review.resolvedFindingIds ?? [])]);
    for (const reported of review.report.findings) {
      if (closed.has(reported.id) || reported.preExisting === true) continue;
      const finding = findingAtHead(review, reported, delta);
      if (finding === null) {
        outdated.push({ reviewId: review.id, finding: reported });
        continue;
      }
      const item: InlineFinding = {
        reviewId: review.id,
        finding,
        selected: review.selection[finding.id] ?? false,
        overridden: finding.id in review.selectionOverrides,
        edited: finding.id in review.findingEdits,
        carriedFrom: finding.carriedFrom?.split("/").pop() ?? null,
      };
      for (const location of finding.locations) {
        const list = inline.get(location.file) ?? [];
        list.push({ item, line: location.startLine });
        inline.set(location.file, list);
      }
    }
  }
  return { inline, outdated };
}

/** The open findings inline in the diff, by file; see `standingFindings`. */
export function inlineFindingsByPath(reviews: Review[], delta: DiffDelta | null): Map<string, PlacedFinding[]> {
  return standingFindings(reviews, delta).inline;
}

/** How a finding came to be resolved: by the reviewer, by an apply round (until a re-review checks it), or a re-review found it fixed. */
export type ResolvedBy = "you" | "applied" | "fixed";

/** A finding no longer open, with what closed it; `finding` is null where only its title is known. */
export interface ResolvedFinding {
  key: string;
  reviewId: string;
  findingId: string;
  title: string;
  finding: Finding | null;
  by: ResolvedBy;
  /** The re-review's note on how it was fixed. */
  note: string | null;
  /** The commit the re-review that found it fixed read. */
  at: string | null;
}

/**
 * Every finding of the change's own no longer open, newest first: the ones the reviewer resolved (in any review, since
 * re-reviews leave them be), the ones the active reviews' apply rounds fixed (a re-review then checks them, and lists
 * them as fixed or carries them again), and the ones each re-review found fixed.
 */
export function resolvedFindings(reviews: Review[]): ResolvedFinding[] {
  const completed = reviews.filter((review) => review.status === "completed" && review.report !== null).sort((a, b) => b.createdAt - a.createdAt);
  const active = new Set(activeReviews(reviews).map((review) => review.id));
  const byHandle = new Map<string, Finding>(completed.flatMap((review) => review.report!.findings.map((finding) => [`${review.id}/${finding.id}`, finding] as const)));
  const resolved: ResolvedFinding[] = [];
  const add = (review: Review, finding: Finding, by: ResolvedBy) =>
    resolved.push({ key: `${by}:${review.id}/${finding.id}`, reviewId: review.id, findingId: finding.id, title: finding.title, finding, by, note: null, at: null });
  for (const review of completed) {
    const own = review.report!.findings.filter((finding) => finding.preExisting !== true);
    const mine = new Set(review.resolvedFindingIds ?? []);
    const applied = new Set(review.appliedFindingIds ?? []);
    for (const finding of own) if (mine.has(finding.id)) add(review, finding, "you");
    if (active.has(review.id)) for (const finding of own) if (applied.has(finding.id) && !mine.has(finding.id)) add(review, finding, "applied");
    for (const entry of review.report!.resolved ?? []) {
      const at = entry.id.lastIndexOf("/");
      const earlier = byHandle.get(entry.id) ?? null;
      resolved.push({
        key: `fixed:${review.id}:${entry.id}`,
        reviewId: entry.id.slice(0, at),
        findingId: entry.id.slice(at + 1),
        title: entry.title || earlier?.title || entry.id.slice(at + 1),
        finding: earlier,
        by: "fixed",
        note: entry.note || null,
        at: review.commitSha ?? null,
      });
    }
  }
  return resolved;
}

/** The active reviews' open pre-existing findings, which are not the change's, and the findings their verifiers filtered out. */
export function findingsOutsideDiff(reviews: Review[]): { preExisting: ListedFinding[]; filtered: ListedFinding[] } {
  const preExisting: ListedFinding[] = [];
  const filtered: ListedFinding[] = [];
  for (const review of activeReviews(reviews)) {
    const closed = new Set([...(review.appliedFindingIds ?? []), ...(review.resolvedFindingIds ?? [])]);
    for (const finding of review.report?.findings ?? []) if (finding.preExisting === true && !closed.has(finding.id)) preExisting.push({ reviewId: review.id, finding });
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
