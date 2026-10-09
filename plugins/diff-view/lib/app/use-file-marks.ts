import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DiffResult } from "../types";
import { errorMessage } from "./format";
import { isGeneratedFile } from "./generated";
import type { DiffSource } from "./source";

function toggled(set: ReadonlySet<string>, path: string, present: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (present) next.add(path);
  else next.delete(path);
  return next;
}

/**
 * Which files are marked viewed and which are collapsed. Viewed and generated files start collapsed; marking a file
 * viewed collapses it and unmarking expands it, but the user can still open or close any file by hand.
 */
export function useFileMarks(source: DiffSource, diff: DiffResult | null) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const headSha = diff?.headSha ?? null;
  const generatedCollapsedFor = useRef<string | null>(null);
  useEffect(() => {
    if (diff === null) return;
    const key = `${headSha ?? "env"}:${diff.files.length}`;
    if (generatedCollapsedFor.current === key) return;
    generatedCollapsedFor.current = key;
    const generated = diff.files.filter(isGeneratedFile).map((entry) => entry.path);
    if (generated.length > 0) setCollapsed((current) => new Set([...current, ...generated]));
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
    setViewed((current) => toggled(current, path, isViewed));
    setCollapsed((current) => toggled(current, path, isViewed));
    source.setViewed(path, isViewed).then(
      (paths) => setViewed(new Set(paths)),
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
  };
  const toggleCollapsed = (path: string) => setCollapsed((current) => toggled(current, path, !current.has(path)));
  const expand = (path: string) => setCollapsed((current) => (current.has(path) ? toggled(current, path, false) : current));
  const setCollapsedPaths = (paths: readonly string[], isCollapsed: boolean) =>
    setCollapsed((current) => (paths.every((path) => current.has(path) === isCollapsed) ? current : new Set(isCollapsed ? [...current, ...paths] : [...current].filter((path) => !paths.includes(path)))));
  return { viewed, collapsed, markViewed, toggleCollapsed, expand, setCollapsedPaths };
}
