import type { CheckOutcome, CommentMeta, ConversationData, ConversationEvent, PullRequestSummary, Reaction } from "../../shared/comments";
import type { BoardStore } from "../board";
import type { KanbanContext } from "../context";
import { NO_GITHUB_TOKEN, githubGraphql, githubPost, githubRequest, resolveToken } from "../github";
import type { PrComments } from "./pr-comments";

const REACTIONS = "reactionGroups { content viewerHasReacted reactors { totalCount } }";
const COMMENT_META = `id databaseId authorAssociation lastEditedAt isMinimized minimizedReason ${REACTIONS}`;
const ACTOR = "id createdAt actor { login }";
const REVIEWER = "requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { name } ... on Mannequin { login } }";

/** The pull request's facts and one page of its timeline; the facts are read again with each page, which costs little. */
export const CONVERSATION_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number state isDraft merged url createdAt body lastEditedAt authorAssociation ${REACTIONS}
      author { login }
      baseRefName headRefName
      commits { totalCount }
      reviewDecision mergeable mergeStateStatus
      labels(first: 30) { nodes { name color } }
      assignees(first: 20) { nodes { login } }
      milestone { title url }
      closingIssuesReferences(first: 10) { nodes { number title url state } }
      reviewRequests(first: 20) { nodes { ${REVIEWER} } }
      latestReviews(first: 30) { nodes { author { login } state } }
      headCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl description } } } } } } }
      timelineItems(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on IssueComment { ${COMMENT_META} }
          ... on PullRequestReview { ${COMMENT_META} state body submittedAt url author { login } }
          ... on PullRequestCommit { commit { oid signature { isValid } statusCheckRollup { state } } }
          ... on HeadRefForcePushedEvent { ${ACTOR} beforeCommit { oid } afterCommit { oid } }
          ... on LabeledEvent { ${ACTOR} label { name color } }
          ... on UnlabeledEvent { ${ACTOR} label { name color } }
          ... on AssignedEvent { ${ACTOR} assignee { __typename ... on User { login } } }
          ... on UnassignedEvent { ${ACTOR} assignee { __typename ... on User { login } } }
          ... on ReviewRequestedEvent { ${ACTOR} ${REVIEWER} }
          ... on ReviewRequestRemovedEvent { ${ACTOR} ${REVIEWER} }
          ... on ReviewDismissedEvent { ${ACTOR} dismissalMessage }
          ... on CrossReferencedEvent { ${ACTOR} source { __typename ... on PullRequest { number title url repository { nameWithOwner } } ... on Issue { number title url repository { nameWithOwner } } } }
          ... on BaseRefChangedEvent { ${ACTOR} previousRefName currentRefName }
          ... on HeadRefRestoredEvent { ${ACTOR} }
          ... on HeadRefDeletedEvent { ${ACTOR} }
          ... on MilestonedEvent { ${ACTOR} milestoneTitle }
          ... on DemilestonedEvent { ${ACTOR} milestoneTitle }
          ... on AutoMergeEnabledEvent { ${ACTOR} }
          ... on AutoMergeDisabledEvent { ${ACTOR} }
          ... on MergedEvent { ${ACTOR} commit { oid } }
          ... on ClosedEvent { ${ACTOR} }
          ... on ReopenedEvent { ${ACTOR} }
          ... on ReadyForReviewEvent { ${ACTOR} }
          ... on ConvertToDraftEvent { ${ACTOR} }
          ... on RenamedTitleEvent { ${ACTOR} currentTitle }
        }
      }
    }
  }
}`;

/** The inline comments' badges and reactions, which the timeline doesn't hold. */
export const THREAD_META_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved resolvedBy { login } comments(first: 100) { nodes { ${COMMENT_META} } } }
      }
    }
  }
}`;

interface Login {
  login?: string;
}
interface ReactionGroup {
  content: string;
  viewerHasReacted: boolean;
  reactors: { totalCount: number };
}
export interface GraphqlCommentMeta {
  /** The node id reactions are added to. */
  id?: string;
  databaseId?: number | null;
  authorAssociation?: string | null;
  lastEditedAt?: string | null;
  isMinimized?: boolean;
  minimizedReason?: string | null;
  reactionGroups?: ReactionGroup[] | null;
}
type Reviewer = { __typename?: string; login?: string; name?: string } | null;
interface CheckContext {
  __typename?: string;
  name?: string;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  context?: string;
  state?: string | null;
  targetUrl?: string | null;
  description?: string | null;
}
export interface GraphqlTimelineNode extends GraphqlCommentMeta {
  __typename?: string;
  createdAt?: string;
  actor?: Login | null;
  author?: Login | null;
  state?: string;
  body?: string;
  submittedAt?: string | null;
  url?: string;
  commit?: { oid?: string; signature?: { isValid?: boolean } | null; statusCheckRollup?: { state?: string } | null } | null;
  beforeCommit?: { oid?: string } | null;
  afterCommit?: { oid?: string } | null;
  label?: { name?: string; color?: string } | null;
  assignee?: Login | null;
  requestedReviewer?: Reviewer;
  dismissalMessage?: string | null;
  source?: { number?: number; title?: string; url?: string; repository?: { nameWithOwner?: string } } | null;
  previousRefName?: string;
  currentRefName?: string;
  milestoneTitle?: string;
  currentTitle?: string;
}
export interface GraphqlPullRequest extends GraphqlCommentMeta {
  number: number;
  state: string;
  isDraft: boolean;
  merged: boolean;
  url: string;
  createdAt: string;
  body: string | null;
  author: Login | null;
  baseRefName: string;
  headRefName: string;
  commits: { totalCount: number };
  reviewDecision: string | null;
  mergeable: string;
  mergeStateStatus: string;
  labels: { nodes: Array<{ name: string; color: string }> };
  assignees: { nodes: Login[] };
  milestone: { title: string; url: string } | null;
  closingIssuesReferences: { nodes: Array<{ number: number; title: string; url: string; state: string }> };
  reviewRequests: { nodes: Array<{ requestedReviewer: Reviewer }> };
  latestReviews: { nodes: Array<{ author: Login | null; state: string }> };
  headCommit: { nodes: Array<{ commit: { statusCheckRollup: { state: string; contexts: { nodes: Array<CheckContext | null> } } | null } } | null> };
  timelineItems: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<GraphqlTimelineNode | null> };
}

const VERDICTS = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);
const REACTION_CONTENT = new Set(["THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES"]);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

function outcomeOfState(state: string | null | undefined): CheckOutcome | null {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

type CheckRun = NonNullable<PullRequestSummary["checks"]>["runs"][number];

function checkRun(context: CheckContext): CheckRun {
  if (context.__typename === "StatusContext") {
    return { name: context.context ?? "status", outcome: outcomeOfState(context.state) ?? "neutral", description: context.description ?? null, url: context.targetUrl ?? null };
  }
  const outcome: CheckOutcome =
    context.status !== "COMPLETED" ? "pending" : context.conclusion === "SUCCESS" ? "success" : FAILED.has(context.conclusion ?? "") ? "failure" : context.conclusion === "SKIPPED" ? "skipped" : "neutral";
  return { name: context.name ?? "check", outcome, description: null, url: context.detailsUrl ?? null };
}

function reactions(groups: readonly ReactionGroup[] | null | undefined): Reaction[] {
  return (groups ?? [])
    .filter((group) => group.reactors.totalCount > 0 && REACTION_CONTENT.has(group.content))
    .map((group) => ({ content: group.content as Reaction["content"], count: group.reactors.totalCount, mine: group.viewerHasReacted }));
}

export function commentMeta(node: GraphqlCommentMeta): CommentMeta {
  const association = node.authorAssociation ?? null;
  return {
    association: association === "NONE" ? null : association,
    edited: node.lastEditedAt != null,
    minimized: node.isMinimized === true ? (node.minimizedReason ?? "hidden") : null,
    reactions: reactions(node.reactionGroups),
    subject: node.id ?? null,
  };
}

const short = (sha: string) => sha.slice(0, 7);
const reviewerName = (reviewer: Reviewer) => reviewer?.login ?? reviewer?.name ?? null;

/** A timeline node as a conversation action; null for kinds the conversation shows otherwise or not at all. */
function action(node: GraphqlTimelineNode, repoUrl: string): Extract<ConversationEvent, { kind: "action" }> | null {
  const base = { kind: "action" as const, id: node.id ?? "", actor: node.actor?.login ?? "", createdAt: node.createdAt ?? "", detail: null as string | null, url: null as string | null, color: null as string | null };
  switch (node.__typename) {
    case "HeadRefForcePushedEvent": {
      const before = node.beforeCommit?.oid;
      const after = node.afterCommit?.oid;
      if (before === undefined || after === undefined) return { ...base, action: "force-pushed" };
      return { ...base, action: "force-pushed", detail: `${short(before)} to ${short(after)}`, url: `${repoUrl}/compare/${before}..${after}` };
    }
    case "LabeledEvent":
    case "UnlabeledEvent":
      return { ...base, action: node.__typename === "LabeledEvent" ? "labeled" : "unlabeled", detail: node.label?.name ?? null, color: node.label?.color ?? null };
    case "AssignedEvent":
    case "UnassignedEvent":
      return { ...base, action: node.__typename === "AssignedEvent" ? "assigned" : "unassigned", detail: node.assignee?.login ?? null };
    case "ReviewRequestedEvent":
    case "ReviewRequestRemovedEvent":
      return { ...base, action: node.__typename === "ReviewRequestedEvent" ? "review-requested" : "review-request-removed", detail: reviewerName(node.requestedReviewer ?? null) };
    case "ReviewDismissedEvent":
      return { ...base, action: "review-dismissed", detail: node.dismissalMessage ?? null };
    case "CrossReferencedEvent": {
      const source = node.source;
      if (source?.url === undefined) return null;
      return { ...base, action: "cross-referenced", detail: `${source.repository?.nameWithOwner ?? ""}#${source.number ?? ""} ${source.title ?? ""}`.trim(), url: source.url };
    }
    case "BaseRefChangedEvent":
      return { ...base, action: "base-changed", detail: node.previousRefName !== undefined && node.currentRefName !== undefined ? `${node.previousRefName} to ${node.currentRefName}` : null };
    case "HeadRefRestoredEvent":
      return { ...base, action: "branch-restored" };
    case "HeadRefDeletedEvent":
      return { ...base, action: "branch-deleted" };
    case "MilestonedEvent":
    case "DemilestonedEvent":
      return { ...base, action: node.__typename === "MilestonedEvent" ? "milestoned" : "demilestoned", detail: node.milestoneTitle ?? null };
    case "AutoMergeEnabledEvent":
      return { ...base, action: "auto-merge-enabled" };
    case "AutoMergeDisabledEvent":
      return { ...base, action: "auto-merge-disabled" };
    case "MergedEvent":
      return { ...base, action: "merged", detail: node.commit?.oid ?? null };
    case "ClosedEvent":
      return { ...base, action: "closed" };
    case "ReopenedEvent":
      return { ...base, action: "reopened" };
    case "ReadyForReviewEvent":
      return { ...base, action: "ready-for-review" };
    case "ConvertToDraftEvent":
      return { ...base, action: "converted-to-draft" };
    case "RenamedTitleEvent":
      return { ...base, action: "renamed", detail: node.currentTitle ?? null };
    default:
      return null;
  }
}

/**
 * The conversation as the diff view reads it: the pull request's facts, its description, every submitted review and
 * change, and badges by comment id and commit sha. Commits and comments come from the board instead (the diff's
 * commits, the synced comments), so the timeline's own copies of them only lend their badges. A pending review is the
 * viewer's unsent draft and stays out.
 */
/** A review thread as the badges query reads it. */
export interface GraphqlThreadMeta {
  isResolved?: boolean;
  resolvedBy?: Login | null;
  comments?: { nodes?: GraphqlCommentMeta[] };
}

export function conversationData(pr: GraphqlPullRequest, timeline: readonly (GraphqlTimelineNode | null)[], reviewThreads: readonly GraphqlThreadMeta[], viewer: string | null): ConversationData {
  const repoUrl = pr.url.replace(/\/pull\/\d+$/u, "");
  const openedId = `pr:${pr.number}`;
  const comments: ConversationData["comments"] = { [openedId]: commentMeta(pr) };
  const commits: ConversationData["commits"] = {};
  const events: ConversationEvent[] = [{ kind: "opened", id: openedId, author: pr.author?.login ?? "", body: pr.body ?? "", createdAt: pr.createdAt, url: pr.url }];
  for (const node of timeline) {
    if (node === null) continue;
    if (node.__typename === "IssueComment") {
      if (node.databaseId != null) comments[`issue-comment:${node.databaseId}`] = commentMeta(node);
      continue;
    }
    if (node.__typename === "PullRequestReview") {
      if (node.databaseId == null || node.submittedAt == null || !VERDICTS.has(node.state ?? "")) continue;
      const id = `review:${node.databaseId}`;
      const author = node.author?.login ?? "";
      comments[id] = commentMeta(node);
      events.push({ kind: "review", id, author, mine: viewer !== null && author === viewer, state: node.state as Extract<ConversationEvent, { kind: "review" }>["state"], body: node.body ?? "", createdAt: node.submittedAt, url: node.url ?? "" });
      continue;
    }
    if (node.__typename === "PullRequestCommit") {
      const oid = node.commit?.oid;
      if (oid !== undefined) commits[oid] = { verified: node.commit?.signature?.isValid ?? null, checks: outcomeOfState(node.commit?.statusCheckRollup?.state) };
      continue;
    }
    const event = action(node, repoUrl);
    if (event !== null) events.push(event);
  }
  const threads: ConversationData["threads"] = {};
  for (const thread of reviewThreads) {
    const nodes = thread.comments?.nodes ?? [];
    for (const node of nodes) if (node.databaseId != null) comments[`review-comment:${node.databaseId}`] = commentMeta(node);
    const root = nodes[0]?.databaseId;
    if (thread.isResolved === true && root != null) threads[`review-comment:${root}`] = { resolvedBy: thread.resolvedBy?.login ?? null };
  }

  const requested = pr.reviewRequests.nodes.map((node) => reviewerName(node.requestedReviewer)).filter((name): name is string => name !== null);
  const reviewed = pr.latestReviews.nodes
    .filter((node) => VERDICTS.has(node.state) && node.author?.login !== undefined && !requested.includes(node.author.login))
    .map((node) => ({ name: node.author!.login!, state: node.state as Exclude<PullRequestSummary["reviewers"][number]["state"], "REQUESTED"> }));
  const rollup = pr.headCommit.nodes[0]?.commit.statusCheckRollup ?? null;
  const pullRequest: PullRequestSummary = {
    state: pr.merged ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
    author: pr.author?.login ?? "",
    url: pr.url,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    commitCount: pr.commits.totalCount,
    labels: pr.labels.nodes,
    assignees: pr.assignees.nodes.map((node) => node.login ?? "").filter((login) => login !== ""),
    milestone: pr.milestone,
    linkedIssues: pr.closingIssuesReferences.nodes.map((issue) => ({ number: issue.number, title: issue.title, url: issue.url, open: issue.state === "OPEN" })),
    reviewers: [...reviewed, ...requested.map((name) => ({ name, state: "REQUESTED" as const }))],
    reviewDecision: pr.reviewDecision === "APPROVED" || pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED" ? pr.reviewDecision : null,
    mergeable: pr.mergeable === "MERGEABLE" || pr.mergeable === "CONFLICTING" ? pr.mergeable : "UNKNOWN",
    mergeState: pr.mergeStateStatus,
    checks:
      rollup === null
        ? null
        : { outcome: outcomeOfState(rollup.state) ?? "neutral", runs: rollup.contexts.nodes.filter((context): context is CheckContext => context !== null).map(checkRun) },
  };
  return { viewer, pullRequest, events, comments, commits, threads };
}

/** A comment id as the conversation names it, split into its kind and GitHub's number. */
function parseCommentId(id: string): { kind: "issue-comment" | "review" | "pr"; number: number } {
  const match = /^(issue-comment|review|pr):(\d+)$/u.exec(id);
  if (match === null) throw new Error(`Not a pull request comment: ${id}`);
  return { kind: match[1] as "issue-comment" | "review" | "pr", number: Number(match[2]) };
}

/** A PR card's conversation, read from GitHub each time the changes page shows it, and what the user writes in it. */
export function createPrConversation(ctx: KanbanContext, { board, prComments }: { board: BoardStore; prComments: PrComments }) {
  const { settings, stmts, publish, bb } = ctx;

  /** The card's PR and a token, for a change the user makes on GitHub. */
  async function target(ticketId: string) {
    const { pr } = board.getTicket(ticketId);
    if (pr === null) throw new Error("This card has no pull request");
    const auth = await resolveToken(settings);
    if (auth === null) throw new Error(NO_GITHUB_TOKEN);
    return { pr, token: auth.token, base: `/repos/${pr.repo}` };
  }

  /** After a change: the synced comments catch up, and the open changes page refetches through the board event. */
  async function settle(ticketId: string, token: string): Promise<void> {
    const row = stmts.byId.get(ticketId);
    if (row !== undefined) await prComments.syncPrComments(row, token).catch((error: unknown) => bb.log.warn(`could not refresh comments for ${row.pr_repo}#${row.pr_number}: ${String(error)}`));
    publish();
  }

  async function postComment(ticketId: string, body: string): Promise<void> {
    if (body.trim() === "") throw new Error("The comment is empty");
    const { pr, token, base } = await target(ticketId);
    await githubPost(`${base}/issues/${pr.number}/comments`, token, { body });
    await settle(ticketId, token);
  }

  /** Rewrites a PR-level comment, a review's summary, or the description; GitHub refuses what isn't the user's to edit. */
  async function editComment(ticketId: string, id: string, body: string): Promise<void> {
    const { kind, number } = parseCommentId(id);
    const { pr, token, base } = await target(ticketId);
    if (kind === "issue-comment") await githubRequest("PATCH", `${base}/issues/comments/${number}`, token, { body });
    else if (kind === "review") await githubRequest("PUT", `${base}/pulls/${pr.number}/reviews/${number}`, token, { body });
    else await githubRequest("PATCH", `${base}/pulls/${pr.number}`, token, { body });
    await settle(ticketId, token);
  }

  async function deleteComment(ticketId: string, id: string): Promise<void> {
    const { kind, number } = parseCommentId(id);
    if (kind !== "issue-comment") throw new Error("Only a comment can be deleted; reviews and the description stay");
    const { token, base } = await target(ticketId);
    await githubRequest("DELETE", `${base}/issues/comments/${number}`, token);
    await settle(ticketId, token);
  }

  async function toggleReaction(ticketId: string, subject: string, content: string, add: boolean): Promise<void> {
    const { token } = await target(ticketId);
    const mutation = add ? "addReaction" : "removeReaction";
    await githubGraphql(`mutation($subject: ID!, $content: ReactionContent!) { ${mutation}(input: { subjectId: $subject, content: $content }) { clientMutationId } }`, { subject, content }, token);
    publish();
  }

  async function prConversation(ticketId: string): Promise<ConversationData> {
    const { pr } = board.getTicket(ticketId);
    if (pr === null) return { viewer: null, pullRequest: null, events: [], comments: {}, commits: {}, threads: {} };
    const auth = await resolveToken(settings);
    if (auth === null) throw new Error(NO_GITHUB_TOKEN);
    const [owner, name] = pr.repo.split("/");
    const variables = { owner, name, number: pr.number };

    const readTimeline = async () => {
      const nodes: Array<GraphqlTimelineNode | null> = [];
      let first: { pr: GraphqlPullRequest; viewer: string | null } | null = null;
      let after: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const data: { viewer?: Login | null; repository: { pullRequest: GraphqlPullRequest | null } | null } = await githubGraphql(CONVERSATION_QUERY, { ...variables, after }, auth.token);
        const pull = data.repository?.pullRequest ?? null;
        if (pull === null) throw new Error(`GitHub has no pull request ${pr.repo}#${pr.number}`);
        first ??= { pr: pull, viewer: data.viewer?.login ?? null };
        nodes.push(...pull.timelineItems.nodes);
        if (!pull.timelineItems.pageInfo.hasNextPage || pull.timelineItems.pageInfo.endCursor === null) break;
        after = pull.timelineItems.pageInfo.endCursor;
      }
      return { ...first!, nodes };
    };
    const readThreadMeta = async () => {
      const metas: GraphqlThreadMeta[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const data: { repository: { pullRequest: { reviewThreads: { pageInfo?: { hasNextPage: boolean; endCursor: string | null }; nodes: GraphqlThreadMeta[] } } | null } | null } =
          await githubGraphql(THREAD_META_QUERY, { ...variables, after }, auth.token);
        const threads = data.repository?.pullRequest?.reviewThreads;
        metas.push(...(threads?.nodes ?? []));
        if (threads?.pageInfo?.hasNextPage !== true || threads.pageInfo.endCursor === null) break;
        after = threads.pageInfo.endCursor;
      }
      return metas;
    };
    const [timeline, threadMeta] = await Promise.all([readTimeline(), readThreadMeta()]);
    return conversationData(timeline.pr, timeline.nodes, threadMeta, timeline.viewer);
  }

  return { prConversation, postComment, editComment, deleteComment, toggleReaction };
}
