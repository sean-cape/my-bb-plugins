import { Fragment, useEffect, useRef } from "react";
import { enter, PRESS, speed, STAGGER, stagger, useChangedSinceMount, SOFT } from "bb-motion";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { threadListIndicatorStateForThread } from "../model/thread-activity.js";
import type { SidebarProjectIdResolver } from "../model/active-project.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import type { SidebarProject } from "../model/use-sidebar-data.js";
import { ThreadStatusGlyph } from "../rows/ThreadStatusGlyph.js";
import { ProjectMonogram } from "../rows/ProjectMonogram.js";
import { CurrentMarker, GroupLabel } from "./CurrentMarker.js";
import {
  formatAge,
  THREAD_SECTION_LABELS,
  threadActivityAt,
  type LeftEntry,
  type PickerColumn,
  type ThreadRowModel,
} from "./picker-model.js";

function emptyMessage(entry: LeftEntry | undefined): string {
  if (entry === undefined) return "No matching projects or threads.";
  switch (entry.kind) {
    case "browse":
      return "Enter opens the folder picker.";
    case "unread":
      return "No unread or running threads.";
    default:
      return "No threads. Press n to start one.";
  }
}

/** Entries that mix projects get a monogram on each row. */
function showsProjectMonograms(entry: LeftEntry | undefined): boolean {
  return (
    entry?.kind === "pinned" ||
    entry?.kind === "unread" ||
    entry?.kind === "search"
  );
}

/**
 * The age agrees with the order: running threads sort by when they started,
 * so they don't reshuffle on every update; the rest by latest attention.
 */
function rowAge(row: ThreadRowModel, now: number): string {
  return formatAge(
    row.section === "running" ? row.thread.createdAt : threadActivityAt(row.thread),
    now,
  );
}

const HEADER_ICONS: Partial<Record<LeftEntry["kind"], IconName>> = {
  personal: "UserRound",
  pinned: "Pin",
  unread: "Mail",
  search: "Search",
};

function ThreadsHeader({
  entry,
  count,
  current,
}: {
  entry: LeftEntry | undefined;
  count: number;
  current: boolean;
}) {
  if (entry === undefined || entry.kind === "path" || entry.kind === "browse") {
    return null;
  }
  const icon = HEADER_ICONS[entry.kind];
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-sm">
      {entry.kind === "project" ? (
        <ProjectMonogram projectId={entry.project.id} name={entry.project.name} />
      ) : icon ? (
        <Icon name={icon} className="size-4 text-muted-foreground" />
      ) : null}
      <span className="min-w-0 truncate font-medium">{entry.label}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {count === 1 ? "1 thread" : `${count} threads`}
      </span>
      {current ? (
        <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 py-px text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
          Current
        </span>
      ) : null}
    </div>
  );
}

/** Pops when the row is pinned in view, not when it mounts already pinned. */
function PinnedMark({ pinned }: { pinned: boolean }) {
  const changed = useChangedSinceMount(pinned);
  if (!pinned) return null;
  return (
    <Icon
      name="Pin"
      className={cn(
        "size-3 shrink-0 text-muted-foreground",
        changed && enter.pop,
      )}
      aria-label="Pinned"
    />
  );
}

const MESSAGE_CLASS = "px-3 py-2 text-sm text-muted-foreground";

/** The right column: the selected entry's threads, or a status line. */
export function ThreadsColumn({
  entry,
  rows,
  intro,
  highlightedIndex,
  column,
  status,
  narrow,
  routedThreadId,
  currentProjectId,
  orderedProjects,
  resolveProjectId,
  draftIds,
  onHover,
  onOpen,
}: {
  entry: LeftEntry | undefined;
  rows: readonly ThreadRowModel[];
  /** The picker just opened: rows cascade in. */
  intro: boolean;
  highlightedIndex: number;
  column: PickerColumn;
  /** Replaces the rows, e.g. the typed folder path's lookup result. */
  status: string | null;
  /** Leaves room for the preview pane beside it. */
  narrow: boolean;
  routedThreadId: string | null;
  currentProjectId: string | null;
  orderedProjects: readonly SidebarProject[];
  resolveProjectId: SidebarProjectIdResolver;
  draftIds: ReadonlySet<string>;
  onHover: (threadId: string) => void;
  onOpen: (thread: SidebarThread) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-picker-index="${highlightedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const now = Date.now();
  const withMonograms = showsProjectMonograms(entry);
  const entryIsCurrent =
    (entry?.kind === "project" && entry.project.id === currentProjectId) ||
    (entry?.kind === "personal" && entry.projectId === currentProjectId);
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        narrow ? "w-96 shrink-0" : "min-w-0 flex-1",
      )}
    >
      {status === null ? (
        <ThreadsHeader
          entry={entry}
          count={rows.length}
          current={entryIsCurrent}
        />
      ) : null}
      <div
        ref={listRef}
        role="listbox"
        aria-label={entry ? `${entry.label} threads` : "Threads"}
        data-picker-column="right"
        className="min-h-0 flex-1 overflow-y-auto p-1"
      >
        {status !== null ? (
          <div className={cn(MESSAGE_CLASS, enter.fade, speed.fast)}>
            {status}
          </div>
        ) : rows.length === 0 ? (
          <div className={cn(MESSAGE_CLASS, enter.fade, speed.fast)}>
            {emptyMessage(entry)}
          </div>
        ) : (
          rows.map((row, index) => {
            // The remembered row stays unpainted while the cursor is in the
            // projects column, so only one column shows a cursor.
            const selected = index === highlightedIndex && column !== "left";
            const projectId = resolveProjectId(row.thread);
            const project = withMonograms
              ? orderedProjects.find((candidate) => candidate.id === projectId)
              : undefined;
            const routed = row.thread.id === routedThreadId;
            const startsSection =
              row.section !== null && rows[index - 1]?.section !== row.section;
            const introStyle = intro ? stagger(index) : undefined;
            return (
              <Fragment key={row.thread.id}>
                {startsSection && row.section !== null ? (
                  <GroupLabel
                    label={THREAD_SECTION_LABELS[row.section]}
                    className={cn(
                      index > 0 && "mt-2",
                      intro && [enter.fade, STAGGER],
                    )}
                  />
                ) : null}
                <div
                  role="option"
                  aria-selected={selected}
                  aria-current={routed ? "page" : undefined}
                  data-picker-index={index}
                  data-picker-thread-id={row.thread.id}
                  className={cn(
                    "relative flex h-8 cursor-pointer select-none items-center gap-2 rounded-md pr-2 text-sm",
                    PRESS,
                    SOFT,
                    intro && [enter.rise, speed.fast, STAGGER],
                    selected &&
                      (column === "right"
                        ? "bg-state-active text-foreground"
                        : "bg-state-hover"),
                    routed && "font-medium text-foreground",
                  )}
                  style={{
                    paddingLeft: 8 + row.depth * 16,
                    ...introStyle,
                  }}
                  onMouseMove={() => {
                    if (!selected || column !== "right") onHover(row.thread.id);
                  }}
                  onClick={() => onOpen(row.thread)}
                >
                  {routed ? <CurrentMarker projectId={projectId} /> : null}
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <ThreadStatusGlyph
                      {...threadListIndicatorStateForThread(
                        row.thread,
                        draftIds.has(row.thread.id),
                      )}
                    />
                  </span>
                  {project ? (
                    <ProjectMonogram projectId={project.id} name={project.name} />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">
                    {row.thread.displayTitle}
                  </span>
                  <PinnedMark pinned={row.thread.pinnedAt !== null} />
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {rowAge(row, now)}
                  </span>
                </div>
              </Fragment>
            );
          })
        )}
      </div>
    </div>
  );
}
