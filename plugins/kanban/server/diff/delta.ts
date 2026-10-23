// What changed since a point in a card's history, for the changes view to tell new code from code already looked at:
// since the card's last completed review by default, else the reviewer's last GitHub review, else the head they last
// marked files viewed on.
import { changeBlocks } from "bb-diff-view/line-map";
import { COMMIT_SHA_PATTERN, WORKTREE_SHA } from "bb-diff-view/types";
import type { Ticket } from "../../shared/board";
import type { DiffDelta } from "../../shared/diff";
import type { KanbanContext } from "../context";
import { githubPages, resolveToken, type GithubReview } from "../github";
import type { Changes } from "./changes";
import { lastGithubReviewSha } from "./commits";
import { newLineRangesFromPatch, type ViewedMarks } from "./viewed";

type Since = DiffDelta["since"];

export function createDiffDelta(ctx: KanbanContext, { changes, viewed }: { changes: Changes; viewed: ViewedMarks }) {
  const { settings, stmts } = ctx;

  /** The completed reviews of the chain this diff is (a PR card's PR reviews, else its local ones), newest first. */
  function reviewsOfDiff(ticket: Ticket) {
    return stmts.reviewsForTicketOfKind.all(ticket.id, ticket.pr !== null ? "pr" : "local").filter((row) => row.status === "completed" && row.commit_sha !== null);
  }

  async function githubReviewSha(ticket: Ticket): Promise<string | null> {
    const login = ctx.sync.login;
    if (ticket.pr === null || login === null) return null;
    const auth = await resolveToken(settings);
    if (auth === null) return null;
    const reviews = await githubPages<GithubReview>(`/repos/${ticket.pr.repo}/pulls/${ticket.pr.number}/reviews`, auth.token).catch(() => null);
    return reviews === null ? null : lastGithubReviewSha(reviews, login);
  }

  /** Where "new" counts from when the view names no point of its own. */
  async function defaultSince(ticket: Ticket, head: string | null): Promise<{ sha: string; since: Since } | null> {
    const review = reviewsOfDiff(ticket)[0];
    if (review !== undefined) return { sha: review.commit_sha!, since: { kind: "review", reviewId: review.id } };
    const github = await githubReviewSha(ticket);
    if (github !== null) return { sha: github, since: { kind: "githubReview", reviewId: null } };
    const looked = head === null ? null : viewed.lastViewedHead(ticket, head);
    return looked === null ? null : { sha: looked, since: { kind: "viewed", reviewId: null } };
  }

  function namedSince(ticket: Ticket, sha: string): Since {
    const review = reviewsOfDiff(ticket).find((row) => row.commit_sha === sha || row.commit_sha!.startsWith(sha));
    return review === undefined ? { kind: "commit", reviewId: null } : { kind: "review", reviewId: review.id };
  }

  /**
   * The files and new-side lines that changed from `fromSha` (else the default point) to the diff's new side: a PR's
   * head, or a local card's working tree. Null when there is no point to count from, it is the head, or the changes
   * can't be read from here.
   */
  async function diffDelta(ticket: Ticket, fromSha: string | null): Promise<DiffDelta | null> {
    if (ticket.pr === null && ticket.threadId === null) return null;
    const head = ticket.pr === null ? WORKTREE_SHA : (await changes.ticketDiff(ticket, false)).headSha;
    if (head === null) return null;
    const point = fromSha === null ? await defaultSince(ticket, head) : { sha: fromSha, since: namedSince(ticket, fromSha) };
    if (point === null || !COMMIT_SHA_PATTERN.test(point.sha) || head === point.sha || head.startsWith(point.sha)) return null;
    let diff;
    try {
      diff = await changes.ticketDiff(ticket, false, { from: point.sha, to: head });
    } catch (error) {
      ctx.bb.log.warn(`could not read the changes since ${point.sha} on ${ticket.id}: ${String(error)}`);
      return null;
    }
    if (diff.message !== null) return null;
    return {
      fromSha: point.sha,
      toSha: head,
      since: point.since,
      files: diff.files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ranges: file.patch === null ? [] : newLineRangesFromPatch(file.patch),
        blocks: file.patch === null ? null : changeBlocks(file.patch),
      })),
    };
  }

  return { diffDelta };
}

export type DiffDeltas = ReturnType<typeof createDiffDelta>;
