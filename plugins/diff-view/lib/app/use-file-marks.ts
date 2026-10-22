import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DiffFile, DiffResult } from "../types";
import { errorMessage } from "./format";
import { startsCollapsed } from "./generated";
import { flipped, withMembers } from "./sets";
import type { DiffSource } from "./source";

/**
 * Which files are marked viewed and which are collapsed. Viewed, generated and very large files start collapsed; marking
 * a file viewed collapses it and unmarking expands it, but the user can still open or close any file by hand.
 * `alsoCollapsed` names more files to start collapsed, read when a diff arrives.
 */
export function useFileMarks(source: DiffSource, diff: DiffResult | null, alsoCollapsed?: (file: DiffFile) => boolean) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const headSha = diff?.headSha ?? null;
  const generatedCollapsedFor = useRef<string | null>(null);
  useEffect(() => {
    if (diff === null) return;
    const key = `${headSha ?? "env"}:${diff.files.length}`;
    if (generatedCollapsedFor.current === key) return;
    generatedCollapsedFor.current = key;
    const closed = diff.files.filter((entry) => startsCollapsed(entry) || alsoCollapsed?.(entry) === true).map((entry) => entry.path);
    if (closed.length > 0) setCollapsed((current) => new Set([...current, ...closed]));
  }, [diff, headSha]);
  // Environment diffs have no head sha, so marks are refetched with every diff load; the source decides which survive.
  const viewedKey = headSha ?? diff?.fetchedAt ?? null;
  useEffect(() => {
    if (viewedKey === null) return;
    source.listViewed().then(
      (paths) => {
        setViewed(new Set(paths));
        setCollapsed((current) => new Set([...current, ...paths]));
      },
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
  }, [source, viewedKey]);
  const markViewed = (path: string, isViewed: boolean) => {
    setViewed((current) => withMembers(current, [path], isViewed));
    setCollapsed((current) => withMembers(current, [path], isViewed));
    source.setViewed(path, isViewed).then(
      (paths) => setViewed(new Set(paths)),
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
  };
  const toggleCollapsed = (path: string) => setCollapsed((current) => flipped(current, path));
  const expand = (path: string) => setCollapsed((current) => withMembers(current, [path], false));
  const setCollapsedPaths = (paths: readonly string[], isCollapsed: boolean) => setCollapsed((current) => withMembers(current, paths, isCollapsed));
  return { viewed, collapsed, markViewed, toggleCollapsed, expand, setCollapsedPaths };
}
