import { describe, expect, it } from "vitest";
import { allDiffThreads } from "./lib/app/comments/threads";
import { commentSections, nextThreadFilter, recountHunk, shownInline, threadCounts, threadStatus } from "./lib/app/comments/comment-sections";
import { COMMENTS_KEY_HELP, COMMENTS_KEYMAP } from "./lib/app/comments/comments-keymap";
import { REVIEW_KEYMAP } from "./lib/app/keys/keymap";
import { keymapConflicts, unboundHelpKeys } from "../vim-mode/lib/index.ts";
import { githubComment as github, localComment as local } from "./test-helpers";

// a.ts: lines 1-3 unchanged, 4 replaced, 5-12 unchanged context.
const A_PATCH = ["@@ -1,12 +1,12 @@", " one", " two", " three", "-four", "+FOUR", " five", " six", " seven", " eight", " nine", " ten", " eleven", " twelve"].join("\n");
const FILES = [
  { path: "a.ts", previousPath: null, patch: A_PATCH },
  { path: "b.ts", previousPath: null, patch: "@@ -1,1 +1,1 @@\n-x\n+y" },
];

describe("thread status", () => {
  const threads = allDiffThreads(
    [local({ id: "open" }), local({ id: "reply", inReplyTo: "review-comment:3", target: "github" })],
    [github({ id: "review-comment:2", resolved: true }), github({ id: "review-comment:3", outdated: true, line: 7 }), github({ id: "review-comment:4", outdated: true, line: 9 })],
  );
  const byId = new Map(threads.map((thread) => [thread.id, thread]));

  it("keeps outdated and resolved threads the diff leaves out", () => {
    expect(threads.map((thread) => thread.id).sort()).toEqual(["open", "review-comment:2", "review-comment:3", "review-comment:4"]);
    expect(allDiffThreads([], [github({ id: "review-comment:4", outdated: true })]).filter(shownInline)).toEqual([]);
  });

  it("names each thread open, resolved or outdated and counts them", () => {
    expect(threadStatus(byId.get("open")!)).toBe("open");
    expect(threadStatus(byId.get("review-comment:2")!)).toBe("resolved");
    expect(threadStatus(byId.get("review-comment:3")!)).toBe("outdated");
    expect(threadCounts(threads)).toEqual({ open: 1, resolved: 1, outdated: 2 });
  });

  it("draws only open threads inline, and a closed one while it holds an unsent reply", () => {
    expect(threads.filter(shownInline).map((thread) => thread.id).sort()).toEqual(["open", "review-comment:3"]);
  });

  it("cycles the filter open, resolved, outdated, all", () => {
    expect([nextThreadFilter("open"), nextThreadFilter("resolved"), nextThreadFilter("outdated"), nextThreadFilter("all")]).toEqual(["resolved", "outdated", "all", "open"]);
  });
});

describe("recountHunk", () => {
  it("recounts a header GitHub cut short at the commented line", () => {
    expect(recountHunk("@@ -10,6 +10,8 @@ func f() {\n a\n-b\n+c\n+d")).toBe("@@ -10,2 +10,3 @@ func f() {\n a\n-b\n+c\n+d");
  });

  it("is null for text without a hunk", () => {
    expect(recountHunk("no hunk here")).toBeNull();
  });
});

describe("commentSections", () => {
  const hunk = "@@ -20,8 +20,8 @@\n c1\n c2\n c3\n c4\n-old\n+new";
  const threads = allDiffThreads(
    [local({ id: "on-change", line: 4 }), local({ id: "file", line: null }), local({ id: "gone", path: "z.ts", line: 2 })],
    [
      github({ id: "review-comment:1", resolved: true, line: 11 }),
      github({ id: "review-comment:2", path: "b.ts", outdated: true, line: 24, originalLine: 24, diffHunk: hunk }),
      github({ id: "review-comment:3", outdated: true, line: 30 }),
    ],
  );

  it("groups every thread by file in diff order, each over its code", () => {
    const sections = commentSections(threads, FILES, "all");
    expect(sections.map((section) => [section.key, section.kind])).toEqual([
      ["a.ts", "current"],
      ["outdated:review-comment:2/b.ts", "outdated"],
      ["z.ts", "current"],
    ]);
    const [a, b, z] = sections;
    // One excerpt for the file's lines: the change at 4 and the resolved thread at 11, each with context.
    expect(a!.patch).toBe(["@@ -1,12 +1,12 @@", " one", " two", " three", "-four", "+FOUR", " five", " six", " seven", " eight", " nine", " ten", " eleven", " twelve"].join("\n"));
    const placed = new Map(a!.threads.map((thread) => [thread.id, thread.line]));
    expect(placed).toEqual(new Map([["on-change", 4], ["file", null], ["review-comment:1", 11], ["review-comment:3", null]]));
    // The outdated thread sits on its original line in GitHub's stored hunk, cut to the lines around it.
    expect(b!.patch).toBe("@@ -21,4 +21,4 @@\n c2\n c3\n c4\n-old\n+new");
    expect(b!.threads.map((thread) => [thread.path, thread.line])).toEqual([["b.ts", 24]]);
    // A file no longer in the diff keeps its threads, under its header.
    expect(z!.patch).toBeNull();
    expect(z!.threads.map((thread) => thread.line)).toEqual([null]);
  });

  it("keeps only the threads the filter names", () => {
    expect(commentSections(threads, FILES, "open").flatMap((section) => section.threads.map((thread) => thread.id))).toEqual(["on-change", "file", "gone"]);
    expect(commentSections(threads, FILES, "resolved").map((section) => section.key)).toEqual(["a.ts"]);
    expect(commentSections(threads, FILES, "outdated").map((section) => section.key)).toEqual(["a.ts", "outdated:review-comment:2/b.ts"]);
  });
});

describe("comments view keys", () => {
  it("has no conflicting sequences, and every key its help lists is bound", () => {
    expect(keymapConflicts(COMMENTS_KEYMAP)).toEqual([]);
    expect(unboundHelpKeys(COMMENTS_KEY_HELP, [COMMENTS_KEYMAP])).toEqual([]);
  });

  it("maps gc and H in the files view, and gf and F to the view's own commands", () => {
    expect(REVIEW_KEYMAP.gc).toEqual({ kind: "commentsView" });
    expect(REVIEW_KEYMAP.H).toEqual({ kind: "hideThreads" });
    expect(COMMENTS_KEYMAP.gf).toEqual({ kind: "openInFiles" });
    expect(COMMENTS_KEYMAP.F).toEqual({ kind: "threadFilter" });
  });
});
