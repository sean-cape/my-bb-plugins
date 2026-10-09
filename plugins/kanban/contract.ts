import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { boardSchema, columnSchema, dueDateSchema, sourceSchema, syncStatusSchema, tagSchema, ticketSchema } from "./shared/board";
import { commentApplySchema, diffCommentSchema, diffCommentTargetSchema, prCommentSchema, reviewEventSchema } from "./shared/comments";
import { diffDeltaSchema, diffSideSchema, structuralDiffSchema, symbolLookupSchema, symbolUsagesSchema, ticketDiffSchema } from "./shared/diff";
import { dumpSchema, proposedTicketSchema } from "./shared/dump";
import { findingEditSchema, reviewSchema } from "./shared/review";
import { codeReviewThreadSchema, hunkExplanationSchema, narrativeSchema } from "./shared/tour";

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
        dueDate: dueDateSchema.nullable().default(null),
        /** Created under the new card, in its column and project, before any thread starts. */
        subtasks: z
          .array(
            z
              .object({
                title: z.string().trim().min(1).max(200),
                description: z.string().max(10_000).default(""),
                tags: z.array(tagSchema).max(20).default([]),
              })
              .strict(),
          )
          .max(50)
          .default([]),
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
  /** `null` clears the due date. */
  ticket_set_due_date: {
    input: z.object({ id: z.string(), dueDate: dueDateSchema.nullable() }).strict(),
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
  diff_structural: {
    input: z.object({ ticketId: z.string(), path: z.string().min(1) }).strict(),
    output: structuralDiffSchema,
  },
  symbol_definitions: {
    input: z.object({ ticketId: z.string(), symbol: z.string().trim().min(1).max(200) }).strict(),
    output: symbolLookupSchema,
  },
  /** Every whole-word occurrence of a symbol in the card's local checkout. */
  symbol_usages: {
    input: z.object({ ticketId: z.string(), symbol: z.string().trim().min(1).max(200) }).strict(),
    output: symbolUsagesSchema,
  },
  /** A slice of a file in the card's local checkout, for widening an inline peek. */
  symbol_peek_file: {
    input: z.object({ ticketId: z.string(), path: z.string().min(1), startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).strict(),
    output: z.object({ startLine: z.number().int(), lines: z.array(z.string()), totalLines: z.number().int() }),
  },
  diff_comments_list: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ comments: z.array(diffCommentSchema) }),
  },
  /** The agent-written tour of a card's changes: latest one, plus whether the diff head moved since. */
  narrative_get: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ narrative: narrativeSchema.nullable(), stale: z.boolean() }),
  },
  narrative_generate: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: narrativeSchema,
  },
  /** Agent explanations of hunks for the diff's current head. */
  hunk_explanations_list: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ explanations: z.array(hunkExplanationSchema) }),
  },
  /** Every thread the code review buttons started for the diff subject, newest first. */
  code_review_threads: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ threads: z.array(codeReviewThreadSchema) }),
  },
  hunk_explain: {
    input: z.object({ ticketId: z.string(), path: z.string().min(1), side: z.enum(["old", "new"]).default("new"), startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).strict(),
    output: hunkExplanationSchema,
  },
  /** Files and line ranges that changed since the reviewer's last viewed head; null when the head has not moved. */
  diff_delta: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ delta: diffDeltaSchema.nullable() }),
  },
  /** Files the reviewer has ticked as viewed; marks on an older head carry over for files that did not change since. */
  diff_viewed_list: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ paths: z.array(z.string()) }),
  },
  diff_viewed_set: {
    input: z.object({ ticketId: z.string(), path: z.string().min(1), viewed: z.boolean() }).strict(),
    output: z.object({ paths: z.array(z.string()) }),
  },
  diff_comment_add: {
    input: z
      .object({
        ticketId: z.string(),
        path: z.string().min(1),
        line: z.number().int().min(1).nullable().default(null),
        side: diffSideSchema.default("RIGHT"),
        /** First line of a multi-line comment, which ends at `line`. */
        startLine: z.number().int().min(1).nullable().default(null),
        startSide: diffSideSchema.nullable().default(null),
        body: z.string().trim().min(1).max(10_000),
        /** Defaults to the card's default target for new threads, and to local for replies. */
        target: diffCommentTargetSchema.optional(),
        /** Reply in this thread (a diff comment id or a synced `review-comment:<n>` id); path, line and side come from its root. */
        inReplyTo: z.string().min(1).nullable().default(null),
      })
      .strict(),
    output: diffCommentSchema,
  },
  diff_comment_update: {
    input: z
      .object({
        id: z.string(),
        body: z.string().trim().min(1).max(10_000).optional(),
        line: z.number().int().min(1).nullable().optional(),
        target: diffCommentTargetSchema.optional(),
      })
      .strict(),
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
        /** Post the GitHub drafts: new threads as one review, replies into their threads. */
        postToGithub: z.boolean().default(false),
        /** The review the drafts post as, as on GitHub's "Finish your review". */
        reviewEvent: reviewEventSchema.default("COMMENT"),
        /** Start a thread that addresses the pending local comments. */
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
  /** Reword a finding before it is applied; `edit: null` restores the reviewer's original text. */
  review_edit_finding: {
    input: z.object({ reviewId: z.string(), findingId: z.string(), edit: findingEditSchema.nullable() }).strict(),
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
