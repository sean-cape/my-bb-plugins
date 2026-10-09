import type { Ticket } from "../../shared/board";
import type { CommentApply, DiffComment, DiffCommentTarget, PrComment, ReviewEvent } from "../../shared/comments";
import type { KanbanContext } from "../context";
import { rowToDiffComment, type DiffCommentRow } from "../db/rows";
import type { Changes } from "../diff/changes";
import type { DiffSubjects } from "../diff/subjects";
import type { BoardStore } from "../board";
import { GithubHttpError, githubPages, githubPost, resolveToken } from "../github";
import type { PrComments } from "./pr-comments";
import { errorMessage, shortId } from "../util";
import { checkedLineRange, longLineLabel, locationLabel } from "bb-diff-view/line-range";
import type { LineRange } from "bb-diff-view/types";

function sideOf(side: string | null): "LEFT" | "RIGHT" {
  return side === "LEFT" ? "LEFT" : "RIGHT";
}

function rowRange(row: { line: number | null; side: string | null; start_line: number | null; start_side: string | null }): LineRange {
  return { line: row.line, side: sideOf(row.side), startLine: row.start_line, startSide: row.start_line === null ? null : sideOf(row.start_side) };
}

/** Says which lines a comment that touches the old side is on, since the apply thread reads line numbers as the new file's. */
function oldSideNote(comment: DiffComment): string {
  if (comment.line === null || (comment.side !== "LEFT" && comment.startSide !== "LEFT")) return "";
  if (comment.startLine === null) return `(On removed line ${comment.line} of the old file.) `;
  if (comment.startSide === comment.side) return `(On removed lines ${comment.startLine}–${comment.line} of the old file.) `;
  return `(On ${longLineLabel(comment)}.) `;
}

export interface DiffThreadRoot extends LineRange {
  id: string;
  path: string;
  /** The thread lives (or will live, once its draft root posts) on GitHub, so replies may go there too. */
  onGithub: boolean;
}

/** Comments left on a card's diff: local notes for an agent, or drafts and replies posted to the GitHub PR. */
export function createDiffComments(
  ctx: KanbanContext,
  { board, subjects, changes, prComments }: { board: BoardStore; subjects: DiffSubjects; changes: Changes; prComments: PrComments },
) {
  const { bb, settings, stmts, sync, publish } = ctx;
  const { getTicket } = board;
  const { resolveDiffSubject, ensureCardForSubject } = subjects;
  const { ticketDiff } = changes;
  const { syncPrComments, spawnApplyForComments } = prComments;

  /** Earlier messages of a diff thread (GitHub and local), oldest first, as a quoted preamble for the apply thread. */
  function threadContext(ticketId: string, rootId: string, skip: ReadonlySet<string>): string {
    const messages: Array<{ at: number; who: string; body: string }> = [];
    if (rootId.startsWith("review-comment:")) {
      for (const row of stmts.commentsForTicket.all(ticketId)) {
        if (row.id !== rootId && row.in_reply_to !== rootId) continue;
        messages.push({ at: Date.parse(row.created_at), who: `${row.author} on GitHub`, body: row.body });
      }
      const unsynced = stmts.commentById.get(rootId) === undefined ? stmts.diffCommentByGithubId.get(ticketId, rootId) : undefined;
      if (unsynced !== undefined) messages.push({ at: unsynced.created_at, who: "the user on GitHub", body: unsynced.body });
    } else {
      const root = stmts.diffCommentById.get(rootId);
      if (root !== undefined && !skip.has(root.id)) messages.push({ at: root.created_at, who: root.author ?? "the user", body: root.body });
    }
    for (const reply of stmts.diffCommentRepliesTo.all(ticketId, rootId)) {
      if (skip.has(reply.id) || reply.github_comment_id !== null) continue;
      messages.push({ at: reply.created_at, who: reply.author ?? "the user", body: reply.body });
    }
    if (messages.length === 0) return "";
    messages.sort((a, b) => a.at - b.at);
    const quoted = messages.map((message) => `> **${message.who}:** ${message.body.trim().replace(/\n/gu, "\n> ")}`).join("\n>\n");
    return `(Reply in an existing thread. Earlier in the thread:\n${quoted}\n)\n\n`;
  }

  /** Local diff comments in the shape the apply-pr-comments skill reads. */
  function diffCommentsAsPrComments(ticket: Ticket, comments: DiffComment[]): PrComment[] {
    const batch = new Set(comments.map((comment) => comment.id));
    return comments.map((comment) => ({
      id: `local:${comment.id}`,
      ticketId: ticket.id,
      kind: "review-comment",
      githubId: 0,
      author: sync.login ?? "you",
      mine: true,
      body: `${comment.inReplyTo === null ? "" : threadContext(ticket.id, comment.inReplyTo, batch)}${oldSideNote(comment)}${comment.body}`,
      path: comment.path,
      line: comment.line,
      startLine: comment.startLine,
      startSide: comment.startSide,
      reviewState: null,
      inReplyTo: comment.inReplyTo === null ? null : comment.inReplyTo.startsWith("review-comment:") ? comment.inReplyTo : `local:${comment.inReplyTo}`,
      side: comment.side,
      outdated: false,
      resolved: null,
      url: comment.postedUrl ?? ticket.pr?.url ?? "",
      createdAt: new Date(comment.createdAt).toISOString(),
      updatedAt: new Date(comment.updatedAt).toISOString(),
      selected: true,
      selectionOverride: null,
      addressedAt: null,
    }));
  }

  /** Cards whose GitHub drafts are being posted; a second submit or an edit would race the drafts read at the start. */
  const postingDrafts = new Set<string>();

  /** The root of the thread `inReplyTo` belongs to; replies to replies attach to the root, as on GitHub. */
  function diffThreadRoot(ticketId: string, inReplyTo: string): DiffThreadRoot {
    const id = inReplyTo.replace(/^local:/u, "");
    if (id.startsWith("review-comment:")) {
      const comment = stmts.commentById.get(id);
      if (comment === undefined) {
        // Posted from the board but not synced back yet.
        const draft = stmts.diffCommentByGithubId.get(ticketId, id);
        if (draft === undefined) throw new Error(`No GitHub review comment ${id} on this card`);
        return { id, path: draft.path, ...rowRange(draft), onGithub: true };
      }
      if (comment.ticket_id !== ticketId) throw new Error(`No GitHub review comment ${id} on this card`);
      if (comment.in_reply_to !== null) return diffThreadRoot(ticketId, comment.in_reply_to);
      const range = rowRange(comment);
      return { id, path: comment.path ?? "", ...(comment.outdated === 1 ? { ...range, line: null, startLine: null, startSide: null } : range), onGithub: true };
    }
    const comment = stmts.diffCommentById.get(id);
    if (comment === undefined || comment.ticket_id !== ticketId) throw new Error(`No diff comment ${id} on this card`);
    if (comment.in_reply_to !== null) return diffThreadRoot(ticketId, comment.in_reply_to);
    if (comment.github_comment_id?.startsWith("review-comment:") && stmts.commentById.get(comment.github_comment_id) !== undefined) {
      return diffThreadRoot(ticketId, comment.github_comment_id);
    }
    const onGithub = comment.target === "github" && comment.line !== null && (comment.posted_at === null || (comment.github_comment_id?.startsWith("review-comment:") ?? false));
    return { id: comment.github_comment_id?.startsWith("review-comment:") ? comment.github_comment_id : comment.id, path: comment.path, ...rowRange(comment), onGithub };
  }

  function assertCommentTarget(ticket: Ticket, target: DiffCommentTarget, root: DiffThreadRoot | null): void {
    if (target !== "github") return;
    if (!ticket.canPostToGithub) throw new Error("Only PR cards can post comments to GitHub");
    if (root !== null && !root.onGithub) throw new Error("This thread is local to the board; a GitHub reply needs a thread on an inline GitHub comment");
  }

  /**
   * Post GitHub drafts: new threads as one review (inline where a line is given, otherwise in the review body), then
   * replies into their threads. Each draft records the synced comment it became so the board shows it once.
   */
  async function postDiffCommentsToGithub(ticket: Ticket, drafts: DiffComment[], event: ReviewEvent): Promise<{ posted: number; url: string | null }> {
    if (ticket.pr === null || !ticket.canPostToGithub) throw new Error("Only PR cards can post to GitHub");
    const auth = await resolveToken(settings);
    if (auth === null) throw new Error("No GitHub token configured.");
    const { repo, number } = ticket.pr;
    const topLevel = drafts.filter((comment) => comment.inReplyTo === null);
    const replyIds = drafts.filter((comment) => comment.inReplyTo !== null).map((comment) => comment.id);
    let posted = 0;
    let url: string | null = null;
    if (topLevel.length > 0) {
      const inline = topLevel.filter((comment) => comment.line !== null);
      const general = topLevel.filter((comment) => comment.line === null);
      const summarize = (list: DiffComment[]) => list.map((comment) => `- \`${locationLabel(comment.path, comment)}\` — ${comment.body.trim()}`).join("\n");
      const path = `/repos/${repo}/pulls/${number}/reviews`;
      const commitId = (await ticketDiff(ticket, false)).headSha;
      let review: { id: number; html_url: string };
      let inlinePosted = inline.length > 0;
      try {
        review = await githubPost(path, auth.token, {
          event,
          ...(commitId === null ? {} : { commit_id: commitId }),
          body: general.length === 0 ? "" : summarize(general),
          comments: inline.map((comment) => ({
            path: comment.path,
            ...(comment.startLine === null ? {} : { start_line: comment.startLine, start_side: comment.startSide ?? comment.side }),
            line: comment.line,
            side: comment.side,
            body: comment.body.trim(),
          })),
        });
      } catch (error) {
        // A line outside the diff makes GitHub reject the whole review; fall back to one body-only review.
        if (!(error instanceof GithubHttpError) || error.status !== 422) throw error;
        review = await githubPost(path, auth.token, { event, body: summarize(topLevel) });
        inlinePosted = false;
      }
      // Mark first so nothing reposts these if the read-back below fails or the server stops.
      const now = Date.now();
      for (const comment of topLevel) stmts.markDiffCommentPosted.run(now, review.html_url, `review:${review.id}`, comment.id);
      posted += topLevel.length;
      url = review.html_url;
      const created = inlinePosted ? await reviewCommentsOf(repo, number, review.id, auth.token) : [];
      for (const comment of inline) {
        const index = created.findIndex((entry) => entry.path === comment.path && (entry.body ?? "").trim() === comment.body.trim());
        if (index === -1) continue;
        const match = created.splice(index, 1)[0]!;
        const githubId = `review-comment:${match.id}`;
        stmts.markDiffCommentPosted.run(now, match.html_url, githubId, comment.id);
        // Replies left on the draft follow the thread onto GitHub.
        stmts.repointDiffCommentReplies.run(githubId, comment.id);
      }
      // Pick up anything the read-back missed before posting replies into those threads.
      const row = stmts.byId.get(ticket.id);
      if (row !== undefined) await syncPrComments(row, auth.token).catch((error: unknown) => bb.log.warn(`could not refresh comments for ${repo}#${number}: ${String(error)}`));
    }
    const failed: string[] = [];
    let repliesPosted = 0;
    for (const id of replyIds) {
      const reply = stmts.diffCommentById.get(id);
      if (reply === undefined || reply.posted_at !== null) continue;
      const rootId = reply.in_reply_to ?? "";
      if (!rootId.startsWith("review-comment:")) {
        failed.push(`${locationLabel(reply.path, rowRange(reply))}: its thread is not an inline GitHub comment`);
        continue;
      }
      try {
        const created = await githubPost<{ id: number; html_url: string }>(
          `/repos/${repo}/pulls/${number}/comments/${rootId.slice("review-comment:".length)}/replies`,
          auth.token,
          { body: reply.body.trim() },
        );
        stmts.markDiffCommentPosted.run(Date.now(), created.html_url, `review-comment:${created.id}`, reply.id);
        posted += 1;
        repliesPosted += 1;
        url ??= created.html_url;
      } catch (error) {
        failed.push(`${locationLabel(reply.path, rowRange(reply))}: ${errorMessage(error)}`);
      }
    }
    // Replies alone post no review, so an approval or change request goes up as its own once they are in.
    if (topLevel.length === 0 && event !== "COMMENT" && failed.length === 0) {
      const review = await githubPost<{ html_url: string }>(`/repos/${repo}/pulls/${number}/reviews`, auth.token, {
        event,
        ...(event === "REQUEST_CHANGES" ? { body: "Requesting changes; see my replies in the review threads." } : {}),
      });
      url = review.html_url;
    }
    const row = stmts.byId.get(ticket.id);
    if (repliesPosted > 0 && row !== undefined) {
      await syncPrComments(row, auth.token).catch((error: unknown) => bb.log.warn(`could not refresh comments for ${repo}#${number}: ${String(error)}`));
    }
    if (failed.length > 0) {
      publish();
      throw new Error(`Posted ${posted}; ${failed.length} repl${failed.length === 1 ? "y" : "ies"} could not be posted: ${failed.join("; ")}`);
    }
    return { posted, url };
  }

  async function reviewCommentsOf(repo: string, number: number, reviewId: number, token: string): Promise<Array<{ id: number; path: string; body: string | null; html_url: string }>> {
    try {
      return await githubPages(`/repos/${repo}/pulls/${number}/reviews/${reviewId}/comments`, token);
    } catch (error) {
      bb.log.warn(`could not read back review ${reviewId} on ${repo}#${number}: ${String(error)}`);
      return [];
    }
  }

  async function listDiffComments(subjectId: string): Promise<{ comments: DiffComment[] }> {
    return { comments: stmts.diffCommentsForTicket.all((await resolveDiffSubject(subjectId)).id).map(rowToDiffComment) };
  }

  async function addDiffComment({
    ticketId,
    path,
    line,
    side,
    startLine,
    startSide,
    body,
    target,
    inReplyTo,
  }: {
    ticketId: string;
    path: string;
    line: number | null;
    side: "LEFT" | "RIGHT";
    startLine?: number | null | undefined;
    startSide?: "LEFT" | "RIGHT" | null | undefined;
    body: string;
    target?: DiffCommentTarget | undefined;
    inReplyTo: string | null;
  }): Promise<DiffComment> {
    const ticket = await resolveDiffSubject(ticketId);
    const root = inReplyTo === null ? null : diffThreadRoot(ticket.id, inReplyTo);
    const anchor = root ?? checkedLineRange({ line, side: line === null ? "RIGHT" : side, startLine, startSide });
    const chosen = target ?? (root === null ? ticket.defaultCommentTarget : "local");
    assertCommentTarget(ticket, chosen, root);
    const now = Date.now();
    const id = shortId();
    stmts.insertDiffComment.run({
      id,
      ticket_id: ticket.id,
      path: root?.path ?? path,
      line: anchor.line,
      side: anchor.side,
      start_line: anchor.startLine,
      start_side: anchor.startSide,
      body,
      target: chosen,
      in_reply_to: root?.id ?? null,
      author: null,
      author_thread_id: null,
      created_at: now,
      updated_at: now,
    });
    publish();
    return rowToDiffComment(stmts.diffCommentById.get(id)!);
  }

  async function updateDiffComment({ id, body, line, target }: { id: string; body?: string | undefined; line?: number | null | undefined; target?: DiffCommentTarget | undefined }): Promise<DiffComment> {
    const row = stmts.diffCommentById.get(id);
    if (row === undefined) throw new Error(`No diff comment with id ${id}`);
    if (row.author !== null) throw new Error("Agent replies cannot be edited");
    if (row.apply_id !== null) throw new Error("This comment was already submitted");
    if (row.posted_at !== null) throw new Error("This comment was already posted to GitHub");
    if (postingDrafts.has(row.ticket_id)) throw new Error("This card's drafts are being posted to GitHub; try again in a moment");
    const nextTarget = target ?? (row.target === "github" ? "github" : "local");
    if (nextTarget !== row.target) {
      const ticket = await resolveDiffSubject(row.ticket_id);
      assertCommentTarget(ticket, nextTarget, row.in_reply_to === null ? null : diffThreadRoot(row.ticket_id, row.in_reply_to));
      if (nextTarget === "local" && stmts.diffCommentRepliesTo.all(row.ticket_id, row.id).some((reply) => reply.target === "github")) {
        throw new Error("Replies in this thread are headed to GitHub; make them local first");
      }
    }
    // Moving a comment to another line makes it a one-line comment there.
    const range = line === undefined || row.in_reply_to !== null ? rowRange(row) : checkedLineRange({ line, side: sideOf(row.side) });
    stmts.updateDiffComment.run(body ?? row.body, range.line, range.startLine, range.startSide, nextTarget, Date.now(), id);
    publish();
    return rowToDiffComment(stmts.diffCommentById.get(id)!);
  }

  function deleteDiffComment(id: string): { deleted: boolean } {
    const row = stmts.diffCommentById.get(id);
    if (row === undefined) return { deleted: false };
    const sent = (comment: DiffCommentRow) => comment.author === null && (comment.apply_id !== null || comment.posted_at !== null);
    if (sent(row)) throw new Error("This comment was already sent; it can no longer be deleted");
    if (stmts.diffCommentRepliesTo.all(row.ticket_id, row.id).some(sent)) throw new Error("Replies in this thread were already sent; delete the unsent ones instead");
    const result = stmts.deleteDiffComment.run(id, id);
    if (result.changes > 0) publish();
    return { deleted: result.changes > 0 };
  }

  async function submitDiffComments({
    ticketId,
    postToGithub,
    reviewEvent,
    address,
    autoApprove,
    push,
  }: {
    ticketId: string;
    postToGithub: boolean;
    reviewEvent: ReviewEvent;
    address: boolean;
    autoApprove: boolean;
    push: boolean;
  }): Promise<{ posted: number; postedUrl: string | null; apply: CommentApply | null; ticket: Ticket }> {
    if (!postToGithub && !address) throw new Error("Choose at least one of: post to GitHub, address with a thread");
    const ticket = await ensureCardForSubject(await resolveDiffSubject(ticketId));
    if (postToGithub && postingDrafts.has(ticket.id)) throw new Error("Already posting this card's drafts to GitHub");
    const local = address ? stmts.pendingDiffComments.all(ticket.id).map(rowToDiffComment) : [];
    const drafts = postToGithub ? stmts.githubDraftComments.all(ticket.id).map(rowToDiffComment) : [];
    if (local.length === 0 && drafts.length === 0) throw new Error("No pending comments to submit");
    let posted = 0;
    let postedUrl: string | null = null;
    if (drafts.length > 0) {
      postingDrafts.add(ticket.id);
      try {
        if (reviewEvent !== "COMMENT" && ticket.pr?.role === "authored") throw new Error("GitHub doesn't let you approve or request changes on your own pull request");
        const result = await postDiffCommentsToGithub(ticket, drafts, reviewEvent);
        posted = result.posted;
        postedUrl = result.url;
      } finally {
        postingDrafts.delete(ticket.id);
      }
    }
    let apply: CommentApply | null = null;
    if (local.length > 0) {
      const result = await spawnApplyForComments(ticket.id, autoApprove, push, diffCommentsAsPrComments(ticket, local));
      apply = result.apply;
      stmts.assignDiffCommentsApply.run(apply.id, JSON.stringify(local.map((comment) => comment.id)));
    }
    publish();
    return { posted, postedUrl, apply, ticket: getTicket(ticket.id) };
  }

  return { diffThreadRoot, listDiffComments, addDiffComment, updateDiffComment, deleteDiffComment, submitDiffComments };
}

export type DiffComments = ReturnType<typeof createDiffComments>;
