// bb-plugin-kanban — backend entry.
//
// A kanban board where every card is a ticket that can be backed by a BB
// thread. Tickets are created automatically from the user's open GitHub pull
// requests (authored and review-requested), or ad hoc from the board UI, the
// `bb kanban` CLI, or an agent inside a thread. Agents move their own card
// between columns with `bb kanban move <column>`.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BOARD_CHANGED } from "./shared/events";
import { registerAgentInstructions } from "./server/agent-instructions";
import { registerCli } from "./server/cli";
import type { KanbanContext } from "./server/context";
import { migrate } from "./server/db/migrations";
import { prepareStatements } from "./server/db/statements";
import { registerThreadLifecycle } from "./server/lifecycle";
import { registerRpc } from "./server/rpc";
import { createServices } from "./server/services";
import { defineSettings } from "./server/settings";
import { loadSyncStatus } from "./server/sync";

export * from "./shared/board";
export * from "./shared/comments";
export * from "./shared/diff";
export * from "./shared/dump";
export * from "./shared/loop";
export * from "./shared/review";
export * from "./shared/tour";
export { BOARD_CHANGED } from "./shared/events";
export { rpcContract } from "./contract";
export { isVendoredPath, splitUnifiedDiff } from "bb-diff-view/server";
export { parseNarrative, parseProposal, parseReviewReport } from "./server/agent-output";
export { newLineRangesFromPatch } from "./server/diff/viewed";
export { githubRepoFromRemote } from "./server/github";
export { adfToText } from "./server/jira";
export { countSeverities, defaultSelected, rollupScores } from "./server/reviews/findings";

export default async function plugin(bb: BbPluginApi) {
  const settings = defineSettings(bb);
  const db = bb.storage.database();
  migrate(bb, db);
  const ctx: KanbanContext = {
    bb,
    settings,
    db,
    stmts: prepareStatements(db),
    sync: await loadSyncStatus(bb),
    publish: () => bb.realtime.publish(BOARD_CHANGED, { at: Date.now() }),
  };
  const services = createServices(ctx);
  const { board, codeReviewThreads, reviews, sourceSync, projectSettings, spend } = services;

  await projectSettings.loadProjectSettings();
  await board.keepPreLoopDefaults();
  sourceSync.registerService();
  spend.registerService();
  board.setReviewTag((await settings.get()).reviewTag);
  board.setMonitorTags((await settings.get()).monitorTags);
  await codeReviewThreads.reconcileOnLoad();
  await reviews.repairInterimReviewsOnLoad();
  settings.onChange((next, prev) => {
    board.setReviewTag(next.reviewTag);
    board.setMonitorTags(next.monitorTags);
    if (next.hideReviewThreads !== prev.hideReviewThreads) void codeReviewThreads.applyCodeReviewThreadVisibility(next.hideReviewThreads);
    sourceSync.onSettingsChange(next, prev);
  });

  registerThreadLifecycle(ctx, services);
  void services.reviewResume.reconcileOnLoad();
  services.loop.reconcileOnLoad();
  registerAgentInstructions(ctx, services);
  registerRpc(ctx, services);
  registerCli(ctx, services);

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
