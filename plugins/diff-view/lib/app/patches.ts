// Each file's patch as the view draws and searches it: the diff's own, or the one "Load diff" fetched, with whitespace
// changes made context while they are hidden. Pure, for the tests.
import type { DiffFile, DiffResult, DiffSide } from "../types";
import { rowKey } from "./text/patch-rows";
import { ignoreWhitespacePatch, onlyWhitespaceChanged, patchHasChanges } from "./text/whitespace";

export interface ShownPatch {
  /** Whitespace pairs made context while whitespace is hidden; null when nothing is left to draw. */
  patch: string | null;
  /** Every change is whitespace, and whitespace is hidden. */
  onlyWhitespace: boolean;
  /** The drawn patch adds or deletes lines. */
  changed: boolean;
}

/** A patch "Load diff" fetched, with what it was fetched against. */
export interface LoadedPatch {
  fetchedAt: number;
  fingerprint: string | null;
  patch: string;
}

/**
 * What pins a file's patch across refetches: its counts at a known head commit. Null for a diff of a working tree (no
 * head sha), whose files can change under the same counts, and for a file with no counted lines (a name-status listing).
 */
function fingerprintOf(file: DiffFile, diff: DiffResult): string | null {
  if (diff.headSha === null || file.additions + file.deletions === 0) return null;
  return `${diff.headSha}:${file.status}:${file.additions}:${file.deletions}`;
}

export function loadedPatchEntry(file: DiffFile, diff: DiffResult, patch: string): LoadedPatch {
  return { fetchedAt: diff.fetchedAt, fingerprint: fingerprintOf(file, diff), patch };
}

/** A loaded patch still good for this fetch of the diff: the same fetch, or a refetch that pins the file unchanged. */
export function currentLoadedPatch(entry: LoadedPatch | undefined, file: DiffFile, diff: DiffResult): string | null {
  if (entry === undefined) return null;
  if (entry.fetchedAt === diff.fetchedAt) return entry.patch;
  return entry.fingerprint !== null && entry.fingerprint === fingerprintOf(file, diff) ? entry.patch : null;
}

/** The files whose every change is whitespace, by their patch as the view has it. */
export function whitespaceOnlyPaths(files: readonly DiffFile[], patchOf: (file: DiffFile) => string | null): ReadonlySet<string> {
  return new Set(files.filter((file) => onlyWhitespaceChanged(patchOf(file))).map((file) => file.path));
}

/** The lines a hunk whose changes are all whitespace stays drawn for: a thread's, on its side, and a finding's, on the new side. */
export function whitespaceKeep(threads: readonly { side: DiffSide; line: number | null }[], findings: readonly { line: number | null }[]): (side: DiffSide, line: number) => boolean {
  const marked = new Set([...threads.flatMap((thread) => (thread.line === null ? [] : [rowKey(thread.side, thread.line)])), ...findings.flatMap((entry) => (entry.line === null ? [] : [rowKey("RIGHT", entry.line)]))]);
  return (side, line) => marked.has(rowKey(side, line));
}

/** One file's patch as drawn: as it is, or with whitespace changes made context outside the lines `keep` holds. */
export function shownPatch(raw: string, hideWhitespace: boolean, onlyWhitespace: boolean, keep: (side: DiffSide, line: number) => boolean): ShownPatch {
  if (!hideWhitespace) return { patch: raw, onlyWhitespace: false, changed: patchHasChanges(raw) };
  const patch = ignoreWhitespacePatch(raw, keep);
  return { patch, onlyWhitespace, changed: patch !== null && patchHasChanges(patch) };
}
