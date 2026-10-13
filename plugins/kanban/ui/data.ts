import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useBbNavigate, experimental_usePluginId as usePluginId, experimental_useSidebarThreadActions as useSidebarThreadActions, experimental_useSidebarThreads as useSidebarThreads, useRealtime, useRpc, useSdk,  } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import type { Board } from "../shared/board";
import { BOARD_CHANGED } from "../shared/events";
import { errorMessage } from "./format";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export interface ProjectOption {
  id: string;
  name: string;
}

export function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("board_get").then(
      (next) => {
        setBoard(next);
        setError(null);
      },
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(BOARD_CHANGED, refetch);
  return { rpc, board, setBoard, error, refetch };
}

const projectListeners = new Set<() => void>();
let projectsVersion = 0;

function subscribeProjects(listener: () => void): () => void {
  projectListeners.add(listener);
  return () => projectListeners.delete(listener);
}

/** Every `useProjects` refetches, so a project made from one picker shows up in the others. */
function refreshProjects(): void {
  projectsVersion += 1;
  for (const listener of projectListeners) listener();
}

export function useProjects(): ProjectOption[] {
  const sdk = useSdk();
  const version = useSyncExternalStore(subscribeProjects, () => projectsVersion);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    sdk.projects.list().then(
      (list) => {
        if (cancelled) return;
        setProjects(list.map((project) => ({ id: project.id, name: project.name })));
      },
      () => {
        if (!cancelled) setProjects([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, version]);
  return projects;
}

/**
 * Opens the host's native folder picker and makes a project of the chosen directory, named after it as bb's own
 * "Add project" does. Resolves null when the picker is cancelled.
 */
export function useCreateProjectFromFolder(): () => Promise<ProjectOption | null> {
  const sdk = useSdk();
  return useCallback(async () => {
    const { primaryHostId } = await sdk.system.config();
    if (primaryHostId === null) throw new Error("bb has no primary host to pick a folder on");
    // The server only opens the picker when the asking client and the work host are the same machine.
    const { path } = await sdk.hosts.pickFolder({ hostId: primaryHostId, clientHostId: primaryHostId });
    if (path === null) return null;
    const name = path.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop()?.trim() ?? "";
    if (name === "") throw new Error(`Cannot name a project after ${path}`);
    const created = await sdk.projects.create({ name, source: { type: "local_path", hostId: primaryHostId, path } });
    refreshProjects();
    return { id: created.id, name: created.name };
  }, [sdk]);
}

export function useThreadIndex(): ReadonlyMap<string, PluginSidebarThread> {
  const { threads } = useSidebarThreads({ experimental_lifecycles: ["active", "archived"] });
  return useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
}

/** Sidebar `open` silently ignores threads the sidebar does not list, which includes every hidden code review thread. */
export function useOpenThread(): (threadId: string) => void {
  const actions = useSidebarThreadActions();
  const navigate = useBbNavigate();
  const threads = useThreadIndex();
  return useCallback(
    (threadId: string) => {
      if (threads.has(threadId)) actions.open(threadId);
      else navigate.toThread(threadId);
    },
    [actions, navigate, threads],
  );
}

/** "Push after applying" is a per-user habit, so it lives in localStorage rather than on the card. */
export function usePushPreference(): [boolean, (next: boolean) => void] {
  const pluginId = usePluginId();
  const key = `${pluginId}:pushAfterApply`;
  const [push, setPush] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(key) !== "false";
    } catch {
      return true;
    }
  });
  const update = (next: boolean) => {
    setPush(next);
    try {
      window.localStorage.setItem(key, String(next));
    } catch {
      // Private mode or quota: keep the in-memory value for this session.
    }
  };
  return [push, update];
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
