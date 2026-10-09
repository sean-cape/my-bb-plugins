import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { enter, usePopOnChange, POPOVER_MOTION } from "bb-motion";
import { DiffRefreshButton } from "bb-diff-view/app/diff-view";
import type { rpcContract } from "../contract";
import type { Board, Ticket } from "../shared/board";
import { BOARD_CHANGED } from "../shared/events";
import type { CodeReviewThread } from "../shared/tour";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { relativeTime, shortSha } from "./format";
import { useBoard, useOpenThread, useNow } from "./data";
import { pageUi, usePageUi } from "./page-state";
import { Badge, COMPACT, KANBAN_MENU, MENU_ITEM_CLASS, SegmentedTabs, menuVimKeys } from "./primitives";
import { diffInstanceKey, diffSubjectFromSubPath, findDiffSubjectTicket } from "./diff-page";
import { toastError } from "./actions";

function syncSummary(board: Board, now: number): string {
  const { sync } = board;
  if (sync.lastSyncAt === null) return "Not synced yet";
  const prCount = board.tickets.filter((ticket) => ticket.kind === "pr").length;
  const jiraCount = board.tickets.filter((ticket) => ticket.kind === "jira").length;
  const parts = [`${prCount} PR${prCount === 1 ? "" : "s"}${sync.login !== null ? ` as @${sync.login}` : ""}`];
  if (jiraCount > 0) parts.push(`${jiraCount} Jira`);
  return `${parts.join(" · ")} · synced ${relativeTime(sync.lastSyncAt, now)}`;
}

function BoardSettingsMenu({
  board,
  syncing,
  onColumns,
  onSources,
  onShortcuts,
  onSync,
}: {
  board: Board | null;
  syncing: boolean;
  onColumns: () => void;
  onSources: () => void;
  onShortcuts: () => void;
  onSync: () => void;
}) {
  const now = useNow();
  const { showSubtasks } = usePageUi();
  const error = board?.sync.lastError ?? null;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" className="relative size-7" aria-label="Board settings">
          <Icon name="Settings" className={cn("size-4", syncing && "animate-spin")} />
          {error !== null ? (
            <span aria-hidden className={cn("absolute right-1 top-1 size-1.5 rounded-full bg-destructive", enter.pop)} />
          ) : null}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...usePortalScopeProps()}
          align="end"
          sideOffset={4}
          className={cn("z-50 min-w-56 max-w-80 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md", POPOVER_MOTION, KANBAN_MENU)}
          onKeyDown={menuVimKeys}
        >
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onColumns}>
            <Icon name="Columns2" className="size-4 text-muted-foreground" />
            Columns…
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onSources}>
            <Icon name="kanban-rss" className="size-4 text-muted-foreground" />
            Sources…
          </DropdownMenu.Item>
          <DropdownMenu.CheckboxItem
            className={cn(MENU_ITEM_CLASS, "pl-7")}
            checked={showSubtasks}
            onCheckedChange={(checked) => pageUi.set({ showSubtasks: checked === true })}
            onSelect={(event) => event.preventDefault()}
          >
            <DropdownMenu.ItemIndicator className="absolute left-2">
              <Icon name="Check" className={cn("size-4", enter.pop)} />
            </DropdownMenu.ItemIndicator>
            Show subtasks on the board
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onShortcuts}>
            <Icon name="kanban-keyboard" className="size-4 text-muted-foreground" />
            Keyboard shortcuts
            <kbd className="ml-auto font-mono text-xs text-muted-foreground">?</kbd>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item className={cn(MENU_ITEM_CLASS, "items-start")} disabled={syncing} onSelect={onSync}>
            <Icon name="kanban-refresh" className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", syncing && "animate-spin")} />
            <span className="flex min-w-0 flex-col">
              <span>{syncing ? "Syncing sources…" : "Sync sources now"}</span>
              {board !== null ? (
                <span className={cn("truncate text-xs", error !== null ? "text-destructive" : "text-muted-foreground")} title={error ?? undefined}>
                  {error ?? syncSummary(board, now)}
                </span>
              ) : null}
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const CODE_REVIEW_THREAD_ICON: Record<CodeReviewThread["kind"], string> = {
  review: "kanban-search-check",
  apply: "kanban-wrench",
  "apply-comments": "kanban-wrench",
  narrative: "MessageSquare",
  explain: "MessageSquare",
};

/** The latest review and its apply round, one click from the changes page; older threads stay in the Threads menu. */
function ReviewThreadButtons({ ticket }: { ticket: Ticket }) {
  const rpc = useRpc<typeof rpcContract>();
  const openThread = useOpenThread();
  const [starting, setStarting] = useState(false);
  const review = ticket.latestReview;
  const startReview = async () => {
    setStarting(true);
    try {
      const updated = await rpc.call("ticket_review_pr", { id: ticket.id, projectId: null });
      if (updated.reviewThreadId !== null) openThread(updated.reviewThreadId);
    } catch (cause) {
      toastError(cause);
    } finally {
      setStarting(false);
    }
  };
  if (review === null) {
    if (ticket.pr === null) return null;
    return (
      <Button type="button" variant="secondary" className={COMPACT} disabled={starting} onClick={() => void startReview()}>
        <Icon name="kanban-search-check" className="size-3.5" />
        {starting ? "Starting…" : "Review"}
      </Button>
    );
  }
  const counts = review.counts;
  const total = counts === null ? null : counts.critical + counts.important + counts.minor;
  const apply = review.apply;
  return (
    <>
      <span title={review.status === "running" ? "Open the running review thread" : "Open the review thread to read the findings or keep iterating"}>
        <Button type="button" variant="secondary" className={COMPACT} onClick={() => openThread(review.threadId)}>
          <Icon name="kanban-search-check" className={cn("size-3.5", review.status === "running" && "animate-pulse")} />
          {review.status === "running" ? "Reviewing…" : review.sinceCommitSha === null ? "Review" : "Re-review"}
          {review.status === "failed" ? (
            <Badge tone="danger">failed</Badge>
          ) : total !== null && counts !== null ? (
            <Badge tone={counts.critical > 0 ? "danger" : counts.important > 0 ? "warning" : total === 0 ? "success" : "neutral"}>{total}</Badge>
          ) : null}
        </Button>
      </span>
      {apply !== null ? (
        <span title={apply.completedAt === null ? "Open the thread applying the review" : `Fixes ${apply.push ? "pushed" : "committed"} as ${shortSha(apply.pushedCommit)}`}>
          <Button type="button" variant="ghost" className={COMPACT} onClick={() => openThread(apply.threadId)}>
            <Icon name="kanban-wrench" className={cn("size-3.5", apply.completedAt === null && "animate-pulse")} />
            {apply.completedAt === null ? "Applying…" : "Fixes"}
          </Button>
        </span>
      ) : null}
    </>
  );
}

/** Code review threads run hidden from the sidebar and the project, so this menu is how the changes page reaches them. */
function CodeReviewThreadsMenu({ subjectId }: { subjectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const openThread = useOpenThread();
  const now = useNow();
  const [threads, setThreads] = useState<CodeReviewThread[]>([]);
  const load = useCallback(() => {
    rpc.call("code_review_threads", { ticketId: subjectId }).then((result) => setThreads(result.threads), () => setThreads([]));
  }, [rpc, subjectId]);
  useEffect(load, [load]);
  useRealtime(BOARD_CHANGED, load);
  if (threads.length === 0) return null;
  const running = threads.filter((thread) => thread.status === "running").length;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button type="button" variant="ghost" className={COMPACT} aria-label="Code review threads">
          <Icon name="MessageSquare" className={cn("size-3.5", running > 0 && "animate-pulse")} />
          Threads
          <Badge tone={running > 0 ? "accent" : "neutral"}>{threads.length}</Badge>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...usePortalScopeProps()} align="end" sideOffset={4} className={cn("z-50 max-h-96 min-w-64 max-w-96 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md", POPOVER_MOTION, KANBAN_MENU)} onKeyDown={menuVimKeys}>
          {threads.map((thread) => (
            <DropdownMenu.Item key={`${thread.kind}:${thread.threadId}`} className={MENU_ITEM_CLASS} onSelect={() => openThread(thread.threadId)}>
              <Icon name={CODE_REVIEW_THREAD_ICON[thread.kind]} className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{thread.label}</span>
              {thread.status === "running" ? <Badge tone="accent">running</Badge> : thread.status === "failed" ? <Badge tone="danger">failed</Badge> : null}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{relativeTime(thread.startedAt, now)}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Controls for the host title bar: board tools on the board, diff tools on a card's changes page. */
export function BoardHeader({ subPath }: { subPath: string }) {
  const trimmed = subPath.replace(/^\/+|\/+$/gu, "");
  const diffTicketId = diffSubjectFromSubPath(trimmed);
  const view: "board" | "todo" = trimmed === "todo" ? "todo" : "board";
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const { board, refetch } = useBoard();
  const [syncing, setSyncing] = useState(false);
  const syncNow = async () => {
    setSyncing(true);
    try {
      const status = await rpc.call("sync_now");
      if (status.lastError !== null) toast.error(status.lastError);
    } catch (cause) {
      toastError(cause);
    } finally {
      setSyncing(false);
      refetch();
    }
  };

  const onProposals = trimmed === "proposals" || trimmed.startsWith("proposals/");
  if (onProposals) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Button type="button" variant="ghost" className={COMPACT} onClick={() => navigate.toPluginPanel("board", { subPath: trimmed === "proposals" ? "" : "proposals" })}>
          <Icon name="ChevronDown" className="size-3.5 rotate-90" />
          {trimmed === "proposals" ? "Board" : "Proposals"}
        </Button>
        <Button className={cn(COMPACT, "ml-1")} onClick={() => pageUi.set({ dialog: "new", newTicketColumn: null })}>
          <Icon name="Plus" className="size-3.5" />
          New card
        </Button>
      </div>
    );
  }
  if (diffTicketId !== null) {
    const ticket = findDiffSubjectTicket(board, diffTicketId);
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Button type="button" variant="ghost" className={COMPACT} onClick={() => navigate.toPluginPanel("board", { subPath: "" })}>
          <Icon name="ChevronDown" className="size-3.5 rotate-90" />
          Board
        </Button>
        {ticket !== null ? (
          <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground md:inline-flex">
            <span className="truncate font-medium text-foreground">{ticket.title}</span>
            <span className="shrink-0">· {ticket.pr !== null ? `${ticket.pr.repo.split("/")[1]}#${ticket.pr.number}` : ticket.id}</span>
          </span>
        ) : null}
        {ticket !== null ? <ReviewThreadButtons ticket={ticket} /> : null}
        <CodeReviewThreadsMenu subjectId={diffTicketId} />
        <DiffRefreshButton instanceKey={diffInstanceKey(diffTicketId)} />
      </div>
    );
  }

  return (
    <div data-kanban-keys="" data-kanban-header="" className="flex items-center gap-1.5">
      <SegmentedTabs
        label="View"
        value={view}
        options={VIEW_OPTIONS}
        onChange={(entry) => navigate.toPluginPanel("board", { subPath: entry === "board" ? "" : "todo" })}
        tabClassName="px-2 py-0.5"
      />
      <BoardSettingsMenu
        board={board}
        syncing={syncing || board?.sync.inProgress === true}
        onColumns={() => pageUi.set({ dialog: "columns" })}
        onSources={() => pageUi.set({ dialog: "sources" })}
        onShortcuts={() => pageUi.set({ dialog: "keys" })}
        onSync={() => void syncNow()}
      />
      {board !== null && board.dumps.length > 0 ? <ProposalsButton board={board} onOpen={() => navigate.toPluginPanel("board", { subPath: "proposals" })} /> : null}
      <Button className={COMPACT} onClick={() => pageUi.set({ dialog: "new", newTicketColumn: null })}>
        <Icon name="Plus" className="size-3.5" />
        New card
      </Button>
    </div>
  );
}

const VIEW_OPTIONS = [
  { value: "board", label: "Board" },
  { value: "todo", label: "Todo" },
] as const;

function ProposalsButton({ board, onOpen }: { board: Board; onOpen: () => void }) {
  const ready = board.dumps.filter((dump) => dump.status === "ready").length;
  const pop = usePopOnChange(ready);
  return (
    <Button type="button" variant="ghost" className={cn(COMPACT, "relative")} onClick={onOpen} aria-label="Brain dump proposals">
      <Icon name="kanban-search-check" className={cn("size-3.5", board.dumps.some((dump) => dump.status === "planning") && "animate-pulse")} />
      Proposals
      {ready > 0 ? (
        <span key={pop.key} onAnimationEnd={pop.onAnimationEnd} className={cn("inline-flex", pop.className)}>
          <Badge tone="success">{ready}</Badge>
        </span>
      ) : board.dumps.some((dump) => dump.status === "failed") ? (
        <Badge tone="danger" className={enter.pop}>!</Badge>
      ) : null}
    </Button>
  );
}
