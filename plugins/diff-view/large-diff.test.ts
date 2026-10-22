import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReviewCommand } from "./lib/app/keys/review-commands";
import { environmentDiff, patchFromSides, splitUnifiedDiff, withUnlistedFiles } from "./lib/server";
import type { DiffResult } from "./lib/types";
import { fakeEnvironmentSdk, git, reviewEnv, tempRepo } from "./test-helpers";

describe("patchFromSides", () => {
  it("makes a patch headed with the file's own paths, which the diff parser reads back", async () => {
    const patch = await patchFromSides("src/new.ts", "src/old.ts", "one\ntwo\nthree\n", "one\n2\nthree\nfour\n");
    expect(patch).not.toBeNull();
    expect(patch!.split("\n").slice(0, 5)).toEqual(["diff --git a/src/old.ts b/src/new.ts", "rename from src/old.ts", "rename to src/new.ts", "--- a/src/old.ts", "+++ b/src/new.ts"]);
    const [file] = splitUnifiedDiff(patch!);
    expect(file).toMatchObject({ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", additions: 2, deletions: 1, binary: false });
    expect(file!.patch).toContain("@@ -1,3 +1,4 @@");
  });

  it("marks a side that does not exist as an added or deleted file", async () => {
    const added = splitUnifiedDiff((await patchFromSides("a.txt", null, null, "hello\n"))!);
    expect(added).toMatchObject([{ path: "a.txt", previousPath: null, status: "added", additions: 1, deletions: 0 }]);
    const removed = splitUnifiedDiff((await patchFromSides("a.txt", null, "bye\nnow\n", null))!);
    expect(removed).toMatchObject([{ path: "a.txt", status: "removed", additions: 0, deletions: 2 }]);
  });

  it("returns null for equal or binary sides", async () => {
    expect(await patchFromSides("same.txt", null, "x\n", "x\n")).toBeNull();
    expect(await patchFromSides("blob.bin", null, "a\0b", "a\0c")).toBeNull();
  });
});

describe("binary files in a diff", () => {
  it("are flagged from git's Binary files line and from a --binary patch, but a mode change is not", () => {
    const files = splitUnifiedDiff(
      [
        "diff --git a/logo.png b/logo.png",
        "Binary files a/logo.png and b/logo.png differ",
        "diff --git a/icon.png b/icon.png",
        "new file mode 100644",
        "index 0000000..3f4e2a1",
        "GIT binary patch",
        "literal 12",
        "zcmZ?wbhEHbWMp7uXkcIv",
        "",
        "diff --git a/run.sh b/run.sh",
        "old mode 100644",
        "new mode 100755",
        "",
      ].join("\n"),
    );
    expect(files.map((file) => [file.path, file.binary, file.patch])).toEqual([
      ["logo.png", true, null],
      ["icon.png", true, null],
      ["run.sh", false, null],
    ]);
  });
});

function truncatedDiff(paths: string[]): DiffResult {
  return {
    source: "environment",
    files: paths.map((path) => ({ path, previousPath: null, status: "modified", additions: 1, deletions: 1, patch: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-a\n+b`, vendored: false })),
    baseRef: "abc",
    baseSha: null,
    headSha: null,
    truncated: true,
    message: null,
    fetchedAt: 0,
    hiddenVendored: null,
    repo: null,
    environmentId: null,
  };
}

describe("withUnlistedFiles", () => {
  it("adds the files the cut-off text left out, drops the cut file's partial patch, and says how many lack changes", () => {
    const diff = withUnlistedFiles(truncatedDiff(["a.ts", "b.ts"]), "M\ta.ts\nM\tb.ts\nA\tc.ts\nR087\told.ts\td.ts\n");
    expect(diff.files.map((file) => [file.path, file.previousPath, file.status, file.patch === null])).toEqual([
      ["a.ts", null, "modified", false],
      ["b.ts", null, "modified", true],
      ["c.ts", null, "added", true],
      ["d.ts", "old.ts", "renamed", true],
    ]);
    expect(diff.truncated).toBe(true);
    expect(diff.truncatedNote).toMatch(/3 of 4 files came without their changes/u);
  });

  it("keeps every patch when the file list names nothing more", () => {
    const diff = withUnlistedFiles(truncatedDiff(["a.ts"]), "M\ta.ts\n");
    expect(diff.files[0]!.patch).not.toBeNull();
    expect(diff.truncatedNote).toMatch(/some changes may be missing/u);
  });
});

describe("Enter on a file without a patch", () => {
  const run = (collapsed: boolean, loadPatch: (() => void) | undefined) => {
    const setCollapsed = vi.fn();
    const models = new Map([["big.ts", { rows: [], cutToHunk: false, element: () => null, loadPatch }]]);
    const built: ReturnType<typeof reviewEnv> = reviewEnv({ files: [{ path: "big.ts", collapsed, rows: [] }], seat: () => built.state().cursor, setCollapsed }, { cursor: { path: "big.ts", side: "RIGHT", line: null, want: "RIGHT" }, models });
    runReviewCommand({ kind: "fold", action: "annotation" }, 1, built.env);
    return setCollapsed;
  };

  it("loads its patch from the header instead of folding the file", () => {
    const load = vi.fn();
    expect(run(false, load)).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
  });

  it("folds as before when there is nothing to load, and opens a collapsed file first", () => {
    expect(run(false, undefined)).toHaveBeenCalledWith(["big.ts"], true);
    const load = vi.fn();
    expect(run(true, load)).toHaveBeenCalledWith(["big.ts"], false);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("environmentDiff over a truncated SDK diff", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  const fakeSdk = (workspacePath: string | null, diff: string, files: string) => fakeEnvironmentSdk(workspacePath, { diff, files });

  it("reads the whole diff, untracked files included, from a local checkout", async () => {
    dir = await tempRepo("large-diff-test-");
    await writeFile(join(dir, "kept.txt"), "one\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-q", "-m", "base");
    await writeFile(join(dir, "kept.txt"), "one\ntwo\n");
    await writeFile(join(dir, "fresh.txt"), "new\n");
    const diff = await environmentDiff(fakeSdk(dir, "diff --git a/kept.txt b/kept.txt\n@@ -1 +1,2 @@\n", "M\tkept.txt\n"), "env");
    expect(diff.truncated).toBe(false);
    expect(diff.files.map((file) => [file.path, file.status, file.additions, file.patch !== null])).toEqual([
      ["kept.txt", "modified", 1, true],
      ["fresh.txt", "added", 1, true],
    ]);
  });

  it("falls back to the banner note without a local checkout", async () => {
    const diff = await environmentDiff(fakeSdk(null, "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b", "M\ta.ts\nM\tb.ts\n"), "env");
    expect(diff.truncated).toBe(true);
    expect(diff.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(diff.truncatedNote).toMatch(/2 of 2 files/u);
  });
});
