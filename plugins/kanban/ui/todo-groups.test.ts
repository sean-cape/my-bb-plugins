import { describe, expect, it } from "vitest";
import type { Ticket } from "../shared/board";
import { todoGroups } from "./todo-groups";

const today = "2026-11-03";
let position = 0;
const card = (id: string, fields: Partial<Ticket> = {}): Ticket =>
  ({ id, columnId: "todo", dueDate: null, priority: null, parentId: null, position: (position += 1), createdAt: 0, ...fields }) as Ticket;
const columns = [
  { id: "todo", name: "To Do" },
  { id: "done", name: "Done" },
];
const shape = (groups: ReturnType<typeof todoGroups>) => groups.map((group) => [group.name, group.rows.map((row) => row.id)]);

describe("todoGroups", () => {
  const tickets = [
    card("later", { dueDate: "2026-11-20" }),
    card("plain"),
    card("late", { dueDate: "2026-11-01" }),
    card("urgent-later", { dueDate: "2026-11-30", priority: 1 }),
    card("now", { dueDate: today }),
    card("sub", { parentId: "plain", dueDate: today }),
    card("finished", { columnId: "done", dueDate: "2026-10-01" }),
  ];

  it("sorts by when it's due, most urgent first, done last, subtasks under their parent", () => {
    expect(shape(todoGroups(tickets, () => true, "due", columns, today, "done"))).toEqual([
      ["Overdue", ["late"]],
      ["Today", ["now"]],
      ["Upcoming", ["urgent-later", "later"]],
      ["No date", ["plain", "sub"]],
      ["Done", ["finished"]],
    ]);
  });

  it("groups by column on request, and a subtask whose parent is filtered out stands on its own", () => {
    expect(shape(todoGroups(tickets, (ticket) => ticket.id !== "plain", "column", columns, today, "done"))).toEqual([
      ["To Do", ["urgent-later", "late", "now", "sub", "later"]],
      ["Done", ["finished"]],
    ]);
  });
});
