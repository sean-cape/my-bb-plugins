// Each thread's status, and the code the conversation draws it over. Pure, for the tests.
import { excerptPatch, type NarrativePatchFile, type NarrativeRef } from "../../narrative";
import { patchRows, rowKey } from "../text/patch-rows";
import { isUnsent, type DiffThread } from "./threads";

export type ThreadStatus = "open" | "resolved" | "outdated";

export function threadStatus(thread: DiffThread): ThreadStatus {
  if (thread.outdated) return "outdated";
  return thread.resolved === true ? "resolved" : "open";
}

/** Whether the files and narrative views draw a thread: an open one, or a resolved or outdated one holding an unsent reply. */
export function shownInline(thread: DiffThread): boolean {
  return threadStatus(thread) === "open" || thread.entries.some(isUnsent);
}

export function threadCounts(threads: readonly DiffThread[]): Record<ThreadStatus, number> {
  const counts = { open: 0, resolved: 0, outdated: 0 };
  for (const thread of threads) counts[threadStatus(thread)] += 1;
  return counts;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u;

/**
 * GitHub's `diff_hunk` keeps its hunk's header but stops at the commented line, so the header's counts promise rows
 * that are not there; renderers read the counts. This recounts each header from the rows that follow it.
 */
export function recountHunk(hunk: string): string | null {
  const out: string[] = [];
  let header: { index: number; oldStart: number; newStart: number; rest: string } | null = null;
  let oldCount = 0;
  let newCount = 0;
  const flush = () => {
    if (header !== null) out[header.index] = `@@ -${header.oldStart},${oldCount} +${header.newStart},${newCount} @@${header.rest}`;
  };
  for (const text of hunk.replace(/\n$/u, "").split("\n")) {
    const match = HUNK_HEADER.exec(text);
    if (match !== null) {
      flush();
      header = { index: out.length, oldStart: Number(match[1]), newStart: Number(match[2]), rest: match[3] ?? "" };
      oldCount = 0;
      newCount = 0;
      out.push(text);
      continue;
    }
    if (header === null) continue;
    out.push(text);
    if (text.startsWith("\\")) continue;
    if (text.startsWith("-")) oldCount += 1;
    else if (text.startsWith("+")) newCount += 1;
    else {
      oldCount += 1;
      newCount += 1;
    }
  }
  flush();
  return header === null ? null : out.join("\n");
}

const sideOf = (side: "LEFT" | "RIGHT"): NarrativeRef["side"] => (side === "LEFT" ? "old" : "new");

function refsFor(path: string, thread: Pick<DiffThread, "line" | "side" | "startLine" | "startSide">): NarrativeRef[] {
  if (thread.line === null) return [];
  if (thread.startLine === null || (thread.startSide ?? thread.side) === thread.side) {
    return [{ path, side: sideOf(thread.side), startLine: thread.startLine ?? thread.line, endLine: thread.line }];
  }
  return [
    { path, side: sideOf(thread.startSide!), startLine: thread.startLine, endLine: thread.startLine },
    { path, side: sideOf(thread.side), startLine: thread.line, endLine: thread.line },
  ];
}

/** How many rows of a run of only added (or only deleted) lines show either side of a thread's lines. */
const ONE_SIDED_WINDOW = 3;

/**
 * The refs widened to every change block they touch, so a thread on an added line shows the lines it replaced too
 * (an excerpt otherwise leaves unreferenced changes out). A block of only added or only deleted lines replaced
 * nothing, and can be a whole new file, so it widens by a few rows either side of the thread's lines instead.
 */
function withChangeBlocks(patch: string, refs: readonly NarrativeRef[]): NarrativeRef[] {
  const { rows } = patchRows(patch);
  const changed = (index: number) => rows[index] !== undefined && (rows[index]!.left === null || rows[index]!.right === null);
  const hits = (index: number) =>
    refs.some((ref) => {
      const line = ref.side === "old" ? rows[index]!.left : rows[index]!.right;
      const end = ref.endLine ?? ref.startLine;
      return line !== null && ref.startLine !== null && end !== null && line >= Math.min(ref.startLine, end) && line <= Math.max(ref.startLine, end);
    });
  const out = [...refs];
  for (let index = 0; index < rows.length; index++) {
    if (!changed(index) || !hits(index)) continue;
    let start = index;
    let stop = index;
    while (changed(start - 1) && rows[start - 1]!.hunk === rows[index]!.hunk) start -= 1;
    while (changed(stop + 1) && rows[stop + 1]!.hunk === rows[index]!.hunk) stop += 1;
    const block = rows.slice(start, stop + 1);
    if (block.every((row) => row.left === null) || block.every((row) => row.right === null)) {
      // Each run of the thread's lines gets its own window, so threads far apart in a new file don't show all between.
      let last = index;
      while (last < stop && hits(last + 1)) last += 1;
      start = Math.max(start, index - ONE_SIDED_WINDOW);
      stop = Math.min(stop, last + ONE_SIDED_WINDOW);
    }
    for (let at = start; at <= stop; at++) {
      const row = rows[at]!;
      const [side, line] = row.left !== null ? (["old", row.left] as const) : (["new", row.right!] as const);
      out.push({ path: refs[0]!.path, side, startLine: line, endLine: line });
    }
    index = stop;
  }
  return out;
}

function excerptFor(patch: string, refs: readonly NarrativeRef[]): string | null {
  return refs.length === 0 ? null : excerptPatch(patch, withChangeBlocks(patch, refs));
}

/**
 * A thread over its code in the conversation. `key` names the excerpt for the renderer and the keys:
 * `thread:<thread id>/<path>`, keeping the file's name last for the renderer's language. `placed` is the thread on a
 * line `patch` draws, or (a null line) under the header; actions find the thread itself by id.
 */
export interface ThreadCode {
  key: string;
  path: string;
  /** `stored` is the hunk GitHub kept when the comment was left; `current` is today's lines. */
  kind: "current" | "stored";
  patch: string | null;
  placed: DiffThread;
}

const atHeader = (thread: DiffThread): DiffThread => ({ ...thread, line: null, startLine: null, startSide: null });

/** A thread on a line the patch draws keeps it; otherwise it moves under the header, as a thread without code. */
function placeOn(patch: string | null, thread: DiffThread): DiffThread {
  if (thread.line === null) return thread;
  return patch !== null && patchRows(patch).at.has(rowKey(thread.side, thread.line)) ? thread : atHeader(thread);
}

/** A GitHub thread at the line it was left on, in the hunk GitHub stored; null when it stored none. */
function storedCode(thread: DiffThread, key: string): ThreadCode | null {
  const root = thread.entries[0]!;
  if (root.source !== "github" || root.comment.diffHunk == null) return null;
  const hunk = recountHunk(root.comment.diffHunk);
  if (hunk === null) return null;
  const line = root.comment.originalLine ?? root.comment.line;
  const startLine = root.comment.originalStartLine ?? root.comment.startLine;
  const placed: DiffThread = { ...thread, line, side: root.comment.side, startLine, startSide: startLine === null ? null : (root.comment.startSide ?? root.comment.side) };
  const patch = excerptFor(hunk, refsFor(thread.path, placed)) ?? hunk;
  return { key, path: thread.path, kind: "stored", patch, placed: placeOn(patch, placed) };
}

/**
 * The code a thread is shown over, as GitHub's conversation shows it: a GitHub thread over the hunk GitHub stored when
 * it was left, cut to the commented lines and a little context; a thread started here (or one GitHub stored no hunk
 * for) over the same excerpt of today's patch, or under its file's name when the diff doesn't show its lines.
 */
export function threadCode(thread: DiffThread, files: readonly NarrativePatchFile[]): ThreadCode {
  const key = `thread:${thread.id}/${thread.path}`;
  const stored = storedCode(thread, key);
  if (stored !== null) return stored;
  const filePatch = thread.outdated ? null : (files.find((file) => file.path === thread.path)?.patch ?? null);
  const patch = filePatch === null ? null : excerptFor(filePatch, refsFor(thread.path, thread));
  return { key, path: thread.path, kind: "current", patch, placed: placeOn(patch, thread) };
}
