import type { Column, Ticket } from "../shared/board";
import { byPriority } from "./format";

export type TodoGrouping = "due" | "column";

export interface TodoGroup {
  id: string;
  name: string;
  rows: Ticket[];
}

const DUE_GROUPS = [
  { id: "overdue", name: "Overdue" },
  { id: "today", name: "Today" },
  { id: "upcoming", name: "Upcoming" },
  { id: "no-date", name: "No date" },
  { id: "done", name: "Done" },
] as const;

function dueGroup(ticket: Ticket, today: string, doneId: string | null): (typeof DUE_GROUPS)[number]["id"] {
  if (ticket.columnId === doneId) return "done";
  if (ticket.dueDate === null) return "no-date";
  return ticket.dueDate < today ? "overdue" : ticket.dueDate === today ? "today" : "upcoming";
}

const byPosition = (a: Ticket, b: Ticket) => a.position - b.position || a.createdAt - b.createdAt;
const byUrgency = (a: Ticket, b: Ticket) => byPriority(a, b) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || byPosition(a, b);

/**
 * The todo list's sections: by when each card is due (done ones last), or by column, most urgent first within each.
 * A subtask follows its parent when the parent is listed, whatever its own date, and stands on its own otherwise.
 */
export function todoGroups(tickets: readonly Ticket[], listed: (ticket: Ticket) => boolean, grouping: TodoGrouping, columns: readonly Column[], today: string, doneId: string | null): TodoGroup[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const heads = tickets.filter((ticket) => listed(ticket) && (ticket.parentId === null || !byId.has(ticket.parentId) || !listed(byId.get(ticket.parentId)!)));
  const childrenOf = (id: string) => tickets.filter((ticket) => ticket.parentId === id && listed(ticket)).sort(byPosition);
  const sections: readonly { id: string; name: string }[] = grouping === "due" ? DUE_GROUPS : columns;
  const sectionOf = (ticket: Ticket) => (grouping === "due" ? dueGroup(ticket, today, doneId) : ticket.columnId);
  return sections
    .map((section) => ({
      id: section.id,
      name: section.name,
      rows: heads
        .filter((ticket) => sectionOf(ticket) === section.id)
        .sort(byUrgency)
        .flatMap((ticket) => [ticket, ...childrenOf(ticket.id)]),
    }))
    .filter((group) => group.rows.length > 0);
}
