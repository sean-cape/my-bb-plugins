import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DAILY_TEMPLATE,
  appendToSection,
  dateKeyOfDailyPath,
  formatInboxEntry,
  localDateKey,
  openTasks,
  renderDailyTemplate,
  sectionItems,
  sectionLines,
} from "./daily.ts";

const note = renderDailyTemplate(DEFAULT_DAILY_TEMPLATE, "2026-10-06", new Date(2026, 9, 6, 9, 5));

describe("renderDailyTemplate", () => {
  it("fills the date and weekday", () => {
    assert.match(note, /^---\ndate: 2026-10-06\n/);
    assert.match(note, /# 2026-10-06 — Tuesday/);
  });
});

describe("appendToSection", () => {
  it("appends inside the section, before the next heading", () => {
    const once = appendToSection(note, "Inbox", "- 09:05 first");
    const twice = appendToSection(once, "Inbox", "- 09:10 second");
    assert.deepEqual(sectionLines(twice, "Inbox"), ["- 09:05 first", "- 09:10 second"]);
    assert.match(twice, /- 09:10 second\n\n## Plan/);
  });

  it("creates the section when missing and keeps CRLF", () => {
    const result = appendToSection("# Day\r\n\r\nSome text\r\n", "Inbox", "- 10:00 hi");
    assert.equal(result, "# Day\r\n\r\nSome text\r\n\r\n## Inbox\r\n- 10:00 hi\r\n");
  });

  it("ignores headings inside code fences and frontmatter", () => {
    const content = "---\ntitle: Inbox\n---\n```\n## Inbox\n```\n## Inbox\n- old\n## Next\n";
    const result = appendToSection(content, "Inbox", "- new");
    assert.match(result, /```\n## Inbox\n```\n## Inbox\n- old\n- new\n\n## Next/);
  });
});

describe("openTasks", () => {
  it("lists unchecked items in a section", () => {
    const content = "## Carry to tomorrow\n- [ ] One\n- [x] Done\n  - [ ] Nested\n## Other\n- [ ] Elsewhere";
    assert.deepEqual(openTasks(content, "Carry to tomorrow"), ["One", "Nested"]);
  });
});

describe("formatInboxEntry", () => {
  it("indents continuation lines and appends the source", () => {
    assert.equal(formatInboxEntry("line one\nline two", "14:02", "bb: Fix login"), "- 14:02 line one\n  line two — _via bb: Fix login_");
  });
});

describe("sectionItems", () => {
  it("folds continuation lines into their bullet", () => {
    const content = "## Inbox\n- 10:00 one\n  more\n- 11:00 two\n## Next";
    assert.deepEqual(sectionItems(content, "Inbox"), ["10:00 one\nmore", "11:00 two"]);
  });
});

describe("dates", () => {
  it("keys local dates and recognizes daily paths", () => {
    assert.equal(localDateKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
    assert.equal(dateKeyOfDailyPath("DailyNotes", "DailyNotes/2026-05-13.md"), "2026-05-13");
    assert.equal(dateKeyOfDailyPath("DailyNotes", "Wiki/2026-05-13.md"), null);
  });
});
