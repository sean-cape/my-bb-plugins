import type { Finding, FindingSuggestion, LineRange, SuggestionItem } from "../../types";
import { lineSpanLabel } from "../../line-range";
import { suggestionBlock } from "../../suggestions";
import type { InlineFinding } from "../findings/findings";
import { LINES_NOT_SHOWN, suggestionLandedAt, type LinesAt, type SuggestionState } from "./thread-suggestion";

const PREFIX = "finding:";

/** The `SuggestionItem` id of a finding's suggestion, which names the finding so applying it can mark it applied. */
export function findingSuggestionId(reviewId: string, findingId: string): string {
  return `${PREFIX}${reviewId}/${findingId}`;
}

export function parseFindingSuggestionId(id: string): { reviewId: string; findingId: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { reviewId: rest.slice(0, slash), findingId: rest.slice(slash + 1) };
}

/** The replacement's lines; an empty replacement deletes the lines rather than leaving one blank line. */
export function replacementLines(replacement: string): string[] {
  return replacement === "" ? [] : replacement.split("\n");
}

/** What `A`, `B` and `gs` act on in a finding: its suggestion, and whether it can be applied or posted now. */
export interface FindingSuggestionState extends SuggestionState {
  id: string;
  suggestion: FindingSuggestion;
}

export function findingSuggestion(item: InlineFinding, linesAt: LinesAt, appliedIds: ReadonlySet<string> = new Set()): FindingSuggestionState | null {
  const suggestion = item.finding.suggestion ?? null;
  if (suggestion === null) return null;
  const id = findingSuggestionId(item.reviewId, item.finding.id);
  const replacement = replacementLines(suggestion.replacement);
  const current = linesAt(suggestion.file, suggestion.startLine, suggestion.endLine);
  const found = { id, suggestion, replacement, current };
  // A review records only the replacement, not the lines it read, so a shrinking one is known applied by this session's record alone.
  const applied = appliedIds.has(id) || suggestionLandedAt(linesAt, { path: suggestion.file, startLine: suggestion.startLine, endLine: suggestion.endLine, replacement });
  if (applied) return { ...found, item: null, reason: "Already applied", applied: true };
  if (current === null) return { ...found, item: null, reason: LINES_NOT_SHOWN, applied: false };
  return {
    ...found,
    item: { id, path: suggestion.file, startLine: suggestion.startLine, endLine: suggestion.endLine, expected: current, replacement },
    reason: null,
    applied: false,
  };
}

/** The draft GitHub comment `gs` posts: the finding's title and description, then its suggestion block. */
export function findingSuggestionBody(finding: Pick<Finding, "title" | "description">, suggestion: FindingSuggestion): string {
  return [`**${finding.title}**`, finding.description.trim(), suggestionBlock(replacementLines(suggestion.replacement))].filter((part) => part !== "").join("\n\n");
}

/** The new-side lines the suggestion replaces, as a comment's range. */
export function findingSuggestionRange(suggestion: FindingSuggestion): LineRange {
  const single = suggestion.startLine === suggestion.endLine;
  return { line: suggestion.endLine, side: "RIGHT", startLine: single ? null : suggestion.startLine, startSide: single ? null : "RIGHT" };
}

/** `a.ts:L12` or `a.ts:L12-14`. */
export function findingSuggestionLabel(suggestion: FindingSuggestion): string {
  return `${suggestion.file}:${lineSpanLabel(suggestion.startLine, suggestion.endLine)}`;
}
