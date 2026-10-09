import { useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { cx, EntranceScope, enter, exit, speed, stagger, STAGGER, useLateMount, useListKeys, usePresenceList, type PresenceEntry } from "bb-motion";
import { FIELD_ROW, FIXED_GROUP_ROW } from "./client-keys";

const LATE_ENTRANCE = cx(enter.rise, speed.fast);

/** A block that rises in when it appears in response to the user, but not with its surroundings. */
export function Appear({ className, children }: { className?: string; children: ReactNode }) {
  const late = useLateMount();
  return (
    <div className={cx(className, late && LATE_ENTRANCE)}>
      <EntranceScope>{children}</EntranceScope>
    </div>
  );
}

/**
 * `usePresenceList`, but only items removed through `remove(key)` play an exit.
 * Ones dropped by replacing the data wholesale (opening a history entry) just
 * go, rather than sinking out underneath their replacements.
 */
export function usePresenceRemovals<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): { entries: PresenceEntry<T>[]; onExited: (key: string) => void; remove: (key: string) => void } {
  const removed = useRef(new Set<string>());
  const { entries, onExited } = usePresenceList(items, keyOf);
  const exiting = new Set(entries.filter((entry) => entry.exiting).map((entry) => entry.key));
  for (const key of removed.current) if (!exiting.has(key)) removed.current.delete(key);
  const remove = useCallback((key: string) => {
    removed.current.add(key);
  }, []);
  return { entries: entries.filter((entry) => !entry.exiting || removed.current.has(entry.key)), onExited, remove };
}

export type PresenceValue<T> = { key: string; value: T; index: number; exiting: boolean };

/**
 * `usePresenceRemovals` for a list stored as bare values, keyed by position at
 * insertion. Call `forget(index)` just before removing that value from the
 * data; its ghost keeps the value and index it had.
 */
export function usePresenceValues<T>(values: readonly T[]): {
  rows: PresenceValue<T>[];
  onExited: (key: string) => void;
  forget: (index: number) => void;
} {
  const listKeys = useListKeys(values.length);
  const { entries, onExited, remove } = usePresenceRemovals(
    values.map((value, index) => ({ key: String(listKeys.keys[index]), value, index })),
    (entry) => entry.key,
  );
  const forget = (index: number) => {
    remove(String(listKeys.keys[index]));
    listKeys.forget(index);
  };
  return { rows: entries.map(({ key, item, exiting }) => ({ key, value: item.value, index: item.index, exiting })), onExited, forget };
}

/**
 * A row of a list kept by `usePresenceList`: rises in when added, cascades in
 * with the list's first show when given `cascadeIndex`, and once removed from
 * the data plays its exit as an inert ghost.
 */
export function PresenceRow({
  className,
  cascadeIndex,
  fieldRow,
  exiting,
  onExited,
  children,
}: {
  className?: string;
  cascadeIndex?: number;
  /** A stop for the request form's field cursor; a fixed group holds rows of its own. */
  fieldRow?: "item" | "fixedGroup";
  exiting: boolean;
  onExited: () => void;
  children: ReactNode;
}) {
  const late = useLateMount();
  const cascades = !exiting && !late && cascadeIndex !== undefined;
  return (
    <div
      {...(fieldRow === "item" ? FIELD_ROW : fieldRow === "fixedGroup" ? FIXED_GROUP_ROW : {})}
      className={cx(className, exiting ? exit.sink : late ? LATE_ENTRANCE : cascades && cx(enter.rise, STAGGER))}
      style={cascades ? stagger(cascadeIndex) : undefined}
      inert={exiting || undefined}
      aria-hidden={exiting || undefined}
      onAnimationEnd={(event) => {
        if (exiting && event.target === event.currentTarget) onExited();
      }}
    >
      <EntranceScope>{children}</EntranceScope>
    </div>
  );
}
