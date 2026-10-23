import type { PluginThreadEventPayloads, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import type { KanbanContext } from "../context";
import type { Loop } from "../loop/loop";
import type { Reviews } from "./reviews";

type QueuedMessage = PluginThreadEventPayloads["message.queued"]["entry"];

const RESUME_REASON = "Resuming the interrupted code review";
/** A failure whose attempt number reaches this has already been resumed twice. */
const MAX_ATTEMPTS = 3;
/**
 * How long a failed review thread waits for its turn's failure details, or for the provider-retry plugin to queue a
 * retry (it asks account pools first, with a 5 second timeout), before the review fails.
 */
const SETTLE_MS = 15_000;
/** A sleep or dropped connection reports no category at all, so a failure without one counts as transient too. */
const TRANSIENT_CATEGORIES = new Set(["unknown", "connection-failed", "stream-disconnected", "internal"]);

/**
 * A review thread that dies mid-turn (the machine slept, the connection dropped, bb restarted) is resumed where it
 * stopped instead of failing, since starting over would run the reviewer and verifier again. Rate limits and
 * overloads are left to the provider-retry plugin, whose queued retry keeps the review running. Checks and classify
 * threads are cheap and fail straight to the loop, which starts them again from scratch.
 */
export function createReviewResume(ctx: KanbanContext, { reviews, loop }: { reviews: Reviews; loop: Loop }) {
  const { bb, stmts } = ctx;
  const settling = new Map<string, { timer: ReturnType<typeof setTimeout>; error: string | null }>();

  bb.onDispose(() => {
    for (const { timer } of settling.values()) clearTimeout(timer);
    settling.clear();
  });

  function isRunningReview(threadId: string): boolean {
    return stmts.reviewByThread.get(threadId)?.status === "running";
  }

  function stopSettling(threadId: string): string | null {
    const pending = settling.get(threadId);
    if (pending === undefined) return null;
    clearTimeout(pending.timer);
    settling.delete(threadId);
    return pending.error;
  }

  function giveUp(threadId: string, error: string | null): void {
    stopSettling(threadId);
    loop.threadFailed(threadId, error);
  }

  /** The review fails unless its thread is still in error with a retry queued; a thread that moved on settles through its own events. */
  async function settle(threadId: string, error: string | null): Promise<void> {
    stopSettling(threadId);
    if (!isRunningReview(threadId)) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.deletedAt !== null) return giveUp(threadId, error);
      if (thread.status !== "error") return;
      if (hasQueuedRetry(await bb.sdk.threads.queue.list({ threadId }))) return;
    } catch (failure) {
      bb.log.warn(`could not check failed review thread ${threadId}: ${String(failure)}`);
    }
    giveUp(threadId, error);
  }

  async function resume(threadId: string, turnRequestId: string | undefined, error: string | null): Promise<void> {
    try {
      await bb.sdk.threads.retry({ threadId, ...(turnRequestId === undefined ? {} : { turnRequestId }), reason: RESUME_REASON });
      bb.log.info(`resumed review thread ${threadId}`);
    } catch (failure) {
      // The provider-retry plugin may have queued its own retry first, which keeps the review going.
      bb.log.warn(`could not resume review thread ${threadId}: ${String(failure)}`);
      await settle(threadId, error);
    }
  }

  /** `turn.failed` follows right after, for a failure inside a turn, and decides; any other failure settles once the wait is up. */
  function threadFailed(threadId: string, error: string | null): void {
    if (!isRunningReview(threadId)) {
      loop.threadFailed(threadId, error);
      return;
    }
    stopSettling(threadId);
    settling.set(threadId, { timer: setTimeout(() => void settle(threadId, error), SETTLE_MS), error });
  }

  function turnFailed(event: PluginTurnFailedEvent): void {
    const { threadId, errorInfo, attemptNumber, requestId } = event;
    if (!isRunningReview(threadId)) return;
    if (errorInfo?.category === "rate-limit" || errorInfo?.httpStatusCode === 429 || errorInfo?.category === "overloaded") return;
    const error = stopSettling(threadId);
    const transient = errorInfo === null || TRANSIENT_CATEGORIES.has(errorInfo.category);
    if (!transient || attemptNumber >= MAX_ATTEMPTS) return giveUp(threadId, error);
    void resume(threadId, requestId, error);
  }

  /** A retry row queued for the review means someone is resuming it; one deleted before it ran leaves the thread failed. */
  function messageQueued(entry: QueuedMessage): void {
    if (entry.payload.kind === "retry") stopSettling(entry.threadId);
  }

  function messageCancelled(entry: QueuedMessage): void {
    if (entry.payload.kind === "retry" && isRunningReview(entry.threadId)) void settle(entry.threadId, null);
  }

  function threadActive(threadId: string): void {
    stopSettling(threadId);
  }

  /**
   * Thread events aren't replayed while the plugin is unloaded, so a review whose thread failed or finished then is
   * picked up here: a failed one is resumed and a finished one records its report.
   */
  async function reconcileOnLoad(): Promise<void> {
    for (const row of stmts.runningReviews.all()) {
      const threadId = row.thread_id;
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.deletedAt !== null) giveUp(threadId, null);
        else if (thread.status === "error") {
          if (!hasQueuedRetry(await bb.sdk.threads.queue.list({ threadId }))) await resume(threadId, undefined, null);
        } else if (thread.status === "idle" && thread.activeBackgroundAgentCount === 0) {
          const { output } = await bb.sdk.threads.output({ threadId });
          if (reviews.handleIdle(threadId, output)) await loop.reviewFinished(threadId);
        }
      } catch (failure) {
        bb.log.warn(`could not reconcile review thread ${threadId}: ${String(failure)}`);
      }
    }
  }

  return { threadFailed, turnFailed, messageQueued, messageCancelled, threadActive, reconcileOnLoad };
}

function hasQueuedRetry(entries: readonly QueuedMessage[]): boolean {
  return entries.some((entry) => entry.payload.kind === "retry");
}

export type ReviewResume = ReturnType<typeof createReviewResume>;
