// A change's completed reviews as numbered rounds (r1, r2, …), and where the rest of its history sits against them:
// the commits that came after a round, the round that first reported a finding, and what a delta counts from. The
// strip, the commit picker and the findings all read this one numbering.
import type { DiffCommits, DiffDelta, Finding, Review } from "../types";
import { shortSha } from "./format";

export interface ReviewRound {
  /** 1 for the oldest completed review. */
  number: number;
  review: Review;
  /** The change's own findings the round reported first, not carried from an earlier round. */
  reported: number;
  /** Earlier findings the round found still open. */
  carried: number;
  /** Earlier findings the round found fixed. */
  resolved: number;
}

/** Whether two shas name the same commit, either possibly abbreviated (to 7 or more characters). */
export function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  if (a.length < 7 || b.length < 7) return a === b;
  return a.startsWith(b) || b.startsWith(a);
}

export function roundName(number: number): string {
  return `r${number}`;
}

/** The completed reviews, oldest first, numbered from 1. */
export function reviewRounds(reviews: readonly Review[]): ReviewRound[] {
  return reviews
    .filter((review) => review.status === "completed")
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((review, index) => {
      const own = (review.report?.findings ?? []).filter((finding) => finding.preExisting !== true);
      const carried = own.filter((finding) => (finding.carriedFrom ?? null) !== null).length;
      return { number: index + 1, review, reported: own.length - carried, carried, resolved: review.report?.resolved?.length ?? 0 };
    });
}

export function roundOf(rounds: readonly ReviewRound[], reviewId: string | null | undefined): ReviewRound | undefined {
  return reviewId == null ? undefined : rounds.find((round) => round.review.id === reviewId);
}

/** The review the host is running now, which will be the next round. */
export function runningReview(reviews: readonly Review[]): Review | null {
  return reviews.find((review) => review.status === "running") ?? null;
}

/** `<reviewId>/<findingId>` split at its last slash. */
function carriedRef(ref: string): { reviewId: string; findingId: string } {
  const at = ref.lastIndexOf("/");
  return { reviewId: ref.slice(0, at), findingId: ref.slice(at + 1) };
}

/**
 * The earlier round that first reported a carried finding, back along its carried-from links; null when the review it
 * was carried from is not a round (failed, or gone).
 */
export function originRound(rounds: readonly ReviewRound[], reviewId: string, finding: Finding): number | null {
  let origin: ReviewRound | null = null;
  let current: Finding | undefined = finding;
  // Each link points at an earlier round, so the walk ends; the bound guards a malformed chain.
  for (let step = 0; current !== undefined && (current.carriedFrom ?? null) !== null && step < rounds.length; step++) {
    const ref = carriedRef(current.carriedFrom!);
    const earlier = roundOf(rounds, ref.reviewId);
    if (earlier === undefined || earlier.review.id === reviewId) break;
    origin = earlier;
    current = earlier.review.report?.findings.find((entry) => entry.id === ref.findingId);
  }
  return origin?.number ?? null;
}

/** How many of the diff's commits came after `sha` (all of them from its base); null when it is neither. */
export function commitsAfter(commits: DiffCommits | null, sha: string | null | undefined): number | null {
  if (commits === null || sha == null) return null;
  if (sameSha(commits.base, sha)) return commits.commits.length;
  const index = commits.commits.findIndex((commit) => sameSha(commit.sha, sha));
  return index === -1 ? null : commits.commits.length - index - 1;
}

/** The rounds that read up to `sha`. */
export function roundsAt(rounds: readonly ReviewRound[], sha: string): ReviewRound[] {
  return rounds.filter((round) => sameSha(round.review.commitSha, sha));
}

/**
 * Index of the first commit no round has read: the commits from it on are new. Null when no round's commit is in the
 * list (no reviews, or reviews of commits since rewritten).
 */
export function firstUnreviewedCommit(commits: DiffCommits, rounds: readonly ReviewRound[]): number | null {
  let first: number | null = null;
  for (const round of rounds) {
    const after = commitsAfter(commits, round.review.commitSha);
    if (after !== null) first = Math.max(first ?? 0, commits.commits.length - after);
  }
  return first;
}

/** What a delta counts from, as the strip and the summary bar name it: "r2", "your last GitHub review", "abc1234". */
export function sinceName(delta: DiffDelta, rounds: readonly ReviewRound[]): string {
  switch (delta.since?.kind) {
    case "review": {
      const round = roundOf(rounds, delta.since.reviewId);
      return round === undefined ? "the last review" : roundName(round.number);
    }
    case "githubReview":
      return "your last GitHub review";
    case "commit":
      return shortSha(delta.fromSha);
    default:
      return "you last looked";
  }
}
