import { useMemo, useState } from "react";
import { commitRangeKey, type CommitRange, type DiffFile, type DiffResult } from "../types";
import type { DiffThread } from "./comments/threads";
import type { PlacedFinding } from "./findings/findings";
import { currentLoadedPatch, loadedPatchEntry, shownPatch, whitespaceKeep, whitespaceOnlyPaths, type LoadedPatch, type ShownPatch } from "./patches";

/**
 * The patches "Load diff" fetched, kept by the view rather than the file's section so search, suggestions and the
 * whitespace preference see them, and each file's patch as the view has it. A loaded patch lasts for the fetch of the
 * diff it was loaded in, and past a refetch only while its file is pinned unchanged (see `currentLoadedPatch`).
 */
export function useLoadedPatches(diff: DiffResult | null, range: CommitRange | null) {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, LoadedPatch>>(() => new Map());
  const keyOf = (path: string) => `${commitRangeKey(range)}:${path}`;
  const loadedPatchOf = (file: DiffFile): string | null => (diff === null ? null : currentLoadedPatch(loaded.get(keyOf(file.path)), file, diff));
  const rememberLoadedPatch = (file: DiffFile, patch: string) => {
    if (diff !== null) setLoaded((current) => new Map(current).set(keyOf(file.path), loadedPatchEntry(file, diff, patch)));
  };
  /** Each file's patch, the diff's own or a loaded one, by path. */
  const rawPatches = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const file of diff?.files ?? []) {
      const patch = file.patch ?? loadedPatchOf(file);
      if (patch !== null) byPath.set(file.path, patch);
    }
    return byPath;
  }, [diff, loaded, range]);
  const whitespaceOnly = useMemo(() => whitespaceOnlyPaths(diff?.files ?? [], (file) => rawPatches.get(file.path) ?? null), [diff, rawPatches]);
  return { rawPatches, whitespaceOnly, loadedPatchOf, rememberLoadedPatch };
}

/** Each file's patch as drawn: a hunk whose changes are all whitespace still shows while a comment or finding sits on one of its lines. */
export function useShownPatches({
  rawPatches,
  hideWhitespace,
  whitespaceOnly,
  threadsByPath,
  findingsByPath,
}: {
  rawPatches: ReadonlyMap<string, string>;
  hideWhitespace: boolean;
  whitespaceOnly: ReadonlySet<string>;
  threadsByPath: ReadonlyMap<string, readonly DiffThread[]>;
  findingsByPath: ReadonlyMap<string, readonly PlacedFinding[]>;
}): ReadonlyMap<string, ShownPatch> {
  return useMemo(() => {
    const byPath = new Map<string, ShownPatch>();
    for (const [path, raw] of rawPatches) {
      const keep = whitespaceKeep(threadsByPath.get(path) ?? [], findingsByPath.get(path) ?? []);
      byPath.set(path, shownPatch(raw, hideWhitespace, whitespaceOnly.has(path), keep));
    }
    return byPath;
  }, [rawPatches, hideWhitespace, whitespaceOnly, threadsByPath, findingsByPath]);
}
