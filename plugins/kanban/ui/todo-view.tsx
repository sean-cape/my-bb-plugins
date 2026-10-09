import { useEffect, useRef, useState } from "react";
import type { FormEvent, MutableRefObject } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { PRESS, STAGGER, enter, exit, speed, stagger, type Arrival, useArrivals, useEntrance, usePopOnChange, usePresenceList } from "bb-motion";
import type { Board, Column, Ticket } from "../shared/board";
import { doneColumnId, todoColumnId } from "../shared/columns";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { localDay, parseQuickAdd } from "./format";
import { type Rpc, useNow } from "./data";
import { Kbd, ThreadStatusDot } from "./primitives";
import { tagTone, TagBadges } from "./tags";
import { PrBadges, JiraBadges, ReviewBadge, DueBadge } from "./badges";
import { toastError } from "./actions";
import type { BoardCommand } from "./board-nav";
import { focusStop, focusedStop, moveAlongBand, nearestStop, pressStop, scrollHalfPage } from "./stops";

export function TodoView({
  commandRef,
  board,
  threads,
  rpc,
  onOpen,
  onOpenThread,
  refetch,
}: {
  /** Where the page's key handler sends board commands while the todo list shows. */
  commandRef: MutableRefObject<((command: BoardCommand) => void) | null>;
  board: Board;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  rpc: Rpc;
  onOpen: (ticket: Ticket) => void;
  onOpenThread: (threadId: string) => void;
  refetch: () => void;
}) {
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [quick, setQuick] = useState("");
  const today = localDay(useNow(60_000));
  const doneId = doneColumnId(board.columns);
  const todoId = todoColumnId(board.columns);
  const matches = (ticket: Ticket) => (showDone || ticket.columnId !== doneId) && tagFilter.every((tag) => ticket.tags.includes(tag));
  const byId = new Map(board.tickets.map((ticket) => [ticket.id, ticket]));
  // A subtask shows under its parent when the parent is listed; otherwise it stands on its own.
  const visible = board.tickets
    .filter((ticket) => matches(ticket) && (ticket.parentId === null || !byId.has(ticket.parentId) || !matches(byId.get(ticket.parentId)!)))
    .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  const childrenOf = (id: string) => board.tickets.filter((ticket) => ticket.parentId === id && matches(ticket)).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  const groups = board.columns
    .map((column) => ({ column, rows: visible.filter((ticket) => ticket.columnId === column.id).flatMap((ticket) => [ticket, ...childrenOf(ticket.id)]) }))
    .filter((group) => group.rows.length > 0);
  // Rows cascade as one list across sections.
  const byColumn = groups.map((group, index) => ({ ...group, offset: groups.slice(0, index).reduce((sum, previous) => sum + previous.rows.length, 0) }));
  const arrival = useArrivals(board.tickets.map((ticket) => ticket.id));
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // A todo moving between sections remounts there and has to be focused again.
  const pendingFocusId = useRef<string | null>(null);
  const lastRowId = useRef<string | null>(null);
  const rowElements = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-todo-row]:not([aria-hidden])") ?? []);
  const rowFor = (ticketId: string | null) => (ticketId === null ? undefined : rowElements().find((row) => row.dataset.ticketId === ticketId));
  const focusRow = (row: HTMLElement) => {
    row.querySelector<HTMLElement>("[data-todo-open]")?.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  };
  useEffect(() => {
    const row = rowFor(pendingFocusId.current);
    if (row === undefined) return;
    pendingFocusId.current = null;
    focusRow(row);
  });
  const enterFromTop = (from: Element) => {
    const filter = nearestStop("filters", from);
    const first = rowElements()[0];
    if (filter !== null) focusStop(filter);
    else if (first !== undefined) focusRow(first);
  };
  commandRef.current = (command) => {
    const at = focusedStop();
    const rows = rowElements();
    const row = (document.activeElement?.closest<HTMLElement>("[data-todo-row]") ?? null);
    const index = row === null ? -1 : rows.indexOf(row);
    const ticket = row === null ? undefined : byId.get(row.dataset.ticketId ?? "");
    switch (command.kind) {
      case "cursor": {
        const { motion } = command;
        if (at !== null) {
          if (moveAlongBand(at.band, at.stop, motion)) return;
          if (motion === "up" && at.band === "filters") {
            const next = nearestStop("header", at.stop);
            if (next !== null) focusStop(next);
          } else if (motion === "down" && at.band === "header") enterFromTop(at.stop);
          else if (motion === "down" && at.band === "filters" && rows[0] !== undefined) focusRow(rows[0]);
          return;
        }
        if (index === -1) {
          const resume = rowFor(lastRowId.current) ?? rows[0];
          if (resume !== undefined) focusRow(resume);
          return;
        }
        if (motion === "up" && index === 0) {
          const next = nearestStop("filters", row!) ?? nearestStop("header", row!);
          if (next !== null) focusStop(next);
          return;
        }
        const next = motion === "up" ? rows[index - 1] : motion === "down" ? rows[index + 1] : motion === "top" ? rows[0] : motion === "bottom" ? rows[rows.length - 1] : undefined;
        if (next !== undefined) focusRow(next);
        return;
      }
      case "open":
        if (at !== null) pressStop(at.stop);
        else if (ticket !== undefined) onOpen(ticket);
        return;
      case "thread":
        if (ticket?.threadId != null) onOpenThread(ticket.threadId);
        return;
      case "toggle-done": {
        if (ticket === undefined) return;
        // Without "Show done" the row leaves the list, so the cursor steps off it first.
        const neighbour = showDone ? row : (rows[index + 1] ?? rows[index - 1] ?? null);
        if (neighbour !== null) pendingFocusId.current = neighbour.dataset.ticketId ?? null;
        void toggleDone(ticket);
        return;
      }
      case "add":
      case "focus-input":
        inputRef.current?.focus();
        return;
      case "scroll": {
        const scroller = listRef.current?.closest<HTMLElement>("[data-kanban-keys]");
        if (scroller == null) return;
        const next = scrollHalfPage(scroller, rows, row, command.direction);
        if (next !== null && next !== row) focusRow(next);
        return;
      }
      default:
        return;
    }
  };
  const toggleDone = async (ticket: Ticket) => {
    const target = ticket.columnId === doneId ? todoId : doneId;
    if (target === null) return;
    try {
      await rpc.call("ticket_move", { id: ticket.id, columnId: target, index: null });
    } catch (cause) {
      toastError(cause);
    }
    refetch();
  };
  const quickAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { title, tags } = parseQuickAdd(quick);
    if (title === "" || todoId === null) return;
    try {
      await rpc.call("ticket_create", { title, tags: [...new Set([...tags, ...tagFilter])], columnId: todoId });
      setQuick("");
    } catch (cause) {
      toastError(cause);
    }
    refetch();
  };
  return (
    <div
      ref={listRef}
      onFocus={(event) => {
        const ticketId = (event.target as Element).closest<HTMLElement>("[data-todo-row]")?.dataset.ticketId;
        if (ticketId !== undefined) lastRowId.current = ticketId;
      }}
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:my-4 md:rounded-xl md:border md:border-border md:bg-background/75 md:p-5 md:shadow-sm md:backdrop-blur-md">
      <form onSubmit={quickAdd} className="flex items-center gap-2">
        <Input
          ref={inputRef}
          value={quick}
          onChange={(event) => setQuick(event.target.value)}
          onKeyDown={(event) => {
            // With vim-mode, this is the second Escape: the first only entered vim's normal mode.
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            const row = rowFor(lastRowId.current) ?? rowElements()[0];
            if (row !== undefined) focusRow(row);
            else listRef.current?.closest<HTMLElement>("[data-kanban-keys]")?.focus({ preventScroll: true });
          }}
          placeholder="Add a todo… use #tag for tags"
          aria-label="New todo"
        />
        <Button type="submit" disabled={parseQuickAdd(quick).title === ""}>
          <Icon name="Plus" className="size-4" />
          Add
        </Button>
      </form>
      {board.tags.length > 0 ? (
        <div data-kanban-filters="" className="flex flex-wrap items-center gap-1.5">
          {board.tags.map((tag) => {
            const active = tagFilter.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={active}
                onClick={() => setTagFilter(active ? tagFilter.filter((entry) => entry !== tag) : [...tagFilter, tag])}
                className={cn(
                  "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  PRESS,
                  active ? cn(tagTone(tag).chip, "font-medium") : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                <span className={cn("size-1.5 rounded-full", tagTone(tag).dot)} aria-hidden="true" />
                {tag}
              </button>
            );
          })}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={showDone} onCheckedChange={(checked) => setShowDone(checked === true)} aria-label="Show done" />
            Show done
          </label>
        </div>
      ) : null}
      {byColumn.length === 0 ? (
        <p className={cn("rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground", enter.fade)}>
          Nothing to do{tagFilter.length > 0 ? " with these tags" : ""}.
        </p>
      ) : null}
      {byColumn.map(({ column, rows, offset }) => (
        <TodoSection
          key={column.id}
          column={column}
          rows={rows}
          offset={offset}
          arrival={arrival}
          doneId={doneId}
          today={today}
          threads={threads}
          onToggleDone={(ticket) => void toggleDone(ticket)}
          onOpen={onOpen}
          onOpenThread={onOpenThread}
        />
      ))}
      <p className="hidden flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground md:flex">
        {TODO_HINTS.map(({ keys, action }) => (
          <span key={action} className="inline-flex items-center gap-1.5">
            {keys.map((key) => (
              <Kbd key={key} className="min-w-5 px-1 py-0 text-[11px]">
                {key}
              </Kbd>
            ))}
            {action}
          </span>
        ))}
      </p>
    </div>
  );
}

const TODO_HINTS = [
  { keys: ["j", "k"], action: "move" },
  { keys: ["x"], action: "done" },
  { keys: ["o"], action: "open" },
  { keys: ["t"], action: "thread" },
  { keys: ["i"], action: "add" },
  { keys: ["T"], action: "board" },
  { keys: ["?"], action: "all keys" },
] as const;

function TodoSection({
  column,
  rows,
  offset,
  arrival,
  doneId,
  today,
  threads,
  onToggleDone,
  onOpen,
  onOpenThread,
}: {
  column: Column;
  rows: Ticket[];
  offset: number;
  arrival: (ticketId: string) => Arrival;
  doneId: string | null;
  today: string;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  onToggleDone: (ticket: Ticket) => void;
  onOpen: (ticket: Ticket) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const shown = usePresenceList(rows, (ticket) => ticket.id);
  const countPop = usePopOnChange(rows.length);
  return (
    <section aria-label={column.name}>
      <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {column.name}{" "}
        <span key={countPop.key} onAnimationEnd={countPop.onAnimationEnd} className={cn("inline-block font-normal tabular-nums", countPop.className)}>
          {rows.length}
        </span>
      </h2>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {shown.entries.map(({ key, item: ticket, exiting }, index) => (
          <TodoRow
            key={key}
            ticket={ticket}
            index={offset + index}
            arrival={arrival(ticket.id)}
            exiting={exiting}
            onExited={() => shown.onExited(key)}
            isDone={ticket.columnId === doneId}
            today={today}
            thread={ticket.threadId === null ? null : threads.get(ticket.threadId)}
            onToggleDone={() => onToggleDone(ticket)}
            onOpen={() => onOpen(ticket)}
            onOpenThread={onOpenThread}
          />
        ))}
      </ul>
    </section>
  );
}

function TodoRow({
  ticket,
  index,
  arrival,
  exiting,
  onExited,
  isDone,
  today,
  thread,
  onToggleDone,
  onOpen,
  onOpenThread,
}: {
  ticket: Ticket;
  index: number;
  arrival: Arrival;
  exiting: boolean;
  onExited: () => void;
  isDone: boolean;
  today: string;
  thread: PluginSidebarThread | null | undefined;
  onToggleDone: () => void;
  onOpen: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const entrance = useEntrance(arrival === "intro" ? cn(enter.rise, speed.fast, STAGGER) : arrival === "new" ? enter.rise : undefined);
  return (
    <li
      data-todo-row=""
      data-ticket-id={ticket.id}
      style={stagger(index)}
      aria-hidden={exiting || undefined}
      inert={exiting}
      onAnimationEnd={(event) => {
        if (exiting && event.target === event.currentTarget) onExited();
        else entrance.onAnimationEnd(event);
      }}
      className={cn("flex items-center gap-3 px-3 py-2 text-sm has-[[data-todo-open]:focus-visible]:bg-state-hover", ticket.parentId !== null && "pl-9", exiting ? exit.sink : entrance.className)}
    >
      <Checkbox checked={isDone} onCheckedChange={onToggleDone} aria-label={isDone ? `Reopen "${ticket.title}"` : `Mark "${ticket.title}" done`} />
      <button type="button" data-todo-open="" onClick={onOpen} className={cn("min-w-0 flex-1 truncate text-left outline-none hover:underline", isDone && "text-muted-foreground line-through")}>
        {ticket.title}
      </button>
      <div className="hidden flex-wrap items-center gap-1 sm:flex">
        <PrBadges ticket={ticket} />
        <JiraBadges ticket={ticket} />
        <DueBadge ticket={ticket} today={today} isDone={isDone} />
        <TagBadges tags={ticket.tags} />
        <ReviewBadge ticket={ticket} />
      </div>
      {ticket.threadId !== null ? (
        <button
          type="button"
          aria-label="Open thread"
          onClick={() => onOpenThread(ticket.threadId!)}
          className="flex shrink-0 items-center gap-1.5 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <ThreadStatusDot thread={thread} />
          <Icon name="MessageSquare" className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
}
