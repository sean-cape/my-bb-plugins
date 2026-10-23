import { useEffect, useState } from "react";
import type { ConversationEvent } from "../../types";
import { errorMessage } from "../format";
import type { DiffSource } from "../source";

const NO_EVENTS: ConversationEvent[] = [];

/**
 * The source's conversation events, read the first time the conversation opens and again on each refresh while it is
 * open; what was read stays shown while a refresh runs, and through a failed one.
 */
export function useConversationEvents(source: DiffSource, refreshSignal: unknown, open: boolean): { events: ConversationEvent[]; error: string | null } {
  const [events, setEvents] = useState<ConversationEvent[]>(NO_EVENTS);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || source.conversation === undefined) return;
    let current = true;
    source.conversation().then(
      (next) => {
        if (!current) return;
        setEvents(next);
        setError(null);
      },
      (cause: unknown) => {
        if (current) setError(errorMessage(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [source, refreshSignal, open]);
  return { events, error };
}
