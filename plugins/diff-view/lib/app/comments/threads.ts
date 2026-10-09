import type { DiffComment, DiffCommentTarget, GithubComment, LineRange } from "../../types";

export type ThreadEntry = { source: "github"; comment: GithubComment } | { source: "local"; comment: DiffComment };

/** A conversation anchored to a line, a range ending at `line`, or the file: a GitHub review thread or one started on the board, with replies from either. */
export interface DiffThread extends LineRange {
  id: string;
  path: string;
  entries: ThreadEntry[];
  /** Replies may be posted to GitHub: the root is an inline GitHub comment, or a GitHub draft that will become one. */
  onGithub: boolean;
  outdated: boolean;
  resolved: boolean | null;
  /** The replies' root is gone (deleted on GitHub, or not synced); they are shown together but cannot be answered. */
  orphaned: boolean;
}

export type LocalCommentState = "pending" | "draft" | "submitted" | "posted" | "addressed" | "agent";

export function localCommentState(comment: DiffComment): LocalCommentState {
  if (comment.author !== null) return "agent";
  if (comment.target === "github") return comment.postedAt === null ? "draft" : "posted";
  if (comment.addressedAt !== null) return "addressed";
  return comment.applyId !== null ? "submitted" : "pending";
}

function entryTime(entry: ThreadEntry): number {
  return entry.source === "github" ? Date.parse(entry.comment.createdAt) : entry.comment.createdAt;
}

export function isUnsent(entry: ThreadEntry): boolean {
  if (entry.source === "github") return false;
  const state = localCommentState(entry.comment);
  return state === "pending" || state === "draft";
}

/** Merge synced GitHub review comments with the board's own diff comments into threads; posted drafts show once, as their synced copy. */
export function buildDiffThreads(local: readonly DiffComment[], github: readonly GithubComment[]): DiffThread[] {
  const synced = new Set(github.filter((comment) => comment.kind === "review-comment").map((comment) => comment.id));
  // Only an inline synced copy replaces a posted draft; drafts that went into a review body have no inline copy to show.
  const visible = local.filter((comment) => comment.githubCommentId === null || !synced.has(comment.githubCommentId));
  const threads = new Map<string, DiffThread>();
  const alias = new Map<string, string>();
  const inline = github.filter((comment): comment is GithubComment & { path: string } => comment.kind === "review-comment" && comment.path !== null);
  const fromGithub = (comment: GithubComment & { path: string }): DiffThread => ({
    id: comment.id,
    path: comment.path,
    line: comment.outdated ? null : comment.line,
    side: comment.side,
    startLine: comment.outdated ? null : comment.startLine,
    startSide: comment.outdated ? null : comment.startSide,
    entries: [{ source: "github", comment }],
    onGithub: true,
    outdated: comment.outdated,
    resolved: comment.resolved,
    orphaned: false,
  });
  const fromLocal = (comment: DiffComment): DiffThread => ({
    id: comment.id,
    path: comment.path,
    line: comment.line,
    side: comment.side,
    startLine: comment.startLine,
    startSide: comment.startSide,
    entries: [{ source: "local", comment }],
    onGithub: comment.target === "github" && comment.line !== null && (comment.postedAt === null || (comment.githubCommentId?.startsWith("review-comment:") ?? false)),
    outdated: false,
    resolved: null,
    orphaned: false,
  });
  for (const comment of inline) if (comment.inReplyTo === null) threads.set(comment.id, fromGithub(comment));
  for (const comment of visible) {
    if (comment.inReplyTo !== null) continue;
    threads.set(comment.id, fromLocal(comment));
    if (comment.githubCommentId !== null) alias.set(comment.githubCommentId, comment.id);
  }
  const attach = (rootId: string, entry: ThreadEntry, orphan: () => DiffThread) => {
    const thread = threads.get(rootId) ?? threads.get(alias.get(rootId) ?? "");
    if (thread !== undefined) thread.entries.push(entry);
    else threads.set(rootId, { ...orphan(), id: rootId, onGithub: false, orphaned: true });
  };
  for (const comment of inline) if (comment.inReplyTo !== null) attach(comment.inReplyTo, { source: "github", comment }, () => fromGithub(comment));
  for (const comment of visible) if (comment.inReplyTo !== null) attach(comment.inReplyTo, { source: "local", comment }, () => fromLocal(comment));
  for (const thread of threads.values()) {
    const [root, ...replies] = thread.entries;
    replies.sort((a, b) => entryTime(a) - entryTime(b));
    thread.entries = [root!, ...replies];
  }
  return [...threads.values()];
}

export function threadIsOpen(thread: DiffThread): boolean {
  if (thread.resolved === true) return false;
  if (thread.entries.some(isUnsent)) return true;
  const root = thread.entries[0]!;
  return root.source === "github" ? true : root.comment.addressedAt === null;
}

/** What the review keys can do in a thread, matching the buttons its comments show. */
export interface ThreadKeyActions {
  canReply: boolean;
  /** Your latest comment that has not been sent yet: the one `e`, `dd` and `M` act on. */
  ownUnsent: DiffComment | null;
  /** Where `M` moves that comment, when it can move. */
  moveTo: DiffCommentTarget | null;
  /** The thread on GitHub, for `gx`. */
  url: string | null;
  /** The agent thread that last replied, for `go`. */
  agentThread: string | null;
}

export function threadKeyActions(thread: DiffThread, canPostToGithub: boolean): ThreadKeyActions {
  const local = thread.entries.filter((entry): entry is ThreadEntry & { source: "local" } => entry.source === "local");
  const unsent = local.filter(isUnsent).at(-1) ?? null;
  const ownUnsent = unsent?.comment ?? null;
  let moveTo: DiffCommentTarget | null = null;
  if (ownUnsent !== null && canPostToGithub) {
    if (localCommentState(ownUnsent) === "draft") moveTo = "local";
    else if (unsent === thread.entries[0] ? ownUnsent.line !== null : thread.onGithub) moveTo = "github";
  }
  const root = thread.entries[0]!;
  const posted = local.map((entry) => entry.comment.postedUrl).filter((url): url is string => url !== null);
  return {
    canReply: !thread.orphaned,
    ownUnsent,
    moveTo,
    url: root.source === "github" ? root.comment.url : (posted[0] ?? null),
    agentThread: local.filter((entry) => entry.comment.author !== null && entry.comment.authorThreadId !== null).at(-1)?.comment.authorThreadId ?? null,
  };
}
