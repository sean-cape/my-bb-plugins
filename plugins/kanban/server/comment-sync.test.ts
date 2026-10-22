import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPrComments } from "./comments/pr-comments";
import type { KanbanContext } from "./context";
import { migrate } from "./db/migrations";
import { prepareStatements } from "./db/statements";

interface StubReviewComment {
  id: number;
  body: string;
  line: number | null;
  diff_hunk?: string;
  original_line?: number;
  original_start_line?: number | null;
  start_line?: number | null;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** A PR's comments on GitHub as each read of `/pulls/7/comments` finds them; a read may wait on a gate. */
function stubComments(reads: Array<{ comments: StubReviewComment[]; gate?: Promise<void> }>) {
  let served = 0;
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/widgets/pulls/7/comments") {
      const read = reads[Math.min(served++, reads.length - 1)]!;
      await read.gate;
      return json(
        read.comments.map((comment) => ({
          user: { login: "ada" },
          path: "a.ts",
          side: "RIGHT",
          start_side: comment.start_line == null && comment.original_start_line == null ? null : "RIGHT",
          html_url: `https://github.com/acme/widgets/pull/7#discussion_r${comment.id}`,
          created_at: "2026-10-05T11:00:00Z",
          updated_at: "2026-10-05T11:00:00Z",
          ...comment,
        })),
      );
    }
    if (url.pathname === "/graphql") return new Response("no", { status: 500 });
    return json([]);
  });
  vi.stubGlobal("fetch", fetch);
  return { reads: () => served };
}

function setup(card: { prState?: string; syncedFor?: string | null } = {}) {
  const { bb } = createFakePluginHost({ pluginId: "kanban" });
  const db = bb.storage.database();
  migrate(bb, db);
  const stmts = prepareStatements(db);
  db.prepare(
    `INSERT INTO tickets (id, title, column_id, kind, pr_repo, pr_number, pr_state, pr_updated_at, comments_synced_for, position, created_at, updated_at)
     VALUES ('t1', 'PR 7', 'done', 'pr', 'acme/widgets', 7, ?, '2026-10-05T01:00:00Z', ?, 0, 0, 0)`,
  ).run(card.prState ?? "open", card.syncedFor ?? null);
  const publish = vi.fn();
  const ctx = { bb, db, stmts, sync: { login: "jordan-rivera" }, settings: { get: async () => ({ githubToken: "token", ghPath: "" }) }, publish } as unknown as KanbanContext;
  const prComments = createPrComments(ctx, { board: {}, threads: {}, projects: {}, codeReviewThreads: {} } as never);
  return { prComments, stmts, publish, row: () => stmts.byId.get("t1")! };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("comment sync", () => {
  it("refreshes a synced comment's hunk and original lines on the next sync", async () => {
    stubComments([
      { comments: [{ id: 1, body: "Rename this", line: 5 }] },
      { comments: [{ id: 1, body: "Rename this", line: null, diff_hunk: "@@ -1,3 +1,4 @@\n a\n+b", original_line: 4, original_start_line: 3 }] },
    ]);
    const { prComments, stmts, row } = setup();
    await prComments.syncPrComments(row(), "token");
    expect(stmts.commentById.get("review-comment:1")).toMatchObject({ diff_hunk: null, original_line: null, original_start_line: null, outdated: 0 });
    await prComments.syncPrComments(row(), "token");
    expect(stmts.commentById.get("review-comment:1")).toMatchObject({ diff_hunk: "@@ -1,3 +1,4 @@\n a\n+b", original_line: 4, original_start_line: 3, start_line: 3, line: 4, outdated: 1 });
  });

  it("runs a card's syncs one at a time, so an earlier read never lands over a later one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const github = stubComments([{ comments: [{ id: 1, body: "old", line: 5 }], gate }, { comments: [{ id: 1, body: "new", line: 5 }, { id: 2, body: "another", line: 6 }] }]);
    const { prComments, stmts, row } = setup();
    const first = prComments.syncPrComments(row(), "token");
    const second = prComments.syncPrComments(row(), "token");
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The second waits for the first rather than reading GitHub alongside it.
    expect(github.reads()).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(github.reads()).toBe(2);
    expect(stmts.commentsForTicket.all("t1").map((comment) => [comment.id, comment.body])).toEqual([
      ["review-comment:1", "new"],
      ["review-comment:2", "another"],
    ]);
  });

  it("syncs a merged card's comments once when they never were, which the sync loop of open PRs never would", async () => {
    const github = stubComments([{ comments: [{ id: 1, body: "Rename this", line: null, diff_hunk: "@@ -1 +1 @@", original_line: 1 }] }]);
    const { prComments, stmts, publish, row } = setup({ prState: "merged" });
    await prComments.syncIfUnsynced("t1");
    expect(stmts.commentById.get("review-comment:1")).toMatchObject({ diff_hunk: "@@ -1 +1 @@" });
    expect(row().comments_synced_for).toBe("2026-10-05T01:00:00Z");
    expect(publish).toHaveBeenCalledTimes(1);
    await prComments.syncIfUnsynced("t1");
    expect(github.reads()).toBe(1);
  });

  it("leaves a card whose comments were synced to the sync loop", async () => {
    const github = stubComments([{ comments: [] }]);
    const { prComments } = setup({ prState: "closed", syncedFor: "2026-10-05T01:00:00Z" });
    await prComments.syncIfUnsynced("t1");
    expect(github.reads()).toBe(0);
  });
});
