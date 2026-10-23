import { rpcContract } from "../contract";
import { initialColumn } from "./board";
import type { KanbanContext } from "./context";
import { rowToDump } from "./db/rows";
import type { Services } from "./services";

/** The board's RPC surface; each handler hands off to the feature that owns it. */
export function registerRpc(ctx: KanbanContext, services: Services): void {
  const { bb, db, stmts, sync, publish } = ctx;
  const { board, subjects, threads, projects, changes, viewed, deltas, prComments, prConversation, pendingReview, diffComments, reviews, tour, dumps, subtasks, sourceSync, codeReviewThreads, loop, projectSettings } = services;
  const { resolveDiffSubject } = subjects;

  bb.rpc.register(rpcContract, {
    board_get: async () => ({
      columns: await board.getColumns(),
      tickets: stmts.all.all().map(board.hydrate),
      sources: await board.getSources(),
      tags: board.allTags(),
      sync,
      dumps: stmts.dumpsOpen.all().map(rowToDump),
      projectSettings: projectSettings.allProjectSettings(),
    }),
    dump_create: ({ text, projectId }) => dumps.createDump(text, projectId),
    dumps_list: ({ includeClosed }) => dumps.listDumps(includeClosed),
    dump_refine: ({ id, answers, notes }) => dumps.refineDump(id, answers, notes),
    dump_finalize: ({ id, tickets, columnId, startThreads }) => dumps.finalizeDump(id, tickets, columnId, startThreads),
    dump_discard: ({ id }) => dumps.discardDump(id),
    ticket_create: async (input) => {
      const columns = await board.getColumns();
      const columnId =
        input.columnId !== undefined && columns.some((column) => column.id === input.columnId)
          ? input.columnId
          : initialColumn(columns, null);
      if (input.parentId !== null && stmts.byId.get(input.parentId) === undefined) throw new Error(`No ticket with id ${input.parentId}`);
      const parentProject = input.parentId === null ? null : (stmts.byId.get(input.parentId)?.project_id ?? null);
      const projectId = input.projectId ?? parentProject;
      const ticket = db.transaction(() => {
        const created = board.createTicket({
          title: input.title,
          description: input.description,
          columnId,
          kind: "adhoc",
          tags: input.tags,
          threadId: null,
          projectId,
          pr: null,
          parentId: input.parentId,
          dueDate: input.dueDate,
          ...(input.monitored === undefined ? {} : { monitored: input.monitored }),
        });
        for (const subtask of input.subtasks) {
          board.createTicket({
            title: subtask.title,
            description: subtask.description,
            columnId,
            kind: "adhoc",
            tags: subtask.tags,
            threadId: null,
            projectId,
            pr: null,
            parentId: created.id,
          });
        }
        return board.getTicket(created.id);
      })();
      publish();
      if (input.startThread && input.projectId !== null) {
        return threads.spawnThreadForTicket(ticket.id, input.projectId);
      }
      return ticket;
    },
    ticket_update: ({ id, title, description }) => board.updateText(id, title, description),
    ticket_set_parent: ({ id, parentId }) => board.setParent(id, parentId),
    ticket_breakdown: ({ id, projectId, guidance }) => subtasks.breakdown(id, projectId, guidance),
    ticket_start_children: ({ id, mode, projectId }) => subtasks.startChildren(id, mode, projectId),
    ticket_set_tags: ({ id, tags }) => {
      board.getTicket(id);
      return board.setTags(id, tags);
    },
    ticket_set_due_date: ({ id, dueDate }) => board.setDueDate(id, dueDate),
    sources_set: async ({ sources }) => {
      const ids = new Set<string>();
      for (const source of sources) {
        if (ids.has(source.id)) throw new Error(`Duplicate source id "${source.id}"`);
        ids.add(source.id);
      }
      await bb.storage.kv.set("sources", sources);
      publish();
      void sourceSync.runSync();
      return { sources };
    },
    ticket_move: async ({ id, columnId, index }) => {
      const columns = await board.getColumns();
      if (!columns.some((column) => column.id === columnId)) {
        throw new Error(`No column with id ${columnId}`);
      }
      return board.moveTicket(id, columnId, index);
    },
    ticket_delete: ({ id }) => board.deleteTicket(id),
    ticket_restore: ({ id }) => board.restoreTicket(id),
    ticket_start_thread: ({ id, projectId }) => threads.spawnThreadForTicket(id, projectId),
    ticket_set_monitored: ({ id, monitored, gates }) => loop.setMonitored(id, monitored, gates ?? null),
    loop_set_gates: ({ id, gates }) => loop.setGates(id, gates),
    loop_approve_plan: ({ id, plan }) => loop.approvePlan(id, plan),
    loop_approve_findings: ({ id, findingIds }) => loop.approveFindings(id, findingIds),
    loop_accept: ({ id }) => loop.accept(id),
    loop_send_back: ({ id }) => loop.sendBack(id),
    loop_rethink: ({ id }) => loop.rethink(id),
    loop_pull_in: ({ id, findingId }) => loop.pullIn(id, findingId),
    loop_set_level: ({ id, level, reason }) => loop.setLevel(id, level, reason),
    loop_reading_plan: ({ id }) => loop.readingPlan(id),
    loop_decide_dispute: ({ id, findingId, decision }) => loop.decideDispute(id, findingId, decision),
    project_set_check_command: ({ projectId, checkCommand }) => projectSettings.setProjectSettings(projectId, { checkCommand: checkCommand === "" ? null : checkCommand }),
    project_set_path_rules: ({ projectId, pathRules }) => projectSettings.setProjectSettings(projectId, { pathRules }),
    ticket_review_pr: ({ id, projectId, mode, depth }) => reviews.startReview(id, projectId, mode, depth),
    review_availability: async ({ ticketId }) => ({ reason: await reviews.reviewUnavailableReason(ticketId) }),
    review_list: ({ ticketId }) => reviews.listReviews(ticketId),
    review_apply: ({ ticketId, reviewId, push }) => reviews.spawnApplyForReview(ticketId, reviewId, push),
    review_set_selection: ({ reviewId, findingId, selected }) => reviews.setSelection(reviewId, findingId, selected),
    review_set_applied: ({ reviewId, findingId, applied }) => reviews.setApplied(reviewId, findingId, applied),
    review_edit_finding: ({ reviewId, findingId, edit }) => reviews.editFinding(reviewId, findingId, edit),
    review_make_card: ({ reviewId, findingId }) => reviews.makeFindingCard(reviewId, findingId),
    diff_get: async ({ ticketId, refresh, range }) => changes.ticketDiff(await resolveDiffSubject(ticketId), refresh, range),
    diff_structural: async ({ ticketId, path, range }) => changes.structuralDiff(await resolveDiffSubject(ticketId), path, range),
    symbol_definitions: async ({ ticketId, symbol }) => changes.symbolDefinitions(await resolveDiffSubject(ticketId), symbol),
    symbol_usages: async ({ ticketId, symbol }) => changes.symbolUsages(await resolveDiffSubject(ticketId), symbol),
    symbol_peek_file: async ({ ticketId, path, startLine, endLine }) => changes.peekFile(await resolveDiffSubject(ticketId), path, startLine, endLine),
    diff_blame: async ({ ticketId, path, side, startLine, endLine, range }) => ({ lines: await changes.blame(await resolveDiffSubject(ticketId), path, side, startLine, endLine, range) }),
    diff_commits: async ({ ticketId }) => changes.ticketCommits(await resolveDiffSubject(ticketId)),
    diff_comments_list: async ({ ticketId }) => {
      const list = await diffComments.listDiffComments(ticketId);
      // The changes page is open: look for pending-review changes made on GitHub meanwhile.
      const ticket = await resolveDiffSubject(ticketId);
      const row = stmts.byId.get(ticket.id);
      if (row !== undefined && ticket.canPostToGithub) pendingReview.pullSoon(row, prComments.syncPrComments);
      return list;
    },
    pending_review_get: async ({ ticketId }) => pendingReview.stateOf((await resolveDiffSubject(ticketId)).id),
    pending_review_set_body: async ({ ticketId, body }) => pendingReview.setBody((await resolveDiffSubject(ticketId)).id, body),
    narrative_get: async ({ ticketId }) => tour.latestNarrative(await resolveDiffSubject(ticketId)),
    narrative_generate: async ({ ticketId }) => tour.spawnNarrative(await resolveDiffSubject(ticketId)),
    narrative_story: async ({ ticketId }) => tour.narrativeStory(await resolveDiffSubject(ticketId)),
    hunk_explanations_list: async ({ ticketId }) => tour.listExplanations(await resolveDiffSubject(ticketId)),
    code_review_threads: async ({ ticketId }) => ({ threads: codeReviewThreads.codeReviewThreads((await resolveDiffSubject(ticketId)).id) }),
    hunk_explain: async ({ ticketId, path, side, startLine, endLine }) => tour.explainHunk(await resolveDiffSubject(ticketId), path, side, Math.min(startLine, endLine), Math.max(startLine, endLine)),
    diff_delta: async ({ ticketId, fromSha }) => ({ delta: await deltas.diffDelta(await resolveDiffSubject(ticketId), fromSha) }),
    diff_viewed_list: async ({ ticketId }) => viewed.listViewed(await resolveDiffSubject(ticketId)),
    diff_viewed_set: async ({ ticketId, path, viewed: isViewed }) => viewed.setViewed(await resolveDiffSubject(ticketId), path, isViewed),
    diff_comment_add: (input) => diffComments.addDiffComment(input),
    diff_comment_update: (input) => diffComments.updateDiffComment(input),
    diff_comment_delete: ({ id }) => diffComments.deleteDiffComment(id),
    diff_comments_submit: (input) => diffComments.submitDiffComments(input),
    comments_list: async ({ ticketId }) => {
      await prComments.syncIfUnsynced(ticketId);
      return prComments.listComments(ticketId);
    },
    pr_conversation: ({ ticketId }) => prConversation.prConversation(ticketId),
    pr_comment_post: async ({ ticketId, body }) => {
      await prConversation.postComment(ticketId, body);
      return null;
    },
    pr_comment_edit: async ({ ticketId, id, body }) => {
      await prConversation.editComment(ticketId, id, body);
      return null;
    },
    pr_comment_delete: async ({ ticketId, id }) => {
      await prConversation.deleteComment(ticketId, id);
      return null;
    },
    pr_reaction_toggle: async ({ ticketId, subject, content, add }) => {
      await prConversation.toggleReaction(ticketId, subject, content, add);
      return null;
    },
    comment_set_selected: ({ id, selected }) => prComments.setSelected(id, selected),
    comment_set_addressed: ({ id, addressed }) => prComments.setAddressed(id, addressed),
    comment_set_resolved: ({ id, resolved }) => prComments.setResolved(id, resolved),
    comments_apply: ({ ticketId, push }) => prComments.spawnApplyForComments(ticketId, push),
    review_reset_selection: ({ reviewId }) => reviews.resetSelection(reviewId),
    ticket_link_thread: ({ id, threadId }) => threads.linkThread(id, threadId),
    columns_set: ({ columns }) => board.setColumns(columns),
    sync_now: async () => {
      await sourceSync.runSync();
      return sync;
    },
    diff_load_patch: async ({ ticketId, path, range }) => ({ patch: await changes.loadPatch(await resolveDiffSubject(ticketId), path, range) }),
    suggestions_apply: async ({ ticketId, items, message }) => services.suggestions.applySuggestions(await resolveDiffSubject(ticketId), items, message),
  });
}
