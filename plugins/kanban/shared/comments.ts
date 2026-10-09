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
