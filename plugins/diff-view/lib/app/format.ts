export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function relativeTime(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function shortSha(sha: string | null): string {
  return sha === null ? "?" : sha.slice(0, 7);
}

/** `1 file`, `3 files`; `nouns` for a noun that doesn't just take an s. */
export function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

/** Items grouped by their path, in the order each path first appears. */
export function groupByPath<T extends { path: string }>(items: Iterable<T>): Map<string, T[]> {
  const byPath = new Map<string, T[]>();
  for (const item of items) {
    const group = byPath.get(item.path);
    if (group === undefined) byPath.set(item.path, [item]);
    else group.push(item);
  }
  return byPath;
}
