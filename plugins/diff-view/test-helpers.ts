// Fixtures the diff view's tests share. Not a test file itself, so vitest runs none of it; the tests that import it
// typecheck it.
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewEnv } from "./lib/app/keys/review-commands";
import type { FileNavModel } from "./lib/app/keys/review-keys-context";
import type { DiffComment, GithubComment, StructuralDiff } from "./lib/types";

export const execFileAsync = promisify(execFile);

/** A 40-character sha made of one digit, so tests can name commits 1, 2, 3. */
export const sha = (n: number): string => String(n).repeat(40).slice(0, 40);

/** git in `cwd` as a throwaway author, unsigned; its output, trimmed. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
}

/** A new repository on `main` in a temp directory; the caller removes it. */
export async function tempRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await git(dir, "init", "-q", "-b", "main");
  return dir;
}

/**
 * The SDK as `bb-diff-view/server` reads an environment: one on this host with its checkout at `workspacePath` (null:
 * none here) and `main` as its merge base branch. With `truncatedDiff`, its diff is that text and file list, cut at
 * bb's size limit.
 */
export function fakeEnvironmentSdk(workspacePath: string | null, truncatedDiff?: { diff: string; files: string }): BbPluginApi["sdk"] {
  const diff = truncatedDiff === undefined ? {} : { diff: async () => ({ outcome: "available", diff: { ...truncatedDiff, mergeBaseRef: "HEAD", shortstat: "", truncated: true } }) };
  return {
    system: { config: async () => ({ primaryHostId: "host" }) },
    environments: { get: async () => ({ mergeBaseBranch: "main", workspacePath, hostId: "host" }), ...diff },
  } as unknown as BbPluginApi["sdk"];
}

type KeyState = ReturnType<ReviewEnv["keys"]["get"]>;

/**
 * A `ReviewEnv` for `runReviewCommand`: no files, threads or findings, every line on screen, and key state starting
 * from `keys` (no cursor by default) over `keys.models`; `overrides` replace any other part. `state()` reads the key
 * state as the command left it.
 */
export function reviewEnv(overrides: Partial<Record<keyof ReviewEnv, unknown>> = {}, keys: Partial<KeyState> & { models?: Map<string, FileNavModel> } = {}): { env: ReviewEnv; state: () => KeyState } {
  const { models = new Map(), ...start } = keys;
  let state = { cursor: null, visual: null, pending: "", focused: null, cursorShown: true, ...start } as KeyState;
  const env = {
    keys: { get: () => state, set: (patch: Partial<KeyState>) => (state = { ...state, ...patch }), models, threads: new Map(), findings: new Map() },
    files: [],
    threads: [],
    findings: [],
    onScreen: () => true,
    seat: () => null,
    reveal: () => {},
    notify: () => {},
    ...overrides,
  } as unknown as ReviewEnv;
  return { env, state: () => state };
}

/** One of the board's own diff comments: a pending local one on line 1 of `a.ts` unless overridden. */
export function localComment(overrides: Partial<DiffComment> & { id: string }): DiffComment {
  return {
    path: "a.ts",
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

/** A synced GitHub review comment on line 1 of `a.ts` unless overridden. */
export function githubComment(overrides: Partial<GithubComment> & { id: string }): GithubComment {
  return {
    kind: "review-comment",
    author: "octocat",
    mine: false,
    body: "body",
    path: "a.ts",
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

/** A structural diff of `aligned` line pairs, with the new and old lines listed changed. */
export function structural(aligned: StructuralDiff["aligned"], changedNew: number[] = [], changedOld: number[] = []): StructuralDiff {
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
