import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ticket } from "../shared/board";
import type { KanbanContext } from "./context";
import { compareTruncation, createChanges, diffFileFromGithub, prTruncation } from "./diff/changes";
import type { GithubPullFile } from "./github";

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

describe("diffFileFromGithub", () => {
  const file = (overrides: Partial<GithubPullFile>): GithubPullFile => ({ filename: "a.bin", status: "added", additions: 0, deletions: 0, sha: "0123456789abcdef0123456789abcdef01234567", ...overrides });

  it.each([
    ["an added file with no patch or lines", file({}), true],
    ["a removed file with no patch or lines", file({ status: "removed" }), true],
    ["a modified file with no patch or lines", file({ status: "modified" }), true],
    ["an added empty file", file({ sha: EMPTY_BLOB }), false],
    ["a removed empty file", file({ status: "removed", sha: EMPTY_BLOB }), false],
    ["a pure rename", file({ status: "renamed", previous_filename: "old.bin" }), false],
    ["a file with a patch", file({ status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }), false],
    ["a file too big for a patch but with line counts", file({ status: "modified", additions: 4000 }), false],
  ])("calls %s binary: %s", (_, input, binary) => {
    expect(diffFileFromGithub(input).binary).toBe(binary);
  });

  it("keeps the names, counts and patch", () => {
    expect(diffFileFromGithub(file({ filename: "vendor/x/b.go", previous_filename: "a.go", status: "renamed", additions: 1, deletions: 2, patch: "@@" }))).toEqual({
      path: "vendor/x/b.go",
      previousPath: "a.go",
      status: "renamed",
      additions: 1,
      deletions: 2,
      patch: "@@",
      vendored: true,
      binary: false,
    });
  });
});

describe("truncation", () => {
  it.each([
    [10, 10, false],
    [10, 11, true],
    [3000, 3000, false],
    [3000, 4500, true],
    [2999, undefined, false],
    [3000, undefined, true],
  ])("a PR listing %i files of %s changed is truncated: %s", (listed, changed, truncated) => {
    const result = prTruncation(listed, changed);
    expect(result.truncated).toBe(truncated);
    expect(result.truncatedNote === null).toBe(!truncated);
  });

  it("says how many of the PR's files are shown when GitHub gives the count", () => {
    expect(prTruncation(3000, 4500).truncatedNote).toContain("Showing 3,000 of this pull request's 4,500 changed files");
    expect(prTruncation(3000, undefined).truncatedNote).toContain("this one may have more");
  });

  it.each([
    [299, false],
    [300, true],
  ])("a comparison of %i files is truncated: %s", (listed, truncated) => {
    expect(compareTruncation(listed)).toEqual({ truncated, truncatedNote: truncated ? expect.stringContaining("at most 300 files") : null });
  });
});

describe("a PR card's old side", () => {
  const TIP = "b".repeat(40);
  const MERGE_BASE = "c".repeat(40);
  const HEAD = "d".repeat(40);
  const FROM = "e".repeat(40);
  const RANGE_BASE = "f".repeat(40);
  const ticket = { id: "t1", pr: { repo: "acme/widgets", number: 7, updatedAt: "2026-10-05T00:00:00Z" }, threadId: null, latestReview: null } as unknown as Ticket;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  /** GitHub for one PR whose base branch moved on (`TIP`) after it branched (`MERGE_BASE`), recording what was read. */
  function stubGithub() {
    const reads: string[] = [];
    const blamed: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      reads.push(path);
      if (url.pathname === "/graphql") {
        const { variables } = JSON.parse(String(init?.body)) as { variables: { expression: string } };
        blamed.push(variables.expression);
        return json({ data: { repository: { object: { blame: { ranges: [] } } } } });
      }
      if (url.pathname === "/repos/acme/widgets/pulls/7") return json({ base: { ref: "main", sha: TIP }, head: { sha: HEAD }, changed_files: 1 });
      if (url.pathname === "/repos/acme/widgets/pulls/7/files") return json([{ filename: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }]);
      if (url.pathname === "/repos/acme/widgets/pulls/7/commits") return json([{ sha: HEAD, commit: { message: "Change a", author: { name: "Ada", date: "2026-10-05T00:00:00Z" } }, author: null }]);
      if (url.pathname === "/repos/acme/widgets/pulls/7/reviews") return json([]);
      if (url.pathname === `/repos/acme/widgets/compare/${TIP}...${HEAD}`) return json({ merge_base_commit: { sha: MERGE_BASE }, files: [] });
      if (url.pathname === `/repos/acme/widgets/compare/${FROM}...${HEAD}`) return json({ merge_base_commit: { sha: RANGE_BASE }, files: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 1 }] });
      if (url.pathname.startsWith("/repos/acme/widgets/contents/a.ts")) return new Response(`a.ts at ${url.searchParams.get("ref")}\n`, { status: 200 });
      return json({ message: `unexpected ${path}` });
    });
    vi.stubGlobal("fetch", fetch);
    return { reads, blamed };
  }

  const changes = () =>
    createChanges({
      bb: { log: { warn: () => {} }, sdk: {} },
      settings: { get: async () => ({ githubToken: "token", ghPath: "", hideVendored: false, difftPath: "" }) },
      stmts: { latestCompletedReviewOfKind: { get: () => undefined } },
      sync: { login: null },
    } as unknown as KanbanContext);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the merge base, not the base branch's tip, for the diff, the file sides, blame and the commit picker", async () => {
    const github = stubGithub();
    const card = changes();
    expect(await card.ticketDiff(ticket, false)).toMatchObject({ baseRef: "main", baseSha: MERGE_BASE, headSha: HEAD });
    const patch = await card.loadPatch(ticket, "a.ts");
    expect(patch).toContain(`-a.ts at ${MERGE_BASE}`);
    expect(patch).toContain(`+a.ts at ${HEAD}`);
    await card.blame(ticket, "a.ts", "LEFT", 1, 1);
    await card.blame(ticket, "a.ts", "RIGHT", 1, 1);
    expect(github.blamed).toEqual([MERGE_BASE, HEAD]);
    expect((await card.ticketCommits(ticket)).base).toBe(MERGE_BASE);
    // The PR's files and merge base are read once, then served with the cached diff.
    expect(github.reads.filter((path) => path.startsWith("/repos/acme/widgets/pulls/7/files"))).toHaveLength(1);
    expect(github.reads.filter((path) => path.includes("/compare/"))).toEqual([`/repos/acme/widgets/compare/${TIP}...${HEAD}?per_page=1`]);
  });

  it("is the range comparison's merge base for blame and file sides of a range", async () => {
    const github = stubGithub();
    const card = changes();
    const range = { from: FROM, to: HEAD };
    await card.blame(ticket, "a.ts", "LEFT", 1, 1, range);
    await card.blame(ticket, "a.ts", "RIGHT", 1, 1, range);
    expect(github.blamed).toEqual([RANGE_BASE, HEAD]);
    expect(await card.loadPatch(ticket, "a.ts", range)).toContain(`-a.ts at ${RANGE_BASE}`);
  });

  it("falls back to the base branch's tip when GitHub gives no merge base", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/compare/")) return new Response("nope", { status: 500 });
        if (url.pathname === "/repos/acme/widgets/pulls/7") return json({ base: { ref: "main", sha: TIP }, head: { sha: HEAD } });
        return json([]);
      }),
    );
    expect(await changes().ticketDiff(ticket, false)).toMatchObject({ baseSha: TIP, headSha: HEAD });
  });
});
