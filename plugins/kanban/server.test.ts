import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { PluginThreadEventPayloads, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import type { ReadingPlan } from "./shared/reading-plan";
import plugin, { adfToText, defaultSelected, githubRepoFromRemote, newLineRangesFromPatch, parseNarrative, parseProposal, parseReviewReport, splitUnifiedDiff, type Board, type CodeReviewThread, type CommentApply, type DiffComment, type Dump, type Finding, type Narrative, type NarrativeStory, type PrComment, type Review, type StructuralDiff, type SymbolLookup, type Ticket, type TicketDiff } from "./server";
import type { ConversationData } from "./shared/comments";
import { LOOP_STOPPED } from "./shared/events";
import { loopStateSchema, openFindingsClause, phaseChip } from "./shared/loop";

type Host = ReturnType<typeof createFakePluginHost>;
type ThreadResponse = ReturnType<typeof makeThreadResponse>;

interface SearchItem {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  user: { login: string };
  updated_at: string;
  repository_url: string;
  pull_request: { merged_at: string | null };
}

function searchItem(repo: string, number: number, overrides: Partial<SearchItem> = {}): SearchItem {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/${repo}/pull/${number}`,
    state: "open",
    draft: false,
    user: { login: "octocat" },
    updated_at: "2026-10-05T00:00:00Z",
    repository_url: `https://api.github.com/repos/${repo}`,
    pull_request: { merged_at: null },
    ...overrides,
  };
}

/** A fetch stub keyed by URL substring; `pulls` answers the per-PR refresh. */
interface JiraStubIssue {
  key: string;
  summary: string;
  status?: string;
  category?: "new" | "indeterminate" | "done";
  type?: string;
  priority?: string | null;
  assignee?: string | null;
  description?: unknown;
}

function jiraIssueJson(issue: JiraStubIssue) {
  return {
    key: issue.key,
    fields: {
      summary: issue.summary,
      description: issue.description ?? null,
      updated: "2026-10-06T00:00:00.000+0000",
      status: { name: issue.status ?? "To Do", statusCategory: { key: issue.category ?? "new" } },
      issuetype: { name: issue.type ?? "Task" },
      priority: issue.priority === undefined ? { name: "Medium" } : issue.priority === null ? null : { name: issue.priority },
      assignee: issue.assignee === undefined ? { displayName: "Sean" } : issue.assignee === null ? null : { displayName: issue.assignee },
    },
  };
}

/** Resolve / unresolve mutations the GitHub stub received, by thread root id. */
let resolvedMutations: Array<{ rootId: number; resolve: boolean }> = [];

function stubGithub(options: {
  authored?: SearchItem[];
  requested?: SearchItem[];
  pulls?: Record<string, { state: "open" | "closed"; merged: boolean; draft?: boolean; title?: string }>;
  jira?: JiraStubIssue[];
  jiraIssues?: Record<string, JiraStubIssue>;
  jiraFail?: boolean;
  files?: unknown[];
  rejectInline?: boolean;
  contents?: Record<string, string>;
  codeSearch?: Array<{ path: string; fragment: string }>;
  comments?: {
    issue?: Array<{ id: number; login: string; body: string }>;
    review?: Array<{ id: number; login: string; body: string; path: string; line: number | null; side?: "LEFT" | "RIGHT"; startLine?: number; replyTo?: number; hunk?: string; reviewId?: number }>;
    reviews?: Array<{ id: number; login: string; body: string; state: string; submitted?: boolean }>;
  };
  /** Root review-comment ids of resolved threads, answered from the GraphQL reviewThreads query. */
  resolvedThreads?: number[];
  /** The pull request as the conversation's GraphQL query reads it, and its inline comments' badges. */
  conversation?: { pr: Record<string, unknown>; threadComments?: unknown[] };
  /** Head branch and check rollup per `repo#number` for the batched GraphQL query; a missing PR comes back null. */
  heads?: Record<string, { headRef: string; rollup: string | null }>;
  failHeads?: boolean;
  failReadBack?: boolean;
  /** A pending review already on GitHub when the test starts, as if begun there. */
  pending?: { login?: string; body?: string; comments: Array<Omit<StubPendingComment, "id" | "side" | "start_line" | "start_side"> & Partial<Pick<StubPendingComment, "side" | "start_line" | "start_side">>> };
  /** GitHub serves no record for a pending comment read by id, as it does for some left on github.com. */
  pendingRecordsMissing?: boolean;
}) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  ghPending = { reviews: [], nextComment: 9000, created: [] };
  resolvedMutations = [];
  const pendingComment = (comment: Partial<StubPendingComment> & { path: string; body: string }): StubPendingComment => ({
    id: ghPending.nextComment++, path: comment.path, line: comment.line ?? null, side: comment.side ?? "RIGHT", start_line: comment.start_line ?? null, start_side: comment.start_side ?? null, body: comment.body,
    ...(comment.in_reply_to_id === undefined ? {} : { in_reply_to_id: comment.in_reply_to_id }),
  });
  if (options.pending !== undefined) {
    ghPending.reviews.push({ id: 600, node_id: "PRR_600", login: options.pending.login ?? "sean", body: options.pending.body ?? "", comments: options.pending.comments.map((comment) => pendingComment(comment)), submitted: null });
  }
  const pendingCommentJson = (review: StubPendingReview, comment: StubPendingComment) => ({
    id: comment.id, node_id: `PRRC_${comment.id}`, pull_request_review_id: review.id, user: { login: review.login }, body: comment.body, path: comment.path, line: comment.line, original_line: comment.line ?? 1, side: comment.side,
    start_line: comment.start_line, original_start_line: comment.start_line, start_side: comment.start_side,
    ...(comment.in_reply_to_id === undefined ? {} : { in_reply_to_id: comment.in_reply_to_id }),
    html_url: `https://github.com/acme-co/widgets/pull/7#discussion_r${comment.id}`, created_at: "2026-10-06T09:00:00Z", updated_at: "2026-10-06T09:00:00Z",
  });
  const STATE: Record<string, string> = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.split("?")[0]!;
    if (url.startsWith("https://acme.atlassian.net/")) {
      if (options.jiraFail) return new Response("boom", { status: 500 });
      if (url.includes("/rest/api/3/search/jql")) {
        return json({ issues: (options.jira ?? []).map(jiraIssueJson), isLast: true });
      }
      const key = /\/rest\/api\/3\/issue\/([^?]+)/u.exec(url)?.[1];
      const issue = key === undefined ? undefined : options.jiraIssues?.[decodeURIComponent(key)];
      return issue === undefined ? new Response("not found", { status: 404 }) : json(jiraIssueJson(issue));
    }
    if (url.includes("/user")) return json({ login: "sean" });
    if (url.includes("/search/issues")) {
      const items = url.includes("user-review-requested") ? (options.requested ?? []) : (options.authored ?? []);
      return json({ total_count: items.length, items });
    }
    const method = typeof input === "object" && input !== null && "method" in input ? (input as Request).method : (init?.method ?? "GET");
    if (method === "POST" && url.endsWith("/graphql")) {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string | number | null> };
      if (/\b(add|remove)Reaction\(/u.test(request.query)) return json({ data: { reaction: { clientMutationId: null } } });
      if (request.query.includes("timelineItems(")) return json({ data: { viewer: { login: "sean" }, repository: { pullRequest: options.conversation?.pr ?? null } } });
      if (request.query.includes("reviewThreads(first: 50")) {
        return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ isResolved: true, resolvedBy: { login: "alex" }, comments: { nodes: options.conversation?.threadComments ?? [] } }] } } } } });
      }
      if (request.query.includes("addPullRequestReviewThread(")) {
        const review = ghPending.reviews.find((entry) => entry.node_id === request.variables.reviewId && entry.submitted === null);
        if (review === undefined) return json({ errors: [{ message: "Could not resolve to a node with the global id" }] });
        const v = request.variables;
        if (v.line !== null && Number(v.line) > 50) return json({ errors: [{ message: "Line could not be found in the diff" }] });
        const comment = pendingComment({ path: String(v.path), body: String(v.body), line: v.line === null ? null : Number(v.line), side: v.side === "LEFT" ? "LEFT" : "RIGHT", start_line: v.startLine === null ? null : Number(v.startLine), start_side: v.startLine === null ? null : v.startSide === "LEFT" ? "LEFT" : "RIGHT" });
        review.comments.push(comment);
        return json({ data: { addPullRequestReviewThread: { thread: { comments: { nodes: [{ databaseId: comment.id, url: `https://github.com/acme-co/widgets/pull/7#discussion_r${comment.id}` }] } } } } });
      }
      if (request.query.includes("addPullRequestReviewThreadReply(")) {
        const review = ghPending.reviews.find((entry) => entry.node_id === request.variables.reviewId && entry.submitted === null);
        const rootId = Number(String(request.variables.threadId).replace("PRRT_", ""));
        if (review === undefined || Number.isNaN(rootId)) return json({ errors: [{ message: "Could not resolve to a node with the global id" }] });
        const comment = pendingComment({ path: "a.go", body: String(request.variables.body), in_reply_to_id: rootId });
        review.comments.push(comment);
        return json({ data: { addPullRequestReviewThreadReply: { comment: { databaseId: comment.id, url: `https://github.com/acme-co/widgets/pull/7#discussion_r${comment.id}` } } } });
      }
      if (request.query.includes("resolveReviewThread(")) {
        const resolve = !/\bunresolveReviewThread\(/u.test(request.query);
        const rootId = Number(String(request.variables.threadId).replace("PRRT_", ""));
        if (Number.isNaN(rootId)) return json({ errors: [{ message: "Could not resolve to a node with the global id" }] });
        resolvedMutations.push({ rootId, resolve });
        options.resolvedThreads = (options.resolvedThreads ?? []).filter((id) => id !== rootId).concat(resolve ? [rootId] : []);
        return json({ data: { [resolve ? "resolveReviewThread" : "unresolveReviewThread"]: { thread: { isResolved: resolve } } } });
      }
      if (request.query.includes("statusCheckRollup")) {
        if (options.failHeads) return new Response("boom", { status: 502 });
        const data: Record<string, unknown> = {};
        for (let index = 0; `owner${index}` in request.variables; index += 1) {
          const { [`owner${index}`]: owner, [`name${index}`]: name, [`number${index}`]: number } = request.variables;
          const head = options.heads?.[`${owner}/${name}#${number}`];
          data[`pr${index}`] =
            head === undefined
              ? null
              : { pullRequest: { headRefName: head.headRef, commits: { nodes: [{ commit: { statusCheckRollup: head.rollup === null ? null : { state: head.rollup } } }] } } };
        }
        return json({ data });
      }
      const roots = new Set(options.resolvedThreads ?? []);
      const threadNode = (comment: { id: number; path: string; line: number | null; side?: "LEFT" | "RIGHT"; start_line?: number | null; start_side?: "LEFT" | "RIGHT" | null }, isResolved: boolean) => ({
        id: `PRRT_${comment.id}`,
        isResolved,
        path: comment.path,
        line: comment.line,
        originalLine: comment.line,
        startLine: comment.start_line ?? null,
        originalStartLine: comment.start_line ?? null,
        diffSide: comment.side ?? "RIGHT",
        startDiffSide: comment.start_side ?? null,
        comments: { nodes: [{ databaseId: comment.id }] },
      });
      const nodes = (options.comments?.review ?? []).filter((comment) => comment.replyTo === undefined).map((comment) => threadNode({ ...comment, start_line: comment.startLine }, roots.has(comment.id)));
      for (const review of ghPending.reviews) {
        for (const comment of review.comments) {
          if (comment.in_reply_to_id === undefined) nodes.push(threadNode(comment, false));
        }
      }
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
    }
    const pendingCommentRoute = /\/pulls\/comments\/(\d+)$/u.exec(path);
    if (pendingCommentRoute !== null) {
      const id = Number(pendingCommentRoute[1]);
      const review = ghPending.reviews.find((entry) => entry.comments.some((comment) => comment.id === id));
      if (review === undefined || (method === "GET" && options.pendingRecordsMissing === true)) return new Response("not found", { status: 404 });
      if (method === "GET") return json(pendingCommentJson(review, review.comments.find((comment) => comment.id === id)!));
      if (method === "DELETE") {
        review.comments = review.comments.filter((comment) => comment.id !== id);
        return new Response(null, { status: 204 });
      }
      review.comments.find((comment) => comment.id === id)!.body = (JSON.parse(String(init?.body)) as { body: string }).body;
      return json(pendingCommentJson(review, review.comments.find((comment) => comment.id === id)!));
    }
    const reviewEvents = /\/pulls\/(\d+)\/reviews\/(\d+)\/events$/u.exec(path);
    if (reviewEvents !== null && method === "POST") {
      const review = ghPending.reviews.find((entry) => entry.id === Number(reviewEvents[2]) && entry.submitted === null);
      if (review === undefined) return new Response("not found", { status: 404 });
      const body = JSON.parse(String(init?.body)) as { event: string; body?: string };
      events.push({ reviewId: review.id, ...body });
      review.submitted = body.event;
      if (body.body !== undefined) review.body = body.body;
      return json({ id: review.id, html_url: `https://github.com/acme-co/widgets/pull/7#pullrequestreview-${review.id}` });
    }
    const reviewById = /\/pulls\/(\d+)\/reviews\/(\d+)$/u.exec(path);
    if (reviewById !== null && (method === "PUT" || method === "DELETE")) {
      const index = ghPending.reviews.findIndex((entry) => entry.id === Number(reviewById[2]));
      if (index === -1) return new Response("not found", { status: 404 });
      if (method === "DELETE") {
        ghPending.reviews.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      ghPending.reviews[index]!.body = (JSON.parse(String(init?.body)) as { body: string }).body;
      return json({ id: ghPending.reviews[index]!.id, body: ghPending.reviews[index]!.body });
    }
    if (method === "POST" && /\/pulls\/\d+\/reviews$/u.test(url)) {
      const body = JSON.parse(String(init?.body ?? (await (input as Request).text()))) as { event?: string; comments?: Array<{ path: string; body: string; line?: number; side?: "LEFT" | "RIGHT"; start_line?: number; start_side?: "LEFT" | "RIGHT" }>; body?: string; commit_id?: string };
      if (body.event === undefined) {
        // No event: a pending review, kept in the stub's state rather than among the posted reviews.
        ghPending.created.push(body);
        const id = 600 + ghPending.reviews.length + ghPending.created.length;
        ghPending.reviews.push({
          id, node_id: `PRR_${id}`, login: "sean", body: body.body ?? "", submitted: null,
          comments: (body.comments ?? []).map((comment) => pendingComment({ path: comment.path, body: comment.body, line: comment.line ?? null, side: comment.side ?? "RIGHT", start_line: comment.start_line ?? null, start_side: comment.start_side ?? null })),
        });
        return json({ id, node_id: `PRR_${id}`, html_url: `https://github.com/acme-co/widgets/pull/7#pullrequestreview-${id}` });
      }
      posted.push(body);
      if (options.rejectInline && (body.comments?.length ?? 0) > 0) return new Response("Unprocessable", { status: 422 });
      return json({ id: 900 + posted.length, html_url: `https://github.com/acme-co/widgets/pull/7#pullrequestreview-${900 + posted.length}` });
    }
    const replyPost = /\/pulls\/\d+\/comments\/(\d+)\/replies$/u.exec(url);
    if (method === "POST" && replyPost !== null) {
      const body = JSON.parse(String(init?.body)) as { body: string };
      repliesPosted.push({ to: Number(replyPost[1]), body: body.body });
      const id = 7000 + repliesPosted.length;
      return json({ id, html_url: `https://github.com/acme-co/widgets/pull/7#discussion_r${id}` });
    }
    const reviewReadBack = /\/pulls\/\d+\/reviews\/(\d+)\/comments/u.exec(url);
    if (reviewReadBack !== null) {
      const pendingReview = ghPending.reviews.find((entry) => entry.id === Number(reviewReadBack[1]));
      if (pendingReview !== undefined) {
        // GitHub's legacy review-comment shape: no line, side or start line.
        return json(pendingReview.comments.map((comment) => {
          const { line, side, start_line, start_side, original_line, original_start_line, ...legacy } = pendingCommentJson(pendingReview, comment);
          return { ...legacy, position: line ?? null };
        }));
      }
      if (options.failReadBack) return new Response("boom", { status: 502 });
      const review = posted[Number(reviewReadBack[1]) - 901];
      return json(
        (review?.comments ?? []).map((comment, index) => ({
          id: 8000 + index, path: comment.path, body: comment.body, html_url: `https://github.com/acme-co/widgets/pull/7#discussion_r${8000 + index}`,
        })),
      );
    }
    const contents = /\/repos\/([^/]+\/[^/]+)\/contents\/(.+)\?ref=([^&]+)/u.exec(url);
    if (contents !== null) {
      const body = options.contents?.[`${decodeURIComponent(contents[2]!)}@${contents[3]}`];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
    }
    if (url.includes("/search/code")) {
      return json({ items: (options.codeSearch ?? []).map((item) => ({ path: item.path, text_matches: [{ fragment: item.fragment }] })) });
    }
    if (/\/pulls\/\d+\/files/u.test(url)) {
      return json(
        options.files ?? [
          { filename: "a.go", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n line\n-old\n+new\n+more" },
          { filename: "img.png", status: "added", additions: 0, deletions: 0 },
        ],
      );
    }
    if (/\/issues\/comments\/\d+$/u.test(path)) return method === "DELETE" ? new Response(null, { status: 204 }) : json({});
    if (method === "POST" && /\/issues\/\d+\/comments$/u.test(path)) return json({ id: 77 });
    const issueComments = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments/u.exec(url);
    if (issueComments !== null) {
      return json(
        (options.comments?.issue ?? []).map((comment) => ({
          id: comment.id, user: { login: comment.login }, body: comment.body,
          html_url: `https://github.com/${issueComments[1]}/pull/${issueComments[2]}#issuecomment-${comment.id}`,
          created_at: "2026-10-05T10:00:00Z", updated_at: "2026-10-05T10:00:00Z",
        })),
      );
    }
    const reviewComments = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments/u.exec(url);
    if (reviewComments !== null) {
      // Comments of submitted pending reviews are published now, so they list with the rest.
      const published = ghPending.reviews.filter((review) => review.submitted !== null).flatMap((review) => review.comments.map((comment) => pendingCommentJson(review, comment)));
      return json([
        ...published,
        ...(options.comments?.review ?? []).map((comment) => ({
          id: comment.id, user: { login: comment.login }, body: comment.body, path: comment.path, line: comment.line, original_line: comment.line ?? 1, side: comment.side ?? "RIGHT",
          ...(comment.replyTo === undefined ? {} : { in_reply_to_id: comment.replyTo }),
          ...(comment.hunk === undefined ? {} : { diff_hunk: comment.hunk }),
          ...(comment.reviewId === undefined ? {} : { pull_request_review_id: comment.reviewId }),
          ...(comment.startLine === undefined
            ? { start_line: null, original_start_line: null, start_side: null }
            : { start_line: comment.line === null ? null : comment.startLine, original_start_line: comment.startLine, start_side: comment.side ?? "RIGHT" }),
          html_url: `https://github.com/${reviewComments[1]}/pull/${reviewComments[2]}#discussion_r${comment.id}`,
          created_at: "2026-10-05T11:00:00Z", updated_at: "2026-10-05T11:00:00Z",
        })),
      ]);
    }
    const reviews = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews/u.exec(url);
    if (reviews !== null) {
      return json([
        ...(options.comments?.reviews ?? []).map((review) => ({
          id: review.id, user: { login: review.login }, body: review.body, state: review.state,
          html_url: `https://github.com/${reviews[1]}/pull/${reviews[2]}#pullrequestreview-${review.id}`,
          ...(review.submitted === false ? {} : { submitted_at: "2026-10-05T12:00:00Z" }),
        })),
        ...ghPending.reviews.map((review) => ({
          id: review.id, node_id: review.node_id, user: { login: review.login }, body: review.body, state: review.submitted === null ? "PENDING" : STATE[review.submitted],
          html_url: `https://github.com/${reviews[1]}/pull/${reviews[2]}#pullrequestreview-${review.id}`,
          ...(review.submitted === null ? {} : { submitted_at: "2026-10-06T12:00:00Z" }),
        })),
      ]);
    }
    const match = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/u.exec(url);
    if (match !== null) {
      const pull = options.pulls?.[`${match[1]}#${match[2]}`] ?? { state: "open" as const, merged: false, title: `PR ${match[2]}` };
      return json({
        title: pull.title ?? `PR ${match[2]}`,
        state: pull.state,
        merged: pull.merged,
        draft: pull.draft ?? false,
        html_url: `https://github.com/${match[1]}/pull/${match[2]}`,
        updated_at: "2026-10-05T01:00:00Z",
        created_at: "2026-10-04T09:00:00Z",
        body: "Adds widgets",
        user: { login: "octocat" },
        base: { ref: "main", sha: "1111111111111111111111111111111111111111" },
        head: { sha: "9f3b2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c" },
      });
    }
    return new Response("unexpected", { status: 500 });
  });
}

let spawned: Array<Record<string, unknown>>;
/** Final outputs served by `threads.output`; set before a reload since stubs do not survive one. */
const threadOutputs = new Map<string, string>();
/** Statuses served by `threads.get`, idle when unset; set before a reload like `threadOutputs`. */
const threadStatuses = new Map<string, ThreadResponse["status"]>();
let posted: Array<{ comments?: Array<{ path: string; body: string }>; body?: string }> = [];
let repliesPosted: Array<{ to: number; body: string }> = [];
/** Submissions of pending reviews (`POST .../reviews/{id}/events`). */
let events: Array<{ reviewId: number; event: string; body?: string }> = [];
interface StubPendingComment {
  id: number;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  start_line: number | null;
  start_side: "LEFT" | "RIGHT" | null;
  body: string;
  in_reply_to_id?: number;
}
interface StubPendingReview {
  id: number;
  node_id: string;
  login: string;
  body: string;
  comments: StubPendingComment[];
  /** Set once submitted (from the board or "on GitHub"); its comments then list as published review comments. */
  submitted: string | null;
}
/** The stub's pending reviews, created through the API or seeded by a test; tests change them to act as GitHub. */
let ghPending: { reviews: StubPendingReview[]; nextComment: number; created: Array<Record<string, unknown>> } = { reviews: [], nextComment: 9000, created: [] };
let host: Host | null = null;

async function load(settings: Record<string, string | number | boolean> = {}) {
  spawned = [];
  threadOutputs.clear();
  threadStatuses.clear();
  posted = [];
  repliesPosted = [];
  events = [];
  host = createFakePluginHost({
    pluginId: "kanban",
    agentSkillIds: ["kanban"],
    // The direct-post tests predate staging drafts on GitHub and keep exercising that path; staging tests turn it on.
    settings: { githubToken: "tok", stageOnGithub: false, ...settings },
    sdk: {
      projects: {
        list: async () => [
          {
            id: "proj_acme",
            name: "widgets",
            kind: "standard",
            gitRemoteUrl: "git@github.com:acme-co/widgets.git",
            sources: [
              {
                id: "src_1",
                projectId: "proj_acme",
                hostId: "host_1",
                isDefault: true,
                path: "/Users/me/widgets",
                type: "local_path",
                createdAt: 0,
                updatedAt: 0,
              },
            ],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      },
      threads: {
        spawn: async (args: Record<string, unknown>) => {
          spawned.push(args);
          return makeThreadResponse({ id: `thr_${spawned.length}`, projectId: String(args.projectId) });
        },
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, projectId: "proj_acme", environmentId: `env_${threadId}`, status: threadStatuses.get(threadId) ?? "idle" }),
        updatePluginMetadata: async () => ({}),
        markRead: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_acme" }),
        markUnread: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_acme" }),
        output: async ({ threadId }: { threadId: string }) => ({ output: threadOutputs.get(threadId) ?? null }),
        retry: async () => ({ ok: true, delivery: "sent", attempt: 2, turnRequestId: "req_retry" }),
        queue: { list: async () => [] },
      },
    },
  });
  await plugin(host.bb);
  return host;
}

function current(): Host {
  if (host === null) throw new Error("plugin not loaded");
  return host;
}

async function board(): Promise<Board> {
  return (await current().harness.behavior.callRpc("board_get", null)) as Board;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  await host?.harness.lifecycle.dispose();
  host = null;
});

describe("githubRepoFromRemote", () => {
  it("normalizes ssh, https, and .git forms", () => {
    expect(githubRepoFromRemote("git@github.com:Acme-Co/Widgets.git")).toBe("acme-co/widgets");
    expect(githubRepoFromRemote("https://github.com/acme-co/widgets")).toBe("acme-co/widgets");
    expect(githubRepoFromRemote("https://github.com/acme-co/widgets.git/")).toBe("acme-co/widgets");
    expect(githubRepoFromRemote("https://gitlab.com/a/b")).toBeNull();
    expect(githubRepoFromRemote(null)).toBeNull();
  });
});

describe("ad hoc tickets", () => {
  it("creates in backlog by default and moves with reordering", async () => {
    await load();
    const a = (await current().harness.behavior.callRpc("ticket_create", { title: "A" })) as Ticket;
    const b = (await current().harness.behavior.callRpc("ticket_create", { title: "B" })) as Ticket;
    expect(a.columnId).toBe("backlog");
    expect(a.threadId).toBeNull();

    await current().harness.behavior.callRpc("ticket_move", { id: a.id, columnId: "todo" });
    await current().harness.behavior.callRpc("ticket_move", { id: b.id, columnId: "todo", index: 0 });
    const todo = (await board()).tickets
      .filter((ticket) => ticket.columnId === "todo")
      .sort((x, y) => x.position - y.position)
      .map((ticket) => ticket.id);
    expect(todo).toEqual([b.id, a.id]);
    expect(current().harness.inspection.realtimeSignals.length).toBeGreaterThan(0);
  });

  it("records when a card enters a column, and keeps it through reorders there", async () => {
    await load();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const a = (await current().harness.behavior.callRpc("ticket_create", { title: "A" })) as Ticket;
    const b = (await current().harness.behavior.callRpc("ticket_create", { title: "B" })) as Ticket;
    expect(a.columnEnteredAt).toBe(1_000);

    now.mockReturnValue(2_000);
    await current().harness.behavior.callRpc("ticket_move", { id: a.id, columnId: "done" });
    now.mockReturnValue(3_000);
    await current().harness.behavior.callRpc("ticket_move", { id: b.id, columnId: "done", index: 0 });
    const entered = new Map((await board()).tickets.map((ticket) => [ticket.id, ticket.columnEnteredAt]));
    // a was pushed down a place by b's arrival, which is not a move for a.
    expect(entered.get(a.id)).toBe(2_000);
    expect(entered.get(b.id)).toBe(3_000);
  });

  it("keeps a column's hide-after setting", async () => {
    await load();
    const columns = [
      { id: "todo", name: "To Do" },
      { id: "done", name: "Done", hideAfterDays: 7 },
    ];
    await current().harness.behavior.callRpc("columns_set", { columns });
    expect((await board()).columns).toEqual(columns);
  });

  it("spawns a thread with the ticket id in plugin metadata when asked", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", {
      title: "Ship it",
      description: "Do the thing",
      projectId: "proj_acme",
      startThread: true,
    })) as Ticket;
    expect(ticket.threadId).toBe("thr_1");
    expect(spawned[0]).toMatchObject({
      projectId: "proj_acme",
      environment: { type: "project-default" },
      title: "Ship it",
      pluginMetadata: { ticketId: ticket.id },
    });
    expect(String(spawned[0]!.prompt)).toContain("Do the thing");
    expect(String(spawned[0]!.prompt)).toContain("bb kanban move");
  });

  it("creates subtasks with the card, in its column and project, before its thread starts", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", {
      title: "Ship it",
      columnId: "todo",
      projectId: "proj_acme",
      startThread: true,
      subtasks: [{ title: "Write the migration", tags: ["db"] }, { title: "Backfill", description: "In batches" }],
    })) as Ticket;
    expect(ticket.children.total).toBe(2);
    const children = (await board()).tickets.filter((entry) => entry.parentId === ticket.id).sort((a, b) => a.position - b.position);
    expect(children.map((child) => [child.title, child.description, child.tags, child.columnId, child.projectId, child.threadId])).toEqual([
      ["Write the migration", "", ["db"], "todo", "proj_acme", null],
      ["Backfill", "In batches", [], "todo", "proj_acme", null],
    ]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ pluginMetadata: { ticketId: ticket.id } });
    const configured = await current().harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { ticketId: ticket.id } }));
    expect(configured?.instructions).toContain("2 subtask(s)");
  });

  it("returns the subtask count without starting a thread", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "Plan", subtasks: [{ title: "One" }] })) as Ticket;
    expect(ticket.children).toMatchObject({ total: 1, done: 0 });
    expect(spawned).toHaveLength(0);
  });

  it("rejects moves to unknown columns", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "A" })) as Ticket;
    await expect(
      current().harness.behavior.callRpc("ticket_move", { id: ticket.id, columnId: "nope" }),
    ).rejects.toThrow(/No column/u);
  });
});

describe("CLI", () => {
  it("adds a card linked to the current thread and moves it by thread context", async () => {
    await load();
    const add = await current().harness.behavior.runCli(["add", "Fix flaky test", "--json"], {
      threadId: "thr_9",
      signal: new AbortController().signal,
    });
    expect(add.exitCode).toBe(0);
    const ticket = JSON.parse(add.stdout ?? "") as Ticket;
    expect(ticket.threadId).toBe("thr_9");
    expect(current().harness.inspection.sdk.callsTo("threads.updatePluginMetadata")).toHaveLength(1);

    const move = await current().harness.behavior.runCli(["move", "in-progress"], {
      threadId: "thr_9",
      signal: new AbortController().signal,
    });
    expect(move.exitCode).toBe(0);
    expect(move.stdout).toContain("[Building]");

    const show = await current().harness.behavior.runCli(["show", "--json"], {
      threadId: "thr_9",
      signal: new AbortController().signal,
    });
    expect((JSON.parse(show.stdout ?? "") as Ticket).columnId).toBe("in-progress");
  });

  it("shows a card given its id as an argument or with --ticket, but not both", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "Positional" })) as Ticket;
    const positional = await current().harness.behavior.runCli(["show", ticket.id, "--json"]);
    expect(positional.exitCode).toBe(0);
    expect((JSON.parse(positional.stdout ?? "") as Ticket).id).toBe(ticket.id);
    const option = await current().harness.behavior.runCli(["show", "--ticket", ticket.id, "--json"]);
    expect(option.exitCode).toBe(0);
    expect((JSON.parse(option.stdout ?? "") as Ticket).id).toBe(ticket.id);

    const both = await current().harness.behavior.runCli(["show", ticket.id, "--ticket", ticket.id]);
    expect(both.exitCode).not.toBe(0);
    expect(both.stderr).toContain("not both");
  });

  it("explains when a thread has no card", async () => {
    await load();
    const result = await current().harness.behavior.runCli(["move", "done"], {
      threadId: "thr_none",
      signal: new AbortController().signal,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no kanban card");
  });

  it("accepts a column by display name", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "A" })) as Ticket;
    const result = await current().harness.behavior.runCli(["move", "Done", "--ticket", ticket.id, "--json"]);
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout ?? "") as Ticket).columnId).toBe("done");
  });
});

describe("GitHub sync", () => {
  it("creates PR cards in To Do and spawns threads for matched projects", async () => {
    const fetchMock = stubGithub({
      authored: [
        searchItem("acme-co/widgets", 1, { title: "Add thing", user: { login: "sean" } }),
        searchItem("acme-co/widgets", 2, { title: "WIP", draft: true, user: { login: "sean" } }),
        searchItem("other/repo", 3, { title: "Elsewhere", user: { login: "sean" } }),
      ],
      requested: [searchItem("acme-co/widgets", 4, { title: "Please review", user: { login: "alice" } })],
    });
    vi.stubGlobal("fetch", fetchMock);
    await load();
    await current().harness.behavior.callRpc("sync_now", null);

    const { tickets, sync } = await board();
    const byNumber = new Map(tickets.map((ticket) => [ticket.pr?.number, ticket]));
    expect(sync.login).toBe("sean");
    expect(sync.lastError).toBeNull();
    expect(byNumber.get(1)).toMatchObject({ columnId: "todo", kind: "pr", projectId: "proj_acme" });
    expect(byNumber.get(2)).toMatchObject({ columnId: "todo", pr: { state: "draft" } });
    expect(byNumber.get(4)).toMatchObject({ columnId: "todo", tags: ["pr-reviews"], sourceId: "pr-reviews", pr: { role: "other", author: "alice" } });
    expect(byNumber.get(1)).toMatchObject({ tags: ["my-prs"], sourceId: "my-prs" });
    // No project matches other/repo and no fallback project is set: card without a thread.
    expect(byNumber.get(3)).toMatchObject({ projectId: null, threadId: null });

    expect(spawned).toHaveLength(3);
    const titles = spawned.map((args) => String(args.title));
    expect(titles).toContain("widgets#1: Add thing");
    const reviewPrompt = spawned.find((args) => String(args.title).startsWith("widgets#4"));
    expect(String(reviewPrompt?.prompt)).toContain("gh pr diff 4 --repo acme-co/widgets");
    const ownPrompt = spawned.find((args) => String(args.title).startsWith("widgets#1"));
    expect(String(ownPrompt?.prompt)).toContain("tracks your pull request");
    expect(String(reviewPrompt?.prompt)).toContain("Do not post comments");
  });

  it("is idempotent and moves merged, closed, and reviewed PRs to done", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("acme-co/widgets", 1), searchItem("acme-co/widgets", 2)],
        requested: [searchItem("acme-co/widgets", 4)],
      }),
    );
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    await current().harness.behavior.callRpc("sync_now", null);
    expect((await board()).tickets).toHaveLength(3);
    expect(spawned).toHaveLength(0);

    // Next sync: #1 merged, #2 closed, #4 review no longer requested but still open.
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [],
        requested: [],
        pulls: {
          "acme-co/widgets#1": { state: "closed", merged: true },
          "acme-co/widgets#2": { state: "closed", merged: false },
          "acme-co/widgets#4": { state: "open", merged: false },
        },
      }),
    );
    await current().harness.behavior.callRpc("sync_now", null);
    const byNumber = new Map((await board()).tickets.map((ticket) => [ticket.pr?.number, ticket]));
    expect(byNumber.get(1)).toMatchObject({ columnId: "done", pr: { state: "merged" } });
    expect(byNumber.get(2)).toMatchObject({ columnId: "done", pr: { state: "closed" } });
    expect(byNumber.get(4)).toMatchObject({ columnId: "done", pr: { state: "open" } });
  });

  it("reopens a PR in todo when it comes back to its source, but not one moved to Done while still in it", async () => {
    const requested = (...numbers: number[]) => numbers.map((number) => searchItem("acme-co/widgets", number));
    const open = { state: "open" as const, merged: false };
    const pulls = { "acme-co/widgets#4": open, "acme-co/widgets#5": open, "acme-co/widgets#6": open };
    vi.stubGlobal("fetch", stubGithub({ requested: requested(4, 5, 6) }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const idOf = new Map((await board()).tickets.map((ticket) => [ticket.pr?.number, ticket.id]));
    const columnOf = async (number: number) => (await board()).tickets.find((ticket) => ticket.pr?.number === number)?.columnId;

    // #4 is reviewed and sync finishes it; #5 is moved to Done by hand and stays requested; #6 is moved by hand, then reviewed.
    await current().harness.behavior.callRpc("ticket_move", { id: idOf.get(5), columnId: "done" });
    await current().harness.behavior.callRpc("ticket_move", { id: idOf.get(6), columnId: "done" });
    vi.stubGlobal("fetch", stubGithub({ requested: requested(5), pulls }));
    await current().harness.behavior.callRpc("sync_now", null);
    expect(await columnOf(4)).toBe("done");

    vi.stubGlobal("fetch", stubGithub({ requested: requested(4, 5, 6), pulls }));
    await current().harness.behavior.callRpc("sync_now", null);
    expect(await columnOf(4)).toBe("todo");
    expect(await columnOf(5)).toBe("done");
    expect(await columnOf(6)).toBe("todo");

    // Back in the source clears the mark: moving it to Done by hand now sticks.
    await current().harness.behavior.callRpc("ticket_move", { id: idOf.get(4), columnId: "done" });
    await current().harness.behavior.callRpc("sync_now", null);
    expect(await columnOf(4)).toBe("done");
  });

  it("does not reopen a PR that only left a source that was disabled", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 4)] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const [card] = (await board()).tickets;
    await current().harness.behavior.callRpc("ticket_move", { id: card!.id, columnId: "done" });
    const sources = (await board()).sources;
    const withReviews = (enabled: boolean) => sources.map((source) => (source.id === "pr-reviews" ? { ...source, enabled } : source));

    await current().harness.behavior.callRpc("sources_set", { sources: withReviews(false) });
    await current().harness.behavior.callRpc("sync_now", null);
    await current().harness.behavior.callRpc("sources_set", { sources: withReviews(true) });
    await current().harness.behavior.callRpc("sync_now", null);
    expect((await board()).tickets[0]!.columnId).toBe("done");
  });

  it("reads open PRs' branches and checks every sync, keeping the last values when the read fails or the PR is finished", async () => {
    const fetchMock = stubGithub({
      authored: [searchItem("acme-co/widgets", 1), searchItem("acme-co/widgets", 2), searchItem("acme-co/widgets", 3)],
      heads: {
        "acme-co/widgets#1": { headRef: "feature/login", rollup: "SUCCESS" },
        "acme-co/widgets#2": { headRef: "fix-bug", rollup: null },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const prsOf = async () => new Map((await board()).tickets.map((ticket) => [ticket.pr?.number, ticket.pr]));
    let prs = await prsOf();
    expect(prs.get(1)).toMatchObject({ headRef: "feature/login", checks: "passing" });
    expect(prs.get(2)).toMatchObject({ headRef: "fix-bug", checks: null });
    // The repository did not answer for #3: nothing known yet.
    expect(prs.get(3)).toMatchObject({ headRef: null, checks: null });
    const headQueries = fetchMock.mock.calls.filter(([, init]) => String(init?.body ?? "").includes("statusCheckRollup"));
    expect(headQueries).toHaveLength(2);

    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("acme-co/widgets", 1), searchItem("acme-co/widgets", 2), searchItem("acme-co/widgets", 3)],
        heads: {
          "acme-co/widgets#1": { headRef: "feature/login", rollup: "FAILURE" },
          "acme-co/widgets#3": { headRef: "chore", rollup: "EXPECTED" },
        },
      }),
    );
    await current().harness.behavior.callRpc("sync_now", null);
    prs = await prsOf();
    expect(prs.get(1)).toMatchObject({ checks: "failing" });
    expect(prs.get(2)).toMatchObject({ headRef: "fix-bug", checks: null });
    expect(prs.get(3)).toMatchObject({ headRef: "chore", checks: "pending" });

    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 1), searchItem("acme-co/widgets", 2), searchItem("acme-co/widgets", 3)], failHeads: true }));
    const status = (await current().harness.behavior.callRpc("sync_now", null)) as Board["sync"];
    expect(status.lastError).toBeNull();
    prs = await prsOf();
    expect(prs.get(1)).toMatchObject({ headRef: "feature/login", checks: "failing" });

    // #1 merged: it is not asked about again, so it keeps the checks it last had.
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("acme-co/widgets", 2), searchItem("acme-co/widgets", 3)],
        pulls: { "acme-co/widgets#1": { state: "closed", merged: true } },
        heads: { "acme-co/widgets#1": { headRef: "feature/login", rollup: "SUCCESS" } },
      }),
    );
    await current().harness.behavior.callRpc("sync_now", null);
    prs = await prsOf();
    expect(prs.get(1)).toMatchObject({ state: "merged", headRef: "feature/login", checks: "failing" });

    host = await current().harness.lifecycle.reload(plugin);
    expect((await prsOf()).get(3)).toMatchObject({ headRef: "chore", checks: "pending" });
  });

  it("does not override a manual column for a PR that is still open", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 1)] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const [ticket] = (await board()).tickets;
    await current().harness.behavior.callRpc("ticket_move", { id: ticket!.id, columnId: "backlog" });
    await current().harness.behavior.callRpc("sync_now", null);
    expect((await board()).tickets[0]!.columnId).toBe("backlog");
  });

  it("keeps a PR card's edited title over the PR's, while unedited cards follow it", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 1), searchItem("acme-co/widgets", 2), searchItem("acme-co/widgets", 3)] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const idOf = async (number: number) => (await board()).tickets.find((ticket) => ticket.pr?.number === number)!.id;
    await current().harness.behavior.callRpc("ticket_update", { id: await idOf(1), title: "My name for it" });
    await current().harness.behavior.callRpc("ticket_update", { id: await idOf(2), title: "PR 2", description: "Only notes changed" });
    await current().harness.behavior.callRpc("ticket_update", { id: await idOf(3), title: "Gone from search" });

    // #3 left the search, so its title arrives from the single-PR refresh instead.
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("acme-co/widgets", 1, { title: "Renamed upstream" }), searchItem("acme-co/widgets", 2, { title: "Also renamed" })],
        pulls: { "acme-co/widgets#3": { state: "open", merged: false, title: "Renamed too" } },
      }),
    );
    await current().harness.behavior.callRpc("sync_now", null);
    const titles = new Map((await board()).tickets.map((ticket) => [ticket.pr?.number, ticket.title]));
    expect(titles.get(1)).toBe("My name for it");
    expect(titles.get(2)).toBe("Also renamed");
    expect(titles.get(3)).toBe("Gone from search");
  });

  it("attaches a PR pushed from an ad hoc card's thread to that card", async () => {
    await load();
    const add = await current().harness.behavior.runCli(["add", "Widget UI cleanups", "--json"], { threadId: "thr_f2xxnrzt6a", signal: new AbortController().signal });
    const card = JSON.parse(add.stdout ?? "") as Ticket;
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("acme-co/widgets", 5, { title: "Clean up the Widget UI" })],
        heads: { "acme-co/widgets#5": { headRef: "bb/widget-ui-cleanups-thr_f2xxnrzt6a", rollup: "SUCCESS" } },
      }),
    );
    await current().harness.behavior.callRpc("sync_now", null);

    const { tickets } = await board();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ id: card.id, kind: "pr", title: "Widget UI cleanups", threadId: "thr_f2xxnrzt6a", pr: { repo: "acme-co/widgets", number: 5 } });
    expect(spawned).toHaveLength(0);
  });

  it("reports a missing token without throwing when the gh binary is not found", async () => {
    vi.stubGlobal("fetch", stubGithub({}));
    await load({ githubToken: "", ghPath: "/nonexistent/gh" });
    const status = (await current().harness.behavior.callRpc("sync_now", null)) as Board["sync"];
    expect(status.lastError).toContain("No GitHub token");
    expect(status.tokenSource).toBe("none");
  });

  it("takes the token from the configured gh binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanban-gh-"));
    try {
      const gh = join(dir, "gh");
      await writeFile(gh, '#!/bin/sh\n[ "$1 $2" = "auth token" ] && echo gh-tok\n', { mode: 0o755 });
      const fetch = stubGithub({});
      vi.stubGlobal("fetch", fetch);
      await load({ githubToken: "", ghPath: gh });
      const status = (await current().harness.behavior.callRpc("sync_now", null)) as Board["sync"];
      expect(status).toMatchObject({ tokenSource: "gh-cli", login: "sean", lastError: null });
      const auth = fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"));
      expect(auth).toContain("Bearer gh-tok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("thread lifecycle", () => {
  it("moves idle cards to in-progress on activity, done on archive, and unlinks on delete", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", {
      title: "A",
      projectId: "proj_acme",
      startThread: true,
    })) as Ticket;
    const thread = makeThreadResponse({ id: ticket.threadId!, projectId: "proj_acme" });

    await current().harness.behavior.emitThreadEvent("thread.active", { thread });
    expect((await board()).tickets[0]!.columnId).toBe("in-progress");

    await current().harness.behavior.emitThreadEvent("thread.archived", { thread });
    expect((await board()).tickets[0]!.columnId).toBe("done");

    await current().harness.behavior.emitThreadEvent("thread.deleted", { thread });
    expect((await board()).tickets[0]!.threadId).toBeNull();
  });

  it("injects ticket instructions for threads tagged with a ticket id", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "Investigate" })) as Ticket;
    const configured = await current().harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { ticketId: ticket.id } }),
    );
    expect(configured?.skills).toEqual(["kanban"]);
    expect(configured?.instructions).toContain(JSON.stringify(ticket.id));
    expect(configured?.instructions).toContain("bb kanban move in-progress");

    const plain = await current().harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    expect(plain?.instructions ?? undefined).toBeUndefined();
  });
});

describe("PR review", () => {
  it("spawns a review thread in a fresh worktree under the card's thread", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 7, { title: "Refactor" })] }));
    await load();
    await current().harness.behavior.callRpc("sync_now", null);
    const [card] = (await board()).tickets;
    expect(card!.threadId).toBe("thr_1");

    const reviewed = (await current().harness.behavior.callRpc("ticket_review_pr", { id: card!.id })) as Ticket;
    expect(reviewed.reviewThreadId).toBe("thr_2");
    expect(spawned[1]).toMatchObject({
      projectId: "proj_acme",
      environment: {
        type: "host",
        hostId: "host_1",
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
      lifecycleOwnerThreadId: "thr_1",
      title: "Review widgets#7: Refactor",
      visibility: "hidden",
      pluginMetadata: { ticketId: card!.id, role: "review" },
    });
    const prompt = String(spawned[1]!.prompt);
    expect(prompt).toContain("git fetch origin \"$BASE\" \"pull/7/head\"");
    expect(prompt).toContain("git checkout --detach FETCH_HEAD");
    expect(prompt).toContain("bb kanban review-record --commit");
    expect(prompt).toContain("`code-review` skill");
    expect(prompt).toContain("origin/$BASE...HEAD");
    expect(prompt).toContain("do not post comments");
    expect(reviewed.latestReview).toMatchObject({ threadId: "thr_2", status: "running", commitSha: null, apply: null });

    const configured = await current().harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { ticketId: card!.id, role: "review" } }),
    );
    expect(configured?.instructions).toContain("code review");
    expect(configured?.instructions).not.toContain("bb kanban move");

    await current().harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
    });
    // The persisted review (and its thread reference) survives deletion of the thread.
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ threadId: "thr_2" });
  });

  it("asks for a project when none matches a PR card's repository", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("other/repo", 1)] }));
    await load({ autoStartThreads: false, autoCreateProjects: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const pr = (await board()).tickets.find((ticket) => ticket.pr !== null)!;
    await expect(current().harness.behavior.callRpc("ticket_review_pr", { id: pr.id })).rejects.toThrow(/No project matches/u);
    const reviewed = (await current().harness.behavior.callRpc("ticket_review_pr", { id: pr.id, projectId: "proj_acme" })) as Ticket;
    expect(reviewed.reviewThreadId).toBe("thr_1");
  });

  it("creates a project for a repository no project matches and adopts its cards", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("other/repo", 1)] }));
    const clones = await mkdtemp(join(tmpdir(), "kanban-clones-"));
    // A `.git` directory at the clone path means the plugin skips `git clone` and goes straight to creating the project.
    await mkdir(join(clones, "other", "repo", ".git"), { recursive: true });
    await load({ autoStartThreads: false, cloneDir: clones });
    const created: Array<{ name: string; source: { path: string; hostId: string } }> = [];
    current().harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1", dataDir: clones }));
    current().harness.sdk.stub("projects.create", async (args: { name: string; source: { path: string; hostId: string } }) => {
      created.push(args);
      return { id: "proj_repo", name: args.name, gitRemoteUrl: "git@github.com:other/repo.git", sources: [{ id: "src_1", hostId: "host_1", path: args.source.path, isDefault: true }] };
    });
    await current().harness.behavior.callRpc("sync_now", null);
    await vi.waitFor(async () => {
      const card = (await board()).tickets.find((ticket) => ticket.pr !== null)!;
      expect(card.projectId).toBe("proj_repo");
    });
    expect(created).toEqual([{ name: "repo", source: { hostId: "host_1", path: join(clones, "other", "repo"), type: "local_path" } }]);
    await rm(clones, { recursive: true, force: true });
  });

  it("starts a review from the CLI using the thread's card", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 7)] }));
    await load();
    await current().harness.behavior.callRpc("sync_now", null);
    const result = await current().harness.behavior.runCli(["review"], { threadId: "thr_1", signal: new AbortController().signal });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("@thread:thr_2");
  });
});

describe("code review thread visibility", () => {
  it("spawns tours and explanations hidden, lists every code review thread, and re-syncs them all with the setting", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 7)] }));
    await load({ autoStartThreads: false });
    const updates: Array<{ threadId: string; visibility?: string }> = [];
    current().harness.sdk.stub("threads.update", async (args: { threadId: string; visibility?: string }) => {
      updates.push(args);
      return {};
    });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    await current().harness.behavior.callRpc("narrative_generate", { ticketId: card.id });
    await current().harness.behavior.callRpc("hunk_explain", { ticketId: card.id, path: "a.go", startLine: 2, endLine: 3 });
    expect(spawned.map((args) => [(args.pluginMetadata as { role: string }).role, args.visibility])).toEqual([
      ["review", "hidden"],
      ["narrative", "hidden"],
      ["explain", "hidden"],
    ]);

    const { threads } = (await current().harness.behavior.callRpc("code_review_threads", { ticketId: card.id })) as { threads: CodeReviewThread[] };
    expect(threads.map((thread) => [thread.kind, thread.threadId, thread.status]).sort()).toEqual([
      ["explain", "thr_3", "running"],
      ["narrative", "thr_2", "running"],
      ["review", "thr_1", "running"],
    ]);
    expect(threads.find((thread) => thread.kind === "explain")!.label).toBe("Explain a.go:2");

    await current().harness.behavior.setSettings({ hideReviewThreads: false });
    await vi.waitFor(() => expect(updates.filter((update) => update.visibility === "visible").map((update) => update.threadId).sort()).toEqual(["thr_1", "thr_2", "thr_3"]));
  });

  it("shows review threads again when the setting is turned off, and hides them when it is turned back on", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 7)] }));
    await load({ autoStartThreads: false });
    const updates: Array<{ threadId: string; visibility?: string }> = [];
    current().harness.sdk.stub("threads.update", async (args: { threadId: string; visibility?: string }) => {
      updates.push(args);
      return {};
    });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    expect(spawned[0]).toMatchObject({ visibility: "hidden" });

    await current().harness.behavior.setSettings({ hideReviewThreads: false });
    await vi.waitFor(() => expect(updates).toContainEqual({ threadId: "thr_1", visibility: "visible" }));
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id, mode: "full" }).catch(() => undefined);
    expect(spawned.at(-1)).toMatchObject({ visibility: "visible" });
    await current().harness.behavior.setSettings({ hideReviewThreads: true });
    await vi.waitFor(() => expect(updates.filter((update) => update.visibility === "hidden").length).toBeGreaterThan(0));
  });
});

describe("parseReviewReport", () => {
  it("extracts the review-findings block and ignores malformed ones", () => {
    const good = [
      "## Change Summary\nstuff\n\n## Review Findings\n\n### Minor (Nice to Fix)\n- **F1** `a.go:3` — Rename. Because — do it (flagged by: style)\n",
      "```json review-findings",
      JSON.stringify({ version: 1, summary: "stuff", commit: "abc", findings: [{ id: "F1", severity: "minor", title: "Rename", locations: [{ file: "a.go", startLine: 3 }], flaggedBy: ["style"] }] }),
      "```",
    ].join("\n");
    const report = parseReviewReport(good);
    expect(report?.commit).toBe("abc");
    expect(report?.findings[0]).toMatchObject({ id: "F1", severity: "minor", locations: [{ file: "a.go", startLine: 3, endLine: null }], fix: null });
    expect(parseReviewReport("no block here")).toBeNull();
    expect(parseReviewReport("```json review-findings\n{ not json\n```")).toBeNull();
    expect(parseReviewReport("```json review-findings\n{\"version\":1}\n```")).toBeNull();
  });

  it("reads a verified report's confidence, pre-existing tags and filtered findings", () => {
    const body = [
      "## Review Findings",
      "```json review-findings",
      JSON.stringify({
        version: 2,
        summary: "s",
        findings: [
          { id: "F1", severity: "minor", title: "Nit", locations: [{ file: "a.ts", startLine: 1, endLine: 2 }], confidence: 95, preExisting: false, verification: "Read the line" },
          { id: "F2", severity: "critical", title: "Old bug", locations: [{ file: "b.ts", startLine: 9 }], confidence: 85, preExisting: true },
        ],
        filtered: [{ id: "X1", severity: "important", title: "Misread", confidence: 20, verification: "The guard on line 4 handles it" }],
      }),
      "```",
    ].join("\n");
    const report = parseReviewReport(body)!;
    expect(report.findings.map(({ id, confidence, preExisting }) => ({ id, confidence, preExisting }))).toEqual([
      { id: "F1", confidence: 95, preExisting: false },
      { id: "F2", confidence: 85, preExisting: true },
    ]);
    expect(report.findings[0]!.verification).toBe("Read the line");
    expect(report.filtered).toMatchObject([{ id: "X1", confidence: 20, verification: "The guard on line 4 handles it", preExisting: false, locations: [] }]);
  });

  it("takes confidence from 0 to 100 and an unverified finding's null pre-existing tag, and rejects a report scored past 100", () => {
    const block = (findings: unknown[]) => ["```json review-findings", JSON.stringify({ version: 2, findings }), "```"].join("\n");
    const report = parseReviewReport(
      block([
        { id: "F1", severity: "minor", title: "a", confidence: 0 },
        { id: "F2", severity: "minor", title: "b", confidence: 100 },
        { id: "F3", severity: "minor", title: "c", confidence: null, preExisting: null },
      ]),
    )!;
    expect(report.findings.map(({ confidence, preExisting }) => ({ confidence, preExisting }))).toEqual([
      { confidence: 0, preExisting: false },
      { confidence: 100, preExisting: false },
      { confidence: null, preExisting: false },
    ]);
    expect(parseReviewReport(block([{ id: "F1", severity: "minor", title: "a", confidence: 150 }]))).toBeNull();
  });

  it("parses a report the code-review skill compiled with its verify pass", async () => {
    const report = parseReviewReport(await readFile(join(import.meta.dirname, "server/reviews/fixtures/verified-review.md"), "utf8"))!;
    expect(report).toMatchObject({ version: 2, findings: [], notCovered: [] });
    expect(report.filtered).toHaveLength(1);
    expect(report.filtered[0]!.class).toBeNull();
    expect(report.filtered[0]).toMatchObject({ id: "X1", confidence: 50, preExisting: true, importance: null });
    expect(report.filtered[0]!.verification).toContain("matter of taste");
  });

  it("reads a stored report from before verification as unverified, introduced and unfiltered", () => {
    const report = parseReviewReport(["```json review-findings", JSON.stringify({ version: 1, findings: [{ id: "F1", severity: "important", title: "Bug" }] }), "```"].join("\n"))!;
    expect(report.findings[0]).toMatchObject({ confidence: null, preExisting: false, verification: null, class: null });
    expect(report.filtered).toEqual([]);
    expect(report.notCovered).toEqual([]);
  });

  it("reads each finding's bug class with every instance, and the report's not-covered list", () => {
    const instances = [
      { file: "a.ts", startLine: 3, endLine: 3 },
      { file: "b.ts", startLine: 9, endLine: 12 },
    ];
    const body = [
      "```json review-findings",
      JSON.stringify({
        version: 3,
        findings: [{ id: "F1", severity: "important", title: "Unquoted path in shell command", class: "unquoted shell argument", locations: instances, confidence: 90 }],
        filtered: [{ id: "X1", severity: "minor", title: "Maybe", class: "naming", confidence: 25 }],
        notCovered: ["Untested: the retry path in `sync.ts` when the fetch times out", "UI only: the board's drag preview"],
      }),
      "```",
    ].join("\n");
    const report = parseReviewReport(body)!;
    expect(report.findings[0]).toMatchObject({ class: "unquoted shell argument", locations: instances });
    expect(report.filtered[0]!.class).toBe("naming");
    expect(report.notCovered).toEqual(["Untested: the retry path in `sync.ts` when the fetch times out", "UI only: the board's drag preview"]);
  });
});

describe("defaultSelected", () => {
  const finding = (overrides: Partial<Finding>): Finding => ({
    id: "F1",
    severity: "minor",
    title: "t",
    description: "",
    fix: null,
    locations: [],
    flaggedBy: [],
    category: null,
    importance: null,
    scopeFit: null,
    carriedFrom: null,
    confidence: null,
    preExisting: false,
    verification: null,
    class: null,
    triage: null,
    ...overrides,
  });
  it("pre-selects critical findings and well-scored ones, and falls back to severity when unscored", () => {
    expect(defaultSelected(finding({ severity: "critical", importance: 1, scopeFit: 1 }))).toBe(true);
    expect(defaultSelected(finding({ severity: "minor", importance: 3, scopeFit: 3 }))).toBe(true);
    expect(defaultSelected(finding({ severity: "important", importance: 4, scopeFit: 2 }))).toBe(false);
    expect(defaultSelected(finding({ severity: "important", importance: 2, scopeFit: 5 }))).toBe(false);
    expect(defaultSelected(finding({ severity: "important" }))).toBe(true);
    expect(defaultSelected(finding({ severity: "minor" }))).toBe(false);
  });

  it("never pre-selects a pre-existing finding, even a critical one", () => {
    expect(defaultSelected(finding({ severity: "critical", importance: 5, scopeFit: 5, preExisting: true }))).toBe(false);
    expect(defaultSelected(finding({ severity: "important", preExisting: true }))).toBe(false);
  });
});

describe("persisted reviews", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const newSha = "fedcba9876543210fedcba9876543210fedcba98";
  const ctx = (threadId: string) => ({ threadId, signal: new AbortController().signal });

  async function reviewedCard(): Promise<Ticket> {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 7, { title: "Refactor" })] }));
    await load();
    await current().harness.behavior.callRpc("sync_now", null);
    const [card] = (await board()).tickets;
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card!.id });
    return (await board()).tickets[0]!;
  }

  it("records the commit from the review thread and persists the findings when it goes idle", async () => {
    const card = await reviewedCard();
    const record = await current().harness.behavior.runCli(
      ["review-record", "--commit", sha, "--base", "main", "--head", "feature/refactor"],
      ctx("thr_2"),
    );
    expect(record.exitCode).toBe(0);

    const findings = "## Review Findings\n\n### Important\n- x.go:1 Bug\n\nReviewed commit: " + sha;
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: findings,
    });
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      status: "completed",
      commitSha: sha,
      baseRef: "main",
      headRef: "feature/refactor",
      body: findings,
      sinceCommitSha: null,
    });
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "completed", hasBody: true });

    const show = await current().harness.behavior.runCli(["review-show", "--ticket", card.id]);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain(sha);
    expect(show.stdout).toContain("x.go:1 Bug");
    const positional = await current().harness.behavior.runCli(["review-show", card.id]);
    expect(positional.exitCode).toBe(0);
    expect(positional.stdout).toContain("x.go:1 Bug");
    const both = await current().harness.behavior.runCli(["review-show", card.id, "--ticket", card.id]);
    expect(both.exitCode).not.toBe(0);
    expect(both.stderr).toContain("not both");

    // A second idle (for example after a follow-up question) does not overwrite the completed review.
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: "Sure, here is more detail.",
    });
    const again = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(again.reviews[0]!.body).toBe(findings);
  });

  it("waits for background reviewers, and lets the final report replace a review recorded from an interim message", async () => {
    const card = await reviewedCard();
    await current().harness.behavior.runCli(["review-record", "--commit", sha], ctx("thr_2"));
    const interim = "Correctness reviewer reported two issues. I'm still waiting on the testing reviewer.";
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme", activeBackgroundAgentCount: 1 }),
      lastAssistantText: interim,
    });
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "running" });

    // Providers that do not report background agents still idle on the interim message.
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: interim,
    });
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "completed", counts: null });

    const final = ["## Review Findings", "```json review-findings", JSON.stringify({ version: 1, summary: "x", commit: sha, findings: [{ id: "F1", severity: "important", title: "Drop", locations: [] }] }), "```"].join("\n");
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: final,
    });
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "completed", counts: { critical: 0, important: 1, minor: 0 } });

    // Once the review has a report, chatter in the thread does not replace it.
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: ["```json review-findings", JSON.stringify({ version: 1, summary: "y", findings: [] }), "```"].join("\n"),
    });
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews[0]!.body).toBe(final);
  });

  const turnFailed = (overrides: Partial<PluginTurnFailedEvent> = {}): PluginTurnFailedEvent => ({
    threadId: "thr_2",
    requestId: "req_1",
    turnId: "turn_1",
    errorInfo: null,
    inputAccepted: true,
    rateLimits: null,
    attemptNumber: 1,
    ...overrides,
  });
  async function failReviewThread(failure: PluginTurnFailedEvent | null): Promise<void> {
    threadStatuses.set("thr_2", "error");
    await current().harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme", status: "error" }), error: null });
    if (failure !== null) await current().harness.behavior.emitThreadEvent("turn.failed", failure);
  }
  const retries = () => current().harness.inspection.sdk.callsTo("threads.retry");

  it("resumes a review whose thread failed mid-turn, as when the machine slept, and records the resumed run's report", async () => {
    await reviewedCard();
    await failReviewThread(turnFailed());
    await vi.waitFor(() => expect(retries()).toEqual([[expect.objectContaining({ threadId: "thr_2", turnRequestId: "req_1" })]]));
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "running" });
    expect(spawned).toHaveLength(2);

    await current().harness.behavior.runCli(["review-record", "--commit", sha], ctx("thr_2"));
    const findings = ["```json review-findings", JSON.stringify({ version: 1, summary: "x", commit: sha, findings: [{ id: "F1", severity: "important", title: "Drop", locations: [] }] }), "```"].join("\n");
    await current().harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }), lastAssistantText: findings });
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "completed", counts: { critical: 0, important: 1, minor: 0 } });
  });

  it("fails the review when the failure isn't transient", async () => {
    await reviewedCard();
    await failReviewThread(turnFailed({ errorInfo: { category: "unauthorized", httpStatusCode: 401, providerCode: null } }));
    await vi.waitFor(async () => expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "failed" }));
    expect(retries()).toEqual([]);
  });

  it("fails the review once two resumes have failed", async () => {
    await reviewedCard();
    await failReviewThread(turnFailed({ attemptNumber: 3 }));
    await vi.waitFor(async () => expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "failed" }));
    expect(retries()).toEqual([]);
  });

  describe("waiting on a failure's outcome", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("leaves a rate limit to the provider-retry plugin, keeping the review running while its retry is queued", async () => {
      await reviewedCard();
      current().harness.sdk.stub("threads.queue.list", async () => [{ threadId: "thr_2", payload: { kind: "retry", attempt: 2, reason: "Rate limited", retryOfTurnRequestId: "req_1" } }]);
      await failReviewThread(turnFailed({ errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null } }));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(retries()).toEqual([]);
      expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "running" });

      current().harness.sdk.stub("threads.queue.list", async () => []);
      await current().harness.behavior.emitThreadEvent("message.cancelled", {
        entry: { threadId: "thr_2", payload: { kind: "retry", attempt: 2, reason: "Rate limited", retryOfTurnRequestId: "req_1" } } as PluginThreadEventPayloads["message.cancelled"]["entry"],
      });
      await vi.waitFor(async () => expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "failed" }));
    });

    it("fails a review whose thread failed outside a turn once the wait is up", async () => {
      await reviewedCard();
      await failReviewThread(null);
      await vi.advanceTimersByTimeAsync(14_000);
      expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "running" });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(async () => expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "failed" }));
      expect(retries()).toEqual([]);
    });
  });

  it("resumes on load a review whose thread failed while the plugin was unloaded, and records one that finished then", async () => {
    const card = await reviewedCard();
    threadStatuses.set("thr_2", "error");
    host = await current().harness.lifecycle.reload(plugin);
    threadStatuses.set("thr_2", "error");
    await vi.waitFor(() => expect(retries()).toEqual([[expect.objectContaining({ threadId: "thr_2" })]]));
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "running" });

    await current().harness.behavior.runCli(["review-record", "--commit", sha], ctx("thr_2"));
    const final = ["```json review-findings", JSON.stringify({ version: 1, summary: "x", commit: sha, findings: [] }), "```"].join("\n");
    threadOutputs.set("thr_2", final);
    threadStatuses.set("thr_2", "idle");
    host = await current().harness.lifecycle.reload(plugin);
    await vi.waitFor(async () => {
      const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
      expect(reviews[0]).toMatchObject({ status: "completed", body: final });
    });
  });

  it("repairs a review recorded from an interim message from its thread's final output on load", async () => {
    const card = await reviewedCard();
    await current().harness.behavior.runCli(["review-record", "--commit", sha], ctx("thr_2"));
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: "Still waiting on the testing reviewer.",
    });
    const final = ["```json review-findings", JSON.stringify({ version: 1, summary: "x", commit: sha, findings: [{ id: "F1", severity: "critical", title: "Drop", locations: [] }] }), "```"].join("\n");
    threadOutputs.set("thr_2", final);
    await current().bb.storage.kv.delete("interimReviewsRepaired");
    host = await current().harness.lifecycle.reload(plugin);
    await vi.waitFor(async () => {
      const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
      expect(reviews[0]!.body).toBe(final);
    });
  });

  it("reads the commit and severity counts from the structured report", async () => {
    const card = await reviewedCard();
    const body = [
      "## Change Summary\nx\n\n## Review Findings\n\n### Critical (Must Fix)\n- **F1** `a.go:1` — Boom. — fix (flagged by: correctness)\n",
      "```json review-findings",
      JSON.stringify({
        version: 1,
        summary: "x",
        commit: sha,
        range: "origin/main...HEAD",
        reviewers: ["correctness"],
        findings: [
          { id: "F1", severity: "critical", title: "Boom", description: "d", fix: "f", locations: [{ file: "a.go", startLine: 1 }], flaggedBy: ["correctness"], category: "correctness" },
          { id: "F2", severity: "minor", title: "Nit", locations: [], flaggedBy: ["style"] },
          { id: "F3", severity: "minor", title: "Nit 2", locations: [], flaggedBy: ["style"] },
        ],
      }),
      "```",
    ].join("\n");
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: body,
    });
    const latest = (await board()).tickets[0]!.latestReview!;
    expect(latest.commitSha).toBe(sha);
    expect(latest.counts).toEqual({ critical: 1, important: 0, minor: 2 });
    expect(latest.scores).toBeNull();
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews[0]!.report?.findings).toHaveLength(3);
    const show = await current().harness.behavior.runCli(["review-show", "--ticket", card.id]);
    expect(show.stdout).toContain("critical 1 · important 0 · minor 2");
  });

  it("marks a review failed when the thread ends without a commit or a report", async () => {
    const card = await reviewedCard();
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: "I couldn't complete the setup.\n\nReviewed commit: none",
    });
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "failed", commitSha: null, hasBody: true });
    await expect(current().harness.behavior.callRpc("review_apply", { ticketId: card.id })).rejects.toThrow(/No completed review/u);
    // A fresh review after a failure is a full review, not an incremental one.
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    expect(String(spawned[2]!.prompt)).toContain("origin/$BASE...HEAD");
  });

  it("falls back to the 'Reviewed commit' line when review-record was skipped", async () => {
    const card = await reviewedCard();
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: `## Review Findings\n\nnone\n\nReviewed commit: ${sha}`,
    });
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews[0]!.commitSha).toBe(sha);
  });

  it("re-reviews only the commits since the last reviewed sha, or everything when asked", async () => {
    const card = await reviewedCard();
    await current().harness.behavior.runCli(["review-record", "--commit", sha], ctx("thr_2"));
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: "findings",
    });

    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    expect(String(spawned[2]!.title)).toContain("Re-review widgets#7");
    expect(String(spawned[2]!.prompt)).toContain(`${sha}..HEAD`);
    expect(String(spawned[2]!.prompt)).toContain(`previous review covered commit ${sha}`);
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews[0]).toMatchObject({ status: "running", sinceCommitSha: sha });

    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id, mode: "full" });
    expect(String(spawned[3]!.prompt)).toContain("origin/$BASE...HEAD");
    expect(String(spawned[3]!.prompt)).not.toContain(`${sha}..HEAD`);
  });

  it("hands a re-review the open findings to re-check and keeps the user's choices on the ones it carries forward", async () => {
    const card = await reviewedCard();
    const reportBody = (commit: string, extra: Record<string, unknown>, findings: Array<Record<string, unknown>>) =>
      ["## Review Findings", `Reviewed commit: ${commit}`, "```json review-findings", JSON.stringify({ version: 1, summary: "x", commit, findings, ...extra }), "```"].join("\n");
    await current().harness.behavior.runCli(["review-record", "--commit", sha], ctx("thr_2"));
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: reportBody(sha, {}, [
        { id: "F1", severity: "important", title: "Leaky handle", locations: [{ file: "a.go", startLine: 3 }] },
        { id: "F2", severity: "important", title: "Wrong default", locations: [] },
      ]),
    });
    const [first] = ((await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] }).reviews;
    await current().harness.behavior.callRpc("review_set_selection", { reviewId: first!.id, findingId: "F2", selected: false });

    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    const prompt = String(spawned[2]!.prompt);
    expect(prompt).toContain("## Earlier findings");
    expect(prompt).toContain(`"handle": "${first!.id}/F1"`);
    expect(prompt).toContain(`"handle": "${first!.id}/F2"`);
    expect(prompt).toContain('"carriesForward": true');
    expect(prompt).toContain('"carriedFrom"');
    expect(prompt).toContain(`If \`git log ${sha}..HEAD\` is empty nothing changed`);
    expect(prompt).toContain("every earlier finding is open as listed");

    await current().harness.behavior.runCli(["review-record", "--commit", newSha], ctx("thr_3"));
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_3", projectId: "proj_acme" }),
      lastAssistantText: reportBody(newSha, { carriesForward: true, resolved: [{ id: `${first!.id}/F1`, title: "Leaky handle", note: "closed in defer" }] }, [
        { id: "F1", severity: "important", title: "Wrong default", locations: [], carriedFrom: `${first!.id}/F2` },
        { id: "F2", severity: "important", title: "New bug", locations: [] },
      ]),
    });
    const [second] = ((await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] }).reviews;
    expect(second!.report).toMatchObject({ carriesForward: true, resolved: [{ title: "Leaky handle" }] });
    expect(second!.selection).toEqual({ F1: false, F2: true });
    expect(second!.selectionOverrides).toEqual({ F1: false });

    // The cumulative re-review stands alone, so the next one re-checks only its findings.
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    const next = String(spawned[3]!.prompt);
    expect(next).toContain(`"handle": "${second!.id}/F1"`);
    expect(next).not.toContain(`${first!.id}/`);
  });

  it("applies a completed review in the review thread's worktree and records the push", async () => {
    const card = await reviewedCard();
    await expect(current().harness.behavior.callRpc("review_apply", { ticketId: card.id })).rejects.toThrow(/No completed review/u);

    await current().harness.behavior.runCli(["review-record", "--commit", sha, "--head", "feature/refactor"], ctx("thr_2"));
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: "## Review Findings\n- a.go:1 fix me",
    });

    const applied = (await current().harness.behavior.callRpc("review_apply", { ticketId: card.id })) as Ticket;
    expect(applied.latestReview?.apply).toMatchObject({ threadId: "thr_3", completedAt: null });
    expect(spawned[2]).toMatchObject({
      projectId: "proj_acme",
      environment: { type: "reuse", environmentId: "env_thr_2" },
      parentThreadId: "thr_1",
      visibility: "hidden",
      pluginMetadata: { ticketId: card.id, role: "apply" },
    });
    const prompt = String(spawned[2]!.prompt);
    expect(prompt).toContain("`apply-review` skill");
    expect(prompt).toContain("apply every one as written, without a triage step, a confirmation");
    expect(prompt).toContain(`against commit ${sha}`);
    expect(prompt).toContain("git push origin HEAD:refs/heads/feature/refactor");
    expect(prompt).toContain("bb kanban review-applied --commit");
    expect(prompt).toContain("--pushed");
    expect(prompt).toContain("a.go:1 fix me");
    expect(prompt).toContain("never force-push");

    await expect(current().harness.behavior.callRpc("review_apply", { ticketId: card.id })).rejects.toThrow(/already in progress/u);

    const done = await current().harness.behavior.runCli(["review-applied", "--commit", newSha, "--pushed"], ctx("thr_3"));
    expect(done.exitCode).toBe(0);
    const after = (await board()).tickets[0]!.latestReview!;
    expect(after.apply).toMatchObject({ completedAt: expect.any(Number), pushedCommit: newSha, push: true });

    const configured = await current().harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { ticketId: card.id, role: "apply" } }),
    );
    expect(configured?.instructions).toContain("never force-push");
  });

  it("passes only the selected findings to the apply round and persists manual overrides", async () => {
    const card = await reviewedCard();
    const report = {
      version: 1,
      summary: "Adds X.",
      commit: sha,
      range: "origin/main...HEAD",
      reviewers: ["correctness", "style"],
      findings: [
        { id: "F1", severity: "important", title: "Real bug", description: "Breaks when empty", fix: "Guard it", locations: [{ file: "a.go", startLine: 10 }], flaggedBy: ["correctness"], importance: 4, scopeFit: 5 },
        { id: "F2", severity: "important", title: "Refactor everything", description: "New abstraction", fix: "Extract service", locations: [{ file: "b.go" }], flaggedBy: ["style"], importance: 4, scopeFit: 1 },
        { id: "F3", severity: "minor", title: "Nit", description: "Rename", fix: null, locations: [{ file: "c.go", startLine: 3 }], flaggedBy: ["style"], importance: 1, scopeFit: 5 },
      ],
    };
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: `## Review Findings\n...\n\n\`\`\`json review-findings\n${JSON.stringify(report)}\n\`\`\``,
    });
    let { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews[0]!.selection).toEqual({ F1: true, F2: false, F3: false });
    expect((await board()).tickets[0]!.latestReview?.selectedCount).toBe(1);
    expect((await board()).tickets[0]!.latestReview?.scores).toEqual({ maxImportance: 4, meanScopeFit: 3.7, meanImportance: 3, scored: 3 });

    const toggled = (await current().harness.behavior.callRpc("review_set_selection", { reviewId: reviews[0]!.id, findingId: "F3", selected: true })) as Review;
    expect(toggled.selection).toEqual({ F1: true, F2: false, F3: true });
    expect(toggled.selectionOverrides).toEqual({ F3: true });
    await expect(
      current().harness.behavior.callRpc("review_set_selection", { reviewId: reviews[0]!.id, findingId: "F9", selected: true }),
    ).rejects.toThrow(/no finding F9/u);

    await current().harness.behavior.callRpc("review_apply", { ticketId: card.id });
    const prompt = String(spawned[2]!.prompt);
    expect(prompt).toContain("2 of 3 findings were selected");
    expect(prompt).toContain("**F1** (importance 4, scope 5) `a.go:10` — Real bug. Breaks when empty — Guard it (flagged by: correctness)");
    expect(prompt).toContain("**F3**");
    expect(prompt).not.toContain("Refactor everything");
    expect(prompt).toContain("```json review-findings");
    const applied = (await board()).tickets[0]!.latestReview!;
    expect(applied.apply?.findingIds).toEqual(["F1", "F3"]);

    await current().harness.behavior.runCli(["review-applied", "--commit", newSha], ctx("thr_3"));
    const reset = (await current().harness.behavior.callRpc("review_reset_selection", { reviewId: reviews[0]!.id })) as Review;
    expect(reset.selection).toEqual({ F1: true, F2: false, F3: false });
    const nothing = (await current().harness.behavior.callRpc("review_set_selection", { reviewId: reviews[0]!.id, findingId: "F1", selected: false })) as Review;
    expect(Object.values(nothing.selection).some(Boolean)).toBe(false);
    await expect(current().harness.behavior.callRpc("review_apply", { ticketId: card.id })).rejects.toThrow(/No selected findings are left/u);
    ({ reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] });
    expect(reviews[0]!.selectionOverrides).toEqual({ F1: false });
  });

  it("crosses off the findings each apply round fixed, keeps skipped ones open, and never hands a fixed one to a later round", async () => {
    const card = await reviewedCard();
    const report = {
      version: 1,
      summary: "Adds X.",
      commit: sha,
      findings: [
        { id: "F1", severity: "critical", title: "Real bug", locations: [{ file: "a.go", startLine: 10 }] },
        { id: "F2", severity: "critical", title: "Other bug", locations: [{ file: "b.go", startLine: 2 }] },
        { id: "F3", severity: "minor", title: "Nit", locations: [{ file: "c.go", startLine: 3 }] },
      ],
    };
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: `## Review Findings\n\n\`\`\`json review-findings\n${JSON.stringify(report)}\n\`\`\``,
    });
    const reviewId = (await board()).tickets[0]!.latestReview!.id;

    await current().harness.behavior.callRpc("review_apply", { ticketId: card.id });
    expect(String(spawned[2]!.prompt)).toContain("--skipped");
    const done = await current().harness.behavior.runCli(["review-applied", "--commit", newSha, "--skipped", "F2"], ctx("thr_3"));
    expect(done.stdout).toContain("1 finding(s) marked applied, 1 left open");
    let summary = (await board()).tickets[0]!.latestReview!;
    expect(summary).toMatchObject({ appliedCount: 1, selectedCount: 1, counts: { critical: 1, important: 0, minor: 1 } });
    let [stored] = ((await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] }).reviews;
    expect(stored!.appliedFindingIds).toEqual(["F1"]);

    await current().harness.behavior.callRpc("review_set_selection", { reviewId, findingId: "F3", selected: true });
    await current().harness.behavior.callRpc("review_apply", { ticketId: card.id });
    const second = String(spawned[3]!.prompt);
    expect(second).toContain("**F2**");
    expect(second).toContain("**F3**");
    expect(second).not.toContain("Real bug");
    await current().harness.behavior.runCli(["review-applied", "--commit", newSha, "--pushed"], ctx("thr_4"));
    summary = (await board()).tickets[0]!.latestReview!;
    expect(summary).toMatchObject({ appliedCount: 3, selectedCount: 0, counts: { critical: 0, important: 0, minor: 0 } });
    await expect(current().harness.behavior.callRpc("review_apply", { ticketId: card.id })).rejects.toThrow(/No selected findings are left/u);

    const reopened = (await current().harness.behavior.callRpc("review_set_applied", { reviewId, findingId: "F2", applied: false })) as Review;
    expect([...reopened.appliedFindingIds].sort()).toEqual(["F1", "F3"]);
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ appliedCount: 2, selectedCount: 1 });
    [stored] = ((await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] }).reviews;
    expect(stored!.appliedFindingIds).not.toContain("F2");
    await expect(current().harness.behavior.callRpc("review_set_applied", { reviewId, findingId: "F9", applied: true })).rejects.toThrow(/no finding F9/u);
  });

  it("makes a backlog card from a pre-existing finding once, in the reviewed card's project, and never pre-selects it", async () => {
    const card = await reviewedCard();
    const first = {
      version: 2,
      summary: "Adds X.",
      commit: sha,
      findings: [
        { id: "F1", severity: "minor", title: "Nit", locations: [{ file: "a.go", startLine: 1 }], confidence: 90 },
        { id: "F2", severity: "critical", title: "Old race", description: "Two writers interleave.", fix: "Take the lock", class: "unlocked shared write", locations: [{ file: "store.go", startLine: 40, endLine: 52 }, { file: "cache.go" }], confidence: 85, preExisting: true },
      ],
      filtered: [{ id: "X1", severity: "important", title: "Misread", confidence: 10 }],
    };
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: `## Review Findings\n\n\`\`\`json review-findings\n${JSON.stringify(first)}\n\`\`\``,
    });
    const reviewId = (await board()).tickets[0]!.latestReview!.id;
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ counts: { critical: 0, important: 0, minor: 1 } });
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews[0]!.selection).toEqual({ F1: false, F2: false });
    expect(reviews[0]!.report!.filtered.map((entry) => entry.id)).toEqual(["X1"]);

    const made = (await current().harness.behavior.callRpc("review_make_card", { reviewId, findingId: "F2" })) as { ticket: Ticket; created: boolean };
    expect(made.created).toBe(true);
    expect(made.ticket).toMatchObject({ title: "Old race", columnId: "backlog", kind: "adhoc", projectId: card.projectId, threadId: null });
    expect(made.ticket.description).toContain("Two writers interleave.");
    expect(made.ticket.description).toContain("Take the lock");
    expect(made.ticket.description).toContain("`store.go:40-52`");
    expect(made.ticket.description).toContain("`cache.go`");
    expect(made.ticket.description).toContain("**Bug class:** unlocked shared write");
    expect(made.ticket.description).toContain(`(finding ${reviewId}/F2)`);
    expect((await board()).tickets.map((ticket) => ticket.title).sort()).toEqual(["Old race", "Refactor"]);

    // A re-review that carries the finding forward finds the card already made from it.
    await current().harness.behavior.runCli(["review-record", "--commit", sha], ctx("thr_2"));
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    await current().harness.behavior.runCli(["review-record", "--commit", newSha], ctx("thr_3"));
    const carried = { ...first, commit: newSha, carriesForward: true, findings: [{ ...first.findings[1], id: "F1", carriedFrom: `${reviewId}/F2` }], filtered: [] };
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_3", projectId: "proj_acme" }),
      lastAssistantText: `\`\`\`json review-findings\n${JSON.stringify(carried)}\n\`\`\``,
    });
    const [latest] = ((await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] }).reviews;
    expect(latest!.id).not.toBe(reviewId);
    expect(latest!.report!.findings[0]).toMatchObject({ preExisting: true, confidence: 85 });
    const again = (await current().harness.behavior.callRpc("review_make_card", { reviewId: latest!.id, findingId: "F1" })) as { ticket: Ticket; created: boolean };
    expect(again).toMatchObject({ created: false, ticket: { id: made.ticket.id } });
    expect((await board()).tickets).toHaveLength(2);

    // And so does one carried a second time, back through both hops.
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    await current().harness.behavior.runCli(["review-record", "--commit", sha], ctx("thr_4"));
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_4", projectId: "proj_acme" }),
      lastAssistantText: `\`\`\`json review-findings\n${JSON.stringify({ ...carried, commit: sha, findings: [{ ...carried.findings[0], id: "F3", carriedFrom: `${latest!.id}/F1` }] })}\n\`\`\``,
    });
    const [third] = ((await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] }).reviews;
    expect(third!.id).not.toBe(latest!.id);
    const twice = (await current().harness.behavior.callRpc("review_make_card", { reviewId: third!.id, findingId: "F3" })) as { ticket: Ticket; created: boolean };
    expect(twice).toMatchObject({ created: false, ticket: { id: made.ticket.id } });
    expect((await board()).tickets).toHaveLength(2);

    await expect(current().harness.behavior.callRpc("review_make_card", { reviewId, findingId: "X1" })).rejects.toThrow(/no finding X1/u);
  });

  it("pre-selects the findings triage applies, lets the user pull in a deferred or dropped one, and makes a card from a deferred one", async () => {
    const card = await reviewedCard();
    const triaged = {
      version: 4,
      commit: sha,
      findings: [
        { id: "F1", severity: "critical", title: "Retries lose writes", description: "No idempotency key.", locations: [{ file: "a.go", startLine: 4 }], confidence: 95, importance: 5, scopeFit: 2, triage: { decision: "defer", reason: "Needs an idempotency layer; separate work" } },
        { id: "F2", severity: "minor", title: "Magic number", locations: [{ file: "b.go", startLine: 9 }], confidence: 90, importance: 1, scopeFit: 5, triage: { decision: "apply", reason: "One-line constant in touched code" } },
        { id: "F3", severity: "important", title: "Rewrite the parser", locations: [{ file: "c.go" }], confidence: 85, importance: 3, scopeFit: 4, triage: { decision: "drop", reason: "Rewrites 600 lines to save one branch" } },
        { id: "F4", severity: "important", title: "Unverified race", locations: [{ file: "d.go", startLine: 1 }], confidence: null },
      ],
    };
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: `\`\`\`json review-findings\n${JSON.stringify(triaged)}\n\`\`\``,
    });
    const reviewId = (await board()).tickets[0]!.latestReview!.id;
    let [stored] = ((await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] }).reviews;
    expect(stored!.report!.findings[0]!.triage).toEqual({ decision: "defer", reason: "Needs an idempotency layer; separate work" });
    expect(stored!.report!.findings[3]!.triage).toBeNull();
    expect(stored!.selection).toEqual({ F1: false, F2: true, F3: false, F4: true });

    await current().harness.behavior.callRpc("review_set_selection", { reviewId, findingId: "F3", selected: true });
    [stored] = ((await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] }).reviews;
    expect(stored!.selection).toEqual({ F1: false, F2: true, F3: true, F4: true });
    const reset = (await current().harness.behavior.callRpc("review_reset_selection", { reviewId })) as Review;
    expect(reset.selection).toEqual({ F1: false, F2: true, F3: false, F4: true });

    const made = (await current().harness.behavior.callRpc("review_make_card", { reviewId, findingId: "F1" })) as { ticket: Ticket; created: boolean };
    expect(made.created).toBe(true);
    expect(made.ticket.description).toContain(`Deferred by the code review of “Refactor” as separate work: Needs an idempotency layer; separate work (finding ${reviewId}/F1).`);
  });

  it("makes a card from a finding of the change itself too, saying so, with the title cut to a card title's length", async () => {
    const card = await reviewedCard();
    const long = "x".repeat(250);
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: `\`\`\`json review-findings\n${JSON.stringify({ version: 2, commit: sha, findings: [{ id: "F1", severity: "minor", title: long, description: "Rename it.", confidence: 90 }] })}\n\`\`\``,
    });
    const reviewId = (await board()).tickets[0]!.latestReview!.id;
    const { ticket } = (await current().harness.behavior.callRpc("review_make_card", { reviewId, findingId: "F1" })) as { ticket: Ticket };
    expect(ticket.title).toBe("x".repeat(200));
    expect(ticket.description).toBe(`Rename it.\n\nFound by the code review of “Refactor” (finding ${reviewId}/F1).`);
  });

  it("applies without asking and deletes reviews with the card", async () => {
    const card = await reviewedCard();
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: `findings\nReviewed commit: ${sha}`,
    });
    await current().harness.behavior.callRpc("review_apply", { ticketId: card.id });
    expect(String(spawned[2]!.prompt)).not.toContain("go-ahead");

    await current().harness.behavior.callRpc("ticket_delete", { id: card.id });
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews).toEqual([]);
  });

  it("restores a deleted card with its id and reviews, unless sync has added the PR again", async () => {
    const card = await reviewedCard();
    await current().harness.behavior.callRpc("ticket_delete", { id: card.id });
    expect((await board()).tickets).toEqual([]);

    expect(await current().harness.behavior.callRpc("ticket_restore", { id: card.id })).toEqual({ restored: true });
    const restored = (await board()).tickets;
    expect(restored.map((ticket) => ticket.id)).toEqual([card.id]);
    expect(restored[0]).toMatchObject({ reviewThreadId: card.reviewThreadId, columnId: card.columnId });
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews).toHaveLength(1);
    expect(await current().harness.behavior.callRpc("ticket_restore", { id: card.id })).toEqual({ restored: false });

    await current().harness.behavior.callRpc("ticket_delete", { id: card.id });
    await current().harness.behavior.callRpc("sync_now", null);
    const resynced = (await board()).tickets;
    expect(resynced).toHaveLength(1);
    expect(await current().harness.behavior.callRpc("ticket_restore", { id: card.id })).toEqual({ restored: false });
    expect((await board()).tickets.map((ticket) => ticket.id)).toEqual([resynced[0]!.id]);
  });
});

describe("local card review", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const newSha = "fedcba9876543210fedcba9876543210fedcba98";
  const ctx = (threadId: string) => ({ threadId, signal: new AbortController().signal });
  const reportBody = (commit: string, extra: Record<string, unknown>, findings: Array<Record<string, unknown>>) =>
    ["## Review Findings", `Reviewed commit: ${commit}`, "```json review-findings", JSON.stringify({ version: 1, summary: "x", commit, findings, ...extra }), "```"].join("\n");

  interface Checkout {
    headSha?: string | null;
    ahead?: number;
    mergeBaseBranch?: string | null;
    defaultBranch?: string | null;
    hostId?: string;
    /** Replaces the `environments.status` answer. */
    status?: unknown;
  }

  /** The card thread's environment: a branch `ahead` commits past its merge base, at `headSha`. */
  function stubCheckout(checkout: Checkout = {}) {
    const { headSha = sha, ahead = 2, mergeBaseBranch = "main", defaultBranch = "main", hostId = "host_1" } = checkout;
    current().harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId, mergeBaseBranch, defaultBranch }));
    current().harness.sdk.stub("environments.status", async () =>
      checkout.status ?? {
        outcome: "available",
        workspace: {
          branch: { currentBranch: "feature", defaultBranch: "main" },
          checkout: { kind: "branch", branchName: "feature", headSha },
          mergeBase: { aheadCount: ahead, behindCount: 0, baseRef: null, commits: [], files: [], insertions: 0, deletions: 0, hasCommittedUnmergedChanges: ahead > 0, lineStatsComplete: true, mergeBaseBranch: "main" },
        },
      },
    );
  }

  async function localCard(checkout: Checkout = {}): Promise<Ticket> {
    await load({ autoStartThreads: false });
    stubCheckout(checkout);
    return (await current().harness.behavior.callRpc("ticket_create", { title: "Local work", projectId: "proj_acme", startThread: true })) as Ticket;
  }

  async function completeReview(threadId: string, body: string, commit = sha): Promise<Review> {
    await current().harness.behavior.runCli(["review-record", "--commit", commit, "--base", "main"], ctx(threadId));
    await current().harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId, projectId: "proj_acme" }), lastAssistantText: body });
    return ((await current().harness.behavior.callRpc("review_list", { ticketId: (await board()).tickets[0]!.id })) as { reviews: Review[] }).reviews[0]!;
  }

  it("reviews the card thread's HEAD in a fresh hidden worktree against its merge base and persists the findings", async () => {
    const card = await localCard();
    expect(card.threadId).toBe("thr_1");
    expect(await current().harness.behavior.callRpc("review_availability", { ticketId: card.id })).toEqual({ reason: null });

    const reviewed = (await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id })) as Ticket;
    expect(reviewed.reviewThreadId).toBe("thr_2");
    expect(spawned[1]).toMatchObject({
      projectId: "proj_acme",
      environment: { type: "host", hostId: "host_1", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      lifecycleOwnerThreadId: "thr_1",
      title: "Review 0123456: Local work",
      visibility: "hidden",
      pluginMetadata: { ticketId: card.id, role: "review" },
    });
    const prompt = String(spawned[1]!.prompt);
    expect(prompt).toContain(`git checkout --detach ${sha}`);
    expect(prompt).toContain("`main...HEAD`");
    expect(prompt).toContain("## Card intent");
    expect(prompt).toContain("**Title:** Local work");
    expect(prompt).toContain("matches the branch `feature`");
    expect(reviewed.latestReview).toMatchObject({ subjectKind: "local", status: "running", commitSha: null });

    const review = await completeReview("thr_2", reportBody(sha, {}, [{ id: "F1", severity: "important", title: "Leaky handle", locations: [{ file: "a.go", startLine: 3 }] }]));
    expect(review).toMatchObject({ subjectKind: "local", status: "completed", commitSha: sha, baseRef: "main" });
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ status: "completed", counts: { critical: 0, important: 1, minor: 0 } });
  });

  it("starts from the CLI on the thread's card, and says why when it can't", async () => {
    await localCard();
    const result = await current().harness.behavior.runCli(["review"], ctx("thr_1"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("@thread:thr_2");
    expect((await board()).tickets[0]!.latestReview?.subjectKind).toBe("local");

    stubCheckout({ ahead: 0 });
    const refused = await current().harness.behavior.runCli(["review", "--full"], ctx("thr_1"));
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("No commits beyond `main` to review");
  });

  it("runs in the card thread's project and refuses another one", async () => {
    const card = await localCard();
    await expect(current().harness.behavior.callRpc("ticket_review_pr", { id: card.id, projectId: "proj_other" })).rejects.toThrow(/project of the card's thread \(proj_acme\)/u);
    const refused = await current().harness.behavior.runCli(["review", "--project", "proj_other"], ctx("thr_1"));
    expect(refused.exitCode).not.toBe(0);
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id, projectId: "proj_acme" });
    expect(spawned.map((args) => args.projectId)).toEqual(["proj_acme", "proj_acme"]);
  });

  it("runs at Standard depth unless one is chosen, and shows the depth the report says it ran", async () => {
    const card = await localCard();
    const standard = (await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id })) as Ticket;
    expect(String(spawned[1]!.prompt)).toContain("skill at depth `standard`");
    expect(standard.latestReview?.depth).toBe("standard");
    await completeReview("thr_2", reportBody(sha, {}, []));

    const deep = (await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id, mode: "full", depth: "deep" })) as Ticket;
    expect(String(spawned[2]!.prompt)).toContain("skill at depth `deep`");
    expect(deep.latestReview?.depth).toBe("deep");
    const ran = await completeReview("thr_3", reportBody(sha, { version: 5, depth: "quick" }, []));
    expect(ran.depth).toBe("quick");
    expect((await board()).tickets[0]!.latestReview?.depth).toBe("quick");
  });

  it("takes the depth from `bb kanban review --depth`, and refuses one it doesn't know", async () => {
    await localCard();
    const refused = await current().harness.behavior.runCli(["review", "--depth", "thorough"], ctx("thr_1"));
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("quick, standard or deep");
    const result = await current().harness.behavior.runCli(["review", "--depth", "quick"], ctx("thr_1"));
    expect(result.exitCode).toBe(0);
    expect(String(spawned[1]!.prompt)).toContain("skill at depth `quick`");
    expect((await board()).tickets[0]!.latestReview?.depth).toBe("quick");
  });

  const noThread = async () => {
    await load({ autoStartThreads: false });
    return (await current().harness.behavior.callRpc("ticket_create", { title: "No thread" })) as Ticket;
  };
  const noEnvironment = async () => {
    const card = await localCard();
    current().harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_acme", environmentId: null }));
    return card;
  };
  it.each<[string, () => Promise<Ticket>, RegExp]>([
    ["has no thread", noThread, /Start the card's thread first/u],
    ["has a thread with no environment", noEnvironment, /no environment yet/u],
    ["has no commits beyond its merge base", () => localCard({ ahead: 0 }), /No commits beyond `main` to review/u],
    ["has no head commit", () => localCard({ headSha: null }), /no commits yet/u],
    ["has no branch to review against", () => localCard({ mergeBaseBranch: null, defaultBranch: null }), /no default branch/u],
    ["is not a git checkout", () => localCard({ status: { outcome: "not_applicable", reason: "non_git_environment", message: "Not a git repository" } }), /Not a git repository/u],
    ["has an unreadable environment", () => localCard({ status: { outcome: "unavailable", failure: { code: "path_not_found", message: "Workspace path is gone", workspacePath: "/x" } } }), /Workspace path is gone/u],
    ["runs on another machine", () => localCard({ hostId: "host_2" }), /another machine/u],
  ])("explains why a card that %s cannot be reviewed, and refuses to start one", async (_, setup, reason) => {
    const card = await setup();
    const { reason: given } = (await current().harness.behavior.callRpc("review_availability", { ticketId: card.id })) as { reason: string };
    expect(given).toMatch(reason);
    await expect(current().harness.behavior.callRpc("ticket_review_pr", { id: card.id })).rejects.toThrow(reason);
    expect(spawned.filter((args) => (args.pluginMetadata as { role?: string }).role === "review")).toEqual([]);
  });

  it("falls back to the default branch when the environment has no merge-base branch", async () => {
    const card = await localCard({ mergeBaseBranch: null, defaultBranch: "trunk" });
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    expect(String(spawned[1]!.prompt)).toContain("`trunk...HEAD`");
  });

  it("re-reviews the commits since the last local review and carries its open findings forward", async () => {
    const card = await localCard();
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    const first = await completeReview("thr_2", reportBody(sha, {}, [
      { id: "F1", severity: "important", title: "Leaky handle", locations: [{ file: "a.go", startLine: 3 }] },
      { id: "F2", severity: "minor", title: "Wrong default", locations: [] },
    ]));

    stubCheckout({ headSha: newSha });
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    expect(String(spawned[2]!.title)).toBe("Re-review fedcba9: Local work");
    const prompt = String(spawned[2]!.prompt);
    expect(prompt).toContain(`git checkout --detach ${newSha}`);
    expect(prompt).toContain(`${sha}..HEAD`);
    expect(prompt).toContain(`"handle": "${first.id}/F1"`);

    const second = await completeReview(
      "thr_3",
      reportBody(newSha, { carriesForward: true, resolved: [{ id: `${first.id}/F1`, title: "Leaky handle", note: "closed in defer" }] }, [
        { id: "F1", severity: "minor", title: "Wrong default", locations: [], carriedFrom: `${first.id}/F2` },
      ]),
      newSha,
    );
    expect(second).toMatchObject({ sinceCommitSha: sha, commitSha: newSha, report: { carriesForward: true, resolved: [{ title: "Leaky handle" }] } });
  });

  it("starts a full PR review, not a re-review of the local one, once the card gains a PR", async () => {
    const card = await localCard();
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    const local = await completeReview("thr_2", reportBody(sha, {}, [{ id: "F1", severity: "important", title: "Leaky handle", locations: [] }]));
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("acme-co/widgets", 5, { title: "Local work" })],
        heads: { "acme-co/widgets#5": { headRef: "bb/local-work-thr_1", rollup: "SUCCESS" } },
      }),
    );
    await current().harness.behavior.callRpc("sync_now", null);
    expect((await board()).tickets[0]).toMatchObject({ id: card.id, pr: { number: 5 } });

    const reviewed = (await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id, mode: "incremental" })) as Ticket;
    expect(reviewed.latestReview).toMatchObject({ subjectKind: "pr", sinceCommitSha: null });
    const prompt = String(spawned.at(-1)!.prompt);
    expect(prompt).toContain('"pull/5/head"');
    expect(prompt).not.toContain(`${sha}..HEAD`);
    expect(prompt).not.toContain(`${local.id}/F1`);
  });

  it("applies into the card's own thread, records the round, and leaves that thread's visibility alone", async () => {
    const card = await localCard();
    const updates: Array<{ threadId: string; visibility?: string }> = [];
    current().harness.sdk.stub("threads.update", async (args: { threadId: string; visibility?: string }) => {
      updates.push(args);
      return {};
    });
    current().harness.sdk.stub("threads.send", async () => ({ ok: true }));
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    const review = await completeReview("thr_2", reportBody(sha, {}, [
      { id: "F1", severity: "critical", title: "Real bug", locations: [{ file: "a.go", startLine: 10 }] },
      { id: "F2", severity: "critical", title: "Other bug", locations: [{ file: "b.go", startLine: 2 }] },
    ]));

    const applied = (await current().harness.behavior.callRpc("review_apply", { ticketId: card.id, push: true })) as Ticket;
    expect(spawned).toHaveLength(2);
    const sent = current().harness.inspection.sdk.callsTo("threads.send") as Array<[{ threadId: string; input: Array<{ text: string }> }]>;
    expect(sent).toHaveLength(1);
    expect(sent[0]![0].threadId).toBe("thr_1");
    const prompt = sent[0]![0].input[0]!.text;
    expect(prompt).toContain(`--review ${review.id}`);
    expect(prompt).toContain("**F1**");
    expect(prompt).toContain("**F2**");
    expect(applied.latestReview?.apply).toMatchObject({ threadId: "thr_1", completedAt: null, push: false, findingIds: ["F1", "F2"] });
    await expect(current().harness.behavior.callRpc("review_apply", { ticketId: card.id })).rejects.toThrow(/already in progress/u);

    const { threads } = (await current().harness.behavior.callRpc("code_review_threads", { ticketId: card.id })) as { threads: CodeReviewThread[] };
    expect(threads.map((thread) => [thread.kind, thread.threadId, thread.label])).toEqual([
      ["apply", "thr_1", "Apply review findings"],
      ["review", "thr_2", "Review"],
    ]);

    const done = await current().harness.behavior.runCli(["review-applied", "--review", review.id, "--commit", newSha, "--skipped", "F2"], ctx("thr_1"));
    expect(done.stdout).toContain("1 finding(s) marked applied, 1 left open");
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ appliedCount: 1, apply: { completedAt: expect.any(Number), pushedCommit: newSha, push: false } });

    // The card's thread is never a code review thread, so the visibility setting never touches it.
    await current().harness.behavior.setSettings({ hideReviewThreads: false });
    await vi.waitFor(() => expect(updates.filter((update) => update.visibility === "visible").map((update) => update.threadId).sort()).toEqual(["thr_2"]));
  });

  it("refuses a local apply once the card's thread is gone", async () => {
    const card = await localCard();
    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    await completeReview("thr_2", reportBody(sha, {}, [{ id: "F1", severity: "critical", title: "Real bug", locations: [] }]));
    await current().harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_1", projectId: "proj_acme" }) });
    await expect(current().harness.behavior.callRpc("review_apply", { ticketId: card.id })).rejects.toThrow(/card's thread is gone/u);
  });
});

describe("monitored review loop", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const fixSha = "fedcba9876543210fedcba9876543210fedcba98";
  const ctx = (threadId: string) => ({ threadId, signal: new AbortController().signal });
  const evidence = JSON.stringify({ commands: [{ command: "pnpm test", exitCode: 0, outputTail: "42 passed" }] });
  const sentTexts = () => (current().harness.inspection.sdk.callsTo("threads.send") as Array<[{ threadId: string; input: Array<{ text: string }> }]>).map(([args]) => ({ threadId: args.threadId, text: args.input[0]!.text }));
  const card = async () => (await board()).tickets[0]!;

  /** A local card whose thread is `thr_1`, monitored, in a project whose check command is `checkCommand`. */
  async function monitoredCard(checkCommand: string | null = "pnpm check"): Promise<Ticket> {
    await load({ autoStartThreads: false });
    current().harness.sdk.stub("threads.send", async () => ({ ok: true }));
    current().harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_1", mergeBaseBranch: "main", defaultBranch: "main" }));
    current().harness.sdk.stub("environments.status", async () => ({
      outcome: "available",
      workspace: {
        branch: { currentBranch: "feature", defaultBranch: "main" },
        checkout: { kind: "branch", branchName: "feature", headSha: fixSha },
        mergeBase: { aheadCount: 2, behindCount: 0, baseRef: null, commits: [], files: [], insertions: 0, deletions: 0, hasCommittedUnmergedChanges: true, lineStatsComplete: true, mergeBaseBranch: "main" },
      },
    }));
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "Cache lookups", projectId: "proj_acme", startThread: true })) as Ticket;
    if (checkCommand !== null) await current().harness.behavior.callRpc("project_set_check_command", { projectId: "proj_acme", checkCommand });
    return (await current().harness.behavior.callRpc("ticket_set_monitored", { id: ticket.id, monitored: true })) as Ticket;
  }

  /** The classify thread `threadId` scores every changed file `risk`. */
  async function classify(threadId: string, risk: number): Promise<void> {
    const body = ["Scored.", "```json kanban-classify", JSON.stringify({ files: [{ path: "cache.ts", risk, role: "key", lines: 150, note: "lookup cache" }] }), "```"].join("\n");
    await current().harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId, projectId: "proj_acme" }), lastAssistantText: body });
  }
  const ready = (commit = sha, ...extra: string[]) => current().harness.behavior.runCli(["ready", "--commit", commit, "--evidence", evidence, ...extra], ctx("thr_1"));
  const recordChecks = (threadId: string, exitCode: number, output = "") => current().harness.behavior.runCli(["checks-record", "--exit-code", String(exitCode), "--output", output], ctx(threadId));

  it("starts building when monitored and tells the card's thread the loop's contract", async () => {
    const ticket = await monitoredCard();
    expect(ticket.loop).toMatchObject({ monitored: true, phase: "building", reason: null });
    expect(sentTexts()).toEqual([{ threadId: "thr_1", text: expect.stringContaining("bb kanban ready") }]);
    expect(sentTexts()[0]!.text).toContain("`pnpm check`");
  });

  it("re-runs the checks of a ready commit in a fresh hidden worktree and moves the card to Checking", async () => {
    await monitoredCard();
    const result = await ready();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("`pnpm check`");
    expect(spawned[1]).toMatchObject({
      projectId: "proj_acme",
      environment: { type: "host", hostId: "host_1", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      lifecycleOwnerThreadId: "thr_1",
      title: "Checks 0123456: Cache lookups",
      visibility: "hidden",
      pluginMetadata: { ticketId: (await card()).id, role: "checks" },
    });
    const prompt = String(spawned[1]!.prompt);
    expect(prompt).toContain(`git checkout --detach ${sha}`);
    expect(prompt).toContain("( pnpm check )");
    expect(prompt).toContain('log=$(mktemp "${TMPDIR:-/tmp}/kanban-checks.XXXXXX")');
    expect(prompt).toContain('tail -n 200 "$log" >"$log.tail"; bb kanban checks-record --exit-code "$code" --output-file "$log.tail"');
    expect(await card()).toMatchObject({
      columnId: "checking",
      loop: { phase: "checking", commit: sha, checkCommand: { command: "pnpm check", source: "project" }, evidence: { commands: [{ command: "pnpm test", exitCode: 0, outputTail: "42 passed" }], screenshots: [] } },
    });
  });

  it("reads a multi-line evidence file and checks output file, relative to the caller's directory", async () => {
    await monitoredCard();
    const dir = await mkdtemp(join(tmpdir(), "kanban-evidence-"));
    await writeFile(join(dir, "evidence.json"), JSON.stringify({ commands: [{ command: "pnpm test", exitCode: 0, outputTail: "42 passed" }] }, null, 2));
    await writeFile(join(dir, "tail.log"), "ok 1\nok 2\n");
    expect((await current().harness.behavior.runCli(["ready", "--commit", sha, "--evidence-file", "evidence.json"], { ...ctx("thr_1"), cwd: dir })).exitCode).toBe(0);
    expect((await card()).loop).toMatchObject({ phase: "checking", evidence: { commands: [{ command: "pnpm test", outputTail: "42 passed" }] } });
    expect((await current().harness.behavior.runCli(["checks-record", "--exit-code", "1", "--output-file", join(dir, "tail.log")], ctx("thr_2"))).exitCode).toBe(0);
    expect((await current().harness.behavior.runCli(["checks-record", "--exit-code", "1", "--output-file", "missing.log"], { ...ctx("thr_2"), cwd: dir })).exitCode).not.toBe(0);
    await vi.waitFor(() => expect(sentTexts().at(-1)!.text).toContain("ok 1\nok 2"));
    await rm(dir, { recursive: true });
  });

  it("starts its worker threads owned by the card's thread rather than as its children, with the card thread's provider and options", async () => {
    await monitoredCard();
    current().harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "model-a", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/thread/start" }));
    await ready();
    // bb posts a child's final message into its parent, which the card's thread would take as work to do.
    expect(spawned[1]).not.toHaveProperty("parentThreadId");
    // Running a command needs none of the card thread's reasoning.
    expect(spawned[1]).toMatchObject({ lifecycleOwnerThreadId: "thr_1", providerId: expect.any(String), model: "model-a", permissionMode: "auto", serviceTier: "default", reasoningLevel: "low" });
  });

  it("stops the checks thread a newer ready supersedes, and ignores its late idle", async () => {
    await monitoredCard();
    current().harness.sdk.stub("threads.stop", async () => ({ ok: true }));
    await ready();
    await ready(fixSha);
    expect(current().harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_2" }]]);
    expect(spawned[2]).toMatchObject({ title: "Checks fedcba9: Cache lookups" });
    await current().harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }), lastAssistantText: "Stopped." });
    expect((await card()).loop).toMatchObject({ phase: "checking", commit: fixSha, retries: 0 });
  });

  it("stops at a loop error, without retrying, when the review thread lacks the skill whose report the board reads", async () => {
    await monitoredCard();
    await ready();
    await recordChecks("thr_2", 0);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "classifying" }));
    await classify("thr_3", 3);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId: expect.any(String) }));
    await current().harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_4", projectId: "proj_acme" }), lastAssistantText: "Review skill missing." });
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "needs-you", reason: "loop-error", failedThreadId: "thr_4", failure: expect.stringContaining("node scripts/link-claude-config.mjs") }));
    expect(spawned).toHaveLength(4);
  });

  const reviewBody = (commit: string, findings: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    ["## Review Findings", `Reviewed commit: ${commit}`, "```json review-findings", JSON.stringify({ version: 5, summary: "x", commit, findings, ...extra }), "```"].join("\n");
  async function completeReview(threadId: string, body: string, commit: string): Promise<void> {
    await current().harness.behavior.runCli(["review-record", "--commit", commit, "--base", "main"], ctx(threadId));
    await current().harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId, projectId: "proj_acme" }), lastAssistantText: body });
  }

  /** A monitored card whose first review, thread `thr_4`, has started at `sha`. */
  async function reviewingCard(): Promise<void> {
    await monitoredCard();
    await ready();
    await recordChecks("thr_2", 0);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "classifying" }));
    await classify("thr_3", 3);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId: expect.any(String) }));
    await current().harness.behavior.runCli(["review-record", "--commit", sha, "--base", "main"], ctx("thr_4"));
  }
  const idle = (threadId: string, text: string) => current().harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId, projectId: "proj_acme" }), lastAssistantText: text });

  it("keeps reviewing through an interim message the review thread idles on, and routes the report that replaces it", async () => {
    await reviewingCard();
    await idle("thr_4", "C6 scored 65 and goes to the filtered list. Two verifiers still running.");
    expect((await card()).loop).toMatchObject({ phase: "reviewing", reason: null });
    await idle("thr_4", reviewBody(sha, []));
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "needs-you", reason: "clean" }));
  });

  it("counts a review failed once its thread stays idle on an interim message, and at once when it says it stopped", async () => {
    await reviewingCard();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await idle("thr_4", "Two verifiers still running.");
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect((await card()).loop).toMatchObject({ phase: "reviewing" });
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "needs-you", reason: "loop-error", failure: "the thread finished without a review-findings report the board could read" }));

    await reviewingCard();
    await idle("thr_4", "Review failed: the PR head could not be fetched\nDetails follow.");
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "needs-you", reason: "loop-error", failure: "the review stopped: the PR head could not be fetched" }));
  });

  it("reviews the commit that passed its checks, sends only the findings triaged apply to the card's thread, and re-reviews the fix", async () => {
    await monitoredCard();
    await ready();
    expect((await recordChecks("thr_2", 0, "all green")).exitCode).toBe(0);
    expect(spawned[2]).toMatchObject({ lifecycleOwnerThreadId: "thr_1", title: "Classify 0123456: Cache lookups", visibility: "hidden", pluginMetadata: { role: "classify" } });
    expect(String(spawned[2]!.prompt)).toContain("git diff --numstat main...HEAD");
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "classifying" }));
    await classify("thr_3", 3);
    await vi.waitFor(() => expect(spawned).toHaveLength(4));
    expect(spawned[3]).toMatchObject({ lifecycleOwnerThreadId: "thr_1", pluginMetadata: { role: "review" } });
    expect(String(spawned[3]!.prompt)).toContain(`git checkout --detach ${sha}`);
    expect(String(spawned[3]!.prompt)).toContain("at depth `standard`");
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId: expect.any(String) }));
    expect((await card()).columnId).toBe("checking");

    await completeReview(
      "thr_4",
      reviewBody(sha, [
        { id: "F1", severity: "important", title: "Misleading name", locations: [{ file: "cache.ts", startLine: 3 }], confidence: 90, triage: { decision: "apply", reason: "" } },
        { id: "F2", severity: "important", title: "No eviction", locations: [], confidence: 90, triage: { decision: "defer", reason: "separate work" } },
        { id: "F3", severity: "critical", title: "Old race", locations: [], confidence: 90, preExisting: true },
      ]),
      sha,
    );
    await vi.waitFor(async () => expect(await card()).toMatchObject({ columnId: "in-progress", loop: { phase: "fixing", round: 1, rounds: [{ handed: ["F1"] }] } }));
    const fix = sentTexts().at(-1)!;
    expect(fix.threadId).toBe("thr_1");
    expect(fix.text).toContain("Fix exactly these findings, and nothing beyond them");
    expect(fix.text).toContain("Misleading name");
    expect(fix.text).not.toContain("No eviction");
    expect(fix.text).not.toContain("Old race");
    expect(fix.text).toContain("bb kanban ready");
    expect(fix.text).toContain("bb kanban answer");

    expect((await ready(fixSha)).exitCode).not.toBe(0);
    expect((await current().harness.behavior.runCli(["answer", "F1", "fixed"], ctx("thr_1"))).stdout).toContain("every finding is answered");
    await ready(fixSha);
    await recordChecks("thr_5", 0);
    const rereview = String(spawned[5]!.prompt);
    expect(rereview).toContain(`${sha}..HEAD`);
    expect(rereview).toContain("an apply round committed a fix for it");
    const fixedReviewId = (await card()).loop!.rounds[0]!.reviewId;
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId: expect.not.stringMatching(fixedReviewId) }));

    await completeReview("thr_6", reviewBody(fixSha, [], { carriesForward: true, resolved: [] }), fixSha);
    await vi.waitFor(async () =>
      expect(await card()).toMatchObject({ columnId: "review", loop: { phase: "needs-you", reason: "clean", round: 1, attention: { level: "read", reasons: ["risk 3: lookup cache (cache.ts)"] } } }),
    );
    expect(phaseChip((await card()).loop!)?.label).toBe("ready · Read");
  });

  it("marks the card's thread read after a turn that hands the work to the board, and unread with an alert when the loop stops for the user", async () => {
    await monitoredCard();
    const marked = (method: "threads.markRead" | "threads.markUnread") => (current().harness.inspection.sdk.callsTo(method) as Array<[{ threadId: string }]>).map(([args]) => args.threadId);
    const alerts = () => current().harness.inspection.realtimeSignals.filter((signal) => signal.channel === LOOP_STOPPED).map((signal) => signal.payload);
    const cardIdle = () => current().harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", projectId: "proj_acme" }), lastAssistantText: "Done." });

    // Stopping while building, without reporting ready, leaves something for the user to see.
    await cardIdle();
    expect(marked("threads.markRead")).toEqual([]);
    await ready();
    await cardIdle();
    expect(marked("threads.markRead")).toEqual(["thr_1"]);
    // A later turn, such as one the user started while the board works, didn't hand anything off.
    await current().harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_1", projectId: "proj_acme" }) });
    await cardIdle();
    expect(marked("threads.markRead")).toEqual(["thr_1"]);

    await recordChecks("thr_2", 0);
    await classify("thr_3", 3);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId: expect.any(String) }));
    expect(alerts()).toEqual([]);
    await completeReview("thr_4", reviewBody(sha, []), sha);
    await vi.waitFor(() => expect(marked("threads.markUnread")).toEqual(["thr_1"]));
    expect(alerts()).toEqual([{ threadId: "thr_1", title: "Cache lookups", body: expect.stringContaining("Checked and reviewed clean at 0123456") }]);
    // The board's own threads are hidden, so they never reach the unread list to begin with.
    expect(marked("threads.markRead")).toEqual(["thr_1"]);
  });

  it("checks a round of only minor findings without reviewing it again, and ends clean with the disputed one left open", async () => {
    await reviewingCard();
    const apply = { confidence: 90, triage: { decision: "apply", reason: "" } };
    await idle("thr_4", reviewBody(sha, [
      { id: "F1", severity: "minor", title: "Misleading name", locations: [], ...apply },
      { id: "F2", severity: "minor", title: "Magic number", locations: [], ...apply },
    ]));
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "fixing", rounds: [{ handed: ["F1", "F2"], polish: true }] }));
    await current().harness.behavior.runCli(["answer", "F1", "fixed"], ctx("thr_1"));
    await current().harness.behavior.runCli(["answer", "F2", "disputed", "--reason", "The number is named two lines up"], ctx("thr_1"));
    await ready(fixSha);
    const spawnedBefore = spawned.length;
    // The fix's checks thread is the last one spawned.
    await recordChecks(`thr_${spawned.length}`, 0);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "needs-you", reason: "clean", commit: fixSha, openFindings: [{ id: "F2", severity: "minor", title: "Magic number" }] }));
    expect(spawned).toHaveLength(spawnedBefore);
  });

  it("takes the card thread's dispute to the re-review, leaves it unapplied, and escalates a rejected important one", async () => {
    await monitoredCard();
    await ready();
    await recordChecks("thr_2", 0);
    await classify("thr_3", 3);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId: expect.any(String) }));
    const apply = { confidence: 90, triage: { decision: "apply", reason: "" } };
    await completeReview(
      "thr_4",
      reviewBody(sha, [
        { id: "F1", severity: "minor", title: "Misleading name", locations: [], ...apply },
        { id: "F2", severity: "important", title: "Stale reads", locations: [], ...apply },
      ]),
      sha,
    );
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "fixing", rounds: [{ handed: ["F1", "F2"] }] }));
    const reviewId = (await card()).loop!.rounds[0]!.reviewId;

    expect((await current().harness.behavior.runCli(["answer", "F9", "fixed"], ctx("thr_1"))).exitCode).not.toBe(0);
    expect((await current().harness.behavior.runCli(["answer", "F2", "disputed"], ctx("thr_1"))).exitCode).not.toBe(0);
    await current().harness.behavior.runCli(["answer", "F1", "fixed"], ctx("thr_1"));
    await current().harness.behavior.runCli(["answer", "F2", "disputed", "--reason", "Entries are per-request, so nothing goes stale"], ctx("thr_1"));
    await ready(fixSha);
    const fixed = (await current().harness.behavior.callRpc("review_list", { ticketId: (await card()).id })) as { reviews: Review[] };
    expect(fixed.reviews.find((review) => review.id === reviewId)!.appliedFindingIds).toEqual(["F1"]);

    await recordChecks("thr_5", 0);
    const rereview = String(spawned[5]!.prompt);
    expect(rereview).toContain("Entries are per-request, so nothing goes stale");
    expect(rereview).toContain("the card's thread disputed it instead of fixing it");
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId: expect.not.stringMatching(reviewId) }));

    const rejected = { reason: "Entries are per-request, so nothing goes stale", outcome: "rejected", note: "The map is module-level" };
    await completeReview(
      "thr_6",
      reviewBody(fixSha, [{ id: "F1", severity: "important", title: "Stale reads", locations: [], carriedFrom: `${reviewId}/F2`, dispute: rejected, ...apply }], { carriesForward: true }),
      fixSha,
    );
    await vi.waitFor(async () => expect(await card()).toMatchObject({ columnId: "review", loop: { phase: "needs-you", reason: "dispute" } }));
  });

  it("sends failing checks back to the card's thread with their output, and escalates a second failure in a row", async () => {
    await monitoredCard();
    await ready();
    await recordChecks("thr_2", 1, "FAIL cache.test.ts");
    expect(await card()).toMatchObject({ columnId: "in-progress", loop: { phase: "building", reason: null } });
    const bounced = sentTexts()[1]!;
    expect(bounced.threadId).toBe("thr_1");
    expect(bounced.text).toContain(`\`pnpm check\` at commit ${sha}`);
    expect(bounced.text).toContain("exit code 1");
    expect(bounced.text).toContain("FAIL cache.test.ts");
    expect(spawned.filter((args) => (args.pluginMetadata as { role?: string }).role === "review")).toEqual([]);

    await ready(fixSha);
    expect(spawned[2]).toMatchObject({ pluginMetadata: { role: "checks" } });
    await recordChecks("thr_3", 1, "FAIL again");
    expect(await card()).toMatchObject({ columnId: "review", loop: { phase: "needs-you", reason: "checks" } });
    expect(sentTexts()).toHaveLength(2);
  });

  it("retries a checks thread that fails or goes idle without a result once, then escalates as a loop error naming it", async () => {
    await monitoredCard();
    await ready();
    await current().harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }), error: "provider crashed" });
    await vi.waitFor(() => expect(spawned).toHaveLength(3));
    expect(spawned[2]).toMatchObject({ pluginMetadata: { role: "checks" } });
    expect((await card()).loop).toMatchObject({ phase: "checking", retries: 1 });
    await current().harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_3", projectId: "proj_acme" }), lastAssistantText: "I could not run it" });
    await vi.waitFor(async () => expect(await card()).toMatchObject({ columnId: "review", loop: { reason: "loop-error", failedThreadId: "thr_3" } }));
  });

  it("resumes a review thread that failed mid-turn instead of starting a fresh review", async () => {
    await monitoredCard();
    await ready();
    await recordChecks("thr_2", 0);
    await classify("thr_3", 2);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId: expect.any(String) }));
    const { reviewId } = (await card()).loop!;
    await current().harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_4", projectId: "proj_acme", status: "error" }), error: null });
    await current().harness.behavior.emitThreadEvent("turn.failed", { threadId: "thr_4", requestId: "req_1", turnId: null, errorInfo: null, inputAccepted: true, rateLimits: null, attemptNumber: 1 });
    await vi.waitFor(() => expect(current().harness.inspection.sdk.callsTo("threads.retry")).toHaveLength(1));
    expect(spawned).toHaveLength(4);
    expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId, retries: 0 });

    await completeReview("thr_4", reviewBody(sha, []), sha);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "needs-you", reason: "clean" }));
  });

  it("pauses on the card thread's question without moving the card, and resumes at its next ready", async () => {
    const { columnId } = await monitoredCard();
    const interaction = { id: "int_1", kind: "user_question" } as unknown as PluginThreadEventPayloads["interaction.pending"]["interaction"];
    await current().harness.behavior.emitThreadEvent("interaction.pending", { thread: makeThreadResponse({ id: "thr_1", projectId: "proj_acme" }), interaction });
    expect(await card()).toMatchObject({ columnId, loop: { phase: "paused", reason: "question" } });
    await ready();
    expect(await card()).toMatchObject({ columnId: "checking", loop: { phase: "checking", reason: null } });
  });

  it("uses the agent's command, marked as its choice, when the project sets none", async () => {
    await monitoredCard(null);
    const refused = await ready();
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("--check-command");
    expect(spawned).toHaveLength(1);

    const result = await ready(sha, "--check-command", "make test");
    expect(result.stdout).toContain("your choice");
    expect(String(spawned[1]!.prompt)).toContain("( make test )");
    expect((await card()).loop?.checkCommand).toEqual({ command: "make test", source: "agent" });
  });

  it("turns on and off from the CLI; off stops the loop after its current step", async () => {
    await load({ autoStartThreads: false });
    current().harness.sdk.stub("threads.send", async () => ({ ok: true }));
    await current().harness.behavior.callRpc("ticket_create", { title: "Cache lookups", projectId: "proj_acme", startThread: true });
    await current().harness.behavior.callRpc("project_set_check_command", { projectId: "proj_acme", checkCommand: "pnpm check" });
    const notYet = await ready();
    expect(notYet.stdout).toContain("isn't monitored");
    expect(spawned).toHaveLength(1);

    expect((await current().harness.behavior.runCli(["monitor", "on"], ctx("thr_1"))).stdout).toContain("monitored: building");
    await ready();
    expect((await current().harness.behavior.runCli(["monitor", "off"], ctx("thr_1"))).stdout).toContain("after its current step");
    await recordChecks("thr_2", 1, "FAIL");
    expect((await card()).loop).toMatchObject({ monitored: false, phase: "idle", checks: [{ exitCode: 1 }] });
    expect(sentTexts()).toHaveLength(1);
  });

  it("holds a monitored card's thread to the loop's contract and tells checks threads what to record", async () => {
    const ticket = await monitoredCard();
    const configured = await current().harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { ticketId: ticket.id } }));
    expect(configured?.instructions).toContain("never move the card yourself");
    expect(configured?.instructions).toContain("bb kanban ready");
    expect(configured?.instructions).toContain("`pnpm check`");
    expect(configured?.instructions).not.toContain("bb kanban move in-progress");
    expect(configured!.instructions!.length).toBeLessThanOrEqual(4096);

    const checks = await current().harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { ticketId: ticket.id, role: "checks" } }));
    expect(checks?.instructions).toContain("bb kanban checks-record");
  });

  it("adds Checking to an existing board the first time a card is monitored, keeping its column names", async () => {
    await load({ autoStartThreads: false });
    expect((await board()).columns.map((column) => column.name)).toEqual(["Backlog", "To Do", "Building", "Checking", "Needs you", "Done"]);
    await current().harness.behavior.callRpc("columns_set", {
      columns: [
        { id: "backlog", name: "Backlog" },
        { id: "in-progress", name: "Doing" },
        { id: "review", name: "In Review" },
        { id: "done", name: "Done" },
      ],
    });
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "A" })) as Ticket;
    await current().harness.behavior.callRpc("ticket_set_monitored", { id: ticket.id, monitored: true });
    expect((await board()).columns).toEqual([
      { id: "backlog", name: "Backlog" },
      { id: "in-progress", name: "Doing" },
      { id: "checking", name: "Checking" },
      { id: "review", name: "In Review" },
      { id: "done", name: "Done" },
    ]);
  });

  it("keeps the old default names on a board in use that never stored its columns", async () => {
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("ticket_create", { title: "A" });
    host = await current().harness.lifecycle.reload(plugin);
    expect((await board()).columns.map((column) => column.name)).toEqual(["Backlog", "To Do", "In Progress", "In Review", "Done"]);
  });

  /** A monitored local card whose first review came back clean, so it waits at Needs you. */
  async function cleanAtNeedsYou(): Promise<Ticket> {
    await monitoredCard();
    await ready();
    await recordChecks("thr_2", 0);
    await classify("thr_3", 2);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId: expect.any(String) }));
    await completeReview("thr_4", reviewBody(sha, []), sha);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "needs-you", reason: "clean" }));
    return card();
  }

  it("accepts a local card by asking its thread to land the change, and moves it to Done when it reports landed", async () => {
    const ticket = await cleanAtNeedsYou();
    expect((await current().harness.behavior.runCli(["landed"], ctx("thr_1"))).exitCode).not.toBe(0);
    await current().harness.behavior.callRpc("loop_accept", { id: ticket.id });
    const land = sentTexts().at(-1)!;
    expect(land).toMatchObject({ threadId: "thr_1", text: expect.stringContaining("AGENTS.md or CLAUDE.md") });
    expect(land.text).toContain("bb kanban landed");
    expect(await card()).toMatchObject({ columnId: "review", loop: { phase: "accepted" } });
    expect((await current().harness.behavior.runCli(["landed"], ctx("thr_1"))).exitCode).toBe(0);
    expect(await card()).toMatchObject({ columnId: "done", loop: { phase: "landed" } });
  });

  it("requests the narrative at Scrutinize and holds Accept until the reading plan's files are viewed", async () => {
    await monitoredCard();
    const patch = "diff --git a/cache.ts b/cache.ts\n--- a/cache.ts\n+++ b/cache.ts\n@@ -1 +1 @@\n-old\n+new\n";
    current().harness.sdk.stub("environments.diff", async () => ({ outcome: "available", diff: { diff: patch, mergeBaseRef: null, truncated: false } }));
    await ready();
    await recordChecks("thr_2", 0);
    await classify("thr_3", 5);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "reviewing", reviewId: expect.any(String) }));
    await completeReview("thr_4", reviewBody(sha, []), sha);
    await vi.waitFor(async () => expect((await card()).loop).toMatchObject({ phase: "needs-you", attention: { level: "scrutinize" } }));
    await vi.waitFor(() => expect(spawned.some((args) => String(args.title).startsWith("Narrative"))).toBe(true));
    const ticket = await card();

    const plan = (await current().harness.behavior.callRpc("loop_reading_plan", { id: ticket.id })) as ReadingPlan;
    expect(plan).toMatchObject({ level: "scrutinize", gated: true, unviewed: ["cache.ts"], source: "classify" });
    await expect(current().harness.behavior.callRpc("loop_accept", { id: ticket.id })).rejects.toThrow(/1 still isn't: cache.ts/u);

    // Lowered with a reason, the gate lifts; the reason is kept.
    await current().harness.behavior.callRpc("loop_set_level", { id: ticket.id, level: "read", reason: "only a rename" });
    expect((await card()).loop).toMatchObject({ levelOverride: { level: "read", from: "scrutinize", reason: "only a rename" } });
    expect(((await current().harness.behavior.callRpc("loop_reading_plan", { id: ticket.id })) as ReadingPlan).gated).toBe(false);
    await current().harness.behavior.callRpc("loop_set_level", { id: ticket.id, level: "scrutinize", reason: "on second look" });
    await current().harness.behavior.callRpc("diff_viewed_set", { ticketId: ticket.id, path: "cache.ts", viewed: true });
    await current().harness.behavior.callRpc("loop_accept", { id: ticket.id });
    expect((await card()).loop).toMatchObject({ phase: "accepted" });
  });

  it("sends the unsent diff comments to the card's thread as the user's round, and marks them addressed at its next ready", async () => {
    const ticket = await cleanAtNeedsYou();
    await expect(current().harness.behavior.callRpc("loop_send_back", { id: ticket.id })).rejects.toThrow("No unsent diff comments");
    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: ticket.id, path: "cache.ts", line: 3, side: "RIGHT", body: "Name this lookupCache", target: "local", inReplyTo: null });
    await current().harness.behavior.callRpc("loop_send_back", { id: ticket.id });
    const sent = sentTexts().at(-1)!;
    expect(sent).toMatchObject({ threadId: "thr_1", text: expect.stringContaining("Name this lookupCache") });
    expect(sent.text).toContain("doesn't count toward the review loop's cap");
    expect(await card()).toMatchObject({ columnId: "in-progress", pendingDiffComments: 0, loop: { phase: "building", round: 0, humanRounds: 1 } });

    await ready(fixSha);
    const { comments } = (await current().harness.behavior.callRpc("diff_comments_list", { ticketId: ticket.id })) as { comments: DiffComment[] };
    expect(comments[0]!.addressedAt).not.toBeNull();
  });

  it("keeps a card's checks runs through delete and restore", async () => {
    const ticket = await monitoredCard();
    await ready();
    await current().harness.behavior.callRpc("ticket_delete", { id: ticket.id });
    await current().harness.behavior.callRpc("ticket_restore", { id: ticket.id });
    await recordChecks("thr_2", 0);
    expect((await card()).loop).toMatchObject({ phase: "classifying" });
  });

  it("holds a plan-gated card until its plan is approved, then sends the approved plan to its thread and its review", async () => {
    const ticket = await monitoredCard();
    await current().harness.behavior.callRpc("ticket_set_monitored", { id: ticket.id, monitored: false });
    await current().harness.behavior.callRpc("ticket_set_monitored", { id: ticket.id, monitored: true, gates: { plan: true, findings: false, autoAccept: false } });
    expect(sentTexts().at(-1)!.text).toContain("bb kanban plan --plan-file <that file>");
    expect((await ready()).exitCode).not.toBe(0);

    // bb's --plan-stdin takes one line, so a Markdown plan comes from a file.
    const dir = await mkdtemp(join(tmpdir(), "kanban-plan-"));
    await writeFile(join(dir, "plan.md"), "Memoize lookups\n\n- per request\n");
    expect((await current().harness.behavior.runCli(["plan", "--plan-file", "plan.md", "--plan", "x"], { ...ctx("thr_1"), cwd: dir })).exitCode).not.toBe(0);
    expect((await current().harness.behavior.runCli(["plan", "--plan-file", "plan.md"], { ...ctx("thr_1"), cwd: dir })).exitCode).toBe(0);
    expect(await card()).toMatchObject({ columnId: "review", loop: { phase: "planning", proposedPlan: "Memoize lookups\n\n- per request" } });
    await rm(dir, { recursive: true });
    await current().harness.behavior.callRpc("loop_approve_plan", { id: ticket.id, plan: "Memoize lookups per request" });
    expect(await card()).toMatchObject({ columnId: "in-progress", loop: { phase: "building", plan: "Memoize lookups per request" } });
    expect(sentTexts().at(-1)!.text).toContain("with their edits");
    expect(sentTexts().at(-1)!.text).toContain("Memoize lookups per request");

    await ready();
    await recordChecks("thr_2", 0);
    await classify("thr_3", 3);
    await vi.waitFor(() => expect(spawned).toHaveLength(4));
    expect(String(spawned[3]!.prompt)).toContain("**Approved plan:**\n\nMemoize lookups per request");
  });
});

describe("open findings in the loop chips", () => {
  const minors = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `F${index + 1}`, severity: "minor" as const, title: `Nit ${index + 1}` }));
  const readyTitle = (count: number) =>
    phaseChip(loopStateSchema.parse({ monitored: true, phase: "needs-you", reason: "clean", commit: "abc1234def", openFindings: minors(count) }))!.title;

  it("lists none when no minor is open", () => {
    expect(readyTitle(0)).toBe("Checked and reviewed clean at abc1234; needs you");
  });

  it("lists three in full", () => {
    expect(readyTitle(3)).toBe("Checked and reviewed clean at abc1234; 3 minor findings left open: F1 Nit 1, F2 Nit 2, F3 Nit 3; needs you");
  });

  it("lists the first three of five, then how many more", () => {
    expect(readyTitle(5)).toBe("Checked and reviewed clean at abc1234; 5 minor findings left open: F1 Nit 1, F2 Nit 2, F3 Nit 3, +2 more; needs you");
  });

  it("gives the loop status line the same capped clause", () => {
    expect(openFindingsClause(minors(5))).toBe("5 minor findings left open: F1 Nit 1, F2 Nit 2, F3 Nit 3, +2 more");
    expect(openFindingsClause(minors(1))).toBe("1 minor finding left open: F1 Nit 1");
  });

  it("counts a finding deselected at the findings gate by its severity, and lists it ahead of the minors", () => {
    const open = [...minors(3), { id: "F9", severity: "important" as const, title: "Unbounded cache" }];
    expect(openFindingsClause(open)).toBe("4 findings (1 important, 3 minor) left open: F9 Unbounded cache, F1 Nit 1, F2 Nit 2, +1 more");
  });

  it("caps the accepted and landed chips the same way", () => {
    const chip = (phase: "accepted" | "landed") => phaseChip(loopStateSchema.parse({ monitored: true, phase, commit: "abc1234def", openFindings: minors(5) }))!.title;
    expect(chip("accepted")).toBe("Monitored; accepted; 5 minor findings left open: F1 Nit 1, F2 Nit 2, F3 Nit 3, +2 more");
    expect(chip("landed")).toBe("Monitored; accepted and landed; 5 minor findings left open: F1 Nit 1, F2 Nit 2, F3 Nit 3, +2 more");
  });
});

describe("monitoring defaults", () => {
  it("monitors new cards carrying a monitor tag with the default gates, unless the card's own flag says otherwise", async () => {
    await load({ autoStartThreads: false, monitorTags: "loop, risky" });
    const create = async (input: Record<string, unknown>) => (await current().harness.behavior.callRpc("ticket_create", { title: "Work", ...input })) as Ticket;
    expect((await create({ tags: ["loop"] })).loop).toMatchObject({ monitored: true, phase: "building", gates: { plan: false, findings: false, autoAccept: false } });
    expect((await create({ tags: ["loop"], monitored: false })).loop).toBeNull();
    expect((await create({ tags: ["other"] })).loop).toBeNull();
    expect((await create({ tags: ["other"], monitored: true })).loop).toMatchObject({ monitored: true });
    expect((await board()).columns.map((column) => column.id)).toContain("checking");
  });
});

describe("tags and sources", () => {
  it("tags ad hoc cards, edits tags, and filters the CLI list", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "A", tags: ["Infra", "urgent"] })) as Ticket;
    expect(ticket.tags).toEqual(["infra", "urgent"]);
    await expect(current().harness.behavior.callRpc("ticket_set_tags", { id: ticket.id, tags: ["Bad Tag"] })).rejects.toThrow();

    const tagged = await current().harness.behavior.runCli(["tag", "later", "--ticket", ticket.id, "--json"]);
    expect((JSON.parse(tagged.stdout ?? "") as Ticket).tags).toEqual(["infra", "later", "urgent"]);
    const untagged = await current().harness.behavior.runCli(["untag", "urgent", "--ticket", ticket.id, "--json"]);
    expect((JSON.parse(untagged.stdout ?? "") as Ticket).tags).toEqual(["infra", "later"]);

    await current().harness.behavior.callRpc("ticket_create", { title: "B" });
    const list = await current().harness.behavior.runCli(["list", "--tag", "infra", "--json"]);
    expect((JSON.parse(list.stdout ?? "") as Ticket[]).map((entry) => entry.title)).toEqual(["A"]);
    expect((await board()).tags).toEqual(["infra", "later"]);
  });

  it("sets, shows, and clears due dates from the RPC and the CLI, rejecting dates that do not exist", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "Ship it", dueDate: "2026-10-31" })) as Ticket;
    expect(ticket.dueDate).toBe("2026-10-31");
    await expect(current().harness.behavior.callRpc("ticket_create", { title: "Bad", dueDate: "2026-02-30" })).rejects.toThrow();
    await expect(current().harness.behavior.callRpc("ticket_set_due_date", { id: ticket.id, dueDate: "Oct 31" })).rejects.toThrow();

    const moved = (await current().harness.behavior.callRpc("ticket_set_due_date", { id: ticket.id, dueDate: "2026-11-02" })) as Ticket;
    expect(moved.dueDate).toBe("2026-11-02");
    const shown = await current().harness.behavior.runCli(["show", "--ticket", ticket.id]);
    expect(shown.stdout).toContain("due 2026-11-02");

    const cleared = await current().harness.behavior.runCli(["due", "none", "--ticket", ticket.id, "--json"]);
    expect((JSON.parse(cleared.stdout ?? "") as Ticket).dueDate).toBeNull();
    const set = await current().harness.behavior.runCli(["due", "2027-01-15", "--ticket", ticket.id, "--json"]);
    expect((JSON.parse(set.stdout ?? "") as Ticket).dueDate).toBe("2027-01-15");
    const invalid = await current().harness.behavior.runCli(["due", "2027-13-01", "--ticket", ticket.id]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("Invalid due date");

    const added = await current().harness.behavior.runCli(["add", "Later", "--due", "2026-12-01", "--no-link", "--json"]);
    expect((JSON.parse(added.stdout ?? "") as Ticket).dueDate).toBe("2026-12-01");
  });

  it("ships the two GitHub sources by default and applies every matching source's tags", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("acme-co/widgets", 1, { user: { login: "sean" } })],
        requested: [searchItem("acme-co/widgets", 1, { user: { login: "sean" } })],
      }),
    );
    await load({ autoStartThreads: false });
    const sources = (await board()).sources;
    expect(sources.map((source) => source.id)).toEqual(["my-prs", "pr-reviews"]);
    expect(sources.find((source) => source.id === "pr-reviews")?.doneWhenGone).toBe(true);
    await current().harness.behavior.callRpc("sync_now", null);
    const [card] = (await board()).tickets;
    expect(card).toMatchObject({ tags: ["my-prs", "pr-reviews"], sourceId: "my-prs" });

    const cli = await current().harness.behavior.runCli(["sources"]);
    expect(cli.stdout).toContain("my-prs");
    expect(cli.stdout).toContain("#pr-reviews");
  });

  it("uses user-defined sources: new tags are added to existing cards and doneWhenGone is per source", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 1, { user: { login: "sean" } })] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);

    await current().harness.behavior.callRpc("sources_set", {
      sources: [
        {
          id: "mine",
          name: "Mine",
          kind: "github-search",
          query: "is:pr is:open author:@me archived:false",
          tags: ["mine", "work"],
          doneWhenGone: true,
          enabled: true,
        },
      ],
    });
    await current().harness.behavior.callRpc("sync_now", null);
    expect((await board()).tickets[0]).toMatchObject({ tags: ["mine", "my-prs", "work"], sourceId: "my-prs" });

    // The PR leaves the only source but stays open: the original source (my-prs) is gone, so it is not moved.
    vi.stubGlobal("fetch", stubGithub({ authored: [], pulls: { "acme-co/widgets#1": { state: "open", merged: false } } }));
    await current().harness.behavior.callRpc("sync_now", null);
    expect((await board()).tickets[0]!.columnId).toBe("todo");

    await expect(
      current().harness.behavior.callRpc("sources_set", {
        sources: [
          { id: "a", name: "A", kind: "github-search", query: "x", tags: [], doneWhenGone: false, enabled: true },
          { id: "a", name: "B", kind: "github-search", query: "y", tags: [], doneWhenGone: false, enabled: true },
        ],
      }),
    ).rejects.toThrow(/Duplicate/u);
  });
});

describe("source code reviews", () => {
  const reviewSource = (reviewNewPrs: string | null) => ({
    id: "pr-reviews",
    name: "Review requests",
    kind: "github-search",
    query: "is:pr is:open user-review-requested:@me",
    tags: ["pr-reviews"],
    doneWhenGone: true,
    enabled: true,
    reviewNewPrs,
  });
  const reviewThreads = () => spawned.filter((args) => (args.pluginMetadata as { role?: string } | undefined)?.role === "review");

  it("reviews each new PR from the source at its depth under the card's thread, once, leaving earlier cards alone", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 1, { user: { login: "alice" } })] }));
    await load();
    await current().harness.behavior.callRpc("sources_set", { sources: [reviewSource(null)] });
    await current().harness.behavior.callRpc("sync_now", null);
    expect(reviewThreads()).toHaveLength(0);

    vi.stubGlobal("fetch", stubGithub({ requested: [1, 2].map((number) => searchItem("acme-co/widgets", number, { title: "Please review", user: { login: "alice" } })) }));
    await current().harness.behavior.callRpc("sources_set", { sources: [reviewSource("quick")] });
    await current().harness.behavior.callRpc("sync_now", null);
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets.find((ticket) => ticket.pr?.number === 2)!;
    expect(reviewThreads()).toEqual([
      expect.objectContaining({ title: "Review widgets#2: Please review", lifecycleOwnerThreadId: card.threadId, visibility: "hidden", pluginMetadata: { ticketId: card.id, role: "review" } }),
    ]);
    expect(card.latestReview).toMatchObject({ status: "running", depth: "quick" });
    expect((await board()).sync.lastError).toBeNull();

    const cli = await current().harness.behavior.runCli(["sources"]);
    expect(cli.stdout).toContain("(Quick review of new PRs)");
  });

  it("waits for a draft PR to open before reviewing it", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 1, { draft: true })] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sources_set", { sources: [reviewSource("standard")] });
    await current().harness.behavior.callRpc("sync_now", null);
    expect(reviewThreads()).toHaveLength(0);

    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 1)] }));
    await current().harness.behavior.callRpc("sync_now", null);
    expect(reviewThreads().map((args) => args.title)).toEqual(["Review widgets#1: PR 1"]);
  });

  it("leaves a card the review loop monitors to the loop", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 1)] }));
    await load({ autoStartThreads: false, monitorTags: "pr-reviews" });
    await current().harness.behavior.callRpc("sources_set", { sources: [reviewSource("standard")] });
    await current().harness.behavior.callRpc("sync_now", null);
    await current().harness.behavior.callRpc("sync_now", null);
    expect((await board()).tickets[0]!.loop).toMatchObject({ monitored: true });
    expect(reviewThreads()).toHaveLength(0);
  });

  it("re-reviews a PR that comes back to the source, once the running review has finished", async () => {
    const open = { state: "open" as const, merged: false };
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 4)] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sources_set", { sources: [reviewSource("standard")] });
    await current().harness.behavior.callRpc("sync_now", null);
    expect(reviewThreads()).toHaveLength(1);

    vi.stubGlobal("fetch", stubGithub({ requested: [], pulls: { "acme-co/widgets#4": open } }));
    await current().harness.behavior.callRpc("sync_now", null);
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 4)], pulls: { "acme-co/widgets#4": open } }));
    await current().harness.behavior.callRpc("sync_now", null);
    expect(reviewThreads()).toHaveLength(1);

    const ctx = { threadId: "thr_1", signal: new AbortController().signal };
    await current().harness.behavior.runCli(["review-record", "--commit", "0123456789abcdef0123456789abcdef01234567", "--base", "main"], ctx);
    await current().harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", projectId: "proj_acme" }), lastAssistantText: "No findings." });
    await current().harness.behavior.callRpc("sync_now", null);
    expect(reviewThreads().map((args) => String(args.title))).toEqual(["Review widgets#4: PR 4", "Re-review widgets#4: PR 4"]);
    await current().harness.behavior.callRpc("sync_now", null);
    expect(reviewThreads()).toHaveLength(2);
  });
});

describe("source narratives", () => {
  const narrateSource = (narrateNewPrs: boolean) => ({
    id: "pr-reviews",
    name: "Review requests",
    kind: "github-search",
    query: "is:pr is:open user-review-requested:@me",
    tags: ["pr-reviews"],
    doneWhenGone: true,
    enabled: true,
    narrateNewPrs,
  });
  const narrativeThreads = () => spawned.filter((args) => (args.pluginMetadata as { role?: string } | undefined)?.role === "narrative");
  const finishNarrative = async (threadId: string) =>
    current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: threadId, projectId: "proj_acme" }),
      lastAssistantText: [
        "```json kanban-narrative",
        JSON.stringify({ version: 1, summary: "Adds `add`.", readingOrder: [{ path: "a.go", role: "key", note: "The new function.", lines: [2] }], watchOut: [] }),
        "```",
      ].join("\n"),
    });

  it("narrates each new PR from the source under the card's thread, once, leaving earlier cards alone", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 1, { user: { login: "alice" } })] }));
    await load();
    await current().harness.behavior.callRpc("sources_set", { sources: [narrateSource(false)] });
    await current().harness.behavior.callRpc("sync_now", null);
    expect(narrativeThreads()).toHaveLength(0);

    vi.stubGlobal("fetch", stubGithub({ requested: [1, 2].map((number) => searchItem("acme-co/widgets", number, { title: "Please review", user: { login: "alice" } })) }));
    await current().harness.behavior.callRpc("sources_set", { sources: [narrateSource(true)] });
    await current().harness.behavior.callRpc("sync_now", null);
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets.find((ticket) => ticket.pr?.number === 2)!;
    expect(narrativeThreads()).toEqual([
      expect.objectContaining({ title: "Narrative widgets#2: Please review", lifecycleOwnerThreadId: card.threadId, pluginMetadata: { ticketId: card.id, role: "narrative" } }),
    ]);
    expect((await board()).sync.lastError).toBeNull();

    const cli = await current().harness.behavior.runCli(["sources"]);
    expect(cli.stdout).toContain("(narrative of new PRs)");
  });

  it("waits for a draft PR to open before narrating it", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 1, { draft: true })] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sources_set", { sources: [narrateSource(true)] });
    await current().harness.behavior.callRpc("sync_now", null);
    expect(narrativeThreads()).toHaveLength(0);

    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 1)] }));
    await current().harness.behavior.callRpc("sync_now", null);
    expect(narrativeThreads().map((args) => args.title)).toEqual(["Narrative widgets#1: PR 1"]);
  });

  it("leaves a card the review loop monitors to the loop", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 1)] }));
    await load({ autoStartThreads: false, monitorTags: "pr-reviews" });
    await current().harness.behavior.callRpc("sources_set", { sources: [narrateSource(true)] });
    await current().harness.behavior.callRpc("sync_now", null);
    await current().harness.behavior.callRpc("sync_now", null);
    expect((await board()).tickets[0]!.loop).toMatchObject({ monitored: true });
    expect(narrativeThreads()).toHaveLength(0);
  });

  it("waits out a running narrative when a PR comes back, then leaves a current one alone", async () => {
    const open = { state: "open" as const, merged: false };
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 4)] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sources_set", { sources: [narrateSource(true)] });
    await current().harness.behavior.callRpc("sync_now", null);
    expect(narrativeThreads()).toHaveLength(1);

    vi.stubGlobal("fetch", stubGithub({ requested: [], pulls: { "acme-co/widgets#4": open } }));
    await current().harness.behavior.callRpc("sync_now", null);
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 4)], pulls: { "acme-co/widgets#4": open } }));
    await current().harness.behavior.callRpc("sync_now", null);
    expect(narrativeThreads()).toHaveLength(1);

    const card = (await board()).tickets[0]!;
    const { narrative } = (await current().harness.behavior.callRpc("narrative_get", { ticketId: card.id })) as { narrative: Narrative };
    await finishNarrative(narrative.threadId);
    await current().harness.behavior.callRpc("sync_now", null);
    expect(narrativeThreads()).toHaveLength(1);
    expect((await board()).sync.lastError).toBeNull();
  });
});

describe("Jira sources", () => {
  const jiraSettings = { jiraSiteUrl: "https://acme.atlassian.net/", jiraEmail: "dev@acme.example", jiraApiToken: "jt" };
  const jiraSource = {
    id: "my-jira",
    name: "My Jira",
    kind: "jira-jql" as const,
    jql: "assignee = currentUser() AND statusCategory != Done",
    tags: ["jira"],
    doneWhenGone: false,
    enabled: true,
    projectId: "proj_acme",
  };

  it("flattens Atlassian Document Format to text", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
      ],
    };
    expect(adfToText(adf).trim()).toBe("Hello world\n\n- one");
    expect(adfToText(null)).toBe("");
  });

  it("creates tagged Jira cards in status-based columns, spawns threads in the source project, and refreshes status", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        jira: [
          { key: "ACME-1", summary: "Fix login", category: "new", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Details here" }] }] } },
          { key: "ACME-2", summary: "In flight", category: "indeterminate", status: "In Progress", priority: "High" },
        ],
      }),
    );
    await load({ ...jiraSettings, autoStartThreads: true });
    await current().harness.behavior.callRpc("sources_set", { sources: [jiraSource] });
    // sources_set kicks a sync asynchronously; call explicitly for a deterministic assertion.
    await current().harness.behavior.callRpc("sync_now", null);
    const { tickets, sync } = await board();
    expect(sync.jiraSite).toBe("https://acme.atlassian.net");
    expect(sync.lastError).toBeNull();
    const byKey = new Map(tickets.map((ticket) => [ticket.jira?.key, ticket]));
    expect(byKey.get("ACME-1")).toMatchObject({
      kind: "jira",
      columnId: "todo",
      tags: ["jira"],
      sourceId: "my-jira",
      projectId: "proj_acme",
      description: "Details here",
      jira: { url: "https://acme.atlassian.net/browse/ACME-1", status: "To Do", statusCategory: "new", issueType: "Task", assignee: "Sean" },
    });
    expect(byKey.get("ACME-2")).toMatchObject({ columnId: "in-progress", jira: { priority: "High", statusCategory: "indeterminate" } });
    const spawnedJira = spawned.find((args) => String(args.title).startsWith("ACME-1"));
    expect(String(spawnedJira?.prompt)).toContain("Jira issue ACME-1");
    expect(String(spawnedJira?.prompt)).toContain("Details here");

    // ACME-2 leaves the search and is now Done in Jira; ACME-1 is done while still in the search.
    vi.stubGlobal(
      "fetch",
      stubGithub({
        jira: [{ key: "ACME-1", summary: "Fix login", category: "done", status: "Done" }],
        jiraIssues: { "ACME-2": { key: "ACME-2", summary: "In flight", category: "done", status: "Done" } },
      }),
    );
    await current().harness.behavior.callRpc("sync_now", null);
    const after = new Map((await board()).tickets.map((ticket) => [ticket.jira?.key, ticket]));
    expect(after.get("ACME-1")).toMatchObject({ columnId: "done", jira: { status: "Done" } });
    expect(after.get("ACME-2")).toMatchObject({ columnId: "done", jira: { statusCategory: "done" } });
    const list = await current().harness.behavior.runCli(["list", "--tag", "jira"]);
    expect(list.stdout).toContain("ACME-1 (Done)");
    const cli = await current().harness.behavior.runCli(["sources"]);
    expect(cli.stdout).toContain("[jira-jql] assignee = currentUser()");
  });

  it("keeps a Jira card's edited title over the issue's summary", async () => {
    vi.stubGlobal("fetch", stubGithub({ jira: [{ key: "ACME-1", summary: "Fix login", category: "new" }, { key: "ACME-2", summary: "In flight", category: "new" }] }));
    await load({ ...jiraSettings, autoStartThreads: false });
    await current().harness.behavior.callRpc("sources_set", { sources: [jiraSource] });
    await current().harness.behavior.callRpc("sync_now", null);
    const ticket = (await board()).tickets.find((entry) => entry.jira?.key === "ACME-1")!;
    await current().harness.behavior.callRpc("ticket_update", { id: ticket.id, title: "Login, properly" });

    vi.stubGlobal("fetch", stubGithub({ jira: [{ key: "ACME-1", summary: "Fix login v2", category: "new" }, { key: "ACME-2", summary: "Still in flight", category: "new" }] }));
    await current().harness.behavior.callRpc("sync_now", null);
    const titles = new Map((await board()).tickets.map((entry) => [entry.jira?.key, entry.title]));
    expect(titles.get("ACME-1")).toBe("Login, properly");
    expect(titles.get("ACME-2")).toBe("Still in flight");
  });

  it("reports missing Jira settings and per-source failures without blocking GitHub sources", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 1, { user: { login: "sean" } })] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sources_set", { sources: [...((await board()).sources), jiraSource] });
    const status = (await current().harness.behavior.callRpc("sync_now", null)) as Board["sync"];
    expect(status.lastError).toContain("Jira sources need");
    expect((await board()).tickets.some((ticket) => ticket.kind === "pr")).toBe(true);

    vi.stubGlobal("fetch", stubGithub({ authored: [], jiraFail: true, pulls: { "acme-co/widgets#1": { state: "open", merged: false } } }));
    await current().harness.behavior.setSettings(jiraSettings);
    const failed = (await current().harness.behavior.callRpc("sync_now", null)) as Board["sync"];
    expect(failed.lastError).toContain("My Jira: Jira 500");
    expect(failed.jiraSite).toBe("https://acme.atlassian.net");
  });

  it("rejects a source whose fields do not match its kind", async () => {
    await load();
    await expect(
      current().harness.behavior.callRpc("sources_set", {
        sources: [{ id: "x", name: "X", kind: "jira-jql", query: "is:pr", tags: [], doneWhenGone: false, enabled: true }],
      }),
    ).rejects.toThrow();
  });
});

describe("PR comments", () => {
  const comments = {
    issue: [
      { id: 1, login: "alice", body: "Can you add a test for the empty case?" },
      { id: 2, login: "sean", body: "Sure, will do." },
    ],
    review: [
      { id: 10, login: "bob", body: "Rename this to `provisionAll`", path: "a.go", line: 12 },
      { id: 11, login: "sean", body: "Good call", path: "a.go", line: 12, replyTo: 10 },
    ],
    reviews: [
      { id: 100, login: "bob", body: "A few nits inline.", state: "CHANGES_REQUESTED" },
      { id: 101, login: "carol", body: "", state: "APPROVED" },
      { id: 102, login: "dave", body: "draft", state: "PENDING", submitted: false },
    ],
  };
  const ctx = (threadId: string) => ({ threadId, signal: new AbortController().signal });

  async function syncedCard(extra: Record<string, string | number | boolean> = {}): Promise<Ticket> {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 7, { title: "Refactor", user: { login: "sean" } })], comments }));
    await load({ autoStartThreads: false, ...extra });
    await current().harness.behavior.callRpc("sync_now", null);
    return (await board()).tickets[0]!;
  }

  it("syncs conversation, inline, and review comments; my own and approvals are not selected", async () => {
    const card = await syncedCard();
    expect(card.comments).toEqual({ total: 5, open: 3, selected: 3 });
    const { comments: list } = (await current().harness.behavior.callRpc("comments_list", { ticketId: card.id })) as { comments: PrComment[] };
    const byId = new Map(list.map((comment) => [comment.id, comment]));
    expect(byId.get("issue-comment:1")).toMatchObject({ kind: "issue-comment", author: "alice", mine: false, selected: true });
    expect(byId.get("issue-comment:2")).toMatchObject({ mine: true, selected: false });
    expect(byId.get("review-comment:10")).toMatchObject({ path: "a.go", line: 12, selected: true, inReplyTo: null });
    expect(byId.get("review-comment:11")).toMatchObject({ inReplyTo: "review-comment:10", mine: true, selected: false });
    expect(byId.get("review:100")).toMatchObject({ kind: "review", reviewState: "CHANGES_REQUESTED", selected: true });
    expect(byId.has("review:101")).toBe(false);
    expect(byId.has("review:102")).toBe(false);

    // Unchanged PR: comments are not refetched; a bumped updated_at refetches and drops deleted ones.
    const fetchMock = vi.fn(stubGithub({ authored: [searchItem("acme-co/widgets", 7, { user: { login: "sean" } })], comments: { issue: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    await current().harness.behavior.callRpc("sync_now", null);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/issues/7/comments"))).toBe(false);
    expect((await board()).tickets[0]!.comments?.total).toBe(5);
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 7, { user: { login: "sean" }, updated_at: "2026-10-06T00:00:00Z" })], comments: { issue: [comments.issue[0]!] } }));
    await current().harness.behavior.callRpc("sync_now", null);
    expect((await board()).tickets[0]!.comments).toEqual({ total: 1, open: 1, selected: 1 });

    const cli = await current().harness.behavior.runCli(["comments", "--ticket", card.id]);
    expect(cli.stdout).toContain("[x] issue-comment:1  alice");
  });

  it("resolves only inline review threads", async () => {
    await syncedCard();
    await expect(current().harness.behavior.callRpc("comment_set_resolved", { id: "issue-comment:1", resolved: true })).rejects.toThrow("Only inline review threads");
    await expect(current().harness.behavior.callRpc("comment_set_resolved", { id: "review:100", resolved: true })).rejects.toThrow("Only inline review threads");
    expect(resolvedMutations).toEqual([]);
  });

  it("applies only selected comments, optionally without pushing, and marks them addressed afterwards", async () => {
    const card = await syncedCard();
    await current().harness.behavior.callRpc("comment_set_selected", { id: "review:100", selected: false });
    await current().harness.behavior.callRpc("comment_set_addressed", { id: "issue-comment:1", addressed: true });
    expect((await board()).tickets[0]!.comments).toEqual({ total: 5, open: 2, selected: 1 });

    await expect(current().harness.behavior.callRpc("comments_apply", { ticketId: card.id, push: false })).resolves.toMatchObject({
      apply: { threadId: "thr_1", commentIds: ["review-comment:10"], push: false },
    });
    const prompt = String(spawned[0]!.prompt);
    expect(spawned[0]).toMatchObject({ visibility: "hidden", pluginMetadata: { ticketId: card.id, role: "apply-comments" } });
    expect(prompt).toContain("`apply-pr-comments` skill");
    expect(prompt).toContain("Rename this to `provisionAll`");
    expect(prompt).not.toContain("A few nits inline");
    expect(prompt).not.toContain("empty case");
    expect(prompt).toContain("Do NOT push");
    expect(prompt).toContain("```json pr-comments");
    expect(prompt).toContain("apply every one as written, without a triage step, a confirmation");

    await expect(current().harness.behavior.callRpc("comments_apply", { ticketId: card.id })).rejects.toThrow(/already in progress/u);
    const done = await current().harness.behavior.runCli(["comments-applied", "--commit", "abc1234"], ctx("thr_1"));
    expect(done.exitCode).toBe(0);
    const { comments: list, applies } = (await current().harness.behavior.callRpc("comments_list", { ticketId: card.id })) as { comments: PrComment[]; applies: CommentApply[] };
    expect(list.find((comment) => comment.id === "review-comment:10")?.addressedAt).toEqual(expect.any(Number));
    expect(applies[0]).toMatchObject({ completedAt: expect.any(Number), pushedCommit: "abc1234", push: false });
    expect((await board()).tickets[0]!.comments).toEqual({ total: 5, open: 1, selected: 0 });

    await expect(current().harness.behavior.callRpc("comments_apply", { ticketId: card.id })).rejects.toThrow(/No comments are selected/u);
    const configured = await current().harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { ticketId: card.id, role: "apply-comments" } }),
    );
    expect(configured?.instructions).toContain("apply-pr-comments");
  });

  it("includes the push step when asked and records pushed on review and comment applies", async () => {
    const card = await syncedCard();
    const result = (await current().harness.behavior.callRpc("comments_apply", { ticketId: card.id, push: true })) as { apply: CommentApply };
    const prompt = String(spawned[0]!.prompt);
    expect(prompt).toContain('git push origin HEAD:refs/heads/"$HEAD_REF"');
    expect(prompt).toContain("--pushed");
    expect(prompt).toContain("apply every one as written");
    await current().harness.behavior.runCli(["comments-applied", "--commit", "abc1234", "--pushed", "--apply", result.apply.id]);
    const { applies } = (await current().harness.behavior.callRpc("comments_list", { ticketId: card.id })) as { applies: CommentApply[] };
    expect(applies[0]).toMatchObject({ push: true, pushedCommit: "abc1234" });
  });
});

describe("diff view and diff comments", () => {
  it("splits a unified diff into per-file patches with stats", () => {
    const diff = [
      "diff --git a/a.go b/a.go",
      "index 1..2 100644",
      "--- a/a.go",
      "+++ b/a.go",
      "@@ -1,2 +1,3 @@",
      " line",
      "-old",
      "+new",
      "+more",
      "diff --git a/old.txt b/new.txt",
      "similarity index 90%",
      "rename from old.txt",
      "rename to new.txt",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/bin.png b/bin.png",
      "new file mode 100644",
      "Binary files /dev/null and b/bin.png differ",
    ].join("\n");
    const files = splitUnifiedDiff(diff);
    expect(files.map((file) => [file.path, file.status, file.additions, file.deletions, file.patch !== null])).toEqual([
      ["a.go", "modified", 2, 1, true],
      ["new.txt", "renamed", 1, 1, true],
      ["bin.png", "added", 0, 0, false],
    ]);
    expect(files[1]!.previousPath).toBe("old.txt");
  });

  it("serves the PR diff from GitHub and sends local comments to an agent and GitHub drafts to the PR separately", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 7, { title: "Refactor", user: { login: "alice" } })] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    expect(card).toMatchObject({ canPostToGithub: true, defaultCommentTarget: "github" });

    const diff = (await current().harness.behavior.callRpc("diff_get", { ticketId: card.id })) as TicketDiff;
    expect(diff.source).toBe("pr");
    expect(diff.baseRef).toBe("main");
    expect(diff.files.map((file) => [file.path, file.patch === null])).toEqual([["a.go", false], ["img.png", true]]);

    const onGithub = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 2, side: "LEFT", body: "Use a constant here" })) as DiffComment;
    expect(onGithub).toMatchObject({ side: "LEFT", target: "github" });
    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "img.png", body: "Do we need this asset?" });
    const local = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 3, side: "LEFT", body: "Inline the helper", target: "local" })) as DiffComment;
    expect((await board()).tickets[0]!.pendingDiffComments).toBe(3);
    await current().harness.behavior.callRpc("diff_comment_update", { id: onGithub.id, body: "Use a named constant here", line: 3 });

    const toGithub = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: false })) as { posted: number; apply: CommentApply | null };
    expect(toGithub).toMatchObject({ posted: 2, apply: null });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ event: "COMMENT", commit_id: "9f3b2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c", comments: [{ path: "a.go", line: 3, side: "LEFT", body: "Use a named constant here" }] });
    expect(String(posted[0]!.body)).toContain("img.png");
    expect(String(posted[0]!.body)).not.toContain("Inline the helper");
    expect(spawned).toHaveLength(0);
    let { comments } = (await current().harness.behavior.callRpc("diff_comments_list", { ticketId: card.id })) as { comments: DiffComment[] };
    expect(comments.find((comment) => comment.id === onGithub.id)).toMatchObject({ githubCommentId: "review-comment:8000", postedUrl: expect.stringContaining("discussion_r8000") });
    expect(comments.find((comment) => comment.path === "img.png")).toMatchObject({ githubCommentId: "review:901" });
    expect(comments.find((comment) => comment.id === local.id)?.postedAt).toBeNull();
    expect((await board()).tickets[0]!.pendingDiffComments).toBe(1);
    await expect(current().harness.behavior.callRpc("diff_comment_update", { id: onGithub.id, body: "x" })).rejects.toThrow(/already posted/u);

    const toAgent = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: false, address: true })) as { posted: number; apply: CommentApply | null };
    expect(toAgent.posted).toBe(0);
    expect(toAgent.apply?.commentIds).toEqual([`local:${local.id}`]);
    const prompt = String(spawned[0]!.prompt);
    expect(prompt).toContain("`apply-pr-comments` skill");
    expect(prompt).toContain("left on the Kanban diff view");
    expect(prompt).toContain("(On removed line 3 of the old file.) Inline the helper");
    expect(prompt).not.toContain("named constant");
    expect(prompt).toContain("bb kanban comment-reply <id>");
    expect(posted).toHaveLength(1);
    expect((await board()).tickets[0]!.pendingDiffComments).toBe(0);
    await expect(current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: true })).rejects.toThrow(/No pending comments/u);

    await current().harness.behavior.runCli(["comments-applied", "--commit", "abc1234", "--pushed"], { threadId: "thr_1", signal: new AbortController().signal });
    ({ comments } = (await current().harness.behavior.callRpc("diff_comments_list", { ticketId: card.id })) as { comments: DiffComment[] });
    expect(comments.find((comment) => comment.id === local.id)?.addressedAt).toEqual(expect.any(Number));
  });

  it("posts multi-line comments with their start line, syncs GitHub's, and names the range for the agent", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        requested: [searchItem("acme-co/widgets", 7, { title: "Refactor", user: { login: "alice" } })],
        comments: { review: [{ id: 501, login: "bob", body: "This block", path: "a.go", line: 4, startLine: 2 }, { id: 502, login: "bob", body: "Gone", path: "a.go", line: null, startLine: 5 }] },
      }),
    );
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const synced = ((await current().harness.behavior.callRpc("comments_list", { ticketId: card.id })) as { comments: PrComment[] }).comments;
    expect(synced.find((comment) => comment.id === "review-comment:501")).toMatchObject({ line: 4, startLine: 2, startSide: "RIGHT", outdated: false });
    expect(synced.find((comment) => comment.id === "review-comment:502")).toMatchObject({ line: 1, startLine: 5, outdated: true });

    const draft = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 3, startLine: 1, startSide: "LEFT", side: "RIGHT", body: "Rename across both" })) as DiffComment;
    expect(draft).toMatchObject({ line: 3, side: "RIGHT", startLine: 1, startSide: "LEFT", target: "github" });
    await expect(current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 1, startLine: 3, body: "Backwards" })).rejects.toThrow(/before/u);
    const reply = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "x", body: "Same here", inReplyTo: "review-comment:501", target: "local" })) as DiffComment;
    expect(reply).toMatchObject({ path: "a.go", line: 4, startLine: 2, startSide: "RIGHT" });
    const local = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 3, side: "LEFT", startLine: 1, body: "Drop these", target: "local" })) as DiffComment;

    await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: false });
    expect(posted[0]).toMatchObject({ comments: [{ path: "a.go", start_line: 1, start_side: "LEFT", line: 3, side: "RIGHT", body: "Rename across both" }] });

    await current().harness.behavior.callRpc("diff_comment_delete", { id: reply.id });
    const toAgent = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: false, address: true })) as { apply: CommentApply | null };
    expect(toAgent.apply?.commentIds).toEqual([`local:${local.id}`]);
    const prompt = String(spawned[0]!.prompt);
    expect(prompt).toContain("a.go:1-3 (old side) (left on the Kanban diff view)");
    expect(prompt).toContain("(On removed lines 1–3 of the old file.) Drop these");
    expect(prompt).toContain('"startLine": 1');
  });

  it("defaults to local comments without the review tag, still posts GitHub drafts, and falls back to a body-only review on 422", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 7, { user: { login: "sean" } })], rejectInline: true }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    expect(card).toMatchObject({ canPostToGithub: true, defaultCommentTarget: "local" });
    const note = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 99, body: "Off the diff" })) as DiffComment;
    expect(note.target).toBe("local");
    await expect(current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: false })).rejects.toThrow(/No pending comments/u);

    await current().harness.behavior.callRpc("diff_comment_update", { id: note.id, target: "github" });
    const result = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, reviewBody: "  Mostly nits.  ", address: false })) as { posted: number; apply: CommentApply | null };
    expect(result).toMatchObject({ posted: 1, apply: null });
    expect(posted).toHaveLength(2);
    expect(posted[0]!.body).toBe("Mostly nits.");
    expect(posted[1]!.comments).toBeUndefined();
    expect(String(posted[1]!.body)).toMatch(/^Mostly nits\.\n\n- `a.go:99`/u);
    const { comments } = (await current().harness.behavior.callRpc("diff_comments_list", { ticketId: card.id })) as { comments: DiffComment[] };
    expect(comments[0]).toMatchObject({ githubCommentId: "review:902" });
    await expect(current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: false, address: false })).rejects.toThrow();
  });

  it("posts GitHub drafts as an approval or change request on someone else's PR, but not on your own", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({ requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })], authored: [searchItem("acme-co/widgets", 8, { user: { login: "sean" } })] }),
    );
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const tickets = (await board()).tickets;
    const theirs = tickets.find((ticket) => ticket.pr?.number === 7)!;
    const mine = tickets.find((ticket) => ticket.pr?.number === 8)!;

    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: theirs.id, path: "a.go", line: 3, side: "LEFT", body: "Looks good", target: "github" });
    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: theirs.id, path: "b.go", line: null, body: "Whole file reads well", target: "github" });
    const approved = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: theirs.id, postToGithub: true, reviewEvent: "APPROVE", reviewBody: "LGTM, one nit", address: false })) as { movedToDone: boolean; ticket: Ticket };
    expect(posted[0]).toMatchObject({ event: "APPROVE", body: "LGTM, one nit\n\n- `b.go` — Whole file reads well", comments: [{ path: "a.go", body: "Looks good" }] });
    // Approving finishes your review, so the card goes to Done.
    expect(approved).toMatchObject({ movedToDone: true, ticket: { columnId: "done" } });
    expect((await board()).tickets.find((ticket) => ticket.id === theirs.id)?.columnId).toBe("done");

    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: mine.id, path: "a.go", line: 3, side: "LEFT", body: "Note to self", target: "github" });
    await expect(current().harness.behavior.callRpc("diff_comments_submit", { ticketId: mine.id, postToGithub: true, reviewEvent: "REQUEST_CHANGES", address: false })).rejects.toThrow(/your own pull request/u);
    expect(posted).toHaveLength(1);
  });

  it("submits a review with no drafts when it carries a comment or a verdict, as GitHub's Submit review does", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({ requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })], authored: [searchItem("acme-co/widgets", 8, { user: { login: "sean" } })] }),
    );
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const tickets = (await board()).tickets;
    const theirs = tickets.find((ticket) => ticket.pr?.number === 7)!;
    const mine = tickets.find((ticket) => ticket.pr?.number === 8)!;

    // Nothing to say and nothing to post: no review.
    await expect(current().harness.behavior.callRpc("diff_comments_submit", { ticketId: theirs.id, postToGithub: true, address: false })).rejects.toThrow(/No pending comments/u);
    await expect(current().harness.behavior.callRpc("diff_comments_submit", { ticketId: theirs.id, postToGithub: true, reviewBody: "  ", address: false })).rejects.toThrow(/No pending comments/u);
    // A verdict alone still can't go on your own PR.
    await expect(current().harness.behavior.callRpc("diff_comments_submit", { ticketId: mine.id, postToGithub: true, reviewEvent: "APPROVE", address: false })).rejects.toThrow(/your own pull request/u);
    expect(posted).toHaveLength(0);

    const commented = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: mine.id, postToGithub: true, reviewBody: "Context for reviewers", address: false })) as { posted: number };
    expect(commented.posted).toBe(0);
    expect(posted).toEqual([{ event: "COMMENT", body: "Context for reviewers" }]);

    const approved = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: theirs.id, postToGithub: true, reviewEvent: "APPROVE", reviewBody: "LGTM", address: false })) as { movedToDone: boolean };
    expect(posted[1]).toEqual({ event: "APPROVE", body: "LGTM" });
    expect(approved.movedToDone).toBe(true);
  });

  it("leaves the card where it is when a review posts as a comment or change request, or when the approval fails", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const theirs = (await board()).tickets.find((ticket) => ticket.pr?.number === 7)!;
    expect(theirs.columnId).toBe("todo");

    const submit = (reviewEvent: string) => current().harness.behavior.callRpc("diff_comments_submit", { ticketId: theirs.id, postToGithub: true, reviewEvent, address: false }) as Promise<{ movedToDone: boolean; ticket: Ticket }>;
    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: theirs.id, path: "a.go", line: 3, side: "LEFT", body: "Hmm", target: "github" });
    expect(await submit("COMMENT")).toMatchObject({ movedToDone: false, ticket: { columnId: "todo" } });
    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: theirs.id, path: "a.go", line: 3, side: "LEFT", body: "Please fix", target: "github" });
    expect(await submit("REQUEST_CHANGES")).toMatchObject({ movedToDone: false, ticket: { columnId: "todo" } });

    const stub = fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/pulls\/\d+\/reviews$/u.test(url)) return new Response("boom", { status: 500 });
      return stub(input, init);
    }));
    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: theirs.id, path: "a.go", line: 3, side: "LEFT", body: "Ship it", target: "github" });
    await expect(submit("APPROVE")).rejects.toThrow();
    expect((await board()).tickets.find((ticket) => ticket.id === theirs.id)?.columnId).toBe("todo");
  });

  it("moves the card to Done when replies alone post with an approval", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })],
        comments: { review: [{ id: 501, login: "alice", body: "Is this right?", path: "a.go", line: 3 }] },
      }),
    );
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const theirs = (await board()).tickets.find((ticket) => ticket.pr?.number === 7)!;
    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: theirs.id, path: "a.go", line: 3, side: "RIGHT", body: "Yes", target: "github", inReplyTo: "review-comment:501" });
    const result = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: theirs.id, postToGithub: true, reviewEvent: "APPROVE", address: false })) as { movedToDone: boolean; ticket: Ticket };
    expect(repliesPosted).toEqual([{ to: 501, body: "Yes" }]);
    expect(posted[0]).toMatchObject({ event: "APPROVE" });
    expect(result).toMatchObject({ movedToDone: true, ticket: { columnId: "done" } });
  });

  it("hides vendored files by default and never gives them a structural diff", async () => {
    const files = [
      { filename: "a.go", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n line\n-old\n+new\n+more" },
      { filename: "vendor/github.com/x/y/y.go", status: "added", additions: 400, deletions: 0, patch: "@@ -0,0 +1 @@\n+package y" },
      { filename: "web/node_modules/z/index.js", status: "modified", additions: 3, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
    ];
    const fetchMock = stubGithub({ requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })], files });
    vi.stubGlobal("fetch", fetchMock);
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const hidden = (await current().harness.behavior.callRpc("diff_get", { ticketId: card.id })) as TicketDiff;
    expect(hidden.files.map((file) => file.path)).toEqual(["a.go"]);
    expect(hidden.hiddenVendored).toEqual({ files: 2, additions: 403, deletions: 2 });

    const structural = (await current().harness.behavior.callRpc("diff_structural", { ticketId: card.id, path: "vendor/github.com/x/y/y.go" })) as StructuralDiff;
    expect(structural).toMatchObject({ available: false, reason: expect.stringContaining("Vendored") });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/contents/vendor"))).toBe(false);

    await current().harness.behavior.setSettings({ hideVendored: false });
    const shown = (await current().harness.behavior.callRpc("diff_get", { ticketId: card.id })) as TicketDiff;
    expect(shown.files.map((file) => [file.path, file.vendored])).toEqual([["a.go", false], ["vendor/github.com/x/y/y.go", true], ["web/node_modules/z/index.js", true]]);
    expect(shown.hiddenVendored).toBeNull();
  });

  it("only PR cards can target GitHub", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "Local work", projectId: "proj_acme", startThread: true })) as Ticket;
    expect(ticket).toMatchObject({ canPostToGithub: false, defaultCommentTarget: "local" });
    await expect(current().harness.behavior.callRpc("diff_comment_add", { ticketId: ticket.id, path: "x.ts", body: "Rename b", target: "github" })).rejects.toThrow(/Only PR cards/u);
  });

  it("diffs a thread-backed ad hoc card from its environment", async () => {
    await load();
    current().harness.sdk.stub("environments.get", async () => ({ id: "env_thr_1", mergeBaseBranch: "main" }));
    current().harness.sdk.stub("environments.diff", async (args: { target: string; mergeBaseBranch?: string }) => {
      expect(args).toMatchObject({ target: "all", mergeBaseBranch: "main" });
      return { outcome: "available", diff: { diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b", files: "x.ts", mergeBaseRef: "main", shortstat: "", truncated: false } };
    });
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "Local work", projectId: "proj_acme", startThread: true })) as Ticket;
    const diff = (await current().harness.behavior.callRpc("diff_get", { ticketId: ticket.id })) as TicketDiff;
    expect(diff.source).toBe("environment");
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({ path: "x.ts", additions: 1, deletions: 1 });

    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: ticket.id, path: "x.ts", body: "Rename b" });
    const result = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: ticket.id, address: true, push: false })) as { apply: CommentApply | null };
    expect(result.apply).not.toBeNull();
    // Applies in the card thread's own environment rather than a new worktree.
    expect(spawned[1]).toMatchObject({ environment: { type: "reuse", environmentId: "env_thr_1" } });
    expect(String(spawned[1]!.prompt)).toContain("Do NOT push");
  });
});

describe("diff comment threads", () => {
  const review = [
    { id: 10, login: "bob", body: "Rename this to `provisionAll`", path: "a.go", line: 12 },
    { id: 11, login: "sean", body: "Good call", path: "a.go", line: 12, replyTo: 10 },
    { id: 20, login: "bob", body: "Old side nit", path: "a.go", line: 4, side: "LEFT" as const },
    { id: 30, login: "carol", body: "This moved", path: "b.go", line: null, hunk: "@@ -1,2 +1,2 @@\n-old\n+new" },
  ];
  const ctx = (threadId: string) => ({ threadId, signal: new AbortController().signal });

  async function reviewCard(): Promise<Ticket> {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })], comments: { review }, resolvedThreads: [20] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    return (await board()).tickets[0]!;
  }
  const list = async (ticketId: string) => ((await current().harness.behavior.callRpc("diff_comments_list", { ticketId })) as { comments: DiffComment[] }).comments;

  it("syncs GitHub thread side, outdated and resolved state", async () => {
    const card = await reviewCard();
    const { comments } = (await current().harness.behavior.callRpc("comments_list", { ticketId: card.id })) as { comments: PrComment[] };
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    expect(byId.get("review-comment:10")).toMatchObject({ side: "RIGHT", outdated: false, resolved: false });
    expect(byId.get("review-comment:11")).toMatchObject({ inReplyTo: "review-comment:10", resolved: false });
    expect(byId.get("review-comment:20")).toMatchObject({ side: "LEFT", resolved: true });
    expect(byId.get("review-comment:30")).toMatchObject({ outdated: true, line: 1, diffHunk: "@@ -1,2 +1,2 @@\n-old\n+new", originalLine: 1 });
    expect(byId.get("review-comment:10")).toMatchObject({ diffHunk: null, originalLine: 12 });
  });

  it("keeps the review each inline comment was submitted in, for the conversation to group threads under", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 7)], comments: { review: [{ ...review[0]!, reviewId: 40 }, review[1]!] } }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const { comments } = (await current().harness.behavior.callRpc("comments_list", { ticketId: card.id })) as { comments: PrComment[] };
    expect(comments.map((comment) => [comment.id, comment.reviewId])).toEqual([
      ["review-comment:10", "review:40"],
      ["review-comment:11", null],
    ]);
  });

  it("writes in the PR's conversation: posts, edits, deletes and reacts on GitHub, then resyncs the comments", async () => {
    const fetchMock = stubGithub({ requested: [searchItem("acme-co/widgets", 7)] });
    vi.stubGlobal("fetch", fetchMock);
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const calls = () => fetchMock.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${String(input).replace("https://api.github.com", "").split("?")[0]}`);
    const before = calls().length;
    await current().harness.behavior.callRpc("pr_comment_post", { ticketId: card.id, body: "Looks good" });
    await current().harness.behavior.callRpc("pr_comment_edit", { ticketId: card.id, id: "issue-comment:5", body: "Looks great" });
    await current().harness.behavior.callRpc("pr_comment_edit", { ticketId: card.id, id: "pr:7", body: "Adds widgets, faster" });
    await current().harness.behavior.callRpc("pr_comment_delete", { ticketId: card.id, id: "issue-comment:5" });
    await current().harness.behavior.callRpc("pr_reaction_toggle", { ticketId: card.id, subject: "IC_5", content: "HEART", add: true });
    const writes = calls().slice(before).filter((call) => !call.startsWith("GET") && !call.endsWith("/graphql"));
    expect(writes).toEqual(["POST /repos/acme-co/widgets/issues/7/comments", "PATCH /repos/acme-co/widgets/issues/comments/5", "PATCH /repos/acme-co/widgets/pulls/7", "DELETE /repos/acme-co/widgets/issues/comments/5"]);
    const posted = fetchMock.mock.calls.find(([input, init]) => init?.method === "POST" && String(input).endsWith("/issues/7/comments"));
    expect(JSON.parse(String(posted![1]!.body))).toEqual({ body: "Looks good" });
    const reaction = fetchMock.mock.calls.find(([, init]) => String(init?.body ?? "").includes("addReaction("));
    expect(JSON.parse(String(reaction![1]!.body)).variables).toEqual({ subject: "IC_5", content: "HEART" });
    // Each change but the reaction pulls the comments again, so the board shows what GitHub now has.
    expect(calls().slice(before).filter((call) => call === "GET /repos/acme-co/widgets/issues/7/comments")).toHaveLength(4);
    await expect(current().harness.behavior.callRpc("pr_comment_delete", { ticketId: card.id, id: "review:40" })).rejects.toThrow(/Only a comment can be deleted/u);
  });

  it("reads the PR's conversation: its facts, description, submitted reviews, changes and badges, leaving out drafts", async () => {
    const meta = (extra: Record<string, unknown> = {}) => ({ authorAssociation: "NONE", lastEditedAt: null, isMinimized: false, minimizedReason: null, reactionGroups: [], ...extra });
    const actor = (id: string, at: string) => ({ id, createdAt: at, actor: { login: "jordan-rivera" } });
    const pr = {
      id: "PR_7", number: 7, state: "OPEN", isDraft: false, merged: false, url: "https://github.com/acme-co/widgets/pull/7", createdAt: "2026-10-04T09:00:00Z", body: "Adds widgets",
      ...meta({ authorAssociation: "MEMBER", lastEditedAt: "2026-10-04T09:30:00Z", reactionGroups: [{ content: "HEART", viewerHasReacted: true, reactors: { totalCount: 2 } }, { content: "EYES", viewerHasReacted: false, reactors: { totalCount: 0 } }] }),
      author: { login: "jordan-rivera" }, baseRefName: "main", headRefName: "widgets", commits: { totalCount: 2 },
      reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY",
      labels: { nodes: [{ name: "feature", color: "a2eeef" }] }, assignees: { nodes: [{ login: "jordan-rivera" }] }, milestone: null,
      closingIssuesReferences: { nodes: [{ number: 3, title: "Widgets", url: "https://github.com/acme-co/widgets/issues/3", state: "OPEN" }] },
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Team", name: "platform" } }] },
      latestReviews: { nodes: [{ author: { login: "alex" }, state: "CHANGES_REQUESTED" }] },
      headCommit: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [
        { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme-co/widgets/runs/1" },
        { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
        { __typename: "StatusContext", context: "deploy", state: "SUCCESS", targetUrl: null, description: "Preview ready" },
      ] } } } }] },
      timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { __typename: "PullRequestCommit", commit: { oid: "abc", signature: { isValid: true }, statusCheckRollup: { state: "SUCCESS" } } },
        { __typename: "IssueComment", id: "IC_5", databaseId: 5, ...meta({ isMinimized: true, minimizedReason: "OUTDATED" }) },
        { __typename: "PullRequestReview", id: "PRR_40", databaseId: 40, ...meta({ authorAssociation: "COLLABORATOR" }), state: "CHANGES_REQUESTED", body: "Please rename", submittedAt: "2026-10-05T12:00:00Z", url: "https://github.com/acme-co/widgets/pull/7#pullrequestreview-40", author: { login: "alex" } },
        { __typename: "PullRequestReview", databaseId: 41, ...meta(), state: "PENDING", body: "draft", submittedAt: null, url: "", author: { login: "sean" } },
        { __typename: "HeadRefForcePushedEvent", ...actor("E1", "2026-10-05T13:00:00Z"), beforeCommit: { oid: "1111111aaa" }, afterCommit: { oid: "2222222bbb" } },
        { __typename: "LabeledEvent", ...actor("E2", "2026-10-04T10:00:00Z"), label: { name: "feature", color: "a2eeef" } },
        { __typename: "CrossReferencedEvent", ...actor("E3", "2026-10-04T11:00:00Z"), source: { number: 9, title: "Use widgets", url: "https://github.com/acme-co/gadgets/pull/9", repository: { nameWithOwner: "acme-co/gadgets" } } },
        { __typename: "SubscribedEvent", id: "E4" },
      ] },
    };
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 7)], conversation: { pr, threadComments: [{ id: "PRRC_10", databaseId: 10, ...meta({ reactionGroups: [{ content: "THUMBS_UP", viewerHasReacted: false, reactors: { totalCount: 1 } }] }) }] } }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const data = (await current().harness.behavior.callRpc("pr_conversation", { ticketId: card.id })) as ConversationData;
    expect(data.pullRequest).toMatchObject({
      state: "open", author: "jordan-rivera", baseRef: "main", headRef: "widgets", commitCount: 2, labels: [{ name: "feature", color: "a2eeef" }], assignees: ["jordan-rivera"],
      linkedIssues: [{ number: 3, title: "Widgets", open: true }],
      reviewers: [{ name: "alex", state: "CHANGES_REQUESTED" }, { name: "platform", state: "REQUESTED" }],
      reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING", mergeState: "DIRTY",
      checks: { outcome: "failure", runs: [
        { name: "build", outcome: "failure", description: null, url: "https://github.com/acme-co/widgets/runs/1" },
        { name: "lint", outcome: "pending", description: null, url: null },
        { name: "deploy", outcome: "success", description: "Preview ready", url: null },
      ] },
    });
    expect(data.events).toEqual([
      { kind: "opened", id: "pr:7", author: "jordan-rivera", body: "Adds widgets", createdAt: "2026-10-04T09:00:00Z", url: "https://github.com/acme-co/widgets/pull/7" },
      { kind: "review", id: "review:40", author: "alex", mine: false, state: "CHANGES_REQUESTED", body: "Please rename", createdAt: "2026-10-05T12:00:00Z", url: "https://github.com/acme-co/widgets/pull/7#pullrequestreview-40" },
      { kind: "action", id: "E1", action: "force-pushed", actor: "jordan-rivera", detail: "1111111 to 2222222", createdAt: "2026-10-05T13:00:00Z", url: "https://github.com/acme-co/widgets/compare/1111111aaa..2222222bbb", color: null },
      { kind: "action", id: "E2", action: "labeled", actor: "jordan-rivera", detail: "feature", createdAt: "2026-10-04T10:00:00Z", url: null, color: "a2eeef" },
      { kind: "action", id: "E3", action: "cross-referenced", actor: "jordan-rivera", detail: "acme-co/gadgets#9 Use widgets", createdAt: "2026-10-04T11:00:00Z", url: "https://github.com/acme-co/gadgets/pull/9", color: null },
    ]);
    expect(data.comments).toEqual({
      "pr:7": { association: "MEMBER", edited: true, minimized: null, reactions: [{ content: "HEART", count: 2, mine: true }], subject: "PR_7" },
      "issue-comment:5": { association: null, edited: false, minimized: "OUTDATED", reactions: [], subject: "IC_5" },
      "review:40": { association: "COLLABORATOR", edited: false, minimized: null, reactions: [], subject: "PRR_40" },
      "review-comment:10": { association: null, edited: false, minimized: null, reactions: [{ content: "THUMBS_UP", count: 1, mine: false }], subject: "PRRC_10" },
    });
    expect(data.commits).toEqual({ abc: { verified: true, checks: "success" } });
    expect(data.viewer).toBe("sean");
    expect(data.threads).toEqual({ "review-comment:10": { resolvedBy: "alex" } });
  });

  it("resolves and reopens a GitHub review thread from any of its comments, marking the whole thread here", async () => {
    const card = await reviewCard();
    const resolved = (await current().harness.behavior.callRpc("comment_set_resolved", { id: "review-comment:11", resolved: true })) as PrComment;
    expect(resolved).toMatchObject({ id: "review-comment:11", resolved: true });
    expect(resolvedMutations).toEqual([{ rootId: 10, resolve: true }]);
    let { comments } = (await current().harness.behavior.callRpc("comments_list", { ticketId: card.id })) as { comments: PrComment[] };
    expect(comments.filter((comment) => comment.resolved === true).map((comment) => comment.id).sort()).toEqual(["review-comment:10", "review-comment:11", "review-comment:20"]);

    // A later sync agrees with GitHub, which the stub keeps in step with the mutation.
    await current().harness.behavior.callRpc("sync_now", null);
    ({ comments } = (await current().harness.behavior.callRpc("comments_list", { ticketId: card.id })) as { comments: PrComment[] });
    expect(comments.find((comment) => comment.id === "review-comment:10")?.resolved).toBe(true);

    await current().harness.behavior.callRpc("comment_set_resolved", { id: "review-comment:20", resolved: false });
    expect(resolvedMutations.at(-1)).toEqual({ rootId: 20, resolve: false });
    ({ comments } = (await current().harness.behavior.callRpc("comments_list", { ticketId: card.id })) as { comments: PrComment[] });
    expect(comments.find((comment) => comment.id === "review-comment:20")?.resolved).toBe(false);
  });

  it("replies in GitHub threads locally for the agent, with the thread as context, or on GitHub via the replies endpoint", async () => {
    const card = await reviewCard();
    const localReply = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "ignored", line: 1, body: "Do the rename, keep the old name as an alias", inReplyTo: "review-comment:11", target: "local" })) as DiffComment;
    // Replies to replies attach to the thread's root and take its location.
    expect(localReply).toMatchObject({ inReplyTo: "review-comment:10", path: "a.go", line: 12, side: "RIGHT", target: "local" });
    const githubReply = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", body: "Will do in this PR", inReplyTo: "review-comment:10", target: "github" })) as DiffComment;
    expect(githubReply.target).toBe("github");

    const result = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: false })) as { posted: number };
    expect(result.posted).toBe(1);
    expect(posted).toHaveLength(0);
    expect(repliesPosted).toEqual([{ to: 10, body: "Will do in this PR" }]);
    expect((await list(card.id)).find((comment) => comment.id === githubReply.id)).toMatchObject({ githubCommentId: "review-comment:7001" });

    // With no new threads a comment review is only posted to carry a summary.
    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", body: "Second thought: alias it", inReplyTo: "review-comment:10", target: "github" });
    await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, reviewBody: "Replied in the thread", address: false });
    expect(repliesPosted).toHaveLength(2);
    expect(posted).toEqual([{ event: "COMMENT", body: "Replied in the thread" }]);

    await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: false, address: true });
    const prompt = String(spawned[0]!.prompt);
    expect(prompt).toContain("(reply to review-comment:10)");
    expect(prompt).toContain("> **bob on GitHub:** Rename this to `provisionAll`");
    expect(prompt).toContain("> **sean on GitHub:** Good call");
    expect(prompt).toContain("Do the rename, keep the old name as an alias");

    const reply = await current().harness.behavior.runCli(["comment-reply", `local:${localReply.id}`, "Renamed", "and", "aliased"], ctx("thr_1"));
    expect(reply.exitCode).toBe(0);
    const agent = (await list(card.id)).find((comment) => comment.author === "agent");
    expect(agent).toMatchObject({ inReplyTo: "review-comment:10", body: "Renamed and aliased", authorThreadId: "thr_1", path: "a.go", line: 12 });
    expect((await board()).tickets[0]!.pendingDiffComments).toBe(0);
    await expect(current().harness.behavior.callRpc("diff_comment_update", { id: agent!.id, body: "edited" })).rejects.toThrow(/Agent replies/u);
    const unknown = await current().harness.behavior.runCli(["comment-reply", "local:nope", "x"], ctx("thr_1"));
    expect(unknown.exitCode).not.toBe(0);
  });

  it("links a posted draft to its synced copy when the read-back fails, so its reply still posts into the thread", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })],
        comments: { review: [{ id: 55, login: "sean", body: "Needs a test", path: "a.go", line: 3 }] },
        failReadBack: true,
      }),
    );
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const root = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 3, body: "Needs a test", target: "github" })) as DiffComment;
    const reply = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", body: "for empty input", inReplyTo: root.id, target: "github" })) as DiffComment;
    await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: false });
    expect(repliesPosted).toEqual([{ to: 55, body: "for empty input" }]);
    const after = await list(card.id);
    expect(after.find((comment) => comment.id === root.id)).toMatchObject({ githubCommentId: "review-comment:55" });
    expect(after.find((comment) => comment.id === reply.id)).toMatchObject({ inReplyTo: "review-comment:55", postedAt: expect.any(Number) });
    await expect(current().harness.behavior.callRpc("diff_comment_delete", { id: root.id })).rejects.toThrow(/already sent/u);
  });

  it("threads local comments, keeps GitHub replies out of local threads, and carries draft replies onto GitHub with their root", async () => {
    const card = await reviewCard();
    const root = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 2, body: "Extract this", target: "local" })) as DiffComment;
    const followUp = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", body: "…into its own file", inReplyTo: root.id })) as DiffComment;
    expect(followUp).toMatchObject({ inReplyTo: root.id, target: "local", line: 2 });
    await expect(current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", body: "x", inReplyTo: root.id, target: "github" })).rejects.toThrow(/local to the board/u);
    await expect(current().harness.behavior.callRpc("diff_comment_update", { id: followUp.id, target: "github" })).rejects.toThrow(/local to the board/u);

    // Deleting a root takes its replies with it.
    await current().harness.behavior.callRpc("diff_comment_delete", { id: root.id });
    expect(await list(card.id)).toHaveLength(0);

    const draftRoot = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 3, body: "Needs a test", target: "github" })) as DiffComment;
    const draftReply = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", body: "e.g. the empty input", inReplyTo: draftRoot.id, target: "github" })) as DiffComment;
    await expect(current().harness.behavior.callRpc("diff_comment_update", { id: draftRoot.id, target: "local" })).rejects.toThrow(/headed to GitHub/u);
    const result = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: false })) as { posted: number };
    expect(result.posted).toBe(2);
    expect(posted[0]!.comments).toEqual([{ path: "a.go", line: 3, side: "RIGHT", body: "Needs a test" }]);
    expect(repliesPosted).toEqual([{ to: 8000, body: "e.g. the empty input" }]);
    const after = await list(card.id);
    expect(after.find((comment) => comment.id === draftRoot.id)).toMatchObject({ githubCommentId: "review-comment:8000" });
    expect(after.find((comment) => comment.id === draftReply.id)).toMatchObject({ inReplyTo: "review-comment:8000", githubCommentId: "review-comment:7001" });
  });
});

describe("pending review staged on GitHub", () => {
  const rpc = (method: string, input: unknown) => current().harness.behavior.callRpc(method, input);
  const list = async (ticketId: string) => ((await rpc("diff_comments_list", { ticketId })) as { comments: DiffComment[] }).comments;
  const state = (ticketId: string) => rpc("pending_review_get", { ticketId }) as Promise<{ body: string; url: string | null; staged: number }>;
  /** Mirroring runs after the RPC returns, so assertions about GitHub wait for it. */
  async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("condition not met in time");
  }
  async function theirs(): Promise<Ticket> {
    await rpc("sync_now", null);
    return (await board()).tickets.find((ticket) => ticket.pr?.number === 7)!;
  }

  it("stages GitHub drafts into a pending review on GitHub as they are saved, edited, made local and deleted", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })], comments: { review: [{ id: 501, login: "alice", body: "Is this right?", path: "a.go", line: 3 }] } }));
    await load({ autoStartThreads: false, stageOnGithub: true });
    const card = await theirs();

    const draft = (await rpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 3, side: "RIGHT", body: "Use a constant", target: "github" })) as DiffComment;
    expect(draft.githubCommentId).toBeNull();
    await waitFor(async () => (await list(card.id)).find((comment) => comment.id === draft.id)?.githubCommentId !== null);
    // The pending review was created with the PR head, no event, and the draft went in as a thread.
    expect(ghPending.created[0]).toMatchObject({ commit_id: "9f3b2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c" });
    expect(ghPending.created[0]!.event).toBeUndefined();
    expect(ghPending.reviews[0]!.comments).toEqual([expect.objectContaining({ id: 9000, path: "a.go", line: 3, side: "RIGHT", body: "Use a constant" })]);
    expect((await list(card.id)).find((comment) => comment.id === draft.id)).toMatchObject({ githubCommentId: "review-comment:9000", postedUrl: expect.stringContaining("discussion_r9000"), postedAt: null, target: "github" });
    expect(await state(card.id)).toEqual({ body: "", url: expect.stringContaining("pullrequestreview-601"), staged: 1 });
    expect(posted).toHaveLength(0);

    await rpc("diff_comment_update", { id: draft.id, body: "Use a named constant" });
    await waitFor(() => ghPending.reviews[0]!.comments[0]!.body === "Use a named constant");

    const reply = (await rpc("diff_comment_add", { ticketId: card.id, path: "a.go", body: "Yes", inReplyTo: "review-comment:501", target: "github" })) as DiffComment;
    await waitFor(async () => (await list(card.id)).find((comment) => comment.id === reply.id)?.githubCommentId !== null);
    expect(ghPending.reviews[0]!.comments[1]).toMatchObject({ id: 9001, in_reply_to_id: 501, body: "Yes" });

    await rpc("pending_review_set_body", { ticketId: card.id, body: "Summary so far" });
    await waitFor(() => ghPending.reviews[0]!.body === "Summary so far");
    expect((await state(card.id)).body).toBe("Summary so far");

    // Made local: out of the pending review, and an ordinary board comment again.
    await rpc("diff_comment_update", { id: draft.id, target: "local" });
    await waitFor(() => !ghPending.reviews[0]!.comments.some((comment) => comment.id === 9000));
    expect((await list(card.id)).find((comment) => comment.id === draft.id)).toMatchObject({ target: "local", githubCommentId: null });
    await rpc("diff_comment_delete", { id: reply.id });
    await waitFor(() => ghPending.reviews[0]!.comments.length === 0);
    // The summary keeps the review alive; clearing it drops the now-empty review.
    expect(ghPending.reviews).toHaveLength(1);
    await rpc("pending_review_set_body", { ticketId: card.id, body: "" });
    await waitFor(() => ghPending.reviews.length === 0);
    expect(await state(card.id)).toEqual({ body: "", url: null, staged: 0 });
  });

  it("takes a staged root's replies with it, keeps pending comments out of the published sync, and submits a bodiless change request", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })], pending: { comments: [{ path: "a.go", line: 3, body: "From GitHub" }] } }));
    await load({ autoStartThreads: false, stageOnGithub: true });
    const card = await theirs();
    // Pending comments list as drafts here, never as published review comments.
    expect(((await rpc("comments_list", { ticketId: card.id })) as { comments: PrComment[] }).comments).toEqual([]);
    expect((await list(card.id)).map((comment) => comment.githubCommentId)).toEqual(["review-comment:9000"]);

    const root = (await rpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 2, body: "Root", target: "github" })) as DiffComment;
    const reply = (await rpc("diff_comment_add", { ticketId: card.id, path: "a.go", body: "Reply", inReplyTo: root.id, target: "github" })) as DiffComment;
    await waitFor(async () => (await list(card.id)).find((comment) => comment.id === reply.id)?.githubCommentId !== null);
    expect((await list(card.id)).find((comment) => comment.id === reply.id)).toMatchObject({ inReplyTo: "review-comment:9001", githubCommentId: "review-comment:9002" });
    await rpc("diff_comment_delete", { id: root.id });
    await waitFor(() => ghPending.reviews[0]!.comments.length === 1);
    expect((await list(card.id)).map((comment) => comment.githubCommentId)).toEqual(["review-comment:9000"]);

    await rpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, reviewEvent: "REQUEST_CHANGES", address: false });
    expect(events).toEqual([{ reviewId: 600, event: "REQUEST_CHANGES", body: "Requesting changes; see my comments in the review threads." }]);
  });

  it("pulls a pending review begun on GitHub, follows its changes there, and submits it from the board", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({ requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })], pending: { body: "Half done", comments: [{ path: "a.go", line: 3, body: "From GitHub" }] } }),
    );
    await load({ autoStartThreads: false, stageOnGithub: true });
    const card = await theirs();
    const imported = await list(card.id);
    expect(imported).toEqual([expect.objectContaining({ path: "a.go", line: 3, body: "From GitHub", target: "github", githubCommentId: "review-comment:9000", postedAt: null, author: null })]);
    expect(await state(card.id)).toEqual({ body: "Half done", url: expect.stringContaining("pullrequestreview-600"), staged: 1 });
    expect(card.pendingDiffComments).toBe(1);

    // Edited and extended on GitHub: the board follows.
    ghPending.reviews[0]!.comments[0]!.body = "From GitHub, edited";
    ghPending.reviews[0]!.comments.push({ id: 9500, path: "a.go", line: 2, side: "LEFT", start_line: null, start_side: null, body: "Second thought" });
    ghPending.reviews[0]!.body = "Half done, nearly";
    await rpc("sync_now", null);
    const followed = await list(card.id);
    expect(followed.map((comment) => [comment.body, comment.githubCommentId, comment.side])).toEqual([
      ["Second thought", "review-comment:9500", "LEFT"],
      ["From GitHub, edited", "review-comment:9000", "RIGHT"],
    ]);
    expect((await state(card.id)).body).toBe("Half done, nearly");

    // A summary edited here wins until it reaches GitHub; then GitHub's edits win again.
    await rpc("pending_review_set_body", { ticketId: card.id, body: "Mine" });
    await waitFor(() => ghPending.reviews[0]!.body === "Mine");
    ghPending.reviews[0]!.body = "Theirs";
    await rpc("sync_now", null);
    expect((await state(card.id)).body).toBe("Theirs");

    // Removed on GitHub: gone here too.
    ghPending.reviews[0]!.comments = ghPending.reviews[0]!.comments.filter((comment) => comment.id !== 9500);
    await rpc("sync_now", null);
    expect((await list(card.id)).map((comment) => comment.githubCommentId)).toEqual(["review-comment:9000"]);

    // A draft GitHub refuses inline stays here until the submit carries it in the body.
    const refused = (await rpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 99, body: "Off the diff", target: "github" })) as DiffComment;
    const added = (await rpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 3, body: "Added here", target: "github" })) as DiffComment;
    await waitFor(async () => (await list(card.id)).find((comment) => comment.id === added.id)?.githubCommentId !== null);
    expect((await list(card.id)).find((comment) => comment.id === refused.id)?.githubCommentId).toBeNull();

    const result = (await rpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, reviewEvent: "APPROVE", reviewBody: "LGTM", address: false })) as { posted: number; movedToDone: boolean; postedUrl: string | null };
    expect(events).toEqual([{ reviewId: 600, event: "APPROVE", body: "LGTM\n\n- `a.go:99` — Off the diff" }]);
    expect(posted).toHaveLength(0);
    expect(result).toMatchObject({ posted: 3, movedToDone: true, postedUrl: expect.stringContaining("pullrequestreview-600") });
    const after = await list(card.id);
    expect(after.every((comment) => comment.postedAt !== null)).toBe(true);
    expect(after.find((comment) => comment.id === refused.id)?.githubCommentId).toBe("review:600");
    expect(await state(card.id)).toEqual({ body: "", url: null, staged: 0 });
    expect((await board()).tickets.find((ticket) => ticket.id === card.id)).toMatchObject({ columnId: "done", pendingDiffComments: 0 });
  });

  it("places a pulled pending comment from its review thread when GitHub serves no record for it, and places one pulled before onto its line", async () => {
    const fetchStub = stubGithub({
      requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })],
      pending: { comments: [{ path: "a.go", line: 3, body: "Left on github.com" }, { path: "a.go", line: 8, side: "LEFT", start_line: 6, start_side: "LEFT", body: "On a range of the old side" }, { path: "a.go", line: null, body: "On the file" }] },
      pendingRecordsMissing: true,
    });
    vi.stubGlobal("fetch", fetchStub);
    await load({ autoStartThreads: false, stageOnGithub: true });
    const card = await theirs();
    const placed = (comments: DiffComment[]) => comments.map((comment) => [comment.body, comment.line, comment.side, comment.startLine, comment.startSide]).sort((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0));
    expect(placed(await list(card.id))).toEqual([
      ["On the file", null, "RIGHT", null, null],
      ["Left on github.com", 3, "RIGHT", null, null],
      ["On a range of the old side", 8, "LEFT", 6, "LEFT"],
    ]);
    // Placing came from the threads, not from the records GitHub does not serve.
    expect(fetchStub.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input)).filter((url) => /\/pulls\/comments\/\d+$/u.test(url))).toEqual([]);

    // A draft that was pulled before its place was known (its row has no line) is placed by the next pull.
    const [fileLevel] = (await list(card.id)).filter((comment) => comment.body === "On the file");
    ghPending.reviews[0]!.comments.find((comment) => comment.body === "On the file")!.line = 5;
    await rpc("sync_now", null);
    expect((await list(card.id)).find((comment) => comment.id === fileLevel!.id)).toMatchObject({ line: 5, side: "RIGHT" });
  });

  it("marks staged drafts posted when the review is submitted on GitHub, and keeps them as drafts when it is discarded there", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("acme-co/widgets", 7, { user: { login: "alice" } })], pending: { comments: [{ path: "a.go", line: 3, body: "From GitHub" }] } }));
    await load({ autoStartThreads: false, stageOnGithub: true });
    const card = await theirs();
    const mine = (await rpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 2, body: "From the board", target: "github" })) as DiffComment;
    await waitFor(async () => (await list(card.id)).find((comment) => comment.id === mine.id)?.githubCommentId !== null);

    ghPending.reviews[0]!.submitted = "COMMENT";
    await rpc("sync_now", null);
    const submitted = await list(card.id);
    expect(submitted.map((comment) => [comment.githubCommentId, comment.postedAt !== null])).toEqual([
      ["review-comment:9001", true],
      ["review-comment:9000", true],
    ]);
    expect(await state(card.id)).toEqual({ body: "", url: null, staged: 0 });
    // The synced copies now stand in for the drafts, as after a post from the board.
    const synced = ((await rpc("comments_list", { ticketId: card.id })) as { comments: PrComment[] }).comments;
    expect(synced.map((comment) => comment.id).sort()).toEqual(["review-comment:9000", "review-comment:9001"]);

    // Discarded on GitHub: the board keeps the words as plain drafts.
    ghPending.reviews = [];
    const again = (await rpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 2, body: "Once more", target: "github" })) as DiffComment;
    await waitFor(async () => (await list(card.id)).find((comment) => comment.id === again.id)?.githubCommentId !== null);
    expect(ghPending.reviews).toHaveLength(1);
    ghPending.reviews = [];
    await rpc("sync_now", null);
    expect((await list(card.id)).find((comment) => comment.id === again.id)).toMatchObject({ githubCommentId: null, postedAt: null, target: "github" });
    expect(await state(card.id)).toEqual({ body: "", url: null, staged: 0 });
  });
});

describe("subtasks", () => {
  const ctx = (threadId: string) => ({ threadId, signal: new AbortController().signal });

  it("nests cards, tracks progress, inherits the parent's project, and refuses cycles", async () => {
    await load();
    const parent = (await current().harness.behavior.callRpc("ticket_create", { title: "Epic", projectId: "proj_acme" })) as Ticket;
    const a = (await current().harness.behavior.callRpc("ticket_create", { title: "Part A", parentId: parent.id })) as Ticket;
    const b = (await current().harness.behavior.callRpc("ticket_create", { title: "Part B", parentId: parent.id })) as Ticket;
    expect(a).toMatchObject({ parentId: parent.id, projectId: "proj_acme" });
    let fresh = (await board()).tickets.find((ticket) => ticket.id === parent.id)!;
    expect(fresh.children).toEqual({ total: 2, done: 0, withThread: 0 });

    await current().harness.behavior.callRpc("ticket_move", { id: a.id, columnId: "done" });
    fresh = (await board()).tickets.find((ticket) => ticket.id === parent.id)!;
    expect(fresh.children.done).toBe(1);

    await expect(current().harness.behavior.callRpc("ticket_set_parent", { id: parent.id, parentId: b.id })).rejects.toThrow(/nested inside itself/u);
    await expect(current().harness.behavior.callRpc("ticket_set_parent", { id: a.id, parentId: a.id })).rejects.toThrow(/nested inside itself/u);
    const moved = (await current().harness.behavior.callRpc("ticket_set_parent", { id: b.id, parentId: null })) as Ticket;
    expect(moved.parentId).toBeNull();

    const cli = await current().harness.behavior.runCli(["add", "Part C", "--parent", parent.id, "--json"], ctx("thr_other"));
    const c = JSON.parse(cli.stdout ?? "") as Ticket;
    expect(c).toMatchObject({ parentId: parent.id, threadId: null });
    const list = await current().harness.behavior.runCli(["subtasks", "--ticket", parent.id]);
    expect(list.stdout).toContain("Part A");
    expect(list.stdout).toContain("Part C");
    expect(list.stdout).not.toContain("Part B");
    const top = await current().harness.behavior.runCli(["list", "--parent", "none", "--json"]);
    expect((JSON.parse(top.stdout ?? "") as Ticket[]).map((ticket) => ticket.title).sort()).toEqual(["Epic", "Part B"]);

    await current().harness.behavior.callRpc("ticket_delete", { id: parent.id });
    expect((await board()).tickets.find((ticket) => ticket.id === a.id)?.parentId).toBeNull();
    await current().harness.behavior.callRpc("ticket_set_parent", { id: c.id, parentId: b.id });
    await current().harness.behavior.callRpc("ticket_restore", { id: parent.id });
    const restored = (await board()).tickets;
    expect(restored.find((ticket) => ticket.id === a.id)?.parentId).toBe(parent.id);
    expect(restored.find((ticket) => ticket.id === c.id)?.parentId).toBe(b.id);
  });

  it("starts one thread per open subtask under the parent's thread, or one sequential thread", async () => {
    await load();
    const parent = (await current().harness.behavior.callRpc("ticket_create", { title: "Epic", projectId: "proj_acme", startThread: true })) as Ticket;
    expect(parent.threadId).toBe("thr_1");
    const a = (await current().harness.behavior.callRpc("ticket_create", { title: "Part A", parentId: parent.id })) as Ticket;
    const b = (await current().harness.behavior.callRpc("ticket_create", { title: "Part B", parentId: parent.id })) as Ticket;
    const done = (await current().harness.behavior.callRpc("ticket_create", { title: "Done part", parentId: parent.id, columnId: "done" })) as Ticket;
    void done;

    const result = (await current().harness.behavior.callRpc("ticket_start_children", { id: parent.id })) as { started: number; skipped: number };
    expect(result).toMatchObject({ started: 2, skipped: 0 });
    expect(spawned.slice(1).map((args) => args.title)).toEqual(["Part A", "Part B"]);
    expect(spawned[1]).toMatchObject({ parentThreadId: "thr_1", projectId: "proj_acme", pluginMetadata: { ticketId: a.id } });
    expect(String(spawned[1]!.prompt)).toContain('subtask of "Epic"');
    expect((await board()).tickets.find((ticket) => ticket.id === b.id)?.threadId).toBe("thr_3");

    const again = (await current().harness.behavior.callRpc("ticket_start_children", { id: parent.id })) as { started: number; skipped: number };
    expect(again).toMatchObject({ started: 0, skipped: 2 });

    // Sequential mode sends the plan into the parent's existing thread instead of spawning.
    current().harness.sdk.stub("threads.send", async () => ({ ok: true }));
    await current().harness.behavior.callRpc("ticket_start_children", { id: parent.id, mode: "sequential" });
    const sent = current().harness.inspection.sdk.callsTo("threads.send");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("bb kanban subtasks --ticket");
    expect(JSON.stringify(sent[0])).toContain("Part");

    const configured = await current().harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { ticketId: a.id } }),
    );
    expect(configured?.instructions).toContain("subtask of");
  });

  it("asks an agent to break a card down, in its own thread when it has none", async () => {
    await load();
    const card = (await current().harness.behavior.callRpc("ticket_create", { title: "Big feature", description: "Do many things", projectId: "proj_acme" })) as Ticket;
    const updated = (await current().harness.behavior.callRpc("ticket_breakdown", { id: card.id, guidance: "keep the migration separate" })) as Ticket;
    expect(updated.threadId).toBe("thr_1");
    const prompt = String(spawned[0]!.prompt);
    expect(prompt).toContain(`bb kanban add "<title>" --parent ${card.id}`);
    expect(prompt).toContain("keep the migration separate");
    expect(prompt).toContain("Do many things");
    expect(spawned[0]).toMatchObject({ pluginMetadata: { ticketId: card.id, role: "breakdown" } });
    await expect(current().harness.behavior.callRpc("ticket_start_children", { id: card.id })).rejects.toThrow(/No open subtasks/u);
  });
});

describe("brain dumps", () => {
  const proposalBlock = (tickets: unknown[], questions: unknown[] = []) =>
    `Here is a plan.\n\n\`\`\`json kanban-proposal\n${JSON.stringify({ version: 1, summary: "Two pieces of work.", tickets, questions })}\n\`\`\``;

  it("parses proposals and ignores malformed ones", () => {
    expect(parseProposal(proposalBlock([{ id: "T1", title: "Do X" }]))?.tickets[0]).toMatchObject({ id: "T1", title: "Do X", tags: [], subtasks: [], estimate: null });
    expect(parseProposal("no block")).toBeNull();
    expect(parseProposal("```json kanban-proposal\n{\"version\":1}\n```")).toBeNull();
  });

  it("plans in a background thread, captures the proposal, refines with answers, and creates cards", async () => {
    await load();
    current().harness.sdk.stub("threads.send", async () => ({ ok: true }));
    current().harness.sdk.stub("threads.archive", async () => ({ archived: 1 }));
    const dump = (await current().harness.behavior.callRpc("dump_create", { text: "Move billing to the payments service.\nAlso fix the stale invoices view.", projectId: "proj_acme" })) as Dump;
    expect(dump).toMatchObject({ status: "planning", threadId: "thr_1", projectId: "proj_acme" });
    expect(spawned[0]).toMatchObject({ projectId: "proj_acme", title: "Plan: Move billing to the payments service.", pluginMetadata: { dumpId: dump.id, role: "plan" } });
    expect(String(spawned[0]!.prompt)).toContain("json kanban-proposal");
    expect(String(spawned[0]!.prompt)).toContain("stale invoices");
    expect((await board()).dumps.map((entry) => entry.id)).toEqual([dump.id]);

    const configured = await current().harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { dumpId: dump.id, role: "plan" } }),
    );
    expect(configured?.instructions).toContain("kanban-proposal");

    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_acme" }),
      lastAssistantText: proposalBlock(
        [
          { id: "T1", title: "Charge via payments service", description: "Replace billing call", tags: ["backend"], subtasks: [{ title: "Add client" }, { title: "Wire payments" }], estimate: "M" },
          { id: "T2", title: "Hide stale invoices", tags: ["frontend"], dependsOn: ["T1"] },
        ],
        [{ id: "Q1", question: "Keep the old billing path as fallback?", affects: ["T1"], options: ["yes", "no"] }],
      ),
    });
    let fresh = (await board()).dumps[0]!;
    expect(fresh.status).toBe("ready");
    expect(fresh.proposal?.tickets).toHaveLength(2);
    expect(fresh.proposal?.questions[0]).toMatchObject({ id: "Q1", options: ["yes", "no"] });

    const refined = (await current().harness.behavior.callRpc("dump_refine", { id: dump.id, answers: { Q1: "no" }, notes: "Ship T2 first." })) as Dump;
    expect(refined.status).toBe("planning");
    expect(refined.answers).toEqual({ Q1: "no" });
    const sent = current().harness.inspection.sdk.callsTo("threads.send");
    expect(JSON.stringify(sent[0])).toContain("Q1 (Keep the old billing path as fallback?): no");
    expect(JSON.stringify(sent[0])).toContain("Ship T2 first.");
    await expect(current().harness.behavior.callRpc("dump_refine", { id: dump.id })).rejects.toThrow(/still working/u);

    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_acme" }),
      lastAssistantText: proposalBlock([{ id: "T1", title: "Charge via payments service", subtasks: [{ title: "Add client" }] }, { id: "T2", title: "Hide stale invoices" }]),
    });
    fresh = (await board()).dumps[0]!;
    expect(fresh.status).toBe("ready");
    expect(fresh.proposal?.questions).toEqual([]);

    const result = (await current().harness.behavior.callRpc("dump_finalize", {
      id: dump.id,
      tickets: [{ id: "T1", title: "Charge via payments service (edited)", description: "d", tags: ["backend"], subtasks: [{ title: "Add client", description: "" }], dependsOn: [], estimate: null }],
      columnId: "todo",
    })) as { dump: Dump; tickets: Ticket[] };
    expect(result.dump.status).toBe("done");
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]).toMatchObject({ title: "Charge via payments service (edited)", columnId: "todo", projectId: "proj_acme", tags: ["backend"], children: { total: 1 } });
    expect(current().harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect((await board()).dumps).toEqual([]);
    const all = (await current().harness.behavior.callRpc("dumps_list", { includeClosed: true })) as { dumps: Dump[] };
    expect(all.dumps[0]!.createdTicketIds).toEqual([result.tickets[0]!.id]);
  });

  it("marks a dump failed when the thread ends without a proposal, and discard archives the thread", async () => {
    await load();
    current().harness.sdk.stub("threads.archive", async () => ({ archived: 1 }));
    const dump = (await current().harness.behavior.callRpc("dump_create", { text: "stuff", projectId: "proj_acme" })) as Dump;
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_acme" }),
      lastAssistantText: "I need more information before I can plan.",
    });
    const failed = (await board()).dumps[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("without a kanban-proposal block");
    const discarded = (await current().harness.behavior.callRpc("dump_discard", { id: dump.id })) as Dump;
    expect(discarded.status).toBe("discarded");
    expect(current().harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
  });
});

describe("delta ranges", () => {
  it("turns a unified patch into new-side line ranges, including the insertion point of pure deletions", () => {
    const patch = ["@@ -10,4 +10,5 @@ ctx", " a", "-b", "+B", "+B2", " c", " d", "@@ -40,3 +41,2 @@", " x", "-y", " z"].join("\n");
    expect(newLineRangesFromPatch(patch)).toEqual([
      [11, 12],
      [42, 42],
    ]);
  });
});

describe("change tour", () => {
  it("spawns one tour thread per head, parses its kanban-narrative block, and marks a moved head stale", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 7, { user: { login: "sean" } })] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const first = (await current().harness.behavior.callRpc("narrative_generate", { ticketId: card.id })) as Narrative;
    expect(first.status).toBe("running");
    expect(spawned.at(-1)).toMatchObject({ visibility: "hidden", pluginMetadata: { role: "narrative" } });
    expect(String(spawned.at(-1)!.prompt)).toContain("kanban-narrative");
    expect(String(spawned.at(-1)!.prompt)).toContain("a.go");
    // A second request while one is running returns the running tour instead of spawning again.
    const again = (await current().harness.behavior.callRpc("narrative_generate", { ticketId: card.id })) as Narrative;
    expect(again.id).toBe(first.id);
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: first.threadId, projectId: "proj_acme" }),
      lastAssistantText: [
        "Here is the tour.",
        "```json kanban-narrative",
        JSON.stringify({ version: 1, summary: "Adds `add`.", readingOrder: [{ path: "a.go", role: "key", note: "The new function.", lines: [2] }], watchOut: ["No tests."] }),
        "```",
      ].join("\n"),
    });
    const got = (await current().harness.behavior.callRpc("narrative_get", { ticketId: card.id })) as { narrative: Narrative | null; stale: boolean };
    expect(got.stale).toBe(false);
    expect(got.narrative).toMatchObject({ status: "completed", headSha: "9f3b2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c" });
    expect(got.narrative!.report).toMatchObject({ summary: "Adds `add`.", readingOrder: [{ path: "a.go", role: "key", lines: [2] }], watchOut: ["No tests."] });
    expect(parseNarrative("no block here")).toBeNull();
  });
});

describe("narrative review", () => {
  it("snapshots the diff, checks coverage from the CLI, and writes a revision chapter over the delta once the head moves", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    let head = "9f3b2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c";
    let files: unknown[] = [{ filename: "a.go", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n line\n-old\n+new\n+more" }];
    const compares: string[] = [];
    const base = stubGithub({ authored: [searchItem("acme-co/widgets", 7, { user: { login: "sean" } })] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/compare/")) {
          compares.push(url.slice(url.indexOf("/compare/") + "/compare/".length));
          return json({ files: [
            { filename: "a.go", status: "modified", patch: "@@ -2,2 +2,2 @@\n-new\n+newer\n more" },
            { filename: "base-only.go", status: "modified", patch: "@@ -1 +1 @@\n-x\n+y" },
          ] });
        }
        if (/\/pulls\/7\/files/u.test(url)) return json(files);
        if (/\/pulls\/7$/u.test(url)) {
          const pull = (await (await base(input, init)).json()) as Record<string, unknown>;
          return json({ ...pull, head: { sha: head } });
        }
        return base(input, init);
      }),
    );
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const cli = (args: string[], threadId: string) => current().harness.behavior.runCli(args, { threadId, signal: new AbortController().signal });

    // Two presses before the first spawn lands start one thread.
    const [first, twin] = (await Promise.all([
      current().harness.behavior.callRpc("narrative_generate", { ticketId: card.id }),
      current().harness.behavior.callRpc("narrative_generate", { ticketId: card.id }),
    ])) as [Narrative, Narrative];
    expect(twin.id).toBe(first.id);
    expect(spawned.filter((args) => (args.pluginMetadata as { role?: string } | undefined)?.role === "narrative")).toHaveLength(1);
    const firstPrompt = String(spawned.at(-1)!.prompt);
    expect(firstPrompt).toContain("narrative-review skill");
    expect(firstPrompt).toContain("narrative-check");
    expect(firstPrompt).toContain("bullets with bold lead-ins");
    expect(firstPrompt).toContain("Prefer a ```mermaid diagram to prose");
    expect(firstPrompt).toContain("tight bullet list of the high-level changes");
    expect(firstPrompt).toContain("asd-ste100 skill in STE-flavored mode");
    expect(firstPrompt).not.toContain("revision");

    const partial = { version: 2, summary: "Adds `more`.", steps: [{ id: "more", title: "Adds more", body: "```mermaid\nflowchart LR\n  a --> b\n```", refs: [{ path: "a.go", side: "new", startLine: 2, endLine: 3 }] }] };
    const gaps = await cli(["narrative-check", "--report", JSON.stringify(partial)], first.threadId);
    expect(gaps.exitCode).toBe(1);
    expect(gaps.stdout).toContain("a.go: old 2–2");
    expect(gaps.stdout).toContain("-2 old");
    const complete = { ...partial, steps: [...partial.steps, { id: "old-gone", title: "Drops old", refs: [{ path: "a.go", side: "old", startLine: 2, endLine: 2 }] }] };
    const passed = await cli(["narrative-check", "--report", JSON.stringify(complete)], first.threadId);
    expect(passed).toMatchObject({ exitCode: 0 });
    expect(passed.stdout).toContain("Every changed line is covered.");

    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: first.threadId, projectId: "proj_acme" }),
      lastAssistantText: ["Done.", "```json kanban-narrative", JSON.stringify(complete), "```"].join("\n"),
    });
    let story = (await current().harness.behavior.callRpc("narrative_story", { ticketId: card.id })) as NarrativeStory;
    expect(story.stale).toBe(false);
    expect(story.revisions).toHaveLength(1);
    expect(story.revisions[0]).toMatchObject({ head, previousId: null, delta: null, files: [{ path: "a.go" }] });
    expect(story.revisions[0]!.narrative.report!.steps.map((step) => step.id)).toEqual(["more", "old-gone"]);
    // The first narrative has nothing earlier to revise.
    expect(String((await cli(["narrative-context"], first.threadId)).stdout)).toContain("no earlier narrative");

    head = "2222222222222222222222222222222222222222";
    files = [{ filename: "a.go", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n line\n-old\n+newer\n+more" }];
    await current().harness.behavior.callRpc("diff_get", { ticketId: card.id, refresh: true });
    story = (await current().harness.behavior.callRpc("narrative_story", { ticketId: card.id })) as NarrativeStory;
    expect(story.stale).toBe(true);

    const second = (await current().harness.behavior.callRpc("narrative_generate", { ticketId: card.id })) as Narrative;
    // Leaving out the diff's reads of the PR's merge base.
    expect(compares.filter((compare) => !compare.endsWith("?per_page=1"))).toEqual([`9f3b2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c...${head}`]);
    const secondPrompt = String(spawned.at(-1)!.prompt);
    expect(secondPrompt).toContain("`revision` chapter");
    expect(secondPrompt).toContain("git fetch origin 9f3b2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c");
    const context = String((await cli(["narrative-context"], second.threadId)).stdout);
    expect(context).toContain('"id": "more"');
    expect(context).toContain("+newer");
    // Only files the change itself touches; the base branch's edits stay out.
    expect(context).not.toContain("base-only.go");

    const noRevision = await cli(["narrative-check", "--report", JSON.stringify(complete)], second.threadId);
    expect(noRevision.exitCode).toBe(1);
    expect(noRevision.stdout).toContain("add the `revision` chapter");
    const revised = {
      ...complete,
      revision: { summary: "Renames new to newer.", steps: [{ id: "rename", title: "new becomes newer", refs: [{ path: "a.go", side: "old", startLine: 2, endLine: 2 }, { path: "a.go", side: "new", startLine: 2, endLine: 2 }], affects: ["more", "ghost"] }] },
    };
    const revisedCheck = await cli(["narrative-check", "--report", JSON.stringify(revised)], second.threadId);
    expect(revisedCheck.exitCode).toBe(0);
    expect(revisedCheck.stdout).toContain("Delta: 2/2 changed lines covered.");
    expect(revisedCheck.stdout).toContain("unknown step id ghost");

    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: second.threadId, projectId: "proj_acme" }),
      lastAssistantText: ["```json kanban-narrative", JSON.stringify(revised), "```"].join("\n"),
    });
    story = (await current().harness.behavior.callRpc("narrative_story", { ticketId: card.id })) as NarrativeStory;
    expect(story.stale).toBe(false);
    expect(story.revisions.map((revision) => revision.narrative.id)).toEqual([first.id, second.id]);
    expect(story.revisions[1]).toMatchObject({ head, previousId: first.id, delta: { fromHead: "9f3b2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c", toHead: head, files: [{ path: "a.go" }] } });
    expect(story.revisions[1]!.narrative.report!.revision!.summary).toBe("Renames new to newer.");
  });
});

describe("narrative review of a local card", () => {
  it("keys narratives to the checkout's HEAD and measures the delta from it, uncommitted and untracked files included", async () => {
    const repo = await mkdtemp(join(tmpdir(), "kanban-narrative-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(repo, "a.go"), "package a\n\nfunc one() {}\n");
    git("add", ".");
    git("commit", "-qm", "one");
    const firstHead = git("rev-parse", "HEAD");
    let patch = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,3 +1,3 @@\n package a\n \n-func one() {}\n+func one() {}\n";
    await load({ autoStartThreads: false });
    current().harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
    current().harness.sdk.stub("environments.get", async () => ({ id: "env_thr_1", path: repo, hostId: "host_1", mergeBaseBranch: null }));
    current().harness.sdk.stub("environments.diff", async () => ({ outcome: "available", diff: { diff: patch, mergeBaseRef: null, truncated: false } }));
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "Local work", projectId: "proj_acme", startThread: true })) as Ticket;
    const first = (await current().harness.behavior.callRpc("narrative_generate", { ticketId: ticket.id })) as Narrative;
    const report = { version: 2, summary: "s", steps: [{ id: "one", title: "one", refs: [{ path: "a.go", side: "new", startLine: null }] }] };
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: first.threadId, projectId: "proj_acme" }),
      lastAssistantText: ["```json kanban-narrative", JSON.stringify(report), "```"].join("\n"),
    });

    await writeFile(join(repo, "a.go"), "package a\n\nfunc two() {}\n");
    await writeFile(join(repo, "new.go"), "package a\n");
    patch += "diff --git a/new.go b/new.go\nnew file mode 100644\n--- /dev/null\n+++ b/new.go\n@@ -0,0 +1 @@\n+package a\n";
    const second = (await current().harness.behavior.callRpc("narrative_generate", { ticketId: ticket.id })) as Narrative;
    expect(String(spawned.at(-1)!.prompt)).toContain(`git log ${firstHead}..HEAD`);
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: second.threadId, projectId: "proj_acme" }),
      lastAssistantText: ["```json kanban-narrative", JSON.stringify({ ...report, revision: { summary: "r", steps: [] } }), "```"].join("\n"),
    });
    const story = (await current().harness.behavior.callRpc("narrative_story", { ticketId: ticket.id })) as NarrativeStory;
    expect(story.revisions.map((revision) => [revision.head, revision.dirty])).toEqual([[firstHead, false], [firstHead, true]]);
    const delta = story.revisions[1]!.delta!;
    expect(delta.fromHead).toBe(firstHead);
    expect(delta.files.map((file) => file.path)).toEqual(["a.go", "new.go"]);
    expect(delta.files[0]!.patch).toContain("+func two() {}");
    await rm(repo, { recursive: true, force: true });
  });
});

describe("structural diff and symbols", () => {
  it("reports a clear reason when difftastic is not installed and still returns both file sides", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("acme-co/widgets", 7, { user: { login: "sean" } })],
        contents: { "a.go@1111111111111111111111111111111111111111": "package a\nfunc old() {}\n", "a.go@9f3b2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c": "package a\nfunc add() {}\n" },
      }),
    );
    await load({ autoStartThreads: false, difftPath: "/definitely/not/difft" });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const result = (await current().harness.behavior.callRpc("diff_structural", { ticketId: card.id, path: "a.go" })) as StructuralDiff;
    expect(result.available).toBe(false);
    expect(result.reason).toContain("brew install difftastic");
    expect(result.oldText).toContain("func old()");
    expect(result.newText).toContain("func add()");
    await expect(current().harness.behavior.callRpc("diff_structural", { ticketId: card.id, path: "nope.go" })).rejects.toThrow(/not in this card's diff/u);
  });

  it("finds definitions with git grep in a thread's local checkout (POSIX regex, Go/TS/Python shapes)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "kanban-symbols-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await writeFile(join(repo, "a.go"), "package a\n\nfunc add(a, b int) int { return a + b }\n\nfunc (s *Svc) add() {}\n\ntype addRequest struct{}\n");
    await writeFile(join(repo, "b.ts"), "export async function add(a: number) {}\nconst addition = 1;\n");
    await writeFile(join(repo, "c.py"), "def add(self):\n    pass\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
    await load();
    current().harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
    current().harness.sdk.stub("environments.get", async () => ({ id: "env_thr_1", path: repo, hostId: "host_1", mergeBaseBranch: null }));
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "Local work", projectId: "proj_acme", startThread: true })) as Ticket;
    const lookup = (await current().harness.behavior.callRpc("symbol_definitions", { ticketId: ticket.id, symbol: "add" })) as SymbolLookup;
    expect(lookup.searched).toBe("workspace");
    expect(lookup.open).toEqual({ kind: "environment", environmentId: "env_thr_1" });
    expect(lookup.definitions.map((definition) => `${definition.path}:${definition.line}`)).toEqual(["a.go:3", "a.go:5", "b.ts:1", "c.py:1"]);
    await rm(repo, { recursive: true, force: true });
  });

  it("falls back to GitHub code search for symbol definitions when no local checkout exists", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("acme-co/widgets", 7, { user: { login: "sean" } })],
        codeSearch: [{ path: "internal/x/add.go", fragment: "package x\nfunc add(a, b int) int {\n\treturn a + b\n}" }],
      }),
    );
    await load({ autoStartThreads: false });
    current().harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const lookup = (await current().harness.behavior.callRpc("symbol_definitions", { ticketId: card.id, symbol: "add" })) as SymbolLookup;
    expect(lookup.searched).toBe("github");
    expect(lookup.open).toEqual({ kind: "github", repo: "acme-co/widgets", sha: "9f3b2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c" });
    expect(lookup.definitions[0]).toMatchObject({ path: "internal/x/add.go", line: null, snippet: "func add(a, b int) int {" });
  });
});

describe("columns", () => {
  it("moves cards from removed columns to the first column", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "A", columnId: "review" })) as Ticket;
    await current().harness.behavior.callRpc("columns_set", {
      columns: [
        { id: "todo", name: "To Do" },
        { id: "doing", name: "Doing" },
        { id: "done", name: "Done" },
      ],
    });
    const next = await board();
    expect(next.columns.map((column) => column.id)).toEqual(["todo", "doing", "done"]);
    expect(next.tickets.find((entry) => entry.id === ticket.id)?.columnId).toBe("todo");
  });
});
