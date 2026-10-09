import { Fragment, useEffect, useRef } from "react";
import { enter, POP, PRESS, speed, STAGGER, stagger, useChangedSinceMount } from "bb-motion";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  getCollapsedChildActivity,
  type ThreadListIndicatorState,
} from "../model/thread-activity.js";
import { isSidebarProjectThread } from "../model/project-thread-groups.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { ThreadStatusGlyph } from "../rows/ThreadStatusGlyph.js";
import { ProjectMonogram } from "../rows/ProjectMonogram.js";
import { CurrentMarker, GroupLabel } from "./CurrentMarker.js";
import { formatAge, LEFT_GROUP_LABELS, type LeftEntry } from "./picker-model.js";

const ENTRY_ICONS: Record<Exclude<LeftEntry["kind"], "project">, IconName> = {
  browse: "FolderPlus",
  path: "Folder",
  personal: "UserRound",
  pinned: "Pin",
  unread: "Mail",
  search: "Search",
};

function activityState(
  threads: readonly SidebarThread[],
  draftIds: ReadonlySet<string>,
): ThreadListIndicatorState {
  const activity = getCollapsedChildActivity(threads);
  return {
    hasPendingInteraction: activity.pending,
    hasUnsubmittedDraft: threads.some((thread) => draftIds.has(thread.id)),
    hasUnreadError: activity.unreadError,
    hasUnreadSuccess: activity.unread,
    isBackgroundAgentActive: activity.backgroundAgent,
    isBackgroundCommandActive: activity.backgroundCommand,
    isGoalActive: activity.goal,
    queuedWork: "none",
    isPlanModeActive: activity.planMode,
    isRuntimeActive: activity.runtimeWorking,
    isWorkflowActive: activity.workflow,
  };
}

function EntryCount({ count }: { count: number }) {
  const changed = useChangedSinceMount(count);
  if (count === 0) return null;
  return (
    <span
      key={changed ? count : undefined}
      aria-hidden="true"
      className={cn(
        "shrink-0 text-xs tabular-nums text-muted-foreground",
        changed && POP,
      )}
    >
      {count}
    </span>
  );
}

export interface EntryCounts {
  unread: number;
  pinned: number;
  threadMatches: number;
}

function EntryTrailing({
  entry,
  draftIds,
  counts,
  latestActivity,
  now,
}: {
  entry: LeftEntry;
  draftIds: ReadonlySet<string>;
  counts: EntryCounts;
  latestActivity: ReadonlyMap<string, number>;
  now: number;
}) {
  switch (entry.kind) {
    case "project": {
      const activeAt = latestActivity.get(entry.project.id);
      return (
        <span className="flex shrink-0 items-center gap-1.5">
          <ThreadStatusGlyph
            {...activityState(
              entry.project.threads.filter(isSidebarProjectThread),
              draftIds,
            )}
          />
          {activeAt === undefined ? null : (
            <span
              aria-hidden="true"
              className="w-6 text-right text-[11px] tabular-nums text-muted-foreground/70"
            >
              {formatAge(activeAt, now)}
            </span>
          )}
        </span>
      );
    }
    case "unread":
      return <EntryCount count={counts.unread} />;
    case "pinned":
      return <EntryCount count={counts.pinned} />;
    case "search":
      return <EntryCount count={counts.threadMatches} />;
    default:
      return null;
  }
}

function entryProjectIdForMarker(entry: LeftEntry): string | null {
  if (entry.kind === "project") return entry.project.id;
  if (entry.kind === "personal") return entry.projectId;
  return null;
}

/**
 * The left column: the fixed entries, then labelled groups: the current
 * project, the other projects, and thread matches while filtering.
 */
export function ProjectsColumn({
  entries,
  intro,
  selectedIndex,
  focused,
  currentProjectId,
  latestActivity,
  draftIds,
  counts,
  onEntryClick,
}: {
  entries: readonly LeftEntry[];
  /** The picker just opened: rows cascade in. */
  intro: boolean;
  selectedIndex: number;
  focused: boolean;
  /** Where you are: the routed thread's project, Unassociated included. */
  currentProjectId: string | null;
  latestActivity: ReadonlyMap<string, number>;
  draftIds: ReadonlySet<string>;
  counts: EntryCounts;
  onEntryClick: (index: number, entry: LeftEntry) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-picker-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const now = Date.now();
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Projects"
      data-picker-column="left"
      className={cn(
        "w-64 shrink-0 overflow-y-auto border-r border-border p-1",
        focused ? "bg-transparent" : "bg-muted/20",
      )}
    >
      {entries.map((entry, index) => {
        const selected = index === selectedIndex;
        const markerProjectId = entryProjectIdForMarker(entry);
        const current =
          markerProjectId !== null && markerProjectId === currentProjectId;
        const introStyle = intro ? stagger(index) : undefined;
        return (
          <Fragment key={entry.key}>
            {entry.group !== "nav" &&
            entries[index - 1]?.group !== entry.group ? (
              <GroupLabel
                label={LEFT_GROUP_LABELS[entry.group]}
                className={cn(
                  index > 0 && "mt-2",
                  intro && [enter.fade, STAGGER],
                )}
                style={introStyle}
              />
            ) : null}
            <div
              role="option"
              aria-selected={selected}
              aria-current={current ? "location" : undefined}
              data-picker-index={index}
              className={cn(
                "relative flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-sm",
                PRESS,
                intro && [enter.rise, speed.fast, STAGGER],
                current && "font-medium text-foreground",
                selected &&
                  (focused
                    ? "bg-state-active text-foreground"
                    : "bg-state-hover"),
              )}
              style={introStyle}
              onClick={() => onEntryClick(index, entry)}
            >
              {current ? (
                <CurrentMarker
                  projectId={entry.kind === "project" ? markerProjectId : null}
                />
              ) : null}
              <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                {entry.kind === "project" ? (
                  <ProjectMonogram
                    projectId={entry.project.id}
                    name={entry.project.name}
                  />
                ) : (
                  <Icon name={ENTRY_ICONS[entry.kind]} className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              <EntryTrailing
                entry={entry}
                draftIds={draftIds}
                counts={counts}
                latestActivity={latestActivity}
                now={now}
              />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
