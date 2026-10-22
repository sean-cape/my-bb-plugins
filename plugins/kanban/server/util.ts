import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export const USER_AGENT = "bb-plugin-kanban";

const THREAD_TITLE_MAX_LENGTH = 200;

/** Ids for cards, reviews and comments: short enough to type in `bb kanban` commands. */
export function shortId(): string {
  return randomUUID().slice(0, 8);
}

export function threadTitle(title: string): string {
  return title.slice(0, THREAD_TITLE_MAX_LENGTH);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A JSON array of strings stored in a TEXT column (tags, comment ids, ticket ids); anything else reads as empty. */
export function parseStringArray(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Work run one at a time per key (a card), in the order queued. */
export function createKeyedQueue() {
  const queues = new Map<string, Promise<unknown>>();
  /** Runs `work` after everything queued for `key`; a failure is the caller's and never blocks the next item. */
  function enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  }
  /** Resolves once everything queued for `key` so far is done. */
  function settled(key: string): Promise<void> {
    return (queues.get(key) ?? Promise.resolve()).then(() => undefined);
  }
  return { enqueue, settled };
}

export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ""))].sort();
}
