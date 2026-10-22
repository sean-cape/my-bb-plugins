import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { pickerRows } from "./lib/app/commits/commit-range";
import { blameRev, environmentCommits, unquoteGitPath, withUnlistedFiles } from "./lib/server";
import { WORKTREE_SHA, type CommitRange, type DiffResult, type DiffSide } from "./lib/types";
import plugin from "./server";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();

describe("blameRev", () => {
  const range = (to: string): CommitRange => ({ from: "f".repeat(40), to });
  const commit = "c".repeat(40);
  it.each<[string, DiffSide, CommitRange | null, string | null, string | null, string | null]>([
    ["an environment's old side at its merge base", "LEFT", null, "mergebase", null, "mergebase"],
    ["uncommitted changes' old side at HEAD", "LEFT", null, null, null, "HEAD"],
    ["an environment's new side in the working tree", "RIGHT", null, "mergebase", null, null],
    ["a PR's old side at its merge base", "LEFT", null, "mergebase", "head", "mergebase"],
    ["a PR's new side at its head", "RIGHT", null, "mergebase", "head", "head"],
    ["a range's old side at its diff's base", "LEFT", range(commit), "rangebase", commit, "rangebase"],
    ["a range's old side at its start when its diff names no base", "LEFT", range(commit), null, commit, "f".repeat(40)],
    ["a range's new side at its end", "RIGHT", range(commit), "rangebase", "head", commit],
    ["a range to the working tree's new side in the working tree", "RIGHT", range(WORKTREE_SHA), "rangebase", null, null],
  ])("blames %s", (_, side, which, base, head, expected) => {
    expect(blameRev(side, which, base, head)).toBe(expected);
  });
});

describe("unquoteGitPath", () => {
  it.each([
    ["plain/path.ts", "plain/path.ts"],
    ['"with\\ttab.ts"', "with\ttab.ts"],
    ['"say \\"hi\\".ts"', 'say "hi".ts'],
    ['"back\\\\slash.ts"', "back\\slash.ts"],
    ['"caf\\303\\251.ts"', "café.ts"],
    ['"日本.ts"', "日本.ts"],
    ['"\\360\\237\\230\\200 \\a\\b\\f\\n\\r\\v"', "😀 \u0007\b\f\n\r\v"],
  ])("reads %s as %s", (quoted, path) => {
    expect(unquoteGitPath(quoted)).toBe(path);
  });

  it("gives a truncated diff's unlisted files their real paths", () => {
    const diff: DiffResult = { source: "environment", files: [], baseRef: "abc", baseSha: null, headSha: null, truncated: true, message: null, fetchedAt: 0, hiddenVendored: null, repo: null, environmentId: null };
    const listed = withUnlistedFiles(diff, 'A\t"caf\\303\\251.ts"\nR100\t"old\\tname.ts"\t"new \\"name\\".ts"\n');
    expect(listed.files.map((file) => [file.path, file.previousPath])).toEqual([
      ["café.ts", null],
      ['new "name".ts', "old\tname.ts"],
    ]);
  });
});

describe("pickerRows", () => {
  it("leaves out a mark at the head, which would read as no changes", () => {
    const commits = ["1", "2"].map((n) => ({ sha: n.repeat(40), summary: n, author: "", date: "" }));
    const rows = pickerRows({ commits, base: "0".repeat(40), marks: [{ sha: "1".repeat(40), label: "Since last review" }, { sha: "2".repeat(40), label: "Since your last GitHub review" }] });
    expect(rows.filter((row) => row.kind === "mark")).toEqual([{ kind: "mark", sha: "1".repeat(40), label: "Since last review" }]);
  });
});

describe("a local checkout", () => {
  let dir: string | null = null;
  let host: ReturnType<typeof createFakePluginHost> | null = null;
  afterEach(async () => {
    await host?.harness.lifecycle.dispose();
    host = null;
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  /** main with one commit, and a feature branch checked out two commits ahead of it. */
  async function branchCheckout(): Promise<{ dir: string; base: string }> {
    dir = await mkdtemp(join(tmpdir(), "diff-server-test-"));
    await git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "one\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-q", "-m", "base");
    const base = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "-b", "feature");
    await writeFile(join(dir, "a.txt"), "two\n");
    await git(dir, "commit", "-q", "-am", "second");
    await writeFile(join(dir, "a.txt"), "three\n");
    await git(dir, "commit", "-q", "-am", "third");
    return { dir, base };
  }

  it("lists the branch's commits from its merge base without being given it", async () => {
    const checkout = await branchCheckout();
    const sdk = {
      system: { config: async () => ({ primaryHostId: "host" }) },
      environments: { get: async () => ({ mergeBaseBranch: "main", workspacePath: checkout.dir, hostId: "host" }) },
    } as unknown as BbPluginApi["sdk"];
    const history = await environmentCommits(sdk, "env");
    expect(history.base).toBe(checkout.base);
    expect(history.commits.map((commit) => commit.summary)).toEqual(["second", "third"]);
  });

  async function load(checkoutDir: string, diff: () => string) {
    host = createFakePluginHost({
      pluginId: "diff-view",
      sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", environmentId: "env_1" }) } },
    });
    await plugin(host.bb);
    host.harness.sdk.stub("system.config", async () => ({ primaryHostId: "host" }));
    host.harness.sdk.stub("environments.get", async () => ({ id: "env_1", mergeBaseBranch: "main", workspacePath: checkoutDir, hostId: "host" }));
    host.harness.sdk.stub("environments.diff", async () => ({ outcome: "available", diff: { diff: diff(), files: "a.txt", mergeBaseRef: "f0d73cb95bf8", shortstat: "", truncated: false } }));
    return (method: string, input: unknown) => host!.harness.behavior.callRpc(method, input);
  }

  it("reads a range ending at the working tree afresh on every ask", async () => {
    const checkout = await branchCheckout();
    const call = await load(checkout.dir, () => "");
    const third = await git(checkout.dir, "rev-parse", "HEAD");
    const range = { from: third, to: WORKTREE_SHA };
    expect(((await call("diff_get", { threadId: "thr_1", range })) as DiffResult).files).toEqual([]);
    await writeFile(join(checkout.dir, "a.txt"), "four\n");
    expect(((await call("diff_get", { threadId: "thr_1", range })) as DiffResult).files.map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("marks a file viewed as it is now, though the diff was read moments earlier", async () => {
    const checkout = await branchCheckout();
    let body = "b";
    const call = await load(checkout.dir, () => `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+${body}\n`);
    await call("diff_get", { threadId: "thr_1" });
    body = "c";
    expect(await call("diff_viewed_set", { threadId: "thr_1", path: "a.txt", viewed: true })).toEqual({ paths: ["a.txt"] });
    expect(await call("diff_viewed_list", { threadId: "thr_1" })).toEqual({ paths: ["a.txt"] });
  });
});
