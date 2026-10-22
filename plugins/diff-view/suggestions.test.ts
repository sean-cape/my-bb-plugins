import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keymapConflicts, unboundHelpKeys } from "../vim-mode/lib/index.ts";
import { COMMENTS_KEY_HELP, COMMENTS_KEYMAP } from "./lib/app/comments/comments-keymap";
import type { DiffThread } from "./lib/app/comments/threads";
import { KEY_HELP, REVIEW_KEYMAP } from "./lib/app/keys/keymap";
import type { Cursor, NavRow } from "./lib/app/keys/nav";
import { runReviewCommand, type ReviewEnv } from "./lib/app/keys/review-commands";
import type { FileNavModel } from "./lib/app/keys/review-keys-context";
import { NO_SUGGESTIONS, type SuggestionActions } from "./lib/app/suggestions/actions";
import { threadSuggestion, type LinesAt } from "./lib/app/suggestions/thread-suggestion";
import { applySuggestionsInCheckout } from "./lib/server";
import { applySuggestionsToText, suggestionLanded, newSideLines, parseCommentBody, suggestionBlock, suggestionBlocks, suggestionCaret, suggestionLines } from "./lib/suggestions";
import type { DiffComment, SuggestionItem } from "./lib/types";
import { commentsMessage } from "./server";

const item = (startLine: number, endLine: number, expected: string[], replacement: string[], path = "a.ts"): SuggestionItem => ({ id: `c${startLine}`, path, startLine, endLine, expected, replacement });

describe("parseCommentBody", () => {
  it("cuts a body into Markdown and suggestion blocks, fences of any length, an open one running to the end", () => {
    expect(parseCommentBody("Try this:\n```suggestion\nconst a = 1;\n```\nthanks")).toEqual([
      { kind: "markdown", text: "Try this:" },
      { kind: "suggestion", lines: ["const a = 1;"] },
      { kind: "markdown", text: "thanks" },
    ]);
    expect(suggestionBlocks("````suggestion\n```\ncode\n```\n````")).toEqual([["```", "code", "```"]]);
    expect(suggestionBlocks("```suggestion\r\n\r\n```")).toEqual([[""]]);
    expect(suggestionBlocks("```suggestion\n```")).toEqual([[]]);
    expect(suggestionBlocks("```suggestion\nleft open")).toEqual([["left open"]]);
    expect(suggestionBlocks("```ts\nnot one\n```")).toEqual([]);
  });

  it("writes a block whose fence outgrows the lines' backticks, caret at the end of its last line", () => {
    const block = suggestionBlock(["a", "``` inner"]);
    expect(block).toBe("````suggestion\na\n``` inner\n````");
    expect(suggestionBlocks(block)).toEqual([["a", "``` inner"]]);
    expect(block.slice(0, suggestionCaret(block))).toBe("````suggestion\na\n``` inner");
  });
});

describe("suggestion lines", () => {
  const patch = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,4 @@", " one", "-two", "+TWO", "+two and a half", " three", "@@ -10,1 +11,1 @@", " ten"].join("\n");

  it("reads new-side lines from a patch, null when it leaves one out", () => {
    expect(newSideLines(patch, 2, 3)).toEqual(["TWO", "two and a half"]);
    expect(newSideLines(patch, 1, 4)).toEqual(["one", "TWO", "two and a half", "three"]);
    expect(newSideLines(patch, 11, 11)).toEqual(["ten"]);
    expect(newSideLines(patch, 4, 5)).toBeNull();
  });

  it("takes new-side ranges only", () => {
    expect(suggestionLines({ line: 5, side: "RIGHT", startLine: null, startSide: null })).toEqual({ startLine: 5, endLine: 5 });
    expect(suggestionLines({ line: 7, side: "RIGHT", startLine: 5, startSide: "RIGHT" })).toEqual({ startLine: 5, endLine: 7 });
    expect(suggestionLines({ line: 7, side: "RIGHT", startLine: 5, startSide: "LEFT" })).toBeNull();
    expect(suggestionLines({ line: 7, side: "LEFT", startLine: null, startSide: null })).toBeNull();
    expect(suggestionLines({ line: null, side: "RIGHT", startLine: null, startSide: null })).toBeNull();
  });
});

describe("applySuggestionsToText", () => {
  const text = "one\ntwo\nthree\nfour\n";

  it("applies a batch bottom up, keeping the final newline and the file's line endings", () => {
    expect(applySuggestionsToText(text, [item(1, 1, ["one"], ["ONE", "one and a half"]), item(3, 4, ["three", "four"], [])])).toBe("ONE\none and a half\ntwo\n");
    expect(applySuggestionsToText("a\r\nb\r\n", [item(2, 2, ["b"], ["B"])])).toBe("a\r\nB\r\n");
    expect(applySuggestionsToText("a\nb", [item(2, 2, ["b"], ["B"])])).toBe("a\nB");
  });

  it("refuses every item when one's lines moved, naming its path and lines", () => {
    expect(() => applySuggestionsToText(text, [item(1, 1, ["one"], ["ONE"]), item(2, 3, ["two", "THREE"], ["x"])])).toThrow(/a\.ts:L2-3 changed since the suggestion was made/u);
    expect(() => applySuggestionsToText(text, [item(4, 5, ["four", ""], ["x"])])).toThrow(/a\.ts:L4-5 runs past/u);
    expect(() => applySuggestionsToText(text, [item(1, 2, ["one", "two"], ["x"]), item(2, 2, ["two"], ["y"])])).toThrow(/overlaps a\.ts:L1-2/u);
  });

  it("knows lines already reading as the replacement, but not a shrink that keeps the range's first lines", () => {
    const landed = (current: string[] | null, atReplacement: string[] | null, replacement: string[], original: string[] | null = null) => suggestionLanded({ rangeLength: 2, current, atReplacement, replacement, original });
    expect(landed(["A", "B"], ["A", "B"], ["A", "B"])).toBe(true);
    expect(landed(["A", "c"], ["A", "c", "d"], ["A", "B", "C"])).toBe(false);
    expect(landed(null, null, ["A"])).toBe(false);
    // L2-3 "foo();", "debug();" -> "foo();": the lines before applying already start with the replacement.
    expect(landed(["foo();", "debug();"], ["foo();"], ["foo();"])).toBe(false);
    expect(landed(["foo();", "debug();"], ["foo();"], ["foo();"], ["foo();", "debug();"])).toBe(false);
    expect(landed(["foo();", "next();"], ["foo();"], ["foo();"], ["foo();", "debug();"])).toBe(true);
    // Keeping the line and adding one after it leaves the range as it was left on.
    expect(suggestionLanded({ rangeLength: 1, current: ["foo();"], atReplacement: ["foo();", "bar();"], replacement: ["foo();", "bar();"], original: ["foo();"] })).toBe(true);
  });
});

describe("applySuggestionsInCheckout", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("writes every file only once all of them check out", async () => {
    dir = mkdtempSync(join(tmpdir(), "suggest-"));
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
    writeFileSync(join(dir, "b.ts"), "uno\n");
    await expect(applySuggestionsInCheckout(dir, [item(1, 1, ["one"], ["ONE"]), item(1, 1, ["moved"], ["UNO"], "b.ts")])).rejects.toThrow(/b\.ts:L1 changed/u);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("one\ntwo\n");
    expect(await applySuggestionsInCheckout(dir, [item(1, 1, ["one"], ["ONE"]), item(1, 1, ["uno"], ["UNO"], "b.ts")])).toEqual({ applied: 2, commitUrl: null });
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("ONE\ntwo\n");
    expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("UNO\n");
    await expect(applySuggestionsInCheckout(dir, [item(1, 1, ["x"], ["y"], "../outside.ts")])).rejects.toThrow(/Invalid path/u);
  });
});

const localComment = (id: string, body: string): DiffComment => ({
  id,
  path: "a.ts",
  line: 3,
  side: "RIGHT",
  startLine: 2,
  startSide: "RIGHT",
  body,
  target: "local",
  inReplyTo: null,
  author: null,
  authorThreadId: null,
  createdAt: 1,
  updatedAt: 1,
  postedAt: null,
  postedUrl: null,
  githubCommentId: null,
  addressedAt: null,
  applyId: null,
});

const threadOf = (bodies: string[], patch: Partial<DiffThread> = {}): DiffThread => ({
  id: "t1",
  path: "a.ts",
  line: 3,
  side: "RIGHT",
  startLine: 2,
  startSide: "RIGHT",
  entries: bodies.map((body, index) => ({ source: "local", comment: localComment(`c${index}`, body) })),
  onGithub: false,
  outdated: false,
  resolved: null,
  orphaned: false,
  ...patch,
});

describe("threadSuggestion", () => {
  const file = ["one", "two", "three", "four"];
  const linesAt: LinesAt = (_path, start, end) => (end > file.length ? null : file.slice(start - 1, end));

  it("takes the thread's latest suggestion over its lines today", () => {
    const found = threadSuggestion(threadOf(["```suggestion\nTWO\n```", "no:\n```suggestion\n2\n3\n```"]), linesAt);
    expect(found).toMatchObject({ commentId: "c1", reason: null, applied: false, current: ["two", "three"], startLine: 2 });
    expect(found?.item).toEqual({ id: "c1", path: "a.ts", startLine: 2, endLine: 3, expected: ["two", "three"], replacement: ["2", "3"] });
    expect(threadSuggestion(threadOf(["just words"]), linesAt)).toBeNull();
  });

  it("says why a suggestion can't apply: applied, outdated, resolved, old side", () => {
    expect(threadSuggestion(threadOf(["```suggestion\ntwo\nthree\n```"]), linesAt)).toMatchObject({ item: null, applied: true });
    expect(threadSuggestion(threadOf(["```suggestion\nx\n```"]), linesAt, new Set(["c0"]))).toMatchObject({ item: null, applied: true });
    expect(threadSuggestion(threadOf(["```suggestion\nx\n```"], { outdated: true }), linesAt)?.reason).toMatch(/outdated/u);
    expect(threadSuggestion(threadOf(["```suggestion\nx\n```"], { resolved: true }), linesAt)?.reason).toMatch(/resolved/u);
    expect(threadSuggestion(threadOf(["```suggestion\nx\n```"], { side: "LEFT", startSide: "LEFT" }), linesAt)?.reason).toMatch(/new side/u);
  });
});

describe("suggestion keys", () => {
  it("are bound without conflicts and listed", () => {
    expect([REVIEW_KEYMAP.I, REVIEW_KEYMAP.A, REVIEW_KEYMAP.B, REVIEW_KEYMAP.gB]).toEqual([{ kind: "suggest" }, { kind: "applySuggestion" }, { kind: "batchSuggestion" }, { kind: "commitSuggestions" }]);
    expect(keymapConflicts(REVIEW_KEYMAP)).toEqual([]);
    expect(keymapConflicts(COMMENTS_KEYMAP)).toEqual([]);
    expect(unboundHelpKeys(KEY_HELP.filter((section) => section.title === "Suggested changes"), [REVIEW_KEYMAP])).toEqual([]);
    expect(unboundHelpKeys(COMMENTS_KEY_HELP, [COMMENTS_KEYMAP])).toEqual([]);
  });

  const rows: NavRow[] = [1, 2, 3].map((n) => ({ left: n, right: n, hunk: 0, changed: false }));
  const run = (command: Parameters<typeof runReviewCommand>[0], cursor: Cursor, visual: Cursor | null, suggestions: Partial<SuggestionActions>, threads: DiffThread[] = []) => {
    let state = { cursor, visual, pending: "", focused: null, cursorShown: true } as ReturnType<ReviewEnv["keys"]["get"]>;
    const calls: unknown[] = [];
    const models = new Map<string, FileNavModel>([["a.ts", { rows, cutToHunk: false, element: () => null }]]);
    const env = {
      keys: { get: () => state, set: (patch: Partial<typeof state>) => (state = { ...state, ...patch }), models, threads: new Map(), findings: new Map() },
      files: [{ path: "a.ts", collapsed: false, rows }],
      threads,
      findings: [],
      onScreen: () => true,
      seat: () => null,
      reveal: () => {},
      focusComposer: () => false,
      startComment: (path: string, range: unknown) => calls.push(["startComment", path, range]),
      notify: (message: string) => calls.push(["notify", message]),
      suggestions: { ...NO_SUGGESTIONS, ...suggestions },
    } as unknown as ReviewEnv;
    runReviewCommand(command, 1, env);
    return calls;
  };
  const at = (line: number | null, side: "LEFT" | "RIGHT" = "RIGHT"): Cursor => ({ path: "a.ts", side, line, want: side });
  const file = ["one", "two", "three"];
  const linesAt: LinesAt = (_path, start, end) => file.slice(start - 1, end);

  it("I opens a comment on the selection holding its lines in a block, and refuses the old side", () => {
    expect(run({ kind: "suggest" }, at(3), at(2), { linesAt })).toEqual([
      ["startComment", "a.ts", { line: 3, side: "RIGHT", startLine: 2, startSide: "RIGHT", initialBody: "```suggestion\ntwo\nthree\n```" }],
    ]);
    expect(run({ kind: "suggest" }, at(2, "LEFT"), null, { linesAt })).toEqual([["notify", "Suggestions replace new-side lines; l moves to the new side"]]);
    expect(run({ kind: "suggest" }, at(null), null, { linesAt })[0]).toEqual(["notify", "Move onto a line (or V to select some) to suggest a change"]);
  });

  it("A applies the thread's suggestion, B batches it, gB applies the batch", () => {
    const thread = threadOf(["```suggestion\nTWO\n```"]);
    const applied: SuggestionItem[][] = [];
    const batched: SuggestionItem[] = [];
    const forThread = (entry: DiffThread) => threadSuggestion(entry, linesAt);
    const actions = { linesAt, forThread, apply: async (items: SuggestionItem[]) => void applied.push(items), toggleBatch: (entry: SuggestionItem) => (batched.push(entry), true) };
    run({ kind: "applySuggestion" }, at(3), null, actions, [thread]);
    expect(applied).toEqual([[{ id: "c0", path: "a.ts", startLine: 2, endLine: 3, expected: ["two", "three"], replacement: ["TWO"] }]]);
    expect(run({ kind: "batchSuggestion" }, at(3), null, actions, [thread])).toEqual([["notify", "Added to the batch (1; gB applies it)"]]);
    expect(batched).toHaveLength(1);
    expect(run({ kind: "commitSuggestions" }, at(3), null, { ...actions, batch: batched })).toEqual([]);
    expect(applied).toHaveLength(2);
    expect(run({ kind: "commitSuggestions" }, at(3), null, actions)).toEqual([["notify", "No suggestions in the batch (B adds the one under the cursor)"]]);
    expect(run({ kind: "applySuggestion" }, at(3), null, { ...actions, apply: null }, [thread])).toEqual([["notify", "This view can't apply suggestions"]]);
  });
});

describe("commentsMessage", () => {
  const row = (body: string) => ({ id: "c", thread_id: "t", path: "a.ts", line: 2, side: "RIGHT", start_line: null, start_side: null, body, in_reply_to: null, created_at: 1, updated_at: 1, send_id: null });

  it("says a suggestion block is the exact replacement, only when one is there", () => {
    expect(commentsMessage([row("```suggestion\nx\n```")], new Map())).toContain("exact replacement text");
    expect(commentsMessage([row("rename this")], new Map())).not.toContain("suggestion");
  });
});
