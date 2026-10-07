export const PROJECTS_GROUP_SECTION_ID = "projects";

export type SidebarSectionId =
  | "pinned"
  | "threads"
  | typeof PROJECTS_GROUP_SECTION_ID
  | `project:${string}`
  | `section:${string}`
  | `machine:${string}`;
export type CollapsibleSidebarSectionId = "pinned" | "threads";
