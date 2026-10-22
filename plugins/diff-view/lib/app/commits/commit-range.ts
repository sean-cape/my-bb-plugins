// Picking part of a diff's history: the picker's rows, the range each row stands for, and how a range is named.
import { WORKTREE_SHA, type CommitRange, type DiffCommits, type DiffSide, type LineRange } from "../../types";
import type { Keymap } from "../ui/vim-keys-core";

export type CommitRow = { kind: "all" } | { kind: "mark"; sha: string; label: string } | { kind: "commit"; index: number };

/** The picker's own keys, on top of its list motions: start a range on the highlighted commit. */
export const COMMIT_PICKER_KEYMAP: Keymap<"mark"> = { "<Space>": "mark", x: "mark" };

export function headOf(commits: DiffCommits): string | null {
  return commits.commits.at(-1)?.sha ?? null;
}

export function rangeKey(range: CommitRange | null): string {
  return range === null ? "all" : `${range.from}..${range.to}`;
}

export function shortCommit(sha: string): string {
  return sha === WORKTREE_SHA ? "Uncommitted" : sha.slice(0, 7);
}

/** All changes, then each mark (but one at the head, which would read as nothing), then each commit oldest first. */
export function pickerRows(commits: DiffCommits): CommitRow[] {
  const head = headOf(commits);
  const marks = commits.marks.filter((mark) => mark.sha !== head);
  return [{ kind: "all" }, ...marks.map((mark): CommitRow => ({ kind: "mark", ...mark })), ...commits.commits.map((_, index): CommitRow => ({ kind: "commit", index }))];
}

/** A range covering every commit is all the changes. */
export function normalizeRange(range: CommitRange, commits: DiffCommits): CommitRange | null {
  return range.from === commits.base && range.to === headOf(commits) ? null : range;
}

/** Commits `a` through `b` (either order) as a range; undefined when the first commit's parent is unknown. */
export function commitsRange(commits: DiffCommits, a: number, b: number): CommitRange | null | undefined {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  const to = commits.commits[high]?.sha;
  const from = low === 0 ? commits.base : (commits.commits[low - 1]?.sha ?? null);
  if (to === undefined || from === null) return undefined;
  return normalizeRange({ from, to }, commits);
}

/** From a mark to the head; undefined when there are no commits. */
export function markRange(commits: DiffCommits, sha: string): CommitRange | null | undefined {
  const head = headOf(commits);
  return head === null ? undefined : normalizeRange({ from: sha, to: head }, commits);
}

/**
 * Space (or `x`) on the picker's row `row`: the commit index a range starts at from now on, null to drop the start,
 * or undefined when the row is not a commit.
 */
export function toggledRangeStart(row: CommitRow | undefined, start: number | null): number | null | undefined {
  if (row?.kind !== "commit") return undefined;
  return start === row.index ? null : row.index;
}

/**
 * What Enter (or a click) on `row` picks, with a range started at commit `start`: All changes, a mark to the head, or
 * the commits from the start to the row (the row alone without one); undefined when the first commit's parent is unknown.
 */
export function pickedRange(commits: DiffCommits, row: CommitRow, start: number | null): CommitRange | null | undefined {
  if (row.kind === "all") return null;
  if (row.kind === "mark") return markRange(commits, row.sha);
  return commitsRange(commits, start ?? row.index, row.index);
}

/** Why a started range came out as something else: Enter on its own first commit, or a span of every commit. */
export function collapsedRangeNote(commits: DiffCommits, row: CommitRow, start: number | null): string | null {
  if (start === null || row.kind !== "commit") return null;
  if (row.index === start) return `Showing ${shortCommit(commits.commits[start]!.sha)} alone: Enter on another commit picks a range from it`;
  return commitsRange(commits, start, row.index) === null ? "Those are all the commits: showing all changes" : null;
}

/** Whether the range reads up to the head, where the new side's lines are the ones comments and findings sit on. */
export function rangeEndsAtHead(range: CommitRange | null, commits: DiffCommits | null): boolean {
  return range === null || (commits !== null && range.to === headOf(commits));
}

/** Indexes of the commits a range covers, `[first, last]`; null when it does not line up with the list. */
export function rangeSpan(range: CommitRange, commits: DiffCommits): [number, number] | null {
  const last = commits.commits.findIndex((commit) => commit.sha === range.to);
  const before = range.from === commits.base ? -1 : commits.commits.findIndex((commit) => commit.sha === range.from);
  if (last === -1 || (before === -1 && range.from !== commits.base) || before >= last) return null;
  return [before + 1, last];
}

/** What the summary bar calls the selection: All changes, a mark's name, one commit's short sha, or "3 commits". */
export function rangeLabel(range: CommitRange | null, commits: DiffCommits | null): string {
  if (range === null) return "All changes";
  if (commits !== null) {
    const mark = commits.marks.find((entry) => entry.sha === range.from && range.to === headOf(commits));
    if (mark !== undefined) return mark.label;
    const span = rangeSpan(range, commits);
    if (span !== null) return span[0] === span[1] ? shortCommit(range.to) : `${span[1] - span[0] + 1} commits`;
  }
  return `${shortCommit(range.from)}..${shortCommit(range.to)}`;
}

/**
 * What a range lets the view do. Comments, viewed marks, threads and findings sit on the head's new-side lines, which
 * only a range ending there shows; the narrative, the comments view and the delta read all the changes.
 */
export interface RangeGate {
  /** All the changes are shown. */
  whole: boolean;
  /** Findings show inline. */
  findings: boolean;
  /** The threads drawn inline: all of them, the new side's in a range ending at the head, else none. */
  threads<T extends { side: DiffSide }>(threads: T[]): T[];
  /** Why files can't be marked viewed; null when they can. */
  viewedRefusal: string | null;
  /** Why a comment can't start on these lines; null when it can. */
  commentRefusal(anchor: Pick<LineRange, "side" | "startSide">): string | null;
}

export function rangeGate(range: CommitRange | null, atHead: boolean): RangeGate {
  const whole = range === null;
  return {
    whole,
    findings: whole || atHead,
    threads: (threads) => (whole ? threads : atHead ? threads.filter((thread) => thread.side === "RIGHT") : []),
    viewedRefusal: whole || atHead ? null : "Switch to All changes to mark files viewed",
    commentRefusal: (anchor) => {
      if (whole || (atHead && anchor.side !== "LEFT" && anchor.startSide !== "LEFT")) return null;
      return atHead ? "In a range, comments go on the new side; switch to All changes to comment on old lines" : "Switch to All changes to comment";
    },
  };
}
