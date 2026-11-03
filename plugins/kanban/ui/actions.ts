import { useState } from "react";
import { toast } from "sonner";
import type { Ticket } from "../shared/board";
import type { TodoKeyCommand } from "./board-nav";
import type { Rpc } from "./data";
import { addDays, dueStatus, errorMessage, isSnoozed, nextWeekday } from "./format";

export function toastError(cause: unknown): void {
  toast.error(errorMessage(cause));
}

export type RunAction = (action: () => Promise<unknown>, successMessage?: string) => Promise<void>;

/** Board actions from a panel: `pending` while one runs, a toast for the outcome, then `onDone` to refresh. */
export function usePendingAction(onDone: () => void): { pending: boolean; run: RunAction } {
  const [pending, setPending] = useState(false);
  const run: RunAction = async (action, successMessage) => {
    setPending(true);
    try {
      await action();
      onDone();
      if (successMessage !== undefined) toast.success(successMessage);
    } catch (cause) {
      toastError(cause);
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}

/** The board's and the todo list's to-do keys: a priority, or a snooze that wakes a card already snoozed. */
export async function runTodoKey(rpc: Rpc, ticket: Ticket, command: TodoKeyCommand, today: string): Promise<void> {
  try {
    if (command.kind === "priority") {
      await rpc.call("ticket_set_priority", { id: ticket.id, priority: command.priority });
      toast.success(command.priority === null ? "Priority cleared" : `Priority ${command.priority}`, { description: ticket.title });
      return;
    }
    const until = isSnoozed(ticket, today) ? null : command.until === "tomorrow" ? addDays(today, 1) : nextWeekday(today, 1);
    await rpc.call("ticket_snooze", { id: ticket.id, until });
    toast.success(until === null ? "Awake" : `Snoozed until ${dueStatus(until, today).label}`, {
      description: ticket.title,
      ...(until === null ? {} : { action: { label: "Undo", onClick: () => void rpc.call("ticket_snooze", { id: ticket.id, until: null }).catch(toastError) } }),
    });
  } catch (cause) {
    toastError(cause);
  }
}
