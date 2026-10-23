import { describe, expect, it } from "vitest";
import { allDiffThreads } from "./lib/app/comments/threads";
import { recountHunk, shownInline, threadCode, threadCounts, threadStatus } from "./lib/app/comments/thread-code";
import { conversationItems, conversationStops } from "./lib/app/conversation/conversation";
import { CONVERSATION_KEY_HELP, CONVERSATION_KEYMAP } from "./lib/app/conversation/conversation-keymap";
import { REVIEW_KEYMAP } from "./lib/app/keys/keymap";
import type { ConversationEvent, DiffCommit, PullRequestSummary } from "./lib/types";
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
});

describe("recountHunk", () => {
  it("recounts a header GitHub cut short at the commented line", () => {
    expect(recountHunk("@@ -10,6 +10,8 @@ func f() {\n a\n-b\n+c\n+d")).toBe("@@ -10,2 +10,3 @@ func f() {\n a\n-b\n+c\n+d");
  });

  it("is null for text without a hunk", () => {
    expect(recountHunk("no hunk here")).toBeNull();
  });
});

describe("threadCode", () => {
  const hunk = "@@ -20,8 +20,8 @@\n c1\n c2\n c3\n c4\n-old\n+new";
  const threads = allDiffThreads(
    [local({ id: "on-change", line: 4 }), local({ id: "file", line: null }), local({ id: "gone", path: "z.ts", line: 2 })],
    [
      github({ id: "review-comment:1", line: 11 }),
      github({ id: "review-comment:2", path: "b.ts", outdated: true, line: 24, originalLine: 24, diffHunk: hunk }),
      github({ id: "review-comment:3", outdated: true, line: 30 }),
      github({ id: "review-comment:4", path: "b.ts", line: 3, originalLine: 24, diffHunk: hunk }),
    ],
  );
  const code = (id: string) => threadCode(threads.find((thread) => thread.id === id)!, FILES);

  it("shows a thread started here over today's lines around it", () => {
    const onChange = code("on-change");
    expect([onChange.key, onChange.kind]).toEqual(["thread:on-change/a.ts", "current"]);
    expect(onChange.patch).toBe(["@@ -1,7 +1,7 @@", " one", " two", " three", "-four", "+FOUR", " five", " six", " seven"].join("\n"));
    expect(onChange.placed.line).toBe(4);
  });

  it("shows a GitHub thread over the hunk GitHub stored, at the line it was left on, outdated or not", () => {
    for (const id of ["review-comment:2", "review-comment:4"]) {
      const stored = code(id);
      expect(stored.kind).toBe("stored");
      expect(stored.patch).toBe("@@ -21,4 +21,4 @@\n c2\n c3\n c4\n-old\n+new");
      expect([stored.placed.path, stored.placed.line]).toEqual(["b.ts", 24]);
    }
  });

  it("falls back to today's lines for a GitHub thread with no stored hunk, and to the file's name when there are none", () => {
    expect(code("review-comment:1").patch).toContain(" eleven");
    expect(code("review-comment:1").placed.line).toBe(11);
    const outdated = code("review-comment:3");
    expect([outdated.patch, outdated.placed.line]).toEqual([null, null]);
    const gone = code("gone");
    expect([gone.patch, gone.placed.line]).toEqual([null, null]);
    expect(code("file").placed.line).toBeNull();
  });
});

describe("conversationItems", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  const commit = (sha: string, minute: number): DiffCommit => ({ sha, summary: `commit ${sha}`, author: "Jordan Rivera", date: at(minute) });
  const commits = [commit("a1", 1), commit("b2", 2), commit("c3", 9)];
  const opened: ConversationEvent = { kind: "opened", id: "pr", author: "Jordan Rivera", body: "Adds widgets", createdAt: at(0), url: "https://github.invalid/pr" };
  const approval: ConversationEvent = { kind: "review", id: "review:7", author: "Alex", mine: false, state: "APPROVED", body: "", createdAt: at(8), url: "https://github.invalid/r7" };
  const merged: ConversationEvent = { kind: "action", id: "9", action: "merged", actor: "Jordan Rivera", detail: "c3", createdAt: at(10) };
  const github_ = [
    github({ id: "issue-comment:5", kind: "issue-comment", path: null, line: null, createdAt: at(3) }),
    github({ id: "review-comment:6", reviewId: "review:7", createdAt: at(7) }),
    github({ id: "review-comment:8", reviewId: "review:7", createdAt: at(6), line: 2 }),
    github({ id: "review-comment:9", inReplyTo: "review-comment:6", createdAt: at(11) }),
    github({ id: "review-comment:10", reviewId: "review:11", author: "Sam", createdAt: at(4) }),
  ];
  const threads = allDiffThreads([local({ id: "mine", createdAt: Date.parse(at(5)) })], github_);
  const items = conversationItems({ threads, github: github_, commits, events: [opened, approval, merged] });

  it("puts the description first, then everything in the order it happened, with commits made together in one run", () => {
    expect(items.map((item) => item.key)).toEqual(["opened", "commit:a1", "issue-comment:5", "review:11", "thread:mine", "review:7", "commit:c3", "action:9"]);
    const run = items[1]!;
    expect(run.kind === "commits" ? run.commits.map((entry) => [entry.commit.sha, entry.index]) : null).toEqual([["a1", 0], ["b2", 1]]);
  });

  it("puts each GitHub thread under its review, oldest first, and makes up a review GitHub didn't list", () => {
    const approved = items.find((item) => item.key === "review:7")!;
    expect(approved.kind === "review" ? [approved.review.state, approved.threads.map((thread) => thread.id)] : null).toEqual(["APPROVED", ["review-comment:8", "review-comment:6"]]);
    const madeUp = items.find((item) => item.key === "review:11")!;
    expect(madeUp.kind === "review" ? [madeUp.review.author, madeUp.review.state, madeUp.review.body] : null).toEqual(["Sam", "COMMENTED", ""]);
  });

  it("stops the cursor at each commit and at each thread after its review", () => {
    expect(conversationStops(items).map((stop) => stop.key)).toEqual([
      "opened", "commit:a1", "commit:b2", "issue-comment:5", "review:11", "thread:review-comment:10", "thread:mine", "review:7", "thread:review-comment:8", "thread:review-comment:6", "commit:c3", "action:9",
    ]);
  });

  it("takes reviews from the synced comments when the source lists no events", () => {
    const stored = [...github_, github({ id: "review:7", kind: "review", path: null, line: null, body: "Looks good", reviewState: "CHANGES_REQUESTED", createdAt: at(8) })];
    const review = conversationItems({ threads, github: stored, commits: [], events: [] }).find((item) => item.key === "review:7")!;
    expect(review.kind === "review" ? [review.review.state, review.review.body, review.threads.length] : null).toEqual(["CHANGES_REQUESTED", "Looks good", 2]);
  });
});

describe("summary and status stops", () => {
  it("stops at the pull request and each issue it closes before the timeline, and at the status and each check after it", () => {
    const pr: PullRequestSummary = {
      state: "open", author: "Jordan Rivera", url: "https://github.invalid/acme-co/widgets/pull/7", baseRef: "main", headRef: "widgets", commitCount: 1, labels: [], assignees: [], milestone: null,
      linkedIssues: [{ number: 3, title: "Widgets", url: "https://github.invalid/acme-co/widgets/issues/3", open: true }],
      reviewers: [], reviewDecision: null, mergeable: "MERGEABLE", mergeState: "CLEAN",
      checks: { outcome: "success", runs: [{ name: "build", outcome: "success", description: null, url: "https://github.invalid/run/1" }] },
    };
    const items = conversationItems({ threads: [], github: [], commits: [{ sha: "a1", summary: "s", author: "Alex", date: "2026-01-01T00:00:00Z" }], events: [] });
    const stops = conversationStops(items, pr);
    expect(stops.map((stop) => [stop.key, stop.kind === "link" ? stop.url : null])).toEqual([
      ["summary", pr.url],
      ["issue:3", "https://github.invalid/acme-co/widgets/issues/3"],
      ["commit:a1", null],
      ["status", `${pr.url}/checks`],
      ["check:0", "https://github.invalid/run/1"],
    ]);
  });
});

describe("conversation keys", () => {
  it("has no conflicting sequences, and every key its help lists is bound", () => {
    expect(keymapConflicts(CONVERSATION_KEYMAP)).toEqual([]);
    expect(unboundHelpKeys(CONVERSATION_KEY_HELP, [CONVERSATION_KEYMAP])).toEqual([]);
  });

  it("maps gc and H in the files view, and gf to the conversation's own command", () => {
    expect(REVIEW_KEYMAP.gc).toEqual({ kind: "conversation" });
    expect(REVIEW_KEYMAP.H).toEqual({ kind: "hideThreads" });
    expect(CONVERSATION_KEYMAP.gc).toEqual({ kind: "conversation" });
    expect(CONVERSATION_KEYMAP.gf).toEqual({ kind: "openInFiles" });
  });
});
