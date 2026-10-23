import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ticket } from "../shared/board";
import type { CommitRange, TicketDiff } from "../shared/diff";
import type { KanbanContext } from "./context";
import type { Changes } from "./diff/changes";
import { createDiffDelta } from "./diff/delta";
import type { ViewedMarks } from "./diff/viewed";

const sha = (letter: string) => letter.repeat(40);
const HEAD = sha("f");

function diff(headSha: string | null, files: TicketDiff["files"] = []): TicketDiff {
  return { source: "pr", files, baseRef: "main", baseSha: sha("0"), headSha, truncated: false, message: null, fetchedAt: 0, hiddenVendored: null, repo: "acme-co/widgets", environmentId: null };
}

const changedFile = { path: "a.ts", previousPath: null, status: "modified", additions: 1, deletions: 0, patch: "@@ -4,0 +5,1 @@\n+new line", vendored: false };

function setup({ reviews = [], githubReviews = null, viewedHead = null, pr = true }: { reviews?: Array<{ id: string; commit_sha: string | null; status?: string }>; githubReviews?: unknown[] | null; viewedHead?: string | null; pr?: boolean }) {
  const ranges: Array<CommitRange | null> = [];
  const changes = {
    ticketDiff: async (_ticket: Ticket, _refresh: boolean, range: CommitRange | null = null) => {
      ranges.push(range);
      return range === null ? diff(HEAD) : diff(range.to, [changedFile]);
    },
  } as unknown as Changes;
  const viewed = { lastViewedHead: () => viewedHead } as unknown as ViewedMarks;
  const kinds: string[] = [];
  const ctx = {
    bb: { log: { warn: () => {} } },
    settings: { get: async () => ({ githubToken: "token", ghPath: "" }) },
    stmts: {
      reviewsForTicketOfKind: {
        all: (_ticketId: string, kind: string) => {
          kinds.push(kind);
          return reviews.map((review) => ({ status: "completed", ...review }));
        },
      },
    },
    sync: { login: "alex" },
  } as unknown as KanbanContext;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(githubReviews ?? []), { status: githubReviews === null ? 404 : 200, headers: { "content-type": "application/json" } })),
  );
  const ticket = { id: "card", pr: pr ? { repo: "acme-co/widgets", number: 7 } : null, threadId: pr ? null : "thr_card" } as unknown as Ticket;
  return { deltas: createDiffDelta(ctx, { changes, viewed }), ticket, ranges, kinds };
}

describe("diff delta", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts from the latest completed review of the diff's own kind, with the new lines since it", async () => {
    const { deltas, ticket, ranges, kinds } = setup({ reviews: [{ id: "rev2", commit_sha: sha("b") }, { id: "rev1", commit_sha: sha("a") }] });
    const delta = await deltas.diffDelta(ticket, null);
    expect(delta).toMatchObject({ fromSha: sha("b"), toSha: HEAD, since: { kind: "review", reviewId: "rev2" } });
    expect(delta!.files).toEqual([{ path: "a.ts", status: "modified", additions: 1, deletions: 0, ranges: [[5, 5]], blocks: [[5, 0, 5, 1]] }]);
    expect(ranges.at(-1)).toEqual({ from: sha("b"), to: HEAD });
    expect(kinds).toEqual(["pr"]);
  });

  it("skips reviews that failed or recorded no commit, and has nothing to say when the head is the reviewed commit", async () => {
    const { deltas, ticket } = setup({ reviews: [{ id: "broken", commit_sha: null }, { id: "failed", commit_sha: sha("c"), status: "failed" }, { id: "rev1", commit_sha: HEAD }] });
    expect(await deltas.diffDelta(ticket, null)).toBeNull();
  });

  it("falls back to your last GitHub review, then the head you last marked files viewed on", async () => {
    const github = setup({ githubReviews: [{ user: { login: "Alex" }, state: "COMMENTED", commit_id: sha("c"), submitted_at: "2026-10-01T00:00:00Z" }], viewedHead: sha("d") });
    expect(await github.deltas.diffDelta(github.ticket, null)).toMatchObject({ fromSha: sha("c"), since: { kind: "githubReview", reviewId: null } });
    const looked = setup({ githubReviews: [], viewedHead: sha("d") });
    expect(await looked.deltas.diffDelta(looked.ticket, null)).toMatchObject({ fromSha: sha("d"), since: { kind: "viewed", reviewId: null } });
    const none = setup({});
    expect(await none.deltas.diffDelta(none.ticket, null)).toBeNull();
  });

  it("counts from a picked commit, naming the review that read it", async () => {
    const { deltas, ticket } = setup({ reviews: [{ id: "rev2", commit_sha: sha("b") }, { id: "rev1", commit_sha: sha("a") }] });
    expect(await deltas.diffDelta(ticket, sha("a"))).toMatchObject({ fromSha: sha("a"), since: { kind: "review", reviewId: "rev1" } });
    expect(await deltas.diffDelta(ticket, sha("e"))).toMatchObject({ fromSha: sha("e"), since: { kind: "commit", reviewId: null } });
  });

  it("reads a local card's changes since its review up to the working tree", async () => {
    const { deltas, ticket, ranges, kinds } = setup({ pr: false, reviews: [{ id: "local1", commit_sha: sha("a") }] });
    expect(await deltas.diffDelta(ticket, null)).toMatchObject({ fromSha: sha("a"), toSha: "WORKTREE", since: { kind: "review", reviewId: "local1" } });
    expect(ranges).toEqual([{ from: sha("a"), to: "WORKTREE" }]);
    expect(kinds).toEqual(["local"]);
  });
});
