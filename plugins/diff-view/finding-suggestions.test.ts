import { describe, expect, it } from "vitest";
import type { InlineFinding } from "./lib/app/findings/findings";
import { REVIEW_KEYMAP } from "./lib/app/keys/keymap";
import type { Cursor, NavRow } from "./lib/app/keys/nav";
import { runReviewCommand, type FindingAnchor } from "./lib/app/keys/review-commands";
import type { FileNavModel } from "./lib/app/keys/review-keys-context";
import { NO_SUGGESTIONS, type SuggestionActions } from "./lib/app/suggestions/actions";
import { findingSuggestion, findingSuggestionBody, findingSuggestionId, findingSuggestionRange, parseFindingSuggestionId, type FindingSuggestionState } from "./lib/app/suggestions/finding-suggestion";
import type { LinesAt } from "./lib/app/suggestions/thread-suggestion";
import { suggestionBlocks } from "./lib/suggestions";
import type { Finding, FindingSuggestion, SuggestionItem } from "./lib/types";
import { reviewEnv } from "./test-helpers";

const file = ["one", "two", "three"];
const linesAt: LinesAt = (path, start, end) => (path !== "a.ts" || end > file.length ? null : file.slice(start - 1, end));

function inline(suggestion: FindingSuggestion | null, overrides: Partial<Finding> = {}): InlineFinding {
  const finding: Finding = {
    id: "F1",
    severity: "important",
    title: "Off by one",
    description: "The loop stops early.",
    fix: "Use <=",
    locations: [{ file: "a.ts", startLine: 2, endLine: 3 }],
    importance: null,
    scopeFit: null,
    suggestion,
    ...overrides,
  };
  return { reviewId: "r1", finding, selected: true, overridden: false, edited: false, isNew: false, carriedFrom: null, touched: false };
}

const suggestion: FindingSuggestion = { file: "a.ts", startLine: 2, endLine: 3, replacement: "TWO\nTHREE" };

describe("findingSuggestion", () => {
  it("names the finding in the item's id, read back to mark it applied", () => {
    expect(findingSuggestionId("r1", "F1")).toBe("finding:r1/F1");
    expect(parseFindingSuggestionId("finding:r1/F1")).toEqual({ reviewId: "r1", findingId: "F1" });
    expect(parseFindingSuggestionId("review-comment:12")).toBeNull();
    expect(parseFindingSuggestionId("finding:r1")).toBeNull();
  });

  it("applies over the lines the diff shows today; an empty replacement deletes them", () => {
    expect(findingSuggestion(inline(null), linesAt)).toBeNull();
    expect(findingSuggestion(inline(suggestion), linesAt)?.item).toEqual({ id: "finding:r1/F1", path: "a.ts", startLine: 2, endLine: 3, expected: ["two", "three"], replacement: ["TWO", "THREE"] });
    expect(findingSuggestion(inline({ ...suggestion, replacement: "" }), linesAt)?.item?.replacement).toEqual([]);
  });

  it("says why it can't apply: applied this session, already in the code, lines outside the diff", () => {
    expect(findingSuggestion(inline(suggestion), linesAt, new Set(["finding:r1/F1"]))).toMatchObject({ item: null, applied: true });
    expect(findingSuggestion(inline({ ...suggestion, replacement: "two\nthree" }), linesAt)).toMatchObject({ item: null, applied: true, reason: "Already applied" });
    expect(findingSuggestion(inline({ ...suggestion, endLine: 9 }), linesAt)).toMatchObject({ item: null, applied: false, current: null });
  });

  it("posts as the finding's title and description over a suggestion block on its lines", () => {
    const body = findingSuggestionBody(inline(suggestion).finding, suggestion);
    expect(body.startsWith("**Off by one**\n\nThe loop stops early.\n\n")).toBe(true);
    expect(suggestionBlocks(body)).toEqual([["TWO", "THREE"]]);
    expect(findingSuggestionRange(suggestion)).toEqual({ line: 3, side: "RIGHT", startLine: 2, startSide: "RIGHT" });
    expect(findingSuggestionRange({ ...suggestion, endLine: 2 })).toEqual({ line: 2, side: "RIGHT", startLine: null, startSide: null });
  });
});

describe("finding suggestion keys", () => {
  it("binds gs", () => {
    expect(REVIEW_KEYMAP.gs).toEqual({ kind: "postSuggestion" });
  });

  const rows: NavRow[] = [1, 2, 3].map((n) => ({ left: n, right: n, hunk: 0, changed: false }));
  const at: Cursor = { path: "a.ts", side: "RIGHT", line: 2, want: "RIGHT" };
  const run = (command: Parameters<typeof runReviewCommand>[0], item: InlineFinding, suggestions: Partial<SuggestionActions>) => {
    const anchor: FindingAnchor = { id: "r1:F1:2", path: "a.ts", side: "RIGHT", line: 2, item };
    const calls: unknown[] = [];
    const models = new Map<string, FileNavModel>([["a.ts", { rows, cutToHunk: false, element: () => null }]]);
    const { env } = reviewEnv(
      {
        files: [{ path: "a.ts", collapsed: false, rows }],
        findings: [anchor],
        notify: (message: string) => calls.push(["notify", message]),
        suggestions: { ...NO_SUGGESTIONS, forFinding: (entry: InlineFinding) => findingSuggestion(entry, linesAt), ...suggestions },
      },
      { cursor: at, focused: { kind: "finding", id: anchor.id }, models },
    );
    runReviewCommand(command, 1, env);
    return calls;
  };

  it("A applies the finding's suggestion, B batches it", () => {
    const applied: SuggestionItem[][] = [];
    const batched: SuggestionItem[] = [];
    const actions = { apply: async (items: SuggestionItem[]) => void applied.push(items), toggleBatch: (entry: SuggestionItem) => (batched.push(entry), true) };
    expect(run({ kind: "applySuggestion" }, inline(suggestion), actions)).toEqual([]);
    expect(applied.map((items) => items.map((entry) => entry.id))).toEqual([["finding:r1/F1"]]);
    expect(run({ kind: "batchSuggestion" }, inline(suggestion), actions)).toEqual([["notify", "Added to the batch (1; gB applies it)"]]);
    expect(batched.map((entry) => entry.id)).toEqual(["finding:r1/F1"]);
    expect(run({ kind: "applySuggestion" }, inline(null), actions)).toEqual([["notify", "This finding has no suggested change"]]);
  });

  it("gs posts it to the pull request once, and only where comments can go there", () => {
    const posts: FindingSuggestionState[] = [];
    const post = async (_item: InlineFinding, state: FindingSuggestionState) => void posts.push(state);
    expect(run({ kind: "postSuggestion" }, inline(suggestion), { post })).toEqual([]);
    expect(posts.map((state) => state.id)).toEqual(["finding:r1/F1"]);
    expect(run({ kind: "postSuggestion" }, inline(suggestion), { post, posted: new Set(["finding:r1/F1"]) })).toEqual([["notify", "Already posted as a draft on the pull request"]]);
    expect(run({ kind: "postSuggestion" }, inline(suggestion), {})).toEqual([["notify", "Suggestions post to a pull request, and this view has none"]]);
    expect(run({ kind: "postSuggestion" }, inline({ ...suggestion, endLine: 9 }), { post })[0]).toEqual(["notify", "The diff doesn't show all of the suggestion's lines, so GitHub can't take a comment on them"]);
  });
});
