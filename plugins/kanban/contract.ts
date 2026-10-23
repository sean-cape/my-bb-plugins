import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { TICKET_TITLE_MAX_LENGTH, boardSchema, columnSchema, dueDateSchema, sourceSchema, syncStatusSchema, tagSchema, ticketSchema } from "./shared/board";
import { commentApplySchema, conversationEventSchema, diffCommentSchema, diffCommentTargetSchema, pendingReviewStateSchema, prCommentSchema, reviewEventSchema } from "./shared/comments";
import { blameLineSchema, commitRangeSchema, diffCommitsSchema, diffDeltaSchema, diffSideSchema, structuralDiffSchema, suggestionItemSchema, symbolLookupSchema, symbolUsagesSchema, ticketDiffSchema } from "./shared/diff";
import { dumpSchema, proposedTicketSchema } from "./shared/dump";
import { PLAN_MAX_LENGTH, attentionLevelSchema, levelOverrideSchema, loopGatesSchema, pathRuleSchema, projectSettingsSchema } from "./shared/loop";
import { readingPlanSchema } from "./shared/reading-plan";
import { DEFAULT_REVIEW_DEPTH, findingEditSchema, reviewDepthSchema, reviewSchema } from "./shared/review";
import { codeReviewThreadSchema, hunkExplanationSchema, narrativeSchema, narrativeStorySchema } from "./shared/tour";

export const rpcContract = defineRpcContract({
  board_get: { input: z.null(), output: boardSchema },
  ticket_create: {
    input: z
      .object({
        title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH),
        description: z.string().max(10_000).default(""),
        columnId: z.string().optional(),
        tags: z.array(tagSchema).max(20).default([]),
        projectId: z.string().nullable().default(null),
        startThread: z.boolean().default(false),
        /** The card's own monitoring flag; absent, the tags' monitoring default decides. */
        monitored: z.boolean().optional(),
        /** Create the card as a subtask of this card. */
        parentId: z.string().nullable().default(null),
        dueDate: dueDateSchema.nullable().default(null),
        /** Created under the new card, in its column and project, before any thread starts. */
        subtasks: z
          .array(
            z
              .object({
                title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH),
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
        title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH).optional(),
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
  ticket_restore: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ restored: z.boolean() }),
  },
  ticket_start_thread: {
    input: z.object({ id: z.string(), projectId: z.string() }).strict(),
    output: ticketSchema,
  },
  /** Turn the review loop on or off; off stops it after its current step. */
  /** `gates` are chosen as monitoring turns on; without them the card's kind picks the defaults. */
  ticket_set_monitored: {
    input: z.object({ id: z.string(), monitored: z.boolean(), gates: loopGatesSchema.optional() }).strict(),
    output: ticketSchema,
  },
  loop_set_gates: { input: z.object({ id: z.string(), gates: loopGatesSchema }).strict(), output: ticketSchema },
  /** While the plan gate holds the card: the plan, as proposed or edited, goes to its thread and every later review. */
  loop_approve_plan: { input: z.object({ id: z.string(), plan: z.string().trim().min(1).max(PLAN_MAX_LENGTH) }).strict(), output: ticketSchema },
  /** While the findings gate holds a round: the approved findings go to fix, the rest stay open. */
  loop_approve_findings: { input: z.object({ id: z.string(), findingIds: z.array(z.string()) }).strict(), output: ticketSchema },
  /** At Needs you: a local card's thread lands the change, a PR card is left for the user to merge. */
  loop_accept: { input: z.object({ id: z.string() }).strict(), output: ticketSchema },
  /** At Needs you: the card's unsent local diff comments go to its thread as the user's round. */
  loop_send_back: { input: z.object({ id: z.string() }).strict(), output: ticketSchema },
  /** At Needs you: the loop stops and the card's thread proposes a new approach. */
  loop_rethink: { input: z.object({ id: z.string() }).strict(), output: ticketSchema },
  /** At Needs you: the user's attention level, with why, until the head moves. */
  loop_set_level: { input: z.object({ id: z.string(), level: attentionLevelSchema, reason: levelOverrideSchema.shape.reason }).strict(), output: ticketSchema },
  /** The files the handoff brief asks the user to read at the card's level; null when the brief isn't showing. */
  loop_reading_plan: { input: z.object({ id: z.string() }).strict(), output: readingPlanSchema.nullable() },
  /** At Needs you: a deferred or dropped finding of the last review goes to fix as the user's round. */
  loop_pull_in: { input: z.object({ id: z.string(), findingId: z.string() }).strict(), output: ticketSchema },
  /** At Needs you: uphold a rejected dispute, which sends its finding to fix, or close it. */
  loop_decide_dispute: { input: z.object({ id: z.string(), findingId: z.string(), decision: z.enum(["uphold", "close"]) }).strict(), output: ticketSchema },
  /** The project's check command, which monitored cards' checks re-run; null leaves the choice to each card's agent. */
  project_set_check_command: {
    input: z.object({ projectId: z.string(), checkCommand: z.string().trim().max(2000).nullable() }).strict(),
    output: projectSettingsSchema,
  },
  /** Globs whose changed files get at least the given attention level, and so a review at least that deep. */
  project_set_path_rules: {
    input: z.object({ projectId: z.string(), pathRules: z.array(pathRuleSchema).max(50) }).strict(),
    output: projectSettingsSchema,
  },
  diff_get: {
    input: z.object({ ticketId: z.string(), refresh: z.boolean().default(false), range: commitRangeSchema.nullable().default(null) }).strict(),
    output: ticketDiffSchema,
  },
  diff_structural: {
    input: z.object({ ticketId: z.string(), path: z.string().min(1), range: commitRangeSchema.nullable().default(null) }).strict(),
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
  /** The user's pending review on the PR as the board knows it: the summary drafted so far, and whether one exists on GitHub. */
  pending_review_get: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: pendingReviewStateSchema,
  },
  /** The review box's summary; it reaches the pending review on GitHub once there is one. */
  pending_review_set_body: {
    input: z.object({ ticketId: z.string(), body: z.string().max(65_000) }).strict(),
    output: pendingReviewStateSchema,
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
  /** Every narrative review of the subject with the diff it was written against, oldest first, for stepping across heads. */
  narrative_story: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: narrativeStorySchema,
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
        /** The review's summary, as GitHub's "Leave a comment" box on "Finish your review"; posted above any file-level drafts. */
        reviewBody: z.string().default(""),
        /** Start a thread that addresses the pending local comments. */
        address: z.boolean().default(true),
        push: z.boolean().default(true),
      })
      .strict(),
    output: z.object({
      posted: z.number().int(),
      postedUrl: z.string().nullable(),
      /** An approval posted and the card went to Done for it. */
      movedToDone: z.boolean(),
      apply: commentApplySchema.nullable(),
      ticket: ticketSchema,
    }),
  },
  comments_list: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ comments: z.array(prCommentSchema), applies: z.array(commentApplySchema) }),
  },
  /** The PR's description, every submitted review and its changes (merged, renamed, force-pushed) for the conversation view; empty for a card without a PR. */
  pr_conversation: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ events: z.array(conversationEventSchema) }),
  },
  comment_set_selected: {
    input: z.object({ id: z.string(), selected: z.boolean().nullable() }).strict(),
    output: prCommentSchema,
  },
  comment_set_addressed: {
    input: z.object({ id: z.string(), addressed: z.boolean() }).strict(),
    output: prCommentSchema,
  },
  /** Resolves or reopens the GitHub review thread an inline comment belongs to. */
  comment_set_resolved: {
    input: z.object({ id: z.string(), resolved: z.boolean() }).strict(),
    output: prCommentSchema,
  },
  comments_apply: {
    input: z.object({ ticketId: z.string(), push: z.boolean().default(true) }).strict(),
    output: z.object({ ticket: ticketSchema, apply: commentApplySchema }),
  },
  ticket_review_pr: {
    input: z
      .object({
        id: z.string(),
        projectId: z.string().nullable().default(null),
        /** `incremental` reviews only commits since the last completed review; falls back to full. */
        mode: z.enum(["full", "incremental"]).default("incremental"),
        depth: reviewDepthSchema.default(DEFAULT_REVIEW_DEPTH),
      })
      .strict(),
    output: ticketSchema,
  },
  /** Why the card can't be reviewed yet; null when it can. */
  review_availability: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ reason: z.string().nullable() }),
  },
  review_list: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: z.object({ reviews: z.array(reviewSchema) }),
  },
  review_set_selection: {
    input: z.object({ reviewId: z.string(), findingId: z.string(), selected: z.boolean() }).strict(),
    output: reviewSchema,
  },
  /** Cross a finding off by hand, or reopen one an apply round marked applied. */
  review_set_applied: {
    input: z.object({ reviewId: z.string(), findingId: z.string(), applied: z.boolean() }).strict(),
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
  /** A backlog card for a finding that is separate work (one that was already there before the change); the card made from it before, if any. */
  review_make_card: {
    input: z.object({ reviewId: z.string(), findingId: z.string() }).strict(),
    output: z.object({ ticket: ticketSchema, created: z.boolean() }),
  },
  review_apply: {
    input: z
      .object({
        ticketId: z.string(),
        reviewId: z.string().nullable().default(null),
        /** Push the resulting commit to the PR branch; otherwise commit locally in the worktree. A local review never pushes. */
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
  /** The text patch of a file the diff came without one for (GitHub leaves big files' patches out), made from its two sides. */
  diff_load_patch: {
    input: z.object({ ticketId: z.string(), path: z.string().min(1), range: commitRangeSchema.nullable().default(null) }).strict(),
    output: z.object({ patch: z.string().nullable() }),
  },
  /** Who last changed lines of one side of a file in the card's diff. */
  diff_blame: {
    input: z.object({ ticketId: z.string(), path: z.string().min(1), side: diffSideSchema, startLine: z.number().int().min(1), endLine: z.number().int().min(1), range: commitRangeSchema.nullable().default(null) }).strict(),
    output: z.object({ lines: z.array(blameLineSchema) }),
  },
  /**
   * Applies suggested changes: one commit on a PR card's head branch (then its applied GitHub threads resolve), else
   * the card thread's checkout, uncommitted. Refused whole when any item's lines moved, or the branch moved past the
   * head the items were read at. A null or blank message commits with GitHub's default.
   */
  suggestions_apply: {
    input: z.object({ ticketId: z.string(), items: z.array(suggestionItemSchema).min(1).max(200), message: z.string().max(2_000).nullable().default(null) }).strict(),
    output: z.object({ applied: z.number().int(), commitUrl: z.string().nullable() }),
  },
  /** The diff's commits (the PR's, or the local checkout's with uncommitted changes last) and review marks, for `gr`. */
  diff_commits: {
    input: z.object({ ticketId: z.string() }).strict(),
    output: diffCommitsSchema,
  },
});
