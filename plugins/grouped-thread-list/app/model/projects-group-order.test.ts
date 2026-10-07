import { describe, expect, it } from "vitest";
import {
  expandProjectSectionOrder,
  groupProjectSectionOrder,
} from "./projects-group-order.js";
import type { SidebarSectionId } from "./sidebar-section-id.js";

const FLAT: SidebarSectionId[] = [
  "pinned",
  "project:a",
  "project:b",
  "threads",
  "project:c",
];

describe("groupProjectSectionOrder", () => {
  it("replaces the projects with one group entry where the first project sat", () => {
    expect(groupProjectSectionOrder({ order: FLAT, includeProjects: false })).toEqual(
      ["pinned", "projects", "threads"],
    );
  });

  it("keeps the projects after the group entry when asked", () => {
    expect(groupProjectSectionOrder({ order: FLAT, includeProjects: true })).toEqual([
      "pinned",
      "projects",
      "project:a",
      "project:b",
      "project:c",
      "threads",
    ]);
  });

  it("leaves an order without projects alone", () => {
    expect(
      groupProjectSectionOrder({
        order: ["pinned", "threads"],
        includeProjects: true,
      }),
    ).toEqual(["pinned", "threads"]);
  });
});

describe("expandProjectSectionOrder", () => {
  const projectIds: SidebarSectionId[] = ["project:a", "project:b", "project:c"];

  it("round-trips a grouped order", () => {
    const grouped = groupProjectSectionOrder({ order: FLAT, includeProjects: true });
    expect(expandProjectSectionOrder({ groupedOrder: grouped, projectIds })).toEqual([
      "pinned",
      "project:a",
      "project:b",
      "project:c",
      "threads",
    ]);
  });

  it("moves every project with the group entry", () => {
    expect(
      expandProjectSectionOrder({
        groupedOrder: ["pinned", "project:a", "project:b", "threads", "projects", "project:c"],
        projectIds,
      }),
    ).toEqual(["pinned", "threads", "project:a", "project:b", "project:c"]);
  });

  it("keeps a reordered project inside the group", () => {
    expect(
      expandProjectSectionOrder({
        groupedOrder: ["project:c", "pinned", "projects", "project:a", "project:b", "threads"],
        projectIds,
      }),
    ).toEqual(["pinned", "project:c", "project:a", "project:b", "threads"]);
  });

  it("uses the given projects when the collapsed group omits them", () => {
    expect(
      expandProjectSectionOrder({
        groupedOrder: ["projects", "pinned", "threads"],
        projectIds,
      }),
    ).toEqual(["project:a", "project:b", "project:c", "pinned", "threads"]);
  });
});
