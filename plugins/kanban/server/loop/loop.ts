import type { Ticket } from "../../shared/board";
import { LOOP_STOPPED, type LoopStoppedPayload } from "../../shared/events";
import { defaultGates, effectiveLevel, fixingRound, parseLoopState, phaseChip, unansweredFindings, type AttentionLevel, type CheckCommand, type Evidence, type FindingAnswer, type LoopGates } from "../../shared/loop";
import { readingPlan as buildReadingPlan, type ReadingPlan } from "../../shared/reading-plan";
import type { BoardStore } from "../board";
import type { CardThreads } from "../card-threads";
import type { CodeReviewThreads } from "../code-review-threads";
import { commentsBody, type PrComments } from "../comments/pr-comments";
import type { DiffComments } from "../comments/diff-comments";
import type { Changes } from "../diff/changes";
import type { ViewedMarks } from "../diff/viewed";
import type { KanbanContext } from "../context";
import { parseClassification } from "../agent-output";
import { rowToReview, type ChecksRunRow, type ClassifyRunRow } from "../db/rows";
import type { ProjectSettingsStore } from "../project-settings";
import type { Reviews } from "../reviews/reviews";
import type { Tour } from "../tour";
import { errorMessage, shortId, threadTitle } from "../util";
import { REVIEW_FAILED_PREFIX, REVIEW_SKILL_MISSING, reviewGaveUp } from "../reviews/prompts";
import { cardPromptText, checksPrompt, classifyPrompt, commentsPromptText, fixPromptText } from "./prompts";
import { passiveIdle, reduce, type CardPrompt, type LoopAction, type LoopEvent } from "./reducer";

/** How long a loop review's thread that went idle without its report has to stay idle before the review counts as failed. */
const REPORT_WAIT_MS = 10 * 60_000;

/** Checks only run a command and classify only scores files, so neither needs the card thread's reasoning. */
const MECHANICAL_REASONING = "low";

/** Thrown when a ready report can't name a check command; the CLI turns it into a hint. */
export class NoCheckCommandError extends Error {}

/** Thrown when the card's thread reports a fix round ready, or answers, out of turn; the CLI shows the message as is. */
export class FindingAnswerError extends Error {}

/** Thrown when a decision or report doesn't fit where the loop is; the CLI and the board show the message as is. */
export class LoopTurnError extends Error {}

/**
 * The monitored review loop's adapter: it turns thread events, CLI calls and board actions into reducer events,
 * stores the state the reducer returns, and carries out its actions.
 */
export function createLoop(
  ctx: KanbanContext,
  {
    board,
    threads,
    codeReviewThreads,
    projectSettings,
    reviews,
    diffComments,
    prComments,
    changes,
    viewed,
    tour,
  }: {
    board: BoardStore;
    threads: CardThreads;
    codeReviewThreads: CodeReviewThreads;
    projectSettings: ProjectSettingsStore;
    reviews: Reviews;
    diffComments: DiffComments;
    prComments: PrComments;
    changes: Changes;
    viewed: ViewedMarks;
    tour: Tour;
  },
) {
  const { bb, stmts, publish } = ctx;
  const { getTicket } = board;
  const pathRules = (ticketId: string) => projectSettings.projectSettings(getTicket(ticketId).projectId).pathRules;
  const awaitingReport = new Map<string, ReturnType<typeof setTimeout>>();
  /** Card threads whose current turn reported ready or landed, which is all that makes the turn passive. */
  const handedOff = new Set<string>();
  bb.onDispose(() => {
    for (const timer of awaitingReport.values()) clearTimeout(timer);
    awaitingReport.clear();
  });

  /** Reads, reduces and stores in one synchronous step, so two events for a card can't interleave; actions run after. */
  async function dispatch(ticketId: string, event: LoopEvent): Promise<void> {
    const row = stmts.byId.get(ticketId);
    if (row === undefined) return;
    const { state, actions } = reduce(parseLoopState(row.loop_state), event);
    stmts.setLoopState.run(JSON.stringify(state), ticketId);
    publish();
    for (const action of actions) await perform(ticketId, action);
  }

  async function perform(ticketId: string, action: LoopAction): Promise<void> {
    switch (action.type) {
      case "ensure-columns":
        await board.ensureLoopColumns();
        return;
      case "move": {
        const ticket = getTicket(ticketId);
        if (ticket.columnId === action.column) return;
        if (!(await board.getColumns()).some((column) => column.id === action.column)) return;
        board.moveTicket(ticketId, action.column, null);
        return;
      }
      case "spawn-checks":
        try {
          await spawnChecks(getTicket(ticketId), action.commit, action.checkCommand);
        } catch (error) {
          bb.log.warn(`could not start a checks thread for ticket ${ticketId}: ${errorMessage(error)}`);
          await dispatch(ticketId, { type: "thread-failed", role: "checks", commit: action.commit, threadId: null });
        }
        return;
      case "spawn-classify":
        try {
          await spawnClassify(getTicket(ticketId), action.commit);
        } catch (error) {
          bb.log.warn(`could not start a classify thread for ticket ${ticketId}: ${errorMessage(error)}`);
          await dispatch(ticketId, { type: "thread-failed", role: "classify", commit: action.commit, threadId: null });
        }
        return;
      case "spawn-review": {
        let reviewThreadId: string | null;
        try {
          reviewThreadId = (await reviews.startReview(ticketId, null, action.mode, action.depth, action.commit, action.answers, action.severityFloor)).reviewThreadId;
        } catch (error) {
          bb.log.warn(`could not start a review for ticket ${ticketId}: ${errorMessage(error)}`);
          await dispatch(ticketId, { type: "thread-failed", role: "review", reviewId: null, threadId: null });
          return;
        }
        const review = reviewThreadId === null ? undefined : stmts.reviewByThread.get(reviewThreadId);
        if (review !== undefined) await dispatch(ticketId, { type: "review-started", reviewId: review.id });
        return;
      }
      case "prompt-card":
        await promptCard(ticketId, action.prompt);
        return;
      case "record-fix": {
        const row = stmts.reviewById.get(action.reviewId);
        if (row !== undefined) reviews.completeApply(row, action.commit, false, action.disputed);
        return;
      }
      case "end-fix": {
        const row = stmts.reviewById.get(action.reviewId);
        if (row !== undefined) reviews.completeApply(row, null, false, action.findingIds);
        return;
      }
      case "stop-superseded":
        await stopSuperseded(ticketId, action.reviewId);
        return;
      case "spawn-narrative":
        try {
          await tour.ensureNarrative(getTicket(ticketId));
        } catch (error) {
          // The brief falls back to the reading order without it.
          bb.log.warn(`could not start a narrative for ticket ${ticketId}: ${errorMessage(error)}`);
        }
        return;
      case "alert":
        await alert(ticketId);
        return;
    }
  }

  async function alert(ticketId: string): Promise<void> {
    const ticket = getTicket(ticketId);
    if (ticket.threadId === null || ticket.loop === null) return;
    try {
      await bb.sdk.threads.markUnread({ threadId: ticket.threadId });
    } catch (error) {
      bb.log.warn(`could not mark the thread of ticket ${ticketId} unread: ${errorMessage(error)}`);
    }
    const payload: LoopStoppedPayload = { threadId: ticket.threadId, title: ticket.title, body: phaseChip(ticket.loop)?.title ?? "Needs you" };
    bb.realtime.publish(LOOP_STOPPED, payload);
  }

  /**
   * A card thread's turn that handed the work to the board needs nothing from the user, so it is marked read: that
   * keeps it out of the unread list, and the push plugin, which waits two seconds before sending, skips a read thread.
   * Any other turn, such as one the user started, is left as it ends.
   */
  function quietIdle(threadId: string): void {
    if (!handedOff.delete(threadId)) return;
    const row = stmts.byThread.get(threadId);
    if (row === undefined || !passiveIdle(parseLoopState(row.loop_state))) return;
    bb.sdk.threads.markRead({ threadId }).catch((error: unknown) => bb.log.warn(`could not mark card thread ${threadId} read: ${errorMessage(error)}`));
  }

  /** A turn that failed after handing off leaves no mark for the next one. */
  function turnStarted(threadId: string): void {
    handedOff.delete(threadId);
  }

  async function promptCard(ticketId: string, prompt: CardPrompt): Promise<void> {
    const ticket = getTicket(ticketId);
    if (ticket.threadId === null) return;
    let text: string;
    if (prompt.kind === "fix") {
      const row = stmts.reviewById.get(prompt.reviewId);
      if (row === undefined) return;
      const review = rowToReview(row);
      const findings = (review.report?.findings ?? []).filter((finding) => prompt.findingIds.includes(finding.id));
      text = fixPromptText(ticket, prompt.byUser === true ? null : prompt.round, review.commitSha, findings, prompt.polish === true);
    } else if (prompt.kind === "comments") {
      const comments = diffComments.pendingLocalComments(ticket);
      if (comments.length === 0) return;
      try {
        await bb.sdk.threads.send({ threadId: ticket.threadId, mode: "auto", input: [{ type: "text", text: commentsPromptText(ticket, commentsBody(ticket, comments)), mentions: [] }] });
      } catch (error) {
        bb.log.warn(`could not send the diff comments of ticket ${ticketId} to its thread: ${errorMessage(error)}`);
        return;
      }
      // An apply run owned by the card's thread marks the comments sent; its next ready marks them addressed.
      const applyId = shortId();
      stmts.insertCommentApply.run({ id: applyId, ticket_id: ticket.id, thread_id: ticket.threadId, comment_ids: JSON.stringify(comments.map((comment) => comment.id)), started_at: Date.now(), push: 0 });
      stmts.assignDiffCommentsApply.run(applyId, JSON.stringify(comments.map((comment) => comment.id.replace(/^local:/u, ""))));
      publish();
      return;
    } else {
      text = cardPromptText(prompt, ticket, projectSettings.projectSettings(ticket.projectId).checkCommand);
    }
    try {
      await bb.sdk.threads.send({ threadId: ticket.threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
    } catch (error) {
      bb.log.warn(`could not prompt the thread of ticket ${ticketId}: ${errorMessage(error)}`);
      return;
    }
    // The fix round is the review's apply round, so its re-review hands the fixed findings to the reviewer's scope check.
    if (prompt.kind === "fix") {
      stmts.startApply.run(ticket.threadId, Date.now(), JSON.stringify(prompt.findingIds), 0, prompt.reviewId);
      publish();
    }
  }

  /** Each run is failed before its thread stops, so the idle the stop brings is a late result the loop ignores, never a report. */
  async function stopSuperseded(ticketId: string, reviewId: string | null): Promise<void> {
    const now = Date.now();
    const threadIds: string[] = [];
    for (const run of stmts.runningChecksRuns.all(ticketId)) {
      stmts.failChecksRun.run(now, run.id);
      threadIds.push(run.thread_id);
    }
    for (const run of stmts.runningClassifyRuns.all(ticketId)) {
      stmts.finishClassifyRun.run("failed", null, now, run.id);
      threadIds.push(run.thread_id);
    }
    const review = reviewId === null ? undefined : stmts.reviewById.get(reviewId);
    if (review !== undefined && review.status === "running") {
      stmts.failReview.run("Superseded by a newer commit before it finished.", now, review.id);
      threadIds.push(review.thread_id);
    }
    publish();
    for (const threadId of threadIds) {
      try {
        await bb.sdk.threads.stop({ threadId });
      } catch (error) {
        bb.log.warn(`could not stop superseded thread ${threadId} of ticket ${ticketId}: ${errorMessage(error)}`);
      }
    }
  }

  async function spawnChecks(ticket: Ticket, commit: string, checkCommand: CheckCommand): Promise<void> {
    const projectId = ticket.projectId;
    if (projectId === null) throw new Error("The card has no project to check its work in");
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: await threads.freshWorktree(projectId),
      prompt: checksPrompt(ticket, commit, checkCommand.command),
      title: threadTitle(`Checks ${commit.slice(0, 7)}: ${ticket.title}`),
      ...(await threads.workerOptions(ticket)),
      reasoningLevel: MECHANICAL_REASONING,
      visibility: await codeReviewThreads.codeReviewThreadVisibility(),
      pluginMetadata: { ticketId: ticket.id, role: "checks" },
    });
    stmts.insertChecksRun.run({
      id: shortId(),
      ticket_id: ticket.id,
      thread_id: thread.id,
      commit_sha: commit,
      command: checkCommand.command,
      command_source: checkCommand.source,
      created_at: Date.now(),
    });
    publish();
  }

  async function spawnClassify(ticket: Ticket, commit: string): Promise<void> {
    const target = ticket.pr === null ? await reviews.localReviewTarget(ticket) : null;
    const projectId = target?.projectId ?? ticket.projectId;
    if (projectId === null) throw new Error("The card has no project to classify its work in");
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: await threads.freshWorktree(projectId),
      prompt: classifyPrompt(ticket, commit, target?.subject.kind === "local" ? target.subject.defaultBranch : null),
      title: threadTitle(`Classify ${commit.slice(0, 7)}: ${ticket.title}`),
      ...(await threads.workerOptions(ticket)),
      reasoningLevel: MECHANICAL_REASONING,
      visibility: await codeReviewThreads.codeReviewThreadVisibility(),
      pluginMetadata: { ticketId: ticket.id, role: "classify" },
    });
    stmts.insertClassifyRun.run({ id: shortId(), ticket_id: ticket.id, thread_id: thread.id, commit_sha: commit, created_at: Date.now() });
    publish();
  }

  /** `gates` are the ones chosen as monitoring turns on; without them the card's kind picks the defaults. */
  async function setMonitored(ticketId: string, monitored: boolean, gates: LoopGates | null = null): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    await dispatch(ticket.id, monitored ? { type: "monitor", hasThread: ticket.threadId !== null, gates: gates ?? defaultGates(ticket.kind) } : { type: "unmonitor" });
    return getTicket(ticket.id);
  }

  async function setGates(ticketId: string, gates: LoopGates): Promise<Ticket> {
    return decide(getTicket(ticketId).id, { type: "set-gates", gates });
  }

  function planningState(ticket: Ticket) {
    const state = parseLoopState(stmts.byId.get(ticket.id)!.loop_state);
    if (!state.monitored || state.phase !== "planning") throw new LoopTurnError(`Ticket ${ticket.id}'s plan gate isn't holding it, so there's no plan to propose or approve`);
    return state;
  }

  /** The card's thread proposes its plan; the plan gate holds it for the user. */
  async function proposePlan(ticketId: string, plan: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    planningState(ticket);
    return decide(ticket.id, { type: "plan-proposed", plan });
  }

  /** The user approves the plan, edited or as proposed; it goes to the card's thread and every later review. */
  async function approvePlan(ticketId: string, plan: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    planningState(ticket);
    return decide(ticket.id, { type: "approve-plan", plan });
  }

  /** The user approves the findings gate's round with `findingIds`; the rest are left open. */
  async function approveFindings(ticketId: string, findingIds: string[]): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    const state = waitingState(ticket);
    if (state.reason !== "findings") throw new LoopTurnError(`Ticket ${ticket.id} has no round of findings awaiting your approval`);
    const unknown = findingIds.filter((id) => !state.awaitingFindings.some((finding) => finding.id === id));
    if (unknown.length > 0) throw new LoopTurnError(`The round awaiting you holds ${state.awaitingFindings.map((finding) => finding.id).join(", ")}; not ${unknown.join(", ")}`);
    return decide(ticket.id, { type: "approve-findings", findingIds, pr: ticket.pr !== null });
  }

  /** The project's command when it sets one; otherwise the one the agent ran, marked as its choice. */
  function resolveCheckCommand(ticket: Ticket, agentCommand: string | null): CheckCommand {
    const projectCommand = projectSettings.projectSettings(ticket.projectId).checkCommand;
    if (projectCommand !== null) return { command: projectCommand, source: "project" };
    if (agentCommand !== null && agentCommand.trim() !== "") return { command: agentCommand.trim(), source: "agent" };
    throw new NoCheckCommandError("The project sets no check command, so the ready report has to name the one you ran");
  }

  /** The card's thread answers findings of the fix round it is in; returns the ones still unanswered. */
  async function answerFindings(ticketId: string, findingIds: string[], answer: FindingAnswer): Promise<string[]> {
    const ticket = getTicket(ticketId);
    const state = parseLoopState(stmts.byId.get(ticket.id)!.loop_state);
    const round = fixingRound(state);
    if (round === undefined) throw new FindingAnswerError(`Ticket ${ticket.id} isn't in a fix round, so there are no findings to answer.`);
    const unknown = findingIds.filter((id) => !round.handed.includes(id));
    if (unknown.length > 0) throw new FindingAnswerError(`This round handed over ${round.handed.join(", ")}; not ${unknown.join(", ")}.`);
    await dispatch(ticket.id, { type: "answer", answers: Object.fromEntries(findingIds.map((id) => [id, answer])) });
    return unansweredFindings(parseLoopState(stmts.byId.get(ticket.id)!.loop_state));
  }

  /** The card's thread reports its work committed and verified; on a monitored card the checks start. */
  async function reportReady(ticketId: string, report: { commit: string; evidence: Evidence; checkCommand: string | null }): Promise<{ ticket: Ticket; checkCommand: CheckCommand | null }> {
    const ticket = getTicket(ticketId);
    const state = parseLoopState(stmts.byId.get(ticket.id)!.loop_state);
    if (!state.monitored) return { ticket, checkCommand: null };
    if (state.phase === "planning") {
      throw new LoopTurnError(
        state.proposedPlan === null ? `The plan gate holds ticket ${ticket.id}: propose a plan with \`bb kanban plan --plan-file <path>\` and wait for its approval first` : `Ticket ${ticket.id}'s plan is waiting on the user's approval; wait for it before building`,
      );
    }
    if (state.phase === "accepted" || state.phase === "landed") {
      throw new LoopTurnError(
        ticket.pr === null ? `Ticket ${ticket.id} was accepted; land it and run \`bb kanban landed\` instead` : `Ticket ${ticket.id} was accepted; the user merges it on GitHub and the board moves it then`,
      );
    }
    const unanswered = unansweredFindings(state);
    if (unanswered.length > 0) throw new FindingAnswerError(`Answer every finding of this round first; ${unanswered.join(", ")} ${unanswered.length === 1 ? "has" : "have"} no answer.`);
    const checkCommand = resolveCheckCommand(ticket, report.checkCommand);
    await dispatch(ticket.id, { type: "ready", commit: report.commit, evidence: report.evidence, checkCommand });
    if (ticket.threadId !== null) handedOff.add(ticket.threadId);
    const apply = ticket.threadId === null ? undefined : stmts.commentApplyByThread.get(ticket.threadId);
    if (apply !== undefined && apply.completed_at === null) prComments.completeApply(apply, report.commit, false);
    return { ticket: getTicket(ticket.id), checkCommand };
  }

  /** The loop's state, when it is stopped at Needs you for the user's decision. */
  function waitingState(ticket: Ticket) {
    const state = parseLoopState(stmts.byId.get(ticket.id)!.loop_state);
    if (!state.monitored || state.phase !== "needs-you") throw new LoopTurnError(`Ticket ${ticket.id}'s review loop isn't waiting on you`);
    return state;
  }

  /** The finding `findingId` of the review the loop stopped after. */
  function lastReviewFinding(ticket: Ticket, reviewId: string | null, findingId: string) {
    const row = reviewId === null ? undefined : stmts.reviewById.get(reviewId);
    const finding = row === undefined ? undefined : rowToReview(row).report?.findings.find((entry) => entry.id === findingId);
    if (finding === undefined) throw new LoopTurnError(`The last review of ticket ${ticket.id} has no finding ${findingId}`);
    return finding;
  }

  async function decide(ticketId: string, event: LoopEvent): Promise<Ticket> {
    await dispatch(ticketId, event);
    return getTicket(ticketId);
  }

  /** The brief's reading plan over the current diff, with the files the changes view has marked viewed. */
  async function readingPlan(ticketId: string): Promise<ReadingPlan | null> {
    const ticket = getTicket(ticketId);
    const state = parseLoopState(stmts.byId.get(ticket.id)!.loop_state);
    if (!state.monitored || (state.phase !== "needs-you" && state.phase !== "paused")) return null;
    const [diff, { narrative }, marks] = await Promise.all([changes.ticketDiff(ticket, false), tour.latestNarrative(ticket), viewed.listViewed(ticket)]);
    return buildReadingPlan({
      level: effectiveLevel(state),
      diffPaths: diff.files.map((file) => file.path),
      narrative: narrative?.status === "completed" ? narrative.report : null,
      classified: state.classification?.files ?? null,
      viewed: new Set(marks.paths),
    });
  }

  async function setLevel(ticketId: string, level: AttentionLevel, reason: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    waitingState(ticket);
    return decide(ticket.id, { type: "set-level", level, reason });
  }

  /** A local card's thread lands the change; a PR card is left for the user to merge. At Scrutinize, only once every plan file is viewed. */
  async function accept(ticketId: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    const state = waitingState(ticket);
    if (ticket.pr === null && ticket.threadId === null) throw new LoopTurnError("The card has no thread to land the change");
    const plan = effectiveLevel(state) === "scrutinize" ? await readingPlan(ticket.id) : null;
    if (plan !== null && plan.gated && plan.unviewed.length > 0) {
      throw new LoopTurnError(`At Scrutinize, mark every file of the reading plan viewed first; ${plan.unviewed.length} still ${plan.unviewed.length === 1 ? "isn't" : "aren't"}: ${plan.unviewed.join(", ")}`);
    }
    return decide(ticket.id, { type: "accept", pr: ticket.pr !== null });
  }

  /** The card's thread landed the accepted change; the card moves to Done. */
  async function reportLanded(ticketId: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    const state = parseLoopState(stmts.byId.get(ticket.id)!.loop_state);
    if (ticket.pr !== null) throw new LoopTurnError("A PR card lands when its pull request merges; the board moves it then");
    if (state.phase !== "accepted") throw new LoopTurnError(`Ticket ${ticket.id} hasn't been accepted, so there's nothing to land yet`);
    const landed = await decide(ticket.id, { type: "landed" });
    if (ticket.threadId !== null) handedOff.add(ticket.threadId);
    return landed;
  }

  async function sendBack(ticketId: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    waitingState(ticket);
    if (ticket.threadId === null) throw new LoopTurnError("The card has no thread to send the comments to");
    const comments = stmts.pendingDiffComments.all(ticket.id).length;
    if (comments === 0) throw new LoopTurnError("No unsent diff comments to send back");
    return decide(ticket.id, { type: "send-back", comments });
  }

  async function rethink(ticketId: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    waitingState(ticket);
    if (ticket.threadId === null) throw new LoopTurnError("The card has no thread to rethink the approach");
    return decide(ticket.id, { type: "rethink" });
  }

  async function pullIn(ticketId: string, findingId: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    const finding = lastReviewFinding(ticket, waitingState(ticket).reviewId, findingId);
    if (finding.preExisting || (finding.triage?.decision !== "defer" && finding.triage?.decision !== "drop")) throw new LoopTurnError(`${findingId} wasn't deferred or dropped`);
    return decide(ticket.id, { type: "pull-in", findingId });
  }

  async function decideDispute(ticketId: string, findingId: string, decision: "uphold" | "close"): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    if (!waitingState(ticket).disputes.some((dispute) => dispute.id === findingId && dispute.decision === null)) throw new LoopTurnError(`${findingId} isn't a dispute awaiting you`);
    return decide(ticket.id, { type: "decide-dispute", findingId, decision, pr: ticket.pr !== null });
  }

  async function recordChecks(run: ChecksRunRow, exitCode: number, outputTail: string): Promise<void> {
    stmts.completeChecksRun.run(exitCode, outputTail, Date.now(), run.id);
    await dispatch(run.ticket_id, { type: "checks-result", commit: run.commit_sha, exitCode, outputTail, pr: getTicket(run.ticket_id).pr !== null });
  }

  /** A checks thread that goes idle without recording a result never ran the checks; a classify thread hands its scores back in its final message. */
  function handleIdle(threadId: string, lastAssistantText: string | null): boolean {
    const classifyRun = stmts.classifyRunByThread.get(threadId);
    if (classifyRun !== undefined) {
      finishClassify(classifyRun, lastAssistantText);
      return true;
    }
    const run = stmts.checksRunByThread.get(threadId);
    if (run === undefined) return false;
    failChecks(run);
    return true;
  }

  function finishClassify(run: ClassifyRunRow, body: string | null): void {
    if (run.status !== "running") return;
    const classification = parseClassification(body);
    stmts.finishClassifyRun.run(classification === null ? "failed" : "completed", body, Date.now(), run.id);
    publish();
    void dispatch(
      run.ticket_id,
      classification === null
        ? { type: "thread-failed", role: "classify", commit: run.commit_sha, threadId: run.thread_id, ...unparsedFailure(body, "a kanban-classify block") }
        : { type: "classified", commit: run.commit_sha, classification, pathRules: pathRules(run.ticket_id) },
    );
  }

  /** Only a run still running counts: a retried run's old thread failing late must not count as the retry failing. */
  function failChecks(run: ChecksRunRow): void {
    if (run.status !== "running") return;
    stmts.failChecksRun.run(Date.now(), run.id);
    publish();
    void dispatch(run.ticket_id, { type: "thread-failed", role: "checks", commit: run.commit_sha, threadId: run.thread_id });
  }

  /** A checks, classify or review thread that errored or was deleted never records its result. */
  function threadFailed(threadId: string, error: string | null): void {
    const classifyRun = stmts.classifyRunByThread.get(threadId);
    if (classifyRun !== undefined) {
      finishClassify(classifyRun, null);
      return;
    }
    const run = stmts.checksRunByThread.get(threadId);
    if (run !== undefined) {
      failChecks(run);
      return;
    }
    const review = stmts.reviewByThread.get(threadId);
    if (review === undefined || review.status !== "running") return;
    stmts.failReview.run(error, Date.now(), review.id);
    publish();
    void dispatch(review.ticket_id, { type: "thread-failed", role: "review", reviewId: review.id, threadId });
  }

  /** The card's thread waits on the user; a monitored card's loop pauses until its next ready. */
  function questionAsked(threadId: string): void {
    const row = stmts.byThread.get(threadId);
    if (row !== undefined) void dispatch(row.id, { type: "question" });
  }

  /** A review thread finished; on a monitored card its findings drive the next step. */
  async function reviewFinished(threadId: string): Promise<void> {
    const row = stmts.reviewByThread.get(threadId);
    if (row === undefined || row.status === "running") return;
    stopAwaitingReport(threadId);
    const report = row.status === "completed" ? rowToReview(row).report : null;
    if (report === null && row.status === "completed" && !reviewGaveUp(row.body) && awaitedByLoop(row.ticket_id, row.id)) {
      awaitingReport.set(
        threadId,
        setTimeout(() => void reportOverdue(threadId), REPORT_WAIT_MS),
      );
      return;
    }
    if (report === null) {
      const failure = row.body !== null && row.body.includes(REVIEW_SKILL_MISSING) ? { failure: REVIEW_SKILL_MISSING_FAILURE } : reviewFailure(row.body);
      await dispatch(row.ticket_id, { type: "thread-failed", role: "review", reviewId: row.id, threadId, ...failure });
      return;
    }
    const findings = report.findings.map(({ id, severity, title, preExisting, triage, carriedFrom, dispute, category }) => ({ id, severity, title, preExisting, triage, carriedFrom, dispute, category }));
    await dispatch(row.ticket_id, { type: "review-completed", reviewId: row.id, findings, notCovered: report.notCovered, pathRules: pathRules(row.ticket_id), pr: getTicket(row.ticket_id).pr !== null });
  }

  /**
   * A review thread can go idle on an interim message while the skill's verifiers still run, which bb's background
   * agent count doesn't always see, and wake when they report; the final report then replaces the interim one. So the
   * loop only counts the review failed once its thread has stayed idle that long without a report.
   */
  async function reportOverdue(threadId: string): Promise<void> {
    awaitingReport.delete(threadId);
    const row = stmts.reviewByThread.get(threadId);
    if (row === undefined || rowToReview(row).report !== null || !awaitedByLoop(row.ticket_id, row.id)) return;
    try {
      // A thread that woke idles again later, and that idle waits anew.
      if ((await bb.sdk.threads.get({ threadId })).status !== "idle") return;
    } catch (error) {
      bb.log.warn(`could not check review thread ${threadId}: ${errorMessage(error)}`);
    }
    await dispatch(row.ticket_id, { type: "thread-failed", role: "review", reviewId: row.id, threadId, ...reviewFailure(row.body) });
  }

  function stopAwaitingReport(threadId: string): void {
    clearTimeout(awaitingReport.get(threadId));
    awaitingReport.delete(threadId);
  }

  function awaitedByLoop(ticketId: string, reviewId: string): boolean {
    const row = stmts.byId.get(ticketId);
    const state = row === undefined ? null : parseLoopState(row.loop_state);
    return state !== null && state.monitored && state.phase === "reviewing" && state.reviewId === reviewId;
  }

  /** Timers don't survive a reload, so a loop review still waiting on its report waits again. */
  function reconcileOnLoad(): void {
    for (const ticket of stmts.all.all()) {
      const state = parseLoopState(ticket.loop_state);
      const review = state.phase === "reviewing" && state.reviewId !== null ? stmts.reviewById.get(state.reviewId) : undefined;
      if (review !== undefined && review.status !== "running") void reviewFinished(review.thread_id);
    }
  }

  return { reconcileOnLoad, setMonitored, setGates, proposePlan, approvePlan, approveFindings, answerFindings, reportReady, recordChecks, handleIdle, quietIdle, turnStarted, threadFailed, questionAsked, reviewFinished, accept, reportLanded, sendBack, rethink, pullIn, decideDispute, setLevel, readingPlan };
}

export type Loop = ReturnType<typeof createLoop>;

const REVIEW_SKILL_MISSING_FAILURE =
  "the review thread has no `code-review` skill that writes a review-findings report; link this repository's claude/ skills and agents into ~/.claude with `node scripts/link-claude-config.mjs`";

/** The reason a review thread gave for stopping, else the generic one. */
function reviewFailure(body: string | null): { failure?: string } {
  const reason = body?.trimStart().startsWith(REVIEW_FAILED_PREFIX) ? body.trimStart().slice(REVIEW_FAILED_PREFIX.length).split("\n")[0]!.trim() : "";
  return reason === "" ? unparsedFailure(body, "a review-findings report") : { failure: `the review stopped: ${reason}` };
}

/** A thread that finished with a final message but no parseable `block` would write the same message on a retry; one that left none may have crashed. */
function unparsedFailure(body: string | null, block: string): { failure?: string } {
  return body === null || body.trim() === "" ? {} : { failure: `the thread finished without ${block} the board could read` };
}
