import { useMemo, useSyncExternalStore } from "react";
import type { DiffResult } from "../../types";
import type { DiffThread } from "../comments/threads";
import { NO_FILE_FILTER, fileFilterActive, fileShown, filterFiles, pruneFileFilter, readFileFilter, subscribeFileFilters, writeFileFilter, type FileFilter, type FileMarks } from "../file-filter";
import type { PlacedFinding } from "../findings/findings";

/**
 * The view's file filter, kept per view instance for the session, and the files it leaves in: the tree, the scroll, the
 * cursor's motions, `f` and `/` all go by `shownFiles`.
 */
export function useFileFilter({
  instanceKey,
  diff,
  viewed,
  allThreads,
  findingsByPath,
  changedSince,
  notify,
}: {
  instanceKey: string;
  diff: DiffResult | null;
  viewed: ReadonlySet<string>;
  allThreads: readonly DiffThread[];
  findingsByPath: ReadonlyMap<string, readonly PlacedFinding[]>;
  changedSince: ReadonlySet<string>;
  notify: (message: string) => void;
}) {
  const stored = useSyncExternalStore(subscribeFileFilters, () => readFileFilter(instanceKey));
  // "Only new" with nothing new (the head came back to the reviewed commit, a re-review caught up) is no filter.
  const fileFilter = useMemo(() => {
    const pruned = pruneFileFilter(stored, diff?.files ?? []);
    if (!pruned.onlyNew || changedSince.size > 0) return pruned;
    const off = { ...pruned, onlyNew: false };
    return fileFilterActive(off) ? off : NO_FILE_FILTER;
  }, [stored, diff, changedSince]);
  const setFileFilter = (filter: FileFilter) => writeFileFilter(instanceKey, filter);
  const fileMarks = useMemo(
    (): FileMarks => ({
      viewed,
      withComments: new Set(allThreads.map((thread) => thread.path)),
      withFindings: new Set([...findingsByPath].filter(([, list]) => list.length > 0).map(([path]) => path)),
      changedSince,
    }),
    [viewed, allThreads, findingsByPath, changedSince],
  );
  const shownFiles = useMemo(() => filterFiles(diff?.files ?? [], fileFilter, fileMarks), [diff, fileFilter, fileMarks]);
  /** Going to a file the filter leaves out clears the filter; true when it did, and the file mounts on the next render. */
  const unhide = (path: string): boolean => {
    const filter = readFileFilter(instanceKey);
    const file = diff?.files.find((entry) => entry.path === path);
    if (file === undefined || fileShown(file, filter, fileMarks)) return false;
    setFileFilter(NO_FILE_FILTER);
    notify(`File filter cleared to show ${path}`);
    return true;
  };
  return { fileFilter, setFileFilter, fileFiltered: fileFilterActive(fileFilter), fileMarks, shownFiles, unhide };
}
