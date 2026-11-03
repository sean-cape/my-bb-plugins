import { useEffect, useRef, useState, type ReactNode } from "react";
import { Markdown, useBbNavigate, experimental_useAppPanel as useAppPanel, experimental_useFixedTabTarget as useFixedTabTarget } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { PRESS, enter, speed, useEntrance, usePopOnChange } from "bb-motion";
import { useNerdFont } from "bb-nerd-font";
import type { Board, Column, Ticket } from "../shared/board";
import { defaultGates, type LoopGates } from "../shared/loop";
import { doneColumnId } from "../shared/columns";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { addDays, dueStatus, isAgentCard, isSnoozed, localDay, nextWeekday, PRIORITY_LABEL } from "./format";
import { type Rpc, type ProjectOption, useBoard, useTicketHasDiff, useProjects, useProjectSuggestion, useThreadIndex, useOpenThread, useNow } from "./data";
import { collapseRightPanel, pageUi, TICKET_TAB } from "./page-state";
import { focusBoard, requestCardFocus, useCardKeys } from "./card-keys";
import { ExternalLink, ThreadStatusDot, Select, HEADER_ICON_BUTTON, COMPACT, Group, Property } from "./primitives";
import { type ProjectPickerSuggestion, ProjectSelect } from "./project-select";
import { TagEditor } from "./tags";
import { ReviewPanel } from "./review-panel";
import { ApprovedPlan, HandoffBrief, LeftOpenFindings, PlanApproval } from "./brief-panel";
import { LoopSection } from "./loop-section";
import { composerMode } from "./loop-menu-items";
import { RunModeControl } from "./run-mode";
import type { RunMode } from "./run-mode-flags";
import { ChecksMark, JiraStatusGlyph, PrStateGlyph, checksHref } from "./badges";
import { jiraStatusMark } from "./source-marks";
import { CommentsPanel } from "./comments-panel";
import { SubtasksGroup } from "./subtasks";
import { type RunAction, usePendingAction } from "./actions";

const STARTED_IN_LOOP = "Thread started in the review loop";

/** The header line truncates, which clips an outline to a sliver at the link's end, so focus draws inside the link. */
const LINE_LINK = "rounded-sm hover:text-foreground hover:underline focus-visible:bg-state-hover focus-visible:text-foreground focus-visible:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * Starts a thread for a card that has none: into the review loop, with the gates chosen here, or on its own. A card
 * already monitored (by a tag, or the switch below) just starts; its thread gets the loop's contract either way.
 */
function ThreadStartRow({
  ticket,
  projects,
  projectId,
  onProjectChange,
  suggestion,
  gates,
  onGatesChange,
  pending,
  run,
  rpc,
}: {
  ticket: Ticket;
  projects: ProjectOption[];
  projectId: string;
  onProjectChange: (projectId: string) => void;
  suggestion: ProjectPickerSuggestion | undefined;
  gates: LoopGates;
  onGatesChange: (gates: LoopGates) => void;
  pending: boolean;
  run: RunAction;
  rpc: Rpc;
}) {
  const monitored = ticket.loop?.monitored === true;
  const [mode, setMode] = useState<RunMode>("thread");
  const start = () => {
    if (mode === "loop" && !monitored) {
      void run(async () => {
        await rpc.call("ticket_set_monitored", { id: ticket.id, monitored: true, gates });
        return rpc.call("ticket_start_thread", { id: ticket.id, projectId });
      }, STARTED_IN_LOOP);
      return;
    }
    void run(() => rpc.call("ticket_start_thread", { id: ticket.id, projectId }), monitored ? STARTED_IN_LOOP : "Thread started");
  };
  return (
    <Property label="Thread">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <ProjectSelect projects={projects} value={projectId} onChange={onProjectChange} allowNone suggestion={suggestion} className="h-7 w-auto max-w-48" />
          <Button type="button" variant="secondary" className={COMPACT} disabled={pending || projectId === ""} onClick={start}>
            <Icon name="Play" className="size-3.5" />
            Start
          </Button>
        </div>
        {monitored ? (
          <span className="text-xs text-muted-foreground">Starts into the review loop; the thread's instructions carry the loop's contract</span>
        ) : (
          <RunModeControl value={mode} onChange={setMode} gates={gates} onGatesChange={onGatesChange} hasProject={projectId !== ""} cardOnly={false} disabled={pending} />
        )}
      </div>
    </Property>
  );
}

function TicketDetails({
  ticket,
  columns,
  projects,
  thread,
  threads,
  allTags,
  projectSettings,
  rpc,
  onClose,
  onChanged,
  onOpenThread,
  onOpenDiff,
  tickets,
  onOpenTicket,
  onBack,
  onEscape,
  focusOnMount = false,
}: {
  ticket: Ticket;
  columns: Column[];
  projects: ProjectOption[];
  thread: PluginSidebarThread | null | undefined;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  allTags: readonly string[];
  projectSettings: Board["projectSettings"];
  rpc: Rpc;
  onClose: () => void;
  onChanged: () => void;
  onOpenThread: (threadId: string) => void;
  onOpenDiff: (ticketId: string) => void;
  tickets: readonly Ticket[];
  onOpenTicket: (ticketId: string) => void;
  /** Back to the board with the card left open. */
  onBack?: () => void;
  /** Escape from the card's keys, outside a text box. */
  onEscape?: () => void;
  focusOnMount?: boolean;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectPicked, setProjectPicked] = useState(false);
  const { pending, run } = usePendingAction(onChanged);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showParentPicker, setShowParentPicker] = useState(false);
  useEffect(() => {
    setTitle(ticket.title);
    setDescription(ticket.description);
    setConfirmDelete(false);
    // Reset the form only when a different card is shown or its stored text changes.
  }, [ticket.id, ticket.title, ticket.description]);
  useEffect(() => {
    setProjectId(ticket.projectId ?? "");
    setProjectPicked(false);
  }, [ticket.id, ticket.projectId]);
  const [showAgentRow, setShowAgentRow] = useState(false);
  useEffect(() => setShowAgentRow(false), [ticket.id]);
  // A plain to-do shows no project picker, so it reads the guess only once it's about to become an agent task.
  const suggestion = useProjectSuggestion(ticket, ticket.threadId === null && (isAgentCard(ticket) || showAgentRow));
  const settled = suggestion === null || suggestion.pending ? { guess: null, fallbackProjectId: null } : suggestion;
  const listed = (id: string | undefined | null) => projects.some((project) => project.id === id);
  const guess = listed(settled.guess?.projectId) ? settled.guess : null;
  const fallbackId = listed(settled.fallbackProjectId) ? settled.fallbackProjectId : null;
  // Until the user picks, the guess beats the fallback project setting, which beats the first project. A pick, which
  // includes a project just made from a folder that the refetched list may not hold yet, always stays.
  useEffect(() => {
    if (projectPicked || ticket.projectId !== null) return;
    const kept = projects.some((project) => project.id === projectId) ? projectId : (projects[0]?.id ?? "");
    const next = guess?.projectId ?? fallbackId ?? kept;
    if (next !== projectId) setProjectId(next);
  }, [projectPicked, ticket.projectId, projects, projectId, guess?.projectId, fallbackId]);
  const pickProject = (next: string) => {
    setProjectPicked(true);
    setProjectId(next);
  };
  const pickerSuggestion: ProjectPickerSuggestion | undefined = suggestion?.pending === true && !projectPicked ? "pending" : (guess ?? undefined);

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
  const hasDiff = useTicketHasDiff(ticket, thread);
  const rootRef = useRef<HTMLDivElement>(null);
  const monitored = ticket.loop?.monitored === true;
  const reviewFirst = ticket.pr !== null;
  // A plain to-do leaves out the code review, the loop and the changes until it gets a project or a thread.
  const agentCard = isAgentCard(ticket);
  // The gates to monitor with, chosen before the switch turns on; a monitored card shows its own.
  const [gateChoice, setGateChoice] = useState(() => defaultGates(ticket.kind));
  useEffect(() => setGateChoice(defaultGates(ticket.kind)), [ticket.id, ticket.kind]);
  const toggleMonitored = () =>
    void run(
      () => rpc.call("ticket_set_monitored", monitored ? { id: ticket.id, monitored: false } : { id: ticket.id, monitored: true, gates: gateChoice }),
      monitored ? "Monitoring off; the loop stops after its current step" : "Monitoring on",
    );
  const [loopMenuOpen, setLoopMenuOpen] = useState(false);
  useEffect(() => setLoopMenuOpen(false), [ticket.id]);
  // Someone else's PR shows no loop section, so m toggles the loop there as before.
  const loopSectionShown = agentCard && ticket.pr?.role !== "other";
  // The loop's composer is the card's main text box (`i`) while it is shown and can send; otherwise the description is.
  const composer = composerMode(ticket.loop);
  const composerMain = loopSectionShown && ticket.threadId !== null && composer !== null && composer !== "paused";
  const keys = useCardKeys(rootRef, ticket.id, focusOnMount, {
    onLoopMenu: () => (loopSectionShown && monitored ? setLoopMenuOpen(true) : toggleMonitored()),
    onThread: () => {
      if (ticket.threadId !== null) {
        onOpenThread(ticket.threadId);
        return;
      }
      // One key hands a card to an agent: the thread starts in the picked (or guessed) project and opens.
      if (projectId === "" || pending) return;
      void run(async () => {
        const started = (await rpc.call("ticket_start_thread", { id: ticket.id, projectId })) as Ticket;
        if (started.threadId !== null) onOpenThread(started.threadId);
      }, monitored ? STARTED_IN_LOOP : "Thread started");
    },
    onDiff: () => {
      if (hasDiff) onOpenDiff(ticket.id);
    },
    onHelp: () => pageUi.set({ dialog: "keys" }),
    onBack,
    onEscape,
  });
  const properties = (
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
      <Property label="Priority">
        <Select
          aria-label="Priority"
          value={ticket.priority === null ? "" : String(ticket.priority)}
          className="h-7 w-auto"
          onChange={(value) => void run(() => rpc.call("ticket_set_priority", { id: ticket.id, priority: value === "" ? null : Number(value) }))}
        >
          <option value="">None</option>
          {[1, 2, 3, 4].map((level) => (
            <option key={level} value={level}>
              P{level} · {PRIORITY_LABEL[level]}
            </option>
          ))}
        </Select>
      </Property>
      <Property label="Snooze">
        <SnoozeEditor ticket={ticket} rpc={rpc} run={run} />
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
      {ticket.threadId !== null ? null : agentCard || showAgentRow ? (
        <ThreadStartRow ticket={ticket} projects={projects} projectId={projectId} onProjectChange={pickProject} suggestion={pickerSuggestion} gates={gateChoice} onGatesChange={setGateChoice} pending={pending} run={run} rpc={rpc} />
      ) : (
        <Property label="Agent">
          <Button type="button" variant="ghost" className={cn(COMPACT, "-ml-2 self-start text-muted-foreground")} onClick={() => setShowAgentRow(true)}>
            <Icon name="Play" className="size-3.5" />
            Run as agent task…
          </Button>
        </Property>
      )}
      {ticket.jira !== null ? (
        <>
          <Property label="Type">{ticket.jira.issueType || "issue"}</Property>
          {ticket.jira.priority !== null ? <Property label="Jira priority">{ticket.jira.priority}</Property> : null}
          {ticket.jira.assignee !== null ? <Property label="Assignee">{ticket.jira.assignee}</Property> : null}
        </>
      ) : null}
    </dl>
  );
  // Moving to a subtask or parent from the keyboard keeps the keyboard in the card.
  const openTicket = (ticketId: string) => {
    if (rootRef.current?.contains(document.activeElement)) requestCardFocus(ticketId);
    onOpenTicket(ticketId);
  };

  return (
    <div
      ref={rootRef}
      data-kanban-card=""
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
            if (event.key !== "Enter") return;
            event.preventDefault();
            keys.leave(event.currentTarget);
          }}
          aria-label="Title"
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
                {ticket.pr.checks !== null ? <ChecksMark checks={ticket.pr.checks} nerdFont={nerdFont} href={checksHref(ticket.pr)} /> : null}
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
          {agentCard ? (
            <span
              className="inline-flex"
              title={!hasDiff ? "No changes" : ticket.pendingDiffComments > 0 ? `View changes · ${ticket.pendingDiffComments} comment${ticket.pendingDiffComments === 1 ? "" : "s"} not sent yet` : "View changes"}
            >
              <button
                type="button"
                className={cn(HEADER_ICON_BUTTON, "aria-disabled:pointer-events-none aria-disabled:opacity-50")}
                aria-label={hasDiff ? "View changes" : "View changes: no changes"}
                data-kanban-initial-stop=""
                // aria-disabled rather than disabled, which would drop it from the card's key stops and move the opening cursor elsewhere.
                aria-disabled={!hasDiff || undefined}
                onClick={() => {
                  if (hasDiff) onOpenDiff(ticket.id);
                }}
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
            </span>
          ) : null}
        </div>
      </header>

      <HandoffBrief ticket={ticket} rpc={rpc} run={run} pending={pending} onOpenThread={onOpenThread} />
      <PlanApproval ticket={ticket} rpc={rpc} run={run} pending={pending} />
      <ApprovedPlan ticket={ticket} />
      <LeftOpenFindings ticket={ticket} rpc={rpc} run={run} pending={pending} />

      {/* A PR card is read for its review: findings, PR comments and the PR's own description come before the card's properties. */}
      {reviewFirst ? (
        <>
          <ReviewPanel
            ticket={ticket}
            threads={threads}
            rpc={rpc}
            pending={pending}
            canReview={ticket.projectId !== null}
            run={run}
            onOpenThread={onOpenThread}
            onOpenTicket={openTicket}
          />
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
          {ticket.pr !== null && ticket.pr.body !== null && ticket.pr.body.trim() !== "" ? (
            <Group title="PR description" defaultOpen>
              <Markdown content={ticket.pr.body} className="text-sm" />
            </Group>
          ) : null}
          {properties}
        </>
      ) : (
        <>
          {properties}
          {agentCard ? (
            <ReviewPanel
              ticket={ticket}
              threads={threads}
              rpc={rpc}
              pending={pending}
              canReview={ticket.projectId !== null}
              run={run}
              onOpenThread={onOpenThread}
              onOpenTicket={openTicket}
            />
          ) : null}
        </>
      )}
      {/* Someone else's PR is not the loop's to drive, nor a plain to-do; m still toggles it. */}
      {!loopSectionShown ? null : (
        <LoopSection
          ticket={ticket}
          gates={monitored ? ticket.loop!.gates : gateChoice}
          projectSettings={projectSettings}
          rpc={rpc}
          run={run}
          pending={pending}
          onToggle={toggleMonitored}
          onGatesChange={(gates) => (monitored ? void run(() => rpc.call("loop_set_gates", { id: ticket.id, gates })) : setGateChoice(gates))}
          onOpenThread={onOpenThread}
          onOpenDiff={() => onOpenDiff(ticket.id)}
          onLeave={keys.leave}
          menuOpen={loopMenuOpen}
          onMenuOpenChange={setLoopMenuOpen}
          composerMain={composerMain}
        />
      )}
      <SubtasksGroup ticket={ticket} tickets={tickets} columns={columns} threads={threads} rpc={rpc} pending={pending} run={run} onOpenTicket={openTicket} onOpenThread={onOpenThread} />

      <Group
        title={ticket.kind === "adhoc" ? "Description" : "Notes"}
        summary={description.trim() === "" ? <span className="text-xs text-muted-foreground">empty</span> : undefined}
        defaultOpen
      >
        <textarea
          // While the loop's composer is the card's main text box, `i` goes there instead.
          {...(composerMain ? {} : { "data-kanban-main-input": "" })}
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

/** Snoozing hides the card from the board and the todo list until the day it's set to; Wake brings it back now. */
function SnoozeEditor({ ticket, rpc, run }: { ticket: Ticket; rpc: Rpc; run: RunAction }) {
  const today = localDay(useNow(60_000));
  const snooze = (until: string | null) => void run(() => rpc.call("ticket_snooze", { id: ticket.id, until }), until === null ? "Awake" : `Snoozed until ${dueStatus(until, today).label}`);
  if (isSnoozed(ticket, today)) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm">Until {dueStatus(ticket.snoozedUntil!, today).label}</span>
        <Button type="button" variant="ghost" className={COMPACT} onClick={() => snooze(null)}>
          Wake
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button type="button" variant="secondary" className={COMPACT} onClick={() => snooze(addDays(today, 1))}>
        Tomorrow
      </Button>
      <Button type="button" variant="secondary" className={COMPACT} onClick={() => snooze(nextWeekday(today, 1))}>
        Next week
      </Button>
      <input
        type="date"
        aria-label="Snooze until"
        min={addDays(today, 1)}
        defaultValue=""
        onBlur={(event) => {
          if (event.target.value > today) snooze(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
        className="h-7 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
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
    projectSettings: board!.projectSettings,
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
        onEscape={() => {
          target.clear();
          collapseRightPanel();
          focusBoard(ticket.id);
        }}
        onClose={() => {
          target.clear();
          collapseRightPanel();
        }}
      />
    </div>
  );
}
