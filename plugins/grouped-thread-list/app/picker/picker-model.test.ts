import { describe, expect, it } from "vitest";
import { makeSidebarThread } from "../model/fixtures.js";
import { createThreadProjectResolver } from "../model/active-project.js";
import type { SidebarProject } from "../model/use-sidebar-data.js";
import {
  buildLeftEntries,
  entryProjectId,
  formatAge,
  fuzzyMatches,
  searchThreads,
  threadRowsForEntry,
} from "./picker-model.js";

function project(id: string, name: string): SidebarProject {
  return {
    id,
    name,
    isPersonal: false,
    threads: [],
  };
}

describe("buildLeftEntries", () => {
  const projects = [
    project("proj_a", "my-bb-plugins"),
    project("proj_b", "hss"),
  ];

  it("lists Open folder, Unassociated, Pinned, Unread, then projects", () => {
    expect(
      buildLeftEntries({
        orderedProjects: projects,
        personalProjectId: "proj_personal",
        currentProjectId: null,
        query: "",
      }).map((entry) => entry.key),
    ).toEqual(["browse", "personal", "pinned", "unread", "proj_a", "proj_b"]);
    expect(
      buildLeftEntries({
        orderedProjects: projects,
        personalProjectId: null,
        currentProjectId: null,
        query: "",
      }).map((entry) => entry.key),
    ).toEqual(["browse", "pinned", "unread", "proj_a", "proj_b"]);
  });

  it("filters to matching projects only, and switches to path mode for paths", () => {
    expect(
      buildLeftEntries({
        orderedProjects: projects,
        personalProjectId: "proj_personal",
        currentProjectId: null,
        query: "mbp",
      }).map((entry) => entry.key),
    ).toEqual(["proj_a"]);
    expect(
      buildLeftEntries({
        orderedProjects: projects,
        personalProjectId: null,
        currentProjectId: null,
        query: "~/dev",
      }).map((entry) => entry.kind),
    ).toEqual(["path", "browse"]);
  });

  it("leads the projects with the current one, in a group of its own", () => {
    const entries = buildLeftEntries({
      orderedProjects: projects,
      personalProjectId: null,
      currentProjectId: "proj_b",
      query: "",
    });
    expect(entries.map((entry) => [entry.key, entry.group])).toEqual([
      ["browse", "nav"],
      ["pinned", "nav"],
      ["unread", "nav"],
      ["proj_b", "current"],
      ["proj_a", "projects"],
    ]);
  });

  it("adds a thread-matches entry after the projects while filtering", () => {
    expect(
      buildLeftEntries({
        orderedProjects: projects,
        personalProjectId: null,
        currentProjectId: null,
        query: "hs",
        threadMatchCount: 2,
      }).map((entry) => [entry.kind, entry.label]),
    ).toEqual([
      ["project", "hss"],
      ["search", "Matching “hs”"],
    ]);
    expect(
      buildLeftEntries({
        orderedProjects: projects,
        personalProjectId: null,
        currentProjectId: null,
        query: "hs",
        threadMatchCount: 0,
      }).map((entry) => entry.kind),
    ).toEqual(["project"]);
  });
});

describe("threadRowsForEntry", () => {
  const threads = [
    makeSidebarThread({ id: "root", projectId: "proj_a", updatedAt: 3 }),
    makeSidebarThread({
      id: "child",
      projectId: "proj_b",
      parentThreadId: "root",
      updatedAt: 2,
    }),
    makeSidebarThread({ id: "other", projectId: "proj_b", updatedAt: 1 }),
    makeSidebarThread({ id: "hidden", projectId: "proj_a", isHidden: true }),
    makeSidebarThread({ id: "pinned", projectId: "proj_b", pinnedAt: 1 }),
  ];
  const resolveProjectId = createThreadProjectResolver(threads);

  it("nests a project's children under their parent and skips hidden threads", () => {
    expect(
      threadRowsForEntry({
        entry: {
          kind: "project",
          key: "proj_a",
          label: "a",
          group: "projects",
          project: project("proj_a", "a"),
        },
        threads,
        resolveProjectId,
      }).map((row) => [row.thread.id, row.depth]),
    ).toEqual([
      ["root", 0],
      ["child", 1],
    ]);
  });

  it("lists pinned threads across projects", () => {
    expect(
      threadRowsForEntry({
        entry: { kind: "pinned", key: "pinned", label: "Pinned", group: "nav" },
        threads,
        resolveProjectId,
      }).map((row) => row.thread.id),
    ).toEqual(["pinned"]);
  });

  it("lists unread finished then running Claude root threads across projects, skipping automation runs, most recent first", () => {
    const unread = [
      makeSidebarThread({
        id: "older",
        projectId: "proj_a",
        latestAttentionAt: 2,
        lastReadAt: 1,
      }),
      makeSidebarThread({
        id: "newer",
        projectId: "proj_b",
        latestAttentionAt: 3,
        lastReadAt: 1,
      }),
      makeSidebarThread({
        id: "read",
        projectId: "proj_a",
        latestAttentionAt: 3,
        lastReadAt: 3,
      }),
      makeSidebarThread({
        id: "running",
        projectId: "proj_a",
        status: "active",
        latestAttentionAt: 4,
        lastReadAt: 1,
      }),
      makeSidebarThread({
        id: "running-claude",
        projectId: "proj_b",
        providerId: "claude-code",
        status: "active",
        latestAttentionAt: 1,
        lastReadAt: 1,
      }),
      makeSidebarThread({
        id: "running-claude-child",
        projectId: "proj_b",
        providerId: "claude-code",
        parentThreadId: "running-claude",
        status: "active",
      }),
      makeSidebarThread({
        id: "automation-unread",
        projectId: "proj_a",
        originPluginId: "automations",
        latestAttentionAt: 4,
        lastReadAt: 1,
      }),
      makeSidebarThread({
        id: "automation-running",
        projectId: "proj_a",
        providerId: "claude-code",
        originPluginId: "automations",
        status: "active",
      }),
      makeSidebarThread({
        id: "idle-claude",
        projectId: "proj_b",
        providerId: "claude-code",
        latestAttentionAt: 1,
        lastReadAt: 1,
      }),
      makeSidebarThread({
        id: "child",
        projectId: "proj_a",
        parentThreadId: "older",
        latestAttentionAt: 4,
        lastReadAt: 1,
      }),
    ];
    expect(
      threadRowsForEntry({
        entry: { kind: "unread", key: "unread", label: "Unread", group: "nav" },
        threads: unread,
        resolveProjectId: createThreadProjectResolver(unread),
      }).map((row) => [row.thread.id, row.section]),
    ).toEqual([
      ["newer", "attention"],
      ["older", "attention"],
      ["running-claude", "running"],
    ]);
  });
});

describe("thread sections", () => {
  const DAY = 86_400_000;
  const now = new Date(2026, 9, 9, 15, 0).getTime();
  const projectEntry = {
    kind: "project",
    key: "proj_a",
    label: "a",
    group: "projects",
    project: project("proj_a", "a"),
  } as const;

  function sections(threads: ReturnType<typeof makeSidebarThread>[]) {
    return threadRowsForEntry({
      entry: projectEntry,
      threads,
      resolveProjectId: createThreadProjectResolver(threads),
      now,
    }).map((row) => [row.thread.id, row.section]);
  }

  it("puts threads that need you, then running ones, above the rest by age", () => {
    expect(
      sections([
        makeSidebarThread({ id: "old", projectId: "proj_a", latestAttentionAt: now - 30 * DAY, lastReadAt: now }),
        makeSidebarThread({ id: "week", projectId: "proj_a", latestAttentionAt: now - 3 * DAY, lastReadAt: now }),
        makeSidebarThread({ id: "yesterday", projectId: "proj_a", latestAttentionAt: now - DAY, lastReadAt: now }),
        makeSidebarThread({ id: "today", projectId: "proj_a", latestAttentionAt: now - 60_000, lastReadAt: now }),
        makeSidebarThread({ id: "running", projectId: "proj_a", status: "active", latestAttentionAt: now - 30 * DAY, lastReadAt: now }),
        makeSidebarThread({ id: "asking", projectId: "proj_a", hasPendingInteraction: true, status: "active", latestAttentionAt: now - 30 * DAY, lastReadAt: now }),
        makeSidebarThread({ id: "unread", projectId: "proj_a", latestAttentionAt: now - 10 * DAY, lastReadAt: 0 }),
      ]),
    ).toEqual([
      ["asking", "attention"],
      ["unread", "attention"],
      ["running", "running"],
      ["today", "today"],
      ["yesterday", "yesterday"],
      ["week", "week"],
      ["old", "older"],
    ]);
  });

  it("files a root by anything under it, and keeps children with their root", () => {
    expect(
      sections([
        makeSidebarThread({ id: "root", projectId: "proj_a", latestAttentionAt: now - 30 * DAY, lastReadAt: now }),
        makeSidebarThread({ id: "child", projectId: "proj_a", parentThreadId: "root", status: "active", latestAttentionAt: now - 30 * DAY }),
        makeSidebarThread({ id: "fresh", projectId: "proj_a", latestAttentionAt: now - 60_000, lastReadAt: now }),
      ]),
    ).toEqual([
      ["root", "running"],
      ["child", "running"],
      ["fresh", "today"],
    ]);
  });
});

describe("searchThreads", () => {
  const threads = [
    makeSidebarThread({ id: "kanban", title: "Make the kanban board navigable", latestAttentionAt: 1 }),
    makeSidebarThread({
      id: "branch",
      title: "Something else",
      latestAttentionAt: 3,
      environment: {
        id: "env",
        name: null,
        branchName: "bb/kanban-review",
        path: null,
        isWorktree: true,
        providerId: null,
        workspaceDisplayKind: "other",
      },
    }),
    makeSidebarThread({ id: "hidden", title: "kanban helper", isHidden: true }),
  ];

  it("matches every term in the title or branch, most recent first", () => {
    expect(searchThreads(threads, "kanban").map((thread) => thread.id)).toEqual([
      "branch",
      "kanban",
    ]);
    expect(searchThreads(threads, "board kanban").map((thread) => thread.id)).toEqual([
      "kanban",
    ]);
    expect(searchThreads(threads, "~/dev")).toEqual([]);
  });
});

describe("entryProjectId", () => {
  it("starts new threads in the selected project, else the active one", () => {
    const [browse, personal, pinned, unread, projectEntry] = buildLeftEntries({
      orderedProjects: [project("proj_a", "alpha")],
      personalProjectId: "proj_me",
      currentProjectId: null,
      query: "",
    });
    expect(
      [browse, personal, pinned, unread, projectEntry, undefined].map(
        (entry) => entryProjectId(entry, "proj_active"),
      ),
    ).toEqual([
      "proj_active",
      "proj_me",
      "proj_active",
      "proj_active",
      "proj_a",
      "proj_active",
    ]);
  });
});

describe("filters and formatting", () => {
  it("matches by subsequence", () => {
    expect(fuzzyMatches("Fix the kanban review", "kbrv")).toBe(true);
    expect(fuzzyMatches("Fix the kanban review", "zz")).toBe(false);
  });

  it("formats ages compactly", () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    expect(formatAge(now - 5_000, now)).toBe("now");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(formatAge(now - 2 * 86_400_000, now)).toBe("2d");
    expect(formatAge(now - 9 * 86_400_000, now)).toBe("1w");
  });
});
