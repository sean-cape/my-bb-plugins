import { COLUMN } from "../shared/columns";
import { doneColumn, type BoardStore } from "./board";
import type { KanbanContext } from "./context";
import type { Dumps } from "./dumps";
import type { Loop } from "./loop/loop";
import type { ReviewResume } from "./reviews/resume";
import type { Reviews } from "./reviews/reviews";
import type { Tour } from "./tour";

/** Cards follow their threads: activity moves them on, archiving finishes them, and idle threads deliver their output. */
export function registerThreadLifecycle(ctx: KanbanContext, { board, dumps, tour, reviews, loop, reviewResume }: { board: BoardStore; dumps: Dumps; tour: Tour; reviews: Reviews; loop: Loop; reviewResume: ReviewResume }): void {
  const { bb, settings, stmts, publish } = ctx;
  const { getColumns, moveTicket } = board;

  bb.events.on("thread.active", async ({ thread }) => {
    reviewResume.threadActive(thread.id);
    loop.turnStarted(thread.id);
    const { autoMoveOnActivity } = await settings.get();
    if (!autoMoveOnActivity) return;
    const row = stmts.byThread.get(thread.id);
    if (row === undefined) return;
    const columns = await getColumns();
    const target = columns.find((column) => column.id === COLUMN.inProgress);
    if (target === undefined) return;
    const idleColumns = new Set<string>([COLUMN.backlog, COLUMN.todo]);
    if (idleColumns.has(row.column_id)) moveTicket(row.id, target.id, null);
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    // Skills like code-review fan out to background agents, and the thread idles between their reports; only the idle after the last one is final.
    if (thread.activeBackgroundAgentCount > 0) return;
    loop.quietIdle(thread.id);
    if (dumps.handleIdle(thread.id, lastAssistantText)) return;
    if (tour.handleIdle(thread.id, lastAssistantText)) return;
    if (loop.handleIdle(thread.id, lastAssistantText)) return;
    if (reviews.handleIdle(thread.id, lastAssistantText)) void loop.reviewFinished(thread.id);
  });

  bb.events.on("thread.failed", ({ thread, error }) => reviewResume.threadFailed(thread.id, error));

  bb.events.on("turn.failed", (event) => reviewResume.turnFailed(event));

  bb.events.on("message.queued", ({ entry }) => reviewResume.messageQueued(entry));

  bb.events.on("message.cancelled", ({ entry }) => reviewResume.messageCancelled(entry));

  bb.events.on("interaction.pending", ({ thread }) => loop.questionAsked(thread.id));

  bb.events.on("thread.archived", async ({ thread }) => {
    const row = stmts.byThread.get(thread.id);
    if (row === undefined) return;
    const columns = await getColumns();
    const done = doneColumn(columns);
    if (row.column_id !== done) moveTicket(row.id, done, null);
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    loop.threadFailed(thread.id, null);
    const now = Date.now();
    const changes = stmts.clearThread.run(now, thread.id).changes + stmts.clearReviewThread.run(now, thread.id).changes;
    if (changes > 0) publish();
  });
}
