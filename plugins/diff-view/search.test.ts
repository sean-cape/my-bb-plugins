import { describe, expect, it } from "vitest";
import { compileSearch } from "../vim-mode/lib/index.ts";
import { cursorOnMatch, searchDiff, stepMatch, type SearchedFile } from "./lib/app/search/diff-search";
import { REVIEW_KEYMAP } from "./lib/app/keys/keymap";
import { runReviewCommand, type ReviewEnv } from "./lib/app/keys/review-commands";
import type { Cursor } from "./lib/app/keys/nav";
import { reviewEnv } from "./test-helpers";

const lines = (...rows: string[]) => rows.join("\n");

const FILES: SearchedFile[] = [
  { path: "a.ts", patch: lines("diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,3 @@", " const foo = 1;", "-let bar = foo;", "+let baz = foo + foo;", " export { foo };") },
  { path: "image.png", patch: null },
  { path: "b.ts", patch: lines("@@ -10,2 +10,3 @@", " // Foo here", "+foo();", " end") },
];

const at = (path: string, side: "LEFT" | "RIGHT", line: number | null): Cursor => ({ path, side, line, want: "RIGHT" });

describe("searchDiff", () => {
  it("finds hits on old, new and context lines, a context line once, in file and display order", () => {
    const { matches } = searchDiff(FILES, compileSearch("foo")!);
    expect(matches.map((match) => [match.path, match.left, match.right, match.occurrence])).toEqual([
      ["a.ts", 1, 1, 0],
      ["a.ts", 2, null, 0],
      ["a.ts", null, 2, 0],
      ["a.ts", null, 2, 1],
      ["a.ts", 3, 3, 0],
      ["b.ts", 10, 10, 0],
      ["b.ts", null, 11, 0],
    ]);
    // Offsets are into the line's text, without the patch's +/-/space mark.
    expect(matches[2]).toMatchObject({ start: 10, end: 13 });
  });

  it("is smartcase and takes regexes", () => {
    expect(searchDiff(FILES, compileSearch("Foo")!).matches.map((match) => match.path)).toEqual(["b.ts"]);
    expect(searchDiff(FILES, compileSearch("ba[rz]")!).matches.map((match) => [match.left, match.right])).toEqual([
      [2, null],
      [null, 2],
    ]);
    // The file header lines before the first hunk are not code.
    expect(searchDiff(FILES, compileSearch("a\\.ts")!).matches).toEqual([]);
  });

  it("searches only the files it is given", () => {
    expect(searchDiff(FILES.slice(2), compileSearch("foo")!).matches.every((match) => match.path === "b.ts")).toBe(true);
  });
});

describe("stepMatch", () => {
  const search = searchDiff(FILES, compileSearch("foo")!);

  it("goes past the cursor's line, and from a header to the file's first match", () => {
    expect(stepMatch(search, at("a.ts", "RIGHT", 1), null, 1, 1)?.index).toBe(1);
    expect(stepMatch(search, at("b.ts", "RIGHT", null), null, 1, 1)?.index).toBe(5);
    expect(stepMatch(search, at("b.ts", "RIGHT", 10), null, -1, 1)?.index).toBe(4);
    // A just-typed search takes a match on the cursor's own line.
    expect(stepMatch(search, at("a.ts", "RIGHT", 1), null, 1, 1, true)?.index).toBe(0);
  });

  it("steps hit by hit from the match last reached, and wraps like vim", () => {
    expect(stepMatch(search, at("a.ts", "RIGHT", 2), 2, 1, 1)).toEqual({ index: 3, wrapped: false });
    expect(stepMatch(search, at("b.ts", "RIGHT", 11), 6, 1, 1)).toEqual({ index: 0, wrapped: true });
    expect(stepMatch(search, at("a.ts", "RIGHT", 1), 0, -1, 1)).toEqual({ index: 6, wrapped: true });
    expect(stepMatch(search, at("b.ts", "RIGHT", 12), null, 1, 1)).toEqual({ index: 0, wrapped: true });
    expect(stepMatch(search, null, null, 1, 3)).toEqual({ index: 2, wrapped: false });
  });

  it("places a line the patch leaves out between the patch lines around it", () => {
    const far = searchDiff([{ path: "c.ts", patch: lines("@@ -1,1 +1,1 @@", "-foo", "+bar", "@@ -40,1 +40,1 @@", " foo") }], compileSearch("foo")!);
    expect(stepMatch(far, at("c.ts", "RIGHT", 20), null, 1, 1)?.index).toBe(1);
    expect(stepMatch(far, at("c.ts", "RIGHT", 20), null, -1, 1)?.index).toBe(0);
  });

  it("is null when nothing matches", () => {
    expect(stepMatch(searchDiff(FILES, compileSearch("nothing")!), null, null, 1, 1)).toBeNull();
  });

  it("puts the cursor on the side a line is on, or the wanted side of a context line", () => {
    expect(cursorOnMatch(search.matches[1]!, "RIGHT")).toEqual({ path: "a.ts", side: "LEFT", line: 2, want: "RIGHT" });
    expect(cursorOnMatch(search.matches[0]!, "LEFT")).toEqual({ path: "a.ts", side: "LEFT", line: 1, want: "LEFT" });
  });
});

describe("search keys", () => {
  it("binds / to the text search and f to the file finder", () => {
    expect(REVIEW_KEYMAP["/"]).toEqual({ kind: "searchText" });
    expect(REVIEW_KEYMAP.f).toEqual({ kind: "findFile" });
  });

  const run = (command: Parameters<typeof runReviewCommand>[0], overrides: Partial<ReviewEnv> = {}, cursor: Cursor | null = null) => {
    const calls: string[] = [];
    const { env, state } = reviewEnv(
      {
        search: null,
        seat: () => cursor,
        reveal: (next: Cursor) => calls.push(`reveal:${next.path}:${next.side}:${next.line}`),
        setCollapsed: (paths: readonly string[], collapsed: boolean) => calls.push(`collapsed:${paths.join(",")}:${collapsed}`),
        openOverlay: (overlay: string) => calls.push(`overlay:${overlay}`),
        focusSendBar: () => false,
        leaveSendBar: () => false,
        closeEmptyComposer: () => false,
        notify: (message: string) => calls.push(message),
        ...overrides,
      },
      { cursor },
    );
    runReviewCommand(command, 1, env);
    return { calls, state: state() };
  };

  it("opens the search box once there is a diff to search", () => {
    expect(run({ kind: "searchText" }).calls).toEqual(["No changes to search"]);
    expect(run({ kind: "searchText" }, { files: [{ path: "a.ts", collapsed: false, rows: null }] }).calls).toEqual(["overlay:search"]);
  });

  it("steps to a match, opening its collapsed file, and says when it wraps", () => {
    const cursor = at("a.ts", "RIGHT", 1);
    const files = [
      { path: "a.ts", collapsed: false, rows: [{ left: 1, right: 1, hunk: 0, changed: false }] },
      { path: "b.ts", collapsed: true, rows: null },
    ];
    const search = { query: "foo", clear: () => false, step: () => ({ cursor: at("b.ts", "RIGHT", 11), wrapped: true }) };
    const { calls, state } = run({ kind: "searchNext", direction: 1 }, { files, search }, cursor);
    expect(calls).toEqual(["collapsed:b.ts:false", "Search hit the bottom, continuing at the top", "reveal:b.ts:RIGHT:11"]);
    expect(state.cursor).toMatchObject({ path: "b.ts", line: 11 });
    const files1 = [files[0]!];
    expect(run({ kind: "searchNext", direction: 1 }, { files: files1 }, cursor).calls).toEqual(["Search the diff with / first"]);
    expect(run({ kind: "searchNext", direction: 1 }, { files: files1, search: { ...search, step: () => null } }, cursor).calls).toEqual(["Nothing in the diff matches “foo”"]);
  });

  it("clears the highlights on Escape only when nothing else was open", () => {
    const cleared: string[] = [];
    const search = { query: "foo", step: () => null, clear: () => cleared.push("clear") > 0 };
    run({ kind: "escape" }, { search, closeEmptyComposer: () => true });
    expect(cleared).toEqual([]);
    run({ kind: "escape" }, { search });
    expect(cleared).toEqual(["clear"]);
  });
});
