import {
  PROJECTS_GROUP_SECTION_ID,
  type SidebarSectionId,
} from "./sidebar-section-id.js";

export function isProjectSectionId(id: string): id is `project:${string}` {
  return id.startsWith("project:");
}

interface GroupProjectSectionOrderArgs {
  order: readonly SidebarSectionId[];
  includeProjects: boolean;
}

/**
 * Collapses every project entry of a flat project-mode order into one
 * Projects group entry, placed where the first project sat. With
 * `includeProjects`, the projects follow the group entry so a single list can
 * drive both group and project reordering.
 */
export function groupProjectSectionOrder({
  order,
  includeProjects,
}: GroupProjectSectionOrderArgs): SidebarSectionId[] {
  const projectIds = order.filter(isProjectSectionId);
  if (projectIds.length === 0) return [...order];
  const grouped: SidebarSectionId[] = [];
  for (const id of order) {
    if (!isProjectSectionId(id)) {
      grouped.push(id);
    } else if (id === projectIds[0]) {
      grouped.push(PROJECTS_GROUP_SECTION_ID);
      if (includeProjects) grouped.push(...projectIds);
    }
  }
  return grouped;
}

interface ExpandProjectSectionOrderArgs {
  groupedOrder: readonly SidebarSectionId[];
  projectIds: readonly SidebarSectionId[];
}

/**
 * Inverse of `groupProjectSectionOrder`: the group entry's position decides
 * where projects sit, and the projects keep the relative order they have in
 * `groupedOrder`. A project dragged outside the group therefore snaps back
 * inside it. `projectIds` supplies the projects when the grouped order omits
 * them because the group is collapsed.
 */
export function expandProjectSectionOrder({
  groupedOrder,
  projectIds,
}: ExpandProjectSectionOrderArgs): SidebarSectionId[] {
  const groupedProjectIds = groupedOrder.filter(isProjectSectionId);
  const orderedProjectIds =
    groupedProjectIds.length > 0 ? groupedProjectIds : projectIds;
  if (!groupedOrder.includes(PROJECTS_GROUP_SECTION_ID)) {
    return [...groupedOrder];
  }
  const expanded: SidebarSectionId[] = [];
  for (const id of groupedOrder) {
    if (id === PROJECTS_GROUP_SECTION_ID) {
      expanded.push(...orderedProjectIds);
    } else if (!isProjectSectionId(id)) {
      expanded.push(id);
    }
  }
  return expanded;
}
