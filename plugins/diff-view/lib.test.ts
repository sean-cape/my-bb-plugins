import { describe, expect, it, vi } from "vitest";
import { allDiffThreads, localCommentState, threadIsOpen, threadKeyActions } from "./lib/app/comments/threads";
import { shownInline } from "./lib/app/comments/thread-code";
import { fetchChangeTotals, knownChangeTotals } from "./lib/app/change-totals";
import { buildFileTree } from "./lib/app/file-tree/build-file-tree";
import { statusMark } from "./lib/app/file-status";
import { activeReviews, distinctFindings, filterFindings, findingsOutsideDiff, inlineFindingsByPath, nextFindingFilter, parseFindingFilter, resolvedFindings, standingFindings } from "./lib/app/findings/findings";
import { isGeneratedFile, isLargeFile, startsCollapsed } from "./lib/app/generated";
import { riskByPath } from "./lib/app/risk";
import { enclosingDefinition } from "./lib/app/structural/enclosing-definition";
import { detectMoves } from "./lib/app/structural/moves";
import { hunkSpan, structuralRows, visibleRows } from "./lib/app/structural/rows";
import { buildLineAnnotations } from "./lib/app/text/line-annotations";
import { navRows, patchRows, selectionRange } from "./lib/app/text/patch-rows";
import { gapEnter, gapPart, navWithGaps } from "./lib/app/text/patch-gaps";
import { FILE_TREE_KEYMAP, KEY_HELP, OUTSIDE_FINDINGS_KEYMAP, REVIEW_KEYMAP } from "./lib/app/keys/keymap";
import { createKeyReader, keymapConflicts, unboundHelpKeys } from "../vim-mode/lib/index.ts";
import { anchorsAtCursor, hunkSpanAt, lastPosition, moveChange, moveFile, moveHunk, moveLines, nextAnchor, visualRange, type Cursor, type NavFile } from "./lib/app/keys/nav";
import { rankFiles } from "./lib/app/keys/rank-files";
import { runReviewCommand, type ReviewEnv } from "./lib/app/keys/review-commands";
import type { FileNavModel } from "./lib/app/keys/review-keys-context";
import { checkedLineRange, locationLabel, longLineLabel, shortLineLabel } from "./lib/line-range";
import { changedLines, excerptCut, excerptPatch, narrativeCoverage, patchLineKey, refsForUncovered, uncoveredText, type NarrativeRef } from "./lib/narrative";
import { UNCOVERED_STEP_ID, affectedAddress, buildChapters, initialAddress, moveChapter, movePage, narratedFiles } from "./lib/app/narrative/chapters";
import { NARRATIVE_KEY_HELP, NARRATIVE_KEYMAP } from "./lib/app/narrative/narrative-keymap";
import { excerptAnnotations, stepExcerpts } from "./lib/app/narrative/excerpts";
import type { DiffThread } from "./lib/app/comments/threads";
import type { NarrativeRevision, NarrativeStep, NarrativeStory } from "./lib/types";
import { splitUnifiedDiff } from "./lib/server";
import type { DiffComment, DiffFile, Finding, GithubComment, Review, StructuralDiff } from "./lib/types";
import { githubComment, localComment, structural } from "./test-helpers";

const local = (overrides: Partial<DiffComment> & { id: string }): DiffComment => localComment({ path: "x.ts", ...overrides });
const github = (overrides: Partial<GithubComment> & { id: string }): GithubComment => githubComment({ path: "x.ts", ...overrides });

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

describe("allDiffThreads", () => {
  it("puts the root first and replies after it oldest first", () => {
    const threads = allDiffThreads(
      [local({ id: "late", inReplyTo: "root", createdAt: 30 }), local({ id: "root", createdAt: 10 }), local({ id: "early", inReplyTo: "root", createdAt: 20 })],
      [],
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]!.entries.map((entry) => entry.comment.id)).toEqual(["root", "early", "late"]);
  });

  it("interleaves local replies to a GitHub thread by time", () => {
    const threads = allDiffThreads(
      [local({ id: "mine", inReplyTo: "review-comment:1", createdAt: Date.parse("1970-01-01T00:00:02Z") })],
      [github({ id: "review-comment:1" }), github({ id: "review-comment:2", inReplyTo: "review-comment:1", createdAt: "1970-01-01T00:00:03Z" })],
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "review-comment:1", onGithub: true, orphaned: false });
    expect(threads[0]!.entries.map((entry) => `${entry.source}:${entry.comment.id}`)).toEqual(["github:review-comment:1", "local:mine", "github:review-comment:2"]);
  });

  it("shows a posted draft once, as its synced copy", () => {
    const threads = allDiffThreads([local({ id: "draft", target: "github", postedAt: 1, githubCommentId: "review-comment:7" })], [github({ id: "review-comment:7" })]);
    expect(threads.map((thread) => thread.id)).toEqual(["review-comment:7"]);
  });

  it("keeps a posted draft with no synced copy yet, and attaches GitHub replies to it by its GitHub id", () => {
    const threads = allDiffThreads(
      [local({ id: "draft", target: "github", postedAt: 1, githubCommentId: "review-comment:7" })],
      [github({ id: "review-comment:8", inReplyTo: "review-comment:7" })],
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe("draft");
    expect(threads[0]!.entries.map((entry) => entry.comment.id)).toEqual(["draft", "review-comment:8"]);
  });

  it("groups replies whose root is gone into an orphaned thread that cannot be answered", () => {
    const [thread] = allDiffThreads([local({ id: "reply", inReplyTo: "gone", target: "github" })], []);
    expect(thread).toMatchObject({ id: "gone", orphaned: true, onGithub: false });
  });

  it("leaves resolved and outdated GitHub threads out of the diff unless a reply to one is still unsent", () => {
    const inline = (locals: DiffComment[], githubs: GithubComment[]) => allDiffThreads(locals, githubs).filter(shownInline);
    const resolved = github({ id: "review-comment:1", resolved: true });
    const outdated = github({ id: "review-comment:2", outdated: true, line: 12 });
    const open = github({ id: "review-comment:3" });
    const threads = inline([], [resolved, outdated, open]);
    expect(threads.map((thread) => thread.id)).toEqual(["review-comment:3"]);
    expect(threads.map(threadIsOpen)).toEqual([true]);
    expect(inline([local({ id: "reply", inReplyTo: "review-comment:1", target: "github" })], [resolved]).map((thread) => thread.id)).toEqual(["review-comment:1"]);
    const withDraft = inline([local({ id: "reply", inReplyTo: "review-comment:2", target: "github" })], [outdated]);
    expect(withDraft.map((thread) => thread.id)).toEqual(["review-comment:2"]);
    const sent = inline([local({ id: "reply", inReplyTo: "review-comment:2", target: "github", postedAt: 1, githubCommentId: "review-comment:9" })], [outdated]);
    expect(sent).toEqual([]);
  });

  it("drops the lines of an outdated GitHub comment that still shows for its unsent reply", () => {
    const [thread] = allDiffThreads([local({ id: "reply", inReplyTo: "review-comment:1", target: "github" })], [github({ id: "review-comment:1", outdated: true, line: 12, startLine: 10, startSide: "RIGHT" })]);
    expect(thread).toMatchObject({ line: null, startLine: null, startSide: null, outdated: true });
  });

  it("anchors a multi-line comment's thread on its range", () => {
    const [thread] = allDiffThreads([local({ id: "a", line: 14, startLine: 10, startSide: "RIGHT" })], []);
    expect(thread).toMatchObject({ line: 14, side: "RIGHT", startLine: 10, startSide: "RIGHT" });
  });

  it("lets replies go to GitHub only from line comments that are, or will become, inline GitHub comments", () => {
    const onGithub = (comment: DiffComment) => allDiffThreads([comment], [])[0]!.onGithub;
    expect(onGithub(local({ id: "a", target: "github" }))).toBe(true);
    expect(onGithub(local({ id: "a", target: "github", line: null }))).toBe(false);
    expect(onGithub(local({ id: "a", target: "github", postedAt: 1, githubCommentId: "review-comment:1" }))).toBe(true);
    expect(onGithub(local({ id: "a", target: "github", postedAt: 1, githubCommentId: "review:1" }))).toBe(false);
    expect(onGithub(local({ id: "a" }))).toBe(false);
  });

  it("ignores synced comments that are not inline review comments", () => {
    expect(allDiffThreads([], [github({ id: "issue-comment:1", kind: "issue-comment" }), github({ id: "review-comment:2", path: null })])).toEqual([]);
  });
});

describe("threadIsOpen", () => {
  const thread = (locals: DiffComment[], githubs: GithubComment[] = []) => allDiffThreads(locals, githubs)[0]!;
  it("closes addressed threads unless a reply is still unsent, and opens a resolved one shown for its unsent reply", () => {
    expect(threadIsOpen(thread([local({ id: "reply", inReplyTo: "review-comment:1", target: "github" })], [github({ id: "review-comment:1", resolved: true })]))).toBe(true);
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
  it("places a finding at each location with the selection it carries", () => {
    const reviews = [
      review("full", 1, [finding("F1", [{ file: "a.ts", startLine: 5, endLine: 8 }, { file: "b.ts", startLine: null, endLine: null }])], { selection: { F1: true }, selectionOverrides: { F1: true } }),
      review("inc", 2, [finding("F2", [{ file: "a.ts", startLine: 20, endLine: null }])], { sinceCommitSha: "abc", findingEdits: { F2: {} } }),
    ];
    const byPath = inlineFindingsByPath(reviews, null);
    expect(byPath.get("a.ts")!.map((entry) => ({ id: entry.item.finding.id, line: entry.line }))).toEqual([
      { id: "F1", line: 5 },
      { id: "F2", line: 20 },
    ]);
    expect(byPath.get("b.ts")!.map((entry) => entry.line)).toEqual([null]);
    expect(byPath.get("a.ts")![0]!.item).toMatchObject({ selected: true, overridden: true, edited: false });
    expect(byPath.get("a.ts")![1]!.item).toMatchObject({ selected: false, overridden: false, edited: true });
  });
});

describe("inlineFindingsByPath applied findings", () => {
  it("leaves out the findings an apply round fixed and the ones the reviewer resolved", () => {
    const fixed = finding("F1", [{ file: "a.ts", startLine: 1, endLine: 1 }]);
    const open = finding("F2", [{ file: "a.ts", startLine: 9, endLine: 9 }]);
    const elsewhere = finding("F3", [{ file: "b.ts", startLine: 2, endLine: 2 }]);
    const mine = finding("F4", [{ file: "a.ts", startLine: 12, endLine: 12 }]);
    const byPath = inlineFindingsByPath([review("full", 1, [fixed, open, elsewhere, mine], { appliedFindingIds: ["F1", "F3"], resolvedFindingIds: ["F4"] })], null);
    expect(byPath.get("a.ts")!.map(({ item }) => item.finding.id)).toEqual(["F2"]);
    expect(byPath.has("b.ts")).toBe(false);
  });
});

describe("inlineFindingsByPath carry-over", () => {
  it("names the earlier finding a carried one came from", () => {
    const carried = { ...finding("F1", [{ file: "a.ts", startLine: 1, endLine: 1 }]), carriedFrom: "r0/F3" };
    const fresh = finding("F2", [{ file: "a.ts", startLine: 9, endLine: 9 }]);
    const byPath = inlineFindingsByPath([review("inc", 2, [carried, fresh], { sinceCommitSha: "a", report: { findings: [carried, fresh], carriesForward: true } })], null);
    expect(byPath.get("a.ts")!.map(({ item }) => ({ id: item.finding.id, carriedFrom: item.carriedFrom }))).toEqual([
      { id: "F1", carriedFrom: "F3" },
      { id: "F2", carriedFrom: null },
    ]);
  });
});

describe("findings across pushes", () => {
  const reviewed = "a".repeat(40);
  // Since the review: two lines inserted after line 3 of a.ts, and line 10 changed.
  const delta = (fromSha: string) => ({
    fromSha,
    toSha: "f".repeat(40),
    files: [{ path: "a.ts", status: "modified", additions: 3, deletions: 1, ranges: [[4, 5], [12, 12]] as Array<[number, number]>, blocks: [[4, 0, 4, 2], [10, 1, 12, 1]] as Array<[number, number, number, number]> }],
  });
  const reviews = [
    review(
      "one",
      1,
      [
        { ...finding("F1", [{ file: "a.ts", startLine: 2, endLine: 2 }]) },
        { ...finding("F2", [{ file: "a.ts", startLine: 6, endLine: 7 }]), suggestion: { file: "a.ts", startLine: 6, endLine: 7, replacement: "x" } },
        finding("F3", [{ file: "a.ts", startLine: 10, endLine: 10 }]),
        finding("F4", [{ file: "a.ts", startLine: 10, endLine: 10 }, { file: "b.ts", startLine: 3, endLine: 3 }]),
      ],
      { commitSha: reviewed },
    ),
  ];

  it("moves a finding with the lines added above it, and its suggestion with it", () => {
    const { inline } = standingFindings(reviews, delta("aaaaaaa"));
    expect(inline.get("a.ts")!.map(({ item, line }) => `${item.finding.id}:${line}`)).toEqual(["F1:2", "F2:8"]);
    expect(inline.get("a.ts")![1]!.item.finding.suggestion).toMatchObject({ startLine: 8, endLine: 9 });
  });

  it("calls a finding outdated when the code under it changed, keeping the locations that still stand", () => {
    const { inline, outdated } = standingFindings(reviews, delta(reviewed));
    expect(outdated.map(({ finding: entry }) => entry.id)).toEqual(["F3"]);
    expect(inline.get("b.ts")!.map(({ item }) => item.finding.id)).toEqual(["F4"]);
    expect(inline.get("b.ts")![0]!.item.finding.locations).toEqual([{ file: "b.ts", startLine: 3, endLine: 3 }]);
  });

  it("leaves findings where they were when the delta counts from another commit", () => {
    const { inline, outdated } = standingFindings(reviews, delta("b".repeat(40)));
    expect(outdated).toEqual([]);
    expect(inline.get("a.ts")!.map(({ item, line }) => `${item.finding.id}:${line}`)).toEqual(["F1:2", "F2:6", "F3:10", "F4:10"]);
  });

  it("lists what closed each resolved finding: the reviewer, an apply round, or a re-review", () => {
    const history = [
      review("one", 1, [finding("F1", []), finding("F2", []), finding("F3", [])], { commitSha: reviewed, resolvedFindingIds: ["F1"], appliedFindingIds: ["F2"] }),
      review("two", 2, [finding("F1", [])], {
        commitSha: "b".repeat(40),
        sinceCommitSha: reviewed,
        appliedFindingIds: ["F1"],
        report: { findings: [{ ...finding("F1", []), carriedFrom: "one/F3" }], carriesForward: true, resolved: [{ id: "one/F2", title: "", note: "guarded" }] },
      }),
    ];
    expect(resolvedFindings(history).map(({ reviewId, findingId, by, note }) => ({ reviewId, findingId, by, note }))).toEqual([
      { reviewId: "two", findingId: "F1", by: "applied", note: null },
      { reviewId: "one", findingId: "F2", by: "fixed", note: "guarded" },
      { reviewId: "one", findingId: "F1", by: "you", note: null },
    ]);
  });
});

describe("findings outside the diff", () => {
  it("keeps pre-existing findings out of the diff and lists them, open ones only, with every active review's filtered findings", () => {
    const old = { ...finding("F2", [{ file: "a.ts", startLine: 40, endLine: 41 }], "critical"), preExisting: true };
    const fixedOld = { ...finding("F3", [{ file: "c.ts", startLine: 1, endLine: 1 }]), preExisting: true };
    const doubted = { ...finding("X1", [{ file: "a.ts", startLine: 2, endLine: 2 }], "important"), confidence: 30 };
    const later = { ...finding("X1", []), confidence: 10 };
    const reviews = [
      review("full", 1, [finding("F1", [{ file: "a.ts", startLine: 1, endLine: 1 }]), old, fixedOld], { appliedFindingIds: ["F3"], report: { findings: [finding("F1", [{ file: "a.ts", startLine: 1, endLine: 1 }]), old, fixedOld], filtered: [doubted] } }),
      review("inc", 2, [], { sinceCommitSha: "a", report: { findings: [], filtered: [later] } }),
    ];
    expect(inlineFindingsByPath(reviews, null).get("a.ts")!.map(({ item }) => item.finding.id)).toEqual(["F1"]);
    const outside = findingsOutsideDiff(reviews);
    expect(outside.preExisting.map(({ reviewId, finding: entry }) => `${reviewId}/${entry.id}`)).toEqual(["full/F2"]);
    expect(outside.filtered.map(({ reviewId, finding: entry }) => `${reviewId}/${entry.id}`)).toEqual(["full/X1", "inc/X1"]);
  });

  it("lists only a carrying-forward re-review's own filtered findings, since it stands for the reviews before it", () => {
    const reviews = [
      review("full", 1, [], { report: { findings: [], filtered: [finding("X1", [])] } }),
      review("inc", 2, [], { sinceCommitSha: "a", report: { findings: [], filtered: [finding("X1", [])] } }),
      review("carried", 3, [], { sinceCommitSha: "b", report: { findings: [], filtered: [finding("X2", [])], carriesForward: true } }),
    ];
    expect(findingsOutsideDiff(reviews).filtered.map(({ reviewId, finding: entry }) => `${reviewId}/${entry.id}`)).toEqual(["carried/X2"]);
  });

  it("finds nothing in reviews from before verification", () => {
    expect(findingsOutsideDiff([review("full", 1, [finding("F1", [])])])).toEqual({ preExisting: [], filtered: [] });
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
  const threads = allDiffThreads([local({ id: "a", line: 3 }), local({ id: "file", line: null }), local({ id: "b", line: 9, side: "LEFT" })], []);
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
    const added = allDiffThreads([local({ id: "a", line: 3 }), local({ id: "file", line: null }), local({ id: "b", line: 9, side: "LEFT" }), local({ id: "c", line: 3 })], []);
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
      narrative: { id: "n", threadId: "t", status: "completed" as const, createdAt: 0, report: { summary: "", watchOut: [], readingOrder: [{ path: "a.ts", role: "key" as const, note: "", lines: [], risk: 2, changes: [] }], steps: [], revision: null } },
    };
    expect(Object.fromEntries(riskByPath(tour, findings))).toEqual({ "a.ts": 2, "b.ts": 4 });
    expect(Object.fromEntries(riskByPath({ ...tour, stale: true }, findings))).toEqual({ "a.ts": 5, "b.ts": 4 });
  });
});

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

describe("statusMark", () => {
  it("marks added, deleted, renamed, and copied files, and leaves modifications plain", () => {
    const marks = ["added", "removed", "renamed", "copied", "modified", "changed"].map((status) => statusMark({ ...file("a.ts"), status })?.letter ?? null);
    expect(marks).toEqual(["A", "D", "R", "C", null, null]);
  });

  it("names where a rename came from", () => {
    expect(statusMark({ ...file("b.ts"), status: "renamed", previousPath: "a.ts" })?.label).toBe("Renamed from a.ts");
  });
});

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
  it("recognises every file sqlc writes, but not the queries, schema and store code around them", () => {
    const sqlc = "internal/storage/sql/sqlc";
    for (const name of ["partner.sql.go", "models.go", "db.go", "querier.go", "copyfrom.go", "batch.go"]) {
      expect(isGeneratedFile(file(`${sqlc}/${name}`)), name).toBe(true);
    }
    for (const path of ["internal/storage/sql/queries/partner.sql", "migrations/0001_init.sql", "internal/storage/sql/store.go", "internal/storage/sqlc_adapter.go"]) {
      expect(isGeneratedFile(file(path)), path).toBe(false);
    }
  });
});

describe("startsCollapsed", () => {
  it("collapses files with over a thousand changed lines, counting both sides", () => {
    expect(isLargeFile(file("src/app.ts", 1000, 0))).toBe(false);
    expect(isLargeFile(file("src/app.ts", 1001, 0))).toBe(true);
    expect(isLargeFile(file("src/app.ts", 600, 401))).toBe(true);
    expect(startsCollapsed(file("src/app.ts", 600, 401))).toBe(true);
    expect(startsCollapsed(file("pnpm-lock.yaml", 1, 0))).toBe(true);
    expect(startsCollapsed(file("src/app.ts", 999, 1))).toBe(false);
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
    const read = (tokens: string[]) => {
      const reader = createKeyReader(REVIEW_KEYMAP, { counts: true });
      return tokens.map((token) => reader.read(token, 0)).at(-1);
    };
    expect(read(["j"])).toMatchObject({ kind: "command", command: { kind: "line", direction: 1 }, count: null });
    expect(read(["1", "2", "k"])).toMatchObject({ kind: "command", command: { kind: "line", direction: -1 }, count: 12 });
    expect(read(["g"])).toEqual({ kind: "pending", keys: "g" });
    expect(read(["3"])).toEqual({ kind: "pending", keys: "3" });
    expect(read(["g", "g"])).toMatchObject({ kind: "command", command: { kind: "top" } });
    expect(read(["F"])).toMatchObject({ kind: "command", command: { kind: "findingFilter" } });
    expect(read(["t"])).toMatchObject({ kind: "command", command: { kind: "fileTree" } });
    expect(read(["T"])).toMatchObject({ kind: "command", command: { kind: "target" } });
    expect(read(["]", "c"])).toMatchObject({ kind: "command", command: { kind: "change", direction: 1 } });
    expect(read(["d", "d"])).toMatchObject({ kind: "command", command: { kind: "delete" } });
    expect(read(["g", "j"])).toMatchObject({ kind: "command", command: { kind: "line", direction: 1 } });
    expect(read(["0"])).toEqual({ kind: "none" });
    expect(read(["q"])).toEqual({ kind: "none" });
    expect(read(["i"])).toMatchObject({ kind: "command", command: { kind: "comment" } });
    expect(read(["a"])).toMatchObject({ kind: "command", command: { kind: "reply" } });
    expect(read(["<CR>"])).toMatchObject({ kind: "command", command: { kind: "fold", action: "annotation" } });
    expect(read(["o"])).toEqual({ kind: "none" });
    expect(read(["g", "F"])).toMatchObject({ kind: "command", command: { kind: "filteredFindings" } });
    expect(read(["g", "p"])).toMatchObject({ kind: "command", command: { kind: "outsideFindings" } });
    expect(keymapConflicts(REVIEW_KEYMAP)).toEqual([]);
  });

  it("ranks file-name matches above path matches", () => {
    const file = (path: string) => ({ path }) as DiffFile;
    expect(rankFiles([file("src/view/a.ts"), file("lib/view.ts"), file("other.ts")], "view").map((entry) => entry.path)).toEqual(["lib/view.ts", "src/view/a.ts"]);
    expect(rankFiles([file("src/view/a.ts")], "sva").map((entry) => entry.path)).toEqual(["src/view/a.ts"]);
  });
});

describe("threadKeyActions", () => {
  it("offers edit, delete and a move for your unsent comment, and links to where the thread lives", () => {
    const [pending] = allDiffThreads([local({ id: "c1" })], []);
    expect(threadKeyActions(pending!, true)).toMatchObject({ canReply: true, canResolve: false, ownUnsent: { id: "c1" }, moveTo: "github", url: null, agentThread: null });
    const [onGithub] = allDiffThreads([], [github({ id: "review-comment:1" })]);
    expect(threadKeyActions(onGithub!, true)).toMatchObject({ canResolve: true, url: "https://github.invalid/c" });
    const [orphan] = allDiffThreads([], [github({ id: "review-comment:2", inReplyTo: "review-comment:gone" })]);
    expect(threadKeyActions(orphan!, true)).toMatchObject({ canReply: false, canResolve: false });
    expect(threadKeyActions(pending!, false).moveTo).toBeNull();
    const [draft] = allDiffThreads([local({ id: "d1", target: "github" })], []);
    expect(threadKeyActions(draft!, true).moveTo).toBe("local");
    const [fileLevel] = allDiffThreads([local({ id: "f1", line: null })], []);
    expect(threadKeyActions(fileLevel!, true).moveTo).toBeNull();
    const [answered] = allDiffThreads([local({ id: "r1", applyId: "a1" }), local({ id: "r2", inReplyTo: "r1", author: "agent", authorThreadId: "thr_x", createdAt: 5 })], []);
    expect(threadKeyActions(answered!, true)).toMatchObject({ ownUnsent: null, moveTo: null, agentThread: "thr_x" });
  });
});

describe("keys for the findings outside the diff", () => {
  const rows = navRows(patchRows(["@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n")), "split");
  const cursor: Cursor = { path: "a.ts", side: "RIGHT", line: 1, want: "RIGHT" };
  const run = (command: Parameters<typeof runReviewCommand>[0], extra: Partial<ReviewEnv>) => {
    let state = { cursor, visual: null, pending: "", focused: null } as ReturnType<ReviewEnv["keys"]["get"]>;
    const notes: string[] = [];
    const env = {
      keys: { get: () => state, set: (patch: Partial<typeof state>) => (state = { ...state, ...patch }), models: new Map([["a.ts", { rows, cutToHunk: false, element: () => null }]]), threads: new Map(), findings: new Map() },
      files: [{ path: "a.ts", collapsed: false, rows }],
      threads: [],
      findings: [],
      onScreen: () => true,
      seat: () => cursor,
      reveal: () => {},
      notify: (message: string) => notes.push(message),
      ...extra,
    } as unknown as ReviewEnv;
    runReviewCommand(command, 1, env);
    return notes;
  };

  it("gF says when nothing was filtered, and otherwise folds or unfolds the filtered findings", () => {
    expect(run({ kind: "filteredFindings" }, { filteredFindings: null })).toEqual(["The review filtered out no findings"]);
    const set = vi.fn();
    expect(run({ kind: "filteredFindings" }, { filteredFindings: { open: false, set } })).toEqual(["Filtered findings listed above the diff"]);
    expect(set).toHaveBeenLastCalledWith(true);
    expect(run({ kind: "filteredFindings" }, { filteredFindings: { open: true, set } })).toEqual(["Filtered findings folded"]);
    expect(set).toHaveBeenLastCalledWith(false);
  });

  it("gp moves into the list, or says there is none", () => {
    expect(run({ kind: "outsideFindings" }, { focusOutsideFindings: () => false })).toEqual(["No outdated, resolved, pre-existing or filtered findings"]);
    expect(run({ kind: "outsideFindings" }, { focusOutsideFindings: () => true })).toEqual([]);
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

describe("file list keys", () => {
  const read = (tokens: string[]) => {
    const reader = createKeyReader(FILE_TREE_KEYMAP, { counts: true });
    return tokens.map((token) => reader.read(token, 0)).at(-1);
  };

  it("moves over rows with counts, and keeps a count typed in the list from reaching the diff", () => {
    expect(read(["j"])).toMatchObject({ kind: "command", command: { kind: "list", motion: "down" } });
    expect(read(["3", "k"])).toMatchObject({ kind: "command", command: { kind: "list", motion: "up" }, count: 3 });
    expect(read(["5"])).toEqual({ kind: "pending", keys: "5" });
    expect(read(["g", "g"])).toMatchObject({ kind: "command", command: { kind: "list", motion: "top" } });
    expect(read(["<C-d>"])).toMatchObject({ kind: "command", command: { kind: "scroll", step: 1 } });
    expect(read(["<Esc>"])).toMatchObject({ kind: "command", command: { kind: "leave" } });
    expect(read(["t"])).toMatchObject({ kind: "command", command: { kind: "hide" } });
    expect(keymapConflicts(FILE_TREE_KEYMAP)).toEqual([]);
    expect(keymapConflicts(OUTSIDE_FINDINGS_KEYMAP)).toEqual([]);
  });

  it("leaves the diff's search and help keys to the diff", () => {
    expect(read(["/"])).toEqual({ kind: "none" });
    expect(read(["?"])).toEqual({ kind: "none" });
    expect(read(["2", "?"])).toEqual({ kind: "none" });
  });

  it("lists only keys the diff or the file list binds", () => {
    expect(unboundHelpKeys(KEY_HELP, [REVIEW_KEYMAP, FILE_TREE_KEYMAP], ["⌘↩"])).toEqual([]);
  });
});

describe("review commands before there is a line", () => {
  const run = (command: Parameters<typeof runReviewCommand>[0], overrides: Partial<ReviewEnv> = {}, models = new Map()) => {
    let state = { cursor: null, visual: null, pending: "", focused: null } as ReturnType<ReviewEnv["keys"]["get"]>;
    const calls: string[] = [];
    const env = {
      keys: { get: () => state, set: (patch: Partial<typeof state>) => (state = { ...state, ...patch }), models, threads: new Map(), findings: new Map() },
      files: [],
      threads: [],
      findings: [],
      target: null,
      findingFilter: null,
      seat: () => null,
      onScreen: () => null,
      openOverlay: (overlay: string) => calls.push(`overlay:${overlay}`),
      refresh: () => calls.push("refresh"),
      toggleFileTree: () => calls.push("fileTree"),
      toggleLayout: () => calls.push("layout"),
      focusSendBar: () => false,
      leaveSendBar: () => false,
      closeEmptyComposer: () => calls.push("closeComposer") > 0,
      notify: (message: string) => calls.push(message),
      ...overrides,
    } as unknown as ReviewEnv;
    runReviewCommand(command, 1, env);
    return { calls, state };
  };

  it("opens the help and the file list, refreshes, and switches the layout while the diff is empty or loading", () => {
    expect(run({ kind: "help" }).calls).toEqual(["overlay:help"]);
    expect(run({ kind: "refresh" }).calls).toEqual(["refresh"]);
    expect(run({ kind: "fileTree" }).calls).toEqual(["fileTree"]);
    expect(run({ kind: "layout" }).calls).toEqual(["layout"]);
    expect(run({ kind: "send" }).calls).toEqual(["No comments waiting to be sent"]);
    expect(run({ kind: "escape" }).calls).toEqual(["closeComposer"]);
  });

  it("searches file names only once there are files to search", () => {
    expect(run({ kind: "findFile" }).calls).toEqual(["No changed files to search"]);
    expect(run({ kind: "findFile" }, { files: [{ path: "a.ts", collapsed: false, rows: null }] }).calls).toEqual(["overlay:files"]);
  });

  it("does nothing for line motions with no line to stand on", () => {
    expect(run({ kind: "line", direction: 1 })).toEqual({ calls: [], state: { cursor: null, visual: null, pending: "", focused: null } });
  });
});

describe("Escape", () => {
  const peekModel = (open: { value: boolean }): FileNavModel => ({
    rows: [],
    cutToHunk: false,
    element: () => null,
    symbols: {
      at: () => [],
      peek: () => {},
      close: () => {
        const was = open.value;
        open.value = false;
        return was;
      },
    },
  });
  const run = (models: Map<string, FileNavModel>, visual: Cursor | null, leaveSendBar = false) => {
    let state = { cursor: null, visual, pending: "", focused: null } as ReturnType<ReviewEnv["keys"]["get"]>;
    const calls: string[] = [];
    const env = {
      keys: { get: () => state, set: (patch: Partial<typeof state>) => (state = { ...state, ...patch }), models, threads: new Map(), findings: new Map() },
      files: [],
      leaveSendBar: () => leaveSendBar && calls.push("sendBar") > 0,
      closeEmptyComposer: () => calls.push("closeComposer") > 0,
    } as unknown as ReviewEnv;
    runReviewCommand({ kind: "escape" }, 1, env);
    return { calls, visual: state.visual };
  };
  const visual: Cursor = { path: "a.ts", side: "RIGHT", line: 1, want: "RIGHT" };

  it("closes every open symbol peek and does nothing else", () => {
    const first = { value: true };
    const second = { value: true };
    const models = new Map<string, FileNavModel>([["a.ts", peekModel(first)], ["b.ts", peekModel(second)], ["c.ts", { rows: [], cutToHunk: false, element: () => null }]]);
    expect(run(models, visual, true)).toEqual({ calls: [], visual });
    expect([first.value, second.value]).toEqual([false, false]);
  });

  it("with no peek open, leaves the send bar, then the line selection, then closes an empty comment box", () => {
    const models = new Map([["a.ts", peekModel({ value: false })]]);
    expect(run(models, visual, true)).toEqual({ calls: ["sendBar"], visual });
    expect(run(models, visual)).toEqual({ calls: [], visual: null });
    expect(run(models, null)).toEqual({ calls: ["closeComposer"], visual: null });
  });
});

describe("fetchChangeTotals", () => {
  const file = (path: string, insertions: number | null, deletions: number | null) => ({ path, insertions, deletions });
  const sdkReturning = (status: unknown) => {
    const calls: string[] = [];
    const sdk = {
      environments: {
        status: async ({ environmentId }: { environmentId: string }) => {
          calls.push(environmentId);
          return status;
        },
      },
    } as unknown as Parameters<typeof fetchChangeTotals>[0];
    return { sdk, calls };
  };

  it("counts a file changed in both the branch and the working tree once, with its working-tree numbers", async () => {
    const { sdk } = sdkReturning({
      outcome: "available",
      workspace: {
        mergeBase: { files: [file("a.ts", 5, 1), file("b.ts", 2, null)] },
        workingTree: { files: [file("a.ts", 7, 3), file("c.ts", null, 4)] },
      },
    });
    expect(await fetchChangeTotals(sdk, "thr_count", "env_1", "env_1:1")).toEqual({ files: 3, additions: 9, deletions: 7 });
    expect(knownChangeTotals("thr_count")).toEqual({ files: 3, additions: 9, deletions: 7 });
  });

  it("asks once while the same thread update is in flight", async () => {
    const { sdk, calls } = sdkReturning({ outcome: "available", workspace: { mergeBase: null, workingTree: { files: [file("a.ts", 1, 0)] } } });
    await Promise.all([fetchChangeTotals(sdk, "thr_dedupe", "env_1", "env_1:1"), fetchChangeTotals(sdk, "thr_dedupe", "env_1", "env_1:1")]);
    expect(calls).toEqual(["env_1"]);
    await fetchChangeTotals(sdk, "thr_dedupe", "env_1", "env_1:2");
    expect(calls).toEqual(["env_1", "env_1"]);
  });

  it("treats an unavailable status as no changes", async () => {
    const { sdk } = sdkReturning({ outcome: "not_applicable", message: "no git" });
    expect(await fetchChangeTotals(sdk, "thr_none", "env_1", "env_1:1")).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(knownChangeTotals("thr_none")?.files).toBe(0);
  });

  it("knows nothing about a thread no button has fetched", () => {
    expect(knownChangeTotals("thr_unseen")).toBeNull();
  });
});

describe("narrative coverage", () => {
  // old 10..14 → new 10..15: line 11 replaced by two lines, line 13 deleted.
  const patch = ["@@ -10,5 +10,5 @@ func run() {", " a", "-b", "+b1", "+b2", " c", "-d", " e"].join("\n");
  const file = { path: "x.go", previousPath: null, patch };

  it("lists deleted lines by old number and added lines by new number", () => {
    expect(changedLines(patch)).toEqual({ old: [11, 13], new: [11, 12] });
  });

  it("reports what no ref covers, per side, and paths outside the diff", () => {
    const coverage = narrativeCoverage([file], [
      { path: "x.go", side: "new", startLine: 11, endLine: 12 },
      { path: "nope.go", side: "new", startLine: 1, endLine: 1 },
    ]);
    expect(coverage.uncovered).toEqual([{ path: "x.go", wholeFile: false, old: [[11, 11], [13, 13]], new: [] }]);
    expect(coverage.unknownPaths).toEqual(["nope.go"]);
    expect(coverage).toMatchObject({ changedLines: 4, coveredLines: 2 });
    expect(uncoveredText(patch, [[11, 13]], [])).toEqual(["-11 b", "-13 d"]);
  });

  it("counts a whole-file ref for both sides, and needs one for a file with no patch", () => {
    expect(narrativeCoverage([file], [{ path: "x.go", side: "new", startLine: null, endLine: null }]).uncovered).toEqual([]);
    const binary = { path: "logo.png", previousPath: null, patch: null };
    expect(narrativeCoverage([binary], []).uncovered).toEqual([{ path: "logo.png", wholeFile: true, old: [], new: [] }]);
    expect(refsForUncovered(narrativeCoverage([file, binary], []).uncovered)).toEqual([
      { path: "x.go", side: "old", startLine: 11, endLine: 11 },
      { path: "x.go", side: "old", startLine: 13, endLine: 13 },
      { path: "x.go", side: "new", startLine: 11, endLine: 12 },
      { path: "logo.png", side: "new", startLine: null, endLine: null },
    ]);
  });

  it("matches a renamed file's refs under either name", () => {
    expect(narrativeCoverage([{ ...file, path: "y.go", previousPath: "x.go" }], [{ path: "x.go", side: "new", startLine: null, endLine: null }]).uncovered).toEqual([]);
  });

  it("cuts an excerpt of the referenced rows with recounted headers, leaving unreferenced changes out", () => {
    expect(excerptPatch(patch, [{ path: "x.go", side: "old", startLine: 13, endLine: 13 }], 1)).toBe(["@@ -12,3 +13,2 @@", " c", "-d", " e"].join("\n"));
    // The replaced line's two sides, with one line of context; the deletion further down is another step's.
    expect(excerptPatch(patch, [{ path: "x.go", side: "old", startLine: 11, endLine: 11 }, { path: "x.go", side: "new", startLine: 11, endLine: 12 }], 1)).toBe(
      ["@@ -10,3 +10,4 @@", " a", "-b", "+b1", "+b2", " c"].join("\n"),
    );
    expect(excerptPatch(patch, [{ path: "x.go", side: "new", startLine: 40, endLine: 41 }])).toBeNull();
    expect(excerptPatch(patch, [{ path: "x.go", side: "new", startLine: null, endLine: null }])).toBe(patch);
  });

  it("starts a zero-context hunk's empty side after the line its header names", () => {
    expect(excerptPatch(["@@ -5,0 +6,2 @@", "+x", "+y"].join("\n"), [{ path: "a", side: "new", startLine: 7, endLine: 7 }], 0)).toBe(["@@ -5,0 +7,1 @@", "+y"].join("\n"));
    expect(excerptPatch(["@@ -3,2 +2,0 @@", "-x", "-y"].join("\n"), [{ path: "a", side: "old", startLine: 4, endLine: 4 }], 0)).toBe(["@@ -4,1 +2,0 @@", "-y"].join("\n"));
  });

  it("keeps a no-newline marker with its line", () => {
    const eof = ["@@ -1 +1 @@", "-c", "\\ No newline at end of file", "+c"].join("\n");
    expect(changedLines(eof)).toEqual({ old: [1], new: [1] });
    expect(excerptPatch(eof, [{ path: "a", side: "old", startLine: 1, endLine: 1 }], 0)).toBe(["@@ -1,1 +0,0 @@", "-c", "\\ No newline at end of file"].join("\n"));
  });

  it("sends a ref to a recreated path to the new file, not the one renamed away from it", () => {
    const renamed = { path: "b.ts", previousPath: "a.ts", patch: "@@ -1 +1 @@\n-x\n+y" };
    const recreated = { path: "a.ts", previousPath: null, patch: "@@ -0,0 +1 @@\n+z" };
    expect(narrativeCoverage([renamed, recreated], [{ path: "a.ts", side: "new", startLine: null, endLine: null }]).uncovered.map((file) => file.path)).toEqual(["b.ts"]);
  });

  it("gives a pure insertion an old count of zero after the line it follows", () => {
    const insertion = ["@@ -3,2 +3,4 @@", " x", "+y", "+z", " w"].join("\n");
    expect(excerptPatch(insertion, [{ path: "a", side: "new", startLine: 4, endLine: 5 }], 0)).toBe(["@@ -3,0 +4,2 @@", "+y", "+z"].join("\n"));
  });

  it("reports the rows a cut leaves out between two runs, and keeps the ones the reader reveals", () => {
    // Three context lines, then 26 added lines (new 66–91); the step names 66–70 and 86–91.
    const added = Array.from({ length: 26 }, (_, index) => `+line ${66 + index}`);
    const insertion = ["@@ -63,3 +63,29 @@", " a", " b", " c", ...added].join("\n");
    const refs: NarrativeRef[] = [
      { path: "a", side: "new", startLine: 66, endLine: 70 },
      { path: "a", side: "new", startLine: 86, endLine: 91 },
    ];
    const hidden = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => ({ old: null, new: from + index }));
    const cut = excerptCut(insertion, refs);
    expect(cut.patch?.split("\n").filter((line) => line.startsWith("@@"))).toEqual(["@@ -63,3 +63,8 @@", "@@ -65,0 +86,6 @@"]);
    expect(cut.gaps).toEqual([{ after: { old: null, new: 70 }, before: { old: null, new: 86 }, hidden: hidden(71, 85), unchanged: 0 }]);
    const some = excerptCut(insertion, refs, { revealed: new Set(hidden(71, 75).map(patchLineKey)) });
    expect(some.gaps).toEqual([{ after: { old: null, new: 75 }, before: { old: null, new: 86 }, hidden: hidden(76, 85), unchanged: 0 }]);
    const all = excerptCut(insertion, refs, { revealed: new Set(hidden(71, 85).map(patchLineKey)) });
    expect(all.gaps).toEqual([]);
    expect(all.patch?.split("\n")[0]).toBe("@@ -63,3 +63,29 @@");
  });

  it("counts the unchanged lines between two hunks, and leaves a gap at either end only when it hides rows", () => {
    const twoHunks = ["@@ -1,2 +1,2 @@", "-a", "+A", " b", "@@ -10,2 +10,2 @@", " c", "-d", "+D"].join("\n");
    expect(excerptCut(twoHunks, [{ path: "a", side: "new", startLine: null, endLine: null }]).gaps).toEqual([
      { after: { old: 2, new: 2 }, before: { old: 10, new: 10 }, hidden: [], unchanged: 7 },
    ]);
    expect(excerptCut(patch, [{ path: "x.go", side: "old", startLine: 13, endLine: 13 }], { context: 0 }).gaps).toEqual([
      {
        after: null,
        before: { old: 13, new: null },
        hidden: [
          { old: 10, new: 10 },
          { old: 11, new: null },
          { old: null, new: 11 },
          { old: null, new: 12 },
          { old: 12, new: 13 },
        ],
        unchanged: 0,
      },
      { after: { old: 13, new: null }, before: null, hidden: [{ old: 14, new: 14 }], unchanged: 0 },
    ]);
  });
});

describe("excerpt gaps", () => {
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => ({ old: null, new: from + index }));
  const row = (right: number, hunk: number) => ({ left: null, right, hunk, changed: true });

  it("puts a fold after the row the gap follows, at the top for a leading one, on the line it opens first", () => {
    const rows = [row(66, 0), row(70, 0), row(86, 1)];
    const gaps = [
      { after: null, before: { old: null, new: 66 }, hidden: lines(60, 65), unchanged: 0 },
      { after: { old: null, new: 70 }, before: { old: null, new: 86 }, hidden: lines(71, 85), unchanged: 0 },
      // Lines between hunks only: a band with nothing to open, so no fold.
      { after: { old: null, new: 86 }, before: { old: 100, new: 100 }, hidden: [], unchanged: 13 },
    ];
    const { rows: nav, gapAt } = navWithGaps(rows, gaps);
    expect(nav.map((entry) => [entry.right, entry.hunk, entry.expander === true])).toEqual([
      [65, -1, true],
      [66, 0, false],
      [70, 0, false],
      [71, 0, true],
      [86, 1, false],
    ]);
    expect([...gapAt]).toEqual([
      [0, 0],
      [3, 1],
    ]);
    // The fold keeps the hunk above it, so the hunk below still starts at its first row.
    expect(moveHunk([{ path: "a", collapsed: false, rows: nav }], { path: "a", side: "RIGHT", line: 66, want: "RIGHT" }, 1, 1)).toMatchObject({ line: 86 });
    // The top fold has no hunk to explain, and the last line is the last one shown, not a fold under it.
    expect(hunkSpanAt(nav, 0)).toBeNull();
    const trailing = navWithGaps(rows, [{ after: { old: null, new: 86 }, before: null, hidden: lines(87, 90), unchanged: 0 }]).rows;
    expect(lastPosition([{ path: "a", collapsed: false, rows: trailing }], "RIGHT")).toMatchObject({ line: 86 });
  });

  it("opens a short gap whole and a long one a step at a time toward the code", () => {
    const short = { after: { old: null, new: 70 }, before: { old: null, new: 86 }, hidden: lines(71, 85), unchanged: 0 };
    expect(gapEnter(short)).toEqual({ reveal: lines(71, 85), cursor: { old: null, new: 71 } });
    const long = { ...short, hidden: lines(71, 100) };
    expect(gapEnter(long)).toEqual({ reveal: lines(71, 90), cursor: { old: null, new: 91 } });
    expect(gapEnter({ ...long, after: null })).toEqual({ reveal: lines(81, 100), cursor: { old: null, new: 80 } });
    expect(gapPart(long, "last")).toEqual(lines(81, 100));
    // A step stops where the patch's hunk does: rows 71–75, then 13 unchanged lines, then rows 89–120.
    const split = { ...short, hidden: [...lines(71, 75), ...lines(89, 120)] };
    expect(gapEnter(split)).toEqual({ reveal: lines(71, 75), cursor: { old: null, new: 89 } });
    expect(gapPart(split, "last")).toEqual(lines(101, 120));
  });
});

describe("narrative chapters", () => {
  const patch = ["@@ -1,2 +1,2 @@", "-a", "+b", " c"].join("\n");
  const step = (id: string, refs: NarrativeStep["refs"], affects: string[] = []): NarrativeStep => ({ id, title: id, body: "", refs, affects });
  const revision = (id: string, head: string, steps: NarrativeStep[], extra: Partial<NarrativeRevision> = {}, chapter: { summary: string; steps: NarrativeStep[] } | null = null): NarrativeRevision => ({
    narrative: { id, threadId: `t-${id}`, status: "completed", createdAt: 0, report: { summary: `summary ${id}`, readingOrder: [], watchOut: [], steps, revision: chapter } },
    head,
    dirty: false,
    previousId: null,
    files: [{ path: "x.ts", previousPath: null, patch }],
    delta: null,
    ...extra,
  });
  const both = [step("swap", [{ path: "x.ts", side: "old", startLine: 1, endLine: 1 }, { path: "x.ts", side: "new", startLine: 1, endLine: 1 }])];
  const story: NarrativeStory = {
    revisions: [
      revision("n1", "1111111aaa", [step("swap-new", [{ path: "x.ts", side: "new", startLine: 1, endLine: 1 }])]),
      revision("n2", "2222222bbb", both, { previousId: "n1", delta: { fromHead: "1111111aaa", toHead: "2222222bbb", files: [{ path: "x.ts", previousPath: null, patch }], note: null } }, { summary: "why", steps: [step("fix", [{ path: "x.ts", side: "old", startLine: 1, endLine: 1 }], ["swap"])] }),
    ],
    running: null,
    stale: false,
  };
  const chapters = buildChapters(story);

  it("orders an earlier narrative, the revision that follows it, then the current one", () => {
    expect(chapters.map((chapter) => [chapter.kind, chapter.current, chapter.title])).toEqual([
      ["narrative", false, "Earlier narrative at 1111111"],
      ["revision", false, "What changed: 1111111 → 2222222"],
      ["narrative", true, "Narrative at 2222222"],
    ]);
  });

  it("adds a not-narrated step for lines the agent skipped, in narratives and revisions alike", () => {
    expect(chapters[0]!.steps.map((entry) => entry.id)).toEqual(["swap-new", UNCOVERED_STEP_ID]);
    expect(chapters[0]!.steps[1]!.refs).toEqual([{ path: "x.ts", side: "old", startLine: 1, endLine: 1 }]);
    expect(chapters[1]!.steps.map((entry) => entry.id)).toEqual(["fix", UNCOVERED_STEP_ID]);
    expect(chapters[2]!.steps.map((entry) => entry.id)).toEqual(["swap"]);
    expect(chapters[2]!.coverage).toMatchObject({ changedLines: 2, coveredLines: 2 });
  });

  it("opens on the newest revision, or where the reader left off", () => {
    expect(initialAddress(chapters, null)).toEqual({ chapter: 1, step: -1 });
    expect(initialAddress(chapters, { chapterKey: "n1:narrative", stepId: "swap-new" })).toEqual({ chapter: 0, step: 0 });
    expect(initialAddress(chapters, { chapterKey: "gone:narrative", stepId: null })).toEqual({ chapter: 1, step: -1 });
    expect(initialAddress(buildChapters({ ...story, revisions: [story.revisions[0]!] }), null)).toEqual({ chapter: 0, step: -1 });
  });

  it("steps across chapter boundaries through each chapter's summary page", () => {
    expect(movePage(chapters, { chapter: 0, step: 1 }, 1)).toEqual({ chapter: 1, step: -1 });
    expect(movePage(chapters, { chapter: 1, step: -1 }, -1)).toEqual({ chapter: 0, step: 1 });
    expect(movePage(chapters, { chapter: 2, step: 0 }, 5)).toEqual({ chapter: 2, step: 0 });
    expect(moveChapter(chapters, { chapter: 2, step: 0 }, -1)).toEqual({ chapter: 2, step: -1 });
    expect(moveChapter(chapters, { chapter: 2, step: -1 }, -1)).toEqual({ chapter: 1, step: -1 });
  });

  it("pairs a revision with the narrative it names, even when that one has no steps to show", () => {
    const withGap: NarrativeStory = { ...story, revisions: [story.revisions[1]!] };
    const only = buildChapters(withGap);
    expect(only.map((chapter) => [chapter.kind, chapter.title])).toEqual([
      ["revision", "What changed: 1111111 → 2222222"],
      ["narrative", "Narrative at 2222222"],
    ]);
  });

  it("follows a revision step into the narrative it led to", () => {
    expect(affectedAddress(chapters, { chapter: 1, step: 0 }, "swap")).toEqual({ chapter: 2, step: 0 });
    expect(affectedAddress(chapters, { chapter: 1, step: 0 }, "nope")).toBeNull();
  });

  it("names the files whose every step has been read", () => {
    expect(narratedFiles(chapters[2]!, new Set())).toEqual([]);
    expect(narratedFiles(chapters[2]!, new Set(["swap"]))).toEqual(["x.ts"]);
  });

  it("has no keys that shadow each other, and its ? sheet lists only keys it binds", () => {
    expect(keymapConflicts(NARRATIVE_KEYMAP)).toEqual([]);
    expect(unboundHelpKeys(NARRATIVE_KEY_HELP, [NARRATIVE_KEYMAP, FILE_TREE_KEYMAP], ["Tab", "⌘↩"])).toEqual([]);
  });

  it("keeps every review key, so the cursor and comments work on a step's lines as on the files", () => {
    // h and l turn pages instead, the narrative's main motion; the arrows keep the sides. gf opens the files view.
    for (const [key, command] of Object.entries(REVIEW_KEYMAP)) if (key !== "h" && key !== "l" && key !== "gf") expect(NARRATIVE_KEYMAP[key]).toEqual(command);
    expect(NARRATIVE_KEYMAP.l).toEqual({ kind: "step", direction: 1 });
    expect(NARRATIVE_KEYMAP["<Right>"]).toEqual({ kind: "side", side: "RIGHT" });
    expect(NARRATIVE_KEYMAP["]]"]).toEqual({ kind: "chapter", direction: 1 });
    expect(NARRATIVE_KEYMAP["<Esc>"]).toEqual({ kind: "escape" });
  });
});

describe("step excerpts", () => {
  const patch = ["@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", " d", "@@ -10,2 +10,3 @@", " x", "+y", " z"].join("\n");
  const thread = (id: string, side: "LEFT" | "RIGHT", line: number | null): DiffThread => ({ id, path: "x.ts", line, side, startLine: null, startSide: null, entries: [], onGithub: false, outdated: false, resolved: null, orphaned: false });
  const finding = (line: number | null) => ({ line, item: { reviewId: "r", finding: { id: `f${line}` } as never, selected: true, overridden: false, edited: false, carriedFrom: null } });

  it("cuts a step's refs to one excerpt per file, with the lines they point at", () => {
    const [excerpt] = stepExcerpts([{ path: "x.ts", side: "old", startLine: 2, endLine: 2 }, { path: "x.ts", side: "new", startLine: 2, endLine: 2 }], [{ path: "x.ts", previousPath: null, patch }]);
    expect(excerpt!.path).toBe("x.ts");
    expect(excerpt!.patch).toBe(["@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", " d"].join("\n"));
  });

  it("hands the renderer only annotations on lines the excerpt shows, keeping file-level threads", () => {
    const excerpt = ["@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", " d"].join("\n");
    const cut = excerptAnnotations(
      excerpt,
      [thread("shown-new", "RIGHT", 2), thread("shown-old", "LEFT", 2), thread("elsewhere", "RIGHT", 11), thread("file", "RIGHT", null)],
      [finding(2), finding(11), finding(null)],
      { line: 11, side: "RIGHT", startLine: null, startSide: null },
    );
    expect(cut.threads.map((entry) => entry.id)).toEqual(["shown-new", "shown-old", "file"]);
    expect(cut.findings.map((entry) => entry.line)).toEqual([2]);
    expect(cut.composer).toBeNull();
    expect(excerptAnnotations(excerpt, [], [], { line: 2, side: "RIGHT", startLine: null, startSide: null }).composer).toEqual({ line: 2, side: "RIGHT", startLine: null, startSide: null });
    expect(excerptAnnotations(excerpt, [], [], { line: null, side: "RIGHT", startLine: null, startSide: null }).composer).toEqual({ line: null, side: "RIGHT", startLine: null, startSide: null });
  });
});
