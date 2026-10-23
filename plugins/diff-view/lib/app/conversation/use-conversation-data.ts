import { useEffect, useState } from "react";
import type { ConversationData } from "../../types";
import { errorMessage } from "../format";
import type { DiffSource } from "../source";

/**
 * The source's conversation data, read the first time the conversation opens and again on each refresh while it is
 * open; what was read stays shown while a refresh runs, and through a failed one.
 */
export function useConversationData(source: DiffSource, refreshSignal: unknown, open: boolean): { data: ConversationData | null; error: string | null } {
  const [data, setData] = useState<ConversationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || source.conversation === undefined) return;
    let current = true;
    source.conversation().then(
      (next) => {
        if (!current) return;
        setData(next);
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
  return { data, error };
}
