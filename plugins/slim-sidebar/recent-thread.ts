/** Most recent first, distinct; two are enough to toggle between threads. */
export type RecentThreads = readonly string[];

const KEPT = 2;

export function recordThreadVisit(recent: RecentThreads, threadId: string | null): RecentThreads {
  if (threadId === null || recent[0] === threadId) return recent;
  return [threadId, ...recent.filter((id) => id !== threadId)].slice(0, KEPT);
}

/** From a thread, the one visited before it; from any other page, the last thread shown. */
export function returnTarget(recent: RecentThreads, currentThreadId: string | null): string | null {
  const target = currentThreadId !== null && recent[0] === currentThreadId ? recent[1] : recent[0];
  return target === undefined || target === currentThreadId ? null : target;
}

/** Kept across reloads; a bad or missing value starts an empty trail. */
export function loadRecentThreads(storage: Pick<Storage, "getItem"> | null, key: string): RecentThreads {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, KEPT) : [];
  } catch {
    return [];
  }
}
