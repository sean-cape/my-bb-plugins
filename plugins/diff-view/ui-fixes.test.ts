import { describe, expect, it } from "vitest";
import { allDiffThreads } from "./lib/app/comments/threads";
import { commentSections } from "./lib/app/comments/comment-sections";
import { navRows, patchRows } from "./lib/app/text/patch-rows";
import type { Cursor, NavFile } from "./lib/app/keys/nav";
import { runReviewCommand, type ReviewEnv } from "./lib/app/keys/review-commands";
import { currentLoadedPatch, loadedPatchEntry, shownPatch, whitespaceKeep, whitespaceOnlyPaths } from "./lib/app/patches";
import { searchDiff } from "./lib/app/search/diff-search";
import { rangeGate } from "./lib/app/commits/commit-range";
import { popoverPlace } from "./lib/app/ui/popover-place";
import { FILE_FILTER_MENU_KEYMAP } from "./lib/app/file-filter";
import { flipped, withMembers } from "./lib/app/sets";
import { compileSearch, keymapConflicts } from "../vim-mode/lib/index.ts";
import type { DiffComment, DiffFile, DiffResult } from "./lib/types";

function local(overrides: Partial<DiffComment> & { id: string }): DiffComment {
  return {
    path: "new.ts",
    line: 1,
    side: "RIGHT",
    startLine: null,
    startSide: null,
    body: "body",
    target: "local",
    inReplyTo: null,
    author: null,
    authorThreadId: null,
    createdAt: 0,
    updatedAt: 0,
    postedAt: null,
    postedUrl: null,
    githubCommentId: null,
    addressedAt: null,
    applyId: null,
    ...overrides,
  };
}

const ADDED = ["@@ -0,0 +1,40 @@", ...Array.from({ length: 40 }, (_, index) => `+line ${index + 1}`)].join("\n");
const shownLines = (patch: string | null) => (patch === null ? [] : patchRows(patch).rows.map((row) => row.right));

describe("the comments view's excerpt of an added file", () => {
  it("shows a window around the thread's lines, not the whole file", () => {
    const threads = allDiffThreads([local({ id: "a", line: 20 })], []);
    const [section] = commentSections(threads, [{ path: "new.ts", previousPath: null, patch: ADDED }], "all");
    expect(shownLines(section!.patch)).toEqual([17, 18, 19, 20, 21, 22, 23]);
    expect(section!.threads[0]!.line).toBe(20);
  });

  it("gives threads far apart a window each, and keeps a range's lines whole", () => {
    const threads = allDiffThreads([local({ id: "a", line: 2 }), local({ id: "b", line: 31, startLine: 29 })], []);
    const [section] = commentSections(threads, [{ path: "new.ts", previousPath: null, patch: ADDED }], "all");
    expect(shownLines(section!.patch)).toEqual([1, 2, 3, 4, 5, 26, 27, 28, 29, 30, 31, 32, 33, 34]);
  });

  it("still shows the lines an added line replaced", () => {
    const patch = ["@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n");
    const threads = allDiffThreads([local({ id: "a", path: "a.ts", line: 2 })], []);
    const [section] = commentSections(threads, [{ path: "a.ts", previousPath: null, patch }], "all");
    expect(section!.patch).toContain("-two");
  });
});

describe("v", () => {
  const rows = navRows(patchRows(["@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n")), "split");
  const files: NavFile[] = [
    { path: "a.ts", collapsed: false, rows },
    { path: "b.ts", collapsed: false, rows },
  ];
  const run = (accepted: boolean) => {
    const cursor: Cursor = { path: "a.ts", side: "RIGHT", line: 1, want: "RIGHT" };
    let state = { cursor, visual: null, pending: "", focused: null } as ReturnType<ReviewEnv["keys"]["get"]>;
    const marked: [string, boolean][] = [];
    const env = {
      keys: {
        get: () => state,
        set: (patch: Partial<typeof state>) => (state = { ...state, ...patch }),
        models: new Map(files.map((file) => [file.path, { rows, cutToHunk: false, element: () => null }])),
        threads: new Map(),
        findings: new Map(),
      },
      files,
      threads: [],
      findings: [],
      viewed: new Set<string>(),
      onScreen: () => true,
      seat: () => cursor,
      reveal: () => {},
      notify: () => {},
      markViewed: (path: string, isViewed: boolean) => {
        marked.push([path, isViewed]);
        return accepted;
      },
    } as unknown as ReviewEnv;
    runReviewCommand({ kind: "viewed" }, 1, env);
    return { marked, at: state.cursor };
  };

  it("moves on to the next file once the mark is made", () => {
    const { marked, at } = run(true);
    expect(marked).toEqual([["a.ts", true]]);
    expect(at?.path).toBe("b.ts");
  });

  it("stays on the file when the mark is refused (a range that doesn't end at the head)", () => {
    const { marked, at } = run(false);
    expect(marked).toEqual([["a.ts", true]]);
    expect(at).toMatchObject({ path: "a.ts", line: 1 });
  });
});

describe("whitespace and the drawn patch", () => {
  const PATCH = ["@@ -1,3 +1,3 @@", "-foo  bar", "+foo bar", " keep", "-old", "+new"].join("\n");

  it("keeps a whitespace-only hunk open only on a thread's side and line, or a finding's new-side line", () => {
    const keep = whitespaceKeep(
      [
        { side: "LEFT", line: 4 },
        { side: "RIGHT", line: null },
      ],
      [{ line: 7 }, { line: null }],
    );
    expect(keep("LEFT", 4)).toBe(true);
    expect(keep("RIGHT", 4)).toBe(false);
    expect(keep("RIGHT", 7)).toBe(true);
    expect(keep("LEFT", 7)).toBe(false);
  });

  it("searches the patch as drawn, where a whitespace-only pair no longer has its old text", () => {
    const pattern = compileSearch("foo  bar")!;
    expect(searchDiff([{ path: "a.ts", patch: PATCH }], pattern).matches).toHaveLength(1);
    const drawn = shownPatch(PATCH, true, false, whitespaceKeep([], []));
    expect(drawn.changed).toBe(true);
    expect(searchDiff([{ path: "a.ts", patch: drawn.patch }], pattern).matches).toEqual([]);
    expect(searchDiff([{ path: "a.ts", patch: drawn.patch }], compileSearch("foo bar")!).matches).toHaveLength(1);
  });
});

describe("loaded patches across a refetch", () => {
  const file = (additions: number, deletions: number): DiffFile => ({ path: "big.ts", previousPath: null, status: "modified", additions, deletions, patch: null, vendored: false });
  const diff = (fetchedAt: number, headSha: string | null): DiffResult => ({ source: "pr", files: [], baseRef: null, baseSha: null, headSha, truncated: false, message: null, fetchedAt, hiddenVendored: null, repo: null, environmentId: null });

  it("lasts for the fetch it was loaded in", () => {
    const entry = loadedPatchEntry(file(0, 0), diff(1, null), "@@");
    expect(currentLoadedPatch(entry, file(0, 0), diff(1, null))).toBe("@@");
  });

  it("survives a refetch only while a head commit pins the file's counts", () => {
    const pinned = loadedPatchEntry(file(3, 1), diff(1, "abc"), "@@");
    expect(currentLoadedPatch(pinned, file(3, 1), diff(2, "abc"))).toBe("@@");
    expect(currentLoadedPatch(pinned, file(3, 2), diff(2, "abc"))).toBeNull();
    expect(currentLoadedPatch(pinned, file(3, 1), diff(2, "def"))).toBeNull();
    const workingTree = loadedPatchEntry(file(3, 1), diff(1, null), "@@");
    expect(currentLoadedPatch(workingTree, file(3, 1), diff(2, null))).toBeNull();
    const uncounted = loadedPatchEntry(file(0, 0), diff(1, "abc"), "@@");
    expect(currentLoadedPatch(uncounted, file(0, 0), diff(2, "abc"))).toBeNull();
  });

  it("counts a loaded whitespace-only patch as whitespace-only", () => {
    const loaded = new Map([["big.ts", "@@ -1,1 +1,1 @@\n-a  b\n+a b"]]);
    expect(whitespaceOnlyPaths([file(1, 1)], (entry) => entry.patch ?? loaded.get(entry.path) ?? null)).toEqual(new Set(["big.ts"]));
  });
});

describe("a commit range's gate", () => {
  const threads = [{ side: "LEFT" as const }, { side: "RIGHT" as const }];

  it("lets all the changes do everything", () => {
    const gate = rangeGate(null, true);
    expect(gate.threads(threads)).toBe(threads);
    expect([gate.whole, gate.findings, gate.viewedRefusal, gate.commentRefusal({ side: "LEFT", startSide: null })]).toEqual([true, true, null, null]);
  });

  it("keeps a range ending at the head to the new side, and one short of it to reading", () => {
    const atHead = rangeGate({ from: "a", to: "b" }, true);
    expect(atHead.threads(threads)).toEqual([{ side: "RIGHT" }]);
    expect(atHead.commentRefusal({ side: "RIGHT", startSide: null })).toBeNull();
    expect(atHead.commentRefusal({ side: "RIGHT", startSide: "LEFT" })).toMatch(/new side/);
    const short = rangeGate({ from: "a", to: "b" }, false);
    expect([short.threads(threads), short.findings, short.viewedRefusal !== null, short.commentRefusal({ side: "RIGHT", startSide: null }) !== null]).toEqual([[], false, true, true]);
  });
});

describe("popover placement", () => {
  const screen = { width: 1000, height: 800 };
  const box = (left: number, right: number, top = 100) => ({ left, right, top, bottom: top + 20 });

  it("opens under the anchor from its left edge, or above it near the bottom", () => {
    expect(popoverPlace(box(100, 300), { width: 200 }, screen)).toEqual({ top: 124, left: 100 });
    expect(popoverPlace(box(100, 300, 700), { width: 200 }, screen)).toEqual({ bottom: 104, left: 100 });
  });

  it("ends at the anchor's right edge rather than leaving it when the screen runs out", () => {
    // The new side's cell of a split row at the right of the screen: the popover stays over that cell.
    expect(popoverPlace(box(700, 990), { width: 480 }, screen).left).toBe(510);
    expect(popoverPlace(box(50, 100), { width: 980 }, screen).left).toBe(12);
  });

  it("keeps a wide popover over a narrow anchor that it can end at neither way", () => {
    // A ⌘-hovered symbol mid-screen under the 592px symbol card.
    expect(popoverPlace(box(500, 560), { width: 592 }, screen).left).toBe(400);
  });
});

describe("the file filter menu's keys", () => {
  it("tick with Space or Enter and close with Escape or q, clear of the menu's motions", () => {
    expect(keymapConflicts(FILE_FILTER_MENU_KEYMAP)).toEqual([]);
    expect(FILE_FILTER_MENU_KEYMAP).toEqual({ "<Space>": "tick", "<CR>": "tick", "<Esc>": "close", q: "close" });
    for (const motion of ["j", "k", "gg", "G"]) expect(FILE_FILTER_MENU_KEYMAP[motion]).toBeUndefined();
  });
});

describe("set helpers", () => {
  it("add or remove members, keeping the set when nothing changes", () => {
    const set: ReadonlySet<string> = new Set(["a"]);
    expect(withMembers(set, ["a"], true)).toBe(set);
    expect(withMembers(set, ["b"], true)).toEqual(new Set(["a", "b"]));
    expect(withMembers(set, ["a", "c"], false)).toEqual(new Set());
    expect(flipped(set, "a")).toEqual(new Set());
    expect(flipped(set, "b")).toEqual(new Set(["a", "b"]));
  });
});
