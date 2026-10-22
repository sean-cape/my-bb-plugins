// The files view's file filter, as GitHub's "Filter" menu on Files changed: which extensions and change types show,
// and whether viewed files, files without comments and files without findings are left out.
import type { DiffFile } from "../types";
import { flipped } from "./sets";
import type { Keymap } from "./ui/vim-keys-core";

export type ChangeType = "added" | "modified" | "renamed" | "deleted";

export const CHANGE_TYPES: readonly ChangeType[] = ["added", "modified", "renamed", "deleted"];

export const CHANGE_TYPE_LABEL: Record<ChangeType, string> = { added: "Added", modified: "Modified", renamed: "Renamed", deleted: "Deleted" };

/** The extension group of a file with none (a Makefile, a dotfile such as .gitignore). */
export const NO_EXTENSION = "";

export interface FileFilter {
  /** Extensions unticked, as `extensionOf` gives them; every other extension shows. */
  hiddenExtensions: ReadonlySet<string>;
  hiddenChangeTypes: ReadonlySet<ChangeType>;
  hideViewed: boolean;
  onlyComments: boolean;
  onlyFindings: boolean;
}

export const NO_FILE_FILTER: FileFilter = { hiddenExtensions: new Set(), hiddenChangeTypes: new Set(), hideViewed: false, onlyComments: false, onlyFindings: false };

/** What the filter reads about each file beyond the file itself. */
export interface FileMarks {
  viewed: ReadonlySet<string>;
  /** Paths with any comment thread, resolved and outdated ones included. */
  withComments: ReadonlySet<string>;
  /** Paths with a review finding shown in the diff. */
  withFindings: ReadonlySet<string>;
}

/** The lower-cased extension of a path's file name with its dot (".ts"); `NO_EXTENSION` when it has none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? NO_EXTENSION : name.slice(dot).toLowerCase();
}

export function changeTypeOf(file: Pick<DiffFile, "status">): ChangeType {
  switch (file.status) {
    case "added":
      return "added";
    case "removed":
    case "deleted":
      return "deleted";
    case "renamed":
    case "copied":
      return "renamed";
    default:
      return "modified";
  }
}

export function fileFilterActive(filter: FileFilter): boolean {
  return filter.hiddenExtensions.size > 0 || filter.hiddenChangeTypes.size > 0 || filter.hideViewed || filter.onlyComments || filter.onlyFindings;
}

export function fileShown(file: Pick<DiffFile, "path" | "status">, filter: FileFilter, marks: FileMarks): boolean {
  if (filter.hiddenExtensions.has(extensionOf(file.path))) return false;
  if (filter.hiddenChangeTypes.has(changeTypeOf(file))) return false;
  if (filter.hideViewed && marks.viewed.has(file.path)) return false;
  if (filter.onlyComments && !marks.withComments.has(file.path)) return false;
  if (filter.onlyFindings && !marks.withFindings.has(file.path)) return false;
  return true;
}

/** The files the filter leaves in, in diff order; the same array when nothing is filtered. */
export function filterFiles<File extends Pick<DiffFile, "path" | "status">>(files: File[], filter: FileFilter, marks: FileMarks): File[] {
  return fileFilterActive(filter) ? files.filter((file) => fileShown(file, filter, marks)) : files;
}

export interface FilterOption<Value> {
  value: Value;
  /** Files of the whole diff with this value, filtered or not. */
  count: number;
}

/** The menu's choices for a diff: each extension present (no extension last) and each change type present. */
export function filterOptions(files: readonly Pick<DiffFile, "path" | "status">[]): { extensions: FilterOption<string>[]; changeTypes: FilterOption<ChangeType>[] } {
  const extensions = new Map<string, number>();
  const types = new Map<ChangeType, number>();
  for (const file of files) {
    const extension = extensionOf(file.path);
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
    const type = changeTypeOf(file);
    types.set(type, (types.get(type) ?? 0) + 1);
  }
  return {
    extensions: [...extensions]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => (a.value === NO_EXTENSION ? 1 : b.value === NO_EXTENSION ? -1 : a.value.localeCompare(b.value))),
    changeTypes: CHANGE_TYPES.filter((type) => types.has(type)).map((value) => ({ value, count: types.get(value)! })),
  };
}

export function toggleExtension(filter: FileFilter, extension: string): FileFilter {
  return { ...filter, hiddenExtensions: flipped(filter.hiddenExtensions, extension) };
}

export function toggleChangeType(filter: FileFilter, type: ChangeType): FileFilter {
  return { ...filter, hiddenChangeTypes: flipped(filter.hiddenChangeTypes, type) };
}

/**
 * The filter as it applies to these files: unticked extensions and change types none of them has are dropped, so a
 * refresh or another commit range never shows a filter that leaves nothing out of its own choices. The same object
 * when nothing was dropped.
 */
export function pruneFileFilter(filter: FileFilter, files: readonly Pick<DiffFile, "path" | "status">[]): FileFilter {
  if (filter.hiddenExtensions.size === 0 && filter.hiddenChangeTypes.size === 0) return filter;
  const extensions = new Set(files.map((file) => extensionOf(file.path)));
  const types = new Set(files.map(changeTypeOf));
  const hiddenExtensions = [...filter.hiddenExtensions].filter((extension) => extensions.has(extension));
  const hiddenChangeTypes = [...filter.hiddenChangeTypes].filter((type) => types.has(type));
  if (hiddenExtensions.length === filter.hiddenExtensions.size && hiddenChangeTypes.length === filter.hiddenChangeTypes.size) return filter;
  const pruned = { ...filter, hiddenExtensions: new Set(hiddenExtensions), hiddenChangeTypes: new Set(hiddenChangeTypes) };
  return fileFilterActive(pruned) ? pruned : NO_FILE_FILTER;
}

/** Filters per view instance, kept for the session (not across reloads) so a side panel reopened keeps its filter. */
const filters = new Map<string, FileFilter>();
const listeners = new Set<() => void>();

export function readFileFilter(instanceKey: string): FileFilter {
  return filters.get(instanceKey) ?? NO_FILE_FILTER;
}

export function writeFileFilter(instanceKey: string, filter: FileFilter): void {
  if (fileFilterActive(filter)) filters.set(instanceKey, filter);
  else filters.delete(instanceKey);
  for (const listener of listeners) listener();
}

export function subscribeFileFilters(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type FileFilterMenuCommand = "tick" | "close";

/** The filter menu's own keys, beside the menu's j / k / gg / G: Space or Enter ticks the focused item, Escape or q closes. */
export const FILE_FILTER_MENU_KEYMAP: Keymap<FileFilterMenuCommand> = { "<Space>": "tick", "<CR>": "tick", "<Esc>": "close", q: "close" };
