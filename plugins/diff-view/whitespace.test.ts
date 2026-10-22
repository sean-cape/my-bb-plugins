import { describe, expect, it } from "vitest";
import { ignoreWhitespacePatch, onlyWhitespaceChanged, patchHasChanges } from "./lib/app/text/whitespace";
import { patchRows } from "./lib/app/text/patch-rows";
import { stepExcerpts } from "./lib/app/narrative/excerpts";
import { REVIEW_KEYMAP } from "./lib/app/keys/keymap";
import { runReviewCommand } from "./lib/app/keys/review-commands";
import { reviewEnv } from "./test-helpers";

const lines = (...rows: string[]) => rows.join("\n");

/** Every line the transformed patch shows sits on old and new numbers the original patch has on those sides. */
function expectNumbersKept(before: string, after: string) {
  const original = patchRows(before).at;
  for (const row of patchRows(after).rows) {
    if (row.left !== null) expect(original.has(`LEFT:${row.left}`), `LEFT:${row.left}`).toBe(true);
    if (row.right !== null) expect(original.has(`RIGHT:${row.right}`), `RIGHT:${row.right}`).toBe(true);
  }
}

describe("ignoreWhitespacePatch", () => {
  it("drops a re-indented block and a file that only changed indentation", () => {
    const patch = lines("@@ -1,3 +1,3 @@", " function f() {", "-  return 1;", "+    return 1;", " }");
    expect(ignoreWhitespacePatch(patch)).toBeNull();
    expect(onlyWhitespaceChanged(patch)).toBe(true);
  });

  it("treats trailing spaces and tabs as whitespace", () => {
    const patch = lines("@@ -2,2 +2,2 @@", "-a = 1;  ", "-b\t= 2;", "+a = 1;", "+b = 2;");
    expect(ignoreWhitespacePatch(patch)).toBeNull();
  });

  it("keeps real changes in a mixed block and turns the whitespace pairs into context with the new text", () => {
    const patch = lines("@@ -10,4 +10,4 @@ class A", "-if (x) {", "-  y();", "-}", "+if (x) {", "+    z();", "+}", " end");
    const shown = ignoreWhitespacePatch(patch)!;
    expect(shown).toBe(lines("@@ -10,4 +10,4 @@ class A", " if (x) {", "-  y();", "+    z();", " }", " end"));
    expectNumbersKept(patch, shown);
    const rows = patchRows(shown).rows;
    expect(rows.map((row) => [row.left, row.right])).toEqual([
      [10, 10],
      [11, null],
      [null, 11],
      [12, 12],
      [13, 13],
    ]);
  });

  it("pairs by LCS when lines were added or removed around the re-indented ones", () => {
    const patch = lines("@@ -1,3 +1,4 @@", "-a", "-  b", "-c", "+new", "+a", "+b", "+  c");
    const shown = ignoreWhitespacePatch(patch)!;
    expect(shown).toBe(lines("@@ -1,3 +1,4 @@", "+new", " a", " b", "   c"));
    expectNumbersKept(patch, shown);
  });

  it("drops whitespace-only hunks, keeps the others' headers, and is idempotent", () => {
    const patch = lines("diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,1 +1,1 @@", "-x =  1", "+x = 1", "@@ -20,2 +20,2 @@", " keep", "-old", "+new", "");
    const shown = ignoreWhitespacePatch(patch)!;
    expect(shown).toBe(lines("diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -20,2 +20,2 @@", " keep", "-old", "+new", ""));
    expectNumbersKept(patch, shown);
    expect(ignoreWhitespacePatch(shown)).toBe(shown);
  });

  it("keeps a whitespace-only hunk that holds a kept line, as context", () => {
    const patch = lines("@@ -5,1 +5,1 @@", "-  a", "+a");
    expect(ignoreWhitespacePatch(patch, (side, line) => side === "RIGHT" && line === 5)).toBe(lines("@@ -5,1 +5,1 @@", " a"));
    expect(ignoreWhitespacePatch(patch, (side, line) => side === "RIGHT" && line === 9)).toBeNull();
  });

  it("counts a missing final newline as a change", () => {
    const patch = lines("@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+a");
    expect(ignoreWhitespacePatch(patch)).toBe(patch);
  });

  it("returns a patch without changes as it is, which is not whitespace-only", () => {
    expect(ignoreWhitespacePatch("")).toBe("");
    expect(onlyWhitespaceChanged("")).toBe(false);
    expect(onlyWhitespaceChanged(null)).toBe(false);
    expect(patchHasChanges(lines("@@ -1,1 +1,1 @@", "-a", "+ a"))).toBe(true);
    expect(patchHasChanges(lines("@@ -1,1 +1,1 @@", " a"))).toBe(false);
  });
});

describe("hiding whitespace in the narrative and from the keys", () => {
  it("matches pairs before a step's lines are cut, and keeps a whitespace-only hunk the step names", () => {
    const file = { path: "f.ts", previousPath: null, patch: lines("@@ -1,3 +1,3 @@", "-  a", "+a", " b", "-c", "+d") };
    expect(stepExcerpts([{ path: "f.ts", side: "new", startLine: 3, endLine: 3 }], [file], true)[0]!.patch).toBe(lines("@@ -1,2 +1,2 @@", " a", " b", "@@ -3,0 +3,1 @@", "+d"));
    const reindented = { path: "g.ts", previousPath: null, patch: lines("@@ -4,1 +4,1 @@", "-  x", "+x") };
    const ref = { path: "g.ts", side: "new" as const, startLine: 4, endLine: 4 };
    expect(stepExcerpts([ref], [reindented], true)[0]!.patch).toBe(lines("@@ -4,1 +4,1 @@", " x"));
    // Cut first, a new-side ref leaves the deletion out, and the pair could no longer be matched.
    expect(stepExcerpts([ref], [reindented])[0]!.patch).toBe(lines("@@ -4,0 +4,1 @@", "+x"));
  });

  it("binds W, which works before there is a line", () => {
    expect(REVIEW_KEYMAP.W).toEqual({ kind: "whitespace" });
    let toggled = 0;
    runReviewCommand({ kind: "whitespace" }, 1, reviewEnv({ toggleWhitespace: () => (toggled += 1) }).env);
    expect(toggled).toBe(1);
  });
});
