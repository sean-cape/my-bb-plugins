import { describe, expect, it } from "vitest";
import type { DiffCommits, Finding, Review } from "./lib/types";
import { WORKTREE_SHA } from "./lib/types";
import { commitsAfter, firstUnreviewedCommit, originRound, reviewRounds, sameSha, sinceName } from "./lib/app/rounds";
import { newRows, type StructuralRow } from "./lib/app/structural/rows";
import { newSinceCss } from "./lib/app/text/new-since-css";
import { moveNewChange, type Cursor, type NavFile } from "./lib/app/keys/nav";

const sha = (letter: string) => letter.repeat(40);

function finding(id: string, extra: Partial<Finding> = {}): Finding {
  return { id, severity: "minor", title: id, description: "", fix: null, locations: [], importance: null, scopeFit: null, ...extra };
}

function review(id: string, createdAt: number, findings: Finding[], extra: Partial<Review> = {}): Review {
  return { id, status: "completed", commitSha: null, sinceCommitSha: null, report: { findings }, selection: {}, selectionOverrides: {}, findingEdits: {}, createdAt, ...extra };
}

const commits: DiffCommits = {
  base: sha("0"),
  commits: [
    { sha: sha("a"), summary: "one", author: "Alex", date: "" },
    { sha: sha("b"), summary: "two", author: "Alex", date: "" },
    { sha: sha("c"), summary: "three", author: "Sam", date: "" },
  ],
  marks: [],
};

describe("review rounds", () => {
  it("numbers the completed reviews oldest first and counts what each found", () => {
    const reviews = [
      review("two", 2, [finding("F1", { carriedFrom: "one/F1" }), finding("F2"), finding("P1", { preExisting: true })], { report: { findings: [finding("F1", { carriedFrom: "one/F1" }), finding("F2")], resolved: [{ id: "one/F3", title: "fixed" }] } }),
      review("running", 3, [], { status: "running", report: null }),
      review("one", 1, [finding("F1"), finding("F3")]),
    ];
    expect(reviewRounds(reviews).map((round) => ({ id: round.review.id, number: round.number, reported: round.reported, carried: round.carried, resolved: round.resolved }))).toEqual([
      { id: "one", number: 1, reported: 2, carried: 0, resolved: 0 },
      { id: "two", number: 2, reported: 1, carried: 1, resolved: 1 },
    ]);
  });

  it("follows a finding back to the round that first reported it, and gives up on a review that is not a round", () => {
    const rounds = reviewRounds([review("one", 1, [finding("F1")]), review("two", 2, [finding("F1", { carriedFrom: "one/F1" })])]);
    expect(originRound(rounds, "two", finding("F1", { carriedFrom: "one/F1" }))).toBe(1);
    expect(originRound(rounds, "two", finding("F1", { carriedFrom: "gone/F1" }))).toBeNull();
    expect(originRound(rounds, "two", finding("F9"))).toBeNull();
  });

  it("matches abbreviated shas, and counts the commits after a round's", () => {
    expect(sameSha("aaaaaaa", sha("a"))).toBe(true);
    expect(sameSha("aaaa", sha("a"))).toBe(false);
    expect(commitsAfter(commits, "aaaaaaa")).toBe(2);
    expect(commitsAfter(commits, sha("0"))).toBe(3);
    expect(commitsAfter(commits, sha("c"))).toBe(0);
    expect(commitsAfter(commits, sha("d"))).toBeNull();
  });

  it("finds the first commit no round has read", () => {
    const rounds = reviewRounds([review("one", 1, [], { commitSha: sha("a") }), review("two", 2, [], { commitSha: sha("b") })]);
    expect(firstUnreviewedCommit(commits, rounds)).toBe(2);
    expect(firstUnreviewedCommit(commits, reviewRounds([review("old", 1, [], { commitSha: sha("e") })]))).toBeNull();
    const local = { ...commits, commits: [...commits.commits, { sha: WORKTREE_SHA, summary: "Uncommitted changes", author: "", date: "" }] };
    expect(firstUnreviewedCommit(local, reviewRounds([review("one", 1, [], { commitSha: sha("c") })]))).toBe(3);
  });

  it("names what a delta counts from", () => {
    const rounds = reviewRounds([review("one", 1, []), review("two", 2, [])]);
    const delta = { fromSha: sha("b"), toSha: sha("c"), files: [] };
    expect(sinceName({ ...delta, since: { kind: "review", reviewId: "two" } }, rounds)).toBe("r2");
    expect(sinceName({ ...delta, since: { kind: "githubReview", reviewId: null } }, rounds)).toBe("your last GitHub review");
    expect(sinceName({ ...delta, since: { kind: "commit", reviewId: null } }, rounds)).toBe("bbbbbbb");
    expect(sinceName(delta, rounds)).toBe("you last looked");
  });
});

describe("new since a review", () => {
  const rows: StructuralRow[] = [
    { index: 0, lhs: 1, rhs: 1, changed: false },
    { index: 1, lhs: 2, rhs: null, changed: true },
    { index: 2, lhs: 3, rhs: 2, changed: false },
    { index: 3, lhs: null, rhs: 3, changed: true },
    { index: 4, lhs: 4, rhs: 4, changed: false },
  ];

  it("takes a row on a changed new line, and a deletion whose next new line is the range's insertion point", () => {
    expect([...newRows(rows, [[2, 2]])].sort()).toEqual([1, 2]);
    expect([...newRows(rows, [[3, 4]])].sort()).toEqual([3, 4]);
    expect(newRows(rows, []).size).toBe(0);
  });

  it("marks only added lines in Pierre's stylesheet, by their gutter number", () => {
    expect(newSinceCss([])).toBe("");
    const css = newSinceCss([[3, 4]]);
    expect(css.startsWith('[data-line-type="change-addition"]:is([data-column-number="3"],[data-column-number="4"])')).toBe(true);
  });

  it("steps ]n through runs of new changed lines, skipping older changes", () => {
    const files: NavFile[] = [
      {
        path: "a.ts",
        collapsed: false,
        rows: [
          { left: 1, right: 1, hunk: 0, changed: false },
          { left: null, right: 2, hunk: 0, changed: true },
          { left: null, right: 3, hunk: 0, changed: true },
          { left: 4, right: 4, hunk: 0, changed: false },
          { left: null, right: 10, hunk: 1, changed: true },
          { left: null, right: 11, hunk: 1, changed: true },
        ],
      },
    ];
    const at = (line: number | null): Cursor => ({ path: "a.ts", side: "RIGHT", line, want: "RIGHT" });
    const isNew = (_path: string, line: number) => line === 3 || line === 11;
    expect(moveNewChange(files, at(null), 1, 1, isNew)).toEqual(at(3));
    expect(moveNewChange(files, at(3), 1, 1, isNew)).toEqual(at(11));
    expect(moveNewChange(files, at(11), -1, 1, isNew)).toEqual(at(3));
    const end = at(11);
    expect(moveNewChange(files, end, 1, 1, isNew)).toBe(end);
  });
});
