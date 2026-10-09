import { useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { STAGGER, enter, speed, stagger, type Arrival, useArrivals, useEntrance, usePopOnChange, POPOVER_MOTION } from "bb-motion";
import type { Column, Ticket } from "../shared/board";
import { doneColumnId, todoColumnId } from "../shared/columns";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { parseQuickAdd } from "./format";
import { type Rpc } from "./data";
import { Badge, ThreadStatusDot, COMPACT, Group, MENU_ITEM_CLASS } from "./primitives";
import type { RunAction } from "./actions";

function SubtaskProgress({ ticket }: { ticket: Ticket }) {
  if (ticket.children.total === 0) return null;
  return <SubtaskProgressBadge done={ticket.children.done} total={ticket.children.total} />;
}

function SubtaskProgressBadge({ done, total }: { done: number; total: number }) {
  const pop = usePopOnChange(done);
  return (
    <span key={pop.key} onAnimationEnd={pop.onAnimationEnd} className={cn("inline-flex", pop.className)}>
      <Badge tone={done === total ? "success" : "neutral"} title={`${done} of ${total} subtasks done`}>
        <Icon name="ListTodo" className="size-3" />
        {done}/{total}
      </Badge>
    </span>
  );
}

function SubtaskRow({
  child,
  index,
  arrival,
  columns,
  thread,
  isDone,
  onToggle,
  onOpenTicket,
  onOpenThread,
}: {
  child: Ticket;
  index: number;
  arrival: Arrival;
  columns: Column[];
  thread: PluginSidebarThread | null | undefined;
  isDone: boolean;
  onToggle: () => void;
  onOpenTicket: (ticketId: string) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const entrance = useEntrance(arrival === "intro" ? cn(enter.rise, speed.fast, STAGGER) : arrival === "new" ? enter.rise : undefined);
  return (
    <li style={stagger(index)} onAnimationEnd={entrance.onAnimationEnd} className={cn("flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-state-hover", entrance.className)}>
      <Checkbox checked={isDone} aria-label={isDone ? `Reopen "${child.title}"` : `Mark "${child.title}" done`} onCheckedChange={onToggle} />
      <button type="button" className={cn("min-w-0 flex-1 truncate text-left hover:underline", isDone && "text-muted-foreground line-through")} onClick={() => onOpenTicket(child.id)}>
        {child.title}
      </button>
      <span className="shrink-0 text-[11px] text-muted-foreground">{columns.find((column) => column.id === child.columnId)?.name ?? child.columnId}</span>
      {child.children.total > 0 ? <SubtaskProgress ticket={child} /> : null}
      {child.threadId !== null ? (
        <button type="button" aria-label="Open subtask thread" className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground" onClick={() => onOpenThread(child.threadId!)}>
          <ThreadStatusDot thread={thread} />
        </button>
      ) : (
        <span className="w-6 shrink-0" />
      )}
    </li>
  );
}

export function SubtasksGroup({
  ticket,
  tickets,
  columns,
  threads,
  rpc,
  pending,
  run,
  onOpenTicket,
  onOpenThread,
}: {
  ticket: Ticket;
  tickets: readonly Ticket[];
  columns: Column[];
  threads: ReadonlyMap<string, PluginSidebarThread>;
  rpc: Rpc;
  pending: boolean;
  run: RunAction;
  onOpenTicket: (ticketId: string) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const children = tickets.filter((entry) => entry.parentId === ticket.id).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  const doneId = doneColumnId(columns);
  const todoId = todoColumnId(columns);
  const open = children.filter((child) => child.columnId !== doneId);
  const unstarted = open.filter((child) => child.threadId === null);
  const canRun = ticket.projectId !== null || ticket.threadId !== null;
  const arrival = useArrivals(children.map((child) => child.id));
  const add = () => {
    const { title, tags } = parseQuickAdd(draft);
    if (title === "") return;
    setDraft("");
    void run(() => rpc.call("ticket_create", { title, tags, parentId: ticket.id, ...(todoId === null ? {} : { columnId: todoId }) }));
  };
  return (
    <Group
      title="Subtasks"
      summary={
        children.length === 0 ? (
          <span className="text-xs text-muted-foreground">none</span>
        ) : (
          <>
            <SubtaskProgress ticket={ticket} />
            {open.some((child) => child.threadId !== null && threads.get(child.threadId)?.runtimeStatus === "active") ? <Badge tone="accent">working</Badge> : null}
          </>
        )
      }
      defaultOpen
    >
      {children.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {children.map((child, index) => (
            <SubtaskRow
              key={child.id}
              child={child}
              index={index}
              arrival={arrival(child.id)}
              columns={columns}
              thread={child.threadId === null ? null : threads.get(child.threadId)}
              isDone={child.columnId === doneId}
              onToggle={() =>
                void run(() => rpc.call("ticket_move", { id: child.id, columnId: child.columnId === doneId ? (todoId ?? child.columnId) : (doneId ?? child.columnId), index: null }))
              }
              onOpenTicket={onOpenTicket}
              onOpenThread={onOpenThread}
            />
          ))}
        </ul>
      ) : null}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a subtask… (#tag allowed)" aria-label="New subtask" className="h-7 text-xs" />
        <Button type="submit" variant="secondary" className={COMPACT} disabled={pending || parseQuickAdd(draft).title === ""}>
          <Icon name="Plus" className="size-3.5" />
          Add
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="secondary" className={COMPACT} disabled={pending || !canRun} onClick={() => setGuidanceOpen((value) => !value)}>
          <Icon name="kanban-search-check" className="size-3.5" />
          Break down with AI
        </Button>
        {open.length > 0 ? (
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <Button type="button" className={COMPACT} disabled={pending || !canRun}>
                <Icon name="Play" className="size-3.5" />
                Start {unstarted.length > 0 ? `${unstarted.length} subtask${unstarted.length === 1 ? "" : "s"}` : "subtasks"}
                <Icon name="ChevronDown" className="size-3 opacity-70" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content {...usePortalScopeProps()} align="start" sideOffset={4} className={cn("z-50 min-w-64 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md", POPOVER_MOTION)}>
                <DropdownMenu.Item
                  className={cn(MENU_ITEM_CLASS, "items-start")}
                  disabled={unstarted.length === 0}
                  onSelect={() => void run(() => rpc.call("ticket_start_children", { id: ticket.id, mode: "parallel" }), "Subtask threads started")}
                >
                  <Icon name="Play" className="mt-0.5 size-4 text-muted-foreground" />
                  <span>One thread per subtask ({unstarted.length})</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={cn(MENU_ITEM_CLASS, "items-start")}
                  onSelect={() => void run(() => rpc.call("ticket_start_children", { id: ticket.id, mode: "sequential" }), "Subtask thread started")}
                >
                  <Icon name="ListTodo" className="mt-0.5 size-4 text-muted-foreground" />
                  <span>One thread, in order ({open.length})</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </div>
      {guidanceOpen ? (
        <div className={cn("flex flex-col gap-1.5 rounded-md border border-border p-2", enter.drop, speed.fast)}>
          <textarea
            autoFocus
            value={guidance}
            rows={2}
            onChange={(event) => setGuidance(event.target.value)}
            placeholder="Guidance for the split (optional)"
            aria-label="Breakdown guidance"
            className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" className={COMPACT} onClick={() => setGuidanceOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              className={COMPACT}
              disabled={pending}
              onClick={() => {
                setGuidanceOpen(false);
                void run(() => rpc.call("ticket_breakdown", { id: ticket.id, guidance }), ticket.threadId === null ? "Breakdown thread started" : "Asked the card's thread to break it down");
              }}
            >
              Ask the agent to split it
            </Button>
          </div>
        </div>
      ) : null}
    </Group>
  );
}
