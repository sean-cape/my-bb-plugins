import { useCallback, useEffect, useReducer } from "react";

const STORAGE_PREFIX = "bb-plugin-grpc-client:";

// localStorage-backed state shared by every hook reading the same key, so a
// write from one place (opening a history entry) updates all readers.
const storageListeners = new Set<(key: string) => void>();
const storageCache = new Map<string, { raw: string | null; value: unknown }>();

export function readStored<T>(key: string, fallback: T): T {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    // Storage can be unavailable; fall back to the default.
  }
  const cached = storageCache.get(key);
  if (cached !== undefined && cached.raw === raw) return cached.value as T;
  if (raw === null) return fallback;
  try {
    const value = JSON.parse(raw) as T;
    storageCache.set(key, { raw, value });
    return value;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable or full; the value then lasts only until reload.
    storageCache.set(key, { raw: null, value });
  }
  for (const listener of storageListeners) listener(key);
}

export function useStored<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const listener = (changed: string) => {
      if (changed === key) rerender();
    };
    storageListeners.add(listener);
    return () => {
      storageListeners.delete(listener);
    };
  }, [key]);
  const update = useCallback((next: T) => writeStored(key, next), [key]);
  return [readStored(key, fallback), update];
}
