import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import { useEffect, useSyncExternalStore } from "react";
import { cycleAction, type FinishAction } from "./actions.js";
import type { Resolved, rpcContract } from "./contract.js";

type Rpc = PluginRpcClient<typeof rpcContract>;

/**
 * One cache of resolved actions for the composer chip, the thread menus and the commands, so a pick in one shows in
 * the others at once. Commands run outside React and so can't call `useRpc`; they use the client the last mounted
 * surface bound, and the thread-menu registration mounts app-wide whenever a thread is on screen.
 */
let client: Rpc | null = null;
let entries = new Map<string, Resolved>();
const listeners = new Set<() => void>();

export function bindRpc(rpc: Rpc): void {
  client = rpc;
}

function publish(resolved: readonly Resolved[]): void {
  if (resolved.length === 0) return;
  entries = new Map(entries);
  for (const entry of resolved) entries.set(entry.threadId, entry);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const cached = (threadId: string): Resolved | undefined => entries.get(threadId);

/** Loads the threads not cached yet, or all of them with `refresh`. */
export async function load(threadIds: readonly string[], refresh = false): Promise<void> {
  const wanted = refresh ? [...threadIds] : threadIds.filter((threadId) => !entries.has(threadId));
  if (client === null || wanted.length === 0) return;
  const { threads } = await client.call("resolve", { threadIds: wanted.slice(0, 200) });
  publish(threads);
}

/** A null action clears the thread's own pick, so it follows its project's default again. */
export async function pick(threadId: string, action: FinishAction | null): Promise<void> {
  if (client === null) return;
  publish([await client.call("set", { threadId, action })]);
}

export async function cycle(threadId: string, step: 1 | -1): Promise<void> {
  if (!entries.has(threadId)) await load([threadId]);
  const current = entries.get(threadId);
  if (current === undefined || !current.applies) return;
  await pick(threadId, cycleAction(current.action, step));
}

/** Makes the thread's current action its project's default, so the project's other threads follow it too. */
export async function makeProjectDefault(threadId: string, projectId: string): Promise<void> {
  const current = entries.get(threadId);
  if (client === null || current === undefined || !current.applies) return;
  await client.call("setProjectDefault", { projectId, action: current.action });
  // Every cached thread of the project may follow the new default.
  await load([...entries.keys()], true);
}

export function useResolved(threadId: string): Resolved | undefined {
  return useSyncExternalStore(subscribe, () => entries.get(threadId));
}

/** Every cached entry, loading the ids not cached yet; for the thread menus' app-wide `useData`. */
export function useResolvedMap(threadIds: readonly string[]): ReadonlyMap<string, Resolved> {
  const snapshot = useSyncExternalStore(subscribe, () => entries);
  const key = threadIds.join(",");
  useEffect(() => {
    // A failed load leaves those menus without the entry; the next change of the visible set retries.
    load(threadIds).catch(() => undefined);
  }, [key]);
  return snapshot;
}

/** For tests: forget every cached entry and the bound client. */
export function resetStore(): void {
  client = null;
  entries = new Map();
  listeners.clear();
}
