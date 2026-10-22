// Suggested changes: GitHub's ```suggestion blocks in comment bodies, the lines they replace, and applying them to a
// file's text. Pure, shared by the view and every host's server.
import type { LineRange, SuggestionItem } from "./types";

/** A comment body cut into Markdown and the suggestion blocks between it. */
export type CommentBodyPart = { kind: "markdown"; text: string } | { kind: "suggestion"; lines: string[] };

const OPENING = /^ {0,3}(`{3,}|~{3,})[ \t]*suggestion[ \t]*$/u;

/** The body's suggestion blocks in order, with the Markdown around them. A block left open runs to the end, as on GitHub. */
export function parseCommentBody(body: string): CommentBodyPart[] {
  return scanCommentBody(body).parts;
}

/**
 * A comment body as it is saved: without its leading and trailing blank lines. A suggestion block left open runs to
 * the end, so then everything after its fence is the suggestion's text and the end is kept as typed.
 */
export function trimCommentBody(body: string): string {
  const lines = body.split("\n");
  const blank = (line: string | undefined) => line !== undefined && line.trim() === "";
  let start = 0;
  while (blank(lines[start])) start += 1;
  let end = lines.length;
  if (!scanCommentBody(body).open) while (end > start && blank(lines[end - 1])) end -= 1;
  return lines.slice(start, end).join("\n");
}

function scanCommentBody(body: string): { parts: CommentBodyPart[]; open: boolean } {
  const parts: CommentBodyPart[] = [];
  let markdown: string[] = [];
  let block: { fence: string; lines: string[] } | null = null;
  const flushMarkdown = () => {
    const text = markdown.join("\n");
    if (text.trim() !== "") parts.push({ kind: "markdown", text });
    markdown = [];
  };
  for (const raw of body.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (block !== null) {
      const closing = line.trim();
      if (closing.length >= block.fence.length && closing === block.fence[0]!.repeat(closing.length)) {
        parts.push({ kind: "suggestion", lines: block.lines });
        block = null;
      } else block.lines.push(line);
      continue;
    }
    const opening = OPENING.exec(line);
    if (opening !== null) {
      flushMarkdown();
      block = { fence: opening[1]!, lines: [] };
    } else markdown.push(line);
  }
  if (block !== null) parts.push({ kind: "suggestion", lines: block.lines });
  else flushMarkdown();
  return { parts, open: block !== null };
}

/** Every suggestion block's lines; the first is the one that applies. */
export function suggestionBlocks(body: string): string[][] {
  return parseCommentBody(body).flatMap((part) => (part.kind === "suggestion" ? [part.lines] : []));
}

/** A suggestion block replacing the lines with `lines`; the fence outgrows any backtick run inside them. */
export function suggestionBlock(lines: readonly string[]): string {
  const longest = Math.max(2, ...lines.map((line) => Math.max(0, ...(line.match(/`+/gu) ?? []).map((run) => run.length))));
  const fence = "`".repeat(longest + 1);
  return [`${fence}suggestion`, ...lines, fence].join("\n");
}

/** Where the caret goes in a body that is just `suggestionBlock(lines)`: the end of its last line. */
export function suggestionCaret(block: string): number {
  return block.lastIndexOf("\n");
}

/** The new-side lines a comment range covers, when it sits on the new side only; null for the old side or a whole file. */
export function suggestionLines(range: LineRange): { startLine: number; endLine: number } | null {
  if (range.line === null || range.side !== "RIGHT") return null;
  if (range.startLine === null) return { startLine: range.line, endLine: range.line };
  if ((range.startSide ?? range.side) !== "RIGHT") return null;
  return { startLine: Math.min(range.startLine, range.line), endLine: Math.max(range.startLine, range.line) };
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Every new-side line a unified patch shows (added and context), by line number. A hunk ends where its new-side count
 * says, so the empty string after a patch's final newline is not a line. A hunk cut short (GitHub's `diff_hunk`) reads
 * as far as it goes.
 */
export function newSideLineMap(patch: string): Map<number, string> {
  const found = new Map<number, string>();
  let next: number | null = null;
  let left = 0;
  for (const text of patch.split("\n")) {
    const header = HUNK_HEADER.exec(text);
    if (header !== null) {
      next = Number(header[1]);
      left = header[2] === undefined ? 1 : Number(header[2]);
      continue;
    }
    if (next === null || left <= 0 || text.startsWith("\\") || text.startsWith("-")) continue;
    if (text.startsWith("+") || text.startsWith(" ") || text === "") {
      const line = text.slice(1);
      found.set(next, line.endsWith("\r") ? line.slice(0, -1) : line);
      next += 1;
      left -= 1;
    }
  }
  return found;
}

/** Lines `start`–`end` of a `newSideLineMap`; null when any is missing. */
export function linesFromMap(map: ReadonlyMap<number, string>, start: number, end: number): string[] | null {
  const lines: string[] = [];
  for (let line = start; line <= end; line++) {
    const text = map.get(line);
    if (text === undefined) return null;
    lines.push(text);
  }
  return lines;
}

/** New-side lines `start`–`end` as a unified patch shows them; null when the patch leaves any of them out. */
export function newSideLines(patch: string, start: number, end: number): string[] | null {
  return linesFromMap(newSideLineMap(patch), start, end);
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => b[index] === line);
}

/**
 * Whether a suggestion over `rangeLength` lines already landed, from the lines today: `current`, the range itself, and
 * `atReplacement`, as many lines from the range's first as the replacement has. When those read as the replacement
 * and the range no longer reads as `original` (the lines it was written against), it landed. Otherwise a replacement
 * shorter than the range reads the same either way (it keeps the range's first lines and drops the rest), so only the
 * session's record of applies can say; a deletion leaves nothing to recognise at all.
 */
export function suggestionLanded({
  rangeLength,
  current,
  atReplacement,
  replacement,
  original,
}: {
  rangeLength: number;
  current: readonly string[] | null;
  atReplacement: readonly string[] | null;
  replacement: readonly string[];
  original: readonly string[] | null;
}): boolean {
  if (replacement.length === 0 || current === null || atReplacement === null || !sameLines(atReplacement, replacement)) return false;
  // The range no longer reading as it was is proof; still reading so is not, since a replacement that keeps the
  // range's lines and adds after them leaves the range itself as it was.
  if (original !== null && original.length === rangeLength && !sameLines(current, original)) return true;
  return replacement.length >= rangeLength;
}

/** Why the server refused a batch: the items whose lines moved or overlap, by path and lines. */
export class SuggestionConflictError extends Error {}

function label(item: Pick<SuggestionItem, "path" | "startLine" | "endLine">): string {
  return `${item.path}:${item.startLine === item.endLine ? `L${item.startLine}` : `L${item.startLine}-${item.endLine}`}`;
}

function lineEnding(piece: string): string {
  return piece.endsWith("\r\n") ? "\r\n" : piece.endsWith("\n") ? "\n" : "";
}

/** Whether the lines just around an item's range still read as the diff showed them, where it sent them. */
function contextMatches(item: SuggestionItem, lines: readonly string[]): boolean {
  const before = item.before ?? [];
  const after = item.after ?? [];
  const from = item.startLine - 1 - before.length;
  if (from < 0 || item.endLine + after.length > lines.length) return false;
  return before.every((line, offset) => lines[from + offset] === line) && after.every((line, offset) => lines[item.endLine + offset] === line);
}

/**
 * The file's text with every item applied, checked first against the text as it is: an item whose `expected` lines
 * (or the lines around them it carries) no longer match, that runs past the file's end or overlaps another throws,
 * naming its path and lines, and nothing is applied. Every line keeps its own ending; the lines put in take the ending
 * of the first line they replace, the last of them that of the last.
 */
export function applySuggestionsToText(text: string, items: readonly SuggestionItem[]): string {
  const pieces = text.split(/(?<=\n)/u);
  const lines = pieces.map((piece) => piece.slice(0, piece.length - lineEnding(piece).length));
  const endings = pieces.map(lineEnding);
  const sorted = [...items].sort((a, b) => a.startLine - b.startLine);
  const problems: string[] = [];
  sorted.forEach((item, index) => {
    const previous = sorted[index - 1];
    if (!Number.isInteger(item.startLine) || !Number.isInteger(item.endLine) || item.startLine < 1 || item.endLine < item.startLine) problems.push(`${label(item)} is not a range of lines`);
    else if (item.endLine > lines.length) problems.push(`${label(item)} runs past the file's ${lines.length} lines`);
    else if (previous !== undefined && item.startLine <= previous.endLine) problems.push(`${label(item)} overlaps ${label(previous)}`);
    else if (item.expected.length !== item.endLine - item.startLine + 1 || item.expected.some((line, offset) => lines[item.startLine - 1 + offset] !== line) || !contextMatches(item, lines)) problems.push(`${label(item)} changed since the suggestion was made`);
  });
  if (problems.length > 0) throw new SuggestionConflictError(`Not applied: ${problems.join("; ")}. Refresh and try again.`);
  // Bottom up, so each splice leaves the line numbers above it alone.
  for (const item of sorted.reverse()) {
    const start = item.startLine - 1;
    const count = item.endLine - item.startLine + 1;
    const first = endings[start]!;
    const last = endings[start + count - 1]!;
    // Only the file's unterminated last line has no ending; lines put in ahead of it end as the line above does.
    const inner = first !== "" ? first : endings[start - 1] || "\n";
    lines.splice(start, count, ...item.replacement);
    endings.splice(start, count, ...item.replacement.map((_, offset) => (offset === item.replacement.length - 1 ? last : inner)));
    // Deleting the unterminated last line leaves the one above it last, still without a final newline.
    if (item.replacement.length === 0 && last === "" && start > 0) endings[start - 1] = "";
  }
  return lines.map((line, index) => line + endings[index]).join("");
}

/** A file's bytes as text; refused unless they are UTF-8, since writing other bytes back as text would garble them. */
export function suggestionFileText(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SuggestionConflictError(`Not applied: ${path} is not UTF-8 text`);
  }
}

/** Items grouped by file, in the order their files first appear. */
export function suggestionsByPath(items: readonly SuggestionItem[]): Map<string, SuggestionItem[]> {
  const byPath = new Map<string, SuggestionItem[]>();
  for (const item of items) byPath.set(item.path, [...(byPath.get(item.path) ?? []), item]);
  return byPath;
}

/** The commit message when the reviewer gives none, as GitHub words it. */
export function defaultSuggestionMessage(count: number): string {
  return count === 1 ? "Apply suggestion from code review" : "Apply suggestions from code review";
}

/** The line a message to an agent carries when a comment holds a suggestion block. */
export const SUGGESTION_NOTE = "A ```suggestion block in a comment is the exact replacement text for the lines that comment is on.";

export function mentionsSuggestion(bodies: Iterable<string>): boolean {
  for (const body of bodies) if (suggestionBlocks(body).length > 0) return true;
  return false;
}
