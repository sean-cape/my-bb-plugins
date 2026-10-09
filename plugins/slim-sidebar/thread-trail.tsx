import { useEffect } from "react";
import { useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { loadRecentThreads, recordThreadVisit, returnTarget, type RecentThreads } from "./recent-thread.js";

const STORAGE_KEY = "slim-sidebar:recent-threads";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// Commands run outside React, so the trail and the navigator live at module scope.
let recent: RecentThreads = loadRecentThreads(storage(), STORAGE_KEY);
let openThread: ((threadId: string) => void) | null = null;

/** Records each thread the route shows; mounted with the sidebar navigation on every viewport. */
export function ThreadTrail() {
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  useEffect(() => {
    const open = (id: string) => navigate.toThread(id);
    openThread = open;
    return () => {
      if (openThread === open) openThread = null;
    };
  }, [navigate]);
  useEffect(() => {
    const next = recordThreadVisit(recent, threadId);
    if (next === recent) return;
    recent = next;
    try {
      storage()?.setItem(STORAGE_KEY, JSON.stringify(recent));
    } catch {
      // A full or blocked storage only costs the trail across reloads.
    }
  }, [threadId]);
  return null;
}

export function canReturnToThread(currentThreadId: string | null): boolean {
  return openThread !== null && returnTarget(recent, currentThreadId) !== null;
}

export function returnToThread(currentThreadId: string | null): void {
  const target = returnTarget(recent, currentThreadId);
  if (target !== null) openThread?.(target);
}
