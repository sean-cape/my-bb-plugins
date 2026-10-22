import { describe, expect, it } from "vitest";
import { blameLinesFromRanges, type GithubBlameRange } from "./github";

const range = (startingLine: number, endingLine: number, oid: string, login: string | null): GithubBlameRange => ({
  startingLine,
  endingLine,
  commit: { oid, messageHeadline: `commit ${oid}`, authoredDate: "2026-10-01T12:00:00Z", author: { name: "Name Only", user: login === null ? null : { login } } },
});

describe("blameLinesFromRanges", () => {
  it("expands the ranges overlapping the asked lines into one entry per line", () => {
    const lines = blameLinesFromRanges([range(1, 4, "a", "ada"), range(5, 5, "b", null), range(6, 40, "c", "cy")], 3, 6);
    expect(lines.map((line) => [line.line, line.sha, line.author])).toEqual([
      [3, "a", "ada"],
      [4, "a", "ada"],
      [5, "b", "Name Only"],
      [6, "c", "cy"],
    ]);
    expect(lines[0]).toMatchObject({ summary: "commit a", time: Date.parse("2026-10-01T12:00:00Z") });
  });
});
