import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMIT_PICKER_KEYMAP, commitsRange, markRange, pickerRows, rangeEndsAtHead, rangeLabel, rangeSpan } from "./lib/app/commits/commit-range";
import { REVIEW_KEYMAP } from "./lib/app/keys/keymap";
import { runReviewCommand } from "./lib/app/keys/review-commands";
import { checkedRange, createExpiringCache, environmentCommits, environmentRangeDiff, localRangeFileSides, parseGitLog } from "./lib/server";
import { WORKTREE_SHA, type DiffCommits } from "./lib/types";
import { createPickerKeys, keymapConflicts } from "../vim-mode/lib/index.ts";
import { fakeEnvironmentSdk, git, reviewEnv, sha, tempRepo } from "./test-helpers";

const commit = (n: number) => ({ sha: sha(n), summary: `commit ${n}`, author: "a", date: "2026-10-01T00:00:00Z" });
const HISTORY: DiffCommits = { commits: [commit(1), commit(2), commit(3)], marks: [{ sha: sha(1), label: "Since last review" }], base: sha(9) };

describe("commit ranges", () => {
  it("lists All changes, the marks, then the commits", () => {
    expect(pickerRows(HISTORY)).toEqual([{ kind: "all" }, { kind: "mark", sha: sha(1), label: "Since last review" }, { kind: "commit", index: 0 }, { kind: "commit", index: 1 }, { kind: "commit", index: 2 }]);
  });

  it("makes a commit's range start at the one before it, and the first's at the base", () => {
    expect(commitsRange(HISTORY, 0, 0)).toEqual({ kind: "range", range: { from: sha(9), to: sha(1) } });
    expect(commitsRange(HISTORY, 1, 1)).toEqual({ kind: "range", range: { from: sha(1), to: sha(2) } });
    expect(commitsRange(HISTORY, 2, 1)).toEqual({ kind: "range", range: { from: sha(1), to: sha(3) } });
  });

  it("calls every commit All changes, and gives up on a first commit with no known base", () => {
    expect(commitsRange(HISTORY, 0, 2)).toEqual({ kind: "range", range: null });
    expect(commitsRange({ ...HISTORY, base: null }, 0, 1)).toEqual({ kind: "unknown" });
  });

  it("runs a mark to the head", () => {
    expect(markRange(HISTORY, sha(1))).toEqual({ kind: "range", range: { from: sha(1), to: sha(3) } });
    expect(markRange({ ...HISTORY, commits: [] }, sha(1))).toEqual({ kind: "unknown" });
  });

  it("names the selection", () => {
    expect(rangeLabel(null, HISTORY)).toBe("All changes");
    expect(rangeLabel({ from: sha(1), to: sha(3) }, HISTORY)).toBe("Since last review");
    expect(rangeLabel({ from: sha(1), to: sha(2) }, HISTORY)).toBe(sha(2).slice(0, 7));
    expect(rangeLabel({ from: sha(9), to: sha(2) }, HISTORY)).toBe("2 commits");
    const dirty = { ...HISTORY, commits: [...HISTORY.commits, { ...commit(4), sha: WORKTREE_SHA }] };
    expect(rangeLabel({ from: sha(3), to: WORKTREE_SHA }, dirty)).toBe("Uncommitted");
    expect(rangeLabel({ from: "abcdef1", to: "1234567" }, HISTORY)).toBe("abcdef1..1234567");
  });

  it("finds the commits a range covers", () => {
    expect(rangeSpan({ from: sha(9), to: sha(2) }, HISTORY)).toEqual([0, 1]);
    expect(rangeSpan({ from: sha(2), to: sha(1) }, HISTORY)).toBeNull();
  });

  it("knows whether a range reads up to the head", () => {
    expect(rangeEndsAtHead(null, null)).toBe(true);
    expect(rangeEndsAtHead({ from: sha(1), to: sha(3) }, HISTORY)).toBe(true);
    expect(rangeEndsAtHead({ from: sha(1), to: sha(2) }, HISTORY)).toBe(false);
    expect(rangeEndsAtHead({ from: sha(1), to: sha(3) }, null)).toBe(false);
  });

  it("refuses ends that are not shas", () => {
    expect(() => checkedRange({ from: "--output=x", to: sha(1) })).toThrow();
    expect(() => checkedRange({ from: WORKTREE_SHA, to: sha(1) })).toThrow();
    expect(checkedRange({ from: sha(1), to: WORKTREE_SHA })).toEqual({ from: sha(1), to: WORKTREE_SHA });
  });
});

describe("gr", () => {
  it("is bound, and the picker's own keys are clear of each other", () => {
    expect(REVIEW_KEYMAP.gr).toEqual({ kind: "commits" });
    const picker = createPickerKeys<"mark">({ length: () => 1, highlight: () => 0, setHighlight: () => {}, pick: () => {}, keymap: COMMIT_PICKER_KEYMAP });
    expect(keymapConflicts(picker.keymaps.list)).toEqual([]);
  });

  it("opens the picker, or says why there is none", () => {
    const notify = vi.fn();
    const openCommits = vi.fn();
    const { env } = reviewEnv({ notify, openCommits: null });
    runReviewCommand({ kind: "commits" }, 1, env);
    expect(notify).toHaveBeenCalledWith("No commits to pick from here (they need a pull request or a local checkout)");
    runReviewCommand({ kind: "commits" }, 1, { ...env, openCommits });
    expect(openCommits).toHaveBeenCalledOnce();
  });
});

describe("parseGitLog", () => {
  it("reads sha, author, date and summary", () => {
    expect(parseGitLog(`${sha(1)}\x1fAda\x1f2026-10-01T00:00:00+00:00\x1fFix it\nnot a commit\n`)).toEqual([{ sha: sha(1), author: "Ada", date: "2026-10-01T00:00:00+00:00", summary: "Fix it" }]);
  });
});

describe("createExpiringCache", () => {
  it("shares one load between calls, reloads when fresh is asked or the entry expires, and drops failures", async () => {
    vi.useFakeTimers();
    try {
      const cache = createExpiringCache<number>(1_000);
      let loads = 0;
      const load = () => Promise.resolve(++loads);
      expect(await Promise.all([cache.get("a", load), cache.get("a", load)])).toEqual([1, 1]);
      expect(await cache.get("a", load, true)).toBe(2);
      vi.advanceTimersByTime(1_001);
      expect(await cache.get("a", load)).toBe(3);
      await expect(cache.get("b", () => Promise.reject(new Error("no")))).rejects.toThrow();
      expect(await cache.get("b", load)).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("range diffs from a local checkout", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });
  const sdkFor = (workspacePath: string | null) => fakeEnvironmentSdk(workspacePath);

  it("lists commits since the base with uncommitted changes last, and diffs one commit or the working tree", async () => {
    dir = await tempRepo("commit-range-test-");
    await writeFile(join(dir, "a.txt"), "one\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-q", "-m", "base");
    const base = await git(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "a.txt"), "two\n");
    await git(dir, "commit", "-q", "-am", "second");
    await writeFile(join(dir, "b.txt"), "b\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-q", "-m", "third");
    await writeFile(join(dir, "a.txt"), "three\n");
    await writeFile(join(dir, "new.txt"), "new\n");

    const sdk = sdkFor(dir);
    const history = await environmentCommits(sdk, "env", base);
    expect(history.base).toBe(base);
    expect(history.commits.map((entry) => entry.summary)).toEqual(["second", "third", "Uncommitted changes"]);
    const [second, third] = history.commits;

    const one = await environmentRangeDiff(sdk, "env", { from: base, to: second!.sha });
    expect(one.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(one).toMatchObject({ baseSha: base, headSha: second!.sha, environmentId: "env" });
    expect(await localRangeFileSides(dir, { from: base, to: second!.sha }, one.files[0]!)).toEqual({ old: "one\n", new: "two\n" });

    const worktree = await environmentRangeDiff(sdk, "env", { from: third!.sha, to: WORKTREE_SHA });
    expect(worktree.files.map((file) => file.path).sort()).toEqual(["a.txt", "new.txt"]);
    expect(worktree.headSha).toBeNull();
    const a = worktree.files.find((file) => file.path === "a.txt")!;
    expect(await localRangeFileSides(dir, { from: third!.sha, to: WORKTREE_SHA }, a)).toEqual({ old: "two\n", new: "three\n" });
  });

  it("has no commits without a local checkout", async () => {
    expect(await environmentCommits(sdkFor(null), "env", sha(1))).toEqual({ commits: [], marks: [], base: null });
    expect((await environmentRangeDiff(sdkFor(null), "env", { from: sha(1), to: sha(2) })).files).toEqual([]);
  });
});
