import type { SidebarThread } from "../model/sidebar-thread.js";
import type { SidebarProject } from "../model/use-sidebar-data.js";
import {
  buildThreadTree,
  compareStandardThreads,
  isSidebarProjectThread,
  type ProjectThreadNode,
} from "../model/project-thread-groups.js";
import { buildPinnedThreadTree } from "../model/pinned-sidebar-threads.js";
import {
  isRuntimeBusyThread,
  isUnreadDoneThread,
} from "../model/thread-activity.js";
import type { SidebarProjectIdResolver } from "../model/active-project.js";

export type PickerColumn = "left" | "right" | "preview";

/**
 * Which labelled run of the left column an entry sits in. "nav" entries come
 * first and carry no label; the current project gets a group of its own.
 */
export type LeftGroup = "nav" | "current" | "projects" | "threads";

export const LEFT_GROUP_LABELS: Record<Exclude<LeftGroup, "nav">, string> = {
  current: "Current",
  projects: "Projects",
  threads: "Threads",
};

type LeftEntryBase = { label: string; group: LeftGroup };

export type LeftEntry = LeftEntryBase &
  (
    | { kind: "pinned"; key: "pinned" }
    | { kind: "personal"; key: "personal"; projectId: string }
    | { kind: "unread"; key: "unread" }
    | { kind: "project"; key: string; project: SidebarProject }
    | { kind: "search"; key: "search"; query: string }
    | { kind: "path"; key: "path" }
    | { kind: "browse"; key: "browse" }
  );

/** Root threads are grouped under these, in this order; children follow their root. */
export type ThreadSection =
  | "attention"
  | "running"
  | "today"
  | "yesterday"
  | "week"
  | "older";

export const THREAD_SECTION_LABELS: Record<ThreadSection, string> = {
  attention: "Needs you",
  running: "Running",
  today: "Today",
  yesterday: "Yesterday",
  week: "Past week",
  older: "Older",
};

const SECTION_ORDER: readonly ThreadSection[] = [
  "attention",
  "running",
  "today",
  "yesterday",
  "week",
  "older",
];

export interface ThreadRowModel {
  thread: SidebarThread;
  depth: number;
  /** Null for lists kept in their own order, like Pinned. */
  section: ThreadSection | null;
}

export function looksLikePath(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/");
}

/** Subsequence match, so "mbp" finds "my-bb-plugins". */
export function fuzzyMatches(text: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  const haystack = text.toLocaleLowerCase();
  let index = 0;
  for (const char of needle) {
    index = haystack.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

/** Every whitespace-separated term appears in the title or branch. */
export function threadMatches(thread: SidebarThread, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u);
  const haystack = [thread.displayTitle, thread.environment?.branchName ?? ""]
    .join("\n")
    .toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Title matches across every project, most recently active first. */
export function searchThreads(
  threads: readonly SidebarThread[],
  query: string,
): SidebarThread[] {
  if (query.trim() === "" || looksLikePath(query)) return [];
  return threads
    .filter(
      (thread) => isSidebarProjectThread(thread) && threadMatches(thread, query),
    )
    .sort(
      (left, right) =>
        threadActivityAt(right) - threadActivityAt(left) ||
        compareStandardThreads(left, right),
    );
}

/**
 * The current project leads the projects so it is always one `j` below
 * Unread; the rest keep their recency order.
 */
export function buildLeftEntries({
  orderedProjects,
  personalProjectId,
  currentProjectId,
  query,
  threadMatchCount = 0,
}: {
  orderedProjects: readonly SidebarProject[];
  personalProjectId: string | null;
  currentProjectId: string | null;
  query: string;
  threadMatchCount?: number;
}): LeftEntry[] {
  if (looksLikePath(query)) {
    return [
      { kind: "path", key: "path", label: query.trim(), group: "nav" },
      { kind: "browse", key: "browse", label: "Open folder…", group: "nav" },
    ];
  }
  const entries: LeftEntry[] = [];
  const filtering = query.trim() !== "";
  if (!filtering) {
    entries.push({
      kind: "browse",
      key: "browse",
      label: "Open folder…",
      group: "nav",
    });
    if (personalProjectId !== null) {
      entries.push({
        kind: "personal",
        key: "personal",
        label: "Unassociated",
        projectId: personalProjectId,
        group: "nav",
      });
    }
    entries.push({ kind: "pinned", key: "pinned", label: "Pinned", group: "nav" });
    entries.push({ kind: "unread", key: "unread", label: "Unread", group: "nav" });
  }
  const current = orderedProjects.find(
    (project) => project.id === currentProjectId,
  );
  const projects =
    current === undefined
      ? orderedProjects
      : [current, ...orderedProjects.filter((project) => project !== current)];
  for (const project of projects) {
    if (!fuzzyMatches(project.name, query)) continue;
    entries.push({
      kind: "project",
      key: project.id,
      label: project.name,
      project,
      group: project === current ? "current" : "projects",
    });
  }
  if (filtering && threadMatchCount > 0) {
    entries.push({
      kind: "search",
      key: "search",
      label: `Matching “${query.trim()}”`,
      query,
      group: "threads",
    });
  }
  return entries;
}

function flattenNodes(
  nodes: readonly ProjectThreadNode[],
  depth: number,
  section: ThreadSection | null,
  rows: ThreadRowModel[],
) {
  for (const node of nodes) {
    rows.push({ thread: node.thread, depth, section });
    flattenNodes(node.children, depth + 1, section, rows);
  }
}

function flattenThreadTree(
  nodes: readonly ProjectThreadNode[],
): ThreadRowModel[] {
  const rows: ThreadRowModel[] = [];
  flattenNodes(nodes, 0, null, rows);
  return rows;
}

/** What idle threads sort by, so the age shown agrees with the order. */
export function threadActivityAt(thread: SidebarThread): number {
  return thread.latestAttentionAt > 0
    ? thread.latestAttentionAt
    : thread.createdAt;
}

function needsAttention(thread: SidebarThread): boolean {
  return (
    thread.hasPendingInteraction ||
    thread.queuedWork === "failed" ||
    isUnreadDoneThread(thread)
  );
}

function isRunning(thread: SidebarThread): boolean {
  return (
    thread.status === "active" ||
    thread.status === "starting" ||
    thread.status === "stopping" ||
    isRuntimeBusyThread(thread)
  );
}

const DAY_MS = 86_400_000;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function ageSection(timestamp: number, now: number): ThreadSection {
  const today = startOfDay(now);
  if (timestamp >= today) return "today";
  if (timestamp >= startOfDay(today - 1)) return "yesterday";
  if (timestamp >= today - 6 * DAY_MS) return "week";
  return "older";
}

function subtreeThreads(node: ProjectThreadNode): SidebarThread[] {
  return [node.thread, ...node.children.flatMap(subtreeThreads)];
}

/** A root lands where anything under it needs you or is still working. */
export function sectionForNode(
  node: ProjectThreadNode,
  now: number,
): ThreadSection {
  const subtree = subtreeThreads(node);
  if (subtree.some(needsAttention)) return "attention";
  if (subtree.some(isRunning)) return "running";
  return ageSection(threadActivityAt(node.thread), now);
}

function sectionedRows(
  nodes: readonly ProjectThreadNode[],
  now: number,
): ThreadRowModel[] {
  const sectioned = nodes.map((node) => ({
    node,
    section: sectionForNode(node, now),
  }));
  // Stable, so each section keeps the tree's own order.
  sectioned.sort(
    (left, right) =>
      SECTION_ORDER.indexOf(left.section) -
      SECTION_ORDER.indexOf(right.section),
  );
  const rows: ThreadRowModel[] = [];
  for (const { node, section } of sectioned) {
    flattenNodes([node], 0, section, rows);
  }
  return rows;
}

const CLAUDE_CODE_PROVIDER_ID = "claude-code";
const AUTOMATIONS_PLUGIN_ID = "automations";

function isRunningClaudeThread(thread: SidebarThread): boolean {
  return (
    thread.parentThreadId == null &&
    thread.providerId === CLAUDE_CODE_PROVIDER_ID &&
    (thread.status === "active" || thread.status === "starting")
  );
}

/**
 * Root threads only, matching the unread dot the glyphs already show. Running
 * Claude sessions are listed too so the tab doubles as "what needs me soon".
 * Automation runs are left out so scheduled work doesn't crowd the list.
 */
export function unreadThreads(
  threads: readonly SidebarThread[],
): SidebarThread[] {
  return threads
    .filter(
      (thread) =>
        isSidebarProjectThread(thread) &&
        thread.originPluginId !== AUTOMATIONS_PLUGIN_ID &&
        (isUnreadDoneThread(thread) || isRunningClaudeThread(thread)),
    )
    .sort(compareStandardThreads);
}

export function threadRowsForEntry({
  entry,
  threads,
  resolveProjectId,
  now = Date.now(),
}: {
  entry: LeftEntry | undefined;
  threads: readonly SidebarThread[];
  resolveProjectId: SidebarProjectIdResolver;
  now?: number;
}): ThreadRowModel[] {
  if (entry === undefined) return [];
  const visible = threads.filter(isSidebarProjectThread);
  const projectRows = (projectId: string) =>
    sectionedRows(
      buildThreadTree(
        visible.filter((thread) => resolveProjectId(thread) === projectId),
      ),
      now,
    );
  switch (entry.kind) {
    case "pinned":
      return flattenThreadTree(buildPinnedThreadTree(visible));
    case "unread":
      return sectionedRows(
        unreadThreads(visible).map((thread) => ({ thread, children: [] })),
        now,
      );
    case "search":
      return searchThreads(visible, entry.query).map((thread) => ({
        thread,
        depth: 0,
        section: null,
      }));
    case "personal":
      return projectRows(entry.projectId);
    case "project":
      return projectRows(entry.project.id);
    case "path":
    case "browse":
      return [];
  }
}

/** The project `n` starts a thread in, or the active one for other entries. */
export function entryProjectId(
  entry: LeftEntry | undefined,
  activeProjectId: string | null,
): string | null {
  switch (entry?.kind) {
    case "project":
      return entry.project.id;
    case "personal":
      return entry.projectId;
    default:
      return activeProjectId;
  }
}

export function formatAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

export function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}
