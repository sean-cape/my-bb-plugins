import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SuggestionItem } from "bb-diff-view/types";
import type { Ticket } from "../shared/board";
import type { PrComment } from "../shared/comments";
import type { KanbanContext } from "./context";
import { commitSuggestionsToPr, createSuggestions } from "./diff/suggestions";
import { stubGitData } from "./git-data-stub";

const item = (path: string, startLine: number, expected: string[], replacement: string[], extra: Partial<SuggestionItem> = {}): SuggestionItem => ({ id: `review-comment:${startLine}`, path, startLine, endLine: startLine + expected.length - 1, expected, replacement, ...extra });

let dir: string | null = null;
afterEach(() => {
  vi.unstubAllGlobals();
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("commitSuggestionsToPr", () => {
  it("commits with the message given, GitHub's default for a blank one", async () => {
    const git = stubGitData({ "a.ts": "one\ntwo\n" });
    vi.stubGlobal("fetch", git.fetch);
    await commitSuggestionsToPr("acme/widgets", 7, [item("a.ts", 1, ["one"], ["ONE"])], "Tidy the loop", "token");
    expect(git.commits.get(git.refs.get("feature/x")!)!.message).toBe("Tidy the loop");
    await commitSuggestionsToPr("acme/widgets", 7, [item("a.ts", 2, ["two"], ["TWO"])], "  ", "token");
    expect(git.commits.get(git.refs.get("feature/x")!)!.message).toBe("Apply suggestion from code review");
  });

  it("refuses items read at a head the branch has moved past, and takes them at its tip", async () => {
    const git = stubGitData({ "a.ts": "one\n" });
    vi.stubGlobal("fetch", git.fetch);
    await expect(commitSuggestionsToPr("acme/widgets", 7, [item("a.ts", 1, ["one"], ["ONE"], { headSha: "old" })], null, "token")).rejects.toThrow(/branch moved on/u);
    expect(git.writes).toEqual([]);
    await commitSuggestionsToPr("acme/widgets", 7, [item("a.ts", 1, ["one"], ["ONE"], { headSha: git.root })], null, "token");
    expect(git.refs.get("feature/x")).not.toBe(git.root);
  });

  it("refuses a head repository that is gone, a file that isn't UTF-8, and a symlink, writing nothing", async () => {
    const gone = stubGitData({ "a.ts": "one\n" }, { headRepo: null });
    vi.stubGlobal("fetch", gone.fetch);
    await expect(commitSuggestionsToPr("acme/widgets", 7, [item("a.ts", 1, ["one"], ["ONE"])], null, "token")).rejects.toThrow(/head repository no longer exists/u);
    expect(gone.writes).toEqual([]);
    const git = stubGitData({ "latin1.txt": new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]), "link.ts": "a.ts" }, { modes: { "link.ts": "120000" } });
    vi.stubGlobal("fetch", git.fetch);
    await expect(commitSuggestionsToPr("acme/widgets", 7, [item("latin1.txt", 1, ["caf�"], ["cafe"])], null, "token")).rejects.toThrow(/latin1\.txt is not UTF-8 text/u);
    await expect(commitSuggestionsToPr("acme/widgets", 7, [item("link.ts", 1, ["a.ts"], ["b.ts"])], null, "token")).rejects.toThrow(/link\.ts is a symlink/u);
    expect(git.writes).toEqual([]);
  });
});

describe("createSuggestions", () => {
  const ctx = ({ sdk = {}, warn = () => {} }: { sdk?: object; warn?: (message: string) => void } = {}) =>
    ({
      bb: { log: { warn }, sdk },
      settings: { get: async () => ({ githubToken: "token", ghPath: "" }) },
      stmts: { byId: { get: () => undefined } },
    }) as unknown as KanbanContext;
  const noComments = { setResolved: async () => ({}) as PrComment, syncPrComments: async () => {} } as never;

  it("resolves only the GitHub review threads among the items applied", async () => {
    const git = stubGitData({ "a.ts": "one\ntwo\nthree\n" });
    vi.stubGlobal("fetch", git.fetch);
    const resolved: string[] = [];
    const prComments = { setResolved: async (id: string) => (resolved.push(id), {} as PrComment), syncPrComments: async () => {} };
    const suggestions = createSuggestions(ctx(), { prComments: prComments as never });
    const prTicket = { id: "t1", pr: { repo: "acme/widgets", number: 7 }, threadId: null } as unknown as Ticket;
    await suggestions.applySuggestions(prTicket, [item("a.ts", 1, ["one"], ["ONE"]), { ...item("a.ts", 2, ["two"], ["TWO"]), id: "finding:r1/F1" }, { ...item("a.ts", 3, ["three"], ["THREE"]), id: "local-7" }], null);
    expect(resolved).toEqual(["review-comment:1"]);
  });

  it("writes a card without a pull request into its thread's checkout, and says why when it can't", async () => {
    dir = mkdtempSync(join(tmpdir(), "kanban-suggest-"));
    writeFileSync(join(dir, "a.ts"), "one\n");
    const sdk = (environmentId: string | null, path: string | null) => ({
      threads: { get: async () => ({ environmentId }) },
      system: { config: async () => ({ primaryHostId: "host" }) },
      environments: { get: async () => ({ workspacePath: path }) },
    });
    const ticket = (threadId: string | null) => ({ id: "t2", pr: null, threadId }) as unknown as Ticket;
    const applied = await createSuggestions(ctx({ sdk: sdk("env", dir) }), { prComments: noComments }).applySuggestions(ticket("th"), [item("a.ts", 1, ["one"], ["ONE"])], "ignored");
    expect(applied).toEqual({ applied: 1, commitUrl: null });
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("ONE\n");
    await expect(createSuggestions(ctx({ sdk: sdk("env", dir) }), { prComments: noComments }).applySuggestions(ticket(null), [item("a.ts", 1, ["ONE"], ["x"])], null)).rejects.toThrow(/no pull request or thread/u);
    await expect(createSuggestions(ctx({ sdk: sdk(null, dir) }), { prComments: noComments }).applySuggestions(ticket("th"), [item("a.ts", 1, ["ONE"], ["x"])], null)).rejects.toThrow(/needs a local checkout/u);
    await expect(createSuggestions(ctx({ sdk: sdk("env", null) }), { prComments: noComments }).applySuggestions(ticket("th"), [item("a.ts", 1, ["ONE"], ["x"])], null)).rejects.toThrow(/needs a local checkout/u);
  });
});
