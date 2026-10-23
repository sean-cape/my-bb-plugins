// The conversation view's model, as GitHub's Conversation tab lays a pull request out: the description, then commits,
// comments, reviews with their threads, and changes to the pull request, oldest first. Pure, for the tests.
import type { ConversationEvent, DiffCommit, GithubComment, PullRequestSummary, ReviewVerdict } from "../../types";
import { isUnsent, type DiffThread } from "../comments/threads";

type OpenedEvent = Extract<ConversationEvent, { kind: "opened" }>;
type ActionEvent = Extract<ConversationEvent, { kind: "action" }>;

export interface ConversationReview {
  id: string;
  author: string;
  mine: boolean;
  state: ReviewVerdict;
  body: string;
  createdAt: string;
  url: string | null;
  addressedAt: number | null;
}

/** A commit and its place in the diff's commits, for reading it alone. */
export interface ConversationCommit {
  commit: DiffCommit;
  index: number;
}

export type ConversationItem =
  | { kind: "opened"; key: string; event: OpenedEvent }
  /** Commits made one after another, with nothing else between them. */
  | { kind: "commits"; key: string; commits: ConversationCommit[] }
  | { kind: "review"; key: string; review: ConversationReview; threads: DiffThread[] }
  | { kind: "comment"; key: string; comment: GithubComment }
  /** A thread outside any review: started here, or synced before its review was known. */
  | { kind: "thread"; key: string; thread: DiffThread }
  | { kind: "action"; key: string; event: ActionEvent };

/** Where the cursor stops: each item, except that a run of commits stops at each commit, and a review at each of its threads after it. */
export type ConversationStop =
  | { key: string; kind: "item"; item: Exclude<ConversationItem, { kind: "commits" | "thread" }> }
  | { key: string; kind: "commit"; commit: ConversationCommit }
  | { key: string; kind: "thread"; thread: DiffThread }
  /** A row of the summary above the timeline or the status below it: the pull request, a linked issue, a check. */
  | { key: string; kind: "link"; url: string | null };

const VERDICTS: readonly string[] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] satisfies ReviewVerdict[];

function verdict(state: string | null | undefined): ReviewVerdict {
  return state != null && VERDICTS.includes(state) ? (state as ReviewVerdict) : "COMMENTED";
}

export const threadKey = (thread: Pick<DiffThread, "id">): string => `thread:${thread.id}`;
/**
 * Whether a thread's block starts folded to its file's name, as GitHub folds a resolved or outdated conversation; one
 * holding the reader's unsent reply starts open.
 */
export function threadStartsFolded(thread: DiffThread): boolean {
  return (thread.resolved === true || thread.outdated) && !thread.entries.some(isUnsent);
}

export const commitKey = (commit: Pick<DiffCommit, "sha">): string => `commit:${commit.sha}`;

function threadTime(thread: DiffThread): number {
  const root = thread.entries[0]!;
  return root.source === "github" ? Date.parse(root.comment.createdAt) : root.comment.createdAt;
}

/** The thread's review, when its root was synced from one. */
function reviewOf(thread: DiffThread): string | null {
  const root = thread.entries[0]!;
  return root.source === "github" ? (root.comment.reviewId ?? null) : null;
}

/**
 * Every thread, synced comment, commit and event in the order they happened. Reviews come from `events` when the
 * source lists them (approvals without text included), else from the synced review comments. A GitHub thread sits
 * under the review it was submitted in, and when that review is unknown one is made up from the thread's first
 * comment, as GitHub would show it; any other thread stands on its own at its first comment.
 */
export function conversationItems(input: {
  threads: readonly DiffThread[];
  github: readonly GithubComment[];
  commits: readonly DiffCommit[];
  events: readonly ConversationEvent[];
}): ConversationItem[] {
  const stored = new Map(input.github.filter((comment) => comment.kind === "review").map((comment) => [comment.id, comment]));
  const reviews = new Map<string, ConversationReview>();
  for (const event of input.events) {
    if (event.kind !== "review") continue;
    reviews.set(event.id, { ...event, addressedAt: stored.get(event.id)?.addressedAt ?? null });
  }
  if (!input.events.some((event) => event.kind === "review")) {
    for (const comment of stored.values()) {
      reviews.set(comment.id, { id: comment.id, author: comment.author, mine: comment.mine, state: verdict(comment.reviewState), body: comment.body, createdAt: comment.createdAt, url: comment.url, addressedAt: comment.addressedAt });
    }
  }

  const timed: Array<{ at: number; item: ConversationItem }> = [];
  const threadsByReview = new Map<string, DiffThread[]>();
  for (const thread of input.threads) {
    const reviewId = reviewOf(thread);
    if (reviewId === null) {
      timed.push({ at: threadTime(thread), item: { kind: "thread", key: threadKey(thread), thread } });
      continue;
    }
    if (!reviews.has(reviewId)) {
      const root = thread.entries[0]!.comment as GithubComment;
      reviews.set(reviewId, { id: reviewId, author: root.author, mine: root.mine, state: "COMMENTED", body: "", createdAt: root.createdAt, url: root.url, addressedAt: null });
    }
    threadsByReview.set(reviewId, [...(threadsByReview.get(reviewId) ?? []), thread]);
  }
  for (const review of reviews.values()) {
    const threads = (threadsByReview.get(review.id) ?? []).sort((a, b) => threadTime(a) - threadTime(b));
    timed.push({ at: Date.parse(review.createdAt), item: { kind: "review", key: review.id, review, threads } });
  }
  for (const comment of input.github) {
    if (comment.kind === "issue-comment") timed.push({ at: Date.parse(comment.createdAt), item: { kind: "comment", key: comment.id, comment } });
  }
  input.commits.forEach((commit, index) => timed.push({ at: Date.parse(commit.date), item: { kind: "commits", key: commitKey(commit), commits: [{ commit, index }] } }));
  for (const event of input.events) {
    if (event.kind === "action") timed.push({ at: Date.parse(event.createdAt), item: { kind: "action", key: `action:${event.id}`, event } });
  }
  // An unreadable time sorts last rather than scrambling the rest.
  const at = (value: number) => (Number.isNaN(value) ? Number.POSITIVE_INFINITY : value);
  timed.sort((a, b) => at(a.at) - at(b.at));

  const items: ConversationItem[] = [];
  const opened = input.events.find((event): event is OpenedEvent => event.kind === "opened");
  if (opened !== undefined) items.push({ kind: "opened", key: "opened", event: opened });
  for (const { item } of timed) {
    const last = items.at(-1);
    if (item.kind === "commits" && last?.kind === "commits") last.commits.push(...item.commits);
    else items.push(item);
  }
  return items;
}

/** The summary's rows the cursor stops at: the pull request itself, then each issue it closes. */
export function summaryStops(pr: PullRequestSummary | null): ConversationStop[] {
  if (pr === null) return [];
  return [{ key: "summary", kind: "link", url: pr.url }, ...pr.linkedIssues.map((issue): ConversationStop => ({ key: `issue:${issue.number}`, kind: "link", url: issue.url }))];
}

/** The status box's rows: the box itself (the checks page), then each check of the head commit. */
export function statusStops(pr: PullRequestSummary | null): ConversationStop[] {
  if (pr === null) return [];
  return [{ key: "status", kind: "link", url: `${pr.url}/checks` }, ...(pr.checks?.runs ?? []).map((run, index): ConversationStop => ({ key: `check:${index}`, kind: "link", url: run.url }))];
}

export function conversationStops(items: readonly ConversationItem[], pr: PullRequestSummary | null = null): ConversationStop[] {
  const timeline = items.flatMap((item): ConversationStop[] => {
    switch (item.kind) {
      case "commits":
        return item.commits.map((commit) => ({ key: commitKey(commit.commit), kind: "commit", commit }));
      case "thread":
        return [{ key: item.key, kind: "thread", thread: item.thread }];
      case "review":
        return [{ key: item.key, kind: "item", item }, ...item.threads.map((thread): ConversationStop => ({ key: threadKey(thread), kind: "thread", thread }))];
      default:
        return [{ key: item.key, kind: "item", item }];
    }
  });
  return [...summaryStops(pr), ...timeline, ...statusStops(pr)];
}
