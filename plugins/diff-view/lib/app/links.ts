import type { BlameLine, DiffFile, DiffResult, DiffSide } from "../types";
import { lineSpan, lineSpanLabel } from "../line-range";
import { lineOn, rowIndexOf, type Cursor, type NavRow } from "./keys/nav";

/** Lines `start`–`end` of one side of a file. */
export interface LineSpan {
  side: DiffSide;
  start: number;
  end: number;
}

type LinkDiff = Pick<DiffResult, "repo" | "baseSha" | "headSha">;
type LinkFile = Pick<DiffFile, "path" | "previousPath" | "status">;

/** The side a whole-file action reads: the old one only for a deleted file. */
export function fileSide(file: Pick<DiffFile, "status">): DiffSide {
  return file.status === "removed" ? "LEFT" : "RIGHT";
}

function sidePath(file: LinkFile, side: DiffSide): string {
  return side === "LEFT" ? (file.previousPath ?? file.path) : file.path;
}

/** A side that does not exist for the file: the old side of an added one, the new side of a deleted one. */
export function missingSide(file: Pick<DiffFile, "status">, side: DiffSide): boolean {
  return (side === "LEFT" && file.status === "added") || (side === "RIGHT" && file.status === "removed");
}

/** The GitHub blob permalink for a file (or its lines) at the side's commit; null without a repo or that commit. */
export function githubFileUrl(diff: LinkDiff, file: LinkFile, span: LineSpan | null): string | null {
  const side = span?.side ?? fileSide(file);
  const sha = side === "LEFT" ? diff.baseSha : diff.headSha;
  if (diff.repo === null || sha === null || missingSide(file, side)) return null;
  const path = sidePath(file, side).split("/").map(encodeURIComponent).join("/");
  const anchor = span === null ? "" : span.end > span.start ? `#L${span.start}-L${span.end}` : `#L${span.start}`;
  return `https://github.com/${diff.repo}/blob/${sha}/${path}${anchor}`;
}

/** What `yl` copies: the GitHub permalink when there is one, else `path:L10-14`. */
export function fileLink(diff: LinkDiff, file: LinkFile, span: LineSpan | null): string {
  const url = githubFileUrl(diff, file, span);
  if (url !== null) return url;
  if (span === null) return sidePath(file, fileSide(file));
  return `${sidePath(file, span.side)}:${lineSpanLabel(span.start, span.end)}${span.side === "LEFT" ? " (old side)" : ""}`;
}

export function githubCommitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}

/**
 * The cursor's line, or with a `V` selection in its file, the selection's lines on the cursor's side (a selection
 * across both sides is read on one). Null on a file header.
 */
export function cursorSpan(rows: readonly NavRow[] | null, cursor: Cursor, visual: Cursor | null): LineSpan | null {
  if (cursor.line === null) return null;
  const single: LineSpan = { side: cursor.side, start: cursor.line, end: cursor.line };
  if (rows === null || visual === null || visual.path !== cursor.path || visual.line === null) return single;
  const from = rowIndexOf(rows, visual.side, visual.line);
  const to = rowIndexOf(rows, cursor.side, cursor.line);
  if (from === -1 || to === -1) return single;
  const lines = rows
    .slice(Math.min(from, to), Math.max(from, to) + 1)
    .map((row) => lineOn(row, cursor.side))
    .filter((line): line is number => line !== null);
  return lines.length === 0 ? single : { side: cursor.side, start: Math.min(...lines), end: Math.max(...lines) };
}

/** The lines of a patch's first hunk, on the new side unless the hunk only deletes; null without a hunk. */
export function firstHunkSpan(patch: string | null): LineSpan | null {
  const header = patch === null ? null : /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/mu.exec(patch);
  if (header === null || header === undefined) return null;
  const newCount = header[4] === undefined ? 1 : Number.parseInt(header[4], 10);
  const oldCount = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
  if (newCount > 0) {
    const start = Number.parseInt(header[3]!, 10);
    return { side: "RIGHT", start, end: start + newCount - 1 };
  }
  if (oldCount === 0) return null;
  const start = Number.parseInt(header[1]!, 10);
  return { side: "LEFT", start, end: start + oldCount - 1 };
}

/** One commit of a blame, with the lines it last changed. */
export interface BlameCommit {
  sha: string;
  author: string;
  time: number;
  summary: string;
  lines: number[];
}

/** Blame lines grouped by commit, in the order their first line appears. */
export function blameCommits(lines: readonly BlameLine[]): BlameCommit[] {
  const bySha = new Map<string, BlameCommit>();
  for (const entry of [...lines].sort((a, b) => a.line - b.line)) {
    const commit = bySha.get(entry.sha) ?? { sha: entry.sha, author: entry.author, time: entry.time, summary: entry.summary, lines: [] };
    commit.lines.push(entry.line);
    bySha.set(entry.sha, commit);
  }
  return [...bySha.values()];
}

/** `L10-12, 14` for sorted line numbers. */
export function lineRuns(lines: readonly number[]): string {
  const runs: string[] = [];
  let start = lines[0];
  for (let index = 1; index <= lines.length; index++) {
    const previous = lines[index - 1]!;
    if (index < lines.length && lines[index] === previous + 1) continue;
    runs.push(lineSpan(start!, previous));
    start = lines[index];
  }
  return runs.length === 0 ? "" : `L${runs.join(", ")}`;
}

/** Opens a link in a new tab that can't reach back into bb's window. */
export function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
