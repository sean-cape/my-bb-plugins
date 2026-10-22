import type { Ticket } from "../../shared/board";
import type { ReviewEvent } from "../../shared/comments";
import type { KanbanContext } from "../context";
import type { BoardStore } from "../board";
import type { DiffCommentRow, PendingReviewRow, TicketRow } from "../db/rows";
import type { Changes } from "../diff/changes";
import { GithubHttpError, NO_GITHUB_TOKEN, github, githubGraphql, githubPages, githubPost, githubRequest, resolveToken, reviewThreads, type GithubReview, type GithubReviewComment } from "../github";
import { createKeyedQueue, errorMessage, shortId } from "../util";
import { locationLabel } from "bb-diff-view/line-range";

const REVIEW_COMMENT = "review-comment:";

function reviewCommentId(githubId: string | null): number | null {
  return githubId !== null && githubId.startsWith(REVIEW_COMMENT) ? Number(githubId.slice(REVIEW_COMMENT.length)) : null;
}

function sideOf(side: string | null): "LEFT" | "RIGHT" {
  return side === "LEFT" ? "LEFT" : "RIGHT";
}

/** `- \`a.go:12\` — text` lines for drafts that could not go up inline, so the review body still carries them. */
export function summarizeDrafts(drafts: DiffCommentRow[]): string {
  return drafts
    .map((draft) => `- \`${locationLabel(draft.path, { line: draft.line, side: sideOf(draft.side), startLine: draft.start_line, startSide: draft.start_line === null ? null : sideOf(draft.start_side) })}\` — ${draft.body.trim()}`)
    .join("\n");
}

/** The review's body: the user's summary over whatever had to go as bullets, whichever of the two there are. */
export function reviewBody(...parts: string[]): string {
  return parts.filter((part) => part !== "").join("\n\n");
}

export interface PendingReviewState {
  body: string;
  /** The pending review on GitHub, once one exists. */
  url: string | null;
  /** Drafts that already sit in that review. */
  staged: number;
}

/**
 * The user's pending review on the PR, kept the same on both sides: a GitHub draft left here goes into the pending
 * review on GitHub as soon as it is saved, and comments pending on GitHub come onto the board as drafts, so the
 * review can be half written in each place and submitted from either. GitHub owns a mirrored comment: a pull takes
 * its text and drops it when GitHub no longer has it. Every write for one card goes through one queue, since GitHub
 * allows one pending review per user and two adds must not both create one.
 */
export function createPendingReview(ctx: KanbanContext, { board, changes }: { board: BoardStore; changes: Changes }) {
  const { bb, settings, stmts, db, sync, publish } = ctx;
  const { ticketDiff } = changes;

  // A submit waits until the card's queued mirroring is settled, so it sees every draft that could be staged.
  const { enqueue, settled } = createKeyedQueue();

  async function enabled(): Promise<boolean> {
    return (await settings.get()).stageOnGithub && sync.login !== null;
  }

  function prOf(ticket: Ticket): { repo: string; number: number } {
    if (ticket.pr === null || !ticket.canPostToGithub) throw new Error("Only PR cards have a review on GitHub");
    return ticket.pr;
  }

  async function token(): Promise<string> {
    const auth = await resolveToken(settings);
    if (auth === null) throw new Error(NO_GITHUB_TOKEN);
    return auth.token;
  }

  function stateOf(ticketId: string): PendingReviewState {
    const row = stmts.pendingReviewForTicket.get(ticketId);
    return { body: row?.body ?? "", url: row?.url ?? null, staged: stmts.stagedDiffComments.all(ticketId).length };
  }

  function saveRemote(ticketId: string, review: { id: number; node_id?: string; html_url: string }, body: string, dirty: boolean, pulledAt: number | null): void {
    stmts.upsertPendingReview.run(ticketId, review.id, review.node_id ?? null, review.html_url, body, dirty ? 1 : 0, pulledAt, Date.now());
  }

  /** The user's pending review on the PR as GitHub lists it, or null. */
  async function findRemote(pr: { repo: string; number: number }, auth: string): Promise<GithubReview | null> {
    if (sync.login === null) return null;
    const reviews = await githubPages<GithubReview>(`/repos/${pr.repo}/pulls/${pr.number}/reviews`, auth);
    return reviews.find((review) => review.state === "PENDING" && review.user?.login === sync.login) ?? null;
  }

  /** The pending review, found on GitHub or created there with the summary drafted so far. */
  async function ensureRemote(ticket: Ticket, auth: string): Promise<PendingReviewRow> {
    const pr = prOf(ticket);
    const local = stmts.pendingReviewForTicket.get(ticket.id);
    if (local !== undefined && local.review_id !== null) return local;
    const body = local?.body ?? "";
    let review = await findRemote(pr, auth);
    if (review === null) {
      const commitId = (await ticketDiff(ticket, false)).headSha;
      review = await githubPost<GithubReview>(`/repos/${pr.repo}/pulls/${pr.number}/reviews`, auth, {
        ...(commitId === null ? {} : { commit_id: commitId }),
        ...(body === "" ? {} : { body }),
      });
    } else if (body !== "" && (review.body ?? "") !== body) {
      await githubRequest("PUT", `/repos/${pr.repo}/pulls/${pr.number}/reviews/${review.id}`, auth, { body });
    }
    saveRemote(ticket.id, review, body, false, local?.pulled_at ?? null);
    return stmts.pendingReviewForTicket.get(ticket.id)!;
  }

  /** Puts one draft into the pending review: a new thread, or a reply into the thread its root is in. */
  async function stageOne(ticket: Ticket, draft: DiffCommentRow, auth: string): Promise<void> {
    const pr = prOf(ticket);
    const remote = await ensureRemote(ticket, auth);
    const reviewId = remote.node_id;
    if (reviewId === null) throw new Error("The pending review has no node id");
    let created: { databaseId: number | null; url: string } | undefined;
    if (draft.in_reply_to !== null) {
      const rootId = reviewCommentId(draft.in_reply_to);
      if (rootId === null) throw new Error("its thread is not an inline GitHub comment");
      const thread = (await reviewThreads(pr.repo, pr.number, auth)).get(rootId);
      if (thread === undefined || thread.id === "") throw new Error("its thread was not found on GitHub");
      const data = await githubGraphql<{ addPullRequestReviewThreadReply: { comment: { databaseId: number | null; url: string } | null } | null }>(
        `mutation($reviewId: ID!, $threadId: ID!, $body: String!) {
          addPullRequestReviewThreadReply(input: { pullRequestReviewId: $reviewId, pullRequestReviewThreadId: $threadId, body: $body }) { comment { databaseId url } }
        }`,
        { reviewId, threadId: thread.id, body: draft.body.trim() },
        auth,
      );
      created = data.addPullRequestReviewThreadReply?.comment ?? undefined;
    } else {
      const data = await githubGraphql<{ addPullRequestReviewThread: { thread: { comments: { nodes: Array<{ databaseId: number | null; url: string }> } } | null } | null }>(
        `mutation($reviewId: ID!, $path: String!, $body: String!, $line: Int, $side: DiffSide, $startLine: Int, $startSide: DiffSide, $subjectType: PullRequestReviewThreadSubjectType) {
          addPullRequestReviewThread(input: { pullRequestReviewId: $reviewId, path: $path, body: $body, line: $line, side: $side, startLine: $startLine, startSide: $startSide, subjectType: $subjectType }) {
            thread { comments(first: 1) { nodes { databaseId url } } }
          }
        }`,
        {
          reviewId,
          path: draft.path,
          body: draft.body.trim(),
          line: draft.line,
          side: draft.line === null ? null : sideOf(draft.side),
          startLine: draft.start_line,
          startSide: draft.start_line === null ? null : sideOf(draft.start_side ?? draft.side),
          subjectType: draft.line === null ? "FILE" : "LINE",
        },
        auth,
      );
      created = data.addPullRequestReviewThread?.thread?.comments.nodes[0];
    }
    if (created === undefined || created.databaseId === null) throw new Error("GitHub returned no comment");
    const githubId = `${REVIEW_COMMENT}${created.databaseId}`;
    stmts.markDiffCommentStaged.run(githubId, created.url, draft.id);
    // Replies left on the draft follow the thread onto GitHub.
    stmts.repointDiffCommentReplies.run(githubId, draft.id);
  }

  /** Mirrors a saved GitHub draft into the pending review; a failure leaves it an ordinary draft the submit posts. */
  function stage(ticketId: string, commentId: string): void {
    void enqueue(ticketId, async () => {
      const draft = stmts.diffCommentById.get(commentId);
      if (draft === undefined || draft.target !== "github" || draft.posted_at !== null || draft.github_comment_id !== null) return;
      const ticket = board.getTicket(ticketId);
      if (!ticket.canPostToGithub || !(await enabled())) return;
      try {
        await stageOne(ticket, draft, await token());
        publish();
      } catch (error) {
        bb.log.warn(`could not stage a draft on ${ticket.pr?.repo}#${ticket.pr?.number}: ${errorMessage(error)}`);
      }
    });
  }

  /** The staged draft's text changed here, so it changes on GitHub. */
  function restage(ticketId: string, commentId: string): void {
    void enqueue(ticketId, async () => {
      const draft = stmts.diffCommentById.get(commentId);
      const githubId = draft === undefined ? null : reviewCommentId(draft.github_comment_id);
      if (draft === undefined || githubId === null || draft.posted_at !== null) return;
      const ticket = board.getTicket(ticketId);
      try {
        await githubRequest("PATCH", `/repos/${prOf(ticket).repo}/pulls/comments/${githubId}`, await token(), { body: draft.body.trim() });
      } catch (error) {
        bb.log.warn(`could not update a staged draft on ${ticket.pr?.repo}#${ticket.pr?.number}: ${errorMessage(error)}`);
      }
    });
  }

  /** Takes staged drafts out of the pending review, after they were deleted or made local here. */
  function unstage(ticketId: string, githubIds: string[]): void {
    const ids = githubIds.map(reviewCommentId).filter((id): id is number => id !== null);
    if (ids.length === 0) return;
    void enqueue(ticketId, async () => {
      const ticket = board.getTicket(ticketId);
      const pr = prOf(ticket);
      const auth = await token();
      for (const id of ids) {
        try {
          await githubRequest("DELETE", `/repos/${pr.repo}/pulls/comments/${id}`, auth);
        } catch (error) {
          if (!(error instanceof GithubHttpError) || error.status !== 404) bb.log.warn(`could not remove a staged draft from ${pr.repo}#${pr.number}: ${errorMessage(error)}`);
        }
      }
      await dropIfEmpty(ticket, auth);
    });
  }

  /** A pending review with nothing left in it goes, so GitHub does not show an empty one. */
  async function dropIfEmpty(ticket: Ticket, auth: string): Promise<void> {
    const local = stmts.pendingReviewForTicket.get(ticket.id);
    if (local === undefined || local.review_id === null) return;
    if (stmts.stagedDiffComments.all(ticket.id).length > 0 || local.body.trim() !== "") return;
    const pr = prOf(ticket);
    try {
      await githubRequest("DELETE", `/repos/${pr.repo}/pulls/${pr.number}/reviews/${local.review_id}`, auth);
    } catch (error) {
      if (!(error instanceof GithubHttpError) || error.status !== 404) {
        bb.log.warn(`could not drop the empty pending review on ${pr.repo}#${pr.number}: ${errorMessage(error)}`);
        return;
      }
    }
    stmts.deletePendingReview.run(ticket.id);
    publish();
  }

  /** The summary typed in the review box; written to the review on GitHub once there is one. */
  function setBody(ticketId: string, body: string): PendingReviewState {
    const ticket = board.getTicket(ticketId);
    const local = stmts.pendingReviewForTicket.get(ticketId);
    if (local === undefined && body.trim() === "") return stateOf(ticketId);
    stmts.upsertPendingReview.run(ticketId, local?.review_id ?? null, local?.node_id ?? null, local?.url ?? null, body, 1, local?.pulled_at ?? null, Date.now());
    if (local?.review_id !== null && local?.review_id !== undefined && ticket.canPostToGithub) {
      void enqueue(ticketId, async () => {
        const current = stmts.pendingReviewForTicket.get(ticketId);
        if (current === undefined || current.review_id === null || current.body_dirty === 0) return;
        try {
          await githubRequest("PUT", `/repos/${prOf(ticket).repo}/pulls/${prOf(ticket).number}/reviews/${current.review_id}`, await token(), { body: current.body });
          stmts.upsertPendingReview.run(ticketId, current.review_id, current.node_id, current.url, current.body, 0, current.pulled_at, Date.now());
        } catch (error) {
          bb.log.warn(`could not update the pending review's summary on ${ticket.pr?.repo}#${ticket.pr?.number}: ${errorMessage(error)}`);
        }
        await dropIfEmpty(ticket, await token());
      });
    }
    return stateOf(ticketId);
  }

  /**
   * Brings the user's pending review on GitHub onto the board: its comments become drafts (new ones added, texts
   * taken, ones GitHub dropped removed) and its summary the review box's text unless that was edited here since.
   * When the review is gone (submitted or discarded on GitHub) the staged marks go too, after a comment sync so
   * drafts that were submitted show as posted.
   */
  async function pull(row: TicketRow, auth: string, syncComments: (row: TicketRow, auth: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (row.pr_repo === null || row.pr_number === null || !(await enabled())) return;
    const pr = { repo: row.pr_repo, number: row.pr_number };
    await enqueue(row.id, async () => {
      const remote = await findRemote(pr, auth);
      const local = stmts.pendingReviewForTicket.get(row.id);
      const staged = stmts.stagedDiffComments.all(row.id);
      if (remote === null) {
        if (local?.review_id == null && staged.length === 0) return;
        await syncComments(row, auth).catch((error: unknown) => bb.log.warn(`could not refresh comments for ${pr.repo}#${pr.number}: ${String(error)}`));
        db.transaction(() => {
          for (const draft of stmts.stagedDiffComments.all(row.id)) stmts.markDiffCommentStaged.run(null, null, draft.id);
          if (local !== undefined) stmts.deletePendingReview.run(row.id);
        })();
        publish();
        return;
      }
      // The review's comment list is GitHub's legacy shape, without line or side. The thread each comment is in
      // has them; a comment's own record does too, but GitHub serves no record for some pending comments.
      const listed = await githubPages<GithubReviewComment>(`/repos/${pr.repo}/pulls/${pr.number}/reviews/${remote.id}/comments`, auth, signal);
      const unplaced = listed.filter((comment) => stmts.diffCommentByGithubId.get(row.id, `${REVIEW_COMMENT}${comment.id}`)?.line == null);
      const threads =
        unplaced.length === 0
          ? new Map()
          : await reviewThreads(pr.repo, pr.number, auth, signal).catch((error: unknown) => {
              bb.log.warn(`could not read the review threads of ${pr.repo}#${pr.number}: ${String(error)}`);
              return new Map<number, never>();
            });
      const comments = await Promise.all(
        listed.map(async (comment): Promise<GithubReviewComment> => {
          // A row pulled before its place was known sits on no line yet; this pull places it.
          if (!unplaced.includes(comment)) return comment;
          const thread = threads.get(comment.in_reply_to_id ?? comment.id);
          if (thread !== undefined) {
            return { ...comment, path: thread.path, line: thread.line, original_line: thread.line, side: thread.side, start_line: thread.startLine, original_start_line: thread.startLine, start_side: thread.startSide };
          }
          return github<GithubReviewComment>(`/repos/${pr.repo}/pulls/comments/${comment.id}`, auth, signal).catch((error: unknown) => {
            bb.log.warn(`could not read pending comment ${comment.id} on ${pr.repo}#${pr.number}: ${String(error)}`);
            return comment;
          });
        }),
      );
      const now = Date.now();
      let changed = false;
      db.transaction(() => {
        const seen = new Set<string>();
        for (const comment of comments) {
          const githubId = `${REVIEW_COMMENT}${comment.id}`;
          seen.add(githubId);
          const existing = stmts.diffCommentByGithubId.get(row.id, githubId);
          const body = comment.body ?? "";
          const startLine = comment.start_line ?? comment.original_start_line ?? null;
          const line = comment.line ?? comment.original_line ?? null;
          if (existing !== undefined) {
            if (existing.body !== body && existing.posted_at === null) {
              stmts.setDiffCommentBody.run(body, now, existing.id);
              changed = true;
            }
            if (existing.line === null && line !== null && existing.posted_at === null) {
              stmts.setDiffCommentRange.run(line, comment.side === "LEFT" ? "LEFT" : "RIGHT", startLine, startLine === null ? null : comment.start_side === "LEFT" ? "LEFT" : "RIGHT", now, existing.id);
              changed = true;
            }
            continue;
          }
          const id = shortId();
          stmts.insertDiffComment.run({
            id,
            ticket_id: row.id,
            path: comment.path,
            line,
            side: comment.side === "LEFT" ? "LEFT" : "RIGHT",
            start_line: startLine,
            start_side: startLine === null ? null : comment.start_side === "LEFT" ? "LEFT" : "RIGHT",
            body,
            target: "github",
            in_reply_to: comment.in_reply_to_id === undefined ? null : `${REVIEW_COMMENT}${comment.in_reply_to_id}`,
            author: null,
            author_thread_id: null,
            created_at: Date.parse(comment.created_at) || now,
            updated_at: now,
          });
          stmts.markDiffCommentStaged.run(githubId, comment.html_url, id);
          changed = true;
        }
        for (const draft of staged) {
          if (draft.github_comment_id !== null && !seen.has(draft.github_comment_id)) {
            stmts.deleteDiffComment.run(draft.id, draft.id);
            changed = true;
          }
        }
        const remoteBody = remote.body ?? "";
        const dirty = local !== undefined && local.body_dirty === 1;
        const body = dirty ? local.body : remoteBody;
        if (local === undefined || local.review_id !== remote.id || local.body !== body || local.url !== remote.html_url) changed = true;
        saveRemote(row.id, remote, body, dirty, now);
      })();
      if (local?.body_dirty === 1 && local.body !== (remote.body ?? "")) {
        await githubRequest("PUT", `/repos/${pr.repo}/pulls/${pr.number}/reviews/${remote.id}`, auth, { body: local.body }).then(
          () => saveRemote(row.id, remote, local.body, false, now),
          (error: unknown) => bb.log.warn(`could not update the pending review's summary on ${pr.repo}#${pr.number}: ${String(error)}`),
        );
      }
      if (changed) publish();
    });
  }

  const pulledAt = new Map<string, number>();
  /** A pull in the background, at most every half minute per card, for when the changes page is open. */
  function pullSoon(row: TicketRow, syncComments: (row: TicketRow, auth: string) => Promise<void>): void {
    if (row.pr_repo === null || row.pr_number === null) return;
    const last = pulledAt.get(row.id) ?? 0;
    if (Date.now() - last < 30_000) return;
    pulledAt.set(row.id, Date.now());
    void resolveToken(settings).then((auth) => (auth === null ? undefined : pull(row, auth.token, syncComments))).catch((error: unknown) => bb.log.warn(`could not pull the pending review for ${row.pr_repo}#${row.pr_number}: ${String(error)}`));
  }

  /**
   * Submits the pending review with the drafts still only here staged into it first; one that GitHub refuses inline
   * goes into the body as a bullet. Returns how many drafts posted and the review's link.
   */
  async function submit(ticket: Ticket, drafts: DiffCommentRow[], event: ReviewEvent, summary: string): Promise<{ posted: number; url: string }> {
    const pr = prOf(ticket);
    await settled(ticket.id);
    return enqueue(ticket.id, async () => {
      const auth = await token();
      const remote = await ensureRemote(ticket, auth);
      const bullets: DiffCommentRow[] = [];
      for (const draft of drafts) {
        const current = stmts.diffCommentById.get(draft.id);
        if (current === undefined || current.posted_at !== null) continue;
        if (current.github_comment_id !== null) continue;
        try {
          await stageOne(ticket, current, auth);
        } catch (error) {
          bb.log.warn(`a draft on ${pr.repo}#${pr.number} goes in the review body instead: ${errorMessage(error)}`);
          bullets.push(current);
        }
      }
      // GitHub wants a body on a change request; the canned line stands in when nothing was written.
      const body = reviewBody(summary, summarizeDrafts(bullets)) || (event === "REQUEST_CHANGES" ? "Requesting changes; see my comments in the review threads." : "");
      const submitted = await githubPost<{ id: number; html_url: string }>(`/repos/${pr.repo}/pulls/${pr.number}/reviews/${remote.review_id}/events`, auth, {
        event,
        ...(body === "" ? {} : { body }),
      });
      const now = Date.now();
      db.transaction(() => {
        for (const draft of stmts.githubDraftComments.all(ticket.id)) {
          if (draft.github_comment_id?.startsWith(REVIEW_COMMENT)) stmts.markDiffCommentPosted.run(now, draft.posted_url ?? submitted.html_url, draft.github_comment_id, draft.id);
          else if (bullets.some((bullet) => bullet.id === draft.id)) stmts.markDiffCommentPosted.run(now, submitted.html_url, `review:${submitted.id}`, draft.id);
        }
        stmts.deletePendingReview.run(ticket.id);
      })();
      return { posted: drafts.length, url: submitted.html_url };
    });
  }

  /** Whether the card's review goes through a pending review on GitHub (one exists, or drafts already sit in it). */
  function hasRemote(ticketId: string): boolean {
    const local = stmts.pendingReviewForTicket.get(ticketId);
    return (local?.review_id ?? null) !== null || stmts.stagedDiffComments.all(ticketId).length > 0;
  }

  return { stateOf, setBody, stage, restage, unstage, pull, pullSoon, submit, hasRemote, settled };
}

export type PendingReview = ReturnType<typeof createPendingReview>;
