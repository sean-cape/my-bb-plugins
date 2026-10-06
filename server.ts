// bb-plugin-kanban — backend entry.
//
// A kanban board where every card is a ticket that can be backed by a BB
// thread. Tickets are created automatically from the user's open GitHub pull
// requests (authored and review-requested), or ad hoc from the board UI, the
// `bb kanban` CLI, or an agent inside a thread. Agents move their own card
// between columns with `bb kanban move <column>`.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared schemas (app.tsx imports only the types)
// ---------------------------------------------------------------------------

export const columnSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
});
export type Column = z.infer<typeof columnSchema>;

/** Whether the signed-in user wrote the PR; drives the card thread's first prompt. */
export const prRoleSchema = z.enum(["authored", "other"]);

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u, "Tags are lowercase letters, digits, dots, dashes, underscores");

/**
 * Where tickets come from automatically. Every item a source returns becomes a
 * card tagged with the source's tags; a card can be fed by several sources.
 */
const sourceBaseSchema = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/u),
  name: z.string().trim().min(1).max(80),
  tags: z.array(tagSchema).max(10),
  /** Move the card to Done when the item stops appearing in this source while still open. */
  doneWhenGone: z.boolean(),
  enabled: z.boolean(),
  /** Project for this source's card threads. GitHub sources try the repo's remote first. */
  projectId: z.string().nullable().default(null),
});

export const githubSourceSchema = sourceBaseSchema.extend({
  kind: z.literal("github-search"),
  /** GitHub search query, e.g. `is:pr is:open author:@me archived:false`. */
  query: z.string().trim().min(1).max(500),
});

export const jiraSourceSchema = sourceBaseSchema.extend({
  kind: z.literal("jira-jql"),
  /** JQL, e.g. `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`. */
  jql: z.string().trim().min(1).max(1000),
});

export const sourceSchema = z.discriminatedUnion("kind", [githubSourceSchema, jiraSourceSchema]);
export type Source = z.infer<typeof sourceSchema>;
export type SourceKind = Source["kind"];
export const SOURCE_KINDS: Array<{ kind: SourceKind; label: string; description: string }> = [
  { kind: "github-search", label: "GitHub search", description: "Pull requests or issues matching a GitHub search query." },
  { kind: "jira-jql", label: "Jira (JQL)", description: "Issues matching a JQL query on your Jira Cloud site." },
];

export const DEFAULT_SOURCES: Source[] = [
  {
    id: "my-prs",
    name: "My pull requests",
    kind: "github-search",
    query: "is:pr is:open author:@me archived:false",
    tags: ["my-prs"],
    doneWhenGone: false,
    enabled: true,
    projectId: null,
  },
  {
    id: "pr-reviews",
    name: "Review requests",
    kind: "github-search",
    query: "is:pr is:open user-review-requested:@me archived:false draft:false",
    tags: ["pr-reviews"],
    doneWhenGone: true,
    enabled: true,
    projectId: null,
  },
];

export const jiraIssueSchema = z.object({
  key: z.string(),
  url: z.string(),
  status: z.string(),
  /** Jira's status category: `new` (To Do), `indeterminate` (In Progress), `done`. */
  statusCategory: z.enum(["new", "indeterminate", "done", "undefined"]),
  issueType: z.string(),
  priority: z.string().nullable(),
  assignee: z.string().nullable(),
  updatedAt: z.string(),
});
export type JiraIssue = z.infer<typeof jiraIssueSchema>;
export const prStateSchema = z.enum(["open", "draft", "merged", "closed"]);

export const pullRequestSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  role: prRoleSchema,
  state: prStateSchema,
  author: z.string(),
  updatedAt: z.string(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const reviewApplySchema = z.object({
  threadId: z.string(),
  startedAt: z.number(),
  /** Set by `bb kanban review-applied` once the fixes are committed and pushed. */
  completedAt: z.number().nullable(),
  pushedCommit: z.string().nullable(),
  /** Finding ids handed to the apply round; null when a free-form review was passed whole. */
  findingIds: z.array(z.string()).nullable(),
  /** Whether the run was asked to push; `pushedCommit` is then the pushed sha, otherwise the local commit. */
  push: z.boolean(),
});

export const findingSeveritySchema = z.enum(["critical", "important", "minor"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const findingSchema = z.object({
  id: z.string(),
  severity: findingSeveritySchema,
  title: z.string(),
  description: z.string().default(""),
  fix: z.string().nullable().default(null),
  locations: z
    .array(
      z.object({
        file: z.string(),
        startLine: z.number().int().nullable().default(null),
        endLine: z.number().int().nullable().default(null),
      }),
    )
    .default([]),
  flaggedBy: z.array(z.string()).default([]),
  category: z.string().nullable().default(null),
  /** 1–5: how much it matters to fix before merge. */
  importance: z.number().int().min(1).max(5).nullable().default(null),
  /** 1–5: how well the fix stays inside the PR's scope (1 = separate piece of work). */
  scopeFit: z.number().int().min(1).max(5).nullable().default(null),
});
export type Finding = z.infer<typeof findingSchema>;

/**
 * Pre-selection for the apply round. Critical always; otherwise both scores
 * must clear 3 so low-value or scope-expanding fixes stay unticked. Unscored
 * reports fall back to severity.
 */
export function defaultSelected(finding: Finding): boolean {
  if (finding.severity === "critical") return true;
  if (finding.importance !== null && finding.scopeFit !== null) {
    return finding.importance >= 3 && finding.scopeFit >= 3;
  }
  return finding.severity === "important";
}

export const selectionSchema = z.record(z.string(), z.boolean());

/** The machine-readable report the code-review skill appends as a ```json review-findings block. */
export const reviewReportSchema = z.object({
  version: z.number().int(),
  summary: z.string().default(""),
  commit: z.string().nullable().default(null),
  range: z.string().nullable().default(null),
  reviewers: z.array(z.string()).default([]),
  skippedReviewers: z.array(z.object({ name: z.string(), reason: z.string().default("") })).default([]),
  skippedFiles: z.array(z.string()).default([]),
  findings: z.array(findingSchema),
});
export type ReviewReport = z.infer<typeof reviewReportSchema>;

export const severityCountsSchema = z.object({
  critical: z.number().int(),
  important: z.number().int(),
  minor: z.number().int(),
});
export type SeverityCounts = z.infer<typeof severityCountsSchema>;

const REPORT_BLOCK = /```json\s+review-findings\s*\n([\s\S]*?)\n```/u;

/** Pulls the structured report out of a review body; null when absent or malformed. */
export function parseReviewReport(body: string | null): ReviewReport | null {
  if (body === null) return null;
  const match = REPORT_BLOCK.exec(body);
  if (match === null) return null;
  try {
    const parsed = reviewReportSchema.safeParse(JSON.parse(match[1]!));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Ticket-level roll-up of the per-finding scores: the worst importance and the typical scope fit. */
export const reviewScoresSchema = z.object({
  maxImportance: z.number().int().min(1).max(5),
  meanScopeFit: z.number().min(1).max(5),
  /** Mean importance, for sorting and tooltips. */
  meanImportance: z.number().min(1).max(5),
  scored: z.number().int(),
});
export type ReviewScores = z.infer<typeof reviewScoresSchema>;

export function rollupScores(report: ReviewReport | null): ReviewScores | null {
  if (report === null) return null;
  const scored = report.findings.filter(
    (finding): finding is Finding & { importance: number; scopeFit: number } =>
      finding.importance !== null && finding.scopeFit !== null,
  );
  if (scored.length === 0) return null;
  const mean = (values: number[]) => Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
  return {
    maxImportance: Math.max(...scored.map((finding) => finding.importance)),
    meanScopeFit: mean(scored.map((finding) => finding.scopeFit)),
    meanImportance: mean(scored.map((finding) => finding.importance)),
    scored: scored.length,
  };
}

export function countSeverities(report: ReviewReport | null): SeverityCounts | null {
  if (report === null) return null;
  const counts: SeverityCounts = { critical: 0, important: 0, minor: 0 };
  for (const finding of report.findings) counts[finding.severity] += 1;
  return counts;
}

/** One persisted code review of a PR card. `body` is the compiled findings. */
export const reviewSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  threadId: z.string(),
  /** `failed`: the thread went idle without recording a commit or producing a report (setup problems, usually). */
  status: z.enum(["running", "completed", "failed"]),
  /** PR head commit that was reviewed; the next review diffs from here. */
  commitSha: z.string().nullable(),
  baseRef: z.string().nullable(),
  headRef: z.string().nullable(),
  /** Commit the previous review ended at, when this was an incremental review. */
  sinceCommitSha: z.string().nullable(),
  body: z.string().nullable(),
  /** Parsed from the body's review-findings block; null for free-form reviews. */
  report: reviewReportSchema.nullable(),
  /** Effective per-finding selection for the apply round: user overrides merged over the heuristic. */
  selection: selectionSchema,
  /** Only the findings the user explicitly toggled. */
  selectionOverrides: selectionSchema,
  createdAt: z.number(),
  completedAt: z.number().nullable(),
  apply: reviewApplySchema.nullable(),
});
export type Review = z.infer<typeof reviewSchema>;
export const reviewSummarySchema = reviewSchema
  .omit({ body: true, report: true, selection: true, selectionOverrides: true })
  .extend({
    hasBody: z.boolean(),
    counts: severityCountsSchema.nullable(),
    selectedCount: z.number().int().nullable(),
    scores: reviewScoresSchema.nullable(),
  });
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

export const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  columnId: z.string(),
  kind: z.enum(["pr", "jira", "adhoc"]),
  tags: z.array(z.string()),
  /** The source that created the card, or null for ad hoc cards. */
  sourceId: z.string().nullable(),
  threadId: z.string().nullable(),
  /** Thread of the latest review, if one was started. */
  reviewThreadId: z.string().nullable(),
  latestReview: reviewSummarySchema.nullable(),
  /** PR comment counts: everything synced, and the ones not yet marked addressed. */
  comments: z.object({ total: z.number().int(), open: z.number().int(), selected: z.number().int() }).nullable(),
  /** Parent card when this is a subtask; null for top-level cards. */
  parentId: z.string().nullable(),
  /** Subtask progress: how many children exist and how many are in the done column. */
  children: z.object({ total: z.number().int(), done: z.number().int(), withThread: z.number().int() }),
  /** Comments the user left on the card's diff that have not been submitted for addressing yet. */
  pendingDiffComments: z.number().int(),
  /** Whether submitting diff comments may post them to the GitHub PR (the PR carries the review tag). */
  canPostToGithub: z.boolean(),
  projectId: z.string().nullable(),
  pr: pullRequestSchema.nullable(),
  jira: jiraIssueSchema.nullable(),
  position: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const syncStatusSchema = z.object({
  lastSyncAt: z.number().nullable(),
  lastError: z.string().nullable(),
  login: z.string().nullable(),
  tokenSource: z.enum(["setting", "gh-cli", "none"]),
  /** Jira Cloud site URL when the Jira settings are complete, else null. */
  jiraSite: z.string().nullable(),
  inProgress: z.boolean(),
});
export type SyncStatus = z.infer<typeof syncStatusSchema>;

/** What the planning agent proposes from a brain dump: tickets plus the questions it could not resolve. */
export const proposedTicketSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  subtasks: z.array(z.object({ title: z.string().min(1), description: z.string().default("") })).default([]),
  dependsOn: z.array(z.string()).default([]),
  estimate: z.enum(["S", "M", "L"]).nullable().default(null),
});
export type ProposedTicket = z.infer<typeof proposedTicketSchema>;
export const proposalQuestionSchema = z.object({
  id: z.string(),
  question: z.string().min(1),
  why: z.string().default(""),
  affects: z.array(z.string()).default([]),
  options: z.array(z.string()).default([]),
});
export const proposalSchema = z.object({
  version: z.number().int(),
  summary: z.string().default(""),
  tickets: z.array(proposedTicketSchema),
  questions: z.array(proposalQuestionSchema).default([]),
});
export type Proposal = z.infer<typeof proposalSchema>;

const PROPOSAL_BLOCK = /```json\s+kanban-proposal\s*\n([\s\S]*?)\n```/u;
export function parseProposal(body: string | null): Proposal | null {
  if (body === null) return null;
  const match = PROPOSAL_BLOCK.exec(body);
  if (match === null) return null;
  try {
    const parsed = proposalSchema.safeParse(JSON.parse(match[1]!));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const dumpStatusSchema = z.enum(["planning", "ready", "failed", "done", "discarded"]);
export const dumpSchema = z.object({
  id: z.string(),
  text: z.string(),
  projectId: z.string(),
  threadId: z.string().nullable(),
  status: dumpStatusSchema,
  proposal: proposalSchema.nullable(),
  /** The user's answers keyed by question id, from the last refine round. */
  answers: z.record(z.string(), z.string()),
  /** Ids of tickets created when the dump was finalized. */
  createdTicketIds: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Dump = z.infer<typeof dumpSchema>;

export const boardSchema = z.object({
  columns: z.array(columnSchema),
  tickets: z.array(ticketSchema),
  sources: z.array(sourceSchema),
  /** Every tag in use, sorted. */
  tags: z.array(z.string()),
  sync: syncStatusSchema,
  /** Brain dumps still in flight or awaiting review (planning, ready, failed). */
  dumps: z.array(dumpSchema),
});
export type Board = z.infer<typeof boardSchema>;

export const prCommentKindSchema = z.enum(["review-comment", "review", "issue-comment"]);
export const prCommentSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  kind: prCommentKindSchema,
  githubId: z.number(),
  author: z.string(),
  /** True when `author` is the signed-in user; such comments are not selected by default. */
  mine: z.boolean(),
  body: z.string(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  reviewState: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Effective selection for the apply round. */
  selected: z.boolean(),
  /** Set when the user toggled the checkbox, overriding the default. */
  selectionOverride: z.boolean().nullable(),
  addressedAt: z.number().nullable(),
});
export type PrComment = z.infer<typeof prCommentSchema>;

export const commentApplySchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  threadId: z.string(),
  commentIds: z.array(z.string()),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  pushedCommit: z.string().nullable(),
  push: z.boolean(),
});
export type CommentApply = z.infer<typeof commentApplySchema>;

export const diffFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** Unified patch for this one file; null for binary or oversized files. */
  patch: z.string().nullable(),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const ticketDiffSchema = z.object({
  source: z.enum(["pr", "environment", "none"]),
  files: z.array(diffFileSchema),
  /** What the diff was taken against: the PR base branch or the environment's merge base. */
  baseRef: z.string().nullable(),
  headSha: z.string().nullable(),
  truncated: z.boolean(),
  message: z.string().nullable(),
  fetchedAt: z.number(),
});
export type TicketDiff = z.infer<typeof ticketDiffSchema>;

/** A comment the user left on the card's diff. Posted to GitHub and/or handed to an apply thread on submit. */
export const diffSideSchema = z.enum(["LEFT", "RIGHT"]);
export const diffCommentSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  /** Which side of the diff the line number refers to: RIGHT = new file (default), LEFT = removed line. */
  side: diffSideSchema,
  body: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  postedAt: z.number().nullable(),
  postedUrl: z.string().nullable(),
  addressedAt: z.number().nullable(),
  applyId: z.string().nullable(),
});
export type DiffComment = z.infer<typeof diffCommentSchema>;

export const rpcContract = defineRpcContract({
  board_get: { input: z.null(), output: boardSchema },
  ticket_create: {
    input: z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(10_000).default(""),
        columnId: z.string().optional(),
        tags: z.array(tagSchema).max(20).default([]),
        projectId: z.string().nullable().default(null),
        startThread: z.boolean().default(false),
        /** Create the card as a subtask of this card. */
        parentId: z.string().nullable().default(null),
      })
      .strict(),
    output: ticketSchema,
  },
  /** Start a background planning thread that turns a ramble into proposed tickets. */
  dump_create: {
    input: z.object({ text: z.string().trim().min(1).max(50_000), projectId: z.string() }).strict(),
    output: dumpSchema,
  },
  dumps_list: {
    input: z.object({ includeClosed: z.boolean().default(false) }).strict(),
    output: z.object({ dumps: z.array(dumpSchema) }),
  },
  /** Send answers and notes back to the planning thread for a revised proposal. */
  dump_refine: {
    input: z.object({ id: z.string(), answers: z.record(z.string(), z.string()).default({}), notes: z.string().max(10_000).default("") }).strict(),
    output: dumpSchema,
  },
  /** Create cards from the (possibly edited) proposal. */
  dump_finalize: {
    input: z
      .object({
        id: z.string(),
        tickets: z.array(proposedTicketSchema).min(1),
        columnId: z.string().optional(),
        startThreads: z.boolean().default(false),
      })
      .strict(),
    output: z.object({ dump: dumpSchema, tickets: z.array(ticketSchema) }),
  },
  dump_discard: {
    input: z.object({ id: z.string() }).strict(),
    output: dumpSchema,
  },
  ticket_set_parent: {
    input: z.object({ id: z.string(), parentId: z.string().nullable() }).strict(),
    output: ticketSchema,
  },
  /** Ask an agent to split the card into subtasks (uses the card's thread, or starts one). */
  ticket_breakdown: {
    input: z.object({ id: z.string(), projectId: z.string().nullable().default(null), guidance: z.string().max(4000).default("") }).strict(),
    output: ticketSchema,
  },
  /** Start work on every open subtask: one thread per subtask, or one thread working through them in order. */
  ticket_start_children: {
    input: z.object({ id: z.string(), mode: z.enum(["parallel", "sequential"]).default("parallel"), projectId: z.string().nullable().default(null) }).strict(),
    output: z.object({ ticket: ticketSchema, started: z.number().int(), skipped: z.number().int() }),
  },
  ticket_set_tags: {
    input: z.object({ id: z.string(), tags: z.array(tagSchema).max(20) }).strict(),
    output: ticketSchema,
  },
  sources_set: {
    input: z.object({ sources: z.array(sourceSchema).max(20) }).strict(),
    output: z.object({ sources: z.array(sourceSchema) }),
  },
  ticket_update: {
    input: z
      .object({
        id: z.string(),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(10_000).optional(),
      })
      .strict(),
    output: ticketSchema,
  },
  ticket_move: {
    input: z
      .object({
        id: z.string(),
        columnId: z.string(),
        index: z.number().int().min(0).nullable().default(null),
      })
      .strict(),
    output: ticketSchema,
  },
  ticket_delete: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  ticket_start_thread: {
    input: z.object({ id: z.string(), projectId: z.string() }).strict(),
    output: ticketSchema,
  },
  diff_get: {
    input: z.object({ ticketId: z.string(), refresh: z.boolean().default(false) }).strict(),
    output: ticketDiffSchema,
  },
  diff_comments_list: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ comments: z.array(diffCommentSchema) }),
  },
  diff_comment_add: {
    input: z
      .object({
        ticketId: z.string(),
        path: z.string().min(1),
        line: z.number().int().min(1).nullable().default(null),
        side: diffSideSchema.default("RIGHT"),
        body: z.string().trim().min(1).max(10_000),
      })
      .strict(),
    output: diffCommentSchema,
  },
  diff_comment_update: {
    input: z.object({ id: z.string(), body: z.string().trim().min(1).max(10_000), line: z.number().int().min(1).nullable().optional() }).strict(),
    output: diffCommentSchema,
  },
  diff_comment_delete: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  diff_comments_submit: {
    input: z
      .object({
        ticketId: z.string(),
        /** Post the pending comments to the GitHub PR as one review (only allowed for PRs carrying the review tag). */
        postToGithub: z.boolean().default(false),
        /** Start a thread that addresses the pending comments. */
        address: z.boolean().default(true),
        autoApprove: z.boolean().default(false),
        push: z.boolean().default(true),
      })
      .strict(),
    output: z.object({ posted: z.number().int(), postedUrl: z.string().nullable(), apply: commentApplySchema.nullable(), ticket: ticketSchema }),
  },
  comments_list: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ comments: z.array(prCommentSchema), applies: z.array(commentApplySchema) }),
  },
  comment_set_selected: {
    input: z.object({ id: z.string(), selected: z.boolean().nullable() }).strict(),
    output: prCommentSchema,
  },
  comment_set_addressed: {
    input: z.object({ id: z.string(), addressed: z.boolean() }).strict(),
    output: prCommentSchema,
  },
  comments_apply: {
    input: z.object({ ticketId: z.string(), autoApprove: z.boolean().default(false), push: z.boolean().default(true) }).strict(),
    output: z.object({ ticket: ticketSchema, apply: commentApplySchema }),
  },
  ticket_review_pr: {
    input: z
      .object({
        id: z.string(),
        projectId: z.string().nullable().default(null),
        /** `incremental` reviews only commits since the last completed review; falls back to full. */
        mode: z.enum(["full", "incremental"]).default("incremental"),
      })
      .strict(),
    output: ticketSchema,
  },
  review_list: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ reviews: z.array(reviewSchema) }),
  },
  review_set_selection: {
    input: z.object({ reviewId: z.string(), findingId: z.string(), selected: z.boolean() }).strict(),
    output: reviewSchema,
  },
  review_reset_selection: {
    input: z.object({ reviewId: z.string() }).strict(),
    output: reviewSchema,
  },
  review_apply: {
    input: z
      .object({
        ticketId: z.string(),
        reviewId: z.string().nullable().default(null),
        /** Skip the apply-review skill's triage confirmation and apply every finding. */
        autoApprove: z.boolean().default(false),
        /** Push the resulting commit to the PR branch; otherwise commit locally in the worktree. */
        push: z.boolean().default(true),
      })
      .strict(),
    output: ticketSchema,
  },
  ticket_link_thread: {
    input: z.object({ id: z.string(), threadId: z.string() }).strict(),
    output: ticketSchema,
  },
  columns_set: {
    input: z.object({ columns: z.array(columnSchema).min(1).max(12) }).strict(),
    output: z.object({ columns: z.array(columnSchema) }),
  },
  sync_now: { input: z.null(), output: syncStatusSchema },
});

/** Realtime channel: the board changed, refetch. */
export const BOARD_CHANGED = "board-changed";

export const DEFAULT_COLUMNS: Column[] = [
  { id: "backlog", name: "Backlog" },
  { id: "todo", name: "To Do" },
  { id: "in-progress", name: "In Progress" },
  { id: "review", name: "In Review" },
  { id: "done", name: "Done" },
];

// ---------------------------------------------------------------------------
// GitHub API shapes (only the fields read)
// ---------------------------------------------------------------------------

interface GithubSearchItem {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  user: { login: string } | null;
  updated_at: string;
  repository_url: string;
  pull_request?: { merged_at: string | null };
}

interface GithubUser {
  login: string;
}
interface GithubIssueComment {
  id: number;
  user: GithubUser | null;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}
interface GithubReviewComment extends GithubIssueComment {
  path: string;
  line: number | null;
  original_line: number | null;
  in_reply_to_id?: number;
}
interface GithubReview {
  id: number;
  user: GithubUser | null;
  body: string | null;
  state: string;
  html_url: string;
  submitted_at?: string;
}

interface GithubPullFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GithubPull {
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  html_url: string;
  updated_at: string;
  user: { login: string } | null;
}


interface JiraSearchIssue {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    updated: string;
    status: { name: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    priority?: { name?: string } | null;
    assignee?: { displayName?: string; emailAddress?: string } | null;
  };
}

/** Atlassian Document Format → plain text, enough for a card description. */
export function adfToText(node: unknown): string {
  if (node === null || typeof node !== "object") return "";
  const { type, text, content } = node as { type?: string; text?: string; content?: unknown[] };
  if (type === "text") return text ?? "";
  if (type === "hardBreak") return "\n";
  const inner = Array.isArray(content) ? content.map(adfToText).join("") : "";
  switch (type) {
    case "paragraph":
    case "heading":
      return `${inner}\n\n`;
    case "listItem":
      return `- ${inner.trim()}\n`;
    case "codeBlock":
      return `\n\`\`\`\n${inner}\n\`\`\`\n`;
    default:
      return inner;
  }
}

function jiraCategory(key: string | undefined): JiraIssue["statusCategory"] {
  return key === "new" || key === "indeterminate" || key === "done" ? key : "undefined";
}

/** Split one unified diff (as `git diff` prints it) into per-file patches. */
export function splitUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = diff.split(/^(?=diff --git )/mu).filter((chunk) => chunk.trim() !== "");
  for (const chunk of chunks) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/mu.exec(chunk);
    const plus = /^\+\+\+ (?:b\/)?(.+)$/mu.exec(chunk)?.[1] ?? null;
    const minus = /^--- (?:a\/)?(.+)$/mu.exec(chunk)?.[1] ?? null;
    const path = plus !== null && plus !== "/dev/null" ? plus : (header?.[2] ?? minus ?? "unknown");
    const previousPath = header !== null && header[1] !== header[2] ? header[1] : null;
    const status =
      minus === "/dev/null" || /^new file mode/mu.test(chunk)
        ? "added"
        : plus === "/dev/null" || /^deleted file mode/mu.test(chunk)
          ? "removed"
          : previousPath !== null
            ? "renamed"
            : "modified";
    let additions = 0;
    let deletions = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    const binary = /^Binary files /mu.test(chunk) || !/^@@/mu.test(chunk);
    files.push({ path, previousPath, status, additions, deletions, patch: binary ? null : chunk });
  }
  return files;
}

function repoFromRepositoryUrl(url: string): string {
  // https://api.github.com/repos/owner/repo
  return url.replace(/^https:\/\/api\.github\.com\/repos\//u, "").toLowerCase();
}

/** `git@github.com:owner/repo.git` and friends → `owner/repo`, or null. */
export function githubRepoFromRemote(remote: string | null): string | null {
  if (remote === null) return null;
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(
    remote.trim(),
  );
  if (match === null) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function prStateOf(item: {
  state: "open" | "closed";
  draft?: boolean;
  merged: boolean;
}): PullRequest["state"] {
  if (item.merged) return "merged";
  if (item.state === "closed") return "closed";
  return item.draft === true ? "draft" : "open";
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

interface TicketRow {
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
  jira_key: string | null;
  jira_url: string | null;
  jira_status: string | null;
  jira_status_category: string | null;
  jira_issue_type: string | null;
  jira_priority: string | null;
  jira_assignee: string | null;
  jira_updated_at: string | null;
  comments_synced_for: string | null;
  parent_id: string | null;
  position: number;
  created_at: number;
  updated_at: number;
}

interface ReviewRow {
  id: string;
  ticket_id: string;
  thread_id: string;
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
  selection_overrides: string | null;
}

interface PrCommentRow {
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
  url: string;
  created_at: string;
  updated_at: string;
  selected: number | null;
  addressed_at: number | null;
}

interface DiffCommentRow {
  id: string;
  ticket_id: string;
  path: string;
  line: number | null;
  side: string | null;
  body: string;
  created_at: number;
  updated_at: number;
  posted_at: number | null;
  posted_url: string | null;
  addressed_at: number | null;
  apply_id: string | null;
}

function rowToDiffComment(row: DiffCommentRow): DiffComment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    path: row.path,
    line: row.line,
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    postedAt: row.posted_at,
    postedUrl: row.posted_url,
    addressedAt: row.addressed_at,
    applyId: row.apply_id,
  };
}

interface DumpRow {
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

function rowToDump(row: DumpRow): Dump {
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
    createdTicketIds: parseTags(row.created_ticket_ids),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface CommentApplyRow {
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

function rowToComment(row: PrCommentRow): PrComment {
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
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    selected: row.selected === null ? commentSelectedByDefault(row) : row.selected === 1,
    selectionOverride: row.selected === null ? null : row.selected === 1,
    addressedAt: row.addressed_at,
  };
}

function rowToCommentApply(row: CommentApplyRow): CommentApply {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    threadId: row.thread_id,
    commentIds: parseTags(row.comment_ids),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    pushedCommit: row.pushed_commit,
    push: row.push !== 0,
  };
}

function parseSelection(raw: string | null): Record<string, boolean> {
  try {
    const parsed = selectionSchema.safeParse(JSON.parse(raw ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function effectiveSelection(report: ReviewReport | null, overrides: Record<string, boolean>): Record<string, boolean> {
  if (report === null) return {};
  return Object.fromEntries(report.findings.map((finding) => [finding.id, overrides[finding.id] ?? defaultSelected(finding)]));
}

function rowToReview(row: ReviewRow): Review {
  const report = parseReviewReport(row.body);
  const selectionOverrides = parseSelection(row.selection_overrides);
  return {
    id: row.id,
    ticketId: row.ticket_id,
    threadId: row.thread_id,
    status: row.status,
    commitSha: row.commit_sha,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    sinceCommitSha: row.since_commit_sha,
    body: row.body,
    report,
    selection: effectiveSelection(report, selectionOverrides),
    selectionOverrides,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    apply:
      row.apply_thread_id !== null && row.apply_started_at !== null
        ? {
            threadId: row.apply_thread_id,
            startedAt: row.apply_started_at,
            completedAt: row.apply_completed_at,
            pushedCommit: row.apply_pushed_commit,
            findingIds: row.apply_finding_ids === null ? null : parseTags(row.apply_finding_ids),
            push: row.apply_push !== 0,
          }
        : null,
  };
}

function summarize(review: Review): ReviewSummary {
  const { body, report, selection, selectionOverrides, ...rest } = review;
  return {
    ...rest,
    hasBody: body !== null && body.trim() !== "",
    counts: countSeverities(report),
    selectedCount: report === null ? null : Object.values(selection).filter(Boolean).length,
    scores: rollupScores(report),
  };
}

/** The review body trimmed to the selected findings, so the apply round never sees deselected ones. */
function selectedFindingsBody(review: Review): { body: string; findingIds: string[] | null } {
  const { report } = review;
  if (report === null) return { body: review.body ?? "(the review body is empty; open the review thread for details)", findingIds: null };
  const selected = report.findings.filter((finding) => review.selection[finding.id] === true);
  const bySeverity = (["critical", "important", "minor"] as const)
    .map((severity) => ({ severity, findings: selected.filter((finding) => finding.severity === severity) }))
    .filter((group) => group.findings.length > 0);
  const headings: Record<FindingSeverity, string> = {
    critical: "### Critical (Must Fix)",
    important: "### Important (Should Fix)",
    minor: "### Minor (Nice to Fix)",
  };
  const lines: string[] = ["## Change Summary", report.summary, "", "## Selected findings", ""];
  lines.push(
    `${selected.length} of ${report.findings.length} findings were selected on the Kanban board; the rest were deliberately left out. Apply only these.`,
    "",
  );
  for (const { severity, findings } of bySeverity) {
    lines.push(headings[severity]);
    for (const finding of findings) {
      const scores = finding.importance === null || finding.scopeFit === null ? "" : ` (importance ${finding.importance}, scope ${finding.scopeFit})`;
      const where = finding.locations
        .map((location) =>
          location.startLine === null
            ? location.file
            : location.endLine === null || location.endLine === location.startLine
              ? `${location.file}:${location.startLine}`
              : `${location.file}:${location.startLine}-${location.endLine}`,
        )
        .map((label) => `\`${label}\``)
        .join(", ");
      const fix = finding.fix === null || finding.fix === "" ? "" : ` — ${finding.fix}`;
      lines.push(`- **${finding.id}**${scores} ${where} — ${finding.title}. ${finding.description}${fix} (flagged by: ${finding.flaggedBy.join(", ")})`);
    }
    lines.push("");
  }
  lines.push("```json review-findings", JSON.stringify({ ...report, findings: selected }, null, 2), "```");
  return { body: lines.join("\n"), findingIds: selected.map((finding) => finding.id) };
}

/** The agent ends its final message with this so the reviewed commit survives even if it skipped `review-record`. */
const REVIEWED_COMMIT_LINE = /Reviewed commit:\s*([0-9a-f]{7,40})/iu;

function parseTags(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ""))].sort();
}

function rowToTicket(
  row: TicketRow,
  latestReview: Review | null,
  comments: Ticket["comments"] = null,
  extras: { pendingDiffComments: number; canPostToGithub: boolean; children: Ticket["children"] } = {
    pendingDiffComments: 0,
    canPostToGithub: false,
    children: { total: 0, done: 0, withThread: 0 },
  },
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
        }
      : null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    columnId: row.column_id,
    kind: row.kind,
    tags: parseTags(row.tags),
    sourceId: row.source_id,
    threadId: row.thread_id,
    reviewThreadId: latestReview?.threadId ?? row.review_thread_id,
    latestReview: latestReview === null ? null : summarize(latestReview),
    comments,
    parentId: row.parent_id,
    children: extras.children,
    pendingDiffComments: extras.pendingDiffComments,
    canPostToGithub: extras.canPostToGithub,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    githubToken: {
      type: "string",
      label: "GitHub token",
      description:
        "Personal access token with repo read scope. Leave empty to use the token from `gh auth token`.",
      secret: true,
    },
    jiraSiteUrl: {
      type: "string",
      label: "Jira site URL",
      description: "Your Jira Cloud site, e.g. https://your-org.atlassian.net. Needed only for Jira sources.",
      default: "",
    },
    jiraEmail: {
      type: "string",
      label: "Jira account email",
      description: "The Atlassian account the API token belongs to.",
      default: "",
    },
    jiraApiToken: {
      type: "string",
      label: "Jira API token",
      description: "Create one at id.atlassian.com → Security → API tokens.",
      secret: true,
    },
    syncIntervalMinutes: {
      type: "number",
      label: "GitHub sync interval (minutes)",
      experimental_schema: z.number().int().min(1).max(240),
      default: 5,
    },
    autoStartThreads: {
      type: "boolean",
      label: "Start a thread for each new pull request card",
      description:
        "When on, a thread is spawned in the matching project as soon as a PR card is created. The agent briefs itself on the PR and waits.",
      default: true,
    },
    defaultProject: {
      type: "project",
      label: "Fallback project",
      description:
        "Used for PR cards whose repository does not match any project's git remote, and as the default for ad hoc tickets.",
    },
    reviewTag: {
      type: "string",
      label: "Review tag",
      description: "Diff comments on PR cards carrying this tag can be posted to the GitHub PR as a review.",
      default: "pr-reviews",
    },
    autoMoveOnActivity: {
      type: "boolean",
      label: "Move cards to In Progress when their thread starts working",
      default: true,
    },
  });

  // ---- storage -----------------------------------------------------------

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      column_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      thread_id TEXT,
      project_id TEXT,
      pr_repo TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      pr_role TEXT,
      pr_state TEXT,
      pr_author TEXT,
      pr_updated_at TEXT,
      position REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS tickets_pr ON tickets(pr_repo, pr_number) WHERE pr_repo IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS tickets_thread ON tickets(thread_id)`,
    `CREATE INDEX IF NOT EXISTS tickets_column ON tickets(column_id, position)`,
    `ALTER TABLE tickets ADD COLUMN review_thread_id TEXT`,
    `CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      commit_sha TEXT,
      base_ref TEXT,
      head_ref TEXT,
      since_commit_sha TEXT,
      body TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      apply_thread_id TEXT,
      apply_started_at INTEGER,
      apply_completed_at INTEGER,
      apply_pushed_commit TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS reviews_ticket ON reviews(ticket_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS reviews_thread ON reviews(thread_id)`,
    `CREATE INDEX IF NOT EXISTS reviews_apply_thread ON reviews(apply_thread_id)`,
    `ALTER TABLE tickets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tickets ADD COLUMN source_id TEXT`,
    `UPDATE tickets SET
       source_id = CASE pr_role WHEN 'authored' THEN 'my-prs' WHEN 'review-requested' THEN 'pr-reviews' ELSE source_id END,
       tags = CASE pr_role WHEN 'authored' THEN '["my-prs"]' WHEN 'review-requested' THEN '["pr-reviews"]' ELSE tags END,
       pr_role = CASE pr_role WHEN 'review-requested' THEN 'other' ELSE pr_role END
     WHERE kind = 'pr'`,
    `ALTER TABLE reviews ADD COLUMN selection_overrides TEXT`,
    `ALTER TABLE reviews ADD COLUMN apply_finding_ids TEXT`,
    `ALTER TABLE tickets ADD COLUMN jira_key TEXT`,
    `ALTER TABLE tickets ADD COLUMN jira_url TEXT`,
    `ALTER TABLE tickets ADD COLUMN jira_status TEXT`,
    `ALTER TABLE tickets ADD COLUMN jira_status_category TEXT`,
    `ALTER TABLE tickets ADD COLUMN jira_issue_type TEXT`,
    `ALTER TABLE tickets ADD COLUMN jira_priority TEXT`,
    `ALTER TABLE tickets ADD COLUMN jira_assignee TEXT`,
    `ALTER TABLE tickets ADD COLUMN jira_updated_at TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS tickets_jira ON tickets(jira_key) WHERE jira_key IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS pr_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      github_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      mine INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL,
      path TEXT,
      line INTEGER,
      review_state TEXT,
      in_reply_to TEXT,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      selected INTEGER,
      addressed_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS pr_comments_ticket ON pr_comments(ticket_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS comment_applies (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      comment_ids TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      pushed_commit TEXT,
      push INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE INDEX IF NOT EXISTS comment_applies_ticket ON comment_applies(ticket_id, started_at)`,
    `ALTER TABLE tickets ADD COLUMN comments_synced_for TEXT`,
    `ALTER TABLE reviews ADD COLUMN apply_push INTEGER`,
    `CREATE TABLE IF NOT EXISTS diff_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      path TEXT NOT NULL,
      line INTEGER,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      posted_at INTEGER,
      posted_url TEXT,
      addressed_at INTEGER,
      apply_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS diff_comments_ticket ON diff_comments(ticket_id, created_at)`,
    `ALTER TABLE diff_comments ADD COLUMN side TEXT NOT NULL DEFAULT 'RIGHT'`,
    `ALTER TABLE tickets ADD COLUMN parent_id TEXT`,
    `CREATE INDEX IF NOT EXISTS tickets_parent ON tickets(parent_id)`,
    `CREATE TABLE IF NOT EXISTS dumps (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      proposal_json TEXT,
      answers_json TEXT,
      created_ticket_ids TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS dumps_thread ON dumps(thread_id)`,
  ]);

  const stmts = {
    all: db.prepare<[], TicketRow>(
      `SELECT * FROM tickets ORDER BY column_id, position, created_at`,
    ),
    byId: db.prepare<[string], TicketRow>(`SELECT * FROM tickets WHERE id = ?`),
    byThread: db.prepare<[string], TicketRow>(
      `SELECT * FROM tickets WHERE thread_id = ? LIMIT 1`,
    ),
    byPr: db.prepare<[string, number], TicketRow>(
      `SELECT * FROM tickets WHERE pr_repo = ? AND pr_number = ?`,
    ),
    openPrs: db.prepare<[], TicketRow>(
      `SELECT * FROM tickets WHERE kind = 'pr' AND pr_state IN ('open', 'draft')`,
    ),
    inColumn: db.prepare<[string], TicketRow>(
      `SELECT * FROM tickets WHERE column_id = ? ORDER BY position, created_at`,
    ),
    maxPosition: db.prepare<[string], { max: number | null }>(
      `SELECT MAX(position) AS max FROM tickets WHERE column_id = ?`,
    ),
    insert: db.prepare(
      `INSERT INTO tickets (id, title, description, column_id, kind, tags, source_id, thread_id, project_id, parent_id,
         pr_repo, pr_number, pr_url, pr_role, pr_state, pr_author, pr_updated_at,
         jira_key, jira_url, jira_status, jira_status_category, jira_issue_type, jira_priority, jira_assignee, jira_updated_at,
         position, created_at, updated_at)
       VALUES (@id, @title, @description, @column_id, @kind, @tags, @source_id, @thread_id, @project_id, @parent_id,
         @pr_repo, @pr_number, @pr_url, @pr_role, @pr_state, @pr_author, @pr_updated_at,
         @jira_key, @jira_url, @jira_status, @jira_status_category, @jira_issue_type, @jira_priority, @jira_assignee, @jira_updated_at,
         @position, @created_at, @updated_at)`,
    ),
    setColumn: db.prepare<[string, number, number, string]>(
      `UPDATE tickets SET column_id = ?, position = ?, updated_at = ? WHERE id = ?`,
    ),
    setPosition: db.prepare<[number, string]>(
      `UPDATE tickets SET position = ? WHERE id = ?`,
    ),
    setThread: db.prepare<[string | null, string | null, number, string]>(
      `UPDATE tickets SET thread_id = ?, project_id = COALESCE(?, project_id), updated_at = ? WHERE id = ?`,
    ),
    clearThread: db.prepare<[number, string]>(
      `UPDATE tickets SET thread_id = NULL, updated_at = ? WHERE thread_id = ?`,
    ),
    setReviewThread: db.prepare<[string | null, number, string]>(
      `UPDATE tickets SET review_thread_id = ?, updated_at = ? WHERE id = ?`,
    ),
    clearReviewThread: db.prepare<[number, string]>(
      `UPDATE tickets SET review_thread_id = NULL, updated_at = ? WHERE review_thread_id = ?`,
    ),
    setText: db.prepare<[string, string, number, string]>(
      `UPDATE tickets SET title = ?, description = ?, updated_at = ? WHERE id = ?`,
    ),
    setPr: db.prepare<
      [string, string, PullRequest["state"], PullRequest["role"], string, string, number, string]
    >(
      `UPDATE tickets SET title = ?, pr_url = ?, pr_state = ?, pr_role = ?, pr_author = ?, pr_updated_at = ?, updated_at = ? WHERE id = ?`,
    ),
    setTags: db.prepare<[string, number, string]>(`UPDATE tickets SET tags = ?, updated_at = ? WHERE id = ?`),
    byJira: db.prepare<[string], TicketRow>(`SELECT * FROM tickets WHERE jira_key = ?`),
    openJira: db.prepare<[], TicketRow>(
      `SELECT * FROM tickets WHERE kind = 'jira' AND (jira_status_category IS NULL OR jira_status_category != 'done')`,
    ),
    setJira: db.prepare<[string, string, string, string, string, string | null, string | null, string, number, string]>(
      `UPDATE tickets SET title = ?, jira_url = ?, jira_status = ?, jira_status_category = ?, jira_issue_type = ?, jira_priority = ?, jira_assignee = ?, jira_updated_at = ?, updated_at = ? WHERE id = ?`,
    ),
    remove: db.prepare<[string]>(`DELETE FROM tickets WHERE id = ?`),
    moveColumn: db.prepare<[string, number, string]>(
      `UPDATE tickets SET column_id = ?, updated_at = ? WHERE column_id = ?`,
    ),
    reviewsForTicket: db.prepare<[string], ReviewRow>(
      `SELECT * FROM reviews WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC`,
    ),
    latestReview: db.prepare<[string], ReviewRow>(
      `SELECT * FROM reviews WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ),
    latestCompletedReview: db.prepare<[string], ReviewRow>(
      `SELECT * FROM reviews WHERE ticket_id = ? AND status = 'completed' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ),
    reviewById: db.prepare<[string], ReviewRow>(`SELECT * FROM reviews WHERE id = ?`),
    reviewByThread: db.prepare<[string], ReviewRow>(
      `SELECT * FROM reviews WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`,
    ),
    reviewByApplyThread: db.prepare<[string], ReviewRow>(
      `SELECT * FROM reviews WHERE apply_thread_id = ? ORDER BY created_at DESC LIMIT 1`,
    ),
    insertReview: db.prepare(
      `INSERT INTO reviews (id, ticket_id, thread_id, status, since_commit_sha, created_at)
       VALUES (@id, @ticket_id, @thread_id, 'running', @since_commit_sha, @created_at)`,
    ),
    recordReviewCommit: db.prepare<[string, string | null, string | null, string]>(
      `UPDATE reviews SET commit_sha = ?, base_ref = COALESCE(?, base_ref), head_ref = COALESCE(?, head_ref) WHERE id = ?`,
    ),
    completeReview: db.prepare<[string | null, string | null, number, string]>(
      `UPDATE reviews SET status = 'completed', body = ?, commit_sha = COALESCE(commit_sha, ?), completed_at = ? WHERE id = ?`,
    ),
    failReview: db.prepare<[string | null, number, string]>(
      `UPDATE reviews SET status = 'failed', body = ?, completed_at = ? WHERE id = ?`,
    ),
    startApply: db.prepare<[string, number, string | null, number, string]>(
      `UPDATE reviews SET apply_thread_id = ?, apply_started_at = ?, apply_finding_ids = ?, apply_push = ?, apply_completed_at = NULL, apply_pushed_commit = NULL WHERE id = ?`,
    ),
    setSelectionOverrides: db.prepare<[string | null, string]>(`UPDATE reviews SET selection_overrides = ? WHERE id = ?`),
    completeApply: db.prepare<[number, string | null, string]>(
      `UPDATE reviews SET apply_completed_at = ?, apply_pushed_commit = ? WHERE id = ?`,
    ),
    setApplyPushed: db.prepare<[string]>(`UPDATE reviews SET apply_push = 1 WHERE id = ?`),
    setCommentApplyPushed: db.prepare<[string]>(`UPDATE comment_applies SET push = 1 WHERE id = ?`),
    deleteReviewsForTicket: db.prepare<[string]>(`DELETE FROM reviews WHERE ticket_id = ?`),
    commentsForTicket: db.prepare<[string], PrCommentRow>(
      `SELECT * FROM pr_comments WHERE ticket_id = ? ORDER BY created_at, rowid`,
    ),
    commentById: db.prepare<[string], PrCommentRow>(`SELECT * FROM pr_comments WHERE id = ?`),
    upsertComment: db.prepare(
      `INSERT INTO pr_comments (id, ticket_id, kind, github_id, author, mine, body, path, line, review_state, in_reply_to, url, created_at, updated_at)
       VALUES (@id, @ticket_id, @kind, @github_id, @author, @mine, @body, @path, @line, @review_state, @in_reply_to, @url, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET author = excluded.author, mine = excluded.mine, body = excluded.body, path = excluded.path,
         line = excluded.line, review_state = excluded.review_state, url = excluded.url, updated_at = excluded.updated_at`,
    ),
    deleteStaleComments: db.prepare<[string, string]>(
      `DELETE FROM pr_comments WHERE ticket_id = ? AND id NOT IN (SELECT value FROM json_each(?))`,
    ),
    deleteCommentsForTicket: db.prepare<[string]>(`DELETE FROM pr_comments WHERE ticket_id = ?`),
    setCommentSelected: db.prepare<[number | null, string]>(`UPDATE pr_comments SET selected = ? WHERE id = ?`),
    setCommentAddressed: db.prepare<[number | null, string]>(`UPDATE pr_comments SET addressed_at = ? WHERE id = ?`),
    markCommentsAddressed: db.prepare<[number, string]>(
      `UPDATE pr_comments SET addressed_at = ?, selected = NULL WHERE id IN (SELECT value FROM json_each(?)) AND addressed_at IS NULL`,
    ),
    setCommentsSyncedFor: db.prepare<[string | null, string]>(`UPDATE tickets SET comments_synced_for = ? WHERE id = ?`),
    commentAppliesForTicket: db.prepare<[string], CommentApplyRow>(
      `SELECT * FROM comment_applies WHERE ticket_id = ? ORDER BY started_at DESC`,
    ),
    commentApplyByThread: db.prepare<[string], CommentApplyRow>(
      `SELECT * FROM comment_applies WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1`,
    ),
    commentApplyById: db.prepare<[string], CommentApplyRow>(`SELECT * FROM comment_applies WHERE id = ?`),
    insertCommentApply: db.prepare(
      `INSERT INTO comment_applies (id, ticket_id, thread_id, comment_ids, started_at, push) VALUES (@id, @ticket_id, @thread_id, @comment_ids, @started_at, @push)`,
    ),
    completeCommentApply: db.prepare<[number, string | null, string]>(
      `UPDATE comment_applies SET completed_at = ?, pushed_commit = ? WHERE id = ?`,
    ),
    deleteCommentAppliesForTicket: db.prepare<[string]>(`DELETE FROM comment_applies WHERE ticket_id = ?`),
    diffCommentsForTicket: db.prepare<[string], DiffCommentRow>(`SELECT * FROM diff_comments WHERE ticket_id = ? ORDER BY path, line, created_at`),
    pendingDiffComments: db.prepare<[string], DiffCommentRow>(
      `SELECT * FROM diff_comments WHERE ticket_id = ? AND addressed_at IS NULL AND apply_id IS NULL ORDER BY path, line, created_at`,
    ),
    pendingDiffCommentCount: db.prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM diff_comments WHERE ticket_id = ? AND addressed_at IS NULL AND apply_id IS NULL`,
    ),
    diffCommentById: db.prepare<[string], DiffCommentRow>(`SELECT * FROM diff_comments WHERE id = ?`),
    insertDiffComment: db.prepare(
      `INSERT INTO diff_comments (id, ticket_id, path, line, side, body, created_at, updated_at) VALUES (@id, @ticket_id, @path, @line, @side, @body, @created_at, @updated_at)`,
    ),
    updateDiffComment: db.prepare<[string, number | null, number, string]>(`UPDATE diff_comments SET body = ?, line = ?, updated_at = ? WHERE id = ?`),
    deleteDiffComment: db.prepare<[string]>(`DELETE FROM diff_comments WHERE id = ?`),
    deleteDiffCommentsForTicket: db.prepare<[string]>(`DELETE FROM diff_comments WHERE ticket_id = ?`),
    markDiffCommentPosted: db.prepare<[number, string | null, string]>(`UPDATE diff_comments SET posted_at = ?, posted_url = ? WHERE id = ?`),
    assignDiffCommentsApply: db.prepare<[string, string]>(
      `UPDATE diff_comments SET apply_id = ? WHERE id IN (SELECT value FROM json_each(?))`,
    ),
    markDiffCommentsAddressedByApply: db.prepare<[number, string]>(`UPDATE diff_comments SET addressed_at = ? WHERE apply_id = ? AND addressed_at IS NULL`),
    childrenOf: db.prepare<[string], TicketRow>(`SELECT * FROM tickets WHERE parent_id = ? ORDER BY position, created_at`),
    setParent: db.prepare<[string | null, number, string]>(`UPDATE tickets SET parent_id = ?, updated_at = ? WHERE id = ?`),
    detachChildren: db.prepare<[number, string]>(`UPDATE tickets SET parent_id = NULL, updated_at = ? WHERE parent_id = ?`),
    dumpsOpen: db.prepare<[], DumpRow>(`SELECT * FROM dumps WHERE status IN ('planning', 'ready', 'failed') ORDER BY created_at DESC`),
    dumpsAll: db.prepare<[], DumpRow>(`SELECT * FROM dumps ORDER BY created_at DESC LIMIT 200`),
    dumpById: db.prepare<[string], DumpRow>(`SELECT * FROM dumps WHERE id = ?`),
    dumpByThread: db.prepare<[string], DumpRow>(`SELECT * FROM dumps WHERE thread_id = ?`),
    insertDump: db.prepare(
      `INSERT INTO dumps (id, text, project_id, thread_id, status, created_at, updated_at) VALUES (@id, @text, @project_id, @thread_id, 'planning', @created_at, @updated_at)`,
    ),
    setDumpThread: db.prepare<[string, number, string]>(`UPDATE dumps SET thread_id = ?, updated_at = ? WHERE id = ?`),
    setDumpProposal: db.prepare<[string, number, string]>(`UPDATE dumps SET status = 'ready', proposal_json = ?, error = NULL, updated_at = ? WHERE id = ?`),
    setDumpFailed: db.prepare<[string, number, string]>(`UPDATE dumps SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`),
    setDumpPlanning: db.prepare<[string, number, string]>(`UPDATE dumps SET status = 'planning', answers_json = ?, error = NULL, updated_at = ? WHERE id = ?`),
    setDumpDone: db.prepare<[string, number, string]>(`UPDATE dumps SET status = 'done', created_ticket_ids = ?, updated_at = ? WHERE id = ?`),
    setDumpDiscarded: db.prepare<[number, string]>(`UPDATE dumps SET status = 'discarded', updated_at = ? WHERE id = ?`),
  };

  function latestReviewFor(ticketId: string): Review | null {
    const row = stmts.latestReview.get(ticketId);
    return row === undefined ? null : rowToReview(row);
  }

  function commentCounts(row: TicketRow): Ticket["comments"] {
    if (row.kind !== "pr") return null;
    const comments = stmts.commentsForTicket.all(row.id).map(rowToComment);
    return {
      total: comments.length,
      open: comments.filter((comment) => comment.addressedAt === null && !comment.mine).length,
      selected: comments.filter((comment) => comment.selected).length,
    };
  }

  let reviewTagCache = "pr-reviews";
  function canPostToGithub(row: TicketRow): boolean {
    return row.kind === "pr" && parseTags(row.tags).includes(reviewTagCache);
  }

  let doneColumnCache = "done";
  function childCounts(row: TicketRow): Ticket["children"] {
    const children = stmts.childrenOf.all(row.id);
    return {
      total: children.length,
      done: children.filter((child) => child.column_id === doneColumnCache).length,
      withThread: children.filter((child) => child.thread_id !== null).length,
    };
  }

  function hydrate(row: TicketRow): Ticket {
    return rowToTicket(row, latestReviewFor(row.id), commentCounts(row), {
      pendingDiffComments: stmts.pendingDiffCommentCount.get(row.id)?.n ?? 0,
      canPostToGithub: canPostToGithub(row),
      children: childCounts(row),
    });
  }

  /** Walk up from `parentId`; true when `id` is an ancestor (or the same card), which would make a cycle. */
  function wouldCycle(id: string, parentId: string): boolean {
    let current: string | null = parentId;
    for (let depth = 0; current !== null && depth < 64; depth += 1) {
      if (current === id) return true;
      current = stmts.byId.get(current)?.parent_id ?? null;
    }
    return false;
  }

  function setParent(id: string, parentId: string | null): Ticket {
    getTicket(id);
    if (parentId !== null) {
      if (stmts.byId.get(parentId) === undefined) throw new Error(`No ticket with id ${parentId}`);
      if (wouldCycle(id, parentId)) throw new Error("A card cannot be nested inside itself or one of its own subtasks");
    }
    stmts.setParent.run(parentId, Date.now(), id);
    publish();
    return getTicket(id);
  }

  async function getColumns(): Promise<Column[]> {
    const stored = await bb.storage.kv.get<Column[]>("columns");
    const parsed = z.array(columnSchema).min(1).safeParse(stored);
    const columns = parsed.success ? parsed.data : DEFAULT_COLUMNS;
    doneColumnCache = doneColumn(columns);
    return columns;
  }

  async function getSources(): Promise<Source[]> {
    const stored = await bb.storage.kv.get<Source[]>("sources");
    const parsed = z.array(sourceSchema).safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_SOURCES;
  }

  function allTags(): string[] {
    const tags = new Set<string>();
    for (const row of stmts.all.all()) for (const tag of parseTags(row.tags)) tags.add(tag);
    return [...tags].sort();
  }

  function setTags(id: string, tags: readonly string[]): Ticket {
    stmts.setTags.run(JSON.stringify(normalizeTags(tags)), Date.now(), id);
    publish();
    return getTicket(id);
  }

  function publish(): void {
    bb.realtime.publish(BOARD_CHANGED, { at: Date.now() });
  }

  function getTicket(id: string): Ticket {
    const row = stmts.byId.get(id);
    if (row === undefined) throw new Error(`No ticket with id ${id}`);
    return hydrate(row);
  }

  function nextPosition(columnId: string): number {
    return (stmts.maxPosition.get(columnId)?.max ?? 0) + 1;
  }

  /** Columns a brand-new card lands in, by what the card is. */
  function initialColumn(columns: Column[], pr: PullRequest | null, jira: JiraIssue | null = null): string {
    const ids = new Set(columns.map((column) => column.id));
    const pick = (...preferred: string[]) =>
      preferred.find((id) => ids.has(id)) ?? columns[0]!.id;
    if (jira !== null) {
      if (jira.statusCategory === "done") return pick("done");
      if (jira.statusCategory === "indeterminate") return pick("in-progress", "todo");
      return pick("todo", "backlog");
    }
    if (pr === null) return pick("backlog", "todo");
    if (pr.state === "merged" || pr.state === "closed") return pick("done");
    // Every new PR card, authored or review-requested, starts as work to do.
    return pick("todo", "backlog");
  }

  function doneColumn(columns: Column[]): string {
    return columns.find((column) => column.id === "done")?.id ?? columns[columns.length - 1]!.id;
  }

  function moveTicket(id: string, columnId: string, index: number | null): Ticket {
    const now = Date.now();
    const move = db.transaction(() => {
      const current = stmts.byId.get(id);
      if (current === undefined) throw new Error(`No ticket with id ${id}`);
      const siblings = stmts.inColumn
        .all(columnId)
        .filter((row) => row.id !== id);
      const at = index === null ? siblings.length : Math.min(index, siblings.length);
      siblings.splice(at, 0, current);
      siblings.forEach((row, position) => {
        if (row.id === id) stmts.setColumn.run(columnId, position + 1, now, id);
        else if (row.position !== position + 1) stmts.setPosition.run(position + 1, row.id);
      });
    });
    move();
    publish();
    return getTicket(id);
  }

  function createTicket(input: {
    title: string;
    description: string;
    columnId: string;
    kind: Ticket["kind"];
    tags?: readonly string[];
    sourceId?: string | null;
    threadId: string | null;
    projectId: string | null;
    pr: PullRequest | null;
    jira?: JiraIssue | null;
    parentId?: string | null;
  }): Ticket {
    const now = Date.now();
    const id = randomUUID().slice(0, 8);
    stmts.insert.run({
      id,
      title: input.title,
      description: input.description,
      column_id: input.columnId,
      kind: input.kind,
      tags: JSON.stringify(normalizeTags(input.tags ?? [])),
      source_id: input.sourceId ?? null,
      thread_id: input.threadId,
      project_id: input.projectId,
      parent_id: input.parentId ?? null,
      pr_repo: input.pr?.repo ?? null,
      pr_number: input.pr?.number ?? null,
      pr_url: input.pr?.url ?? null,
      pr_role: input.pr?.role ?? null,
      pr_state: input.pr?.state ?? null,
      pr_author: input.pr?.author ?? null,
      pr_updated_at: input.pr?.updatedAt ?? null,
      jira_key: input.jira?.key ?? null,
      jira_url: input.jira?.url ?? null,
      jira_status: input.jira?.status ?? null,
      jira_status_category: input.jira?.statusCategory ?? null,
      jira_issue_type: input.jira?.issueType ?? null,
      jira_priority: input.jira?.priority ?? null,
      jira_assignee: input.jira?.assignee ?? null,
      jira_updated_at: input.jira?.updatedAt ?? null,
      position: nextPosition(input.columnId),
      created_at: now,
      updated_at: now,
    });
    return getTicket(id);
  }

  // ---- threads -----------------------------------------------------------

  function threadPrompt(ticket: Ticket, columns: Column[]): string {
    const columnList = columns.map((column) => `\`${column.id}\` (${column.name})`).join(", ");
    const footer = [
      "",
      `This thread is kanban ticket ${ticket.id}. Columns: ${columnList}.`,
      "Move the card as the work progresses with `bb kanban move <column-id>` (it finds this thread's card automatically).",
      "Do not post comments or reviews on GitHub unless the user explicitly asks.",
    ].join("\n");
    if (ticket.jira !== null) {
      const body = ticket.description.trim();
      return [
        `This thread tracks Jira issue ${ticket.jira.key}: "${ticket.title}" (${ticket.jira.url}). Type: ${ticket.jira.issueType || "unknown"}; status: ${ticket.jira.status || "unknown"}.`,
        "",
        body === "" ? "(The issue has no description.)" : body,
        "",
        "Read the relevant code to understand what the issue asks for, propose a short plan, and wait for the user before changing anything. Do not update the Jira issue.",
        footer,
      ].join("\n");
    }
    if (ticket.pr === null) {
      const body = ticket.description.trim();
      const parent = ticket.parentId === null ? null : stmts.byId.get(ticket.parentId);
      const context = parent === undefined || parent === null ? "" : `\n\nThis is a subtask of "${parent.title}" (ticket ${parent.id}). Keep the change scoped to this subtask.`;
      return `${ticket.title}${body === "" ? "" : `\n\n${body}`}${context}\n${footer}`;
    }
    const { repo, number, role } = ticket.pr;
    if (role === "other") {
      return [
        `You were asked to look at pull request ${repo}#${number}: "${ticket.title}" (${ticket.pr.url}).`,
        "",
        `1. Run \`gh pr view ${number} --repo ${repo}\` and \`gh pr diff ${number} --repo ${repo}\` to read the description and the change.`,
        "2. Review it for correctness, edge cases, and anything risky. Be concise and concrete; cite file paths.",
        "3. Summarize your findings here and stop. The user decides what to post.",
        footer,
      ].join("\n");
    }
    return [
      `This thread tracks your pull request ${repo}#${number}: "${ticket.title}" (${ticket.pr.url}).`,
      "",
      `1. Run \`gh pr view ${number} --repo ${repo} --json state,isDraft,reviewDecision,mergeable,statusCheckRollup,reviews,comments\` and \`gh pr checks ${number} --repo ${repo}\`.`,
      "2. Give a short status: CI, review decision, unresolved review comments, merge conflicts.",
      "3. If something needs action (failing checks, requested changes), say what and wait for instructions before changing code.",
      footer,
    ].join("\n");
  }

  async function spawnThreadForTicket(ticketId: string, projectId: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    if (ticket.threadId !== null) return ticket;
    const columns = await getColumns();
    const title =
      ticket.pr !== null
        ? `${ticket.pr.repo.split("/")[1]}#${ticket.pr.number}: ${ticket.title}`
        : ticket.jira !== null
          ? `${ticket.jira.key}: ${ticket.title}`
          : ticket.title;
    const parentThreadId = ticket.parentId === null ? null : (stmts.byId.get(ticket.parentId)?.thread_id ?? null);
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      prompt: threadPrompt(ticket, columns),
      title: title.slice(0, 200),
      ...(parentThreadId === null ? {} : { parentThreadId }),
      pluginMetadata: { ticketId: ticket.id },
    });
    stmts.setThread.run(thread.id, projectId, Date.now(), ticket.id);
    publish();
    return getTicket(ticket.id);
  }

  /**
   * The code-review skill diffs `<default-branch>...HEAD` and its reviewers read
   * whole files, so the PR head has to be checked out locally. The review runs
   * in its own worktree and checks the PR out detached, so it never touches the
   * branch checked out in the main project directory.
   */
  function reviewPrompt(ticket: Ticket, since: Review | null): string {
    if (ticket.pr === null) throw new Error("Only PR cards can be reviewed");
    const { repo, number, url } = ticket.pr;
    const sinceSha = since?.commitSha ?? null;
    const range = sinceSha === null ? "origin/$BASE...HEAD" : `${sinceSha}..HEAD`;
    return [
      sinceSha === null
        ? `Run a full code review of pull request ${repo}#${number}: "${ticket.title}" (${url}).`
        : `Review the new commits on pull request ${repo}#${number}: "${ticket.title}" (${url}). The previous review covered commit ${sinceSha}; only review what changed since then.`,
      "",
      "Setup (this worktree is disposable; do not touch any other checkout). The `gh` and `git fetch` steps need your GitHub credentials, which the sandbox hides; running them with the sandbox disabled is expected and authorized here, so do that rather than stopping to ask.",
      `1. \`BASE=$(gh pr view ${number} --repo ${repo} --json baseRefName --jq .baseRefName)\` and \`HEAD_REF=$(gh pr view ${number} --repo ${repo} --json headRefName --jq .headRefName)\``,
      `2. \`git fetch origin "$BASE" "pull/${number}/head"\``,
      "3. `git checkout --detach FETCH_HEAD`",
      '4. `bb kanban review-record --commit "$(git rev-parse HEAD)" --base "$BASE" --head "$HEAD_REF"` so the board knows which commit this review covers.',
      "",
      sinceSha === null
        ? `Then invoke the \`code-review\` skill with the range \`${range}\` (three-dot) so it reviews exactly the PR's changes. Let it spawn every applicable reviewer in parallel and compile the findings in its standard format.`
        : `If \`git log ${sinceSha}..HEAD\` is empty, say that nothing changed since the last review and stop. Otherwise invoke the \`code-review\` skill with the range \`${range}\` so it reviews only the new commits, and compile the findings in its standard format.`,
      "",
      "Your final message must be the code-review skill's compiled report verbatim, including its `Reviewed commit:` line and the trailing ```json review-findings block; it is persisted on the card and rendered from that JSON.",
      "Rules: do not change code, and do not post comments or reviews on GitHub; the compiled findings in this thread are the deliverable.",
      `This review belongs to kanban ticket ${ticket.id}.`,
    ].join("\n");
  }

  function finishSteps(push: boolean, headRef: string, recordCommand: string, subject: string): string[] {
    return push
      ? [
          "When the skill reports done and verification passed:",
          `1. \`git add -A && git commit -m "${subject}"\` (use a more specific message if the changes are narrow). Do not amend or rewrite existing commits.`,
          `2. \`git push origin HEAD:refs/heads/${headRef}\``,
          `3. \`${recordCommand} --commit "$(git rev-parse HEAD)" --pushed\` so the board records the push.`,
        ]
      : [
          "When the skill reports done and verification passed:",
          `1. \`git add -A && git commit -m "${subject}"\` (use a more specific message if the changes are narrow). Do not amend or rewrite existing commits.`,
          "2. Do NOT push. The user chose to review the commit first: report the worktree path, the commit sha, and the exact push command (`git push origin HEAD:refs/heads/<branch>`) so they can push or ask you to.",
          `3. \`${recordCommand} --commit "$(git rev-parse HEAD)"\` so the board records the local commit.`,
        ];
  }

  function applyPrompt(ticket: Ticket, review: Review, autoApprove: boolean, push: boolean, findingsBody: string): string {
    if (ticket.pr === null) throw new Error("Only PR cards can be reviewed");
    const { repo, number, url } = ticket.pr;
    const headRef = review.headRef ?? `$(gh pr view ${number} --repo ${repo} --json headRefName --jq .headRefName)`;
    return [
      `Apply the persisted code review to pull request ${repo}#${number}: "${ticket.title}" (${url})${push ? " and push the fixes to its branch" : " as a local commit in this worktree"}.`,
      "",
      "Setup (this worktree is disposable; do not touch any other checkout). `git fetch`, `git push`, and `gh` need your credentials, which the sandbox hides; running them with the sandbox disabled is expected and authorized here.",
      `1. \`git fetch origin "pull/${number}/head"\` then \`git checkout --detach FETCH_HEAD\`.`,
      review.commitSha === null
        ? "2. Note `git rev-parse HEAD`."
        : `2. The review was made against commit ${review.commitSha}. If \`git rev-parse HEAD\` differs, say so and check each finding still applies before fixing it.`,
      "",
      `Then invoke the \`apply-review\` skill with the findings below.${autoApprove ? " The user has said: just apply all of it, don't ask — skip the triage confirmation." : " Run its triage step and wait for the user's go-ahead in this thread before changing anything."}`,
      "",
      ...finishSteps(push, headRef, "bb kanban review-applied", "Apply code review findings"),
      "",
      "Rules: never force-push, never post comments or reviews on GitHub, and report the result and any findings you could not apply.",
      `This apply run belongs to kanban ticket ${ticket.id}, review ${review.id}.`,
      "",
      "## Review Findings (persisted)",
      "",
      findingsBody,
    ].join("\n");
  }

  /** The machine the project's checkout lives on; a worktree is created there. */
  async function projectHostId(projectId: string): Promise<string> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error(`No project with id ${projectId}`);
    const source = project.sources.find((candidate) => candidate.isDefault) ?? project.sources[0];
    if (source === undefined) throw new Error(`Project ${project.name} has no checkout to create a worktree in`);
    return source.hostId;
  }

  /** Pull every comment kind for one PR and replace the ticket's stored set. */
  async function syncPrComments(row: TicketRow, token: string, signal?: AbortSignal): Promise<void> {
    if (row.pr_repo === null || row.pr_number === null) return;
    const base = `/repos/${row.pr_repo}`;
    const [issueComments, reviewComments, reviews] = await Promise.all([
      github<GithubIssueComment[]>(`${base}/issues/${row.pr_number}/comments?per_page=100`, token, signal),
      github<GithubReviewComment[]>(`${base}/pulls/${row.pr_number}/comments?per_page=100`, token, signal),
      github<GithubReview[]>(`${base}/pulls/${row.pr_number}/reviews?per_page=100`, token, signal),
    ]);
    const mine = (login: string) => (sync.login !== null && login === sync.login ? 1 : 0);
    const ids: string[] = [];
    const write = db.transaction(() => {
      for (const comment of issueComments) {
        const id = `issue-comment:${comment.id}`;
        ids.push(id);
        const author = comment.user?.login ?? "";
        stmts.upsertComment.run({
          id, ticket_id: row.id, kind: "issue-comment", github_id: comment.id, author, mine: mine(author),
          body: comment.body ?? "", path: null, line: null, review_state: null, in_reply_to: null,
          url: comment.html_url, created_at: comment.created_at, updated_at: comment.updated_at,
        });
      }
      for (const comment of reviewComments) {
        const id = `review-comment:${comment.id}`;
        ids.push(id);
        const author = comment.user?.login ?? "";
        stmts.upsertComment.run({
          id, ticket_id: row.id, kind: "review-comment", github_id: comment.id, author, mine: mine(author),
          body: comment.body ?? "", path: comment.path, line: comment.line ?? comment.original_line ?? null, review_state: null,
          in_reply_to: comment.in_reply_to_id === undefined ? null : `review-comment:${comment.in_reply_to_id}`,
          url: comment.html_url, created_at: comment.created_at, updated_at: comment.updated_at,
        });
      }
      for (const review of reviews) {
        // Pending reviews are drafts nobody else can see; bodiless approvals carry no request.
        if (review.state === "PENDING" || review.submitted_at === undefined) continue;
        if ((review.body ?? "").trim() === "" && review.state !== "CHANGES_REQUESTED") continue;
        const id = `review:${review.id}`;
        ids.push(id);
        const author = review.user?.login ?? "";
        stmts.upsertComment.run({
          id, ticket_id: row.id, kind: "review", github_id: review.id, author, mine: mine(author),
          body: review.body ?? "", path: null, line: null, review_state: review.state, in_reply_to: null,
          url: review.html_url, created_at: review.submitted_at, updated_at: review.submitted_at,
        });
      }
      stmts.deleteStaleComments.run(row.id, JSON.stringify(ids));
      stmts.setCommentsSyncedFor.run(row.pr_updated_at, row.id);
    });
    write();
  }

  function commentsBody(ticket: Ticket, comments: PrComment[]): string {
    const label = (comment: PrComment) =>
      comment.kind === "review-comment"
        ? `${comment.path ?? "?"}${comment.line === null ? "" : `:${comment.line}`}${comment.id.startsWith("local:") ? " (left on the Kanban diff view)" : ""}`
        : comment.kind === "review"
          ? `review summary (${comment.reviewState ?? "COMMENTED"})`
          : "conversation";
    const lines = [
      `${comments.length} comment${comments.length === 1 ? "" : "s"} on ${ticket.pr !== null ? `${ticket.pr.repo}#${ticket.pr.number}` : `kanban ticket ${ticket.id}`} were selected on the Kanban board; others were deliberately left out.`,
      "",
    ];
    for (const comment of comments) {
      lines.push(`### ${comment.id} — ${comment.author} on ${label(comment)}${comment.inReplyTo === null ? "" : ` (reply to ${comment.inReplyTo})`}`);
      lines.push(comment.url, "", comment.body.trim(), "");
    }
    lines.push(
      "```json pr-comments",
      JSON.stringify(
        {
          version: 1,
          repo: ticket.pr?.repo,
          number: ticket.pr?.number,
          comments: comments.map(({ selected, selectionOverride, addressedAt, ticketId, githubId, mine, updatedAt, ...rest }) => rest),
        },
        null,
        2,
      ),
      "```",
    );
    return lines.join("\n");
  }

  function applyCommentsPrompt(ticket: Ticket, apply: { id: string }, autoApprove: boolean, push: boolean, body: string): string {
    const { repo, number, url } = ticket.pr ?? { repo: null, number: null, url: null };
    const intro =
      ticket.pr !== null
        ? `Address the review comments on pull request ${repo}#${number}: "${ticket.title}" (${url})${push ? " and push the fixes to its branch" : " as a local commit in this worktree"}.`
        : `Address the review comments the user left on the changes for "${ticket.title}" (kanban ticket ${ticket.id})${push ? " and push the branch" : " as a local commit"}.`;
    const setup =
      ticket.pr !== null
        ? [
            "Setup (this worktree is disposable; do not touch any other checkout). `git fetch`, `git push`, and `gh` need your credentials, which the sandbox hides; running them with the sandbox disabled is expected and authorized here.",
            `1. \`HEAD_REF=$(gh pr view ${number} --repo ${repo} --json headRefName --jq .headRefName)\``,
            `2. \`git fetch origin "pull/${number}/head"\` then \`git checkout --detach FETCH_HEAD\`.`,
          ]
        : [
            "You are in the card's own environment, on the branch the changes live on. `HEAD_REF=$(git rev-parse --abbrev-ref HEAD)`. `git push` needs your credentials, which the sandbox hides; running it unsandboxed is authorized.",
          ];
    return [
      intro,
      "",
      ...setup,
      "",
      `Then invoke the \`apply-pr-comments\` skill with the comments below.${autoApprove ? " The user has said: just apply all of it, don't ask — skip the triage confirmation." : " Run its triage step and wait for the user's go-ahead in this thread before changing anything."}`,
      "",
      ...finishSteps(push, '"$HEAD_REF"', "bb kanban comments-applied", "Address review comments"),
      "",
      "Rules: never force-push, never post replies or reviews on GitHub, and report what you applied, what you answered, and what you left for the user.",
      `This apply run belongs to kanban ticket ${ticket.id}, apply ${apply.id}.`,
      "",
      "## Selected comments",
      "",
      body,
    ].join("\n");
  }

  /** Local diff comments in the shape the apply-pr-comments skill reads. */
  function diffCommentsAsPrComments(ticket: Ticket, comments: DiffComment[]): PrComment[] {
    return comments.map((comment) => ({
      id: `local:${comment.id}`,
      ticketId: ticket.id,
      kind: "review-comment",
      githubId: 0,
      author: sync.login ?? "you",
      mine: true,
      body: comment.side === "LEFT" && comment.line !== null ? `(On removed line ${comment.line} of the old file.) ${comment.body}` : comment.body,
      path: comment.path,
      line: comment.line,
      reviewState: null,
      inReplyTo: null,
      url: comment.postedUrl ?? ticket.pr?.url ?? "",
      createdAt: new Date(comment.createdAt).toISOString(),
      updatedAt: new Date(comment.updatedAt).toISOString(),
      selected: true,
      selectionOverride: null,
      addressedAt: null,
    }));
  }

  async function spawnApplyForComments(
    ticketId: string,
    autoApprove: boolean,
    push: boolean,
    override?: PrComment[],
  ): Promise<{ ticket: Ticket; apply: CommentApply }> {
    const ticket = getTicket(ticketId);
    if (ticket.pr === null && override === undefined) throw new Error("Only PR cards have comments");
    const selected = override ?? stmts.commentsForTicket.all(ticket.id).map(rowToComment).filter((comment) => comment.selected);
    if (selected.length === 0) throw new Error("No comments are selected; tick at least one comment to apply");
    const running = stmts.commentAppliesForTicket.all(ticket.id).find((row) => row.completed_at === null);
    if (running !== undefined) throw new Error("An apply run for this card's comments is already in progress");
    const projectId = await projectForTicket(ticket, null);
    const applyId = randomUUID().slice(0, 8);
    // Local comments on a thread-backed card are applied in that thread's own environment, where the changes live.
    let environment: Awaited<ReturnType<typeof freshWorktree>> | { type: "reuse"; environmentId: string } | null = null;
    if (ticket.pr === null && ticket.threadId !== null) {
      const cardThread = await bb.sdk.threads.get({ threadId: ticket.threadId });
      if (cardThread.environmentId !== null) environment = { type: "reuse", environmentId: cardThread.environmentId };
    }
    const shortName = ticket.pr !== null ? `${ticket.pr.repo.split("/")[1]}#${ticket.pr.number}` : ticket.id;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: environment ?? (await freshWorktree(projectId)),
      prompt: applyCommentsPrompt(ticket, { id: applyId }, autoApprove, push, commentsBody(ticket, selected)),
      title: `Address comments ${shortName}: ${ticket.title}`.slice(0, 200),
      ...(ticket.threadId === null ? {} : { parentThreadId: ticket.threadId }),
      pluginMetadata: { ticketId: ticket.id, role: "apply-comments", applyId },
    });
    stmts.insertCommentApply.run({
      id: applyId,
      ticket_id: ticket.id,
      thread_id: thread.id,
      comment_ids: JSON.stringify(selected.map((comment) => comment.id)),
      started_at: Date.now(),
      push: push ? 1 : 0,
    });
    publish();
    return { ticket: getTicket(ticket.id), apply: rowToCommentApply(stmts.commentApplyById.get(applyId)!) };
  }

  async function githubPost<T>(path: string, token: string, body: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "bb-plugin-kanban",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw Object.assign(new Error(`GitHub ${response.status} for ${path}: ${text}`), { status: response.status });
    }
    return (await response.json()) as T;
  }

  const diffCache = new Map<string, { key: string; diff: TicketDiff }>();

  /** The card's changes: the PR's files from GitHub, else the thread environment's working diff. */
  async function ticketDiff(ticket: Ticket, refresh: boolean): Promise<TicketDiff> {
    const now = Date.now();
    if (ticket.pr !== null) {
      const key = `pr:${ticket.pr.updatedAt}`;
      const cached = diffCache.get(ticket.id);
      if (!refresh && cached !== undefined && cached.key === key && now - cached.diff.fetchedAt < 10 * 60_000) return cached.diff;
      const auth = await resolveToken();
      if (auth === null) {
        return { source: "pr", files: [], baseRef: null, headSha: null, truncated: false, message: "No GitHub token configured.", fetchedAt: now };
      }
      const [pull, files] = await Promise.all([
        github<GithubPull & { base?: { ref?: string }; head?: { sha?: string } }>(`/repos/${ticket.pr.repo}/pulls/${ticket.pr.number}`, auth.token),
        (async () => {
          const all: GithubPullFile[] = [];
          for (let page = 1; page <= 3; page += 1) {
            const batch = await github<GithubPullFile[]>(`/repos/${ticket.pr!.repo}/pulls/${ticket.pr!.number}/files?per_page=100&page=${page}`, auth.token);
            all.push(...batch);
            if (batch.length < 100) break;
          }
          return all;
        })(),
      ]);
      const diff: TicketDiff = {
        source: "pr",
        files: files.map((file) => ({
          path: file.filename,
          previousPath: file.previous_filename ?? null,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ?? null,
        })),
        baseRef: pull.base?.ref ?? null,
        headSha: pull.head?.sha ?? null,
        truncated: files.length >= 300,
        message: null,
        fetchedAt: now,
      };
      diffCache.set(ticket.id, { key, diff });
      return diff;
    }
    if (ticket.threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId: ticket.threadId });
      if (thread.environmentId === null) {
        return { source: "none", files: [], baseRef: null, headSha: null, truncated: false, message: "The card's thread has no environment yet.", fetchedAt: now };
      }
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      // Everything on the branch since it diverged when the merge base is known, else just the working tree.
      const result = await bb.sdk.environments.diff(
        environment.mergeBaseBranch !== null
          ? { environmentId: thread.environmentId, target: "all", mergeBaseBranch: environment.mergeBaseBranch }
          : { environmentId: thread.environmentId, target: "uncommitted" },
      );
      if (result.outcome !== "available") {
        return { source: "environment", files: [], baseRef: null, headSha: null, truncated: false, message: result.outcome === "not_applicable" ? result.message : result.failure.message, fetchedAt: now };
      }
      return {
        source: "environment",
        files: splitUnifiedDiff(result.diff.diff),
        baseRef: result.diff.mergeBaseRef,
        headSha: null,
        truncated: result.diff.truncated,
        message: null,
        fetchedAt: now,
      };
    }
    return { source: "none", files: [], baseRef: null, headSha: null, truncated: false, message: "No pull request or thread to diff.", fetchedAt: now };
  }

  /** Post pending diff comments to the PR as one GitHub review. Inline where a line is given, otherwise in the review body. */
  async function postDiffCommentsToGithub(ticket: Ticket, comments: DiffComment[]): Promise<{ posted: number; url: string | null }> {
    if (ticket.pr === null) throw new Error("Only PR cards can post to GitHub");
    const auth = await resolveToken();
    if (auth === null) throw new Error("No GitHub token configured.");
    const inline = comments.filter((comment) => comment.line !== null);
    const general = comments.filter((comment) => comment.line === null);
    const where = (comment: DiffComment) => `${comment.path}${comment.line === null ? "" : `:${comment.line}${comment.side === "LEFT" ? " (old)" : ""}`}`;
    const summarize = (list: DiffComment[]) => list.map((comment) => `- \`${where(comment)}\` — ${comment.body.trim()}`).join("\n");
    const path = `/repos/${ticket.pr.repo}/pulls/${ticket.pr.number}/reviews`;
    const commitId = (await ticketDiff(ticket, false)).headSha;
    let review: { id: number; html_url: string };
    try {
      review = await githubPost(path, auth.token, {
        event: "COMMENT",
        ...(commitId === null ? {} : { commit_id: commitId }),
        body: general.length === 0 ? "" : summarize(general),
        comments: inline.map((comment) => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body.trim() })),
      });
    } catch (error) {
      // A line outside the diff makes GitHub reject the whole review; fall back to one body-only review.
      if ((error as { status?: number }).status !== 422) throw error;
      review = await githubPost(path, auth.token, { event: "COMMENT", body: summarize(comments) });
    }
    const now = Date.now();
    for (const comment of comments) stmts.markDiffCommentPosted.run(now, review.html_url, comment.id);
    return { posted: comments.length, url: review.html_url };
  }

  function breakdownPrompt(ticket: Ticket, guidance: string): string {
    const body = ticket.description.trim();
    return [
      `Break the card "${ticket.title}" (kanban ticket ${ticket.id}) into subtasks.`,
      body === "" ? "" : `\nDescription:\n${body}\n`,
      guidance.trim() === "" ? "" : `\nGuidance from the user:\n${guidance.trim()}\n`,
      "Read the relevant code first so the split reflects how the work actually divides. Aim for 3–8 subtasks that are concrete, independently workable, and each small enough for one agent session; order them so dependencies come first.",
      "Create each one with:",
      `  bb kanban add "<title>" --parent ${ticket.id} --description "<what done looks like, files involved, how to verify>"`,
      `Existing subtasks: run \`bb kanban subtasks --ticket ${ticket.id}\` first and do not duplicate them.`,
      `Do not start the work. When finished, run \`bb kanban subtasks --ticket ${ticket.id}\` and summarize the plan in one list.`,
    ].join("\n");
  }

  function sequentialPrompt(ticket: Ticket, columns: Column[]): string {
    const columnList = columns.map((column) => `\`${column.id}\``).join(", ");
    const done = doneColumn(columns);
    const open = stmts.childrenOf.all(ticket.id).filter((child) => child.column_id !== done);
    return [
      `Work through every open subtask of "${ticket.title}" (kanban ticket ${ticket.id}), in order:`,
      ...open.map((child, index) => `  ${index + 1}. ${child.id} — ${child.title}${child.description.trim() === "" ? "" : `: ${child.description.trim().split("\n")[0]}`}`),
      "",
      `1. \`bb kanban subtasks --ticket ${ticket.id} --json\` lists them; skip any already in the done column or already linked to another thread.`,
      "2. For each subtask: `bb kanban move in-progress --ticket <subtask-id>`, do the work described on it, verify it, commit with a message naming the subtask, then `bb kanban move done --ticket <subtask-id>`.",
      "3. If a subtask is blocked or unclear, leave it where it is, say why, and continue with the next one.",
      `4. When all are done, \`bb kanban move done\` for this card and summarize what was committed. Columns: ${columnList}.`,
      "",
      "Do not push unless the user asks.",
    ].join("\n");
  }

  const PROPOSAL_FORMAT = [
    "Reply with a short plain-language summary, then end your message with exactly one fenced block:",
    "```json kanban-proposal",
    '{ "version": 1, "summary": "<one paragraph>", "tickets": [ { "id": "T1", "title": "<imperative, ≤ 80 chars>", "description": "<what, why, what done looks like, files or areas involved>", "tags": ["<lowercase-tag>"], "subtasks": [ { "title": "...", "description": "..." } ], "dependsOn": ["T2"], "estimate": "S" | "M" | "L" } ], "questions": [ { "id": "Q1", "question": "<what you need to know>", "why": "<what changes depending on the answer>", "affects": ["T1"], "options": ["<plausible answer>", "..."] } ] }',
    "```",
    "Rules: one ticket per independently shippable piece of work; split anything bigger than a day into subtasks; put real uncertainties in `questions` instead of guessing (but do not ask about things the code answers); keep ids stable across revisions. Do not create cards yourself and do not start any work.",
  ].join("\n");

  function dumpPrompt(dump: Dump): string {
    return [
      "The user dictated the following stream of tasks and thoughts. Turn it into a proposed set of Kanban tickets.",
      "",
      "Read the relevant parts of this project first, so titles, scopes, and the questions you raise are grounded in the actual code.",
      "",
      "---- dictation ----",
      dump.text.trim(),
      "---- end ----",
      "",
      PROPOSAL_FORMAT,
    ].join("\n");
  }

  function refinePrompt(dump: Dump, answers: Record<string, string>, notes: string): string {
    const questions = dump.proposal?.questions ?? [];
    const answered = Object.entries(answers)
      .filter(([, answer]) => answer.trim() !== "")
      .map(([id, answer]) => `- ${id} (${questions.find((question) => question.id === id)?.question ?? "?"}): ${answer.trim()}`);
    return [
      "Revise the proposal using the answers and notes below. Keep ticket ids stable where the ticket is unchanged; drop resolved questions and add new ones only if the answers raise them.",
      "",
      answered.length > 0 ? `Answers:\n${answered.join("\n")}` : "No questions were answered.",
      notes.trim() === "" ? "" : `\nNotes from the user:\n${notes.trim()}`,
      "",
      PROPOSAL_FORMAT,
    ].join("\n");
  }

  async function createDump(text: string, projectId: string): Promise<Dump> {
    const now = Date.now();
    const id = randomUUID().slice(0, 8);
    stmts.insertDump.run({ id, text, project_id: projectId, thread_id: null, created_at: now, updated_at: now });
    const dump = rowToDump(stmts.dumpById.get(id)!);
    try {
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        prompt: dumpPrompt(dump),
        title: `Plan: ${text.trim().split("\n")[0]!.slice(0, 80)}`,
        pluginMetadata: { dumpId: id, role: "plan" },
      });
      stmts.setDumpThread.run(thread.id, Date.now(), id);
    } catch (error) {
      stmts.setDumpFailed.run(error instanceof Error ? error.message : String(error), Date.now(), id);
    }
    publish();
    return rowToDump(stmts.dumpById.get(id)!);
  }

  async function refineDump(id: string, answers: Record<string, string>, notes: string): Promise<Dump> {
    const row = stmts.dumpById.get(id);
    if (row === undefined) throw new Error(`No brain dump with id ${id}`);
    if (row.thread_id === null) throw new Error("This dump has no planning thread; start a new one");
    if (row.status === "planning") throw new Error("The planning thread is still working");
    const dump = rowToDump(row);
    await bb.sdk.threads.send({ threadId: row.thread_id, mode: "auto", input: [{ type: "text", text: refinePrompt(dump, answers, notes), mentions: [] }] });
    stmts.setDumpPlanning.run(JSON.stringify(answers), Date.now(), id);
    publish();
    return rowToDump(stmts.dumpById.get(id)!);
  }

  async function finalizeDump(id: string, proposed: ProposedTicket[], columnId: string | undefined, startThreads: boolean): Promise<{ dump: Dump; tickets: Ticket[] }> {
    const row = stmts.dumpById.get(id);
    if (row === undefined) throw new Error(`No brain dump with id ${id}`);
    if (row.status === "done" || row.status === "discarded") throw new Error("This dump was already closed");
    const columns = await getColumns();
    const target = columnId !== undefined && columns.some((column) => column.id === columnId) ? columnId : initialColumn(columns, null);
    const created: Ticket[] = [];
    for (const item of proposed) {
      const ticket = createTicket({
        title: item.title.trim(),
        description: item.description.trim(),
        columnId: target,
        kind: "adhoc",
        tags: item.tags,
        threadId: null,
        projectId: row.project_id,
        pr: null,
      });
      for (const sub of item.subtasks) {
        createTicket({
          title: sub.title.trim(),
          description: sub.description.trim(),
          columnId: target,
          kind: "adhoc",
          tags: item.tags,
          threadId: null,
          projectId: row.project_id,
          pr: null,
          parentId: ticket.id,
        });
      }
      created.push(getTicket(ticket.id));
    }
    stmts.setDumpDone.run(JSON.stringify(created.map((ticket) => ticket.id)), Date.now(), id);
    publish();
    if (row.thread_id !== null) {
      try {
        await bb.sdk.threads.archive({ threadId: row.thread_id });
      } catch (error) {
        bb.log.warn(`could not archive planning thread ${row.thread_id}: ${String(error)}`);
      }
    }
    if (startThreads) {
      for (const ticket of created) {
        try {
          await spawnThreadForTicket(ticket.id, row.project_id);
        } catch (error) {
          bb.log.warn(`could not start a thread for ${ticket.id}: ${String(error)}`);
        }
      }
    }
    return { dump: rowToDump(stmts.dumpById.get(id)!), tickets: created.map((ticket) => getTicket(ticket.id)) };
  }

  /** Start a thread for a card, or send a prompt into its existing thread. */
  async function promptTicketThread(ticket: Ticket, projectId: string, prompt: string, title: string, role: string): Promise<Ticket> {
    if (ticket.threadId !== null) {
      await bb.sdk.threads.send({ threadId: ticket.threadId, mode: "auto", input: [{ type: "text", text: prompt, mentions: [] }] });
      return ticket;
    }
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      prompt,
      title: title.slice(0, 200),
      pluginMetadata: { ticketId: ticket.id, role },
    });
    stmts.setThread.run(thread.id, projectId, Date.now(), ticket.id);
    publish();
    return getTicket(ticket.id);
  }

  async function startChildren(ticketId: string, mode: "parallel" | "sequential", explicitProjectId: string | null): Promise<{ ticket: Ticket; started: number; skipped: number }> {
    const ticket = getTicket(ticketId);
    const columns = await getColumns();
    const done = doneColumn(columns);
    const projectId = await projectForTicket(ticket, explicitProjectId);
    const open = stmts.childrenOf.all(ticket.id).filter((child) => child.column_id !== done);
    if (open.length === 0) throw new Error("No open subtasks to start");
    if (mode === "sequential") {
      await promptTicketThread(ticket, projectId, sequentialPrompt(ticket, columns), `Subtasks: ${ticket.title}`, "subtasks");
      return { ticket: getTicket(ticket.id), started: open.length, skipped: 0 };
    }
    let started = 0;
    let skipped = 0;
    for (const child of open) {
      if (child.thread_id !== null) {
        skipped += 1;
        continue;
      }
      if (child.project_id === null) stmts.setThread.run(null, projectId, Date.now(), child.id);
      try {
        await spawnThreadForTicket(child.id, child.project_id ?? projectId);
        started += 1;
      } catch (error) {
        bb.log.warn(`could not start subtask ${child.id}: ${String(error)}`);
        skipped += 1;
      }
    }
    publish();
    return { ticket: getTicket(ticket.id), started, skipped };
  }

  async function freshWorktree(projectId: string) {
    return {
      type: "host" as const,
      hostId: await projectHostId(projectId),
      workspace: { type: "managed-worktree" as const, baseBranch: { kind: "default" as const } },
    };
  }

  async function spawnReviewForTicket(
    ticketId: string,
    projectId: string,
    mode: "full" | "incremental",
  ): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    if (ticket.pr === null) throw new Error("Only PR cards can be reviewed");
    const previousRow = mode === "incremental" ? stmts.latestCompletedReview.get(ticket.id) : undefined;
    const previous = previousRow === undefined || previousRow.commit_sha === null ? null : rowToReview(previousRow);
    const shortName = `${ticket.pr.repo.split("/")[1]}#${ticket.pr.number}`;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: await freshWorktree(projectId),
      prompt: reviewPrompt(ticket, previous),
      title: `${previous === null ? "Review" : "Re-review"} ${shortName}: ${ticket.title}`.slice(0, 200),
      ...(ticket.threadId === null ? {} : { parentThreadId: ticket.threadId }),
      pluginMetadata: { ticketId: ticket.id, role: "review" },
    });
    const now = Date.now();
    stmts.insertReview.run({
      id: randomUUID().slice(0, 8),
      ticket_id: ticket.id,
      thread_id: thread.id,
      since_commit_sha: previous?.commitSha ?? null,
      created_at: now,
    });
    stmts.setReviewThread.run(thread.id, now, ticket.id);
    publish();
    return getTicket(ticket.id);
  }

  async function spawnApplyForReview(ticketId: string, reviewId: string | null, autoApprove: boolean, push: boolean): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    if (ticket.pr === null) throw new Error("Only PR cards can be reviewed");
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
      throw new Error("No findings are selected; tick at least one finding to apply");
    }
    const projectId = await projectForTicket(ticket, null);
    // Reuse the review thread's worktree when it still exists: the PR is already fetched there.
    let environment: Awaited<ReturnType<typeof freshWorktree>> | { type: "reuse"; environmentId: string } | null = null;
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
      prompt: applyPrompt(ticket, review, autoApprove, push, findingsBody),
      title: `Apply review ${ticket.pr.repo.split("/")[1]}#${ticket.pr.number}: ${ticket.title}`.slice(0, 200),
      parentThreadId: ticket.threadId ?? review.threadId,
      pluginMetadata: { ticketId: ticket.id, role: "apply", reviewId: review.id },
    });
    stmts.startApply.run(thread.id, Date.now(), findingIds === null ? null : JSON.stringify(findingIds), push ? 1 : 0, review.id);
    publish();
    return getTicket(ticket.id);
  }

  /** The project a PR card's threads run in: stored, matched by remote, or the fallback. */
  async function projectForTicket(ticket: Ticket, explicit: string | null): Promise<string> {
    if (explicit !== null) return explicit;
    if (ticket.projectId !== null) return ticket.projectId;
    const parentProject = ticket.parentId === null ? null : (stmts.byId.get(ticket.parentId)?.project_id ?? null);
    if (parentProject !== null) return parentProject;
    const resolved = ticket.pr === null ? null : await resolveProjectForRepo(ticket.pr.repo);
    if (resolved === null) {
      throw new Error(
        `No project matches ${ticket.pr?.repo ?? "this card"}. Pick a project, or set the fallback project in the plugin settings.`,
      );
    }
    return resolved;
  }

  async function linkThread(ticketId: string, threadId: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    const thread = await bb.sdk.threads.get({ threadId });
    stmts.setThread.run(thread.id, thread.projectId, Date.now(), ticket.id);
    try {
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        pluginId: bb.pluginId,
        set: { ticketId: ticket.id },
      });
    } catch (error) {
      bb.log.warn(`could not tag thread ${threadId} with ticket ${ticket.id}: ${String(error)}`);
    }
    publish();
    return getTicket(ticket.id);
  }

  /** Project whose git remote is this GitHub repo, else the configured fallback. */
  async function fallbackProject(sourceProjectId: string | null): Promise<string | null> {
    if (sourceProjectId !== null) return sourceProjectId;
    const { defaultProject } = await settings.get();
    return typeof defaultProject === "string" && defaultProject !== "" ? defaultProject : null;
  }

  async function resolveProjectForRepo(repo: string, sourceProjectId: string | null = null): Promise<string | null> {
    const projects = await bb.sdk.projects.list();
    const match = projects.find(
      (project) => githubRepoFromRemote(project.gitRemoteUrl) === repo,
    );
    if (match !== undefined) return match.id;
    return fallbackProject(sourceProjectId);
  }

  // ---- GitHub sync -------------------------------------------------------

  const sync: SyncStatus = {
    lastSyncAt: (await bb.storage.kv.get<number>("lastSyncAt")) ?? null,
    lastError: null,
    login: (await bb.storage.kv.get<string>("login")) ?? null,
    tokenSource: "none",
    jiraSite: null,
    inProgress: false,
  };

  // ---- Jira ----------------------------------------------------------------

  async function jiraConfig(): Promise<{ site: string; authorization: string } | null> {
    const { jiraSiteUrl, jiraEmail, jiraApiToken } = await settings.get();
    const site = jiraSiteUrl.trim().replace(/\/+$/u, "");
    if (site === "" || jiraEmail.trim() === "" || typeof jiraApiToken !== "string" || jiraApiToken.trim() === "") {
      return null;
    }
    return {
      site,
      authorization: `Basic ${Buffer.from(`${jiraEmail.trim()}:${jiraApiToken.trim()}`).toString("base64")}`,
    };
  }

  async function jira<T>(config: { site: string; authorization: string }, path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${config.site}${path}`, {
      headers: { authorization: config.authorization, accept: "application/json", "user-agent": "bb-plugin-kanban" },
      signal: signal ?? null,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`Jira ${response.status} for ${path}: ${body}`);
    }
    return (await response.json()) as T;
  }

  const JIRA_FIELDS = "summary,description,status,issuetype,priority,assignee,updated";

  function toJiraIssue(site: string, issue: JiraSearchIssue): JiraIssue {
    return {
      key: issue.key,
      url: `${site}/browse/${issue.key}`,
      status: issue.fields.status?.name ?? "",
      statusCategory: jiraCategory(issue.fields.status?.statusCategory?.key),
      issueType: issue.fields.issuetype?.name ?? "",
      priority: issue.fields.priority?.name ?? null,
      assignee: issue.fields.assignee?.displayName ?? issue.fields.assignee?.emailAddress ?? null,
      updatedAt: issue.fields.updated,
    };
  }

  async function searchJira(
    config: { site: string; authorization: string },
    jql: string,
    signal?: AbortSignal,
  ): Promise<JiraSearchIssue[]> {
    const issues: JiraSearchIssue[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const query = new URLSearchParams({ jql, fields: JIRA_FIELDS, maxResults: "100" });
      if (nextPageToken !== undefined) query.set("nextPageToken", nextPageToken);
      const result = await jira<{ issues: JiraSearchIssue[]; nextPageToken?: string; isLast?: boolean }>(
        config,
        `/rest/api/3/search/jql?${query.toString()}`,
        signal,
      );
      issues.push(...result.issues);
      if (result.isLast !== false || result.nextPageToken === undefined) break;
      nextPageToken = result.nextPageToken;
    }
    return issues;
  }

  async function resolveToken(): Promise<{ token: string; source: SyncStatus["tokenSource"] } | null> {
    const { githubToken } = await settings.get();
    if (typeof githubToken === "string" && githubToken.trim() !== "") {
      return { token: githubToken.trim(), source: "setting" };
    }
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000 });
      const token = stdout.trim();
      return token === "" ? null : { token, source: "gh-cli" };
    } catch {
      return null;
    }
  }

  async function github<T>(path: string, token: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "bb-plugin-kanban",
      },
      signal: signal ?? null,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`GitHub ${response.status} for ${path}: ${body}`);
    }
    return (await response.json()) as T;
  }

  async function searchPulls(query: string, token: string, signal?: AbortSignal): Promise<GithubSearchItem[]> {
    const items: GithubSearchItem[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const result = await github<{ items: GithubSearchItem[]; total_count: number }>(
        `/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
        token,
        signal,
      );
      items.push(...result.items);
      if (result.items.length < 100 || items.length >= result.total_count) break;
    }
    return items;
  }

  let syncPromise: Promise<void> | null = null;

  function runSync(signal?: AbortSignal): Promise<void> {
    if (syncPromise !== null) return syncPromise;
    sync.inProgress = true;
    syncPromise = syncOnce(signal)
      .then(
        () => {
          sync.lastError = null;
        },
        (error: unknown) => {
          sync.lastError = error instanceof Error ? error.message : String(error);
          bb.log.warn(`GitHub sync failed: ${sync.lastError}`);
        },
      )
      .finally(() => {
        sync.inProgress = false;
        syncPromise = null;
        publish();
      });
    return syncPromise;
  }

  async function syncOnce(signal?: AbortSignal): Promise<void> {
    const sources = (await getSources()).filter((source) => source.enabled);
    const githubSources = sources.filter((source): source is Extract<Source, { kind: "github-search" }> => source.kind === "github-search");
    const jiraSources = sources.filter((source): source is Extract<Source, { kind: "jira-jql" }> => source.kind === "jira-jql");
    const problems: string[] = [];

    const auth = await resolveToken();
    sync.tokenSource = auth?.source ?? "none";
    if (auth !== null && sync.login === null) {
      const me = await github<{ login: string }>("/user", auth.token, signal);
      sync.login = me.login;
      await bb.storage.kv.set("login", me.login);
    }
    const jiraAuth = await jiraConfig();
    sync.jiraSite = jiraAuth?.site ?? null;

    const columns = await getColumns();
    const { autoStartThreads } = await settings.get();
    const now = Date.now();
    const toSpawn: string[] = [];
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const mergeTags = (row: TicketRow, sourceTags: string[]) => {
      const currentTags = parseTags(row.tags);
      if (sourceTags.some((tag) => !currentTags.includes(tag))) {
        stmts.setTags.run(JSON.stringify(normalizeTags([...currentTags, ...sourceTags])), now, row.id);
      }
    };
    const finish = (row: TicketRow, finished: boolean) => {
      if (finished && row.column_id !== doneColumn(columns)) moveTicket(row.id, doneColumn(columns), null);
    };

    // ---- GitHub ----
    if (githubSources.length > 0 && auth === null) {
      problems.push("No GitHub token: set the GitHub token setting or sign in with `gh auth login` on the BB server machine.");
    }
    const seenPrs = new Map<string, { item: GithubSearchItem; sources: Source[] }>();
    if (auth !== null) {
      const results = await Promise.all(
        githubSources.map(async (source) => {
          try {
            return { source, items: await searchPulls(source.query, auth.token, signal) };
          } catch (error) {
            problems.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
            return { source, items: [] as GithubSearchItem[], failed: true };
          }
        }),
      );
      // One PR can appear in several sources: it gets every source's tags, and the first source owns it.
      for (const { source, items } of results) {
        for (const item of items) {
          const key = `${repoFromRepositoryUrl(item.repository_url)}#${item.number}`;
          const entry = seenPrs.get(key);
          if (entry === undefined) seenPrs.set(key, { item, sources: [source] });
          else entry.sources.push(source);
        }
      }
      const roleOf = (author: string): PullRequest["role"] => (author === sync.login ? "authored" : "other");
      for (const { item, sources: itemSources } of seenPrs.values()) {
        const repo = repoFromRepositoryUrl(item.repository_url);
        const pr: PullRequest = {
          repo,
          number: item.number,
          url: item.html_url,
          role: roleOf(item.user?.login ?? ""),
          state: prStateOf({ state: item.state, draft: item.draft, merged: item.pull_request?.merged_at != null }),
          author: item.user?.login ?? "",
          updatedAt: item.updated_at,
        };
        const sourceTags = itemSources.flatMap((source) => source.tags);
        const existing = stmts.byPr.get(repo, item.number);
        if (existing === undefined) {
          const projectId = await resolveProjectForRepo(repo, itemSources[0]!.projectId);
          const ticket = createTicket({
            title: item.title,
            description: "",
            columnId: initialColumn(columns, pr),
            kind: "pr",
            tags: sourceTags,
            sourceId: itemSources[0]!.id,
            threadId: null,
            projectId,
            pr,
          });
          if (autoStartThreads && projectId !== null) toSpawn.push(ticket.id);
          continue;
        }
        stmts.setPr.run(item.title, item.html_url, pr.state, pr.role, pr.author, item.updated_at, now, existing.id);
        mergeTags(existing, sourceTags);
      }
      // Comments: refetch when the PR's updated_at moved (comments bump it) or never fetched.
      for (const row of stmts.openPrs.all()) {
        if (row.comments_synced_for !== null && row.comments_synced_for === row.pr_updated_at) continue;
        try {
          await syncPrComments(row, auth.token, signal);
        } catch (error) {
          bb.log.warn(`could not sync comments for ${row.pr_repo}#${row.pr_number}: ${String(error)}`);
        }
      }
      // Tracked PRs that left every source: merged, closed, or gone from a source that treats that as done.
      const anyGithubFailed = results.some((result) => "failed" in result);
      for (const row of stmts.openPrs.all()) {
        if (anyGithubFailed || row.pr_repo === null || row.pr_number === null) continue;
        if (seenPrs.has(`${row.pr_repo}#${row.pr_number}`)) continue;
        let pull: GithubPull;
        try {
          pull = await github<GithubPull>(`/repos/${row.pr_repo}/pulls/${row.pr_number}`, auth.token, signal);
        } catch (error) {
          bb.log.warn(`could not refresh ${row.pr_repo}#${row.pr_number}: ${String(error)}`);
          continue;
        }
        const state = prStateOf(pull);
        const author = pull.user?.login ?? row.pr_author ?? "";
        stmts.setPr.run(pull.title, pull.html_url, state, roleOf(author), author, pull.updated_at, now, row.id);
        const goneFromDoneSource = row.source_id !== null && sourceById.get(row.source_id)?.doneWhenGone === true;
        finish(row, state === "merged" || state === "closed" || goneFromDoneSource);
      }
    }

    // ---- Jira ----
    if (jiraSources.length > 0 && jiraAuth === null) {
      problems.push("Jira sources need the Jira site URL, account email, and API token settings.");
    }
    if (jiraAuth !== null && jiraSources.length > 0) {
      const results = await Promise.all(
        jiraSources.map(async (source) => {
          try {
            return { source, issues: await searchJira(jiraAuth, source.jql, signal) };
          } catch (error) {
            problems.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
            return { source, issues: [] as JiraSearchIssue[], failed: true };
          }
        }),
      );
      const seenIssues = new Map<string, { issue: JiraSearchIssue; sources: Source[] }>();
      for (const { source, issues } of results) {
        for (const issue of issues) {
          const entry = seenIssues.get(issue.key);
          if (entry === undefined) seenIssues.set(issue.key, { issue, sources: [source] });
          else entry.sources.push(source);
        }
      }
      for (const { issue, sources: itemSources } of seenIssues.values()) {
        const jiraIssue = toJiraIssue(jiraAuth.site, issue);
        const sourceTags = itemSources.flatMap((source) => source.tags);
        const existing = stmts.byJira.get(issue.key);
        if (existing === undefined) {
          const projectId = await fallbackProject(itemSources[0]!.projectId);
          const ticket = createTicket({
            title: issue.fields.summary,
            description: adfToText(issue.fields.description).trim(),
            columnId: initialColumn(columns, null, jiraIssue),
            kind: "jira",
            tags: sourceTags,
            sourceId: itemSources[0]!.id,
            threadId: null,
            projectId,
            pr: null,
            jira: jiraIssue,
          });
          if (autoStartThreads && projectId !== null) toSpawn.push(ticket.id);
          continue;
        }
        stmts.setJira.run(
          issue.fields.summary,
          jiraIssue.url,
          jiraIssue.status,
          jiraIssue.statusCategory,
          jiraIssue.issueType,
          jiraIssue.priority,
          jiraIssue.assignee,
          jiraIssue.updatedAt,
          now,
          existing.id,
        );
        mergeTags(existing, sourceTags);
        if (jiraIssue.statusCategory === "done") finish(existing, true);
      }
      const anyJiraFailed = results.some((result) => "failed" in result);
      for (const row of stmts.openJira.all()) {
        if (anyJiraFailed || row.jira_key === null || seenIssues.has(row.jira_key)) continue;
        let issue: JiraSearchIssue;
        try {
          issue = await jira<JiraSearchIssue>(jiraAuth, `/rest/api/3/issue/${encodeURIComponent(row.jira_key)}?fields=${JIRA_FIELDS}`, signal);
        } catch (error) {
          bb.log.warn(`could not refresh ${row.jira_key}: ${String(error)}`);
          continue;
        }
        const jiraIssue = toJiraIssue(jiraAuth.site, issue);
        stmts.setJira.run(
          issue.fields.summary,
          jiraIssue.url,
          jiraIssue.status,
          jiraIssue.statusCategory,
          jiraIssue.issueType,
          jiraIssue.priority,
          jiraIssue.assignee,
          jiraIssue.updatedAt,
          now,
          row.id,
        );
        const goneFromDoneSource = row.source_id !== null && sourceById.get(row.source_id)?.doneWhenGone === true;
        finish(row, jiraIssue.statusCategory === "done" || goneFromDoneSource);
      }
    }

    sync.lastSyncAt = now;
    await bb.storage.kv.set("lastSyncAt", now);
    publish();

    for (const ticketId of toSpawn) {
      const ticket = getTicket(ticketId);
      if (ticket.projectId === null) continue;
      try {
        await spawnThreadForTicket(ticketId, ticket.projectId);
      } catch (error) {
        bb.log.warn(`could not start a thread for ticket ${ticketId}: ${String(error)}`);
      }
    }

    if (problems.length > 0) throw new Error(problems.join(" · "));
  }

  bb.background.service("github-sync", {
    async start(signal) {
      while (!signal.aborted) {
        await runSync(signal);
        const { syncIntervalMinutes } = await settings.get();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, syncIntervalMinutes * 60_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  reviewTagCache = normalizeTags([(await settings.get()).reviewTag])[0] ?? "pr-reviews";
  settings.onChange((next, prev) => {
    reviewTagCache = normalizeTags([next.reviewTag])[0] ?? "pr-reviews";
    if (next.githubToken !== prev.githubToken) {
      sync.login = null;
      void bb.storage.kv.delete("login");
      void runSync();
    } else if (
      next.jiraSiteUrl !== prev.jiraSiteUrl ||
      next.jiraEmail !== prev.jiraEmail ||
      next.jiraApiToken !== prev.jiraApiToken
    ) {
      void runSync();
    }
  });

  // ---- thread lifecycle --------------------------------------------------

  bb.events.on("thread.active", async ({ thread }) => {
    const { autoMoveOnActivity } = await settings.get();
    if (!autoMoveOnActivity) return;
    const row = stmts.byThread.get(thread.id);
    if (row === undefined) return;
    const columns = await getColumns();
    const target = columns.find((column) => column.id === "in-progress");
    if (target === undefined) return;
    const idleColumns = new Set(["backlog", "todo"]);
    if (idleColumns.has(row.column_id)) moveTicket(row.id, target.id, null);
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const dumpRow = stmts.dumpByThread.get(thread.id);
    if (dumpRow !== undefined && dumpRow.status === "planning") {
      const proposal = parseProposal(lastAssistantText);
      if (proposal === null) {
        stmts.setDumpFailed.run(
          lastAssistantText === null ? "The planning thread ended without a proposal." : `The planning thread replied without a kanban-proposal block. Its last message:\n\n${lastAssistantText.slice(0, 2000)}`,
          Date.now(),
          dumpRow.id,
        );
      } else {
        stmts.setDumpProposal.run(JSON.stringify(proposal), Date.now(), dumpRow.id);
      }
      publish();
      return;
    }
    const row = stmts.reviewByThread.get(thread.id);
    if (row === undefined || row.status !== "running") return;
    const report = parseReviewReport(lastAssistantText);
    const fromLine = lastAssistantText === null ? null : REVIEWED_COMMIT_LINE.exec(lastAssistantText)?.[1] ?? null;
    const commit = report?.commit ?? fromLine ?? row.commit_sha;
    // No report and no commit from any channel means the review never ran (setup failed, agent stopped early).
    if (report === null && commit === null) stmts.failReview.run(lastAssistantText, Date.now(), row.id);
    else stmts.completeReview.run(lastAssistantText, report?.commit ?? fromLine, Date.now(), row.id);
    publish();
  });

  bb.events.on("thread.archived", async ({ thread }) => {
    const row = stmts.byThread.get(thread.id);
    if (row === undefined) return;
    const columns = await getColumns();
    const done = doneColumn(columns);
    if (row.column_id !== done) moveTicket(row.id, done, null);
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    const now = Date.now();
    const changes = stmts.clearThread.run(now, thread.id).changes + stmts.clearReviewThread.run(now, thread.id).changes;
    if (changes > 0) publish();
  });

  bb.agents.configure((context) => {
    if (context.pluginMetadata.role === "plan" && typeof context.pluginMetadata.dumpId === "string") {
      return {
        tools: [],
        skills: ["kanban"],
        instructions: `This thread plans Kanban tickets from the user's dictation (brain dump ${JSON.stringify(context.pluginMetadata.dumpId)}). Every reply that proposes tickets must end with a \`\`\`json kanban-proposal block; do not create cards or start work yourself.`,
      };
    }
    const { ticketId } = context.pluginMetadata;
    if (typeof ticketId !== "string") return { tools: [], skills: [] };
    const row = stmts.byId.get(ticketId);
    if (row === undefined) return { tools: [], skills: [] };
    if (context.pluginMetadata.role === "review") {
      return {
        tools: [],
        skills: ["kanban"],
        instructions: `This thread is a code review for kanban ticket ${JSON.stringify(row.id)} (${JSON.stringify(row.title)}). Review only; do not move the card and do not post to GitHub. Record the reviewed commit with \`bb kanban review-record --commit <sha>\` and end your final message with "Reviewed commit: <sha>".`,
      };
    }
    if (context.pluginMetadata.role === "apply-comments") {
      return {
        tools: [],
        skills: ["kanban"],
        instructions: `This thread addresses PR review comments for kanban ticket ${JSON.stringify(row.id)} (${JSON.stringify(row.title)}) with the apply-pr-comments skill. Commit and push to the PR branch only, never force-push, never post to GitHub, and finish with \`bb kanban comments-applied --commit <sha>\`.`,
      };
    }
    if (context.pluginMetadata.role === "apply") {
      return {
        tools: [],
        skills: ["kanban"],
        instructions: `This thread applies a persisted code review to the PR of kanban ticket ${JSON.stringify(row.id)} (${JSON.stringify(row.title)}). Commit and push to the PR branch only, never force-push, never post to GitHub, and finish with \`bb kanban review-applied --commit <sha>\`.`,
      };
    }
    if (context.pluginMetadata.role === "subtasks") {
      return {
        tools: [],
        skills: ["kanban"],
        instructions: `This thread works through the subtasks of kanban ticket ${JSON.stringify(row.id)} (${JSON.stringify(row.title)}): list them with \`bb kanban subtasks --ticket ${row.id}\`, move each with \`bb kanban move <column> --ticket <subtask-id>\` as you go, and never move or finish a subtask you did not actually complete.`,
      };
    }
    const pr =
      row.pr_repo !== null && row.pr_number !== null
        ? ` It tracks GitHub PR ${JSON.stringify(`${row.pr_repo}#${row.pr_number}`)}.`
        : "";
    const parentRow = row.parent_id === null ? undefined : stmts.byId.get(row.parent_id);
    const parentNote = parentRow === undefined ? "" : ` It is a subtask of ${JSON.stringify(parentRow.title)} (ticket ${JSON.stringify(parentRow.id)}).`;
    const childCount = stmts.childrenOf.all(row.id).length;
    const childNote = childCount === 0 ? "" : ` It has ${childCount} subtask(s): \`bb kanban subtasks\` lists them; add more with \`bb kanban add "<title>" --parent ${row.id}\`.`;
    return {
      tools: [],
      skills: ["kanban"],
      instructions: [
        `This thread is kanban ticket ${JSON.stringify(row.id)} titled ${JSON.stringify(row.title)}, currently in column ${JSON.stringify(row.column_id)}.${pr}${parentNote}${childNote}`,
        "When you start working move it with `bb kanban move in-progress`; when the work is finished and verified, `bb kanban move done`. Run `bb kanban columns` to see the available columns.",
      ].join(" "),
    };
  });

  // ---- RPC ---------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    board_get: async () => ({
      columns: await getColumns(),
      tickets: stmts.all.all().map(hydrate),
      sources: await getSources(),
      tags: allTags(),
      sync,
      dumps: stmts.dumpsOpen.all().map(rowToDump),
    }),
    dump_create: ({ text, projectId }) => createDump(text, projectId),
    dumps_list: ({ includeClosed }) => ({ dumps: (includeClosed ? stmts.dumpsAll.all() : stmts.dumpsOpen.all()).map(rowToDump) }),
    dump_refine: ({ id, answers, notes }) => refineDump(id, answers, notes),
    dump_finalize: ({ id, tickets, columnId, startThreads }) => finalizeDump(id, tickets, columnId, startThreads),
    dump_discard: async ({ id }) => {
      const row = stmts.dumpById.get(id);
      if (row === undefined) throw new Error(`No brain dump with id ${id}`);
      stmts.setDumpDiscarded.run(Date.now(), id);
      publish();
      if (row.thread_id !== null) {
        try {
          await bb.sdk.threads.archive({ threadId: row.thread_id });
        } catch (error) {
          bb.log.warn(`could not archive planning thread ${row.thread_id}: ${String(error)}`);
        }
      }
      return rowToDump(stmts.dumpById.get(id)!);
    },
    ticket_create: async (input) => {
      const columns = await getColumns();
      const columnId =
        input.columnId !== undefined && columns.some((column) => column.id === input.columnId)
          ? input.columnId
          : initialColumn(columns, null);
      if (input.parentId !== null && stmts.byId.get(input.parentId) === undefined) throw new Error(`No ticket with id ${input.parentId}`);
      const parentProject = input.parentId === null ? null : (stmts.byId.get(input.parentId)?.project_id ?? null);
      const ticket = createTicket({
        title: input.title,
        description: input.description,
        columnId,
        kind: "adhoc",
        tags: input.tags,
        threadId: null,
        projectId: input.projectId ?? parentProject,
        pr: null,
        parentId: input.parentId,
      });
      publish();
      if (input.startThread && input.projectId !== null) {
        return spawnThreadForTicket(ticket.id, input.projectId);
      }
      return ticket;
    },
    ticket_update: ({ id, title, description }) => {
      const current = getTicket(id);
      stmts.setText.run(title ?? current.title, description ?? current.description, Date.now(), id);
      publish();
      return getTicket(id);
    },
    ticket_set_parent: ({ id, parentId }) => setParent(id, parentId),
    ticket_breakdown: async ({ id, projectId, guidance }) => {
      const ticket = getTicket(id);
      return promptTicketThread(ticket, await projectForTicket(ticket, projectId), breakdownPrompt(ticket, guidance), ticket.title, "breakdown");
    },
    ticket_start_children: ({ id, mode, projectId }) => startChildren(id, mode, projectId),
    ticket_set_tags: ({ id, tags }) => {
      getTicket(id);
      return setTags(id, tags);
    },
    sources_set: async ({ sources }) => {
      const ids = new Set<string>();
      for (const source of sources) {
        if (ids.has(source.id)) throw new Error(`Duplicate source id "${source.id}"`);
        ids.add(source.id);
      }
      await bb.storage.kv.set("sources", sources);
      publish();
      void runSync();
      return { sources };
    },
    ticket_move: async ({ id, columnId, index }) => {
      const columns = await getColumns();
      if (!columns.some((column) => column.id === columnId)) {
        throw new Error(`No column with id ${columnId}`);
      }
      return moveTicket(id, columnId, index);
    },
    ticket_delete: ({ id }) => {
      // Subtasks outlive their parent as top-level cards rather than disappearing with it.
      stmts.detachChildren.run(Date.now(), id);
      stmts.deleteReviewsForTicket.run(id);
      stmts.deleteCommentsForTicket.run(id);
      stmts.deleteCommentAppliesForTicket.run(id);
      stmts.deleteDiffCommentsForTicket.run(id);
      const result = stmts.remove.run(id);
      if (result.changes > 0) publish();
      return { deleted: result.changes > 0 };
    },
    ticket_start_thread: ({ id, projectId }) => spawnThreadForTicket(id, projectId),
    ticket_review_pr: async ({ id, projectId, mode }) => {
      const ticket = getTicket(id);
      if (ticket.pr === null) throw new Error("Only PR cards can be reviewed");
      return spawnReviewForTicket(id, await projectForTicket(ticket, projectId), mode);
    },
    review_list: ({ ticketId }) => ({ reviews: stmts.reviewsForTicket.all(ticketId).map(rowToReview) }),
    review_apply: ({ ticketId, reviewId, autoApprove, push }) => spawnApplyForReview(ticketId, reviewId, autoApprove, push),
    review_set_selection: ({ reviewId, findingId, selected }) => {
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
    },
    diff_get: ({ ticketId, refresh }) => ticketDiff(getTicket(ticketId), refresh),
    diff_comments_list: ({ ticketId }) => ({ comments: stmts.diffCommentsForTicket.all(ticketId).map(rowToDiffComment) }),
    diff_comment_add: ({ ticketId, path, line, side, body }) => {
      getTicket(ticketId);
      const now = Date.now();
      const id = randomUUID().slice(0, 8);
      stmts.insertDiffComment.run({ id, ticket_id: ticketId, path, line, side: line === null ? "RIGHT" : side, body, created_at: now, updated_at: now });
      publish();
      return rowToDiffComment(stmts.diffCommentById.get(id)!);
    },
    diff_comment_update: ({ id, body, line }) => {
      const row = stmts.diffCommentById.get(id);
      if (row === undefined) throw new Error(`No diff comment with id ${id}`);
      if (row.apply_id !== null) throw new Error("This comment was already submitted");
      stmts.updateDiffComment.run(body, line === undefined ? row.line : line, Date.now(), id);
      publish();
      return rowToDiffComment(stmts.diffCommentById.get(id)!);
    },
    diff_comment_delete: ({ id }) => {
      const result = stmts.deleteDiffComment.run(id);
      if (result.changes > 0) publish();
      return { deleted: result.changes > 0 };
    },
    diff_comments_submit: async ({ ticketId, postToGithub, address, autoApprove, push }) => {
      const ticket = getTicket(ticketId);
      const pending = stmts.pendingDiffComments.all(ticket.id).map(rowToDiffComment);
      if (pending.length === 0) throw new Error("No pending comments to submit");
      if (!postToGithub && !address) throw new Error("Choose at least one of: post to GitHub, address with a thread");
      let posted = 0;
      let postedUrl: string | null = null;
      if (postToGithub) {
        if (!ticket.canPostToGithub) throw new Error(`Posting to GitHub needs the review tag: only PR cards tagged #${reviewTagCache} can post`);
        const result = await postDiffCommentsToGithub(ticket, pending.filter((comment) => comment.postedAt === null));
        posted = result.posted;
        postedUrl = result.url;
      }
      let apply: CommentApply | null = null;
      if (address) {
        const result = await spawnApplyForComments(ticket.id, autoApprove, push, diffCommentsAsPrComments(ticket, pending));
        apply = result.apply;
        stmts.assignDiffCommentsApply.run(apply.id, JSON.stringify(pending.map((comment) => comment.id)));
      }
      publish();
      return { posted, postedUrl, apply, ticket: getTicket(ticket.id) };
    },
    comments_list: ({ ticketId }) => ({
      comments: stmts.commentsForTicket.all(ticketId).map(rowToComment),
      applies: stmts.commentAppliesForTicket.all(ticketId).map(rowToCommentApply),
    }),
    comment_set_selected: ({ id, selected }) => {
      if (stmts.commentById.get(id) === undefined) throw new Error(`No comment with id ${id}`);
      stmts.setCommentSelected.run(selected === null ? null : selected ? 1 : 0, id);
      publish();
      return rowToComment(stmts.commentById.get(id)!);
    },
    comment_set_addressed: ({ id, addressed }) => {
      if (stmts.commentById.get(id) === undefined) throw new Error(`No comment with id ${id}`);
      stmts.setCommentAddressed.run(addressed ? Date.now() : null, id);
      publish();
      return rowToComment(stmts.commentById.get(id)!);
    },
    comments_apply: ({ ticketId, autoApprove, push }) => spawnApplyForComments(ticketId, autoApprove, push),
    review_reset_selection: ({ reviewId }) => {
      const row = stmts.reviewById.get(reviewId);
      if (row === undefined) throw new Error(`No review with id ${reviewId}`);
      stmts.setSelectionOverrides.run(null, reviewId);
      publish();
      return rowToReview(stmts.reviewById.get(reviewId)!);
    },
    ticket_link_thread: ({ id, threadId }) => linkThread(id, threadId),
    columns_set: async ({ columns }) => {
      const ids = new Set<string>();
      for (const column of columns) {
        if (!/^[a-z0-9][a-z0-9-]*$/u.test(column.id)) {
          throw new Error(`Column id "${column.id}" must be lowercase letters, digits, and dashes`);
        }
        if (ids.has(column.id)) throw new Error(`Duplicate column id "${column.id}"`);
        ids.add(column.id);
      }
      const previous = await getColumns();
      const fallback = columns[0]!.id;
      const now = Date.now();
      db.transaction(() => {
        for (const column of previous) {
          if (!ids.has(column.id)) stmts.moveColumn.run(fallback, now, column.id);
        }
      })();
      await bb.storage.kv.set("columns", columns);
      publish();
      return { columns };
    },
    sync_now: async () => {
      await runSync();
      return sync;
    },
  });

  // ---- CLI ---------------------------------------------------------------

  function formatTicket(ticket: Ticket, columns: Column[]): string {
    const column = columns.find((candidate) => candidate.id === ticket.columnId)?.name ?? ticket.columnId;
    const pr =
      ticket.pr !== null
        ? `  ${ticket.pr.repo}#${ticket.pr.number} (${ticket.pr.state})`
        : ticket.jira !== null
          ? `  ${ticket.jira.key} (${ticket.jira.status})`
          : "";
    const tags = ticket.tags.length === 0 ? "" : `  ${ticket.tags.map((tag) => `#${tag}`).join(" ")}`;
    const thread = ticket.threadId === null ? "" : `  @thread:${ticket.threadId}`;
    const review = ticket.reviewThreadId === null ? "" : `  review:@thread:${ticket.reviewThreadId}`;
    const nesting = ticket.parentId !== null ? `  ↳ ${ticket.parentId}` : ticket.children.total > 0 ? `  (${ticket.children.done}/${ticket.children.total} subtasks)` : "";
    return `${ticket.id}  [${column}]  ${ticket.title}${tags}${pr}${thread}${review}${nesting}`;
  }

  function ticketForContext(ticketOption: string | undefined, threadId: string | undefined): Ticket {
    if (ticketOption !== undefined) return getTicket(ticketOption);
    if (threadId !== undefined) {
      const row = stmts.byThread.get(threadId);
      if (row !== undefined) return hydrate(row);
      throw new PluginCliError("This thread has no kanban card.", {
        code: "no_ticket_for_thread",
        hint: 'Create one with `bb kanban add "<title>"` or pass --ticket <id>.',
      });
    }
    throw new PluginCliError("No ticket given.", {
      code: "ticket_required",
      hint: "Pass --ticket <id>; run `bb kanban list` to see ids.",
    });
  }

  const ticketOption = {
    ticket: {
      type: "string",
      description: "Ticket id. Defaults to the card linked to the current thread.",
      aliases: ["id", "card"],
    },
  } as const;

  bb.cli.register(
    defineCli({
      name: "kanban",
      summary: "Kanban board where each card is a thread",
      commands: {
        list: cliCommand({
          summary: "List cards, grouped by column",
          options: {
            column: { type: "string", description: "Only this column id" },
            tag: { type: "string", repeatable: true, split: ",", description: "Only cards with this tag (repeatable)" },
            parent: { type: "string", description: "Only subtasks of this ticket id; `none` for top-level cards only" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }) {
            const columns = await getColumns();
            const wanted = normalizeTags(options.tag);
            const tickets = stmts.all
              .all()
              .map(hydrate)
              .filter((ticket) => options.parent === undefined || (options.parent === "none" ? ticket.parentId === null : ticket.parentId === options.parent))
              .filter((ticket) => options.column === undefined || ticket.columnId === options.column)
              .filter((ticket) => wanted.every((tag) => ticket.tags.includes(tag)));
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(tickets) };
            const lines: string[] = [];
            for (const column of columns) {
              if (options.column !== undefined && column.id !== options.column) continue;
              const inColumn = tickets.filter((ticket) => ticket.columnId === column.id);
              lines.push(`${column.name} (${column.id}) — ${inColumn.length}`);
              for (const ticket of inColumn) lines.push(`  ${formatTicket(ticket, columns)}`);
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        columns: cliCommand({
          summary: "List column ids and names",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }) {
            const columns = await getColumns();
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(columns)
                : columns.map((column) => `${column.id}  ${column.name}`).join("\n"),
            };
          },
        }),
        show: cliCommand({
          summary: "Show one card",
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(ticket) };
            const columns = await getColumns();
            const lines = [formatTicket(ticket, columns)];
            if (ticket.description !== "") lines.push("", ticket.description);
            if (ticket.pr !== null) lines.push("", ticket.pr.url);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        add: cliCommand({
          summary: "Add an ad hoc card; inside a thread, the card is linked to that thread",
          positionals: [{ name: "title", description: "Card title", required: true }],
          options: {
            description: { type: "string", description: "Longer description (markdown)", aliases: ["body"] },
            column: { type: "string", description: "Column id; defaults to backlog" },
            tag: { type: "string", repeatable: true, split: ",", description: "Tag to add (repeatable)" },
            parent: { type: "string", description: "Create the card as a subtask of this ticket id (implies --no-link)" },
            project: { type: "string", description: "Project id for a new thread; implies --start-thread" },
            "start-thread": {
              type: "boolean",
              description: "Spawn a thread for the card (needs --project or a fallback project setting)",
            },
            "no-link": { type: "boolean", description: "Do not link the card to the current thread" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ positionals, options }, ctx) {
            const columns = await getColumns();
            const columnId =
              options.column !== undefined && columns.some((column) => column.id === options.column)
                ? options.column
                : initialColumn(columns, null);
            if (options.column !== undefined && columnId !== options.column) {
              throw new PluginCliError(`No column with id ${options.column}`, {
                code: "unknown_column",
                hint: "Run `bb kanban columns`.",
              });
            }
            const parentRow = options.parent === undefined ? undefined : stmts.byId.get(options.parent);
            if (options.parent !== undefined && parentRow === undefined) {
              throw new PluginCliError(`No ticket with id ${options.parent}`, { code: "unknown_parent", hint: "Run `bb kanban list`." });
            }
            let ticket = createTicket({
              title: positionals.title,
              description: options.description ?? "",
              columnId,
              kind: "adhoc",
              tags: options.tag,
              threadId: null,
              projectId: options.project ?? parentRow?.project_id ?? null,
              pr: null,
              parentId: options.parent ?? null,
            });
            publish();
            if (ctx.threadId !== undefined && options.parent === undefined && !options["no-link"] && !options["start-thread"] && options.project === undefined) {
              ticket = await linkThread(ticket.id, ctx.threadId);
            } else if (options.project !== undefined || options["start-thread"]) {
              const { defaultProject } = await settings.get();
              const projectId = options.project ?? (typeof defaultProject === "string" && defaultProject !== "" ? defaultProject : null);
              if (projectId === null) {
                throw new PluginCliError("No project to start the thread in.", {
                  code: "project_required",
                  hint: "Pass --project <id> or set the fallback project in the plugin settings.",
                });
              }
              ticket = await spawnThreadForTicket(ticket.id, projectId);
            }
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(ticket) : `Added ${formatTicket(ticket, columns)}`,
            };
          },
        }),
        move: cliCommand({
          summary: "Move a card to a column (defaults to the current thread's card)",
          positionals: [{ name: "column", description: "Target column id", required: true }],
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }, ctx) {
            const columns = await getColumns();
            const target = columns.find(
              (column) =>
                column.id === positionals.column ||
                column.name.toLowerCase() === positionals.column.toLowerCase(),
            );
            if (target === undefined) {
              throw new PluginCliError(`No column "${positionals.column}"`, {
                code: "unknown_column",
                hint: `Columns: ${columns.map((column) => column.id).join(", ")}`,
              });
            }
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const moved = moveTicket(ticket.id, target.id, null);
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(moved) : formatTicket(moved, columns),
            };
          },
        }),
        review: cliCommand({
          summary: "Start a code-review thread for a card's pull request (defaults to the current thread's card)",
          options: {
            ...ticketOption,
            project: { type: "string", description: "Project id to run the review in; defaults to the card's project" },
            full: { type: "boolean", description: "Review the whole PR even if an earlier review exists (default: only commits since the last review)" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            if (ticket.pr === null) {
              throw new PluginCliError(`Ticket ${ticket.id} has no linked pull request.`, { code: "no_pull_request" });
            }
            const reviewed = await spawnReviewForTicket(
              ticket.id,
              await projectForTicket(ticket, options.project ?? null),
              options.full ? "full" : "incremental",
            );
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(reviewed) : `Review started in @thread:${reviewed.reviewThreadId}`,
            };
          },
        }),
        subtasks: cliCommand({
          summary: "List a card's subtasks (defaults to the current thread's card)",
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const columns = await getColumns();
            const children = stmts.childrenOf.all(ticket.id).map(hydrate);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(children) };
            if (children.length === 0) return { exitCode: 0, stdout: `${ticket.id} has no subtasks.` };
            return { exitCode: 0, stdout: children.map((child) => formatTicket(child, columns)).join("\n") };
          },
        }),
        "set-parent": cliCommand({
          summary: "Nest a card under another card, or `none` to make it top-level",
          positionals: [
            { name: "ticket", description: "Ticket id to move", required: true },
            { name: "parent", description: "Parent ticket id, or `none`", required: true },
          ],
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }) {
            const updated = setParent(positionals.ticket, positionals.parent === "none" ? null : positionals.parent);
            return { exitCode: 0, stdout: options.json ? JSON.stringify(updated) : formatTicket(updated, await getColumns()) };
          },
        }),
        "start-subtasks": cliCommand({
          summary: "Start agents on a card's open subtasks: one thread each, or one thread in order",
          options: {
            ...ticketOption,
            sequential: { type: "boolean", description: "One thread that works through the subtasks in order (default: one thread per subtask)" },
            project: { type: "string", description: "Project id for new threads; defaults to the card's project" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const result = await startChildren(ticket.id, options.sequential ? "sequential" : "parallel", options.project ?? null);
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(result) : `Started ${result.started} subtask thread(s)${result.skipped > 0 ? `, skipped ${result.skipped}` : ""}`,
            };
          },
        }),
        "review-record": cliCommand({
          summary: "Record the commit a running review covers (run by the review thread itself)",
          options: {
            commit: { type: "string", required: true, description: "Full sha of the reviewed PR head" },
            base: { type: "string", description: "PR base branch name" },
            head: { type: "string", description: "PR head branch name" },
            review: { type: "string", description: "Review id; defaults to the review owned by the current thread" },
          },
          async run({ options }, ctx) {
            const row =
              options.review !== undefined
                ? stmts.reviewById.get(options.review)
                : ctx.threadId === undefined
                  ? undefined
                  : stmts.reviewByThread.get(ctx.threadId);
            if (row === undefined) {
              throw new PluginCliError("No review found for this thread.", {
                code: "no_review_for_thread",
                hint: "Run this from the review thread, or pass --review <id>.",
              });
            }
            if (!/^[0-9a-f]{7,40}$/iu.test(options.commit)) {
              throw new PluginCliError(`"${options.commit}" is not a commit sha.`, { code: "invalid_commit" });
            }
            stmts.recordReviewCommit.run(options.commit, options.base ?? null, options.head ?? null, row.id);
            publish();
            return { exitCode: 0, stdout: `Review ${row.id} covers ${options.commit}` };
          },
        }),
        "review-show": cliCommand({
          summary: "Print the latest persisted review of a card",
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const row = stmts.latestCompletedReview.get(ticket.id);
            if (row === undefined) {
              throw new PluginCliError(`Ticket ${ticket.id} has no completed review.`, {
                code: "no_review",
                hint: "Start one with `bb kanban review`.",
              });
            }
            const review = rowToReview(row);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(review) };
            const counts = countSeverities(review.report);
            return {
              exitCode: 0,
              stdout: [
                `Review ${review.id} of ${ticket.id} at commit ${review.commitSha ?? "unknown"} (${new Date(review.completedAt ?? review.createdAt).toISOString()})${counts === null ? "" : `  critical ${counts.critical} · important ${counts.important} · minor ${counts.minor}`}`,
                "",
                review.body ?? "(empty)",
              ].join("\n"),
            };
          },
        }),
        "apply-review": cliCommand({
          summary: "Start a thread that applies the latest persisted review to the PR branch and pushes it",
          options: {
            ...ticketOption,
            review: { type: "string", description: "Review id; defaults to the latest completed review" },
            yes: { type: "boolean", description: "Apply every finding without the triage confirmation", aliases: ["auto-approve"] },
            "no-push": { type: "boolean", description: "Commit in the worktree but do not push to the PR branch" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const applied = await spawnApplyForReview(ticket.id, options.review ?? null, options.yes, !options["no-push"]);
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(applied)
                : `Apply started in @thread:${applied.latestReview?.apply?.threadId ?? "unknown"}`,
            };
          },
        }),
        comments: cliCommand({
          summary: "List the synced GitHub comments on a PR card (defaults to the current thread's card)",
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const comments = stmts.commentsForTicket.all(ticket.id).map(rowToComment);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(comments) };
            if (comments.length === 0) return { exitCode: 0, stdout: "No comments synced for this card." };
            return {
              exitCode: 0,
              stdout: comments
                .map(
                  (comment) =>
                    `${comment.selected ? "[x]" : "[ ]"} ${comment.id}  ${comment.author}${comment.path === null ? "" : `  ${comment.path}${comment.line === null ? "" : `:${comment.line}`}`}${comment.reviewState === null ? "" : `  ${comment.reviewState}`}${comment.addressedAt === null ? "" : "  (addressed)"}\n    ${comment.body.trim().split("\n")[0]?.slice(0, 160) ?? ""}`,
                )
                .join("\n"),
            };
          },
        }),
        "apply-comments": cliCommand({
          summary: "Start a thread that applies the selected PR comments with the apply-pr-comments skill and pushes",
          options: {
            ...ticketOption,
            yes: { type: "boolean", description: "Apply every selected comment without the triage confirmation", aliases: ["auto-approve"] },
            "no-push": { type: "boolean", description: "Commit in the worktree but do not push to the PR branch" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const result = await spawnApplyForComments(ticket.id, options.yes, !options["no-push"]);
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(result) : `Apply started in @thread:${result.apply.threadId}`,
            };
          },
        }),
        "comments-applied": cliCommand({
          summary: "Mark the selected comments addressed after pushing (run by the apply thread itself)",
          options: {
            commit: { type: "string", description: "Sha of the resulting commit" },
            pushed: { type: "boolean", description: "The commit was pushed to the PR branch" },
            apply: { type: "string", description: "Apply run id; defaults to the run owned by the current thread" },
          },
          async run({ options }, ctx) {
            const row =
              options.apply !== undefined
                ? stmts.commentApplyById.get(options.apply)
                : ctx.threadId === undefined
                  ? undefined
                  : stmts.commentApplyByThread.get(ctx.threadId);
            if (row === undefined) {
              throw new PluginCliError("No comment apply run found for this thread.", {
                code: "no_apply_for_thread",
                hint: "Run this from the apply thread, or pass --apply <id>.",
              });
            }
            const now = Date.now();
            stmts.completeCommentApply.run(now, options.commit ?? null, row.id);
            if (options.pushed) stmts.setCommentApplyPushed.run(row.id);
            stmts.markCommentsAddressed.run(now, row.comment_ids);
            stmts.markDiffCommentsAddressedByApply.run(now, row.id);
            publish();
            return { exitCode: 0, stdout: `Marked ${parseTags(row.comment_ids).length} comment(s) addressed${options.commit === undefined ? "" : ` at ${options.commit}`}` };
          },
        }),
        "review-applied": cliCommand({
          summary: "Mark the review's fixes as committed (and pushed) — run by the apply thread itself",
          options: {
            commit: { type: "string", description: "Sha of the resulting commit" },
            pushed: { type: "boolean", description: "The commit was pushed to the PR branch" },
            review: { type: "string", description: "Review id; defaults to the review being applied by the current thread" },
          },
          async run({ options }, ctx) {
            const row =
              options.review !== undefined
                ? stmts.reviewById.get(options.review)
                : ctx.threadId === undefined
                  ? undefined
                  : stmts.reviewByApplyThread.get(ctx.threadId);
            if (row === undefined) {
              throw new PluginCliError("No apply run found for this thread.", {
                code: "no_apply_for_thread",
                hint: "Run this from the apply thread, or pass --review <id>.",
              });
            }
            stmts.completeApply.run(Date.now(), options.commit ?? null, row.id);
            if (options.pushed) stmts.setApplyPushed.run(row.id);
            publish();
            return { exitCode: 0, stdout: `Review ${row.id} applied${options.commit === undefined ? "" : ` at ${options.commit}`}${options.pushed ? " (pushed)" : ""}` };
          },
        }),
        tag: cliCommand({
          summary: "Add tags to a card (defaults to the current thread's card)",
          positionals: [{ name: "tags", description: "Tags to add", required: true, variadic: true }],
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const parsed = z.array(tagSchema).safeParse(positionals.tags.map((tag) => tag.toLowerCase()));
            if (!parsed.success) {
              throw new PluginCliError(parsed.error.issues[0]?.message ?? "Invalid tag", { code: "invalid_tag" });
            }
            const updated = setTags(ticket.id, [...ticket.tags, ...parsed.data]);
            return { exitCode: 0, stdout: options.json ? JSON.stringify(updated) : formatTicket(updated, await getColumns()) };
          },
        }),
        untag: cliCommand({
          summary: "Remove tags from a card (defaults to the current thread's card)",
          positionals: [{ name: "tags", description: "Tags to remove", required: true, variadic: true }],
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const remove = new Set(normalizeTags(positionals.tags));
            const updated = setTags(ticket.id, ticket.tags.filter((tag) => !remove.has(tag)));
            return { exitCode: 0, stdout: options.json ? JSON.stringify(updated) : formatTicket(updated, await getColumns()) };
          },
        }),
        sources: cliCommand({
          summary: "List ticket sources and the tags they apply",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }) {
            const sources = await getSources();
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(sources) };
            return {
              exitCode: 0,
              stdout: sources
                .map(
                  (source) =>
                    `${source.id}${source.enabled ? "" : " (disabled)"}  ${source.name}  [${source.kind}] ${source.kind === "github-search" ? source.query : source.jql}  → ${source.tags.map((tag) => `#${tag}`).join(" ")}${source.doneWhenGone ? "  (done when gone)" : ""}`,
                )
                .join("\n"),
            };
          },
        }),
        link: cliCommand({
          summary: "Link an existing card to a thread (defaults to the current thread)",
          positionals: [{ name: "ticket", description: "Ticket id", required: true }],
          options: {
            thread: { type: "string", description: "Thread id; defaults to the current thread" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ positionals, options }, ctx) {
            const threadId = options.thread ?? ctx.threadId;
            if (threadId === undefined) {
              throw new PluginCliError("No thread to link.", {
                code: "thread_required",
                hint: "Pass --thread <id> or run this inside a thread.",
              });
            }
            const ticket = await linkThread(positionals.ticket, threadId);
            const columns = await getColumns();
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(ticket) : formatTicket(ticket, columns),
            };
          },
        }),
        remove: cliCommand({
          summary: "Delete a card (the thread is kept)",
          positionals: [{ name: "ticket", description: "Ticket id", required: true }],
          async run({ positionals }) {
            getTicket(positionals.ticket);
            stmts.remove.run(positionals.ticket);
            publish();
            return { exitCode: 0, stdout: `Removed ${positionals.ticket}` };
          },
        }),
        sync: cliCommand({
          summary: "Pull open GitHub PRs into the board now",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }) {
            await runSync();
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(sync) };
            if (sync.lastError !== null) return { exitCode: 1, stderr: sync.lastError };
            return {
              exitCode: 0,
              stdout: `Synced as ${sync.login ?? "unknown"} (${sync.tokenSource}) at ${new Date(sync.lastSyncAt ?? 0).toISOString()}`,
            };
          },
        }),
      },
    }),
  );

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
