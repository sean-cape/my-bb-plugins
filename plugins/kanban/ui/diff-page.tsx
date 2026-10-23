import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { POPOVER_MOTION, PRESS, enter, usePopOnChange } from "bb-motion";
import { useKeyHandler } from "bb-vim-keys/react";
import { DiffView, type DiffSource, type DiffViewLabels, type PendingComments } from "bb-diff-view/app/diff-view";
import type { rpcContract } from "../contract";
import type { Board, Ticket } from "../shared/board";
import type { ReviewEvent } from "../shared/comments";
import { CONFIDENCE_BAR } from "../shared/review";
import { BOARD_CHANGED, THREAD_SUBJECT_PREFIX } from "../shared/events";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { REVIEW_POPOVER_KEYS, SEND_BAR_KEYS, type ReviewPopoverCommand } from "./board-nav";
import { useBoard, usePushPreference } from "./data";
import { PushToggle, COMPACT, ExternalLink } from "./primitives";
import { toastError } from "./actions";
import { HandoffStrip } from "./brief-panel";
import { collapseRightPanel } from "./page-state";
import { DiffPageHeading } from "./diff-heading";
import { planStory } from "./reading-plan";
import { notifyViewedChanged } from "./use-reading-plan";

/** Pairs a changes view with the title-bar controls that refresh it. */
export function diffInstanceKey(subjectId: string): string {
  return `kanban:${subjectId}`;
}

const KANBAN_DIFF_LABELS: Partial<DiffViewLabels> = {
  localTarget: "Kept on the board for an agent to address; never posted",
  localOnlyThread: "This thread is local to the board",
  localHint: "Stays on the board until you send it to an agent",
  makeLocal: "Keep this on the board for an agent instead of posting it",
  noCheckout: "No checkout to open this file in; start the card's thread first.",
  filteredFindings: `Findings the review's verifier scored below ${CONFIDENCE_BAR} for being real; never selected or applied`,
};

/** The board's data for one diff subject (a card id or `thread:<threadId>`), as the shared diff view reads it. */
/** `plan` cuts the narrative down to the card's reading plan. */
function useKanbanDiffSource(subjectId: string, ticket: Ticket | null, plan: boolean, refetch: () => void, onOpenTicket: (ticketId: string) => void): DiffSource {
  const rpc = useRpc<typeof rpcContract>();
  // Read through a ref so a new callback each render doesn't rebuild the source, which would refetch the view.
  const openTicket = useRef(onOpenTicket);
  openTicket.current = onOpenTicket;
  const prTicketId = ticket !== null && ticket.pr !== null ? ticket.id : null;
  // Reviews hang off cards; a thread without one has none yet.
  const reviewSubjectId = ticket?.id ?? (subjectId.startsWith(THREAD_SUBJECT_PREFIX) ? null : subjectId);
  const canPostToGithub = ticket?.canPostToGithub ?? false;
  const defaultCommentTarget = ticket?.defaultCommentTarget ?? "local";
  const planTicketId = plan ? (ticket?.id ?? null) : null;
  return useMemo<DiffSource>(
    () => ({
      getDiff: (refresh, range) => rpc.call("diff_get", { ticketId: subjectId, refresh, range }),
      getStructural: (path, range) => rpc.call("diff_structural", { ticketId: subjectId, path, range }),
      symbolDefinitions: (symbol) => rpc.call("symbol_definitions", { ticketId: subjectId, symbol }),
      symbolUsages: (symbol) => rpc.call("symbol_usages", { ticketId: subjectId, symbol }),
      peekFile: (path, startLine, endLine) => rpc.call("symbol_peek_file", { ticketId: subjectId, path, startLine, endLine }),
      listViewed: async () => (await rpc.call("diff_viewed_list", { ticketId: subjectId })).paths,
      setViewed: async (path, viewed) => {
        const { paths } = await rpc.call("diff_viewed_set", { ticketId: subjectId, path, viewed });
        notifyViewedChanged();
        return paths;
      },
      listComments: async () => (await rpc.call("diff_comments_list", { ticketId: subjectId })).comments,
      // The board's pending-comment counts change with these, so the board refetches too.
      addComment: async (comment) => {
        await rpc.call("diff_comment_add", { ticketId: subjectId, ...comment });
        refetch();
      },
      updateComment: async (id, patch) => {
        await rpc.call("diff_comment_update", { id, ...patch });
        if (patch.target !== undefined) refetch();
      },
      deleteComment: async (id) => {
        await rpc.call("diff_comment_delete", { id });
        refetch();
      },
      canPostToGithub,
      defaultCommentTarget,
      ...(prTicketId === null
        ? {}
        : {
            listGithubComments: async () => (await rpc.call("comments_list", { ticketId: prTicketId })).comments,
            conversation: () => rpc.call("pr_conversation", { ticketId: prTicketId }),
            conversationActions: {
              post: async (body) => {
                await rpc.call("pr_comment_post", { ticketId: prTicketId, body });
              },
              edit: async (id, body) => {
                await rpc.call("pr_comment_edit", { ticketId: prTicketId, id, body });
              },
              remove: async (id) => {
                await rpc.call("pr_comment_delete", { ticketId: prTicketId, id });
              },
              react: async (subject, content, add) => {
                await rpc.call("pr_reaction_toggle", { ticketId: prTicketId, subject, content, add });
              },
            },
            setThreadResolved: async (rootId, resolved) => {
              await rpc.call("comment_set_resolved", { id: rootId, resolved });
              refetch();
            },
          }),
      ...(reviewSubjectId === null
        ? {}
        : {
            reviews: {
              list: async () => (await rpc.call("review_list", { ticketId: reviewSubjectId })).reviews,
              setSelection: (reviewId, findingId, selected) => rpc.call("review_set_selection", { reviewId, findingId, selected }),
              editFinding: (reviewId, findingId, edit) => rpc.call("review_edit_finding", { reviewId, findingId, edit }),
              makeCard: async (reviewId, findingId) => {
                const { ticket: card, created } = await rpc.call("review_make_card", { reviewId, findingId });
                refetch();
                return { cardId: card.id, title: card.title, created };
              },
              openCard: (cardId) => openTicket.current(cardId),
              setApplied: (reviewId, findingId, applied) => rpc.call("review_set_applied", { reviewId, findingId, applied }),
            },
          }),
      delta: async (fromSha) => (await rpc.call("diff_delta", { ticketId: subjectId, fromSha })).delta,
      tour: {
        get: () => rpc.call("narrative_get", { ticketId: subjectId }),
        generate: () => rpc.call("narrative_generate", { ticketId: subjectId }),
        story: async () => {
          const story = await rpc.call("narrative_story", { ticketId: subjectId });
          if (planTicketId === null) return story;
          const readingPlan = await rpc.call("loop_reading_plan", { id: planTicketId });
          return readingPlan === null || readingPlan.level === "glance" ? story : planStory(story, readingPlan);
        },
      },
      explanations: {
        list: async () => (await rpc.call("hunk_explanations_list", { ticketId: subjectId })).explanations,
        explain: (path, side, startLine, endLine) => rpc.call("hunk_explain", { ticketId: subjectId, path, side, startLine, endLine }),
      },
      loadPatch: async (path, range) => (await rpc.call("diff_load_patch", { ticketId: subjectId, path, range })).patch,
      blame: async (path, side, startLine, endLine, range) => (await rpc.call("diff_blame", { ticketId: subjectId, path, side, startLine, endLine, range })).lines,
      suggestions: {
        apply: async (items, message) => {
          const result = await rpc.call("suggestions_apply", { ticketId: subjectId, items, message });
          // Resolving the applied threads changes the board's comment counts.
          refetch();
          return result;
        },
      },
      commits: () => rpc.call("diff_commits", { ticketId: subjectId }),
    }),
    [rpc, subjectId, prTicketId, reviewSubjectId, canPostToGithub, defaultCommentTarget, planTicketId, refetch],
  );
}

const REVIEW_EVENTS: ReadonlyArray<{ value: ReviewEvent; label: string; description: string }> = [
  { value: "COMMENT", label: "Comment", description: "Submit general feedback without explicit approval." },
  { value: "APPROVE", label: "Approve", description: "Submit feedback and approve merging these changes." },
  { value: "REQUEST_CHANGES", label: "Request changes", description: "Submit feedback that must be addressed before merging." },
];

const OWN_PR = "GitHub doesn't let you approve or request changes on your own pull request";

/**
 * GitHub's "Finish your review" box under the Submit review button: a comment, how the review concludes, and the
 * submit. The comment and choice belong to the bar, so closing this keeps them.
 */
function ReviewPopover({
  comment,
  onComment,
  reviewUrl,
  event,
  onEvent,
  canApprove,
  canSubmit,
  submitting,
  onSubmit,
  onClose,
}: {
  comment: string;
  onComment: (comment: string) => void;
  /** The pending review on GitHub this box and its drafts are mirrored to, once there is one. */
  reviewUrl: string | null;
  event: ReviewEvent;
  onEvent: (event: ReviewEvent) => void;
  canApprove: boolean;
  canSubmit: boolean;
  submitting: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const enabled = REVIEW_EVENTS.filter((option) => canApprove || option.value === "COMMENT");
  const onKeys = useKeyHandler<ReviewPopoverCommand>({
    keymap: REVIEW_POPOVER_KEYS,
    onTextEscape: () => {
      onClose();
      return true;
    },
    onCommand: (command, { target }) => {
      if (command === "close") {
        onClose();
        return;
      }
      if (command === "comment") {
        textareaRef.current?.focus();
        return;
      }
      const index = enabled.findIndex((option) => option.value === event);
      const next = enabled[Math.min(enabled.length - 1, Math.max(0, index + command))]!;
      if (next.value === event) return;
      onEvent(next.value);
      if (target?.getAttribute("role") === "radio") rootRef.current?.querySelector<HTMLElement>(`[role="radio"][data-value="${next.value}"]`)?.focus();
    },
  });
  useEffect(() => {
    const onPointerDown = (pointer: PointerEvent) => {
      const target = pointer.target;
      if (!(target instanceof Element)) return;
      if (rootRef.current?.contains(target) || target.closest("[data-review-trigger]") !== null) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Finish your review"
      className={cn("absolute right-0 top-full z-20 mt-1.5 flex w-[min(20rem,calc(100vw-1.5rem))] flex-col gap-3 rounded-md border border-border bg-popover p-3 text-sm text-popover-foreground shadow-md", POPOVER_MOTION)}
      onKeyDown={(keyboard) => {
        if ((keyboard.metaKey || keyboard.ctrlKey) && keyboard.key === "Enter") {
          keyboard.preventDefault();
          if (canSubmit && !submitting) onSubmit();
          return;
        }
        onKeys(keyboard);
      }}
    >
      <textarea
        ref={textareaRef}
        autoFocus
        value={comment}
        rows={4}
        readOnly={submitting}
        onChange={(change) => onComment(change.target.value)}
        placeholder="Leave a comment"
        aria-label="Review comment"
        className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring read-only:opacity-50"
      />
      <div role="radiogroup" aria-label="Review as" className="flex flex-col gap-0.5">
        {REVIEW_EVENTS.map((option) => {
          const disabled = !canApprove && option.value !== "COMMENT";
          const checked = option.value === event;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              data-value={option.value}
              disabled={disabled}
              title={disabled ? OWN_PR : undefined}
              onClick={() => onEvent(option.value)}
              className={cn("flex items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50", PRESS)}
            >
              <span aria-hidden className={cn("mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-full border", checked ? "border-foreground" : "border-muted-foreground")}>
                {checked ? <span className="size-2 rounded-full bg-foreground" /> : null}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {reviewUrl !== null ? (
          <ExternalLink href={reviewUrl} title="Your pending review on GitHub, kept the same as this box and its drafts" className="mr-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
            <Icon name="GitPullRequest" className="size-3" />
            Pending on GitHub
          </ExternalLink>
        ) : canSubmit ? null : (
          <span className="mr-auto text-xs text-muted-foreground">Write a comment or leave drafts on the diff</span>
        )}
        <Button type="button" variant="ghost" className={COMPACT} onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" className={COMPACT} disabled={!canSubmit || submitting} onClick={onSubmit}>
          <Icon name={event === "APPROVE" ? "Check" : "GitPullRequest"} className="size-3.5" />
          Submit review
        </Button>
      </div>
    </div>
  );
}

/**
 * Sends local comments to an apply thread, and GitHub drafts to the pull request through a Submit review button that
 * opens GitHub's "Finish your review" box: a comment and, on someone else's PR, Comment / Approve / Request changes.
 */
function KanbanSubmitBar({
  subjectId,
  pending,
  canPostToGithub,
  canApprove,
  onOpenThread,
  onSubmitted,
}: {
  subjectId: string;
  pending: PendingComments;
  canPostToGithub: boolean;
  canApprove: boolean;
  onOpenThread: (threadId: string) => void;
  onSubmitted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [push, setPush] = usePushPreference();
  const [chosenEvent, setReviewEvent] = useState<ReviewEvent>("COMMENT");
  const reviewEvent = canApprove ? chosenEvent : "COMMENT";
  const [comment, setCommentText] = useState("");
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  // Typing wins over a pull from GitHub until the text is saved; the timer batches keystrokes into one save.
  const typing = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const loadSummary = useCallback(() => {
    if (!canPostToGithub) return;
    rpc.call("pending_review_get", { ticketId: subjectId }).then(
      (state) => {
        setReviewUrl(state.url);
        if (!typing.current) setCommentText(state.body);
      },
      () => undefined,
    );
  }, [rpc, subjectId, canPostToGithub]);
  useEffect(loadSummary, [loadSummary]);
  useRealtime(BOARD_CHANGED, loadSummary);
  const setComment = (next: string) => {
    setCommentText(next);
    typing.current = true;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      rpc.call("pending_review_set_body", { ticketId: subjectId, body: next }).then(
        (state) => {
          typing.current = false;
          setReviewUrl(state.url);
        },
        () => undefined,
      );
    }, 600);
  };
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [submitting, setSubmitting] = useState<"github" | "agent" | null>(null);
  const { local, githubDrafts } = pending;
  const localPop = usePopOnChange(local.length);
  const draftsPop = usePopOnChange(githubDrafts.length);
  const canSubmitReview = githubDrafts.length > 0 || comment.trim() !== "" || reviewEvent !== "COMMENT";
  const openReview = () => {
    setOpen(true);
    // Already open: the comment box, where a fresh one starts anyway.
    triggerRef.current?.closest("[data-diff-submit-bar]")?.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.focus();
  };
  const closeReview = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const onBarKeys = useKeyHandler<"review">({
    keymap: SEND_BAR_KEYS,
    active: () => canPostToGithub,
    onCommand: openReview,
  });
  const submit = async (destination: "github" | "agent") => {
    setSubmitting(destination);
    try {
      const result = await rpc.call("diff_comments_submit", {
        ticketId: subjectId,
        postToGithub: destination === "github",
        reviewEvent,
        reviewBody: destination === "github" ? comment : "",
        address: destination === "agent",
        push,
      });
      const count = result.posted;
      const posted =
        reviewEvent === "APPROVE"
          ? `${count > 0 ? `Approved with ${count}` : "Approved"} on GitHub${result.movedToDone ? "; the card moved to Done" : ""}`
          : reviewEvent === "REQUEST_CHANGES"
            ? `${count > 0 ? `Requested changes with ${count}` : "Requested changes"} on GitHub`
            : count > 0
              ? `Posted ${count} to GitHub`
              : "Posted your comment to GitHub";
      toast.success(destination === "github" ? posted : "Address thread started");
      if (destination === "github") {
        // A failed submit keeps the box as it was for the retry.
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        typing.current = false;
        setCommentText("");
        setReviewUrl(null);
        setReviewEvent("COMMENT");
        setOpen(false);
        triggerRef.current?.closest<HTMLElement>("[data-diff-root]")?.focus({ preventScroll: true });
      }
      if (result.apply !== null) onOpenThread(result.apply.threadId);
    } catch (cause) {
      toastError(cause);
    } finally {
      setSubmitting(null);
      pending.reload();
      onSubmitted();
    }
  };
  if (local.length === 0 && !canPostToGithub) return null;
  return (
    <span data-diff-submit-bar="" className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", enter.fade)} onKeyDown={onBarKeys}>
      {local.length > 0 ? (
        <span className="flex items-center gap-x-2">
          <PushToggle push={push} onChange={setPush} />
          <span title="Start a thread that addresses the local comments with the apply-pr-comments skill and replies in each thread">
            <Button type="button" className={COMPACT} disabled={submitting !== null} onClick={() => void submit("agent")}>
              <Icon name="kanban-wrench" className="size-3.5" />
              Send{" "}
              <span key={localPop.key} onAnimationEnd={localPop.onAnimationEnd} className={cn("inline-block tabular-nums", localPop.className)}>
                {local.length}
              </span>{" "}
              to agent
            </Button>
          </span>
        </span>
      ) : null}
      {canPostToGithub ? (
        <span className="relative flex items-center">
          <span title="Finish your review: a comment, how it concludes, then submit (new threads post as one review; replies post into their threads)">
            <Button
              ref={triggerRef}
              type="button"
              variant="secondary"
              className={COMPACT}
              data-send-bar-focus=""
              data-review-trigger=""
              aria-haspopup="dialog"
              aria-expanded={open}
              disabled={submitting !== null}
              onClick={() => (open ? closeReview() : openReview())}
            >
              <Icon name="GitPullRequest" className="size-3.5" />
              Submit review
              {githubDrafts.length > 0 ? (
                <span key={draftsPop.key} onAnimationEnd={draftsPop.onAnimationEnd} className={cn("inline-block rounded-full bg-foreground/15 px-1.5 text-xs tabular-nums", draftsPop.className)}>
                  {githubDrafts.length}
                </span>
              ) : null}
            </Button>
          </span>
          {open ? (
            <ReviewPopover
              comment={comment}
              onComment={setComment}
              reviewUrl={reviewUrl}
              event={reviewEvent}
              onEvent={setReviewEvent}
              canApprove={canApprove}
              canSubmit={canSubmitReview}
              submitting={submitting !== null}
              onSubmit={() => void submit("github")}
              onClose={closeReview}
            />
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/** Reviews what no review has read yet, carrying the latest review's open findings forward. */
function RereviewDeltaButton({ ticket }: { ticket: Ticket }) {
  const rpc = useRpc<typeof rpcContract>();
  const [reviewing, setReviewing] = useState(false);
  const rereview = async () => {
    setReviewing(true);
    try {
      await rpc.call("ticket_review_pr", { id: ticket.id, mode: "incremental" });
      toast.message("Re-review started");
    } catch (cause) {
      toastError(cause);
    } finally {
      setReviewing(false);
    }
  };
  return (
    <button
      type="button"
      className={cn("ml-auto rounded border border-border px-1.5 py-0.5 hover:bg-state-hover disabled:opacity-50", PRESS)}
      disabled={reviewing || ticket.latestReview?.status === "running"}
      title={ticket.pr === null ? "Review the card thread's commits since the last completed review and re-check its open findings (uncommitted changes wait for a commit)" : "Review the commits since the last completed review and re-check its open findings"}
      onClick={() => void rereview()}
    >
      {ticket.latestReview?.status === "running" ? "Review running…" : "Re-review what's new"}
    </button>
  );
}

/** A card's (or a bare thread's) changes in the shared diff view, with the board's comment routing and reviews. */
export function KanbanDiffView({
  subjectId,
  plan = false,
  onBack,
  onOpenThread,
  onOpenTicket,
}: {
  subjectId: string;
  /** Opened from the handoff brief's reading plan: the narrative shows only the plan's files. */
  plan?: boolean;
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  const { board, refetch } = useBoard();
  const ticket = findDiffSubjectTicket(board, subjectId);
  const source = useKanbanDiffSource(subjectId, ticket, plan, refetch, onOpenTicket);
  const rpc = useRpc<typeof rpcContract>();
  const [boardChanges, setBoardChanges] = useState(0);
  useRealtime(BOARD_CHANGED, () => setBoardChanges((count) => count + 1));
  // The right panel holds the card, whose findings the diff already shows inline, or nothing; either way the diff wants the width.
  useEffect(collapseRightPanel, []);
  if (ticket === null && (board === null || !subjectId.startsWith(THREAD_SUBJECT_PREFIX))) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {board === null ? "Loading…" : "This card no longer exists."}{" "}
        <button type="button" className="underline" onClick={onBack}>
          Back to board
        </button>
      </div>
    );
  }
  return (
    <DiffView
      source={source}
      instanceKey={diffInstanceKey(subjectId)}
      onOpenThread={onOpenThread}
      refreshSignal={boardChanges}
      labels={KANBAN_DIFF_LABELS}
      toolbar={(pending) => (
        <>
          <DiffPageHeading
            subjectId={subjectId}
            ticket={ticket}
            actions={<KanbanSubmitBar subjectId={subjectId} pending={pending} canPostToGithub={ticket?.canPostToGithub ?? false} canApprove={ticket?.pr?.role === "other"} onOpenThread={onOpenThread} onSubmitted={refetch} />}
          />
          {ticket === null ? null : <HandoffStrip ticket={ticket} rpc={rpc} plan={plan} onOpenThread={onOpenThread} />}
        </>
      )}
      deltaActions={ticket === null ? null : ({ unreviewed }) => (unreviewed ? <RereviewDeltaButton ticket={ticket} /> : null)}
    />
  );
}

const PLAN_SUFFIX = "/plan";

/** `diff/<cardId>/plan` opens a card's changes at its reading plan. */
export function diffPlanFromSubPath(subPath: string): boolean {
  return subPath.startsWith("diff/") && !subPath.startsWith("diff/thread/") && subPath.endsWith(PLAN_SUFFIX);
}

/** `diff/<cardId>` (or `diff/<cardId>/plan`) → card id; `diff/thread/<threadId>` → `thread:<threadId>`. Decodes in case the host escaped the path. */
export function diffSubjectFromSubPath(subPath: string): string | null {
  if (!subPath.startsWith("diff/")) return null;
  const path = diffPlanFromSubPath(subPath) ? subPath.slice(0, -PLAN_SUFFIX.length) : subPath;
  const rest = decodeURIComponent(path.slice("diff/".length));
  if (rest.startsWith("thread/")) return `${THREAD_SUBJECT_PREFIX}${rest.slice("thread/".length)}`;
  return rest;
}

/** The diff route takes a card id or `thread:<threadId>`; a thread that has a card shows as that card. */
export function findDiffSubjectTicket(board: Board | null, subjectId: string): Ticket | null {
  if (board === null) return null;
  const direct = board.tickets.find((entry) => entry.id === subjectId);
  if (direct !== undefined) return direct;
  if (!subjectId.startsWith(THREAD_SUBJECT_PREFIX)) return null;
  const threadId = subjectId.slice(THREAD_SUBJECT_PREFIX.length);
  return board.tickets.find((entry) => entry.threadId === threadId) ?? null;
}
