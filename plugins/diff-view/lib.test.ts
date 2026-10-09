import { describe, expect, it } from "vitest";
import { buildDiffThreads, localCommentState, threadIsOpen, threadKeyActions } from "./lib/app/comments/threads";
import { buildFileTree } from "./lib/app/file-tree/build-file-tree";
import { activeReviews, distinctFindings, filterFindings, inlineFindingsByPath, nextFindingFilter, parseFindingFilter } from "./lib/app/findings/findings";
import { isGeneratedFile } from "./lib/app/generated";
import { riskByPath } from "./lib/app/risk";
import { enclosingDefinition } from "./lib/app/structural/enclosing-definition";
import { detectMoves } from "./lib/app/structural/moves";
import { hunkSpan, structuralRows, visibleRows } from "./lib/app/structural/rows";
import { buildLineAnnotations } from "./lib/app/text/line-annotations";
import { navRows, patchRows, selectionRange } from "./lib/app/text/patch-rows";
import { keyToken, parseKeys } from "./lib/app/keys/keymap";
import { anchorsAtCursor, hunkSpanAt, moveChange, moveFile, moveHunk, moveLines, nextAnchor, visualRange, type Cursor, type NavFile } from "./lib/app/keys/nav";
import { rankFiles } from "./lib/app/keys/rank-files";
import { runReviewCommand, type ReviewEnv } from "./lib/app/keys/review-commands";
import { checkedLineRange, locationLabel, longLineLabel, shortLineLabel } from "./lib/line-range";
import { splitUnifiedDiff } from "./lib/server";
import type { DiffComment, DiffFile, Finding, GithubComment, Review, StructuralDiff } from "./lib/types";

function local(overrides: Partial<DiffComment> & { id: string }): DiffComment {
  return {
    path: "x.ts",
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

function github(overrides: Partial<GithubComment> & { id: string }): GithubComment {
  return {
    kind: "review-comment",
    author: "octocat",
    mine: false,
    body: "body",
    path: "x.ts",
    line: 1,
    inReplyTo: null,
    side: "RIGHT",
    startLine: null,
    startSide: null,
    outdated: false,
    resolved: null,
    url: "https://github.invalid/c",
    createdAt: "1970-01-01T00:00:00Z",
    addressedAt: null,
    ...overrides,
  };
}

describe("localCommentState", () => {
  it("reads agent replies, drafts, posted, addressed, sent and pending comments", () => {
    expect(localCommentState(local({ id: "a", author: "agent" }))).toBe("agent");
    expect(localCommentState(local({ id: "a", target: "github" }))).toBe("draft");
    expect(localCommentState(local({ id: "a", target: "github", postedAt: 1 }))).toBe("posted");
    expect(localCommentState(local({ id: "a", addressedAt: 1, applyId: "s" }))).toBe("addressed");
    expect(localCommentState(local({ id: "a", applyId: "s" }))).toBe("submitted");
    expect(localCommentState(local({ id: "a" }))).toBe("pending");
  });
});

describe("buildDiffThreads", () => {
  it("puts the root first and replies after it oldest first", () => {
    const threads = buildDiffThreads(
      [local({ id: "late", inReplyTo: "root", createdAt: 30 }), local({ id: "root", createdAt: 10 }), local({ id: "early", inReplyTo: "root", createdAt: 20 })],
      [],
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]!.entries.map((entry) => entry.comment.id)).toEqual(["root", "early", "late"]);
  });

  it("interleaves local replies to a GitHub thread by time", () => {
    const threads = buildDiffThreads(
      [local({ id: "mine", inReplyTo: "review-comment:1", createdAt: Date.parse("1970-01-01T00:00:02Z") })],
      [github({ id: "review-comment:1" }), github({ id: "review-comment:2", inReplyTo: "review-comment:1", createdAt: "1970-01-01T00:00:03Z" })],
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "review-comment:1", onGithub: true, orphaned: false });
    expect(threads[0]!.entries.map((entry) => `${entry.source}:${entry.comment.id}`)).toEqual(["github:review-comment:1", "local:mine", "github:review-comment:2"]);
  });

  it("shows a posted draft once, as its synced copy", () => {
    const threads = buildDiffThreads([local({ id: "draft", target: "github", postedAt: 1, githubCommentId: "review-comment:7" })], [github({ id: "review-comment:7" })]);
    expect(threads.map((thread) => thread.id)).toEqual(["review-comment:7"]);
  });

  it("keeps a posted draft with no synced copy yet, and attaches GitHub replies to it by its GitHub id", () => {
    const threads = buildDiffThreads(
      [local({ id: "draft", target: "github", postedAt: 1, githubCommentId: "review-comment:7" })],
      [github({ id: "review-comment:8", inReplyTo: "review-comment:7" })],
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe("draft");
    expect(threads[0]!.entries.map((entry) => entry.comment.id)).toEqual(["draft", "review-comment:8"]);
  });

  it("groups replies whose root is gone into an orphaned thread that cannot be answered", () => {
    const [thread] = buildDiffThreads([local({ id: "reply", inReplyTo: "gone", target: "github" })], []);
    expect(thread).toMatchObject({ id: "gone", orphaned: true, onGithub: false });
  });

  it("drops the lines of an outdated GitHub comment", () => {
    const [thread] = buildDiffThreads([], [github({ id: "review-comment:1", outdated: true, line: 12, startLine: 10, startSide: "RIGHT" })]);
    expect(thread).toMatchObject({ line: null, startLine: null, startSide: null, outdated: true });
  });

  it("anchors a multi-line comment's thread on its range", () => {
    const [thread] = buildDiffThreads([local({ id: "a", line: 14, startLine: 10, startSide: "RIGHT" })], []);
    expect(thread).toMatchObject({ line: 14, side: "RIGHT", startLine: 10, startSide: "RIGHT" });
  });

  it("lets replies go to GitHub only from line comments that are, or will become, inline GitHub comments", () => {
    const onGithub = (comment: DiffComment) => buildDiffThreads([comment], [])[0]!.onGithub;
    expect(onGithub(local({ id: "a", target: "github" }))).toBe(true);
    expect(onGithub(local({ id: "a", target: "github", line: null }))).toBe(false);
    expect(onGithub(local({ id: "a", target: "github", postedAt: 1, githubCommentId: "review-comment:1" }))).toBe(true);
    expect(onGithub(local({ id: "a", target: "github", postedAt: 1, githubCommentId: "review:1" }))).toBe(false);
    expect(onGithub(local({ id: "a" }))).toBe(false);
  });

  it("ignores synced comments that are not inline review comments", () => {
    expect(buildDiffThreads([], [github({ id: "issue-comment:1", kind: "issue-comment" }), github({ id: "review-comment:2", path: null })])).toEqual([]);
  });
});

describe("threadIsOpen", () => {
  const thread = (locals: DiffComment[], githubs: GithubComment[] = []) => buildDiffThreads(locals, githubs)[0]!;
  it("closes resolved and addressed threads unless a reply is still unsent", () => {
    expect(threadIsOpen(thread([], [github({ id: "review-comment:1", resolved: true })]))).toBe(false);
    expect(threadIsOpen(thread([local({ id: "root", applyId: "s", addressedAt: 1 })]))).toBe(false);
    expect(threadIsOpen(thread([local({ id: "root", applyId: "s", addressedAt: 1 }), local({ id: "reply", inReplyTo: "root" })]))).toBe(true);
    expect(threadIsOpen(thread([local({ id: "root", applyId: "s" })]))).toBe(true);
    expect(threadIsOpen(thread([], [github({ id: "review-comment:1" })]))).toBe(true);
  });
});

function finding(id: string, locations: Finding["locations"], severity: Finding["severity"] = "minor"): Finding {
  return { id, severity, title: id, description: "", fix: null, locations, importance: null, scopeFit: null };
}

function review(id: string, createdAt: number, findings: Finding[], overrides: Partial<Review> = {}): Review {
  return { id, status: "completed", sinceCommitSha: null, report: { findings }, selection: {}, selectionOverrides: {}, findingEdits: {}, createdAt, ...overrides };
}

describe("activeReviews", () => {
  it("keeps the latest full review and the incremental ones after it", () => {
    const reviews = [
      review("full-old", 1, []),
      review("inc-old", 2, [], { sinceCommitSha: "a" }),
      review("full", 3, []),
      review("inc", 4, [], { sinceCommitSha: "b" }),
      review("running", 5, [], { status: "running", report: null }),
    ];
    expect(activeReviews(reviews).map((entry) => entry.id)).toEqual(["full", "inc"]);
  });

  it("stops at a re-review that carried every open finding forward", () => {
    const reviews = [
      review("full", 1, []),
      review("carried", 2, [], { sinceCommitSha: "a", report: { findings: [], carriesForward: true } }),
      review("inc", 3, [], { sinceCommitSha: "b" }),
    ];
    expect(activeReviews(reviews).map((entry) => entry.id)).toEqual(["carried", "inc"]);
  });

  it("keeps every completed review when none is full", () => {
    expect(activeReviews([review("b", 2, [], { sinceCommitSha: "x" }), review("a", 1, [], { sinceCommitSha: "y" })]).map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("inlineFindingsByPath", () => {
  it("places a finding at each location and marks new and touched ones", () => {
    const reviews = [
      review("full", 1, [finding("F1", [{ file: "a.ts", startLine: 5, endLine: 8 }, { file: "b.ts", startLine: null, endLine: null }])], { selection: { F1: true }, selectionOverrides: { F1: true } }),
      review("inc", 2, [finding("F2", [{ file: "a.ts", startLine: 20, endLine: null }])], { sinceCommitSha: "abc", findingEdits: { F2: {} } }),
    ];
    const byPath = inlineFindingsByPath(reviews, { fromSha: "a", toSha: "b", files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, ranges: [[7, 7]] }] });
    expect(byPath.get("a.ts")!.map((entry) => ({ id: entry.item.finding.id, line: entry.line, isNew: entry.item.isNew, touched: entry.item.touched }))).toEqual([
      { id: "F1", line: 5, isNew: false, touched: true },
      { id: "F2", line: 20, isNew: true, touched: false },
    ]);
    expect(byPath.get("b.ts")!.map((entry) => entry.line)).toEqual([null]);
    const f1 = byPath.get("a.ts")![0]!.item;
    expect(f1).toMatchObject({ selected: true, overridden: true, edited: false });
    expect(byPath.get("a.ts")![1]!.item).toMatchObject({ selected: false, overridden: false, edited: true });
  });
});

describe("inlineFindingsByPath carry-over", () => {
  it("does not call a carried finding new, and names the earlier finding it came from", () => {
    const carried = { ...finding("F1", [{ file: "a.ts", startLine: 1, endLine: 1 }]), carriedFrom: "r0/F3" };
    const fresh = finding("F2", [{ file: "a.ts", startLine: 9, endLine: 9 }]);
    const byPath = inlineFindingsByPath([review("inc", 2, [carried, fresh], { sinceCommitSha: "a", report: { findings: [carried, fresh], carriesForward: true } })], null);
    expect(byPath.get("a.ts")!.map(({ item }) => ({ id: item.finding.id, isNew: item.isNew, carriedFrom: item.carriedFrom }))).toEqual([
      { id: "F1", isNew: false, carriedFrom: "F3" },
      { id: "F2", isNew: true, carriedFrom: null },
    ]);
  });
});

describe("finding filter", () => {
  const byPath = inlineFindingsByPath(
    [review("r", 1, [finding("C", [{ file: "a.ts", startLine: 1, endLine: 1 }, { file: "b.ts", startLine: 4, endLine: 4 }], "critical"), finding("I", [{ file: "a.ts", startLine: 2, endLine: 2 }], "important"), finding("M", [{ file: "c.ts", startLine: 3, endLine: 3 }], "minor")])],
    null,
  );
  const ids = (filter: Parameters<typeof filterFindings>[1]) => Object.fromEntries([...filterFindings(byPath, filter)].map(([path, list]) => [path, list.map((entry) => entry.item.finding.id)]));

  it("keeps findings at or above the threshold and drops files left with none", () => {
    expect(ids("all")).toEqual({ "a.ts": ["C", "I"], "b.ts": ["C"], "c.ts": ["M"] });
    expect(ids("important")).toEqual({ "a.ts": ["C", "I"], "b.ts": ["C"] });
    expect(ids("critical")).toEqual({ "a.ts": ["C"], "b.ts": ["C"] });
    expect(ids("off")).toEqual({});
  });

  it("counts a finding placed at several locations once", () => {
    expect(distinctFindings([...byPath.values()].flat()).map((item) => item.finding.id).sort()).toEqual(["C", "I", "M"]);
  });

  it("cycles from showing the most to none, then back", () => {
    expect([nextFindingFilter("all"), nextFindingFilter("important"), nextFindingFilter("critical"), nextFindingFilter("off")]).toEqual(["important", "critical", "off", "all"]);
  });

  it("reads the stored filter, keeps findings hidden for anyone who had turned them off, and defaults to important and up", () => {
    expect(parseFindingFilter("critical", "false")).toBe("critical");
    expect(parseFindingFilter(null, "false")).toBe("off");
    expect(parseFindingFilter(null, "true")).toBe("important");
    expect(parseFindingFilter(null, null)).toBe("important");
    expect(parseFindingFilter("bogus", null)).toBe("important");
  });
});

describe("buildLineAnnotations", () => {
  const threads = buildDiffThreads([local({ id: "a", line: 3 }), local({ id: "file", line: null }), local({ id: "b", line: 9, side: "LEFT" })], []);
  const findings = inlineFindingsByPath([review("r", 1, [finding("F1", [{ file: "x.ts", startLine: 3, endLine: 3 }, { file: "x.ts", startLine: 7, endLine: 7 }, { file: "x.ts", startLine: null, endLine: null }])])], null).get("x.ts")!;
  const composer = { line: 3, side: "RIGHT" as const, startLine: null, startSide: null };
  const keys = (list: ReturnType<typeof buildLineAnnotations>) => list.map((annotation) => annotation.metadata.key);

  it("puts line threads, then the composer, then each placed finding, under stable keys", () => {
    const list = buildLineAnnotations(threads, composer, findings);
    expect(keys(list)).toEqual(["thread:a", "thread:b", "composer", "finding:r:F1:3", "finding:r:F1:7"]);
    expect(list.map((annotation) => `${annotation.side}-${annotation.lineNumber}`)).toEqual(["additions-3", "deletions-9", "additions-3", "additions-3", "additions-7"]);
  });

  it("keeps threads and the composer at their indices when findings come and go", () => {
    expect(keys(buildLineAnnotations(threads, composer, [])).slice(0, 3)).toEqual(keys(buildLineAnnotations(threads, composer, findings)).slice(0, 3));
  });

  it("hands a submitted composer's index to the thread it became, so nothing after it shifts", () => {
    const before = keys(buildLineAnnotations(threads, composer, findings));
    const added = buildDiffThreads([local({ id: "a", line: 3 }), local({ id: "file", line: null }), local({ id: "b", line: 9, side: "LEFT" }), local({ id: "c", line: 3 })], []);
    const after = keys(buildLineAnnotations(added, null, findings));
    expect(after.indexOf("thread:c")).toBe(before.indexOf("composer"));
    expect(after.slice(3)).toEqual(before.slice(3));
  });
});

describe("riskByPath", () => {
  it("prefers the current tour's score and falls back to the worst finding", () => {
    const findings = inlineFindingsByPath([review("r", 1, [finding("A", [{ file: "a.ts", startLine: 1, endLine: 1 }], "critical"), finding("B", [{ file: "b.ts", startLine: 1, endLine: 1 }], "important"), finding("C", [{ file: "b.ts", startLine: 2, endLine: 2 }])])], null);
    const tour = {
      stale: false,
      narrative: { threadId: "t", status: "completed" as const, report: { summary: "", watchOut: [], readingOrder: [{ path: "a.ts", role: "key" as const, note: "", lines: [], risk: 2, changes: [] }] } },
    };
    expect(Object.fromEntries(riskByPath(tour, findings))).toEqual({ "a.ts": 2, "b.ts": 4 });
    expect(Object.fromEntries(riskByPath({ ...tour, stale: true }, findings))).toEqual({ "a.ts": 5, "b.ts": 4 });
  });
});

function structural(aligned: StructuralDiff["aligned"], changedNew: number[] = [], changedOld: number[] = []): StructuralDiff {
  return {
    available: true,
    reason: null,
    language: null,
    status: "changed",
    oldText: "",
    newText: "",
    aligned,
    oldChanges: changedOld.map((line) => ({ line, changes: [] })),
    newChanges: changedNew.map((line) => ({ line, changes: [] })),
  };
}

describe("structural rows", () => {
  const unchanged = (count: number): StructuralDiff["aligned"] => Array.from({ length: count }, (_, i) => [i + 1, i + 1]);

  it("marks one-sided rows and rows with changed spans as changed", () => {
    const rows = structuralRows(structural([[1, 1], [2, null], [null, 2], [3, 3]], [3]));
    expect(rows.map((row) => row.changed)).toEqual([false, true, true, true]);
  });

  it("shows three lines of context around changes and folds the rest", () => {
    const rows = structuralRows(structural(unchanged(20), [10]));
    const visible = visibleRows(rows, { revealed: new Set(), findingLines: [], threads: [] });
    expect([...visible].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });

  it("unfolds around findings, threads on either side, and revealed rows", () => {
    const aligned: StructuralDiff["aligned"] = [...unchanged(30).slice(0, 15), [16, null], ...unchanged(30).slice(16).map(([lhs, rhs]) => [lhs, rhs! - 1] as [number, number])];
    const rows = structuralRows(structural(aligned, [], []));
    const visible = visibleRows(rows, { revealed: new Set([29]), findingLines: [2, null], threads: [{ line: 25, side: "LEFT", startLine: null, startSide: null }] });
    // Row 15 is the deletion; old line 25 is row 24; new line 2 is row 1.
    expect([...visible].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 29]);
  });

  it("unfolds all of a thread's range", () => {
    const rows = structuralRows(structural(unchanged(40), [1]));
    const visible = visibleRows(rows, { revealed: new Set(), findingLines: [], threads: [{ line: 30, side: "RIGHT", startLine: 18, startSide: "RIGHT" }] });
    expect([...visible].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, ...Array.from({ length: 19 }, (_, i) => 14 + i)]);
  });

  it("spans a hunk on its new side unless it only deletes", () => {
    const rows = structuralRows(structural([[1, 1], [2, null], [3, null], [4, 2]], [], []));
    expect(hunkSpan(rows, new Set([1, 2]), 1)).toEqual({ end: 2, side: "old", start: 2, stop: 3 });
    expect(hunkSpan(rows, new Set([0, 1, 2, 3]), 0)).toEqual({ end: 3, side: "new", start: 1, stop: 2 });
  });
});

describe("detectMoves", () => {
  const rowsOf = (aligned: Array<[number | null, number | null]>) => aligned.map(([lhs, rhs], index) => ({ index, lhs, rhs }));

  it("pairs a deleted block with an identical added block", () => {
    const oldLines = ["a()", "b()", "c()", "keep"];
    const newLines = ["keep", "a()", "b()", "c()"];
    const rows = rowsOf([[1, null], [2, null], [3, null], [4, 1], [null, 2], [null, 3], [null, 4]]);
    const moved = detectMoves(rows, oldLines, newLines);
    expect(moved.get(0)).toEqual({ counterpart: 4, counterpartLine: 2, first: true });
    expect(moved.get(6)).toEqual({ counterpart: 2, counterpartLine: 3, first: false });
    expect(moved.has(3)).toBe(false);
  });

  it("ignores runs shorter than three lines or with fewer than two non-blank lines", () => {
    const short = detectMoves(rowsOf([[1, null], [2, null], [null, 1], [null, 2]]), ["a()", "b()"], ["a()", "b()"]);
    expect(short.size).toBe(0);
    const blank = detectMoves(rowsOf([[1, null], [2, null], [3, null], [null, 1], [null, 2], [null, 3]]), ["x()", "", ""], ["x()", "", ""]);
    expect(blank.size).toBe(0);
  });
});

describe("enclosingDefinition", () => {
  it("finds the function around an indented line", () => {
    const lines = ["export function foo() {", "  const a = 1;", "", "  return a;", "}"];
    expect(enclosingDefinition(lines, 4)).toBe("export function foo() {");
  });

  it("finds a method inside a class", () => {
    const lines = ["class A {", "  method(x) {", "    return x;", "  }", "}"];
    expect(enclosingDefinition(lines, 3)).toBe("method(x) {");
  });

  it("gives nothing for a top-level line under a non-definition", () => {
    expect(enclosingDefinition(["const a = 1;", "const b = 2;"], 2)).toBeNull();
  });
});

function file(path: string, additions = 1, deletions = 0, vendored = false): DiffFile {
  return { path, previousPath: null, status: "modified", additions, deletions, patch: null, vendored };
}

describe("buildFileTree", () => {
  it("nests by directory, folds single-child chains, sorts, and sums stats", () => {
    const tree = buildFileTree([file("a/b/c/y.ts", 2, 1), file("root.ts"), file("a/b/c/x.ts", 3, 0), file("a/z.ts")]);
    expect(tree.files.map((entry) => entry.path)).toEqual(["root.ts"]);
    expect(tree.dirs.map((dir) => dir.name)).toEqual(["a"]);
    const a = tree.dirs[0]!;
    expect(a.files.map((entry) => entry.path)).toEqual(["a/z.ts"]);
    expect(a.dirs.map((dir) => ({ name: dir.name, path: dir.path, files: dir.files.map((entry) => entry.path) }))).toEqual([{ name: "b/c", path: "a/b/c", files: ["a/b/c/x.ts", "a/b/c/y.ts"] }]);
    expect({ additions: a.additions, deletions: a.deletions }).toEqual({ additions: 6, deletions: 1 });
    expect({ additions: tree.additions, deletions: tree.deletions }).toEqual({ additions: 7, deletions: 1 });
  });
});

describe("isGeneratedFile", () => {
  it("recognises lockfiles, build output, generated code and vendored trees", () => {
    for (const path of ["pnpm-lock.yaml", "web/package-lock.json", "go.sum", "dist/app.js", "api/user.pb.go", "src/schema.generated.ts", "pkg/zz_generated.deepcopy.go", "x/mock_store.go"]) {
      expect(isGeneratedFile(file(path)), path).toBe(true);
    }
    expect(isGeneratedFile(file("src/app.ts", 1, 0, true))).toBe(true);
    for (const path of ["src/app.ts", "README.md", "src/build.ts"]) expect(isGeneratedFile(file(path)), path).toBe(false);
  });
});

describe("splitUnifiedDiff", () => {
  it("reads paths, status, counts and binary files from a multi-file diff", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-gone",
      "+came",
      "diff --git a/added.ts b/added.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.ts",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/removed.ts b/removed.ts",
      "deleted file mode 100644",
      "--- a/removed.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/vendor/lib/logo.png b/vendor/lib/logo.png",
      "Binary files a/vendor/lib/logo.png and b/vendor/lib/logo.png differ",
      "",
    ].join("\n");
    const files = splitUnifiedDiff(diff);
    expect(files.map(({ path, previousPath, status, additions, deletions, vendored }) => ({ path, previousPath, status, additions, deletions, vendored }))).toEqual([
      { path: "new.ts", previousPath: "old.ts", status: "renamed", additions: 1, deletions: 1, vendored: false },
      { path: "added.ts", previousPath: null, status: "added", additions: 1, deletions: 0, vendored: false },
      { path: "removed.ts", previousPath: null, status: "removed", additions: 0, deletions: 1, vendored: false },
      { path: "vendor/lib/logo.png", previousPath: null, status: "modified", additions: 0, deletions: 0, vendored: true },
    ]);
    expect(files[0]!.patch).toContain("@@ -1,2 +1,2 @@");
    expect(files[3]!.patch).toBeNull();
  });
});

describe("line ranges", () => {
  it("collapses a one-line range, defaults the start side, and rejects backwards or endless ranges", () => {
    expect(checkedLineRange({ line: 5, side: "RIGHT", startLine: 5 })).toEqual({ line: 5, side: "RIGHT", startLine: null, startSide: null });
    expect(checkedLineRange({ line: 9, side: "LEFT", startLine: 5 })).toEqual({ line: 9, side: "LEFT", startLine: 5, startSide: "LEFT" });
    expect(checkedLineRange({ line: 3, side: "RIGHT", startLine: 8, startSide: "LEFT" })).toEqual({ line: 3, side: "RIGHT", startLine: 8, startSide: "LEFT" });
    expect(() => checkedLineRange({ line: 5, side: "RIGHT", startLine: 9 })).toThrow(/before/u);
    expect(() => checkedLineRange({ line: null, side: "RIGHT", startLine: 9 })).toThrow(/end line/u);
  });

  it("labels single lines, same-side ranges and ranges across sides", () => {
    const one = { line: 12, side: "RIGHT" as const, startLine: null, startSide: null };
    const same = { line: 6, side: "LEFT" as const, startLine: 4, startSide: "LEFT" as const };
    const across = { line: 6, side: "RIGHT" as const, startLine: 4, startSide: "LEFT" as const };
    expect([one, same, across].map(shortLineLabel)).toEqual(["L12", "old L4–6", "old L4 – new L6"]);
    expect([one, same, across].map(longLineLabel)).toEqual(["line 12", "old lines 4–6", "old line 4 to new line 6"]);
    expect([one, same, across].map((range) => locationLabel("a.ts", range))).toEqual(["a.ts:12", "a.ts:4-6 (old side)", "a.ts (old line 4 to new line 6)"]);
    expect(locationLabel("a.ts", { line: null, side: "RIGHT", startLine: null, startSide: null })).toBe("a.ts");
  });
});

describe("selectionRange", () => {
  // Hunk 1: context 1, -2, +2, context 3/3. Hunk 2 starts at old 10 / new 10.
  const rows = patchRows(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -10,2 +10,3 @@ fn", " j", "+k", "", "\\ No newline at end of file"].join("\n"));

  it("orders a selection dragged upward", () => {
    expect(selectionRange(rows, { line: 3, side: "RIGHT" }, { line: 1, side: "RIGHT" })).toEqual({ line: 3, side: "RIGHT", startLine: 1, startSide: "RIGHT" });
  });

  it("orders a selection across sides by where the lines show, not their numbers", () => {
    expect(selectionRange(rows, { line: 2, side: "RIGHT" }, { line: 2, side: "LEFT" })).toEqual({ line: 2, side: "RIGHT", startLine: 2, startSide: "LEFT" });
  });

  it("finds a context line from either side and collapses a selection of one row", () => {
    expect(selectionRange(rows, { line: 3, side: "LEFT" }, { line: 3, side: "RIGHT" })).toEqual({ line: 3, side: "RIGHT", startLine: null, startSide: null });
  });

  it("cuts a selection to the hunk it ends in, counting blank context lines without their space", () => {
    expect(selectionRange(rows, { line: 1, side: "RIGHT" }, { line: 12, side: "RIGHT" })).toEqual({ line: 12, side: "RIGHT", startLine: 10, startSide: "RIGHT" });
  });

  it("falls back to line order on one side for lines outside the patch", () => {
    expect(selectionRange(rows, { line: 40, side: "RIGHT" }, { line: 30, side: "RIGHT" })).toEqual({ line: 40, side: "RIGHT", startLine: 30, startSide: "RIGHT" });
  });
});

describe("review keys", () => {
  const patch = patchRows(["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -10,2 +10,3 @@ fn", " j", "+k", ""].join("\n"));
  const unified = navRows(patch, "unified");
  const files: NavFile[] = [
    { path: "a.ts", collapsed: false, rows: unified },
    { path: "b.ts", collapsed: true, rows: null },
    { path: "c.ts", collapsed: false, rows: null },
    { path: "d.ts", collapsed: false, rows: [] },
  ];
  const at = (path: string, line: number | null, side: "LEFT" | "RIGHT" = "RIGHT"): Cursor => ({ path, side, line, want: "RIGHT" });

  it("pairs a split layout's deletions with the additions after them", () => {
    expect(unified.map((row) => [row.left, row.right])).toEqual([[1, 1], [2, null], [null, 2], [3, 3], [10, 10], [null, 11], [11, 12]]);
    expect(navRows(patch, "split").map((row) => [row.left, row.right, row.hunk])).toEqual([[1, 1, 0], [2, 2, 0], [3, 3, 0], [10, 10, 1], [null, 11, 1], [11, 12, 1]]);
  });

  it("steps lines through headers, onto the side a row has, and back to the side the reader wants", () => {
    expect(moveLines(files, at("a.ts", null), 1)).toEqual(at("a.ts", 1));
    expect(moveLines(files, at("a.ts", 1), 1)).toEqual({ ...at("a.ts", 2), side: "LEFT" });
    expect(moveLines(files, { ...at("a.ts", 2), side: "LEFT" }, 1)).toEqual(at("a.ts", 2));
    expect(moveLines(files, at("a.ts", 1), -1)).toEqual(at("a.ts", null));
    expect(moveLines(files, at("a.ts", null), -1)).toEqual(at("a.ts", null));
  });

  it("passes a collapsed file's header and waits at the header of one still loading", () => {
    expect(moveLines(files, at("a.ts", 12), 1)).toEqual(at("b.ts", null));
    expect(moveLines(files, at("b.ts", null), 1)).toEqual(at("c.ts", null));
    expect(moveLines(files, at("c.ts", null), 1)).toEqual(at("c.ts", null));
    expect(moveLines(files, at("a.ts", 12), 99)).toEqual(at("c.ts", null));
  });

  it("steps back through loading and collapsed files to the last line of the file before, stopping at the top", () => {
    expect(moveLines(files, at("d.ts", null), -1)).toEqual(at("c.ts", null));
    expect(moveLines(files, at("c.ts", null), -1)).toEqual(at("b.ts", null));
    expect(moveLines(files, at("b.ts", null), -1)).toEqual(at("a.ts", 12));
    expect(moveLines(files, at("d.ts", null), -3)).toEqual(at("a.ts", 12));
    expect(moveLines(files, at("d.ts", null), -99)).toEqual(at("a.ts", null));
  });

  it("jumps by change, hunk and file", () => {
    expect(moveChange(files, at("a.ts", null), 1, 1)).toEqual({ ...at("a.ts", 2), side: "LEFT" });
    expect(moveChange(files, at("a.ts", 2), 1, 1)).toEqual(at("a.ts", 11));
    expect(moveChange(files, at("a.ts", 11), -1, 1)).toEqual({ ...at("a.ts", 2), side: "LEFT" });
    expect(moveHunk(files, at("a.ts", 1), 1, 1)).toEqual(at("a.ts", 10));
    expect(moveFile(files, at("a.ts", 10), 1, 2)).toEqual(at("c.ts", null));
    expect(moveFile(files, at("a.ts", 10), -1, 1)).toEqual(at("a.ts", null));
    expect(moveFile(files, at("d.ts", null), 1, 1)).toEqual(at("d.ts", null));
  });

  it("finds anchors past the cursor and the ones on its row, from either side's number", () => {
    const anchors = [
      { id: "file", path: "a.ts", side: "RIGHT" as const, line: null },
      { id: "old", path: "a.ts", side: "LEFT" as const, line: 3 },
      { id: "later", path: "a.ts", side: "RIGHT" as const, line: 12 },
    ];
    expect(nextAnchor(files, at("a.ts", null), anchors, 1, 1)?.id).toBe("old");
    expect(nextAnchor(files, at("a.ts", null), anchors, 1, 2)?.id).toBe("later");
    expect(nextAnchor(files, at("a.ts", 3), anchors, -1, 1)?.id).toBe("file");
    expect(anchorsAtCursor(files, at("a.ts", 3), anchors).map((anchor) => anchor.id)).toEqual(["old"]);
    expect(anchorsAtCursor(files, at("a.ts", null), anchors).map((anchor) => anchor.id)).toEqual(["file"]);
  });

  it("steps through several anchors on one line one at a time", () => {
    const anchors = [
      { id: "first", path: "a.ts", side: "RIGHT" as const, line: 3 },
      { id: "second", path: "a.ts", side: "RIGHT" as const, line: 3 },
      { id: "later", path: "a.ts", side: "RIGHT" as const, line: 12 },
    ];
    expect(nextAnchor(files, at("a.ts", 3), anchors, 1, 1, "first")?.id).toBe("second");
    expect(nextAnchor(files, at("a.ts", 3), anchors, 1, 1, "second")?.id).toBe("later");
    expect(nextAnchor(files, at("a.ts", 3), anchors, -1, 1, "second")?.id).toBe("first");
    expect(nextAnchor(files, at("a.ts", 3), anchors, 1, 1)?.id).toBe("later");
  });

  it("turns a line selection into a comment range in display order, cut to one hunk where GitHub needs it", () => {
    expect(visualRange(unified, at("a.ts", 3), { ...at("a.ts", 2), side: "LEFT" }, true)).toEqual({ line: 3, side: "RIGHT", startLine: 2, startSide: "LEFT" });
    expect(visualRange(unified, at("a.ts", 1), at("a.ts", 12), true)).toEqual({ line: 12, side: "RIGHT", startLine: 10, startSide: "RIGHT" });
    expect(visualRange(unified, at("a.ts", 1), at("a.ts", 12), false)).toEqual({ line: 12, side: "RIGHT", startLine: 1, startSide: "RIGHT" });
    expect(visualRange(unified, at("a.ts", 2), at("a.ts", 2), true)).toEqual({ line: 2, side: "RIGHT", startLine: null, startSide: null });
  });

  it("spans a hunk on its new side unless it only deletes", () => {
    expect(hunkSpanAt(unified, 1)).toEqual({ side: "new", start: 1, stop: 3 });
    expect(hunkSpanAt([{ left: 4, right: null, hunk: 0, changed: true }], 0)).toEqual({ side: "old", start: 4, stop: 4 });
  });

  it("reads counts, prefixes and sequences, and drops keys that cannot make one", () => {
    expect(parseKeys(["j"])).toEqual({ status: "command", command: { kind: "line", direction: 1 }, count: 1 });
    expect(parseKeys(["1", "2", "k"])).toEqual({ status: "command", command: { kind: "line", direction: -1 }, count: 12 });
    expect(parseKeys(["g"])).toEqual({ status: "pending" });
    expect(parseKeys(["3"])).toEqual({ status: "pending" });
    expect(parseKeys(["g", "g"])).toMatchObject({ status: "command", command: { kind: "top" } });
    expect(parseKeys(["F"])).toMatchObject({ status: "command", command: { kind: "findingFilter" } });
    expect(parseKeys(["t"])).toMatchObject({ status: "command", command: { kind: "fileTree" } });
    expect(parseKeys(["T"])).toMatchObject({ status: "command", command: { kind: "target" } });
    expect(parseKeys(["]", "c"])).toMatchObject({ status: "command", command: { kind: "change", direction: 1 } });
    expect(parseKeys(["d", "d"])).toMatchObject({ status: "command", command: { kind: "delete" } });
    expect(parseKeys(["g", "j"])).toEqual({ status: "none" });
    expect(parseKeys(["0"])).toEqual({ status: "none" });
    expect(parseKeys(["q"])).toEqual({ status: "none" });
    expect(parseKeys(["i"])).toMatchObject({ status: "command", command: { kind: "comment" } });
    expect(parseKeys(["a"])).toMatchObject({ status: "command", command: { kind: "reply" } });
    expect(parseKeys(["<CR>"])).toMatchObject({ status: "command", command: { kind: "fold", action: "annotation" } });
    expect(parseKeys(["o"])).toEqual({ status: "none" });
  });

  it("names keys as vim does and leaves ⌘ and ⌥ to the app", () => {
    const key = (init: Partial<KeyboardEventInit> & { key: string }) => keyToken({ ctrlKey: false, metaKey: false, altKey: false, ...init });
    expect([key({ key: "j" }), key({ key: "G" }), key({ key: "d", ctrlKey: true }), key({ key: "Escape" }), key({ key: "ArrowDown" })]).toEqual(["j", "G", "<C-d>", "<Esc>", "<Down>"]);
    expect([key({ key: "d", metaKey: true }), key({ key: "Shift" })]).toEqual([null, null]);
  });

  it("ranks file-name matches above path matches", () => {
    const file = (path: string) => ({ path }) as DiffFile;
    expect(rankFiles([file("src/view/a.ts"), file("lib/view.ts"), file("other.ts")], "view").map((entry) => entry.path)).toEqual(["lib/view.ts", "src/view/a.ts"]);
    expect(rankFiles([file("src/view/a.ts")], "sva").map((entry) => entry.path)).toEqual(["src/view/a.ts"]);
  });
});

describe("threadKeyActions", () => {
  it("offers edit, delete and a move for your unsent comment, and links to where the thread lives", () => {
    const [pending] = buildDiffThreads([local({ id: "c1" })], []);
    expect(threadKeyActions(pending!, true)).toMatchObject({ canReply: true, ownUnsent: { id: "c1" }, moveTo: "github", url: null, agentThread: null });
    expect(threadKeyActions(pending!, false).moveTo).toBeNull();
    const [draft] = buildDiffThreads([local({ id: "d1", target: "github" })], []);
    expect(threadKeyActions(draft!, true).moveTo).toBe("local");
    const [fileLevel] = buildDiffThreads([local({ id: "f1", line: null })], []);
    expect(threadKeyActions(fileLevel!, true).moveTo).toBeNull();
    const [answered] = buildDiffThreads([local({ id: "r1", applyId: "a1" }), local({ id: "r2", inReplyTo: "r1", author: "agent", authorThreadId: "thr_x", createdAt: 5 })], []);
    expect(threadKeyActions(answered!, true)).toMatchObject({ ownUnsent: null, moveTo: null, agentThread: "thr_x" });
  });
});

describe("h into the file list", () => {
  const rows = navRows(patchRows(["@@ -1,2 +1,3 @@", " a", "+b", " c", ""].join("\n")), "split");
  const files: NavFile[] = [{ path: "a.ts", collapsed: false, rows }];
  const run = (cursor: Cursor) => {
    let state = { cursor, visual: null, pending: "", focused: null } as ReturnType<ReviewEnv["keys"]["get"]>;
    const calls: string[] = [];
    const env = {
      keys: { get: () => state, set: (patch: Partial<typeof state>) => (state = { ...state, ...patch }), models: new Map([["a.ts", { rows, cutToHunk: false, element: () => null }]]), threads: new Map(), findings: new Map() },
      files,
      threads: [],
      findings: [],
      onScreen: () => true,
      seat: () => cursor,
      reveal: () => {},
      focusFileTree: () => {
        calls.push("tree");
        return true;
      },
      notify: (message: string) => calls.push(message),
    } as unknown as ReviewEnv;
    runReviewCommand({ kind: "side", side: "LEFT" }, 1, env);
    return { cursor: state.cursor, calls };
  };
  const at = (side: "LEFT" | "RIGHT", line: number | null, want: "LEFT" | "RIGHT" = side): Cursor => ({ path: "a.ts", side, line, want });

  it("moves to the old side first, then into the list", () => {
    expect(run(at("RIGHT", 1))).toEqual({ cursor: at("LEFT", 1), calls: [] });
    expect(run(at("LEFT", 1)).calls).toEqual(["tree"]);
  });

  it("goes straight to the list from a file header", () => {
    expect(run(at("RIGHT", null)).calls).toEqual(["tree"]);
  });

  it("on an added line, the first h only wants the old side and the second enters the list", () => {
    expect(run(at("RIGHT", 2))).toEqual({ cursor: at("RIGHT", 2, "LEFT"), calls: [] });
    expect(run(at("RIGHT", 2, "LEFT")).calls).toEqual(["tree"]);
  });
});
