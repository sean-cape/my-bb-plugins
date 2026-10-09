import { describe, expect, it } from "vitest";
import { agedOut, doneColumnId, todoColumnId } from "../shared/columns";
import { cardSnippet, dueStatus, localDay, parseQuickAdd, parseTagList, relativeTime, shortAge, slugify } from "./format";

describe("parseQuickAdd", () => {
  it("pulls #tags out of a title, lowercased and deduplicated", () => {
    expect(parseQuickAdd("Fix  login #Infra bug #urgent #infra")).toEqual({ title: "Fix login bug", tags: ["infra", "urgent"] });
    expect(parseQuickAdd("Issue#12 stays in the title")).toEqual({ title: "Issue#12 stays in the title", tags: [] });
  });
});

describe("parseTagList", () => {
  it("accepts comma or space separated tags with or without #, and drops invalid ones", () => {
    expect(parseTagList("infra, #urgent  ops,,")).toEqual(["infra", "urgent", "ops"]);
    expect(parseTagList("-bad #also_ok")).toEqual(["also_ok"]);
    expect(parseTagList("")).toEqual([]);
  });
});

describe("slugify", () => {
  it("turns a name into a lowercase dashed id of at most 40 characters, or the fallback", () => {
    expect(slugify("  In Review! ", "untitled")).toBe("in-review");
    expect(slugify("x".repeat(50), "untitled")).toHaveLength(40);
    expect(slugify("!!!", "fallback-id")).toBe("fallback-id");
  });
});

describe("relativeTime", () => {
  it("rounds to the coarsest unit that reads naturally", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 30_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3 d ago");
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});

describe("column lookups", () => {
  it("prefer the done and todo ids, else the last and first columns, else nothing", () => {
    const columns = [{ id: "ideas" }, { id: "todo" }, { id: "done" }, { id: "archive" }];
    expect(doneColumnId(columns)).toBe("done");
    expect(todoColumnId(columns)).toBe("todo");
    expect(doneColumnId([{ id: "a" }, { id: "b" }])).toBe("b");
    expect(todoColumnId([{ id: "a" }, { id: "b" }])).toBe("a");
    expect(doneColumnId([])).toBeNull();
    expect(todoColumnId([])).toBeNull();
  });
});

describe("dueStatus", () => {
  it("names nearby days, flags overdue and imminent dates, and shows the year only when it differs", () => {
    expect(dueStatus("2026-10-08", "2026-10-08")).toMatchObject({ label: "Today", tone: "soon" });
    expect(dueStatus("2026-10-09", "2026-10-08")).toMatchObject({ label: "Tomorrow", tone: "soon" });
    expect(dueStatus("2026-10-07", "2026-10-08")).toMatchObject({ label: "Yesterday", tone: "overdue" });
    expect(dueStatus("2026-10-01", "2026-10-08").title).toContain("7 days overdue");
    expect(dueStatus("2026-10-20", "2026-10-08")).toMatchObject({ tone: "later" });
    expect(dueStatus("2026-10-20", "2026-10-08").title).toContain("in 12 days");
    expect(dueStatus("2027-01-05", "2026-10-08").label).toContain("2027");
    expect(dueStatus("2026-10-20", "2026-10-08").label).not.toContain("2026");
  });

  it("counts calendar days across a daylight saving change", () => {
    expect(dueStatus("2026-11-02", "2026-10-31").title).toContain("in 2 days");
  });
});

describe("localDay", () => {
  it("formats the local calendar day", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
  });
});

describe("agedOut", () => {
  const day = 24 * 60 * 60 * 1000;

  it("hides a card once it has been in the column longer than the column's days", () => {
    expect(agedOut({ hideAfterDays: 7 }, 0, 7 * day)).toBe(false);
    expect(agedOut({ hideAfterDays: 7 }, 0, 7 * day + 1)).toBe(true);
  });

  it("keeps every card when the column has no limit", () => {
    expect(agedOut({}, 0, 1000 * day)).toBe(false);
    expect(agedOut({ hideAfterDays: null }, 0, 1000 * day)).toBe(false);
  });
});

describe("shortAge", () => {
  const now = Date.UTC(2026, 9, 9, 12);
  it("picks the largest unit that keeps the number readable", () => {
    expect(shortAge(now - 20_000, now)).toBe("now");
    expect(shortAge(now - 12 * 60_000, now)).toBe("12m");
    expect(shortAge(now - 5 * 3_600_000, now)).toBe("5h");
    expect(shortAge(now - 23 * 3_600_000, now)).toBe("23h");
    expect(shortAge(now - 47 * 3_600_000, now)).toBe("1d");
    expect(shortAge(now - 3 * 86_400_000, now)).toBe("3d");
    expect(shortAge(now + 60_000, now)).toBe("now");
  });
});

describe("cardSnippet", () => {
  it("flattens Markdown to one line of prose", () => {
    expect(cardSnippet("## Goal\n- [ ] Ship the **new** [docs](https://x.test)\n> quoted `code`")).toBe("Goal Ship the new docs quoted code");
    expect(cardSnippet("Before\n```ts\nconst x = 1;\n```\nafter ![img](a.png)")).toBe("Before after");
    expect(cardSnippet("   \n\n")).toBe("");
  });
});
