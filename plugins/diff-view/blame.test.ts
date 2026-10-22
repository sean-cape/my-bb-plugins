import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keymapConflicts } from "../vim-mode/lib/index.ts";
import { FILE_POPOVER_KEYMAP, REVIEW_KEYMAP } from "./lib/app/keys/keymap";
import type { Cursor, NavRow } from "./lib/app/keys/nav";
import { runReviewCommand, type FileActions } from "./lib/app/keys/review-commands";
import type { FileNavModel } from "./lib/app/keys/review-keys-context";
import { blameCommits, cursorSpan, fileLink, firstHunkSpan, githubCommitUrl, githubFileUrl, lineRuns, type LineSpan } from "./lib/app/links";
import { gitBlame, githubRepoFromRemote, parseBlamePorcelain } from "./lib/server";
import { UNCOMMITTED_SHA } from "./lib/types";
import { git, reviewEnv, tempRepo } from "./test-helpers";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("parseBlamePorcelain", () => {
  it("gives every line its commit, though porcelain states a commit's details only at its first line", () => {
    const output = [
      `${A} 1 10 2`,
      "author Ada",
      "author-mail <ada@example.invalid>",
      "author-time 1700000000",
      "author-tz +0000",
      "summary First change",
      "filename src/a.ts",
      "\tconst a = 1;",
      `${A} 2 11`,
      "\tconst b = 2;",
      `${UNCOMMITTED_SHA} 12 12 1`,
      "author Not Committed Yet",
      "author-time 1800000000",
      "summary Version of src/a.ts from src/a.ts",
      "previous " + B + " src/a.ts",
      "filename src/a.ts",
      "\t\tindented with a tab",
      "",
    ].join("\n");
    expect(parseBlamePorcelain(output)).toEqual([
      { line: 10, sha: A, author: "Ada", time: 1_700_000_000_000, summary: "First change" },
      { line: 11, sha: A, author: "Ada", time: 1_700_000_000_000, summary: "First change" },
      { line: 12, sha: UNCOMMITTED_SHA, author: "Not Committed Yet", time: 1_800_000_000_000, summary: "Version of src/a.ts from src/a.ts" },
    ]);
  });
});

describe("gitBlame", () => {
  let dir = "";
  let first = "";
  beforeAll(async () => {
    dir = await tempRepo("diff-view-blame-");
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
    await git(dir, "add", "a.txt");
    await git(dir, "commit", "-q", "-m", "Add a");
    first = await git(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n");
    await git(dir, "commit", "-q", "-am", "Shout two");
    await writeFile(join(dir, "a.txt"), "one\nTWO\nthree!\n");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("blames the working tree, uncommitted lines included", async () => {
    const lines = await gitBlame(dir, null, "a.txt", 1, 3);
    expect(lines.map((line) => [line.line, line.sha === first, line.summary])).toEqual([
      [1, true, "Add a"],
      [2, false, "Shout two"],
      [3, false, expect.any(String)],
    ]);
    expect(lines[2]!.sha).toBe(UNCOMMITTED_SHA);
  });

  it("blames a commit, and refuses a path out of the checkout", async () => {
    expect((await gitBlame(dir, first, "a.txt", 2, 2)).map((line) => [line.line, line.sha])).toEqual([[2, first]]);
    await expect(gitBlame(dir, null, "../a.txt", 1, 1)).rejects.toThrow("Invalid path");
  });
});

describe("githubRepoFromRemote", () => {
  it("reads ssh and https remotes and nothing else", () => {
    expect(githubRepoFromRemote("git@github.com:Owner/Repo.git\n")).toBe("owner/repo");
    expect(githubRepoFromRemote("https://github.com/owner/repo")).toBe("owner/repo");
    expect(githubRepoFromRemote("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(githubRepoFromRemote(null)).toBeNull();
  });
});

describe("file links", () => {
  const pr = { repo: "owner/repo", baseSha: "base1", headSha: "head1" };
  const env = { repo: "owner/repo", baseSha: null, headSha: null };
  const renamed = { path: "src/new name.ts", previousPath: "src/old.ts", status: "renamed" };
  const span = (side: "LEFT" | "RIGHT", start: number, end = start): LineSpan => ({ side, start, end });

  it("links a PR's lines at the head, and its old lines at the base under the old name", () => {
    expect(fileLink(pr, renamed, span("RIGHT", 10, 14))).toBe("https://github.com/owner/repo/blob/head1/src/new%20name.ts#L10-L14");
    expect(fileLink(pr, renamed, span("RIGHT", 3))).toBe("https://github.com/owner/repo/blob/head1/src/new%20name.ts#L3");
    expect(fileLink(pr, renamed, span("LEFT", 4, 6))).toBe("https://github.com/owner/repo/blob/base1/src/old.ts#L4-L6");
    expect(fileLink(pr, renamed, null)).toBe("https://github.com/owner/repo/blob/head1/src/new%20name.ts");
  });

  it("falls back to path:L without a commit, and has no link to a side the file lacks", () => {
    expect(fileLink(env, renamed, span("RIGHT", 10, 14))).toBe("src/new name.ts:L10-14");
    expect(fileLink(env, renamed, span("LEFT", 4))).toBe("src/old.ts:L4 (old side)");
    expect(fileLink(env, renamed, null)).toBe("src/new name.ts");
    expect(githubFileUrl(pr, { path: "gone.ts", previousPath: null, status: "removed" }, span("RIGHT", 1))).toBeNull();
    expect(githubFileUrl(pr, { path: "gone.ts", previousPath: null, status: "removed" }, null)).toBe("https://github.com/owner/repo/blob/base1/gone.ts");
    expect(githubCommitUrl("owner/repo", A)).toBe(`https://github.com/owner/repo/commit/${A}`);
  });

  it("reads a patch's first hunk on the new side, or the old one when it only deletes", () => {
    expect(firstHunkSpan("diff --git a/x b/x\n@@ -1,3 +5,4 @@\n a\n+b")).toEqual(span("RIGHT", 5, 8));
    expect(firstHunkSpan("@@ -7,2 +6,0 @@\n-a\n-b")).toEqual(span("LEFT", 7, 8));
    expect(firstHunkSpan(null)).toBeNull();
  });
});

describe("cursorSpan", () => {
  const rows: NavRow[] = [
    { left: 1, right: 1, hunk: 0, changed: false },
    { left: 2, right: null, hunk: 0, changed: true },
    { left: null, right: 2, hunk: 0, changed: true },
    { left: null, right: 3, hunk: 0, changed: true },
  ];
  const at = (side: "LEFT" | "RIGHT", line: number | null): Cursor => ({ path: "a.ts", side, line, want: side });

  it("is the cursor's line, or the selection's lines on the cursor's side", () => {
    expect(cursorSpan(rows, at("RIGHT", 2), null)).toEqual({ side: "RIGHT", start: 2, end: 2 });
    expect(cursorSpan(rows, at("RIGHT", 3), at("RIGHT", 1))).toEqual({ side: "RIGHT", start: 1, end: 3 });
    expect(cursorSpan(rows, at("RIGHT", 1), at("LEFT", 2))).toEqual({ side: "RIGHT", start: 1, end: 1 });
    expect(cursorSpan(rows, at("LEFT", 2), at("RIGHT", 3))).toEqual({ side: "LEFT", start: 2, end: 2 });
    expect(cursorSpan(rows, at("RIGHT", null), null)).toBeNull();
  });
});

describe("blame grouping", () => {
  it("groups lines by commit in the order they appear and names their runs", () => {
    const line = (n: number, sha: string) => ({ line: n, sha, author: sha === A ? "Ada" : "Bo", time: 0, summary: sha });
    expect(blameCommits([line(12, A), line(10, A), line(11, B), line(13, A)])).toEqual([
      { sha: A, author: "Ada", time: 0, summary: A, lines: [10, 12, 13] },
      { sha: B, author: "Bo", time: 0, summary: B, lines: [11] },
    ]);
    expect(lineRuns([10, 12, 13])).toBe("L10, 12-13");
    expect(lineRuns([])).toBe("");
  });
});

describe("copy, open and blame keys", () => {
  it("are bound without conflicts, and the popover's keys are too", () => {
    expect([REVIEW_KEYMAP.yp, REVIEW_KEYMAP.yl, REVIEW_KEYMAP.gO, REVIEW_KEYMAP.gb]).toEqual([{ kind: "copyPath" }, { kind: "copyLink" }, { kind: "openFile" }, { kind: "blame" }]);
    expect(keymapConflicts(FILE_POPOVER_KEYMAP)).toEqual([]);
  });

  const rows: NavRow[] = [1, 2, 3].map((n) => ({ left: n, right: n, hunk: 0, changed: false }));
  const run = (command: Parameters<typeof runReviewCommand>[0], cursor: Cursor, visual: Cursor | null, blame: boolean) => {
    const calls: unknown[] = [];
    const actions: FileActions = {
      copyPath: (path) => calls.push(["copyPath", path]),
      copyLink: (path, span) => calls.push(["copyLink", path, span]),
      open: (path, span) => calls.push(["open", path, span]),
      blame: blame ? (path, span) => calls.push(["blame", path, span]) : null,
    };
    const models = new Map<string, FileNavModel>([["a.ts", { rows, cutToHunk: false, element: () => null }]]);
    const { env, state } = reviewEnv({ files: [{ path: "a.ts", collapsed: false, rows }], notify: (message: string) => calls.push(["notify", message]), fileActions: actions }, { cursor, visual, models });
    runReviewCommand(command, 1, env);
    return { calls, visual: state().visual };
  };
  const at = (line: number | null): Cursor => ({ path: "a.ts", side: "RIGHT", line, want: "RIGHT" });

  it("yl links the selection and ends it, as vim's y does", () => {
    expect(run({ kind: "copyLink" }, at(3), at(1), true)).toEqual({ calls: [["copyLink", "a.ts", { side: "RIGHT", start: 1, end: 3 }]], visual: null });
    expect(run({ kind: "copyPath" }, at(2), null, true).calls).toEqual([["copyPath", "a.ts"]]);
    expect(run({ kind: "openFile" }, at(null), null, true).calls).toEqual([["open", "a.ts", null]]);
  });

  it("gb blames the selection, and says why when it can't", () => {
    expect(run({ kind: "blame" }, at(2), at(1), true).calls).toEqual([["blame", "a.ts", { side: "RIGHT", start: 1, end: 2 }]]);
    expect(run({ kind: "blame" }, at(null), null, true).calls).toEqual([["notify", "Move onto a line to blame it"]]);
    expect(run({ kind: "blame" }, at(2), null, false).calls).toEqual([["notify", "This view has no blame"]]);
  });
});
