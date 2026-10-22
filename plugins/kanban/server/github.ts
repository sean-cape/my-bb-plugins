import type { PullRequest, SyncStatus } from "../shared/board";
import type { BlameLine } from "../shared/diff";
import type { KanbanSettings } from "./settings";
import { USER_AGENT, execFileAsync } from "./util";

export const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

/** A non-2xx GitHub response; `status` tells a rejected payload (422) apart from an outage. */
export class GithubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function githubHeaders(token: string, accept = "application/vnd.github+json"): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept, "user-agent": USER_AGENT };
}

// GitHub API shapes (only the fields read)

export interface GithubSearchItem {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  user: { login: string } | null;
  updated_at: string;
  repository_url: string;
  body?: string | null;
  pull_request?: { merged_at: string | null };
}

export interface GithubUser {
  login: string;
}
export interface GithubIssueComment {
  id: number;
  user: GithubUser | null;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}
export interface GithubReviewComment extends GithubIssueComment {
  node_id?: string;
  pull_request_review_id?: number | null;
  path: string;
  line: number | null;
  original_line: number | null;
  side?: "LEFT" | "RIGHT";
  start_line?: number | null;
  original_start_line?: number | null;
  start_side?: "LEFT" | "RIGHT" | null;
  in_reply_to_id?: number;
  diff_hunk?: string;
}
export interface GithubReview {
  id: number;
  node_id?: string;
  user: GithubUser | null;
  body: string | null;
  state: string;
  html_url: string;
  submitted_at?: string;
  /** The commit the review was left on. */
  commit_id?: string | null;
}

export interface GithubPullFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  /** The file's blob. */
  sha?: string;
}

export interface GithubPull {
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  html_url: string;
  updated_at: string;
  user: { login: string } | null;
  body?: string | null;
}

export function repoFromRepositoryUrl(url: string): string {
  // https://api.github.com/repos/owner/repo
  return url.replace(/^https:\/\/api\.github\.com\/repos\//u, "").toLowerCase();
}

export { githubRepoFromRemote } from "bb-diff-view/server";

/** `repo#number`, how thread titles name a PR. */
export function prShortName(pr: { repo: string; number: number }): string {
  return `${pr.repo.split("/")[1]}#${pr.number}`;
}

export function prStateOf(item: {
  state: "open" | "closed";
  draft?: boolean;
  merged: boolean;
}): PullRequest["state"] {
  if (item.merged) return "merged";
  if (item.state === "closed") return "closed";
  return item.draft === true ? "draft" : "open";
}

export async function resolveToken(settings: KanbanSettings): Promise<{ token: string; source: SyncStatus["tokenSource"] } | null> {
  const { githubToken, ghPath } = await settings.get();
  if (typeof githubToken === "string" && githubToken.trim() !== "") {
    return { token: githubToken.trim(), source: "setting" };
  }
  try {
    const { stdout } = await execFileAsync(ghPath.trim() || "gh", ["auth", "token"], { timeout: 10_000 });
    const token = stdout.trim();
    return token === "" ? null : { token, source: "gh-cli" };
  } catch {
    return null;
  }
}

export async function github<T>(path: string, token: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: { ...githubHeaders(token), "x-github-api-version": API_VERSION },
    signal: signal ?? null,
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new GithubHttpError(response.status, `GitHub ${response.status} for ${path}: ${body}`);
  }
  return (await response.json()) as T;
}

export async function githubPost<T>(path: string, token: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: "POST",
    signal: signal ?? null,
    headers: { ...githubHeaders(token), "content-type": "application/json", "x-github-api-version": API_VERSION },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new GithubHttpError(response.status, `GitHub ${response.status} for ${path}: ${text}`);
  }
  return (await response.json()) as T;
}

/** A PUT, PATCH or DELETE; a 204 comes back as null. */
export async function githubRequest<T>(method: "PUT" | "PATCH" | "DELETE", path: string, token: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    signal: signal ?? null,
    headers: { ...githubHeaders(token), "x-github-api-version": API_VERSION, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new GithubHttpError(response.status, `GitHub ${response.status} for ${method} ${path}: ${text}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text === "" ? null : (JSON.parse(text) as T);
}

/** A GraphQL query or mutation; GraphQL errors throw like HTTP ones do. */
export async function githubGraphql<T>(query: string, variables: Record<string, unknown>, token: string, signal?: AbortSignal): Promise<T> {
  const result = await githubPost<{ data?: T; errors?: Array<{ message: string }> }>("/graphql", token, { query, variables }, signal);
  if (result.errors !== undefined && result.errors.length > 0) throw new Error(result.errors.map((error) => error.message).join("; "));
  if (result.data === undefined) throw new Error("GitHub GraphQL returned no data");
  return result.data;
}

/** Every page of a GitHub list endpoint, capped so a runaway PR cannot stall the sync. */
export async function githubPages<T>(path: string, token: string, signal?: AbortSignal, maxPages = 10): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await github<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token, signal);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

export interface ReviewThreadInfo {
  /** The thread's node id, which replies into a pending review address. */
  id: string;
  isResolved: boolean;
  path: string;
  /** Null for a comment on the file as a whole. An outdated thread keeps the line it was left on. */
  line: number | null;
  side: "LEFT" | "RIGHT";
  startLine: number | null;
  startSide: "LEFT" | "RIGHT" | null;
}

function diffSide(side: string | null | undefined): "LEFT" | "RIGHT" {
  return side === "LEFT" ? "LEFT" : "RIGHT";
}

/**
 * Each review thread (the signed-in user's pending ones included) keyed by its first comment's id, with where it
 * sits in the diff. REST exposes neither the ids nor, for a pending review's comments, the lines: its list of them
 * is the legacy shape without `line` or `side`, and reading one by id can 404.
 */
export async function reviewThreads(repo: string, number: number, token: string, signal?: AbortSignal): Promise<Map<number, ReviewThreadInfo>> {
  const [owner, name] = repo.split("/");
  const map = new Map<number, ReviewThreadInfo>();
  let after: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array<{
              id?: string;
              isResolved: boolean;
              path: string;
              line: number | null;
              originalLine: number | null;
              startLine: number | null;
              originalStartLine: number | null;
              diffSide: "LEFT" | "RIGHT";
              startDiffSide: "LEFT" | "RIGHT" | null;
              comments: { nodes: Array<{ databaseId: number | null }> };
            }>;
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      } | null;
    } = await githubGraphql(
      `query($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                nodes { id isResolved path line originalLine startLine originalStartLine diffSide startDiffSide comments(first: 1) { nodes { databaseId } } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
      { owner, name, number, after },
      token,
      signal,
    );
    const threads = data.repository?.pullRequest?.reviewThreads;
    for (const thread of threads?.nodes ?? []) {
      const rootId = thread.comments.nodes[0]?.databaseId;
      if (rootId === null || rootId === undefined) continue;
      const startLine = thread.startLine ?? thread.originalStartLine ?? null;
      map.set(rootId, {
        id: thread.id ?? "",
        isResolved: thread.isResolved,
        path: thread.path,
        line: thread.line ?? thread.originalLine ?? null,
        side: diffSide(thread.diffSide),
        startLine,
        startSide: startLine === null ? null : diffSide(thread.startDiffSide ?? thread.diffSide),
      });
    }
    if (threads?.pageInfo?.hasNextPage !== true || threads.pageInfo.endCursor === null) break;
    after = threads.pageInfo.endCursor;
  }
  return map;
}

/** Resolves or reopens the review thread rooted at `rootId` (its first comment's id); returns the state GitHub reports after. */
export async function setReviewThreadResolved(repo: string, number: number, rootId: number, resolved: boolean, token: string, signal?: AbortSignal): Promise<boolean> {
  const thread = (await reviewThreads(repo, number, token, signal)).get(rootId);
  if (thread === undefined || thread.id === "") throw new Error("The thread was not found on GitHub");
  const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const data = await githubGraphql<Record<string, { thread: { isResolved: boolean } | null } | null>>(
    `mutation($threadId: ID!) { ${field}(input: { threadId: $threadId }) { thread { isResolved } } }`,
    { threadId: thread.id },
    token,
    signal,
  );
  return data[field]?.thread?.isResolved ?? resolved;
}

/** Resolved state per review thread, keyed by the thread's first comment id. */
export async function reviewThreadResolution(repo: string, number: number, token: string, signal?: AbortSignal): Promise<Map<number, boolean>> {
  return new Map(Array.from(await reviewThreads(repo, number, token, signal), ([rootId, thread]) => [rootId, thread.isResolved]));
}

/** GitHub's StatusState for a commit's check rollup; EXPECTED is a required status nothing has reported yet. */
export function checksFromRollup(state: string | null | undefined): PullRequest["checks"] {
  switch (state) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

export interface PrHead {
  headRef: string;
  checks: PullRequest["checks"];
  checksUrl: string | null;
}

/** One check run or commit status in the head commit's rollup, as GitHub's GraphQL union returns it. */
export interface PrCheckContext {
  __typename?: string;
  /** CheckRun: COMPLETED, IN_PROGRESS, QUEUED, … */
  status?: string | null;
  /** CheckRun: SUCCESS, FAILURE, NEUTRAL, SKIPPED, … once completed. */
  conclusion?: string | null;
  detailsUrl?: string | null;
  /** StatusContext: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED. */
  state?: string | null;
  targetUrl?: string | null;
}

interface PrHeadNode {
  pullRequest: {
    headRefName: string;
    commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string; contexts?: { nodes?: Array<PrCheckContext | null> | null } | null } | null } } | null> | null };
  } | null;
}

const FAILED_CONCLUSIONS = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

function contextOutcome(context: PrCheckContext): "failing" | "pending" | "other" {
  if (context.state !== undefined && context.state !== null) {
    if (context.state === "FAILURE" || context.state === "ERROR") return "failing";
    if (context.state === "PENDING" || context.state === "EXPECTED") return "pending";
    return "other";
  }
  if (context.status !== undefined && context.status !== null && context.status !== "COMPLETED") return "pending";
  if (context.conclusion !== undefined && context.conclusion !== null && FAILED_CONCLUSIONS.has(context.conclusion)) return "failing";
  return "other";
}

/** The page the checks tick should open: the first failing check's, else the first pending one's, else the first with a page at all. */
export function checksUrlFromContexts(contexts: ReadonlyArray<PrCheckContext | null> | null | undefined): string | null {
  const withUrl = (contexts ?? []).filter((context): context is PrCheckContext => context !== null).map((context) => ({ context, url: context.detailsUrl ?? context.targetUrl ?? null })).filter((entry): entry is { context: PrCheckContext; url: string } => entry.url !== null);
  for (const outcome of ["failing", "pending", "other"] as const) {
    const hit = withUrl.find((entry) => contextOutcome(entry.context) === outcome);
    if (hit !== undefined) return hit.url;
  }
  return null;
}

/** Aliases a batched query answers, keyed `pr0`, `pr1`, … in the order of `prs`. */
export type PrHeadsData = Record<string, PrHeadNode | null | undefined> | null | undefined;

const PR_HEADS_CHUNK = 40;

function prHeadsQuery(prs: ReadonlyArray<{ repo: string; number: number }>): { query: string; variables: Record<string, string | number> } {
  const variables: Record<string, string | number> = {};
  const params: string[] = [];
  const fields: string[] = [];
  prs.forEach((pr, index) => {
    const [owner = "", name = ""] = pr.repo.split("/");
    variables[`owner${index}`] = owner;
    variables[`name${index}`] = name;
    variables[`number${index}`] = pr.number;
    params.push(`$owner${index}: String!, $name${index}: String!, $number${index}: Int!`);
    fields.push(
      `pr${index}: repository(owner: $owner${index}, name: $name${index}) {
        pullRequest(number: $number${index}) {
          headRefName
          commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes { __typename ... on CheckRun { status conclusion detailsUrl } ... on StatusContext { state targetUrl } } } } } } }
        }
      }`,
    );
  });
  return { query: `query(${params.join(", ")}) {\n${fields.join("\n")}\n}`, variables };
}

/**
 * Head branch and CI status per `repo#number`. A PR whose repository or pull request did not come back (deleted, no
 * access) is left out, so the caller keeps what it had.
 */
export function parsePrHeads(prs: ReadonlyArray<{ repo: string; number: number }>, data: PrHeadsData): Map<string, PrHead> {
  const heads = new Map<string, PrHead>();
  prs.forEach((pr, index) => {
    const pull = data?.[`pr${index}`]?.pullRequest;
    if (pull === null || pull === undefined) return;
    const rollup = pull.commits.nodes?.[0]?.commit.statusCheckRollup ?? null;
    heads.set(`${pr.repo}#${pr.number}`, { headRef: pull.headRefName, checks: checksFromRollup(rollup?.state), checksUrl: checksUrlFromContexts(rollup?.contexts?.nodes) });
  });
  return heads;
}

/**
 * Head branch and CI status for many PRs, one GraphQL request per chunk since the search API returns neither. A failed
 * chunk, or errors that came back alongside data (one repo gone), go to `warn`; the other chunks still count.
 */
export async function fetchPrHeads(
  prs: ReadonlyArray<{ repo: string; number: number }>,
  token: string,
  signal: AbortSignal | undefined,
  warn: (message: string) => void,
): Promise<Map<string, PrHead>> {
  const heads = new Map<string, PrHead>();
  for (let start = 0; start < prs.length && signal?.aborted !== true; start += PR_HEADS_CHUNK) {
    const chunk = prs.slice(start, start + PR_HEADS_CHUNK);
    let result: { data?: PrHeadsData; errors?: Array<{ message: string }> };
    try {
      result = await githubPost("/graphql", token, prHeadsQuery(chunk), signal);
    } catch (error) {
      warn(String(error));
      continue;
    }
    const errors = (result.errors ?? []).map((error) => error.message).join("; ");
    if (errors !== "") warn(errors);
    for (const [key, head] of parsePrHeads(chunk, result.data)) heads.set(key, head);
  }
  return heads;
}

export async function searchPulls(query: string, token: string, signal?: AbortSignal): Promise<GithubSearchItem[]> {
  const items: GithubSearchItem[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await github<{ items: GithubSearchItem[]; total_count: number }>(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
      token,
      signal,
    );
    items.push(...result.items);
    if (result.items.length < 100 || items.length >= result.total_count) break;
  }
  return items;
}

/** One range of GitHub's GraphQL blame: the lines one commit last changed. */
export interface GithubBlameRange {
  startingLine: number;
  endingLine: number;
  commit: { oid: string; messageHeadline: string; authoredDate: string; author: { name: string | null; user: { login: string } | null } | null };
}

/** GitHub's blame ranges as one entry per line of `start`–`end`. */
export function blameLinesFromRanges(ranges: readonly GithubBlameRange[], start: number, end: number): BlameLine[] {
  const lines: BlameLine[] = [];
  for (const range of ranges) {
    const author = range.commit.author?.user?.login ?? range.commit.author?.name ?? "unknown";
    const time = Date.parse(range.commit.authoredDate);
    for (let line = Math.max(start, range.startingLine); line <= Math.min(end, range.endingLine); line++) {
      lines.push({ line, sha: range.commit.oid, author, time: Number.isNaN(time) ? 0 : time, summary: range.commit.messageHeadline });
    }
  }
  return lines.sort((a, b) => a.line - b.line);
}

const BLAME_QUERY = `query($owner: String!, $name: String!, $expression: String!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      ... on Commit {
        blame(path: $path) {
          ranges { startingLine endingLine commit { oid messageHeadline authoredDate author { name user { login } } } }
        }
      }
    }
  }
}`;

/** Who last changed lines `start`–`end` of `path` at commit `sha`, from GitHub's GraphQL blame. */
export async function githubBlame(repo: string, sha: string, path: string, start: number, end: number, token: string, signal?: AbortSignal): Promise<BlameLine[]> {
  const [owner, name] = repo.split("/");
  const data = await githubGraphql<{ repository: { object: { blame?: { ranges: GithubBlameRange[] } } | null } | null }>(BLAME_QUERY, { owner, name, expression: sha, path }, token, signal);
  const ranges = data.repository?.object?.blame?.ranges;
  if (ranges === undefined) throw new Error(`GitHub has no blame for ${path} at ${sha.slice(0, 7)}`);
  return blameLinesFromRanges(ranges, start, end);
}

/** One entry of `/pulls/{n}/commits`. */
export interface GithubPullCommit {
  sha: string;
  commit: { message: string; author: { name?: string | null; date?: string | null } | null };
  author: { login: string } | null;
}

/** A pull request's commits, oldest first; GitHub lists at most 250. */
export async function pullCommits(repo: string, number: number, token: string, signal?: AbortSignal): Promise<GithubPullCommit[]> {
  return githubPages<GithubPullCommit>(`/repos/${repo}/pulls/${number}/commits`, token, signal, 3);
}

/** GitHub lists at most this many files of a comparison. */
export const COMPARE_FILE_LIMIT = 300;

/** The changes from `from` to `to` (three-dot: from their merge base), as GitHub compares them. */
export async function compareCommits(repo: string, from: string, to: string, token: string, signal?: AbortSignal): Promise<{ mergeBase: string | null; files: GithubPullFile[] }> {
  const result = await github<{ merge_base_commit?: { sha?: string } | null; files?: GithubPullFile[] }>(`/repos/${repo}/compare/${from}...${to}`, token, signal);
  return { mergeBase: result.merge_base_commit?.sha ?? null, files: result.files ?? [] };
}

/** Where `head` branched from `base`: the old side of a pull request's diff, which GitHub takes three-dot. */
export async function mergeBaseOf(repo: string, base: string, head: string, token: string, signal?: AbortSignal): Promise<string | null> {
  // One commit and file a page: only the merge base is wanted.
  const result = await github<{ merge_base_commit?: { sha?: string } | null }>(`/repos/${repo}/compare/${base}...${head}?per_page=1`, token, signal);
  return result.merge_base_commit?.sha ?? null;
}
