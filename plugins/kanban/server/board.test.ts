import { describe, expect, it } from "vitest";
import { DEFAULT_COLUMNS, PRE_LOOP_DEFAULT_COLUMNS, type JiraIssue, type PullRequest } from "../shared/board";
import { doneColumn, initialColumn, withLoopColumns } from "./board";

const pr = (state: PullRequest["state"]): PullRequest => ({ repo: "acme/widgets", number: 7, url: "", role: "authored", state, author: "", updatedAt: "", headRef: null, checks: null });
const jira = (statusCategory: JiraIssue["statusCategory"]): JiraIssue => ({ key: "PROJ-1", url: "", status: "", statusCategory, issueType: "", priority: null, assignee: null, updatedAt: "" });

describe("initialColumn", () => {
  it("puts ad hoc cards in the backlog, open PRs and new Jira issues in To Do, and finished items in Done", () => {
    expect(initialColumn(DEFAULT_COLUMNS, null)).toBe("backlog");
    expect(initialColumn(DEFAULT_COLUMNS, pr("open"))).toBe("todo");
    expect(initialColumn(DEFAULT_COLUMNS, pr("draft"))).toBe("todo");
    expect(initialColumn(DEFAULT_COLUMNS, pr("merged"))).toBe("done");
    expect(initialColumn(DEFAULT_COLUMNS, pr("closed"))).toBe("done");
    expect(initialColumn(DEFAULT_COLUMNS, null, jira("new"))).toBe("todo");
    expect(initialColumn(DEFAULT_COLUMNS, null, jira("indeterminate"))).toBe("in-progress");
    expect(initialColumn(DEFAULT_COLUMNS, null, jira("done"))).toBe("done");
  });

  it("falls back to the next preferred column, then the first, when the user removed the usual one", () => {
    const columns = [
      { id: "ideas", name: "Ideas" },
      { id: "todo", name: "To Do" },
      { id: "shipped", name: "Shipped" },
    ];
    expect(initialColumn(columns, null)).toBe("todo");
    expect(initialColumn(columns, null, jira("indeterminate"))).toBe("todo");
    expect(initialColumn(columns, pr("merged"))).toBe("ideas");
    expect(doneColumn(columns)).toBe("shipped");
  });
});

describe("withLoopColumns", () => {
  const ids = (columns: { id: string }[]) => columns.map((column) => column.id);

  it("adds Checking just before review on a board that predates the loop, keeping its names", () => {
    const columns = withLoopColumns(PRE_LOOP_DEFAULT_COLUMNS);
    expect(ids(columns)).toEqual(["backlog", "todo", "in-progress", "checking", "review", "done"]);
    expect(columns.find((column) => column.id === "checking")?.name).toBe("Checking");
    expect(columns.find((column) => column.id === "review")?.name).toBe("In Review");
  });

  it("adds Checking and Needs you right after Doing on a new board, ahead of Waiting", () => {
    const columns = withLoopColumns(DEFAULT_COLUMNS);
    expect(ids(columns)).toEqual(["backlog", "todo", "in-progress", "checking", "review", "waiting", "done"]);
    expect(columns.map((column) => column.name)).toEqual(["Backlog", "To Do", "Doing", "Checking", "Needs you", "Waiting", "Done"]);
  });

  it("leaves a board that has every loop column alone", () => {
    const columns = withLoopColumns(DEFAULT_COLUMNS);
    expect(withLoopColumns(columns)).toBe(columns);
  });

  it("restores a removed in-progress or review where it belongs, before the done column", () => {
    expect(ids(withLoopColumns([{ id: "todo", name: "To Do" }, { id: "done", name: "Done" }]))).toEqual(["todo", "in-progress", "checking", "review", "done"]);
    // With no `done` column the last one is where finished cards go, so the loop's columns stay ahead of it.
    expect(ids(withLoopColumns([{ id: "ideas", name: "Ideas" }, { id: "review", name: "Review" }, { id: "shipped", name: "Shipped" }]))).toEqual(["ideas", "in-progress", "checking", "review", "shipped"]);
  });
});
