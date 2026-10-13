import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, experimental_useAppPanel as useAppPanel, experimental_useFixedTabTarget as useFixedTabTarget } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { PRESS, enter, speed, useEntrance, usePopOnChange } from "bb-motion";
import { useNerdFont } from "bb-nerd-font";
import type { Column, Ticket } from "../shared/board";
import { doneColumnId } from "../shared/columns";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { dueStatus, localDay, threadStatusText } from "./format";
import { type Rpc, type ProjectOption, useBoard, useProjects, useThreadIndex, useOpenThread, useNow } from "./data";
import { collapseRightPanel, pageUi, TICKET_TAB } from "./page-state";
import { focusBoard, requestCardFocus, useCardKeys } from "./card-keys";
import { ExternalLink, ThreadStatusDot, Select, HEADER_ICON_BUTTON, COMPACT, Group, Property } from "./primitives";
import { ProjectSelect } from "./project-select";
import { TagEditor } from "./tags";
import { ReviewPanel } from "./review-panel";
import { ChecksMark, JiraStatusGlyph, PrStateGlyph } from "./badges";
import { jiraStatusMark } from "./source-marks";
import { CommentsPanel } from "./comments-panel";
import { SubtasksGroup } from "./subtasks";
import { type RunAction, usePendingAction } from "./actions";

/** The header line truncates, which clips an outline to a sliver at the link's end, so focus draws inside the link. */
const LINE_LINK = "rounded-sm hover:text-foreground hover:underline focus-visible:bg-state-hover focus-visible:text-foreground focus-visible:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

function TicketDetails({
  ticket,
  columns,
  projects,
  thread,
  threads,
  allTags,
  rpc,
  onClose,
  onChanged,
  onOpenThread,
  onOpenDiff,
  tickets,
  onOpenTicket,
  onBack,
  focusOnMount = false,
}: {
  ticket: Ticket;
  columns: Column[];
  projects: ProjectOption[];
  thread: PluginSidebarThread | null | undefined;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  allTags: readonly string[];
  rpc: Rpc;
  onClose: () => void;
  onChanged: () => void;
  onOpenThread: (threadId: string) => void;
  onOpenDiff: (ticketId: string) => void;
  tickets: readonly Ticket[];
  onOpenTicket: (ticketId: string) => void;
  /** Back to the board with the card left open. */
  onBack?: () => void;
  focusOnMount?: boolean;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const { pending, run } = usePendingAction(onChanged);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showParentPicker, setShowParentPicker] = useState(false);
  useEffect(() => {
    setTitle(ticket.title);
    setDescription(ticket.description);
    setProjectId(ticket.projectId ?? "");
    setConfirmDelete(false);
    // Reset the form only when a different card is shown or its stored text changes.
  }, [ticket.id, ticket.title, ticket.description, ticket.projectId]);
  // Only an empty pick falls back: the list refetches after a project is made from a folder, and that pick must stay.
  useEffect(() => {
    if (projectId === "" && projects[0] !== undefined) setProjectId(projects[0].id);
  }, [projectId, projects]);

  // Title and description save when the field loses focus, like the other controls apply immediately.
  const saveText = () => {
    const nextTitle = title.trim() === "" ? ticket.title : title.trim();
    if (nextTitle === ticket.title && description === ticket.description) return;
    void run(() => rpc.call("ticket_update", { id: ticket.id, title: nextTitle, description }));
  };
  const kindLabel = ticket.pr !== null ? "Pull request" : ticket.jira !== null ? "Jira issue" : "Card";
  const columnName = columns.find((column) => column.id === ticket.columnId)?.name ?? ticket.columnId;
  const parent = ticket.parentId === null ? null : (tickets.find((entry) => entry.id === ticket.parentId) ?? null);
  // Candidates to nest under: anything except this card and its own descendants.
  const descendants = new Set<string>();
  const collect = (id: string) => {
    for (const entry of tickets) {
      if (entry.parentId === id && !descendants.has(entry.id)) {
        descendants.add(entry.id);
        collect(entry.id);
      }
    }
  };
  collect(ticket.id);
  const parentOptions = tickets.filter((entry) => entry.id !== ticket.id && !descendants.has(entry.id));
  const pendingPop = usePopOnChange(ticket.pendingDiffComments);
  const nerdFont = useNerdFont();
  const jiraMark = nerdFont && ticket.jira !== null ? jiraStatusMark(ticket.jira) : null;
  const rootRef = useRef<HTMLDivElement>(null);
  const keys = useCardKeys(rootRef, ticket.id, focusOnMount, {
    onThread: () => {
      if (ticket.threadId !== null) onOpenThread(ticket.threadId);
    },
    onDiff: () => {
      if (ticket.pr !== null || ticket.threadId !== null) onOpenDiff(ticket.id);
    },
    onHelp: () => pageUi.set({ dialog: "keys" }),
    onBack,
  });
  // Moving to a subtask or parent from the keyboard keeps the keyboard in the card.
  const openTicket = (ticketId: string) => {
    if (rootRef.current?.contains(document.activeElement)) requestCardFocus(ticketId);
    onOpenTicket(ticketId);
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={keys.onKeyDown}
      onFocus={keys.onFocus}
      className="flex flex-col gap-4 outline-none [&_[data-kanban-cursor]]:ring-2 [&_[data-kanban-cursor]]:ring-ring"
    >
      <header className="flex flex-col gap-1">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveText}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
          aria-label="Title"
          readOnly={ticket.kind !== "adhoc"}
          className="-mx-1 w-full rounded bg-transparent px-1 text-base font-semibold leading-6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {parent !== null ? (
          <button type="button" className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => openTicket(parent.id)}>
            <Icon name="ChevronUp" className="size-3" />
            <span className="truncate">{parent.title}</span>
          </button>
        ) : null}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground" title={`${kindLabel} ${ticket.id} · ${columnName}`}>
            {ticket.pr !== null ? (
              <>
                {nerdFont ? <PrStateGlyph state={ticket.pr.state} /> : null}
                <span className="shrink-0">
                  <ExternalLink href={ticket.pr.url} title={`Open ${ticket.pr.repo}#${ticket.pr.number} on GitHub`} className={LINE_LINK}>
                    {ticket.pr.repo.split("/")[1]} #{ticket.pr.number}
                  </ExternalLink>
                  {nerdFont ? null : ` · ${ticket.pr.state}`}
                </span>
                {ticket.pr.checks !== null ? <ChecksMark checks={ticket.pr.checks} nerdFont={nerdFont} /> : null}
                {ticket.pr.headRef !== null ? (
                  <span className="min-w-0 truncate" title={`Branch ${ticket.pr.headRef}`}>
                    · {ticket.pr.headRef}
                  </span>
                ) : null}
              </>
            ) : null}
            {ticket.jira !== null ? (
              <span className="flex min-w-0 items-center gap-1.5">
                {nerdFont ? <JiraStatusGlyph jira={ticket.jira} /> : null}
                <span className="truncate">
                  <ExternalLink href={ticket.jira.url} title={`Open ${ticket.jira.key} in Jira`} className={LINE_LINK}>
                    {ticket.jira.key}
                  </ExternalLink>
                  {jiraMark === null ? ` · ${ticket.jira.status || "unknown"}` : null}
                </span>
              </span>
            ) : null}
            {ticket.pr === null && ticket.jira === null ? <span className="truncate">{parent !== null ? "Subtask" : kindLabel}</span> : null}
          </div>
          {ticket.threadId !== null ? (
            <button type="button" className={HEADER_ICON_BUTTON} aria-label="Open thread" title="Open thread" onClick={() => onOpenThread(ticket.threadId!)}>
              <Icon name="MessageSquare" className="size-3.5" />
              <span className="absolute -right-0.5 -top-0.5 flex rounded-full ring-2 ring-background">
                <ThreadStatusDot thread={thread} />
              </span>
            </button>
          ) : null}
          {ticket.pr !== null || ticket.threadId !== null ? (
            <button
              type="button"
              className={HEADER_ICON_BUTTON}
              aria-label="View changes"
              data-kanban-initial-stop=""
              title={ticket.pendingDiffComments > 0 ? `View changes · ${ticket.pendingDiffComments} comment${ticket.pendingDiffComments === 1 ? "" : "s"} not sent yet` : "View changes"}
              onClick={() => onOpenDiff(ticket.id)}
            >
              <Icon name="kanban-diff" className="size-3.5" />
              {ticket.pendingDiffComments > 0 ? (
                <span
                  key={pendingPop.key}
                  onAnimationEnd={pendingPop.onAnimationEnd}
                  className={cn("absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[9px] font-semibold leading-none text-white tabular-nums", pendingPop.className)}
                >
                  {ticket.pendingDiffComments}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
      </header>

      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
        <Property label="Column">
          <Select
            aria-label="Column"
            value={ticket.columnId}
            className="h-7 w-auto"
            onChange={(columnId) => void run(() => rpc.call("ticket_move", { id: ticket.id, columnId, index: null }))}
          >
            {columns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name}
              </option>
            ))}
          </Select>
        </Property>
        <Property label="Tags">
          <TagEditor ticket={ticket} rpc={rpc} run={run} suggestions={allTags} />
        </Property>
        <Property label="Due">
          <DueDateEditor ticket={ticket} isDone={ticket.columnId === doneColumnId(columns)} rpc={rpc} run={run} />
        </Property>
        {ticket.parentId !== null || showParentPicker ? (
          <ParentProperty rise={showParentPicker}>
            <Select
              aria-label="Parent card"
              value={ticket.parentId ?? ""}
              className="h-7 w-auto max-w-full"
              onChange={(value) => void run(() => rpc.call("ticket_set_parent", { id: ticket.id, parentId: value === "" ? null : value }))}
            >
              <option value="">None (top-level)</option>
              {parentOptions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title.length > 60 ? `${entry.title.slice(0, 60)}…` : entry.title}
                </option>
              ))}
            </Select>
          </ParentProperty>
        ) : null}
        <Property label="Thread">
          {ticket.threadId !== null ? (
            <button
              type="button"
              onClick={() => onOpenThread(ticket.threadId!)}
              className="flex max-w-full items-center gap-1.5 text-left text-sm hover:underline"
            >
              <span className="truncate">{thread?.displayTitle ?? "Thread"}</span>
              <span className="shrink-0 text-xs text-muted-foreground">· {threadStatusText(thread)}</span>
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <ProjectSelect projects={projects} value={projectId} onChange={setProjectId} allowNone={false} className="h-7 w-auto max-w-48" />
              <Button
                type="button"
                variant="secondary"
                className={COMPACT}
                disabled={pending || projectId === ""}
                onClick={() => void run(() => rpc.call("ticket_start_thread", { id: ticket.id, projectId }), "Thread started")}
              >
                <Icon name="Play" className="size-3.5" />
                Start
              </Button>
            </div>
          )}
        </Property>
        {ticket.pr !== null ? (
          <Property label="Author">
            <span>{ticket.pr.author || "unknown"}</span>
            {ticket.pr.role === "authored" ? <span className="text-xs text-muted-foreground"> (you)</span> : null}
          </Property>
        ) : null}
        {ticket.jira !== null ? (
          <>
            <Property label="Type">{ticket.jira.issueType || "issue"}</Property>
            {ticket.jira.priority !== null ? <Property label="Priority">{ticket.jira.priority}</Property> : null}
            {ticket.jira.assignee !== null ? <Property label="Assignee">{ticket.jira.assignee}</Property> : null}
          </>
        ) : null}
      </dl>

      <SubtasksGroup ticket={ticket} tickets={tickets} columns={columns} threads={threads} rpc={rpc} pending={pending} run={run} onOpenTicket={openTicket} onOpenThread={onOpenThread} />

      {ticket.pr !== null ? (
        <ReviewPanel
          ticket={ticket}
          threads={threads}
          rpc={rpc}
          pending={pending}
          canReview={ticket.projectId !== null}
          run={run}
          onOpenThread={onOpenThread}
        />
      ) : null}

      {ticket.pr !== null ? (
        <CommentsPanel
          ticket={ticket}
          threads={threads}
          rpc={rpc}
          pending={pending}
          canApply={ticket.projectId !== null}
          run={run}
          onOpenThread={onOpenThread}
        />
      ) : null}

      <Group
        title={ticket.kind === "adhoc" ? "Description" : "Notes"}
        summary={description.trim() === "" ? <span className="text-xs text-muted-foreground">empty</span> : undefined}
        defaultOpen
      >
        <textarea
          data-kanban-main-input=""
          aria-label={ticket.kind === "adhoc" ? "Description" : "Notes"}
          value={description}
          rows={ticket.kind === "adhoc" ? 6 : 3}
          placeholder={ticket.kind === "adhoc" ? "What needs to happen?" : "Notes"}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={saveText}
          className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </Group>

      <footer className="flex items-center justify-between gap-2 pt-1">
        {confirmDelete ? (
          <div className={cn("flex items-center gap-1.5", enter.rise, speed.fast)}>
            <span className="text-xs text-muted-foreground">Delete this card? Threads are kept.</span>
            <Button
              type="button"
              variant="destructive"
              className={COMPACT}
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await rpc.call("ticket_delete", { id: ticket.id });
                  onClose();
                }, "Card deleted")
              }
            >
              Delete
            </Button>
            <Button type="button" variant="ghost" className={COMPACT} onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <span className="flex items-center gap-1">
            <Button type="button" variant="ghost" className={cn(COMPACT, "text-muted-foreground hover:text-destructive")} onClick={() => setConfirmDelete(true)}>
              <Icon name="Trash2" className="size-3.5" />
              Delete
            </Button>
            {ticket.parentId === null && !showParentPicker && parentOptions.length > 0 ? (
              <Button type="button" variant="ghost" className={cn(COMPACT, "text-muted-foreground")} onClick={() => setShowParentPicker(true)}>
                Nest under…
              </Button>
            ) : null}
          </span>
        )}
        <Button type="button" variant="ghost" className={COMPACT} onClick={onClose}>
          Close
        </Button>
      </footer>
    </div>
  );
}

/** The entrance is decided when the row mounts, so it only plays when the picker opens it, never on a card that already shows a parent. */
function ParentProperty({ rise, children }: { rise: boolean; children: ReactNode }) {
  const entrance = useEntrance(rise ? cn(enter.rise, speed.fast) : undefined);
  return (
    <Property label="Parent" className={entrance.className} onAnimationEnd={entrance.onAnimationEnd}>
      {children}
    </Property>
  );
}

/**
 * Saves when the field loses focus: typing a year fires a change per digit, each one a valid date.
 * A date input reads empty while any segment is incomplete, so an empty blur reverts; the X button clears.
 */
function DueDateEditor({ ticket, isDone, rpc, run }: { ticket: Ticket; isDone: boolean; rpc: Rpc; run: RunAction }) {
  const [value, setValue] = useState(ticket.dueDate ?? "");
  const today = localDay(useNow(60_000));
  useEffect(() => setValue(ticket.dueDate ?? ""), [ticket.id, ticket.dueDate]);
  const save = (next: string) => {
    const dueDate = next === "" ? null : next;
    if (dueDate === ticket.dueDate) return;
    void run(() => rpc.call("ticket_set_due_date", { id: ticket.id, dueDate }));
  };
  const due = ticket.dueDate === null ? null : dueStatus(ticket.dueDate, today);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="date"
        aria-label="Due date"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => (value === "" ? setValue(ticket.dueDate ?? "") : save(value))}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
        className="h-7 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {ticket.dueDate !== null ? (
        <button
          type="button"
          aria-label="Clear due date"
          title="Clear due date"
          className={cn("flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)}
          onClick={() => {
            setValue("");
            save("");
          }}
        >
          <Icon name="X" className="size-3.5" />
        </button>
      ) : null}
      {due !== null ? (
        <span className={cn("text-xs text-muted-foreground", !isDone && due.tone === "overdue" && "text-destructive", !isDone && due.tone === "soon" && "text-amber-700 dark:text-amber-300")}>
          {due.relative}
        </span>
      ) : null}
    </div>
  );
}

type TicketDetailsProps = Parameters<typeof TicketDetails>[0];

/** Fallback for surfaces without a right panel (compact viewports). */
export function TicketDialog(props: Omit<TicketDetailsProps, "ticket"> & { ticket: Ticket | null }) {
  if (props.ticket === null) return null;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      {/* The card places focus itself; Radix would put it in the title, where vim-mode starts typing. */}
      <DialogContent className="sm:max-w-xl" onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="sr-only">Card {props.ticket.id}</DialogTitle>
          <DialogDescription className="sr-only">Edit the card, move it, or open its thread.</DialogDescription>
        </DialogHeader>
        <TicketDetails {...props} ticket={props.ticket} focusOnMount />
      </DialogContent>
    </Dialog>
  );
}

/** Right-panel tab: shows the card targeted from the board or todo list. */
export function TicketTab() {
  const target = useFixedTabTarget(TICKET_TAB);
  const { rpc, board, refetch } = useBoard();
  const projects = useProjects();
  const threads = useThreadIndex();
  const openThread = useOpenThread();
  const navigate = useBbNavigate();
  const appPanel = useAppPanel();
  const ticket = target === null ? null : (board?.tickets.find((entry) => entry.id === target.target.ticketId) ?? null);
  // Escape clears the card like closing a dialog would. Radix dialogs (new card, columns, sources)
  // take precedence: while one is open, Escape belongs to it.
  useEffect(() => {
    if (target === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"]') !== null) return;
      event.preventDefault();
      target.clear();
      collapseRightPanel();
      focusBoard(target.target.ticketId);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [target]);
  if (target === null || ticket === null) {
    return (
      <p className={cn("rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground", enter.fade)}>
        {board === null ? "Loading…" : target === null ? "Select a card to see its details here." : "This card no longer exists."}
      </p>
    );
  }
  const detailProps = {
    columns: board!.columns,
    projects,
    thread: ticket.threadId === null ? null : threads.get(ticket.threadId),
    threads,
    allTags: board!.tags,
    rpc,
    onChanged: refetch,
    onOpenThread: openThread,
    onOpenDiff: (ticketId: string) => navigate.toPluginPanel("board", { subPath: `diff/${ticketId}` }),
    tickets: board!.tickets,
    onOpenTicket: (ticketId: string) => appPanel.openFixedTab({ surface: { kind: "current" }, tab: TICKET_TAB, target: { ticketId } }),
  };
  // Keyed so switching cards rises the new one in with fresh per-card state.
  return (
    <div key={ticket.id} className={enter.rise}>
      <TicketDetails
        {...detailProps}
        ticket={ticket}
        onBack={() => focusBoard(ticket.id)}
        onClose={() => {
          target.clear();
          collapseRightPanel();
        }}
      />
    </div>
  );
}
