import { describe, expect, it } from "vitest";
import { commitsFromGithub, reviewMarks } from "./diff/commits";

const sha = (n: number) => String(n).repeat(40);
const commits = [1, 2, 3].map((n) => ({ sha: sha(n), summary: `c${n}`, author: "a", date: "" }));

describe("commitsFromGithub", () => {
  it("keeps the message's first line and prefers the GitHub login", () => {
    expect(
      commitsFromGithub([
        { sha: sha(1), commit: { message: "Fix it\n\nBody", author: { name: "Ada L", date: "2026-10-01T00:00:00Z" } }, author: { login: "ada" } },
        { sha: sha(2), commit: { message: "Other", author: { name: "Bo", date: null } }, author: null },
      ]),
    ).toEqual([
      { sha: sha(1), summary: "Fix it", author: "ada", date: "2026-10-01T00:00:00Z" },
      { sha: sha(2), summary: "Other", author: "Bo", date: "" },
    ]);
  });
});

describe("reviewMarks", () => {
  const review = (login: string, commit: string, state: string, at: string) => ({ user: { login }, commit_id: commit, state, submitted_at: at });

  it("marks the card's last review and the signed-in user's latest submitted GitHub review", () => {
    const github = [review("Me", sha(1), "COMMENTED", "2026-10-01T00:00:00Z"), review("me", sha(2), "APPROVED", "2026-10-02T00:00:00Z"), review("me", sha(3), "PENDING", "2026-10-03T00:00:00Z"), review("other", sha(3), "APPROVED", "2026-10-04T00:00:00Z")];
    expect(reviewMarks(commits, sha(1).slice(0, 12), github, "me")).toEqual([
      { sha: sha(1), label: "Since last review" },
      { sha: sha(2), label: "Since your last GitHub review" },
    ]);
  });

  it("leaves out marks whose commit is not in the diff, or with no one signed in", () => {
    expect(reviewMarks(commits, sha(9), [review("me", sha(8), "APPROVED", "2026-10-02T00:00:00Z")], "me")).toEqual([]);
    expect(reviewMarks(commits, null, [review("me", sha(2), "APPROVED", "2026-10-02T00:00:00Z")], null)).toEqual([]);
  });

  it("leaves out a mark at the head, which has nothing after it, but not one before uncommitted changes", () => {
    expect(reviewMarks(commits, sha(3), [review("me", sha(3), "APPROVED", "2026-10-02T00:00:00Z")], "me")).toEqual([]);
    const withWorktree = [...commits, { sha: "WORKTREE", summary: "Uncommitted changes", author: "", date: "" }];
    expect(reviewMarks(withWorktree, sha(3), null, null)).toEqual([{ sha: sha(3), label: "Since last review" }]);
  });
});
