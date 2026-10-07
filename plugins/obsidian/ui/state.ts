import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { VAULT_CHANGED, type VaultChangedPayload, type VaultTree } from "../contract";
import { createResolver, isNotePath, parseHeadings, slugifyHeading, type LinkResolver } from "../shared/obsidian";

export const PANEL_PATH = "vault";

export type VaultRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host percent-encodes subPath when navigating but hands it back still encoded. */
export function decodeNotePath(subPath: string): string {
  return subPath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

export interface NavigationTarget {
  line?: number;
  heading?: string;
  /** Block id without the leading "^". */
  block?: string;
}

export function targetFromSubpath(subpath: string | null): NavigationTarget | undefined {
  if (subpath === null || subpath === "") return undefined;
  return subpath.startsWith("^") ? { block: subpath.slice(1) } : { heading: subpath };
}

/** Zero-based line a navigation target points at in `content`, or null. */
export function resolveTargetLine(content: string, target: NavigationTarget): number | null {
  if (target.line !== undefined) return target.line;
  const lines = content.split("\n");
  if (target.block !== undefined) {
    const marker = ` ^${target.block.toLowerCase()}`;
    const index = lines.findIndex((line) => line.trimEnd().toLowerCase().endsWith(marker));
    return index === -1 ? null : index;
  }
  if (target.heading !== undefined) {
    const wanted = slugifyHeading(target.heading);
    return parseHeadings(content).find((heading) => slugifyHeading(heading.text) === wanted)?.line ?? null;
  }
  return null;
}

type Listener = () => void;

function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * Cross-surface state shared by the page and its right-panel tabs, which the
 * host mounts as separate React roots.
 */
const liveDocs = createStore<ReadonlyMap<string, string>>(new Map());
const navigationRequests = createStore<{ path: string; target: NavigationTarget; seq: number } | null>(null);
let navigationSeq = 0;

export function publishLiveDoc(path: string, content: string): void {
  if (liveDocs.get().get(path) === content) return;
  const next = new Map(liveDocs.get());
  next.set(path, content);
  liveDocs.set(next);
}

export function useLiveDoc(path: string | null): string | null {
  const docs = useSyncExternalStore(liveDocs.subscribe, liveDocs.get);
  return path === null ? null : (docs.get(path) ?? null);
}

export function requestNavigation(path: string, target: NavigationTarget): void {
  navigationSeq += 1;
  navigationRequests.set({ path, target, seq: navigationSeq });
}

export function useNavigationRequest(path: string) {
  const request = useSyncExternalStore(navigationRequests.subscribe, navigationRequests.get);
  return request !== null && request.path === path ? request : null;
}

/** Each open note's "save now", so moves and deletes can save edits before touching the files. */
const noteFlushers = new Map<string, () => Promise<void>>();

export function registerNoteFlusher(path: string, flush: () => Promise<void>): () => void {
  noteFlushers.set(path, flush);
  return () => {
    if (noteFlushers.get(path) === flush) noteFlushers.delete(path);
  };
}

export async function flushOpenNotes(): Promise<void> {
  await Promise.all([...noteFlushers.values()].map((flush) => flush().catch(() => undefined)));
}

/** Marks a navigation request handled so reopening the note later doesn't jump again. */
export function consumeNavigation(seq: number): void {
  if (navigationRequests.get()?.seq === seq) navigationRequests.set(null);
}

export function useOpenNote() {
  const navigate = useBbNavigate();
  return useCallback(
    (path: string, options: { target?: NavigationTarget; replace?: boolean } = {}) => {
      if (options.target !== undefined) requestNavigation(path, options.target);
      navigate.toPluginPanel(PANEL_PATH, { subPath: path, replace: options.replace });
    },
    [navigate],
  );
}

/** Subscribes to vault change signals and re-syncs after a realtime reconnect. */
export function useVaultChanges(handler: (payload: VaultChangedPayload) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useRealtime(VAULT_CHANGED, (payload) => handlerRef.current(payload as VaultChangedPayload));
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (wasConnected.current) handlerRef.current({ paths: [], structural: true });
    wasConnected.current = true;
  }, [connection]);
}

export interface VaultStatus {
  vaultPath: string | null;
  vaultName: string | null;
  dailyFolder: string;
  todayKey: string;
}

export function useVault() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [tree, setTree] = useState<VaultTree | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshTree = useCallback(async () => {
    try {
      const nextStatus = await rpc.call("status");
      setStatus(nextStatus);
      if (nextStatus.vaultPath === null) {
        setTree(null);
        return;
      }
      setTree(await rpc.call("tree"));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [rpc]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  useVaultChanges((payload) => {
    if (payload.structural) void refreshTree();
  });

  const resolver = useMemo<LinkResolver>(
    () => createResolver(tree?.files.map((file) => file.path) ?? []),
    [tree],
  );
  const notePaths = useMemo(
    () => tree?.files.map((file) => file.path).filter(isNotePath) ?? [],
    [tree],
  );

  return { rpc, status, tree, resolver, notePaths, error, refreshTree };
}

let previewCache: { baseUrl: string; expiresAtMs: number } | null = null;
let previewPending: Promise<string> | null = null;

/** Base URL for serving vault files (images) to the browser; refreshed before expiry. */
export function usePreviewBase(rpc: VaultRpc): string | null {
  const [baseUrl, setBaseUrl] = useState<string | null>(
    previewCache !== null && previewCache.expiresAtMs - Date.now() > 60_000 ? previewCache.baseUrl : null,
  );
  useEffect(() => {
    if (baseUrl !== null) return;
    let cancelled = false;
    previewPending ??= rpc.call("previewBase").then(
      (result) => {
        previewCache = result;
        previewPending = null;
        return result.baseUrl;
      },
      (error) => {
        previewPending = null;
        throw error;
      },
    );
    previewPending.then(
      (url) => {
        if (!cancelled) setBaseUrl(url);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, baseUrl]);
  return baseUrl;
}

export function previewUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/?$/, "/") + path.split("/").map(encodeURIComponent).join("/");
}

const persistedStores = new Map<string, ReturnType<typeof createStore<unknown>>>();

/**
 * localStorage-backed state shared by every component using the same key, so
 * the page and the sidebar explorer stay in step (expanded folders, view mode).
 */
export function useLocalStorageState<T>(key: string, initial: T) {
  let store = persistedStores.get(key);
  if (store === undefined) {
    let value: unknown = initial;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null) value = JSON.parse(stored);
    } catch {
      // Unreadable or disabled storage falls back to the default.
    }
    store = createStore<unknown>(value);
    persistedStores.set(key, store);
  }
  const shared = store;
  const value = useSyncExternalStore(shared.subscribe, shared.get) as T;
  const setValue = useCallback(
    (next: T | ((current: T) => T)) => {
      const resolved = typeof next === "function" ? (next as (current: T) => T)(shared.get() as T) : next;
      shared.set(resolved);
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Storage can be full or disabled; the preference just won't persist.
      }
    },
    [shared, key],
  );
  return [value, setValue] as const;
}

/** The note the Vault page shows, so the sidebar explorer can highlight it. */
const currentNote = createStore<string | null>(null);

export function setCurrentNotePath(path: string | null): void {
  if (currentNote.get() !== path) currentNote.set(path);
}

export function useCurrentNotePath(): string | null {
  return useSyncExternalStore(currentNote.subscribe, currentNote.get);
}

/** Search text shared by whichever explorer is showing, so tag clicks land in it. */
const searchQuery = createStore("");
const searchFocusRequests = createStore(0);

export function useSearchQuery() {
  return [useSyncExternalStore(searchQuery.subscribe, searchQuery.get), searchQuery.set] as const;
}

export function requestSearchFocus(): void {
  searchFocusRequests.set(searchFocusRequests.get() + 1);
}

export function useSearchFocusRequest(): number {
  return useSyncExternalStore(searchFocusRequests.subscribe, searchFocusRequests.get);
}

/** A newly created note whose title should be focused when it opens. */
const titleFocus = createStore<string | null>(null);

export function requestTitleFocus(path: string): void {
  titleFocus.set(path);
}

export function useTitleFocusPath(): string | null {
  return useSyncExternalStore(titleFocus.subscribe, titleFocus.get);
}

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
