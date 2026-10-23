import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { landedStatus } from "./landed.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The user's global config may sign commits; these repositories are throwaway.
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Alex", GIT_AUTHOR_EMAIL: "alex@acme.example", GIT_COMMITTER_NAME: "Alex", GIT_COMMITTER_EMAIL: "alex@acme.example" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

/** A repository on `main` with one commit, and a branch `feature` with one more that changes `a.txt`. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "landed-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "start");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), "two\n");
  git(dir, "commit", "-q", "-am", "change");
  return dir;
}

describe("landedStatus", () => {
  it("counts a branch's commits as not landed until main has their changes", async () => {
    expect(await landedStatus(repo(), "main")).toEqual({ state: "unlanded", base: "main", files: 1, conflicts: false });
  });

  it("counts work cherry-picked onto main as landed, though main has other commits", async () => {
    const dir = repo();
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "b.txt"), "elsewhere\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "another session");
    git(dir, "cherry-pick", "feature");
    git(dir, "checkout", "-q", "feature");
    expect(git(dir, "merge-base", "main", "HEAD")).not.toBe(git(dir, "rev-parse", "HEAD"));
    expect(await landedStatus(dir, "main")).toEqual({ state: "landed", base: "main", pushed: null });
  });

  it("says when merging would conflict", async () => {
    const dir = repo();
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "a.txt"), "three\n");
    git(dir, "commit", "-q", "-am", "clash");
    git(dir, "checkout", "-q", "feature");
    expect(await landedStatus(dir, "main")).toEqual({ state: "unlanded", base: "main", files: 1, conflicts: true });
  });

  it("has nothing to say about a branch with no commits beyond main", async () => {
    const dir = repo();
    git(dir, "checkout", "-q", "main");
    expect(await landedStatus(dir, "main")).toEqual({ state: "none" });
    expect(await landedStatus(dir, "no-such-branch")).toEqual({ state: "none" });
  });

  it("tells landed on main from pushed, through main's upstream", async () => {
    const dir = repo();
    const remote = mkdtempSync(join(tmpdir(), "landed-remote-"));
    dirs.push(remote);
    git(remote, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", remote);
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "b.txt"), "elsewhere\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "another session");
    git(dir, "push", "-q", "-u", "origin", "main");
    git(dir, "cherry-pick", "feature");
    git(dir, "checkout", "-q", "feature");
    expect(await landedStatus(dir, "main")).toEqual({ state: "landed", base: "main", pushed: false });
    git(dir, "push", "-q", "origin", "main");
    expect(await landedStatus(dir, "main")).toEqual({ state: "landed", base: "main", pushed: true });
  });
});
