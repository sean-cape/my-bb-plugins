import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { adfToText, defaultSelected, githubRepoFromRemote, newLineRangesFromPatch, parseNarrative, parseProposal, parseReviewReport, splitUnifiedDiff, type Board, type CodeReviewThread, type CommentApply, type DiffComment, type Dump, type Finding, type Narrative, type PrComment, type Review, type StructuralDiff, type SymbolLookup, type Ticket, type TicketDiff } from "./server";

type Host = ReturnType<typeof createFakePluginHost>;

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
    review?: Array<{ id: number; login: string; body: string; path: string; line: number | null; side?: "LEFT" | "RIGHT"; startLine?: number; replyTo?: number }>;
    reviews?: Array<{ id: number; login: string; body: string; state: string; submitted?: boolean }>;
  };
  /** Root review-comment ids of resolved threads, answered from the GraphQL reviewThreads query. */
  resolvedThreads?: number[];
  failReadBack?: boolean;
}) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
      const roots = new Set(options.resolvedThreads ?? []);
      const nodes = (options.comments?.review ?? [])
        .filter((comment) => comment.replyTo === undefined)
        .map((comment) => ({ isResolved: roots.has(comment.id), comments: { nodes: [{ databaseId: comment.id }] } }));
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
    }
    if (method === "POST" && /\/pulls\/\d+\/reviews$/u.test(url)) {
      const body = JSON.parse(String(init?.body ?? (await (input as Request).text()))) as { comments?: Array<{ path: string; body: string }>; body?: string };
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
      return json(
        (options.comments?.review ?? []).map((comment) => ({
          id: comment.id, user: { login: comment.login }, body: comment.body, path: comment.path, line: comment.line, original_line: comment.line ?? 1, side: comment.side ?? "RIGHT",
          ...(comment.replyTo === undefined ? {} : { in_reply_to_id: comment.replyTo }),
          ...(comment.startLine === undefined
            ? { start_line: null, original_start_line: null, start_side: null }
            : { start_line: comment.line === null ? null : comment.startLine, original_start_line: comment.startLine, start_side: comment.side ?? "RIGHT" }),
          html_url: `https://github.com/${reviewComments[1]}/pull/${reviewComments[2]}#discussion_r${comment.id}`,
          created_at: "2026-10-05T11:00:00Z", updated_at: "2026-10-05T11:00:00Z",
        })),
      );
    }
    const reviews = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews/u.exec(url);
    if (reviews !== null) {
      return json(
        (options.comments?.reviews ?? []).map((review) => ({
          id: review.id, user: { login: review.login }, body: review.body, state: review.state,
          html_url: `https://github.com/${reviews[1]}/pull/${reviews[2]}#pullrequestreview-${review.id}`,
          ...(review.submitted === false ? {} : { submitted_at: "2026-10-05T12:00:00Z" }),
        })),
      );
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
let posted: Array<{ comments?: Array<{ path: string; body: string }>; body?: string }> = [];
let repliesPosted: Array<{ to: number; body: string }> = [];
let host: Host | null = null;

async function load(settings: Record<string, string | number | boolean> = {}) {
  spawned = [];
  threadOutputs.clear();
  posted = [];
  repliesPosted = [];
  host = createFakePluginHost({
    pluginId: "kanban",
    agentSkillIds: ["kanban"],
    settings: { githubToken: "tok", ...settings },
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
          makeThreadResponse({ id: threadId, projectId: "proj_acme", environmentId: `env_${threadId}` }),
        updatePluginMetadata: async () => ({}),
        output: async ({ threadId }: { threadId: string }) => ({ output: threadOutputs.get(threadId) ?? null }),
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
    expect(move.stdout).toContain("[In Progress]");

    const show = await current().harness.behavior.runCli(["show", "--json"], {
      threadId: "thr_9",
      signal: new AbortController().signal,
    });
    expect((JSON.parse(show.stdout ?? "") as Ticket).columnId).toBe("in-progress");
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

  it("does not override a manual column for a PR that is still open", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("acme-co/widgets", 1)] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const [ticket] = (await board()).tickets;
    await current().harness.behavior.callRpc("ticket_move", { id: ticket!.id, columnId: "backlog" });
    await current().harness.behavior.callRpc("sync_now", null);
    expect((await board()).tickets[0]!.columnId).toBe("backlog");
  });

  it("reports a missing token without throwing", async () => {
    vi.stubGlobal("fetch", stubGithub({}));
    await load({ githubToken: "" });
    // `gh auth token` is not available in the test environment, so the plugin
    // records the error on the sync status instead of crashing.
    const status = (await current().harness.behavior.callRpc("sync_now", null)) as Board["sync"];
    if (status.lastError !== null) {
      expect(status.lastError).toContain("No GitHub token");
      expect(status.tokenSource).toBe("none");
    } else {
      expect(status.tokenSource).toBe("gh-cli");
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
      parentThreadId: "thr_1",
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

  it("refuses to review a card without a PR and asks for a project when none matches", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("other/repo", 1)] }));
    await load({ autoStartThreads: false, autoCreateProjects: false });
    const adhoc = (await current().harness.behavior.callRpc("ticket_create", { title: "A" })) as Ticket;
    await expect(current().harness.behavior.callRpc("ticket_review_pr", { id: adhoc.id })).rejects.toThrow(/Only PR cards/u);

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

    const applied = (await current().harness.behavior.callRpc("review_apply", { ticketId: card.id, autoApprove: true })) as Ticket;
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
    expect(prompt).toContain("just apply all of it, don't ask");
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

    await current().harness.behavior.callRpc("review_apply", { ticketId: card.id, autoApprove: true });
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
    await expect(current().harness.behavior.callRpc("review_apply", { ticketId: card.id })).rejects.toThrow(/No findings are selected/u);
    ({ reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] });
    expect(reviews[0]!.selectionOverrides).toEqual({ F1: false });
  });

  it("asks for confirmation by default and deletes reviews with the card", async () => {
    const card = await reviewedCard();
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_acme" }),
      lastAssistantText: `findings\nReviewed commit: ${sha}`,
    });
    await current().harness.behavior.callRpc("review_apply", { ticketId: card.id });
    expect(String(spawned[2]!.prompt)).toContain("wait for the user's go-ahead");

    await current().harness.behavior.callRpc("ticket_delete", { id: card.id });
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews).toEqual([]);
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
    expect(prompt).toContain("wait for the user's go-ahead");

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
    const result = (await current().harness.behavior.callRpc("comments_apply", { ticketId: card.id, autoApprove: true, push: true })) as { apply: CommentApply };
    const prompt = String(spawned[0]!.prompt);
    expect(prompt).toContain('git push origin HEAD:refs/heads/"$HEAD_REF"');
    expect(prompt).toContain("--pushed");
    expect(prompt).toContain("just apply all of it");
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

    const toAgent = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: false, address: true, autoApprove: true })) as { posted: number; apply: CommentApply | null };
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
    const toAgent = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: false, address: true, autoApprove: true })) as { apply: CommentApply | null };
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
    const result = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: false })) as { posted: number; apply: CommentApply | null };
    expect(result).toMatchObject({ posted: 1, apply: null });
    expect(posted).toHaveLength(2);
    expect(posted[1]!.comments).toBeUndefined();
    expect(String(posted[1]!.body)).toContain("a.go:99");
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
    await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: theirs.id, postToGithub: true, reviewEvent: "APPROVE", address: false });
    expect(posted[0]).toMatchObject({ event: "APPROVE", comments: [{ path: "a.go", body: "Looks good" }] });

    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: mine.id, path: "a.go", line: 3, side: "LEFT", body: "Note to self", target: "github" });
    await expect(current().harness.behavior.callRpc("diff_comments_submit", { ticketId: mine.id, postToGithub: true, reviewEvent: "REQUEST_CHANGES", address: false })).rejects.toThrow(/your own pull request/u);
    expect(posted).toHaveLength(1);
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
    { id: 30, login: "carol", body: "This moved", path: "b.go", line: null },
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
    expect(byId.get("review-comment:30")).toMatchObject({ outdated: true, line: 1 });
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
