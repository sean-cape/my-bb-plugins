import { z } from "zod";
import { diffSideSchema } from "./diff";

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
  /** Root of the review thread this replies to; GitHub always points replies at the thread's first comment. */
  inReplyTo: z.string().nullable(),
  /** Diff side an inline comment sits on. */
  side: diffSideSchema,
  /** First line of a multi-line comment, which ends at `line`; null for one line. */
  startLine: z.number().int().nullable(),
  startSide: diffSideSchema.nullable(),
  /** The line it was left on no longer exists in the PR head; `line` is then the original line. */
  outdated: z.boolean(),
  /** Whether the review thread is resolved on GitHub; null when unknown. */
  resolved: z.boolean().nullable(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Effective selection for the apply round. */
  selected: z.boolean(),
  /** Set when the user toggled the checkbox, overriding the default. */
  selectionOverride: z.boolean().nullable(),
  addressedAt: z.number().nullable(),
  /** GitHub's `diff_hunk`: the hunk an inline comment was left on, ending at its line, as GitHub stored it. */
  diffHunk: z.string().nullable(),
  /** The line (and a range's first line) the comment was left on, which an outdated comment keeps. */
  originalLine: z.number().int().nullable(),
  originalStartLine: z.number().int().nullable(),
  /** The review an inline comment was submitted in (`review:<n>`); null for other kinds, or when GitHub named none. */
  reviewId: z.string().nullable(),
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

/** `local` comments are handed to an apply thread; `github` ones are drafts posted to the PR. */
export const diffCommentTargetSchema = z.enum(["local", "github"]);
export type DiffCommentTarget = z.infer<typeof diffCommentTargetSchema>;

/** The user's pending review on the PR: the summary drafted so far, its link on GitHub once it exists there, and how many drafts sit in it. */
export const pendingReviewStateSchema = z.object({ body: z.string(), url: z.string().nullable(), staged: z.number().int() });
export type PendingReviewState = z.infer<typeof pendingReviewStateSchema>;

/** How posted GitHub drafts conclude the review; approving and requesting changes need a PR by someone else. */
export const reviewEventSchema = z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

/** A comment left on the card's diff: by the user (`author` null), or an agent's reply in a thread. */
export const diffCommentSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  /** Which side of the diff the line number refers to: RIGHT = new file (default), LEFT = removed line. */
  side: diffSideSchema,
  /** First line of a multi-line comment, which ends at `line`; null for one line. */
  startLine: z.number().int().nullable(),
  startSide: diffSideSchema.nullable(),
  body: z.string(),
  target: diffCommentTargetSchema,
  /** Thread root: another diff comment's id, or a synced GitHub comment id (`review-comment:<n>`). */
  inReplyTo: z.string().nullable(),
  /** Null for the user's own comments; `agent` for replies an apply thread left. */
  author: z.string().nullable(),
  authorThreadId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  postedAt: z.number().nullable(),
  postedUrl: z.string().nullable(),
  /** The synced comment this became once posted (`review-comment:<n>`, or `review:<n>` when it went in a review body). */
  githubCommentId: z.string().nullable(),
  addressedAt: z.number().nullable(),
  applyId: z.string().nullable(),
});
export type DiffComment = z.infer<typeof diffCommentSchema>;

/** What a pull request's conversation lists besides its commits and synced comments; see `ConversationEvent` in bb-diff-view. */
export const conversationEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("opened"), id: z.string(), author: z.string(), body: z.string(), createdAt: z.string(), url: z.string() }),
  z.object({
    kind: z.literal("review"),
    id: z.string(),
    author: z.string(),
    mine: z.boolean(),
    state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]),
    body: z.string(),
    createdAt: z.string(),
    url: z.string(),
  }),
  z.object({
    kind: z.literal("action"),
    id: z.string(),
    action: z.enum(["merged", "closed", "reopened", "force-pushed", "ready-for-review", "converted-to-draft", "review-requested", "renamed", "branch-deleted"]),
    actor: z.string(),
    detail: z.string().nullable(),
    createdAt: z.string(),
  }),
]);
export type ConversationEvent = z.infer<typeof conversationEventSchema>;
