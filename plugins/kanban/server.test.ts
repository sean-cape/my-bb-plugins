import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { adfToText, defaultSelected, githubRepoFromRemote, parseProposal, parseReviewReport, splitUnifiedDiff, type Board, type CommentApply, type DiffComment, type Dump, type Finding, type PrComment, type Review, type StructuralDiff, type SymbolLookup, type Ticket, type TicketDiff } from "./server";

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
    review?: Array<{ id: number; login: string; body: string; path: string; line: number | null; replyTo?: number }>;
    reviews?: Array<{ id: number; login: string; body: string; state: string; submitted?: boolean }>;
  };
}) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://cape.atlassian.net/")) {
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
    if (method === "POST" && /\/pulls\/\d+\/reviews$/u.test(url)) {
      const body = JSON.parse(String(init?.body ?? (await (input as Request).text()))) as { comments?: unknown[]; body?: string };
      posted.push(body);
      if (options.rejectInline && (body.comments?.length ?? 0) > 0) return new Response("Unprocessable", { status: 422 });
      return json({ id: 900 + posted.length, html_url: `https://github.com/cape-co/cape/pull/7#pullrequestreview-${900 + posted.length}` });
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
          id: comment.id, user: { login: comment.login }, body: comment.body, path: comment.path, line: comment.line, original_line: comment.line ?? 1,
          ...(comment.replyTo === undefined ? {} : { in_reply_to_id: comment.replyTo }),
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
        head: { sha: "4c934cd4730c5004c7118a873e102b0b60fcc41f" },
      });
    }
    return new Response("unexpected", { status: 500 });
  });
}

let spawned: Array<Record<string, unknown>>;
let posted: Array<{ comments?: unknown[]; body?: string }> = [];
let host: Host | null = null;

async function load(settings: Record<string, string | number | boolean> = {}) {
  spawned = [];
  posted = [];
  host = createFakePluginHost({
    pluginId: "kanban",
    agentSkillIds: ["kanban"],
    settings: { githubToken: "tok", ...settings },
    sdk: {
      projects: {
        list: async () => [
          {
            id: "proj_cape",
            name: "cape",
            kind: "standard",
            gitRemoteUrl: "git@github.com:cape-co/cape.git",
            sources: [
              {
                id: "src_1",
                projectId: "proj_cape",
                hostId: "host_1",
                isDefault: true,
                path: "/Users/me/cape",
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
          makeThreadResponse({ id: threadId, projectId: "proj_cape", environmentId: `env_${threadId}` }),
        updatePluginMetadata: async () => ({}),
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
    expect(githubRepoFromRemote("git@github.com:Cape-Co/Cape.git")).toBe("cape-co/cape");
    expect(githubRepoFromRemote("https://github.com/cape-co/cape")).toBe("cape-co/cape");
    expect(githubRepoFromRemote("https://github.com/cape-co/cape.git/")).toBe("cape-co/cape");
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

  it("spawns a thread with the ticket id in plugin metadata when asked", async () => {
    await load();
    const ticket = (await current().harness.behavior.callRpc("ticket_create", {
      title: "Ship it",
      description: "Do the thing",
      projectId: "proj_cape",
      startThread: true,
    })) as Ticket;
    expect(ticket.threadId).toBe("thr_1");
    expect(spawned[0]).toMatchObject({
      projectId: "proj_cape",
      environment: { type: "project-default" },
      title: "Ship it",
      pluginMetadata: { ticketId: ticket.id },
    });
    expect(String(spawned[0]!.prompt)).toContain("Do the thing");
    expect(String(spawned[0]!.prompt)).toContain("bb kanban move");
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
        searchItem("cape-co/cape", 1, { title: "Add thing", user: { login: "sean" } }),
        searchItem("cape-co/cape", 2, { title: "WIP", draft: true, user: { login: "sean" } }),
        searchItem("other/repo", 3, { title: "Elsewhere", user: { login: "sean" } }),
      ],
      requested: [searchItem("cape-co/cape", 4, { title: "Please review", user: { login: "alice" } })],
    });
    vi.stubGlobal("fetch", fetchMock);
    await load();
    await current().harness.behavior.callRpc("sync_now", null);

    const { tickets, sync } = await board();
    const byNumber = new Map(tickets.map((ticket) => [ticket.pr?.number, ticket]));
    expect(sync.login).toBe("sean");
    expect(sync.lastError).toBeNull();
    expect(byNumber.get(1)).toMatchObject({ columnId: "todo", kind: "pr", projectId: "proj_cape" });
    expect(byNumber.get(2)).toMatchObject({ columnId: "todo", pr: { state: "draft" } });
    expect(byNumber.get(4)).toMatchObject({ columnId: "todo", tags: ["pr-reviews"], sourceId: "pr-reviews", pr: { role: "other", author: "alice" } });
    expect(byNumber.get(1)).toMatchObject({ tags: ["my-prs"], sourceId: "my-prs" });
    // No project matches other/repo and no fallback project is set: card without a thread.
    expect(byNumber.get(3)).toMatchObject({ projectId: null, threadId: null });

    expect(spawned).toHaveLength(3);
    const titles = spawned.map((args) => String(args.title));
    expect(titles).toContain("cape#1: Add thing");
    const reviewPrompt = spawned.find((args) => String(args.title).startsWith("cape#4"));
    expect(String(reviewPrompt?.prompt)).toContain("gh pr diff 4 --repo cape-co/cape");
    const ownPrompt = spawned.find((args) => String(args.title).startsWith("cape#1"));
    expect(String(ownPrompt?.prompt)).toContain("tracks your pull request");
    expect(String(reviewPrompt?.prompt)).toContain("Do not post comments");
  });

  it("is idempotent and moves merged, closed, and reviewed PRs to done", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("cape-co/cape", 1), searchItem("cape-co/cape", 2)],
        requested: [searchItem("cape-co/cape", 4)],
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
          "cape-co/cape#1": { state: "closed", merged: true },
          "cape-co/cape#2": { state: "closed", merged: false },
          "cape-co/cape#4": { state: "open", merged: false },
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
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("cape-co/cape", 1)] }));
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
      projectId: "proj_cape",
      startThread: true,
    })) as Ticket;
    const thread = makeThreadResponse({ id: ticket.threadId!, projectId: "proj_cape" });

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
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("cape-co/cape", 7, { title: "Refactor" })] }));
    await load();
    await current().harness.behavior.callRpc("sync_now", null);
    const [card] = (await board()).tickets;
    expect(card!.threadId).toBe("thr_1");

    const reviewed = (await current().harness.behavior.callRpc("ticket_review_pr", { id: card!.id })) as Ticket;
    expect(reviewed.reviewThreadId).toBe("thr_2");
    expect(spawned[1]).toMatchObject({
      projectId: "proj_cape",
      environment: {
        type: "host",
        hostId: "host_1",
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
      parentThreadId: "thr_1",
      title: "Review cape#7: Refactor",
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
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_cape" }),
    });
    // The persisted review (and its thread reference) survives deletion of the thread.
    expect((await board()).tickets[0]!.latestReview).toMatchObject({ threadId: "thr_2" });
  });

  it("refuses to review a card without a PR and asks for a project when none matches", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("other/repo", 1)] }));
    await load({ autoStartThreads: false });
    const adhoc = (await current().harness.behavior.callRpc("ticket_create", { title: "A" })) as Ticket;
    await expect(current().harness.behavior.callRpc("ticket_review_pr", { id: adhoc.id })).rejects.toThrow(/Only PR cards/u);

    await current().harness.behavior.callRpc("sync_now", null);
    const pr = (await board()).tickets.find((ticket) => ticket.pr !== null)!;
    await expect(current().harness.behavior.callRpc("ticket_review_pr", { id: pr.id })).rejects.toThrow(/No project matches/u);
    const reviewed = (await current().harness.behavior.callRpc("ticket_review_pr", { id: pr.id, projectId: "proj_cape" })) as Ticket;
    expect(reviewed.reviewThreadId).toBe("thr_1");
  });

  it("starts a review from the CLI using the thread's card", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("cape-co/cape", 7)] }));
    await load();
    await current().harness.behavior.callRpc("sync_now", null);
    const result = await current().harness.behavior.runCli(["review"], { threadId: "thr_1", signal: new AbortController().signal });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("@thread:thr_2");
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
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("cape-co/cape", 7, { title: "Refactor" })] }));
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
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_cape" }),
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
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_cape" }),
      lastAssistantText: "Sure, here is more detail.",
    });
    const again = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(again.reviews[0]!.body).toBe(findings);
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
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_cape" }),
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
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_cape" }),
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
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_cape" }),
      lastAssistantText: `## Review Findings\n\nnone\n\nReviewed commit: ${sha}`,
    });
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews[0]!.commitSha).toBe(sha);
  });

  it("re-reviews only the commits since the last reviewed sha, or everything when asked", async () => {
    const card = await reviewedCard();
    await current().harness.behavior.runCli(["review-record", "--commit", sha], ctx("thr_2"));
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_cape" }),
      lastAssistantText: "findings",
    });

    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id });
    expect(String(spawned[2]!.title)).toContain("Re-review cape#7");
    expect(String(spawned[2]!.prompt)).toContain(`${sha}..HEAD`);
    expect(String(spawned[2]!.prompt)).toContain(`previous review covered commit ${sha}`);
    const { reviews } = (await current().harness.behavior.callRpc("review_list", { ticketId: card.id })) as { reviews: Review[] };
    expect(reviews[0]).toMatchObject({ status: "running", sinceCommitSha: sha });

    await current().harness.behavior.callRpc("ticket_review_pr", { id: card.id, mode: "full" });
    expect(String(spawned[3]!.prompt)).toContain("origin/$BASE...HEAD");
    expect(String(spawned[3]!.prompt)).not.toContain(`${sha}..HEAD`);
  });

  it("applies a completed review in the review thread's worktree and records the push", async () => {
    const card = await reviewedCard();
    await expect(current().harness.behavior.callRpc("review_apply", { ticketId: card.id })).rejects.toThrow(/No completed review/u);

    await current().harness.behavior.runCli(["review-record", "--commit", sha, "--head", "feature/refactor"], ctx("thr_2"));
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_cape" }),
      lastAssistantText: "## Review Findings\n- a.go:1 fix me",
    });

    const applied = (await current().harness.behavior.callRpc("review_apply", { ticketId: card.id, autoApprove: true })) as Ticket;
    expect(applied.latestReview?.apply).toMatchObject({ threadId: "thr_3", completedAt: null });
    expect(spawned[2]).toMatchObject({
      projectId: "proj_cape",
      environment: { type: "reuse", environmentId: "env_thr_2" },
      parentThreadId: "thr_1",
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
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_cape" }),
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
      thread: makeThreadResponse({ id: "thr_2", projectId: "proj_cape" }),
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

  it("ships the two GitHub sources by default and applies every matching source's tags", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("cape-co/cape", 1, { user: { login: "sean" } })],
        requested: [searchItem("cape-co/cape", 1, { user: { login: "sean" } })],
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
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("cape-co/cape", 1, { user: { login: "sean" } })] }));
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
    vi.stubGlobal("fetch", stubGithub({ authored: [], pulls: { "cape-co/cape#1": { state: "open", merged: false } } }));
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
  const jiraSettings = { jiraSiteUrl: "https://cape.atlassian.net/", jiraEmail: "sean@cape.co", jiraApiToken: "jt" };
  const jiraSource = {
    id: "my-jira",
    name: "My Jira",
    kind: "jira-jql" as const,
    jql: "assignee = currentUser() AND statusCategory != Done",
    tags: ["jira"],
    doneWhenGone: false,
    enabled: true,
    projectId: "proj_cape",
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
          { key: "CAPE-1", summary: "Fix HSS", category: "new", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Details here" }] }] } },
          { key: "CAPE-2", summary: "In flight", category: "indeterminate", status: "In Progress", priority: "High" },
        ],
      }),
    );
    await load({ ...jiraSettings, autoStartThreads: true });
    await current().harness.behavior.callRpc("sources_set", { sources: [jiraSource] });
    // sources_set kicks a sync asynchronously; call explicitly for a deterministic assertion.
    await current().harness.behavior.callRpc("sync_now", null);
    const { tickets, sync } = await board();
    expect(sync.jiraSite).toBe("https://cape.atlassian.net");
    expect(sync.lastError).toBeNull();
    const byKey = new Map(tickets.map((ticket) => [ticket.jira?.key, ticket]));
    expect(byKey.get("CAPE-1")).toMatchObject({
      kind: "jira",
      columnId: "todo",
      tags: ["jira"],
      sourceId: "my-jira",
      projectId: "proj_cape",
      description: "Details here",
      jira: { url: "https://cape.atlassian.net/browse/CAPE-1", status: "To Do", statusCategory: "new", issueType: "Task", assignee: "Sean" },
    });
    expect(byKey.get("CAPE-2")).toMatchObject({ columnId: "in-progress", jira: { priority: "High", statusCategory: "indeterminate" } });
    const spawnedJira = spawned.find((args) => String(args.title).startsWith("CAPE-1"));
    expect(String(spawnedJira?.prompt)).toContain("Jira issue CAPE-1");
    expect(String(spawnedJira?.prompt)).toContain("Details here");

    // CAPE-2 leaves the search and is now Done in Jira; CAPE-1 is done while still in the search.
    vi.stubGlobal(
      "fetch",
      stubGithub({
        jira: [{ key: "CAPE-1", summary: "Fix HSS", category: "done", status: "Done" }],
        jiraIssues: { "CAPE-2": { key: "CAPE-2", summary: "In flight", category: "done", status: "Done" } },
      }),
    );
    await current().harness.behavior.callRpc("sync_now", null);
    const after = new Map((await board()).tickets.map((ticket) => [ticket.jira?.key, ticket]));
    expect(after.get("CAPE-1")).toMatchObject({ columnId: "done", jira: { status: "Done" } });
    expect(after.get("CAPE-2")).toMatchObject({ columnId: "done", jira: { statusCategory: "done" } });
    const list = await current().harness.behavior.runCli(["list", "--tag", "jira"]);
    expect(list.stdout).toContain("CAPE-1 (Done)");
    const cli = await current().harness.behavior.runCli(["sources"]);
    expect(cli.stdout).toContain("[jira-jql] assignee = currentUser()");
  });

  it("reports missing Jira settings and per-source failures without blocking GitHub sources", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("cape-co/cape", 1, { user: { login: "sean" } })] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sources_set", { sources: [...((await board()).sources), jiraSource] });
    const status = (await current().harness.behavior.callRpc("sync_now", null)) as Board["sync"];
    expect(status.lastError).toContain("Jira sources need");
    expect((await board()).tickets.some((ticket) => ticket.kind === "pr")).toBe(true);

    vi.stubGlobal("fetch", stubGithub({ authored: [], jiraFail: true, pulls: { "cape-co/cape#1": { state: "open", merged: false } } }));
    await current().harness.behavior.setSettings(jiraSettings);
    const failed = (await current().harness.behavior.callRpc("sync_now", null)) as Board["sync"];
    expect(failed.lastError).toContain("My Jira: Jira 500");
    expect(failed.jiraSite).toBe("https://cape.atlassian.net");
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
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("cape-co/cape", 7, { title: "Refactor", user: { login: "sean" } })], comments }));
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
    const fetchMock = vi.fn(stubGithub({ authored: [searchItem("cape-co/cape", 7, { user: { login: "sean" } })], comments: { issue: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    await current().harness.behavior.callRpc("sync_now", null);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/issues/7/comments"))).toBe(false);
    expect((await board()).tickets[0]!.comments?.total).toBe(5);
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("cape-co/cape", 7, { user: { login: "sean" }, updated_at: "2026-10-06T00:00:00Z" })], comments: { issue: [comments.issue[0]!] } }));
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
    expect(spawned[0]).toMatchObject({ pluginMetadata: { ticketId: card.id, role: "apply-comments" } });
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

  it("serves the PR diff from GitHub and leaves comments that submit to GitHub and an address thread", async () => {
    vi.stubGlobal("fetch", stubGithub({ requested: [searchItem("cape-co/cape", 7, { title: "Refactor", user: { login: "alice" } })] }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    expect(card.canPostToGithub).toBe(true);

    const diff = (await current().harness.behavior.callRpc("diff_get", { ticketId: card.id })) as TicketDiff;
    expect(diff.source).toBe("pr");
    expect(diff.baseRef).toBe("main");
    expect(diff.files.map((file) => [file.path, file.patch === null])).toEqual([["a.go", false], ["img.png", true]]);

    const c1 = (await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 2, side: "LEFT", body: "Use a constant here" })) as DiffComment;
    expect(c1.side).toBe("LEFT");
    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "img.png", body: "Do we need this asset?" });
    expect((await board()).tickets[0]!.pendingDiffComments).toBe(2);
    await current().harness.behavior.callRpc("diff_comment_update", { id: c1.id, body: "Use a named constant here", line: 3 });

    const result = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: true, autoApprove: true })) as {
      posted: number;
      postedUrl: string | null;
      apply: CommentApply | null;
    };
    expect(result.posted).toBe(2);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ event: "COMMENT", commit_id: "4c934cd4730c5004c7118a873e102b0b60fcc41f", comments: [{ path: "a.go", line: 3, side: "LEFT", body: "Use a named constant here" }] });
    expect(String(posted[0]!.body)).toContain("img.png");
    expect(result.apply?.commentIds).toEqual([`local:${c1.id}`, expect.stringMatching(/^local:/u)]);
    const prompt = String(spawned[0]!.prompt);
    expect(prompt).toContain("`apply-pr-comments` skill");
    expect(prompt).toContain("left on the Kanban diff view");
    expect(prompt).toContain("(On removed line 3 of the old file.) Use a named constant here");

    const { comments } = (await current().harness.behavior.callRpc("diff_comments_list", { ticketId: card.id })) as { comments: DiffComment[] };
    expect(comments.every((comment) => comment.postedAt !== null && comment.applyId === result.apply?.id)).toBe(true);
    expect((await board()).tickets[0]!.pendingDiffComments).toBe(0);
    await expect(current().harness.behavior.callRpc("diff_comment_update", { id: c1.id, body: "x" })).rejects.toThrow(/already submitted/u);

    await current().harness.behavior.runCli(["comments-applied", "--commit", "abc1234", "--pushed"], { threadId: "thr_1", signal: new AbortController().signal });
    const after = (await current().harness.behavior.callRpc("diff_comments_list", { ticketId: card.id })) as { comments: DiffComment[] };
    expect(after.comments.every((comment) => comment.addressedAt !== null)).toBe(true);
  });

  it("refuses to post to GitHub without the review tag and falls back to a body-only review on 422", async () => {
    vi.stubGlobal("fetch", stubGithub({ authored: [searchItem("cape-co/cape", 7, { user: { login: "sean" } })], rejectInline: true }));
    await load({ autoStartThreads: false });
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    expect(card.canPostToGithub).toBe(false);
    await current().harness.behavior.callRpc("diff_comment_add", { ticketId: card.id, path: "a.go", line: 99, body: "Off the diff" });
    await expect(current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: false })).rejects.toThrow(/review tag/u);

    await current().harness.behavior.callRpc("ticket_set_tags", { id: card.id, tags: ["my-prs", "pr-reviews"] });
    const result = (await current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: true, address: false })) as { posted: number; apply: CommentApply | null };
    expect(result.posted).toBe(1);
    expect(result.apply).toBeNull();
    expect(posted).toHaveLength(2);
    expect(posted[1]!.comments).toBeUndefined();
    expect(String(posted[1]!.body)).toContain("a.go:99");
    await expect(current().harness.behavior.callRpc("diff_comments_submit", { ticketId: card.id, postToGithub: false, address: false })).rejects.toThrow();
  });

  it("diffs a thread-backed ad hoc card from its environment", async () => {
    await load();
    current().harness.sdk.stub("environments.get", async () => ({ id: "env_thr_1", mergeBaseBranch: "main" }));
    current().harness.sdk.stub("environments.diff", async (args: { target: string; mergeBaseBranch?: string }) => {
      expect(args).toMatchObject({ target: "all", mergeBaseBranch: "main" });
      return { outcome: "available", diff: { diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b", files: "x.ts", mergeBaseRef: "main", shortstat: "", truncated: false } };
    });
    const ticket = (await current().harness.behavior.callRpc("ticket_create", { title: "Local work", projectId: "proj_cape", startThread: true })) as Ticket;
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

describe("subtasks", () => {
  const ctx = (threadId: string) => ({ threadId, signal: new AbortController().signal });

  it("nests cards, tracks progress, inherits the parent's project, and refuses cycles", async () => {
    await load();
    const parent = (await current().harness.behavior.callRpc("ticket_create", { title: "Epic", projectId: "proj_cape" })) as Ticket;
    const a = (await current().harness.behavior.callRpc("ticket_create", { title: "Part A", parentId: parent.id })) as Ticket;
    const b = (await current().harness.behavior.callRpc("ticket_create", { title: "Part B", parentId: parent.id })) as Ticket;
    expect(a).toMatchObject({ parentId: parent.id, projectId: "proj_cape" });
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
    const parent = (await current().harness.behavior.callRpc("ticket_create", { title: "Epic", projectId: "proj_cape", startThread: true })) as Ticket;
    expect(parent.threadId).toBe("thr_1");
    const a = (await current().harness.behavior.callRpc("ticket_create", { title: "Part A", parentId: parent.id })) as Ticket;
    const b = (await current().harness.behavior.callRpc("ticket_create", { title: "Part B", parentId: parent.id })) as Ticket;
    const done = (await current().harness.behavior.callRpc("ticket_create", { title: "Done part", parentId: parent.id, columnId: "done" })) as Ticket;
    void done;

    const result = (await current().harness.behavior.callRpc("ticket_start_children", { id: parent.id })) as { started: number; skipped: number };
    expect(result).toMatchObject({ started: 2, skipped: 0 });
    expect(spawned.slice(1).map((args) => args.title)).toEqual(["Part A", "Part B"]);
    expect(spawned[1]).toMatchObject({ parentThreadId: "thr_1", projectId: "proj_cape", pluginMetadata: { ticketId: a.id } });
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
    const card = (await current().harness.behavior.callRpc("ticket_create", { title: "Big feature", description: "Do many things", projectId: "proj_cape" })) as Ticket;
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
    const dump = (await current().harness.behavior.callRpc("dump_create", { text: "Move HSS provisioning to sim service.\nAlso fix the deactivated lines view.", projectId: "proj_cape" })) as Dump;
    expect(dump).toMatchObject({ status: "planning", threadId: "thr_1", projectId: "proj_cape" });
    expect(spawned[0]).toMatchObject({ projectId: "proj_cape", title: "Plan: Move HSS provisioning to sim service.", pluginMetadata: { dumpId: dump.id, role: "plan" } });
    expect(String(spawned[0]!.prompt)).toContain("json kanban-proposal");
    expect(String(spawned[0]!.prompt)).toContain("deactivated lines");
    expect((await board()).dumps.map((entry) => entry.id)).toEqual([dump.id]);

    const configured = await current().harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { dumpId: dump.id, role: "plan" } }),
    );
    expect(configured?.instructions).toContain("kanban-proposal");

    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_cape" }),
      lastAssistantText: proposalBlock(
        [
          { id: "T1", title: "Provision via sim service", description: "Replace HSS call", tags: ["backend"], subtasks: [{ title: "Add client" }, { title: "Wire provisioning" }], estimate: "M" },
          { id: "T2", title: "Hide deactivated lines", tags: ["frontend"], dependsOn: ["T1"] },
        ],
        [{ id: "Q1", question: "Keep the old HSS path as fallback?", affects: ["T1"], options: ["yes", "no"] }],
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
    expect(JSON.stringify(sent[0])).toContain("Q1 (Keep the old HSS path as fallback?): no");
    expect(JSON.stringify(sent[0])).toContain("Ship T2 first.");
    await expect(current().harness.behavior.callRpc("dump_refine", { id: dump.id })).rejects.toThrow(/still working/u);

    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_cape" }),
      lastAssistantText: proposalBlock([{ id: "T1", title: "Provision via sim service", subtasks: [{ title: "Add client" }] }, { id: "T2", title: "Hide deactivated lines" }]),
    });
    fresh = (await board()).dumps[0]!;
    expect(fresh.status).toBe("ready");
    expect(fresh.proposal?.questions).toEqual([]);

    const result = (await current().harness.behavior.callRpc("dump_finalize", {
      id: dump.id,
      tickets: [{ id: "T1", title: "Provision via sim service (edited)", description: "d", tags: ["backend"], subtasks: [{ title: "Add client", description: "" }], dependsOn: [], estimate: null }],
      columnId: "todo",
    })) as { dump: Dump; tickets: Ticket[] };
    expect(result.dump.status).toBe("done");
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]).toMatchObject({ title: "Provision via sim service (edited)", columnId: "todo", projectId: "proj_cape", tags: ["backend"], children: { total: 1 } });
    expect(current().harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect((await board()).dumps).toEqual([]);
    const all = (await current().harness.behavior.callRpc("dumps_list", { includeClosed: true })) as { dumps: Dump[] };
    expect(all.dumps[0]!.createdTicketIds).toEqual([result.tickets[0]!.id]);
  });

  it("marks a dump failed when the thread ends without a proposal, and discard archives the thread", async () => {
    await load();
    current().harness.sdk.stub("threads.archive", async () => ({ archived: 1 }));
    const dump = (await current().harness.behavior.callRpc("dump_create", { text: "stuff", projectId: "proj_cape" })) as Dump;
    await current().harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_cape" }),
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

describe("structural diff and symbols", () => {
  it("reports a clear reason when difftastic is not installed and still returns both file sides", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("cape-co/cape", 7, { user: { login: "sean" } })],
        contents: { "a.go@1111111111111111111111111111111111111111": "package a\nfunc old() {}\n", "a.go@4c934cd4730c5004c7118a873e102b0b60fcc41f": "package a\nfunc add() {}\n" },
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

  it("falls back to GitHub code search for symbol definitions when no local checkout exists", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithub({
        authored: [searchItem("cape-co/cape", 7, { user: { login: "sean" } })],
        codeSearch: [{ path: "internal/x/add.go", fragment: "package x\nfunc add(a, b int) int {\n\treturn a + b\n}" }],
      }),
    );
    await load({ autoStartThreads: false });
    current().harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
    await current().harness.behavior.callRpc("sync_now", null);
    const card = (await board()).tickets[0]!;
    const lookup = (await current().harness.behavior.callRpc("symbol_definitions", { ticketId: card.id, symbol: "add" })) as SymbolLookup;
    expect(lookup.searched).toBe("github");
    expect(lookup.open).toEqual({ kind: "github", repo: "cape-co/cape", sha: "4c934cd4730c5004c7118a873e102b0b60fcc41f" });
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
