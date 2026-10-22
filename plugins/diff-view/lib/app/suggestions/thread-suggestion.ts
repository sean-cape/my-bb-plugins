import type { SuggestionItem } from "../../types";
import { newSideLines, suggestionBlocks, suggestionLanded, suggestionLines } from "../../suggestions";
import type { DiffThread, ThreadEntry } from "../comments/threads";

/** Why a suggestion can't be applied or posted when the diff leaves some of its lines out. */
export const LINES_NOT_SHOWN = "The diff doesn't show all of the suggestion's lines";

/** New-side lines of a file as the diff shows them; null when it leaves any of them out. */
export type LinesAt = (path: string, startLine: number, endLine: number) => string[] | null;

/** What `A` and `B` act on in a suggestion, a thread's or a finding's, and whether it can be applied now. */
export interface SuggestionState {
  replacement: string[];
  /** What applying it sends; null when it cannot be applied, `reason` saying why. */
  item: SuggestionItem | null;
  reason: string | null;
  /** The lines already read as it would leave them, or it was applied this session. */
  applied: boolean;
  /** The lines it replaces as they read today; null when not known here. */
  current: string[] | null;
}

/**
 * Whether a suggestion over new-side lines `startLine`–`endLine` of `path` already landed, by the diff's lines today
 * and, where known, the lines it was written against (see `suggestionLanded`).
 */
export function suggestionLandedAt(linesAt: LinesAt, { path, startLine, endLine, replacement, original = null }: { path: string; startLine: number; endLine: number; replacement: readonly string[]; original?: readonly string[] | null }): boolean {
  return suggestionLanded({
    rangeLength: endLine - startLine + 1,
    current: linesAt(path, startLine, endLine),
    atReplacement: replacement.length === 0 ? null : linesAt(path, startLine, startLine + replacement.length - 1),
    replacement,
    original,
  });
}

/** The suggestion `A` and `B` act on in a thread: its latest comment holding one. */
export interface ThreadSuggestion extends SuggestionState {
  commentId: string;
  /** The first of the thread's lines, for numbering the drawn diff. */
  startLine: number | null;
}

/** The lines a thread's suggestions replace, as they read today; null when they are not today's new-side lines. */
export function threadCurrentLines(thread: DiffThread, linesAt: LinesAt): string[] | null {
  const range = thread.outdated ? null : suggestionLines(thread);
  return range === null ? null : linesAt(thread.path, range.startLine, range.endLine);
}

/** The new-side lines a synced GitHub comment was left on, from its `diff_hunk`; null when it doesn't say. */
function writtenAgainst(entry: ThreadEntry | undefined): string[] | null {
  if (entry?.source !== "github") return null;
  const { diffHunk, originalLine, originalStartLine, side, startSide } = entry.comment;
  if (diffHunk == null || originalLine == null || side !== "RIGHT" || (startSide ?? side) !== "RIGHT") return null;
  return newSideLines(diffHunk, originalStartLine ?? originalLine, originalLine);
}

export function threadSuggestion(thread: DiffThread, linesAt: LinesAt, appliedIds: ReadonlySet<string> = new Set()): ThreadSuggestion | null {
  let latest: { entry: ThreadEntry; replacement: string[] } | null = null;
  for (const entry of thread.entries) {
    const first = suggestionBlocks(entry.comment.body)[0];
    if (first !== undefined) latest = { entry, replacement: first };
  }
  if (latest === null) return null;
  const commentId = latest.entry.comment.id;
  const range = suggestionLines(thread);
  const expected = threadCurrentLines(thread, linesAt);
  const found = { commentId, replacement: latest.replacement, current: expected, startLine: range?.startLine ?? null };
  const landed =
    appliedIds.has(commentId) ||
    (range !== null &&
      !thread.outdated &&
      suggestionLandedAt(linesAt, { path: thread.path, ...range, replacement: found.replacement, original: writtenAgainst(latest.entry) ?? writtenAgainst(thread.entries[0]) }));
  const refuse = (reason: string): ThreadSuggestion => ({ ...found, item: null, reason, applied: landed });
  if (landed) return refuse("Already applied");
  if (thread.outdated) return refuse("The thread is outdated: its lines changed since");
  if (thread.resolved === true) return refuse("The thread is resolved");
  if (range === null) return refuse("Suggestions replace lines on the new side");
  if (expected === null) return refuse(LINES_NOT_SHOWN);
  return { ...found, item: { id: commentId, path: thread.path, startLine: range.startLine, endLine: range.endLine, expected, replacement: found.replacement }, reason: null, applied: false };
}
