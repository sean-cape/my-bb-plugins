import { useMemo, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { PRESS, enter, usePopOnChange } from "bb-motion";
import { DiffView, type DiffSource, type DiffViewLabels, type PendingComments } from "bb-diff-view/app/diff-view";
import type { rpcContract } from "../contract";
import type { Board, Ticket } from "../shared/board";
import type { ReviewEvent } from "../shared/comments";
import { BOARD_CHANGED, THREAD_SUBJECT_PREFIX } from "../shared/events";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useBoard, usePushPreference } from "./data";
import { PushToggle, COMPACT, SegmentedTabs } from "./primitives";
import { toastError } from "./actions";

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
};

/** The board's data for one diff subject (a card id or `thread:<threadId>`), as the shared diff view reads it. */
function useKanbanDiffSource(subjectId: string, ticket: Ticket | null, refetch: () => void): DiffSource {
  const rpc = useRpc<typeof rpcContract>();
  const prTicketId = ticket !== null && ticket.pr !== null ? ticket.id : null;
  // Reviews hang off cards; a thread without one has none yet.
  const reviewSubjectId = ticket?.id ?? (subjectId.startsWith(THREAD_SUBJECT_PREFIX) ? null : subjectId);
  const canPostToGithub = ticket?.canPostToGithub ?? false;
  const defaultCommentTarget = ticket?.defaultCommentTarget ?? "local";
  return useMemo<DiffSource>(
    () => ({
      getDiff: (refresh) => rpc.call("diff_get", { ticketId: subjectId, refresh }),
      getStructural: (path) => rpc.call("diff_structural", { ticketId: subjectId, path }),
      symbolDefinitions: (symbol) => rpc.call("symbol_definitions", { ticketId: subjectId, symbol }),
      symbolUsages: (symbol) => rpc.call("symbol_usages", { ticketId: subjectId, symbol }),
      peekFile: (path, startLine, endLine) => rpc.call("symbol_peek_file", { ticketId: subjectId, path, startLine, endLine }),
      listViewed: async () => (await rpc.call("diff_viewed_list", { ticketId: subjectId })).paths,
      setViewed: async (path, viewed) => (await rpc.call("diff_viewed_set", { ticketId: subjectId, path, viewed })).paths,
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
      ...(prTicketId === null ? {} : { listGithubComments: async () => (await rpc.call("comments_list", { ticketId: prTicketId })).comments }),
      ...(reviewSubjectId === null
        ? {}
        : {
            reviews: {
              list: async () => (await rpc.call("review_list", { ticketId: reviewSubjectId })).reviews,
              setSelection: (reviewId, findingId, selected) => rpc.call("review_set_selection", { reviewId, findingId, selected }),
              editFinding: (reviewId, findingId, edit) => rpc.call("review_edit_finding", { reviewId, findingId, edit }),
            },
          }),
      delta: async () => (await rpc.call("diff_delta", { ticketId: subjectId })).delta,
      tour: {
        get: () => rpc.call("narrative_get", { ticketId: subjectId }),
        generate: () => rpc.call("narrative_generate", { ticketId: subjectId }),
      },
      explanations: {
        list: async () => (await rpc.call("hunk_explanations_list", { ticketId: subjectId })).explanations,
        explain: (path, side, startLine, endLine) => rpc.call("hunk_explain", { ticketId: subjectId, path, side, startLine, endLine }),
      },
    }),
    [rpc, subjectId, prTicketId, reviewSubjectId, canPostToGithub, defaultCommentTarget, refetch],
  );
}

const REVIEW_EVENTS: ReadonlyArray<{ value: ReviewEvent; label: string }> = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" },
];

/**
 * Sends local comments to an apply thread and GitHub drafts to the pull request, as a plain comment review or, on
 * someone else's PR, an approval or change request.
 */
function KanbanSubmitBar({ subjectId, pending, canApprove, onOpenThread, onSubmitted }: { subjectId: string; pending: PendingComments; canApprove: boolean; onOpenThread: (threadId: string) => void; onSubmitted: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [push, setPush] = usePushPreference();
  const [autoApprove, setAutoApprove] = useState(false);
  const [chosenEvent, setReviewEvent] = useState<ReviewEvent>("COMMENT");
  const reviewEvent = canApprove ? chosenEvent : "COMMENT";
  const [submitting, setSubmitting] = useState<"github" | "agent" | null>(null);
  const { local, githubDrafts } = pending;
  const localPop = usePopOnChange(local.length);
  const draftsPop = usePopOnChange(githubDrafts.length);
  const submit = async (destination: "github" | "agent") => {
    setSubmitting(destination);
    try {
      const result = await rpc.call("diff_comments_submit", { ticketId: subjectId, postToGithub: destination === "github", reviewEvent, address: destination === "agent", autoApprove, push });
      const posted = reviewEvent === "APPROVE" ? `Approved with ${result.posted} on GitHub` : reviewEvent === "REQUEST_CHANGES" ? `Requested changes with ${result.posted} on GitHub` : `Posted ${result.posted} to GitHub`;
      toast.success(destination === "github" ? posted : "Address thread started");
      if (result.apply !== null) onOpenThread(result.apply.threadId);
    } catch (cause) {
      toastError(cause);
    } finally {
      setSubmitting(null);
      pending.reload();
      onSubmitted();
    }
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-muted/30 px-3 py-2", enter.drop)}>
      {local.length > 0 ? (
        <>
          <span className="text-sm">
            <span key={localPop.key} onAnimationEnd={localPop.onAnimationEnd} className={cn("inline-block font-medium tabular-nums", localPop.className)}>
              {local.length}
            </span>{" "}
            local comment{local.length === 1 ? "" : "s"}
          </span>
          <PushToggle push={push} onChange={setPush} />
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={autoApprove} onCheckedChange={(checked) => setAutoApprove(checked === true)} aria-label="Skip triage confirmation" />
            skip triage
          </label>
          <span title="Start a thread that addresses these with the apply-pr-comments skill and replies in each thread">
            <Button type="button" className={COMPACT} disabled={submitting !== null} onClick={() => void submit("agent")}>
              <Icon name="kanban-wrench" className="size-3.5" />
              Send {local.length} to agent
            </Button>
          </span>
        </>
      ) : null}
      {githubDrafts.length > 0 ? (
        <span className={cn("inline-flex items-center gap-3", local.length > 0 && "ml-auto")}>
          <span className="text-sm">
            <span key={draftsPop.key} onAnimationEnd={draftsPop.onAnimationEnd} className={cn("inline-block font-medium tabular-nums", draftsPop.className)}>
              {githubDrafts.length}
            </span>{" "}
            GitHub draft{githubDrafts.length === 1 ? "" : "s"}
          </span>
          {canApprove ? <SegmentedTabs
              label="Review as"
              value={reviewEvent}
              options={REVIEW_EVENTS}
              onChange={setReviewEvent}
              onActivate={() => {
                if (submitting === null) void submit("github");
              }}
              selectedTabProps={{ "data-send-bar-focus": "" }}
              className="w-72 shrink-0"
              tabClassName="whitespace-nowrap px-2 py-0.5"
            /> : null}
          <span title="New threads post as one review; replies post into their threads">
            <Button type="button" variant="secondary" className={COMPACT} disabled={submitting !== null} onClick={() => void submit("github")}>
              <Icon name={reviewEvent === "APPROVE" ? "Check" : "GitPullRequest"} className="size-3.5" />
              {reviewEvent === "APPROVE" ? `Approve with ${githubDrafts.length}` : reviewEvent === "REQUEST_CHANGES" ? `Request changes with ${githubDrafts.length}` : `Post ${githubDrafts.length} to GitHub`}
            </Button>
          </span>
        </span>
      ) : null}
    </div>
  );
}

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
      title="Review the commits since the last completed review and re-check its open findings"
      onClick={() => void rereview()}
    >
      {ticket.latestReview?.status === "running" ? "Review running…" : "Re-review the delta"}
    </button>
  );
}

/** A card's (or a bare thread's) changes in the shared diff view, with the board's comment routing and reviews. */
export function KanbanDiffView({ subjectId, onBack, onOpenThread }: { subjectId: string; onBack: () => void; onOpenThread: (threadId: string) => void }) {
  const { board, refetch } = useBoard();
  const ticket = findDiffSubjectTicket(board, subjectId);
  const source = useKanbanDiffSource(subjectId, ticket, refetch);
  const [boardChanges, setBoardChanges] = useState(0);
  useRealtime(BOARD_CHANGED, () => setBoardChanges((count) => count + 1));
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
      renderSubmitBar={(pending) => <KanbanSubmitBar subjectId={subjectId} pending={pending} canApprove={ticket?.pr?.role === "other"} onOpenThread={onOpenThread} onSubmitted={refetch} />}
      deltaActions={ticket !== null && ticket.pr !== null ? <RereviewDeltaButton ticket={ticket} /> : null}
    />
  );
}

/** `diff/<cardId>` → card id; `diff/thread/<threadId>` → `thread:<threadId>`. Decodes in case the host escaped the path. */
export function diffSubjectFromSubPath(subPath: string): string | null {
  if (!subPath.startsWith("diff/")) return null;
  const rest = decodeURIComponent(subPath.slice("diff/".length));
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
