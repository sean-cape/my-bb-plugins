import { useCallback, useEffect, useMemo } from "react";
import { useAtom } from "jotai";
import { activeProjectIdAtom } from "../preferences/atoms.js";
import { usePreferencesReady } from "../preferences/PreferencesSync.js";
import type { SidebarThread } from "./sidebar-thread.js";
import { useSidebarData, type SidebarProject } from "./use-sidebar-data.js";
import {
  createThreadProjectResolver,
  latestActivityByProject,
  orderProjectsByActivity,
  resolveActiveProjectId,
  type SidebarProjectIdResolver,
} from "./active-project.js";

export interface ActiveProjectState {
  activeProjectId: string | null;
  /** Each project's latest thread activity, the order `orderedProjects` uses. */
  latestActivity: ReadonlyMap<string, number>;
  personalProjectId: string | null;
  /** Standard projects, most recently active first. */
  orderedProjects: SidebarProject[];
  resolveProjectId: SidebarProjectIdResolver;
  setActiveProjectId: (projectId: string) => void;
  threads: SidebarThread[];
}

export function useActiveProject(): ActiveProjectState {
  const { status, projects, personalProject } = useSidebarData();
  const preferencesReady = usePreferencesReady();
  const [storedProjectId, setStoredProjectId] = useAtom(activeProjectIdAtom);
  const threads = useMemo<SidebarThread[]>(
    () => projects.flatMap((project) => project.threads),
    [projects],
  );
  const resolveProjectId = useMemo(
    () => createThreadProjectResolver(threads),
    [threads],
  );
  const latestActivity = useMemo(
    () => latestActivityByProject(threads, resolveProjectId),
    [resolveProjectId, threads],
  );
  const orderedProjects = useMemo(
    () => orderProjectsByActivity(projects, latestActivity),
    [latestActivity, projects],
  );
  const activeProjectId = resolveActiveProjectId(
    storedProjectId,
    projects,
    latestActivity,
  );
  // Persist the fallback so later activity in another project can't silently
  // move the list. Only an unset preference is filled in: a stored id missing
  // from the list may be a project created a moment ago that hasn't arrived.
  // Waiting for both loads keeps a guess from an empty list out of storage.
  useEffect(() => {
    if (!preferencesReady || status !== "ready") return;
    if (storedProjectId === null && activeProjectId !== null) {
      setStoredProjectId(activeProjectId);
    }
  }, [
    activeProjectId,
    preferencesReady,
    setStoredProjectId,
    status,
    storedProjectId,
  ]);
  const setActiveProjectId = useCallback(
    (projectId: string) => setStoredProjectId(projectId),
    [setStoredProjectId],
  );
  return {
    activeProjectId,
    latestActivity,
    personalProjectId: personalProject?.id ?? null,
    orderedProjects,
    resolveProjectId,
    setActiveProjectId,
    threads,
  };
}
