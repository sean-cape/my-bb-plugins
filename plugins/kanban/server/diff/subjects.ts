import type { Ticket } from "../../shared/board";
import { THREAD_SUBJECT_PREFIX } from "../../shared/events";
import type { BoardStore } from "../board";
import type { KanbanContext } from "../context";

/** What a diff page is about: a card, or a thread that has no card yet. */
export function createDiffSubjects(ctx: KanbanContext, { board }: { board: BoardStore }) {
  const { bb, stmts, publish } = ctx;
  const { getTicket, hydrate, getColumns, createTicket } = board;

  /**
   * The diff page accepts a card id or `thread:<threadId>`. A thread with a card resolves to that card; a thread
   * without one gets a transient card-shaped subject so the diff, comments and viewed marks work before any card exists.
   */
  async function resolveDiffSubject(id: string): Promise<Ticket> {
    if (!id.startsWith(THREAD_SUBJECT_PREFIX)) return getTicket(id);
    const threadId = id.slice(THREAD_SUBJECT_PREFIX.length);
    const linked = stmts.byThread.get(threadId);
    if (linked !== undefined) {
      // Comments left before the thread had a card were stored under the thread subject.
      if (stmts.moveDiffComments.run(linked.id, id).changes > 0) publish();
      return hydrate(linked);
    }
    const thread = await bb.sdk.threads.get({ threadId });
    const now = Date.now();
    return {
      id,
      title: thread.title ?? "Thread changes",
      description: "",
      columnId: "",
      kind: "adhoc",
      tags: [],
      sourceId: null,
      threadId,
      reviewThreadId: null,
      checksThreadId: null,
      classifyThreadId: null,
      latestReview: null,
      comments: null,
      parentId: null,
      dueDate: null,
      children: { total: 0, done: 0, withThread: 0 },
      pendingDiffComments: stmts.pendingDiffCommentCount.get(id)?.n ?? 0,
      canPostToGithub: false,
      defaultCommentTarget: "local",
      projectId: thread.projectId,
      pr: null,
      jira: null,
      position: 0,
      columnEnteredAt: now,
      loop: null,
      spend: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Submitting comments needs a real card (the apply thread is tracked on it); create one for a bare thread and move its diff state over. */
  async function ensureCardForSubject(subject: Ticket): Promise<Ticket> {
    if (!subject.id.startsWith(THREAD_SUBJECT_PREFIX) || subject.threadId === null) return subject;
    const columns = await getColumns();
    const created = createTicket({
      title: subject.title,
      description: "",
      columnId: columns[0]!.id,
      kind: "adhoc",
      threadId: subject.threadId,
      projectId: subject.projectId,
      pr: null,
    });
    stmts.moveDiffComments.run(created.id, subject.id);
    stmts.moveViewed.run(created.id, subject.id);
    stmts.moveNarratives.run(created.id, subject.id);
    stmts.moveExplanations.run(created.id, subject.id);
    publish();
    return getTicket(created.id);
  }

  return { resolveDiffSubject, ensureCardForSubject };
}

export type DiffSubjects = ReturnType<typeof createDiffSubjects>;
