import type { Ticket } from "../shared/board";
import type { BoardStore } from "./board";
import type { CardThreads } from "./card-threads";
import type { KanbanContext } from "./context";
import { rowToNarrative, rowToReview } from "./db/rows";
import { reviewRequestPrompt, reviewRequestUpdatePrompt } from "./review-brief-prompt";
import { errorMessage } from "./util";

/**
 * A review requested of the user gets its thread once the board has read the pull request for them: when the review
 * completes (and the narrative the source asked for, when there is one), the card's thread is spawned with both as its
 * brief, or an existing thread is sent the new review. Nothing is briefed twice: the review row remembers it.
 */
export function createReviewBrief(ctx: KanbanContext, { board, threads }: { board: BoardStore; threads: CardThreads }) {
  const { bb, stmts } = ctx;
  const { getTicket, getColumns } = board;

  function isReviewRequest(ticket: Ticket): boolean {
    return ticket.pr !== null && ticket.pr.role === "other" && (ticket.pr.state === "open" || ticket.pr.state === "draft");
  }

  /** The narrative the brief should wait for: one the source asked for and hasn't started, or one still running. */
  function narrativePending(ticketId: string): boolean {
    const row = stmts.byId.get(ticketId);
    if (row === undefined) return false;
    if (row.auto_narrative === 1) return true;
    return stmts.latestNarrative.get(ticketId)?.status === "running";
  }

  async function brief(ticketId: string): Promise<void> {
    const ticket = getTicket(ticketId);
    if (!isReviewRequest(ticket) || ticket.projectId === null) return;
    const latest = stmts.latestReview.get(ticket.id);
    if (latest === undefined || latest.status === "running" || latest.briefed_at !== null) return;
    if (narrativePending(ticket.id)) return;
    const narrativeRow = stmts.latestNarrative.get(ticket.id);
    const narrative = narrativeRow === undefined ? null : rowToNarrative(narrativeRow).report;
    if (latest.status === "failed") {
      // A review that never ran still owes the user a thread, or nothing reaches them: it reads the PR itself instead.
      if (ticket.threadId === null) await threads.spawnThreadForTicket(ticket.id, ticket.projectId, reviewRequestPrompt(ticket, await getColumns(), { review: null, narrative, reviewFailed: true }));
    } else {
      const review = rowToReview(latest);
      if (ticket.threadId === null) {
        await threads.spawnThreadForTicket(ticket.id, ticket.projectId, reviewRequestPrompt(ticket, await getColumns(), { review, narrative, reviewFailed: false }));
      } else {
        await bb.sdk.threads.send({
          threadId: ticket.threadId,
          mode: "auto",
          input: [{ type: "text", text: reviewRequestUpdatePrompt(ticket, review, narrative), mentions: [] }],
        });
      }
    }
    // Marked after the spawn or send, so a failed one is tried again at the next completion.
    stmts.setReviewBriefed.run(Date.now(), latest.id);
  }

  /** A review or narrative thread finished: brief the card it belongs to, if it is a review request waiting for one. */
  async function workerFinished(threadId: string): Promise<void> {
    const ticketId = stmts.reviewByThread.get(threadId)?.ticket_id ?? stmts.narrativeByThread.get(threadId)?.ticket_id;
    if (ticketId === undefined) return;
    try {
      await brief(ticketId);
    } catch (error) {
      bb.log.warn(`could not brief the thread of ticket ${ticketId}: ${errorMessage(error)}`);
    }
  }

  return { workerFinished, brief };
}

export type ReviewBrief = ReturnType<typeof createReviewBrief>;
