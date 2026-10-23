import type { BbPluginApi } from "@get-bb/plugin-sdk";

const AUTOMATIONS_PLUGIN_ID = "automations";
const RUN_ENDED_KV_PREFIX = "automation-run-ended:";

function runEndedKey(threadId: string): string {
  return `${RUN_ENDED_KV_PREFIX}${threadId}`;
}

/**
 * An automation run is passive background work, so the turn it was started
 * for is marked read when it finishes. That keeps it out of the unread list
 * and stops its push notification: the push plugin waits two seconds before
 * sending and skips a thread read since. A failed run, and any later turn the
 * user starts in the thread, still reach the user.
 */
export function quietAutomationRuns(bb: BbPluginApi): void {
  bb.events.on("thread.idle", async ({ thread }) => {
    // A run that fans out to background agents idles between their reports;
    // only the idle after the last one ends it.
    if (
      thread.originPluginId !== AUTOMATIONS_PLUGIN_ID ||
      thread.activeBackgroundAgentCount > 0
    ) {
      return;
    }
    if ((await bb.storage.kv.get(runEndedKey(thread.id))) !== undefined) return;
    try {
      await bb.sdk.threads.markRead({ threadId: thread.id });
    } catch (error) {
      bb.log.warn(
        `could not mark automation run ${thread.id} read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await bb.storage.kv.set(runEndedKey(thread.id), Date.now());
  });

  bb.events.on("thread.failed", async ({ thread }) => {
    if (thread.originPluginId !== AUTOMATIONS_PLUGIN_ID) return;
    await bb.storage.kv.set(runEndedKey(thread.id), Date.now());
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    await bb.storage.kv.delete(runEndedKey(thread.id));
  });
}
