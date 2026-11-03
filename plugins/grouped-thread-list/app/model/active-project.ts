import type { SidebarThread } from "./sidebar-thread.js";
import { createSidebarProjectIdResolver } from "./project-thread-groups.js";

interface ProjectShape {
  id: string;
  name: string;
  isPersonal: boolean;
}

export type SidebarProjectIdResolver = (thread: SidebarThread) => string;

export function createThreadProjectResolver(
  threads: readonly SidebarThread[],
): SidebarProjectIdResolver {
  return createSidebarProjectIdResolver(
    new Map(threads.map((thread) => [thread.id, thread])),
  );
}

export function latestActivityByProject(
  threads: readonly SidebarThread[],
  resolveProjectId: SidebarProjectIdResolver,
): Map<string, number> {
  const latest = new Map<string, number>();
  for (const thread of threads) {
    if (thread.isHidden) continue;
    const projectId = resolveProjectId(thread);
    const at = Math.max(thread.updatedAt, thread.latestAttentionAt);
    if (at > (latest.get(projectId) ?? -Infinity)) latest.set(projectId, at);
  }
  return latest;
}

/** Most recently active first; projects without threads follow by name. */
export function orderProjectsByActivity<Project extends ProjectShape>(
  projects: readonly Project[],
  latestActivity: ReadonlyMap<string, number>,
): Project[] {
  return projects
    .filter((project) => !project.isPersonal)
    .sort((left, right) => {
      const leftAt = latestActivity.get(left.id);
      const rightAt = latestActivity.get(right.id);
      if (leftAt !== undefined && rightAt !== undefined && leftAt !== rightAt) {
        return rightAt - leftAt;
      }
      if (leftAt !== undefined && rightAt === undefined) return -1;
      if (leftAt === undefined && rightAt !== undefined) return 1;
      return left.name.localeCompare(right.name);
    });
}

/**
 * A stored id that no longer names a project (removed, or never set) falls
 * back to the most recently active project so the list is never empty while
 * projects exist.
 */
export function resolveActiveProjectId(
  storedProjectId: string | null,
  projects: readonly ProjectShape[],
  latestActivity: ReadonlyMap<string, number>,
): string | null {
  const standard = projects.filter((project) => !project.isPersonal);
  if (
    storedProjectId !== null &&
    standard.some((project) => project.id === storedProjectId)
  ) {
    return storedProjectId;
  }
  return orderProjectsByActivity(standard, latestActivity)[0]?.id ?? null;
}
