import { TICKET_TITLE_MAX_LENGTH, type Ticket } from "../../shared/board";
import { locationLabel } from "../../shared/finding-location";
import type { FindingAnswer } from "../../shared/loop";
import type { Finding, FindingEdit, Review, ReviewDepth, ReviewSubject, SeverityFloor } from "../../shared/review";
import { REVIEWED_COMMIT_LINE, parseReviewReport } from "../agent-output";
import { initialColumn, type BoardStore } from "../board";
import type { CardThreads, ThreadEnvironment } from "../card-threads";
import type { CodeReviewThreads } from "../code-review-threads";
import type { KanbanContext } from "../context";
import { rowToReview, type ReviewRow } from "../db/rows";
import type { Projects } from "../projects";
import { parseFindingEdits, parseSelection, selectedFindingsBody, standingReviews } from "./findings";
import { localApplyPrompt, prApplyPrompt, reviewPrompt, type CardIntent } from "./prompts";
import { localSubject, prSubject, subjectLabel } from "./subject";
import { errorMessage, parseStringArray, shortId, threadTitle } from "../util";

const INTERIM_REVIEWS_REPAIRED_KEY = "interimReviewsRepaired";
/** Carry-over chains are short; the cap only guards against a cycle in stored handles. */
const MAX_CARRY_HOPS = 64;

/** Code review threads for a card's PR or local commit, the findings they persist, and the apply rounds that fix them. */
export function createReviews(
  ctx: KanbanContext,
  { board, threads, projects, codeReviewThreads }: { board: BoardStore; threads: CardThreads; projects: Projects; codeReviewThreads: CodeReviewThreads },
) {
  const { bb, stmts, publish } = ctx;
  const { getTicket } = board;
  const { freshWorktree, projectHostId, workerOptions } = threads;
  const { projectForTicket } = projects;
  const { codeReviewThreadVisibility } = codeReviewThreads;

  /**
   * A local review covers the commits the card's thread made beyond the branch the changes view diffs against, and
   * runs in that thread's project. The error says why the card can't be reviewed yet, in words the board shows.
   */
  async function localReviewTarget(ticket: Ticket): Promise<{ subject: ReviewSubject; projectId: string; branch: string | null }> {
    if (ticket.threadId === null) throw new Error("Start the card's thread first; a review covers the commits it makes");
    const thread = await bb.sdk.threads.get({ threadId: ticket.threadId });
    if (thread.environmentId === null) throw new Error("The card's thread has no environment yet");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const branch = environment.mergeBaseBranch ?? environment.defaultBranch;
    if (branch === null) throw new Error("The card's environment has no default branch to review its commits against");
    // The review's fresh worktree comes from the project's checkout, so it only has commits made in that repository.
    if (environment.hostId !== (await projectHostId(thread.projectId))) {
      throw new Error("The card's thread runs on another machine than the project's checkout, so a review worktree can't see its commits");
    }
    const status = await bb.sdk.environments.status({ environmentId: environment.id, mergeBaseBranch: branch });
    if (status.outcome === "not_applicable") throw new Error(status.message);
    if (status.outcome === "unavailable") throw new Error(status.failure.message);
    const { checkout, mergeBase } = status.workspace;
    const head = checkout.kind === "branch" || checkout.kind === "detached" ? checkout.headSha : null;
    if (head === null) throw new Error("The card's thread has no commits yet");
    if (mergeBase === null || mergeBase.aheadCount === 0) throw new Error(`No commits beyond \`${branch}\` to review; commit the card's work first`);
    return { subject: localSubject(head, branch), projectId: thread.projectId, branch: checkout.kind === "branch" ? checkout.branchName : null };
  }

  /** Why the card can't be reviewed yet, or null when it can; a PR card always can once it has a project. */
  async function reviewUnavailableReason(ticketId: string): Promise<string | null> {
    const ticket = getTicket(ticketId);
    if (ticket.pr !== null) return null;
    try {
      await localReviewTarget(ticket);
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }

  /** The plan the plan gate approved, which the review's scope finder and triage hold the change to. */
  function cardIntent(ticket: Ticket, branch: string | null): CardIntent {
    return { plan: ticket.loop?.plan ?? null, branch };
  }

  /**
   * Review a PR card's pull request, or another card's committed work, in a new hidden thread, running the depth's
   * finders. `commit` pins a local review to that commit instead of the thread's HEAD; a PR review takes the PR's head.
   * `answers` are the card thread's answers to earlier findings, by handle, which a re-review judges.
   * `severityFloor` leaves a re-review's new findings below it unreported.
   */
  async function startReview(
    ticketId: string,
    explicitProjectId: string | null,
    mode: "full" | "incremental",
    depth: ReviewDepth,
    commit: string | null = null,
    answers: Record<string, FindingAnswer> = {},
    severityFloor: SeverityFloor = null,
  ): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    if (ticket.pr !== null) return spawnReviewForTicket(ticket.id, await projectForTicket(ticket, explicitProjectId), mode, depth, prSubject(ticket), cardIntent(ticket, null), answers, severityFloor);
    const { subject: head, projectId, branch } = await localReviewTarget(ticket);
    const subject = commit === null || head.kind !== "local" ? head : localSubject(commit, head.defaultBranch);
    if (explicitProjectId !== null && explicitProjectId !== projectId) {
      throw new Error(`A local review runs in the project of the card's thread (${projectId}), so it can't run in ${explicitProjectId}`);
    }
    return spawnReviewForTicket(ticket.id, projectId, mode, depth, subject, cardIntent(ticket, branch), answers, severityFloor);
  }

  async function spawnReviewForTicket(
    ticketId: string,
    projectId: string,
    mode: "full" | "incremental",
    depth: ReviewDepth,
    subject: ReviewSubject,
    intent: CardIntent,
    answers: Record<string, FindingAnswer>,
    severityFloor: SeverityFloor,
  ): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    // A card reviewed both as a PR and locally keeps two chains; a re-review only continues the one of its own kind.
    const previousRow = mode === "incremental" ? stmts.latestCompletedReviewOfKind.get(ticket.id, subject.kind) : undefined;
    const previous = previousRow === undefined || previousRow.commit_sha === null ? null : rowToReview(previousRow);
    const standing = previous === null ? [] : standingReviews(stmts.reviewsForTicketOfKind.all(ticket.id, subject.kind).map(rowToReview));
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: await freshWorktree(projectId),
      prompt: reviewPrompt(subject, ticket, previous, standing, intent, depth, answers, severityFloor),
      title: threadTitle(`${previous === null ? "Review" : "Re-review"} ${subjectLabel(subject)}: ${ticket.title}`),
      ...(await workerOptions(ticket)),
      visibility: await codeReviewThreadVisibility(),
      pluginMetadata: { ticketId: ticket.id, role: "review" },
    });
    const now = Date.now();
    stmts.insertReview.run({
      id: shortId(),
      ticket_id: ticket.id,
      thread_id: thread.id,
      subject_kind: subject.kind,
      depth,
      since_commit_sha: previous?.commitSha ?? null,
      created_at: now,
    });
    stmts.setReviewThread.run(thread.id, now, ticket.id);
    publish();
    return getTicket(ticket.id);
  }

  async function spawnApplyForReview(ticketId: string, reviewId: string | null, push: boolean): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    const row = reviewId === null ? stmts.latestCompletedReview.get(ticket.id) : stmts.reviewById.get(reviewId);
    if (row === undefined || row.ticket_id !== ticket.id) throw new Error("No completed review to apply for this card");
    if (row.status === "running") throw new Error("The review is still running");
    if (row.status === "failed") throw new Error("The review did not complete; run it again first");
    const review = rowToReview(row);
    if (review.apply !== null && review.apply.completedAt === null) {
      throw new Error("An apply run for this review is already in progress");
    }
    const { body: findingsBody, findingIds } = selectedFindingsBody(review);
    if (findingIds !== null && findingIds.length === 0) {
      throw new Error("No selected findings are left to apply; tick at least one open finding");
    }
    const handed = findingIds === null ? null : JSON.stringify(findingIds);
    if (review.subjectKind === "local") return applyInCardThread(ticket, review, findingsBody, handed);
    const subject = prSubject(ticket);
    const projectId = await projectForTicket(ticket, null);
    // Reuse the review thread's worktree when it still exists: the PR is already fetched there.
    let environment: ThreadEnvironment | null = null;
    try {
      const reviewThread = await bb.sdk.threads.get({ threadId: review.threadId });
      if (reviewThread.environmentId !== null && reviewThread.archivedAt === null) {
        environment = { type: "reuse", environmentId: reviewThread.environmentId };
      }
    } catch {
      environment = null;
    }
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: environment ?? (await freshWorktree(projectId)),
      prompt: prApplyPrompt(subject, ticket, review, push, findingsBody),
      title: threadTitle(`Apply review ${subjectLabel(subject)}: ${ticket.title}`),
      parentThreadId: ticket.threadId ?? review.threadId,
      visibility: await codeReviewThreadVisibility(),
      pluginMetadata: { ticketId: ticket.id, role: "apply", reviewId: review.id },
    });
    stmts.startApply.run(thread.id, Date.now(), handed, push ? 1 : 0, review.id);
    publish();
    return getTicket(ticket.id);
  }

  /**
   * A local review's fixes belong on the card's branch, so the card's own thread applies them, keeping its own
   * instructions; a fresh worktree would commit them off that branch.
   */
  async function applyInCardThread(ticket: Ticket, review: Review, findingsBody: string, handed: string | null): Promise<Ticket> {
    if (ticket.threadId === null) throw new Error("The card's thread is gone, and a local review's fixes are made there; start a new thread and review again");
    await bb.sdk.threads.send({ threadId: ticket.threadId, mode: "auto", input: [{ type: "text", text: localApplyPrompt(ticket, review, findingsBody), mentions: [] }] });
    stmts.startApply.run(ticket.threadId, Date.now(), handed, 0, review.id);
    publish();
    return getTicket(ticket.id);
  }

  /** A carried finding keeps the apply-round choice the user made on the finding it came from. */
  function inheritSelections(reviewId: string): void {
    const row = stmts.reviewById.get(reviewId);
    const report = row === undefined ? null : parseReviewReport(row.body);
    if (row === undefined || report === null || !report.carriesForward) return;
    const overrides = parseSelection(row.selection_overrides);
    const sourceOverrides = new Map<string, Record<string, boolean>>();
    let changed = false;
    for (const finding of report.findings) {
      if (finding.carriedFrom === null || finding.id in overrides) continue;
      const [sourceId, sourceFindingId] = finding.carriedFrom.split("/");
      if (sourceId === undefined || sourceFindingId === undefined) continue;
      if (!sourceOverrides.has(sourceId)) {
        const source = stmts.reviewById.get(sourceId);
        sourceOverrides.set(sourceId, source === undefined || source.ticket_id !== row.ticket_id ? {} : parseSelection(source.selection_overrides));
      }
      const inherited = sourceOverrides.get(sourceId)![sourceFindingId];
      if (inherited === undefined) continue;
      overrides[finding.id] = inherited;
      changed = true;
    }
    if (changed) stmts.setSelectionOverrides.run(JSON.stringify(overrides), reviewId);
  }

  /** A review recorded from an interim message is superseded by the first later one carrying the report, until an apply round pins it. */
  function supersedeInterimReview(row: ReviewRow, text: string | null): boolean {
    const report = parseReviewReport(text);
    if (report === null || row.apply_thread_id !== null || parseReviewReport(row.body) !== null) return false;
    stmts.completeReview.run(text, report.commit, Date.now(), row.id);
    inheritSelections(row.id);
    return true;
  }

  /** Reviews finished before idles waited for background reviewers may hold an interim message; their thread's final output has the report. */
  async function repairInterimReviews(): Promise<void> {
    let repaired = 0;
    for (const row of stmts.unappliedFinishedReviews.all()) {
      if (parseReviewReport(row.body) !== null) continue;
      try {
        const { output } = await bb.sdk.threads.output({ threadId: row.thread_id });
        if (supersedeInterimReview(row, output)) repaired += 1;
      } catch (error) {
        bb.log.warn(`could not read the final output of review thread ${row.thread_id}: ${String(error)}`);
      }
    }
    await bb.storage.kv.set(INTERIM_REVIEWS_REPAIRED_KEY, true);
    if (repaired > 0) publish();
  }

  async function repairInterimReviewsOnLoad(): Promise<void> {
    if ((await bb.storage.kv.get<boolean>(INTERIM_REVIEWS_REPAIRED_KEY)) !== true) void repairInterimReviews();
  }

  /** The review thread's final idle carries the compiled report; without a report or a commit the review never ran. */
  function handleIdle(threadId: string, lastAssistantText: string | null): boolean {
    const row = stmts.reviewByThread.get(threadId);
    if (row === undefined) return false;
    const report = parseReviewReport(lastAssistantText);
    if (row.status !== "running") {
      if (supersedeInterimReview(row, lastAssistantText)) publish();
      return true;
    }
    const fromLine = lastAssistantText === null ? null : REVIEWED_COMMIT_LINE.exec(lastAssistantText)?.[1] ?? null;
    const commit = report?.commit ?? fromLine ?? row.commit_sha;
    // No report and no commit from any channel means the review never ran (setup failed, agent stopped early).
    if (report === null && commit === null) stmts.failReview.run(lastAssistantText, Date.now(), row.id);
    else {
      stmts.completeReview.run(lastAssistantText, report?.commit ?? fromLine, Date.now(), row.id);
      inheritSelections(row.id);
    }
    publish();
    return true;
  }

  function listReviews(ticketId: string): { reviews: Review[] } {
    return { reviews: stmts.reviewsForTicket.all(ticketId).map(rowToReview) };
  }

  function setSelection(reviewId: string, findingId: string, selected: boolean): Review {
    const row = stmts.reviewById.get(reviewId);
    if (row === undefined) throw new Error(`No review with id ${reviewId}`);
    const review = rowToReview(row);
    if (review.report === null || !review.report.findings.some((finding) => finding.id === findingId)) {
      throw new Error(`Review ${reviewId} has no finding ${findingId}`);
    }
    const overrides = { ...review.selectionOverrides, [findingId]: selected };
    stmts.setSelectionOverrides.run(JSON.stringify(overrides), reviewId);
    publish();
    return rowToReview(stmts.reviewById.get(reviewId)!);
  }

  /** Ends the review's apply round: the findings it was handed are fixed, except the ones it reports it could not apply. */
  function completeApply(row: ReviewRow, commit: string | null, pushed: boolean, skipped: readonly string[]): number {
    stmts.completeApply.run(Date.now(), commit, row.id);
    if (pushed) stmts.setApplyPushed.run(row.id);
    const handed = row.apply_finding_ids === null ? [] : parseStringArray(row.apply_finding_ids);
    const fixed = handed.filter((id) => !skipped.includes(id));
    const applied = new Set([...(row.applied_finding_ids === null ? [] : parseStringArray(row.applied_finding_ids)), ...fixed]);
    stmts.setAppliedFindingIds.run(applied.size === 0 ? null : JSON.stringify([...applied]), row.id);
    publish();
    return fixed.length;
  }

  function setApplied(reviewId: string, findingId: string, applied: boolean): Review {
    const row = stmts.reviewById.get(reviewId);
    if (row === undefined) throw new Error(`No review with id ${reviewId}`);
    const review = rowToReview(row);
    if (review.report === null || !review.report.findings.some((finding) => finding.id === findingId)) {
      throw new Error(`Review ${reviewId} has no finding ${findingId}`);
    }
    const ids = new Set(review.appliedFindingIds);
    if (applied) ids.add(findingId);
    else ids.delete(findingId);
    stmts.setAppliedFindingIds.run(ids.size === 0 ? null : JSON.stringify([...ids]), reviewId);
    publish();
    return rowToReview(stmts.reviewById.get(reviewId)!);
  }

  function resetSelection(reviewId: string): Review {
    const row = stmts.reviewById.get(reviewId);
    if (row === undefined) throw new Error(`No review with id ${reviewId}`);
    stmts.setSelectionOverrides.run(null, reviewId);
    publish();
    return rowToReview(stmts.reviewById.get(reviewId)!);
  }

  function editFinding(reviewId: string, findingId: string, edit: FindingEdit | null): Review {
    const row = stmts.reviewById.get(reviewId);
    if (row === undefined) throw new Error(`No review with id ${reviewId}`);
    const original = parseReviewReport(row.body);
    if (original === null || !original.findings.some((finding) => finding.id === findingId)) {
      throw new Error(`Review ${reviewId} has no finding ${findingId}`);
    }
    const edits = parseFindingEdits(row.finding_edits);
    if (edit === null) delete edits[findingId];
    else edits[findingId] = { ...edits[findingId], ...edit };
    stmts.setFindingEdits.run(Object.keys(edits).length === 0 ? null : JSON.stringify(edits), reviewId);
    publish();
    return rowToReview(stmts.reviewById.get(reviewId)!);
  }

  /** The handle of the finding this one was first reported as, following re-reviews' carry-overs back. */
  function originalHandle(reviewId: string, finding: Finding): string {
    let handle = `${reviewId}/${finding.id}`;
    let carriedFrom = finding.carriedFrom;
    for (let hops = 0; carriedFrom !== null && hops < MAX_CARRY_HOPS; hops += 1) {
      handle = carriedFrom;
      const [sourceId, sourceFindingId] = carriedFrom.split("/");
      const source = sourceId === undefined ? undefined : stmts.reviewById.get(sourceId);
      const earlier = source === undefined ? undefined : parseReviewReport(source.body)?.findings.find((entry) => entry.id === sourceFindingId);
      carriedFrom = earlier?.carriedFrom ?? null;
    }
    return handle;
  }

  async function makeFindingCard(reviewId: string, findingId: string): Promise<{ ticket: Ticket; created: boolean }> {
    const row = stmts.reviewById.get(reviewId);
    if (row === undefined) throw new Error(`No review with id ${reviewId}`);
    const review = rowToReview(row);
    const finding = review.report?.findings.find((entry) => entry.id === findingId);
    if (finding === undefined) throw new Error(`Review ${reviewId} has no finding ${findingId}`);
    const source = getTicket(review.ticketId);
    // Read before the check below, so nothing yields between finding no card and making one and two quick presses
    // can't both make it.
    const columnId = initialColumn(await board.getColumns(), null);
    // The card names the finding it came from, which is how a second press (or the same finding carried into a
    // re-review) finds it instead of making another.
    const provenance = `(finding ${originalHandle(reviewId, finding)})`;
    const existing = stmts.all.all().find((ticket) => ticket.description.includes(provenance));
    if (existing !== undefined) return { ticket: getTicket(existing.id), created: false };
    const description = [
      finding.description,
      finding.fix === null || finding.fix === "" ? null : `**Suggested fix:** ${finding.fix}`,
      finding.class === null || finding.class === "" ? null : `**Bug class:** ${finding.class}`,
      finding.locations.length === 0 ? null : ["**Where:**", ...finding.locations.map((location) => `- \`${locationLabel(location)}\``)].join("\n"),
      finding.preExisting
        ? `Already in the code before “${source.title}”; its code review found it ${provenance}.`
        : finding.triage?.decision === "defer"
          ? `Deferred by the code review of “${source.title}” as separate work${finding.triage.reason === "" ? "" : `: ${finding.triage.reason}`} ${provenance}.`
          : `Found by the code review of “${source.title}” ${provenance}.`,
    ].filter((part) => part !== null && part !== "");
    const ticket = board.createTicket({
      title: finding.title.slice(0, TICKET_TITLE_MAX_LENGTH),
      description: description.join("\n\n"),
      columnId,
      kind: "adhoc",
      threadId: null,
      projectId: source.projectId,
      pr: null,
    });
    publish();
    return { ticket: getTicket(ticket.id), created: true };
  }

  return { localReviewTarget, reviewUnavailableReason, startReview, spawnApplyForReview, repairInterimReviewsOnLoad, handleIdle, listReviews, setSelection, resetSelection, editFinding, makeFindingCard, completeApply, setApplied };
}

export type Reviews = ReturnType<typeof createReviews>;
