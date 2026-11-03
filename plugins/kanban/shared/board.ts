import { z } from "zod";
import { COLUMN } from "./columns";
import { dumpSchema } from "./dump";
import { loopStateSchema, projectSettingsSchema } from "./loop";
import { reviewDepthSchema, reviewSummarySchema } from "./review";
import { tokensSchema } from "./spend";

export const TICKET_TITLE_MAX_LENGTH = 200;

export const columnSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  /** Cards that have sat in the column longer than this are hidden on the board; unset keeps them all. */
  hideAfterDays: z.number().int().min(1).max(365).nullable().optional(),
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

/** A calendar day, `YYYY-MM-DD`, with no time or zone: a card is due on a day wherever you are. */
export const dueDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Due dates are YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, "Not a real calendar date");

/** How much a card matters, Todoist-style: 1 is the most urgent, 4 the least; a card without one has none. */
export const prioritySchema = z.number().int().min(1).max(4);
export type Priority = z.infer<typeof prioritySchema>;

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
  /** Depth of the code review started on every PR card this source creates or brings back; null starts none. */
  reviewNewPrs: reviewDepthSchema.nullable().default(null),
  /** Writes a narrative review of every PR card this source creates or brings back. */
  narrateNewPrs: z.boolean().default(false),
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
    reviewNewPrs: null,
    narrateNewPrs: false,
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
    reviewNewPrs: null,
    narrateNewPrs: false,
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
/** The head commit's combined CI status. */
export const prChecksSchema = z.enum(["passing", "failing", "pending"]);

export const pullRequestSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  role: prRoleSchema,
  state: prStateSchema,
  author: z.string(),
  updatedAt: z.string(),
  /** Null until the first sync reads it. */
  headRef: z.string().nullable(),
  /** Null when the head commit has no checks, or they have not been read yet. */
  checks: prChecksSchema.nullable(),
  /** Where the checks tick leads: the failing (else pending, else first) check's own page; null falls back to the PR's checks tab. */
  checksUrl: z.string().nullable().default(null),
  /** The PR's description as written on GitHub; null until a sync reads it. */
  body: z.string().nullable().default(null),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

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
  /** The threads of the review loop's checks and classify steps while they run; null between runs. */
  checksThreadId: z.string().nullable(),
  classifyThreadId: z.string().nullable(),
  latestReview: reviewSummarySchema.nullable(),
  /** PR comment counts: everything synced, and the ones not yet marked addressed. */
  comments: z.object({ total: z.number().int(), open: z.number().int(), selected: z.number().int() }).nullable(),
  /** Parent card when this is a subtask; null for top-level cards. */
  parentId: z.string().nullable(),
  dueDate: z.string().nullable(),
  priority: prioritySchema.nullable(),
  /** A calendar day the card stays hidden until: snoozed while the viewer's day is before it; null when awake. */
  snoozedUntil: z.string().nullable(),
  /** Subtask progress: how many children exist and how many are in the done column. */
  children: z.object({ total: z.number().int(), done: z.number().int(), withThread: z.number().int() }),
  /** Comments the user left on the card's diff that have not been submitted for addressing yet. */
  pendingDiffComments: z.number().int(),
  /** Whether diff comments can go to the GitHub PR (any PR card). */
  canPostToGithub: z.boolean(),
  /** Where a new diff comment goes unless the user picks otherwise: GitHub for PRs carrying the review tag. */
  defaultCommentTarget: z.enum(["local", "github"]),
  projectId: z.string().nullable(),
  pr: pullRequestSchema.nullable(),
  jira: jiraIssueSchema.nullable(),
  position: z.number(),
  /** When the card moved into its current column. */
  columnEnteredAt: z.number(),
  /** The monitored review loop's state; null for a card that was never monitored. */
  loop: loopStateSchema.nullable(),
  /** Tokens used by every thread the card started, from Claude Code's transcripts; null before any were used. */
  spend: tokensSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Ticket = z.infer<typeof ticketSchema>;

/** A small model's pick of the project a card with none belongs to, offered as the card panel's default. */
export const projectGuessSchema = z.object({ projectId: z.string(), reason: z.string() });
export type ProjectGuess = z.infer<typeof projectGuessSchema>;

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

export const boardSchema = z.object({
  columns: z.array(columnSchema),
  tickets: z.array(ticketSchema),
  sources: z.array(sourceSchema),
  /** Every tag in use, sorted. */
  tags: z.array(z.string()),
  sync: syncStatusSchema,
  /** Brain dumps still in flight or awaiting review (planning, ready, failed). */
  dumps: z.array(dumpSchema),
  /** Per-project settings, by project id; a project with none set is absent. */
  projectSettings: z.record(z.string(), projectSettingsSchema),
});
export type Board = z.infer<typeof boardSchema>;

/**
 * A new board's columns, for any kind of to-do; the ids are the ones agents have always moved cards by. The review
 * loop adds its own columns the first time a card is monitored.
 */
export const DEFAULT_COLUMNS: Column[] = [
  { id: COLUMN.backlog, name: "Backlog" },
  { id: COLUMN.todo, name: "To Do" },
  { id: COLUMN.inProgress, name: "Doing" },
  { id: COLUMN.waiting, name: "Waiting" },
  { id: COLUMN.done, name: "Done" },
];

/** What the review loop calls the columns it adds to a board; columns a board already has keep their own names. */
export const LOOP_COLUMN_NAMES = {
  [COLUMN.inProgress]: "Building",
  [COLUMN.checking]: "Checking",
  [COLUMN.review]: "Needs you",
} as const;


/** The defaults before the review loop. A board that never stored its columns showed these, and keeps them. */
export const PRE_LOOP_DEFAULT_COLUMNS: Column[] = [
  { id: COLUMN.backlog, name: "Backlog" },
  { id: COLUMN.todo, name: "To Do" },
  { id: COLUMN.inProgress, name: "In Progress" },
  { id: COLUMN.review, name: "In Review" },
  { id: COLUMN.done, name: "Done" },
];
