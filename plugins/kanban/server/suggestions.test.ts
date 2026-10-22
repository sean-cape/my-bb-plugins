import { afterEach, describe, expect, it, vi } from "vitest";
import type { SuggestionItem } from "bb-diff-view/types";
import type { Ticket } from "../shared/board";
import type { PrComment } from "../shared/comments";
import { commentsBody } from "./comments/pr-comments";
import type { KanbanContext } from "./context";
import { commitSuggestionsToPr, createSuggestions } from "./diff/suggestions";
import { stubGitData } from "./git-data-stub";

const item = (path: string, startLine: number, endLine: number, expected: string[], replacement: string[], id = `review-comment:${startLine}`): SuggestionItem => ({ id, path, startLine, endLine, expected, replacement });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("commitSuggestionsToPr", () => {
  it("makes one commit on the head branch with every file's suggestions, keeping each file's mode", async () => {
    const git = stubGitData({ "src/a.ts": "one\ntwo\nthree\n", "run.sh": "echo hi\n" });
    vi.stubGlobal("fetch", git.fetch);
    const result = await commitSuggestionsToPr("acme/widgets", 7, [item("src/a.ts", 3, 3, ["three"], ["THREE"]), item("src/a.ts", 1, 1, ["one"], []), item("run.sh", 1, 1, ["echo hi"], ["echo hello"])], null, "token");
    const head = git.refs.get("feature/x")!;
    expect(result).toEqual({ applied: 3, commitUrl: `https://github.com/fork/widgets/commit/${head}` });
    const commit = git.commits.get(head)!;
    expect(commit.message).toBe("Apply suggestions from code review");
    expect(commit.parents).toHaveLength(1);
    const tree = git.trees.get(commit.tree)!;
    expect(tree.find((entry) => entry.path === "run.sh")).toMatchObject({ mode: "100755" });
    expect(git.blobs.get(tree.find((entry) => entry.path === "run.sh")!.sha)).toBe("echo hello\n");
    expect(git.blobs.get(tree.find((entry) => entry.path === "src/a.ts")!.sha)).toBe("two\nTHREE\n");
    expect(git.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      "POST /repos/fork/widgets/git/blobs",
      "POST /repos/fork/widgets/git/blobs",
      "POST /repos/fork/widgets/git/trees",
      "POST /repos/fork/widgets/git/commits",
      "PATCH /repos/fork/widgets/git/refs/heads/feature/x",
    ]);
    expect(git.writes.at(-1)!.body).toEqual({ sha: head, force: false });
  });

  it("writes nothing when any item's lines moved on the branch, naming them", async () => {
    const git = stubGitData({ "src/a.ts": "one\ntwo\n" });
    vi.stubGlobal("fetch", git.fetch);
    await expect(commitSuggestionsToPr("acme/widgets", 7, [item("src/a.ts", 1, 1, ["one"], ["ONE"]), item("src/a.ts", 2, 2, ["2"], ["TWO"])], "Tidy", "token")).rejects.toThrow(/src\/a\.ts:L2 changed since the suggestion was made/u);
    await expect(commitSuggestionsToPr("acme/widgets", 7, [item("src/gone.ts", 1, 1, ["x"], ["y"])], null, "token")).rejects.toThrow(/src\/gone\.ts is not on the pull request's branch/u);
    expect(git.writes).toEqual([]);
  });
});

describe("createSuggestions", () => {
  const prTicket = { id: "t1", pr: { repo: "acme/widgets", number: 7 }, threadId: null } as unknown as Ticket;
  const ctx = (warn: (message: string) => void) =>
    ({
      bb: { log: { warn } },
      settings: { get: async () => ({ githubToken: "token", ghPath: "" }) },
      stmts: { byId: { get: () => undefined } },
    }) as unknown as KanbanContext;

  it("resolves each applied GitHub thread after the commit, and a failed resolve doesn't fail the apply", async () => {
    const git = stubGitData({ "a.ts": "one\ntwo\n" });
    vi.stubGlobal("fetch", git.fetch);
    const resolved: string[] = [];
    const warnings: string[] = [];
    const prComments = {
      setResolved: async (id: string) => {
        if (id === "review-comment:2") throw new Error("GitHub said no");
        resolved.push(id);
        return {} as PrComment;
      },
      syncPrComments: async () => {},
    };
    const suggestions = createSuggestions(ctx((message) => warnings.push(message)), { prComments: prComments as never });
    const result = await suggestions.applySuggestions(prTicket, [item("a.ts", 1, 1, ["one"], ["ONE"]), item("a.ts", 2, 2, ["two"], ["TWO"])], null);
    expect(result.applied).toBe(2);
    expect(resolved).toEqual(["review-comment:1"]);
    expect(warnings).toEqual([expect.stringContaining("review-comment:2")]);
  });
});

describe("commentsBody", () => {
  const comment = (body: string) => ({ id: "local:1", kind: "review-comment", author: "you", path: "a.ts", line: 2, side: "RIGHT", startLine: null, startSide: null, inReplyTo: null, url: "", body }) as unknown as PrComment;
  const ticket = { id: "t1", pr: null } as unknown as Ticket;

  it("tells the agent a suggestion block is the exact replacement, only when one is there", () => {
    expect(commentsBody(ticket, [comment("```suggestion\nconst a = 1;\n```")])).toContain("exact replacement text");
    expect(commentsBody(ticket, [comment("rename this")])).not.toContain("exact replacement");
  });
});
