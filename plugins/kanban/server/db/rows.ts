import { z } from "zod";
import type { PullRequest, Ticket } from "../../shared/board";
import type { CommentApply, DiffComment, DiffCommentTarget, PrComment } from "../../shared/comments";
import { proposalSchema, type Dump, type Proposal } from "../../shared/dump";
import { parseLoopState, type CheckCommand } from "../../shared/loop";
import type { Review, ReviewDepth } from "../../shared/review";
import type { HunkExplanation, Narrative } from "../../shared/tour";
import { parseNarrative, parseReviewReport } from "../agent-output";
import { jiraCategory } from "../jira";
import { applyFindingEdits, effectiveSelection, parseFindingEdits, parseSelection, summarize } from "../reviews/findings";
import { parseStringArray } from "../util";

export interface TicketRow {
  id: string;
  title: string;
  description: string;
  column_id: string;
  kind: "pr" | "jira" | "adhoc";
  tags: string;
  source_id: string | null;
  thread_id: string | null;
  review_thread_id: string | null;
  project_id: string | null;
  pr_repo: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_role: PullRequest["role"] | null;
  pr_state: PullRequest["state"] | null;
  pr_author: string | null;
  pr_updated_at: string | null;
  pr_head_ref: string | null;
  pr_checks: PullRequest["checks"];
  pr_checks_url: string | null;
  pr_body: string | null;
  jira_key: string | null;
  jira_url: string | null;
  jira_status: string | null;
  jira_status_category: string | null;
  jira_issue_type: string | null;
  jira_priority: string | null;
  jira_assignee: string | null;
  jira_updated_at: string | null;
  comments_synced_for: string | null;
  /** 1 once a tracked PR stops appearing in its source, until it shows up again. */
  left_source: number;
  parent_id: string | null;
  due_date: string | null;
  position: number;
  /** Null only for rows written before the column existed and not yet migrated. */
  column_entered_at: number | null;
  /** The review loop's state as JSON; null until the card is first monitored. */
  loop_state: string | null;
  /** A source asked for a review of this PR card that has not started yet. */
  auto_review_depth: ReviewDepth | null;
  /** 1 when a source asked for a narrative of this PR card that has not started yet. */
  auto_narrative: number;
  created_at: number;
  updated_at: number;
}

export interface ClassifyRunRow {
  id: string;
  ticket_id: string;
  thread_id: string;
  commit_sha: string;
  status: "running" | "completed" | "failed";
  /** The thread's final message, kept for a look at what it scored. */
  body: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface ChecksRunRow {
  id: string;
  ticket_id: string;
  thread_id: string;
  commit_sha: string;
  command: string;
  command_source: CheckCommand["source"];
  status: "running" | "completed" | "failed";
  exit_code: number | null;
  output_tail: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface HunkExplanationRow {
  id: string;
  ticket_id: string;
  path: string;
  side: "old" | "new";
  start_line: number;
  end_line: number;
  head_sha: string | null;
  thread_id: string;
  status: "running" | "completed" | "failed";
  body: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface NarrativeRow {
  id: string;
  ticket_id: string;
  thread_id: string;
  status: "running" | "completed" | "failed";
  head_sha: string | null;
  body: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface ReviewRow {
  id: string;
  ticket_id: string;
  thread_id: string;
  subject_kind: Review["subjectKind"];
  depth: Review["depth"];
  status: Review["status"];
  commit_sha: string | null;
  base_ref: string | null;
  head_ref: string | null;
  since_commit_sha: string | null;
  body: string | null;
  created_at: number;
  completed_at: number | null;
  apply_thread_id: string | null;
  apply_started_at: number | null;
  apply_completed_at: number | null;
  apply_pushed_commit: string | null;
  apply_finding_ids: string | null;
  apply_push: number | null;
  applied_finding_ids: string | null;
  resolved_finding_ids: string | null;
  selection_overrides: string | null;
  finding_edits: string | null;
}

export interface PrCommentRow {
  id: string;
  ticket_id: string;
  kind: PrComment["kind"];
  github_id: number;
  author: string;
  mine: number;
  body: string;
  path: string | null;
  line: number | null;
  review_state: string | null;
  in_reply_to: string | null;
  side: string;
  start_line: number | null;
  start_side: string | null;
  outdated: number;
  resolved: number | null;
  url: string;
  created_at: string;
  updated_at: string;
  selected: number | null;
  addressed_at: number | null;
  diff_hunk: string | null;
  original_line: number | null;
  original_start_line: number | null;
  review_id: number | null;
}

export interface DiffCommentRow {
  id: string;
  ticket_id: string;
  path: string;
  line: number | null;
  side: string | null;
  start_line: number | null;
  start_side: string | null;
  body: string;
  target: string;
  in_reply_to: string | null;
  author: string | null;
  author_thread_id: string | null;
  created_at: number;
  updated_at: number;
  posted_at: number | null;
  posted_url: string | null;
  github_comment_id: string | null;
  addressed_at: number | null;
  apply_id: string | null;
}

function sideOf(startLine: number | null, side: string | null): "LEFT" | "RIGHT" | null {
  if (startLine === null) return null;
  return side === "LEFT" ? "LEFT" : "RIGHT";
}

export function rowToDiffComment(row: DiffCommentRow): DiffComment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    path: row.path,
    line: row.line,
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    startLine: row.start_line,
    startSide: sideOf(row.start_line, row.start_side),
    body: row.body,
    target: row.target === "github" ? "github" : "local",
    inReplyTo: row.in_reply_to,
    author: row.author,
    authorThreadId: row.author_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    postedAt: row.posted_at,
    postedUrl: row.posted_url,
    githubCommentId: row.github_comment_id,
    addressedAt: row.addressed_at,
    applyId: row.apply_id,
  };
}

export interface PendingReviewRow {
  ticket_id: string;
  review_id: number | null;
  node_id: string | null;
  url: string | null;
  body: string;
  /** 1 while the summary was edited here and not yet written to the review on GitHub. */
  body_dirty: number;
  pulled_at: number | null;
  updated_at: number;
}

export interface DumpRow {
  id: string;
  text: string;
  project_id: string;
  thread_id: string | null;
  status: Dump["status"];
  proposal_json: string | null;
  answers_json: string | null;
  created_ticket_ids: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export function rowToDump(row: DumpRow): Dump {
  let proposal: Proposal | null = null;
  try {
    const parsed = proposalSchema.safeParse(JSON.parse(row.proposal_json ?? "null"));
    proposal = parsed.success ? parsed.data : null;
  } catch {
    proposal = null;
  }
  let answers: Record<string, string> = {};
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(row.answers_json ?? "{}"));
    answers = parsed.success ? parsed.data : {};
  } catch {
    answers = {};
  }
  return {
    id: row.id,
    text: row.text,
    projectId: row.project_id,
    threadId: row.thread_id,
    status: row.status,
    proposal,
    answers,
    createdTicketIds: parseStringArray(row.created_ticket_ids),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CommentApplyRow {
  id: string;
  ticket_id: string;
  thread_id: string;
  comment_ids: string;
  started_at: number;
  completed_at: number | null;
  pushed_commit: string | null;
  push: number;
}

/** Default: everything someone else wrote that still asks for something; approvals and my own notes stay unticked. */
function commentSelectedByDefault(row: PrCommentRow): boolean {
  if (row.mine === 1) return false;
  if (row.addressed_at !== null) return false;
  if (row.kind === "review" && (row.review_state === "APPROVED" || row.review_state === "DISMISSED")) return false;
  return row.body.trim() !== "";
}

export function rowToComment(row: PrCommentRow): PrComment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    kind: row.kind,
    githubId: row.github_id,
    author: row.author,
    mine: row.mine === 1,
    body: row.body,
    path: row.path,
    line: row.line,
    reviewState: row.review_state,
    inReplyTo: row.in_reply_to,
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    startLine: row.start_line,
    startSide: sideOf(row.start_line, row.start_side),
    outdated: row.outdated === 1,
    resolved: row.resolved === null ? null : row.resolved === 1,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    selected: row.selected === null ? commentSelectedByDefault(row) : row.selected === 1,
    selectionOverride: row.selected === null ? null : row.selected === 1,
    addressedAt: row.addressed_at,
    diffHunk: row.diff_hunk,
    originalLine: row.original_line,
    originalStartLine: row.original_start_line,
    reviewId: row.review_id === null ? null : `review:${row.review_id}`,
  };
}

export function rowToCommentApply(row: CommentApplyRow): CommentApply {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    threadId: row.thread_id,
    commentIds: parseStringArray(row.comment_ids),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    pushedCommit: row.pushed_commit,
    push: row.push !== 0,
  };
}

export function rowToReview(row: ReviewRow): Review {
  const findingEdits = parseFindingEdits(row.finding_edits);
  const report = applyFindingEdits(parseReviewReport(row.body), findingEdits);
  const selectionOverrides = parseSelection(row.selection_overrides);
  return {
    id: row.id,
    ticketId: row.ticket_id,
    threadId: row.thread_id,
    subjectKind: row.subject_kind,
    status: row.status,
    commitSha: row.commit_sha,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    sinceCommitSha: row.since_commit_sha,
    depth: report?.depth ?? row.depth,
    body: row.body,
    report,
    selection: effectiveSelection(report, selectionOverrides),
    selectionOverrides,
    findingEdits,
    appliedFindingIds: row.applied_finding_ids === null ? [] : parseStringArray(row.applied_finding_ids),
    resolvedFindingIds: row.resolved_finding_ids === null ? [] : parseStringArray(row.resolved_finding_ids),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    apply:
      row.apply_thread_id !== null && row.apply_started_at !== null
        ? {
            threadId: row.apply_thread_id,
            startedAt: row.apply_started_at,
            completedAt: row.apply_completed_at,
            pushedCommit: row.apply_pushed_commit,
            findingIds: row.apply_finding_ids === null ? null : parseStringArray(row.apply_finding_ids),
            push: row.apply_push !== 0,
          }
        : null,
  };
}

export function rowToTicket(
  row: TicketRow,
  latestReview: Review | null,
  comments: Ticket["comments"],
  extras: { pendingDiffComments: number; canPostToGithub: boolean; defaultCommentTarget: DiffCommentTarget; children: Ticket["children"]; spend: Ticket["spend"] },
): Ticket {
  const pr: PullRequest | null =
    row.pr_repo !== null &&
    row.pr_number !== null &&
    row.pr_url !== null &&
    row.pr_role !== null &&
    row.pr_state !== null
      ? {
          repo: row.pr_repo,
          number: row.pr_number,
          url: row.pr_url,
          role: row.pr_role,
          state: row.pr_state,
          author: row.pr_author ?? "",
          updatedAt: row.pr_updated_at ?? "",
          headRef: row.pr_head_ref,
          checks: row.pr_checks,
          checksUrl: row.pr_checks_url,
          body: row.pr_body,
        }
      : null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    columnId: row.column_id,
    kind: row.kind,
    tags: parseStringArray(row.tags),
    sourceId: row.source_id,
    threadId: row.thread_id,
    reviewThreadId: latestReview?.threadId ?? row.review_thread_id,
    latestReview: latestReview === null ? null : summarize(latestReview),
    comments,
    parentId: row.parent_id,
    dueDate: row.due_date,
    children: extras.children,
    pendingDiffComments: extras.pendingDiffComments,
    canPostToGithub: extras.canPostToGithub,
    defaultCommentTarget: extras.defaultCommentTarget,
    projectId: row.project_id,
    pr,
    jira:
      row.jira_key !== null && row.jira_url !== null
        ? {
            key: row.jira_key,
            url: row.jira_url,
            status: row.jira_status ?? "",
            statusCategory: jiraCategory(row.jira_status_category ?? undefined),
            issueType: row.jira_issue_type ?? "",
            priority: row.jira_priority,
            assignee: row.jira_assignee,
            updatedAt: row.jira_updated_at ?? "",
          }
        : null,
    position: row.position,
    columnEnteredAt: row.column_entered_at ?? row.updated_at,
    loop: row.loop_state === null ? null : parseLoopState(row.loop_state),
    spend: extras.spend,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToNarrative(row: NarrativeRow): Narrative {
  const report = row.status === "completed" ? parseNarrative(row.body) : null;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    threadId: row.thread_id,
    status: row.status,
    headSha: row.head_sha,
    report,
    error: row.status === "failed" ? (row.body === null ? "The tour thread ended without writing a tour." : `The tour thread replied without a kanban-narrative block. Its last message:\n\n${row.body.slice(0, 2000)}`) : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function rowToExplanation(row: HunkExplanationRow): HunkExplanation {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    path: row.path,
    side: row.side,
    startLine: row.start_line,
    endLine: row.end_line,
    headSha: row.head_sha,
    threadId: row.thread_id,
    status: row.status,
    body: row.body,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
