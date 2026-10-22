import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  blameRev,
  checkedRange,
  emptyDiff,
  environmentCommits,
  environmentDiff,
  environmentFileSides,
  environmentRangeDiff,
  environmentRangeFileSides,
  gitBlame,
  grepDefinitions,
  grepUsages,
  hideVendoredFiles,
  isVendoredPath,
  localEnvironmentPath,
  noCommits,
  patchFromSides,
  runDifftastic,
  structuralUnavailable,
} from "bb-diff-view/server";
import { commitRangeKey, type DiffSide, type FileSides } from "bb-diff-view/types";
import type { Ticket } from "../../shared/board";
import type { BlameLine, CommitRange, DiffCommits, StructuralDiff, SymbolLookup, SymbolUsages, TicketDiff } from "../../shared/diff";
import type { KanbanContext } from "../context";
import {
  COMPARE_FILE_LIMIT,
  GITHUB_API,
  NO_GITHUB_TOKEN,
  compareCommits,
  github,
  githubBlame,
  githubHeaders,
  githubPages,
  mergeBaseOf,
  pullCommits,
  resolveToken,
  type GithubPull,
  type GithubPullFile,
  type GithubReview,
} from "../github";
import { commitsFromGithub, reviewMarks } from "./commits";
import { errorMessage, execFileAsync } from "../util";

type DiffFile = TicketDiff["files"][number];

/** GitHub lists at most 3,000 files of a pull request: 30 pages of 100. */
const PR_FILE_PAGES = 30;
const PR_FILE_LIMIT = PR_FILE_PAGES * 100;
const NO_ENVIRONMENT = "The card's thread has no environment yet.";
/** How long a PR's diff is kept, and an environment's range (its local git read). */
const PR_DIFF_TTL_MS = 10 * 60_000;
const ENVIRONMENT_RANGE_TTL_MS = 15_000;
const DIFF_CACHE_LIMIT = 200;
/** git's blob id of an empty file, which GitHub gives an added or removed empty file. */
const EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/** A file of a GitHub pull request or comparison as the diff view reads it. */
export function diffFileFromGithub(file: GithubPullFile): DiffFile {
  return {
    path: file.filename,
    previousPath: file.previous_filename ?? null,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch ?? null,
    vendored: isVendoredPath(file.filename),
    // GitHub gives no binary flag. A file with neither a patch nor line counts is one, unless only its name or mode
    // changed or it is empty.
    binary: file.patch === undefined && file.additions === 0 && file.deletions === 0 && file.sha !== EMPTY_BLOB_SHA && ["added", "removed", "modified"].includes(file.status),
  };
}

type Truncation = Pick<TicketDiff, "truncated" | "truncatedNote">;

/** Whether GitHub's file list of a pull request (`listed` files of its `changedFiles`) left some out. */
export function prTruncation(listed: number, changedFiles: number | undefined): Truncation {
  const limit = PR_FILE_LIMIT.toLocaleString();
  if (changedFiles !== undefined) {
    if (listed >= changedFiles) return { truncated: false, truncatedNote: null };
    return {
      truncated: true,
      truncatedNote: `Showing ${listed.toLocaleString()} of this pull request's ${changedFiles.toLocaleString()} changed files: GitHub lists at most ${limit}. Open it on GitHub, or review it from a local checkout, for the rest.`,
    };
  }
  if (listed < PR_FILE_LIMIT) return { truncated: false, truncatedNote: null };
  return { truncated: true, truncatedNote: `GitHub lists at most ${limit} files of a pull request; this one may have more.` };
}

/** Whether GitHub's comparison of a range, `listed` files long, may have left files out. */
export function compareTruncation(listed: number): Truncation {
  if (listed < COMPARE_FILE_LIMIT) return { truncated: false, truncatedNote: null };
  return { truncated: true, truncatedNote: `GitHub compares at most ${COMPARE_FILE_LIMIT} files, so these commits may change more than are shown. Pick fewer commits, or All changes, for the rest.` };
}

/** The file of a diff at `path`, by its new or old path. */
export function fileInDiff(diff: TicketDiff, path: string): DiffFile {
  const file = diff.files.find((entry) => entry.path === path || entry.previousPath === path);
  if (file === undefined) throw new Error(`${path} is not in this card's diff`);
  return file;
}

export async function containsCommit(dir: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: dir, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** A card's changes, file sides, structural diffs and symbol lookups. */
export function createChanges(ctx: KanbanContext) {
  const { bb, settings } = ctx;

  const diffCache = new Map<string, { key: string; diff: TicketDiff }>();

  /** The card's changes (or a range of their commits), minus vendored files when the setting hides them. */
  async function ticketDiff(ticket: Ticket, refresh: boolean, range: CommitRange | null = null): Promise<TicketDiff> {
    const diff = range === null ? await fullTicketDiff(ticket, refresh) : await rangeDiff(ticket, checkedRange(range), refresh);
    return (await settings.get()).hideVendored ? hideVendoredFiles(diff) : diff;
  }

  /** Cached per card and range: a PR's until it updates, an environment range's for a few seconds. */
  function cachedDiff(ticket: Ticket, range: CommitRange | null, refresh: boolean): TicketDiff | null {
    const cached = diffCache.get(`${ticket.id}@${commitRangeKey(range)}`);
    if (refresh || cached === undefined) return null;
    const age = Date.now() - cached.diff.fetchedAt;
    if (ticket.pr !== null) return cached.key === `pr:${ticket.pr.updatedAt}` && age < PR_DIFF_TTL_MS ? cached.diff : null;
    return range !== null && age < ENVIRONMENT_RANGE_TTL_MS ? cached.diff : null;
  }

  function cacheDiff(ticket: Ticket, range: CommitRange | null, diff: TicketDiff): void {
    const id = `${ticket.id}@${commitRangeKey(range)}`;
    diffCache.delete(id);
    if (diffCache.size >= DIFF_CACHE_LIMIT) diffCache.delete(diffCache.keys().next().value!);
    diffCache.set(id, { key: ticket.pr === null ? "env" : `pr:${ticket.pr.updatedAt}`, diff });
  }

  /** The changes of part of the card's history: GitHub's compare for a PR, else the thread's local checkout. */
  async function rangeDiff(ticket: Ticket, range: CommitRange, refresh: boolean): Promise<TicketDiff> {
    const cached = cachedDiff(ticket, range, refresh);
    if (cached !== null) return cached;
    let diff: TicketDiff;
    if (ticket.pr !== null) {
      const auth = await resolveToken(settings);
      if (auth === null) return emptyDiff("pr", NO_GITHUB_TOKEN);
      const { mergeBase, files } = await compareCommits(ticket.pr.repo, range.from, range.to, auth.token);
      diff = {
        source: "pr",
        files: files.map(diffFileFromGithub),
        baseRef: range.from.slice(0, 7),
        // The comparison is three-dot, so the old side is the merge base: `from` itself for a commit of the PR.
        baseSha: mergeBase ?? range.from,
        headSha: range.to,
        ...compareTruncation(files.length),
        message: null,
        fetchedAt: Date.now(),
        hiddenVendored: null,
        repo: ticket.pr.repo,
        environmentId: null,
      };
    } else if (ticket.threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId: ticket.threadId });
      if (thread.environmentId === null) return emptyDiff("none", NO_ENVIRONMENT);
      diff = await environmentRangeDiff(bb.sdk, thread.environmentId, range);
    } else {
      return emptyDiff("none", "No pull request or thread to diff.");
    }
    cacheDiff(ticket, range, diff);
    return diff;
  }

  /** The card's commits for the commit picker, with the review marks that are among them. */
  async function ticketCommits(ticket: Ticket): Promise<DiffCommits> {
    const lastReviewSha = ctx.stmts.latestCompletedReview.get(ticket.id)?.commit_sha ?? null;
    if (ticket.pr !== null) {
      const auth = await resolveToken(settings);
      if (auth === null) return noCommits();
      const [list, githubReviews, diff] = await Promise.all([
        pullCommits(ticket.pr.repo, ticket.pr.number, auth.token),
        githubPages<GithubReview>(`/repos/${ticket.pr.repo}/pulls/${ticket.pr.number}/reviews`, auth.token).catch(() => null),
        // Usually cached: the changes page has just read it. Its old side is the merge base the PR's commits start at.
        fullTicketDiff(ticket, false),
      ]);
      const commits = commitsFromGithub(list);
      return { commits, marks: reviewMarks(commits, lastReviewSha, githubReviews, ctx.sync.login), base: diff.baseSha };
    }
    if (ticket.threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId: ticket.threadId });
      if (thread.environmentId === null) return noCommits();
      const found = await environmentCommits(bb.sdk, thread.environmentId);
      return { ...found, marks: reviewMarks(found.commits, lastReviewSha, null, null) };
    }
    return noCommits();
  }

  /** The card's changes: the PR's files from GitHub, else the thread environment's working diff. */
  async function fullTicketDiff(ticket: Ticket, refresh: boolean): Promise<TicketDiff> {
    const now = Date.now();
    if (ticket.pr !== null) {
      const cached = cachedDiff(ticket, null, refresh);
      if (cached !== null) return cached;
      const auth = await resolveToken(settings);
      if (auth === null) {
        return emptyDiff("pr", NO_GITHUB_TOKEN);
      }
      const { repo, number } = ticket.pr;
      const [pull, files] = await Promise.all([
        github<GithubPull & { base?: { ref?: string; sha?: string }; head?: { sha?: string }; changed_files?: number }>(`/repos/${repo}/pulls/${number}`, auth.token),
        githubPages<GithubPullFile>(`/repos/${repo}/pulls/${number}/files`, auth.token, undefined, PR_FILE_PAGES),
      ]);
      const baseTip = pull.base?.sha ?? null;
      const headSha = pull.head?.sha ?? null;
      // GitHub diffs a PR from where it branched, so the old side is the merge base; the base branch's tip has moved
      // on whenever something merged into it since.
      const mergeBase =
        baseTip === null || headSha === null
          ? null
          : await mergeBaseOf(repo, baseTip, headSha, auth.token).catch((error: unknown) => {
              bb.log.warn(`could not read the merge base of ${repo}#${number}: ${errorMessage(error)}`);
              return null;
            });
      const diff: TicketDiff = {
        source: "pr",
        files: files.map(diffFileFromGithub),
        baseRef: pull.base?.ref ?? null,
        baseSha: mergeBase ?? baseTip,
        headSha,
        ...prTruncation(files.length, pull.changed_files),
        message: null,
        fetchedAt: now,
        hiddenVendored: null,
        repo,
        environmentId: null,
      };
      cacheDiff(ticket, null, diff);
      return diff;
    }
    if (ticket.threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId: ticket.threadId });
      if (thread.environmentId === null) return emptyDiff("none", NO_ENVIRONMENT);
      return environmentDiff(bb.sdk, thread.environmentId);
    }
    return emptyDiff("none", "No pull request or thread to diff.");
  }

  /** Both sides of one file of the card's diff (`diff`, read for `range`), as text; null for a side that does not exist or is binary. */
  async function fileSides(ticket: Ticket, diff: TicketDiff, file: DiffFile, range: CommitRange | null): Promise<FileSides> {
    if (ticket.pr !== null) {
      const auth = await resolveToken(settings);
      if (auth === null) throw new Error(NO_GITHUB_TOKEN);
      const fetchSide = async (ref: string | null, filePath: string): Promise<string | null> => {
        if (ref === null) return null;
        const response = await fetch(`${GITHUB_API}/repos/${ticket.pr!.repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`, {
          headers: githubHeaders(auth.token, "application/vnd.github.raw+json"),
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`GitHub ${response.status} fetching ${filePath}@${ref.slice(0, 7)}`);
        return response.text();
      };
      return {
        old: file.status === "added" ? null : await fetchSide(diff.baseSha, file.previousPath ?? file.path),
        new: file.status === "removed" ? null : await fetchSide(diff.headSha, file.path),
      };
    }
    if (ticket.threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId: ticket.threadId });
      if (thread.environmentId === null) throw new Error(NO_ENVIRONMENT);
      if (range !== null) return environmentRangeFileSides(bb.sdk, thread.environmentId, range, file);
      return environmentFileSides(bb.sdk, thread.environmentId, file, diff.baseRef);
    }
    throw new Error("No pull request or thread to diff.");
  }

  /** The text patch of a file the diff came without one for, made from its two sides. */
  async function loadPatch(ticket: Ticket, path: string, range: CommitRange | null = null): Promise<string | null> {
    const diff = await ticketDiff(ticket, false, range);
    const file = fileInDiff(diff, path);
    const sides = await fileSides(ticket, diff, file, range);
    return patchFromSides(file.path, file.previousPath, sides.old, sides.new);
  }

  const structuralCache = new Map<string, StructuralDiff>();

  async function structuralDiff(ticket: Ticket, path: string, range: CommitRange | null = null): Promise<StructuralDiff> {
    if (isVendoredPath(path)) return structuralUnavailable("Vendored file; the structural diff skips these.");
    const diff = await ticketDiff(ticket, false, range);
    const sides = await fileSides(ticket, diff, fileInDiff(diff, path), range);
    const cacheKey = `${ticket.id}:${commitRangeKey(range)}:${path}:${diff.headSha ?? "env"}:${(sides.old ?? "").length}:${(sides.new ?? "").length}`;
    const cached = structuralCache.get(cacheKey);
    if (cached !== undefined && diff.headSha !== null) return cached;
    const result = await runDifftastic((await settings.get()).difftPath, path, sides);
    if (result.available) structuralCache.set(cacheKey, result);
    return result;
  }

  /** Where a symbol is defined: `git grep` in a local workspace of the card, else GitHub code search for PR cards. */
  async function symbolDefinitions(ticket: Ticket, symbol: string): Promise<SymbolLookup> {
    const localDir = await localWorkspaceDir(ticket);
    if (localDir !== null) {
      const definitions = await grepDefinitions(localDir.path, symbol);
      // A failed git grep falls through to GitHub.
      if (definitions !== null) return { symbol, definitions, open: { kind: "environment", environmentId: localDir.environmentId }, searched: "workspace" };
    }
    if (ticket.pr !== null) {
      const auth = await resolveToken(settings);
      const diff = await ticketDiff(ticket, false);
      if (auth !== null) {
        const response = await fetch(`${GITHUB_API}/search/code?q=${encodeURIComponent(`${symbol} repo:${ticket.pr.repo}`)}&per_page=20`, {
          headers: githubHeaders(auth.token, "application/vnd.github.text-match+json"),
        });
        if (response.ok) {
          const body = (await response.json()) as { items?: Array<{ path: string; text_matches?: Array<{ fragment: string }> }> };
          const definitions = (body.items ?? []).map((item) => ({
            path: item.path,
            line: null,
            snippet: (item.text_matches?.[0]?.fragment ?? "").split("\n").find((line) => line.includes(symbol))?.trim().slice(0, 200) ?? "",
            context: null,
          }));
          return { symbol, definitions, open: { kind: "github", repo: ticket.pr.repo, sha: diff.headSha ?? "HEAD" }, searched: "github" };
        }
      }
      return { symbol, definitions: [], open: { kind: "github", repo: ticket.pr.repo, sha: diff.headSha ?? "HEAD" }, searched: "none" };
    }
    return { symbol, definitions: [], open: { kind: "none" }, searched: "none" };
  }

  async function symbolUsages(ticket: Ticket, symbol: string): Promise<SymbolUsages> {
    const localDir = await localWorkspaceDir(ticket);
    if (localDir === null) return { symbol, usages: [], open: { kind: "none" }, searched: "none", truncated: false };
    return { symbol, ...(await grepUsages(localDir.path, symbol)), open: { kind: "environment", environmentId: localDir.environmentId }, searched: "workspace" };
  }

  /**
   * A checkout of the card's code on this server machine: the card thread's environment, else its latest review's.
   * For PR cards, a checkout that does not contain the PR head is only used when no candidate does, since the
   * card thread's worktree often lags the PR branch and would miss symbols the PR introduces.
   */
  async function localWorkspaceDir(ticket: Ticket): Promise<{ path: string; environmentId: string } | null> {
    const candidates = [ticket.threadId, ticket.latestReview?.threadId ?? null].filter((id): id is string => id !== null);
    const headSha = ticket.pr === null ? null : (await ticketDiff(ticket, false)).headSha;
    let stale: { path: string; environmentId: string } | null = null;
    for (const threadId of candidates) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId === null) continue;
        const path = await localEnvironmentPath(bb.sdk, thread.environmentId);
        if (path === null) continue;
        const found = { path, environmentId: thread.environmentId };
        if (headSha === null || (await containsCommit(path, headSha))) return found;
        stale ??= found;
      } catch {
        continue;
      }
    }
    return stale;
  }

  async function peekFile(ticket: Ticket, path: string, startLine: number, endLine: number): Promise<{ startLine: number; lines: string[]; totalLines: number }> {
    const localDir = await localWorkspaceDir(ticket);
    if (localDir === null) throw new Error("No local checkout to read from.");
    if (path.includes("..") || path.startsWith("/")) throw new Error("Invalid path");
    const text = await readFile(join(localDir.path, path), "utf8");
    const all = text.split("\n");
    const start = Math.max(1, Math.min(startLine, endLine));
    const end = Math.min(all.length, Math.max(startLine, endLine));
    return { startLine: start, lines: all.slice(start - 1, end), totalLines: all.length };
  }

  /**
   * Who last changed lines of one side of a file in the card's diff, at the commits the diff compares: with commits
   * picked, the range's end and its old side (on a PR, the comparison's merge base); else a PR's head and merge base,
   * or an environment's working tree and merge base. A PR's are read from a local checkout that has them, else from
   * GitHub's blame.
   */
  async function blame(ticket: Ticket, path: string, side: DiffSide, startLine: number, endLine: number, range: CommitRange | null = null): Promise<BlameLine[]> {
    const diff = await ticketDiff(ticket, false, range);
    const file = fileInDiff(diff, path);
    const filePath = side === "LEFT" ? (file.previousPath ?? file.path) : file.path;
    const localDir = await localWorkspaceDir(ticket);
    if (ticket.pr !== null) {
      const rev = diff.baseSha === null || diff.headSha === null ? null : blameRev(side, range, diff.baseSha, diff.headSha);
      if (rev === null) throw new Error("The PR's commits aren't known yet; refresh the diff.");
      if (localDir !== null && (await containsCommit(localDir.path, rev))) return gitBlame(localDir.path, rev, filePath, startLine, endLine);
      const auth = await resolveToken(settings);
      if (auth === null) throw new Error(NO_GITHUB_TOKEN);
      return githubBlame(ticket.pr.repo, rev, filePath, startLine, endLine, auth.token);
    }
    if (localDir === null) throw new Error("Blame needs a local checkout of the card's thread.");
    return gitBlame(localDir.path, blameRev(side, range, diff.baseRef, diff.headSha), filePath, startLine, endLine);
  }

  return { ticketDiff, structuralDiff, symbolDefinitions, symbolUsages, peekFile, loadPatch, blame, ticketCommits };
}

export type Changes = ReturnType<typeof createChanges>;
