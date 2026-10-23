import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DiffThread } from "./lib/app/comments/threads";
import type { InlineFinding } from "./lib/app/findings/findings";
import { findingSuggestion } from "./lib/app/suggestions/finding-suggestion";
import { isInBatch } from "./lib/app/suggestions/actions";
import { threadSuggestion, type LinesAt } from "./lib/app/suggestions/thread-suggestion";
import { applySuggestionsInCheckout } from "./lib/server";
import { applySuggestionsToText, newSideLineMap, trimCommentBody } from "./lib/suggestions";
import type { GithubComment, SuggestionItem } from "./lib/types";

const item = (startLine: number, endLine: number, expected: string[], replacement: string[], path = "a.ts", extra: Partial<SuggestionItem> = {}): SuggestionItem => ({ id: `${path}:${startLine}`, path, startLine, endLine, expected, replacement, ...extra });

const fileLines = (lines: string[]): LinesAt => (_path, start, end) => (end > lines.length ? null : lines.slice(start - 1, end));

const githubComment = (body: string, patch: Partial<GithubComment> = {}): GithubComment => ({
  id: "review-comment:1",
  kind: "review-comment",
  author: "octo",
  mine: false,
  body,
  path: "a.ts",
  line: 3,
  inReplyTo: null,
  side: "RIGHT",
  startLine: 2,
  startSide: "RIGHT",
  outdated: false,
  resolved: false,
  url: "",
  createdAt: "2026-10-01T00:00:00Z",
  addressedAt: null,
  ...patch,
});

const threadOf = (comment: GithubComment): DiffThread => ({ id: comment.id, path: "a.ts", line: 3, side: "RIGHT", startLine: 2, startSide: "RIGHT", entries: [{ source: "github", comment }], onGithub: true, outdated: false, resolved: false, orphaned: false });

describe("a suggestion that shrinks its range", () => {
  const shrink = "```suggestion\nfoo();\n```";

  it("is not already applied while its lines still read as before; the session's record or the lines it was written against say when it is", () => {
    const before = fileLines(["one", "foo();", "debug();", "four"]);
    expect(threadSuggestion(threadOf(githubComment(shrink)), before)).toMatchObject({ applied: false, reason: null, item: { expected: ["foo();", "debug();"], replacement: ["foo();"] } });
    expect(threadSuggestion(threadOf(githubComment(shrink)), before, new Set(["review-comment:1"]))).toMatchObject({ applied: true, item: null });
    const hunk = "@@ -1,4 +1,4 @@\n one\n foo();\n debug();";
    const written = githubComment(shrink, { diffHunk: hunk, originalLine: 3, originalStartLine: 2 });
    expect(threadSuggestion(threadOf(written), before)).toMatchObject({ applied: false, reason: null });
    // Applied: "debug();" is gone and line 3 is what followed it.
    expect(threadSuggestion(threadOf(written), fileLines(["one", "foo();", "four"]))).toMatchObject({ applied: true, reason: "Already applied" });
  });

  it("in a finding, is applied only by the session's record", () => {
    const finding: InlineFinding = {
      reviewId: "r1",
      finding: { id: "F1", severity: "minor", title: "Debug left in", description: "", fix: null, locations: [], importance: null, scopeFit: null, suggestion: { file: "a.ts", startLine: 2, endLine: 3, replacement: "foo();" } },
      selected: true,
      overridden: false,
      edited: false,
      newIn: null,
      carriedFrom: null,
      openSince: null,
      touched: false,
    };
    const before = fileLines(["one", "foo();", "debug();"]);
    expect(findingSuggestion(finding, before)).toMatchObject({ applied: false, item: { replacement: ["foo();"] } });
    expect(findingSuggestion(finding, before, new Set(["finding:r1/F1"]))).toMatchObject({ applied: true, item: null });
  });
});

describe("newSideLineMap", () => {
  it("ends each hunk at its count, so a patch's final newline adds no line", () => {
    const map = newSideLineMap("@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n");
    expect([...map]).toEqual([
      [1, "one"],
      [2, "TWO"],
    ]);
    expect([...newSideLineMap("@@ -5 +5 @@\n-a\n+b\n")]).toEqual([[5, "b"]]);
  });
});

describe("applySuggestionsToText line endings and context", () => {
  it("keeps every line's own ending in a mixed file, the lines put in taking the replaced ones'", () => {
    const text = "a\r\nb\nc\n";
    expect(applySuggestionsToText(text, [item(1, 1, ["a"], ["A"])])).toBe("A\r\nb\nc\n");
    expect(applySuggestionsToText(text, [item(2, 2, ["b"], ["B", "B2"])])).toBe("a\r\nB\nB2\nc\n");
    expect(applySuggestionsToText(text, [item(1, 1, ["a"], ["A", "A2"]), item(3, 3, ["c"], [])])).toBe("A\r\nA2\r\nb\n");
    expect(applySuggestionsToText("a\nb", [item(2, 2, ["b"], ["B", "C"])])).toBe("a\nB\nC");
    expect(applySuggestionsToText("a\nb", [item(2, 2, ["b"], [])])).toBe("a");
  });

  it("refuses an item whose surrounding lines no longer read as the diff showed them", () => {
    const text = "}\nreturn err\n}\n";
    expect(applySuggestionsToText(text, [item(2, 2, ["return err"], ["return nil"], "a.ts", { before: ["}"], after: ["}"] })])).toBe("}\nreturn nil\n}\n");
    expect(() => applySuggestionsToText(text, [item(2, 2, ["return err"], ["return nil"], "a.ts", { before: ["if err != nil {"] })])).toThrow(/a\.ts:L2 changed since/u);
    expect(() => applySuggestionsToText(text, [item(1, 1, ["}"], ["x"], "a.ts", { before: ["above"] })])).toThrow(/changed since/u);
  });
});

describe("trimCommentBody", () => {
  it("drops blank lines around a body, but keeps the end of a suggestion block left open", () => {
    expect(trimCommentBody("\n\nlooks off\n  \n")).toBe("looks off");
    expect(trimCommentBody("\n```suggestion\nindented  \n```\n\n")).toBe("```suggestion\nindented  \n```");
    expect(trimCommentBody("try:\n```suggestion\n  return x;  \n")).toBe("try:\n```suggestion\n  return x;  \n");
  });
});

describe("isInBatch", () => {
  it("matches by id", () => {
    expect(isInBatch([item(1, 1, ["a"], ["b"])], item(1, 1, ["x"], ["y"]))).toBe(true);
    expect(isInBatch([], item(1, 1, ["a"], ["b"]))).toBe(false);
    expect(isInBatch([item(1, 1, ["a"], ["b"])], null)).toBe(false);
  });
});

describe("applySuggestionsInCheckout guards", () => {
  let dir: string | null = null;
  const locked: string[] = [];
  afterEach(() => {
    for (const path of locked.splice(0)) chmodSync(path, 0o755);
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const checkout = () => (dir = mkdtempSync(join(tmpdir(), "suggest-guard-")));

  it("puts back files already written when a later one fails", async () => {
    const root = checkout();
    writeFileSync(join(root, "a.ts"), "one\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.ts"), "uno\n");
    // Reading still works, but no temp file can be made beside b.ts.
    chmodSync(join(root, "sub"), 0o555);
    locked.push(join(root, "sub"));
    await expect(applySuggestionsInCheckout(root, [item(1, 1, ["one"], ["ONE"]), item(1, 1, ["uno"], ["UNO"], "sub/b.ts")])).rejects.toThrow(/sub\/b\.ts could not be written/u);
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("one\n");
    expect(readFileSync(join(root, "sub", "b.ts"), "utf8")).toBe("uno\n");
  });

  it("keeps a file's mode, and runs applies to one checkout one after the other", async () => {
    const root = checkout();
    writeFileSync(join(root, "run.sh"), "echo hi\n", { mode: 0o755 });
    const first = applySuggestionsInCheckout(root, [item(1, 1, ["echo hi"], ["echo hello"], "run.sh")]);
    const second = applySuggestionsInCheckout(root, [item(1, 1, ["echo hi"], ["echo bye"], "run.sh")]);
    await expect(first).resolves.toEqual({ applied: 1, commitUrl: null });
    await expect(second).rejects.toThrow(/run\.sh:L1 changed since/u);
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo hello\n");
    expect(statSync(join(root, "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("refuses files that are not UTF-8, and symlinks", async () => {
    const root = checkout();
    writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await expect(applySuggestionsInCheckout(root, [item(1, 1, ["caf�"], ["cafe"], "latin1.txt")])).rejects.toThrow(/latin1\.txt is not UTF-8 text/u);
    expect(readFileSync(join(root, "latin1.txt"))).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const outside = mkdtempSync(join(tmpdir(), "suggest-outside-"));
    try {
      writeFileSync(join(outside, "secret.ts"), "keep\n");
      symlinkSync(join(outside, "secret.ts"), join(root, "link.ts"));
      symlinkSync(outside, join(root, "linked"));
      await expect(applySuggestionsInCheckout(root, [item(1, 1, ["keep"], ["gone"], "link.ts")])).rejects.toThrow(/link\.ts is a symlink/u);
      await expect(applySuggestionsInCheckout(root, [item(1, 1, ["keep"], ["gone"], "linked/secret.ts")])).rejects.toThrow(/outside the checkout/u);
      expect(readFileSync(join(outside, "secret.ts"), "utf8")).toBe("keep\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps a byte-order mark", async () => {
    const root = checkout();
    writeFileSync(join(root, "bom.ts"), "﻿a\nb\n");
    await applySuggestionsInCheckout(root, [item(2, 2, ["b"], ["B"], "bom.ts")]);
    expect(readFileSync(join(root, "bom.ts"), "utf8")).toBe("﻿a\nB\n");
  });
});
