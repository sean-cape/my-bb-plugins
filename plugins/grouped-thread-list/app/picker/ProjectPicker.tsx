import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { enter, exit, usePresence } from "bb-motion";
import {
  experimental_useSidebarThreadActions,
  useBbContext,
  useSidebarThreadDraftIds,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useActiveProject } from "../model/use-active-project.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { closeProjectPicker, useProjectPickerOpen } from "./picker-store.js";
import {
  buildLeftEntries,
  clampIndex,
  entryProjectId,
  searchThreads,
  threadRowsForEntry,
  unreadThreads,
  type LeftEntry,
  type PickerColumn,
  type ThreadRowModel,
} from "./picker-model.js";
import { buildPinnedThreadTree } from "../model/pinned-sidebar-threads.js";
import { isSidebarProjectThread } from "../model/project-thread-groups.js";
import type { SidebarProject } from "../model/use-sidebar-data.js";
import { ProjectMonogram } from "../rows/ProjectMonogram.js";
import {
  keyName,
  pickerHints,
  resolveFilterKey,
  resolvePickerKey,
  resolvePreviewKey,
  type FilterCommand,
  type PickerCommand,
  type PreviewScroll,
} from "./picker-keymap.js";
import { usePinnedToBottom } from "./use-pinned-to-bottom.js";
import {
  describePathLookup,
  openableFolderPath,
  useFolderPathLookup,
} from "./use-folder-path-lookup.js";
import { useHostDialogOpen } from "./use-host-dialog-open.js";
import { useOpenFolder } from "./use-open-folder.js";
import {
  PreviewPane,
  scrollPreview,
  usePreviewThreadId,
} from "./PreviewPane.js";
import { ProjectsColumn } from "./ProjectsColumn.js";
import { ThreadsColumn } from "./ThreadsColumn.js";
import { undoLastArchive } from "../undo-archive.js";

/**
 * Opens on Unread with the left column focused, so the projects are one j
 * away. The routed thread is pre-highlighted when it is listed there.
 */
function initialSelection(
  routedThreadId: string | null,
  threads: readonly SidebarThread[],
): { leftKey: string; threadId: string | null } {
  return {
    leftKey: "unread",
    threadId: unreadThreads(threads).some(
      (thread) => thread.id === routedThreadId,
    )
      ? routedThreadId
      : null,
  };
}

function consume(event: ReactKeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function PickerHints({ column }: { column: PickerColumn }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-muted-foreground">
      {pickerHints(column).map(([keys, label]) => (
        <span key={label} className="flex items-center gap-1">
          <kbd className="min-w-4 rounded border border-border px-1 text-center font-sans">
            {keys}
          </kbd>
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * Where you are, whichever entry the picker is showing: the routed thread's
 * project and title, or just the project on a project's compose screen.
 */
function CurrentLocation({
  project,
  isPersonal,
  thread,
}: {
  project: SidebarProject | undefined;
  isPersonal: boolean;
  thread: SidebarThread | undefined;
}) {
  if (project === undefined && !isPersonal) return null;
  return (
    <div
      aria-label="Current location"
      className="flex min-w-0 max-w-[45%] shrink items-center gap-1.5 text-xs text-muted-foreground"
    >
      {project ? (
        <ProjectMonogram projectId={project.id} name={project.name} />
      ) : (
        <Icon name="UserRound" className="size-3.5" />
      )}
      <span className="shrink-0 font-medium text-foreground/80">
        {project?.name ?? "Unassociated"}
      </span>
      {thread ? (
        <>
          <Icon name="ChevronRight" className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{thread.displayTitle}</span>
        </>
      ) : null}
    </div>
  );
}

/**
 * The routed thread's project (by root ancestor), else the project whose
 * screen is open, else the active project, so there is always a "here".
 */
function currentProjectIdFor({
  routedThread,
  routedProjectId,
  activeProjectId,
  resolveProjectId,
}: {
  routedThread: SidebarThread | undefined;
  routedProjectId: string | null;
  activeProjectId: string | null;
  resolveProjectId: (thread: SidebarThread) => string;
}): string | null {
  if (routedThread !== undefined) return resolveProjectId(routedThread);
  return routedProjectId ?? activeProjectId;
}

function ProjectPickerDialog({
  exiting,
  onExitEnd,
}: {
  /** Closed and playing its exit: inert and hidden from assistive tech. */
  exiting: boolean;
  onExitEnd: (event: AnimationEvent) => void;
}) {
  const sidebarActions = experimental_useSidebarThreadActions();
  const { threadId: routedThreadId, projectId: routedProjectId } =
    useBbContext();
  const draftIds = useSidebarThreadDraftIds();
  const {
    activeProjectId,
    latestActivity,
    orderedProjects,
    personalProjectId,
    resolveProjectId,
    setActiveProjectId,
    threads,
  } = useActiveProject();
  const [initial] = useState(() =>
    initialSelection(routedThreadId, threads),
  );
  const [column, setColumn] = useState<PickerColumn>("left");
  const [leftKey, setLeftKey] = useState(initial.leftKey);
  const [threadId, setThreadId] = useState<string | null>(initial.threadId);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // Rows cascade in only until the first interaction: moving through
  // projects remounts the whole thread list, which must then appear at once.
  const [intro, setIntro] = useState(true);
  const endIntro = () => {
    if (intro) setIntro(false);
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const pendingKey = useRef<string | null>(null);
  const lastRight = useRef<{ threadId: string | null; index: number }>({
    threadId: null,
    index: 0,
  });

  const routedThread = useMemo(
    () => threads.find((thread) => thread.id === routedThreadId),
    [routedThreadId, threads],
  );
  const currentProjectId = currentProjectIdFor({
    routedThread,
    routedProjectId,
    activeProjectId,
    resolveProjectId,
  });
  const currentProject = orderedProjects.find(
    (project) => project.id === currentProjectId,
  );
  const threadMatchCount = useMemo(
    () => searchThreads(threads, query).length,
    [query, threads],
  );
  const leftEntries = useMemo(
    () =>
      buildLeftEntries({
        orderedProjects,
        personalProjectId,
        currentProjectId,
        query,
        threadMatchCount,
      }),
    [currentProjectId, orderedProjects, personalProjectId, query, threadMatchCount],
  );
  const counts = useMemo(
    () => ({
      unread: unreadThreads(threads).length,
      pinned: buildPinnedThreadTree(threads.filter(isSidebarProjectThread))
        .length,
      threadMatches: threadMatchCount,
    }),
    [threadMatchCount, threads],
  );
  const leftIndex = clampIndex(
    Math.max(
      0,
      leftEntries.findIndex((entry) => entry.key === leftKey),
    ),
    leftEntries.length,
  );
  const leftEntry: LeftEntry | undefined = leftEntries[leftIndex];
  const rows = useMemo(
    () => threadRowsForEntry({ entry: leftEntry, threads, resolveProjectId }),
    [leftEntry, resolveProjectId, threads],
  );
  const foundRightIndex = rows.findIndex((row) => row.thread.id === threadId);
  // A highlighted thread that disappears (deleted, archived) leaves the
  // cursor on the row that took its place instead of jumping to the top.
  const rightIndex = clampIndex(
    foundRightIndex >= 0
      ? foundRightIndex
      : threadId !== null && threadId === lastRight.current.threadId
        ? lastRight.current.index
        : 0,
    rows.length,
  );
  lastRight.current = { threadId, index: rightIndex };
  const highlightedRow: ThreadRowModel | undefined = rows[rightIndex];
  const previewThreadId = usePreviewThreadId(
    column === "left" ? null : (highlightedRow?.thread.id ?? null),
  );
  const previewThread =
    previewThreadId === null
      ? undefined
      : threads.find((thread) => thread.id === previewThreadId);
  const releasePreviewPin = usePinnedToBottom(previewRef, previewThreadId);
  const behindHostDialog = useHostDialogOpen(rootRef);
  const scrollPreviewBy = (scroll: PreviewScroll) => {
    releasePreviewPin();
    scrollPreview(previewRef.current, scroll);
  };
  const pathQuery = leftEntry?.kind === "path" ? query.trim() : "";
  const pathLookup = useFolderPathLookup(pathQuery, pathQuery !== "");
  const { busy, openFolder, browseForFolder } = useOpenFolder((projectId) => {
    setActiveProjectId(projectId);
    setQuery("");
    setLeftKey(projectId);
    setThreadId(null);
    setColumn("left");
  });

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const selectLeft = (index: number) => {
    const entry = leftEntries[clampIndex(index, leftEntries.length)];
    if (entry === undefined || entry.key === leftKey) return;
    setLeftKey(entry.key);
    setThreadId(null);
  };
  const selectRight = (index: number) => {
    const row = rows[clampIndex(index, rows.length)];
    if (row) setThreadId(row.thread.id);
  };
  const moveBy = (delta: number) => {
    if (column === "preview") {
      scrollPreviewBy(delta > 0 ? "line-down" : "line-up");
    } else if (column === "left") selectLeft(leftIndex + delta);
    else selectRight(rightIndex + delta);
  };
  const moveTo = (edge: "first" | "last") => {
    if (column === "preview") {
      scrollPreviewBy(edge === "first" ? "top" : "bottom");
      return;
    }
    const length = column === "left" ? leftEntries.length : rows.length;
    const index = edge === "first" ? 0 : length - 1;
    if (column === "left") selectLeft(index);
    else selectRight(index);
  };
  const focusColumn = (next: PickerColumn) => {
    if (next !== "left" && rows.length === 0) return;
    setColumn(next);
    setSearching(false);
  };

  const openThread = (thread: SidebarThread) => {
    const projectId = resolveProjectId(thread);
    if (projectId !== personalProjectId) setActiveProjectId(projectId);
    closeProjectPicker();
    sidebarActions.open(thread.id);
  };

  /** The thread the row-level keys act on, unless the cursor is in projects. */
  const actionableRow = (): ThreadRowModel | undefined =>
    column === "left" ? undefined : highlightedRow;

  const togglePin = () => {
    const thread = actionableRow()?.thread;
    if (thread === undefined) return;
    void sidebarActions
      .setPinned(thread.id, thread.pinnedAt === null)
      .catch(() => toast.error("Failed to update the pin."));
  };

  const markRead = () => {
    const thread = actionableRow()?.thread;
    if (thread === undefined || !thread.isUnread) return;
    void sidebarActions
      .setRead(thread.id, true)
      .catch(() => toast.error("Failed to mark the thread read."));
  };

  const archiveThread = () => {
    const thread = actionableRow()?.thread;
    if (thread === undefined) return;
    sidebarActions.archive(thread.id);
  };

  const newThread = () => {
    const projectId = entryProjectId(leftEntry, activeProjectId);
    if (projectId === null) return;
    if (projectId !== personalProjectId) setActiveProjectId(projectId);
    closeProjectPicker();
    sidebarActions.openNewThread({ projectId, focusPrompt: true });
  };

  const activate = () => {
    if (busy) return;
    if (column !== "left") {
      if (highlightedRow) openThread(highlightedRow.thread);
      return;
    }
    switch (leftEntry?.kind) {
      case "browse":
        void browseForFolder();
        return;
      case "path": {
        const path = openableFolderPath(pathLookup);
        if (path !== null) void openFolder(path);
        return;
      }
      case undefined:
        return;
      default:
        focusColumn("right");
    }
  };

  const startSearch = () => {
    setSearching(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const stopSearch = () => {
    setSearching(false);
    rootRef.current?.focus();
  };

  const pickerCommands: Record<PickerCommand, () => void> = {
    down: () => moveBy(1),
    up: () => moveBy(-1),
    left: () => focusColumn(column === "preview" ? "right" : "left"),
    right: () => focusColumn(column === "left" ? "right" : "preview"),
    "switch-column": () => focusColumn(column === "left" ? "right" : "left"),
    top: () => moveTo("first"),
    bottom: () => moveTo("last"),
    activate,
    pin: togglePin,
    "mark-read": markRead,
    archive: archiveThread,
    "undo-archive": () => undoLastArchive(document),
    "new-thread": newThread,
    filter: startSearch,
    escape: () => {
      if (query !== "") {
        setQuery("");
        setColumn("left");
      } else closeProjectPicker();
    },
    close: closeProjectPicker,
  };

  const filterCommands: Record<FilterCommand, () => void> = {
    down: () => moveBy(1),
    up: () => moveBy(-1),
    accept: () => {
      stopSearch();
      activate();
    },
    cancel: stopSearch,
  };

  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (exiting || event.target === inputRef.current) return;
    if (event.metaKey || event.altKey) return;
    const key = keyName(event);
    // Every key, Shift included, ends a pending double tap.
    const previousPendingKey = pendingKey.current;
    pendingKey.current = null;
    const previewScroll =
      column === "preview" ? resolvePreviewKey(key) : undefined;
    if (previewScroll !== undefined) {
      scrollPreviewBy(previewScroll);
      consume(event);
      return;
    }
    const resolved = resolvePickerKey(key, previousPendingKey);
    if (resolved.type === "unbound") return;
    if (resolved.type === "pending") pendingKey.current = key;
    else pickerCommands[resolved.command]();
    consume(event);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const command = resolveFilterKey(keyName(event));
    if (command === undefined) return;
    filterCommands[command]();
    consume(event);
  };

  return (
    <div
      className={cn(
        "fixed inset-0",
        behindHostDialog ? "z-40" : "z-[60]",
        exiting && "pointer-events-none",
      )}
      aria-hidden={exiting || undefined}
      inert={exiting}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeProjectPicker();
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-label="Switch project"
        tabIndex={-1}
        data-vim-ignore=""
        onKeyDown={onRootKeyDown}
        onKeyDownCapture={endIntro}
        onPointerDownCapture={endIntro}
        onAnimationEnd={onExitEnd}
        // Centered by margins rather than a translate, so the entrance and
        // exit keyframes own the transform outright.
        className={cn(
          "absolute inset-x-0 top-[10vh] mx-auto flex h-[min(680px,84vh)] w-[min(1240px,96vw)] origin-top flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl outline-none",
          exiting ? exit.scale : enter.scale,
        )}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <Icon name="Search" className="size-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            readOnly={!searching}
            tabIndex={-1}
            onFocus={() => setSearching(true)}
            onBlur={() => setSearching(false)}
            onChange={(event) => {
              endIntro();
              setQuery(event.target.value);
              setThreadId(null);
              setColumn("left");
            }}
            onKeyDown={onInputKeyDown}
            placeholder="/ to find a project or thread, or type a folder path"
            aria-label="Filter projects"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            spellCheck={false}
            autoComplete="off"
          />
          {busy ? (
            <Icon
              name="Loading"
              className="size-4 animate-spin text-muted-foreground"
            />
          ) : (
            <CurrentLocation
              project={currentProject}
              isPersonal={
                currentProjectId !== null &&
                currentProjectId === personalProjectId
              }
              thread={routedThread}
            />
          )}
        </div>
        <div className="flex min-h-0 flex-1">
          <ProjectsColumn
            entries={leftEntries}
            intro={intro}
            selectedIndex={leftIndex}
            focused={column === "left"}
            currentProjectId={currentProjectId}
            latestActivity={latestActivity}
            draftIds={draftIds}
            counts={counts}
            onEntryClick={(index, entry) => {
              selectLeft(index);
              setColumn("left");
              if (entry.kind === "browse") void browseForFolder();
            }}
          />
          <ThreadsColumn
            entry={leftEntry}
            rows={rows}
            intro={intro}
            highlightedIndex={rightIndex}
            column={column}
            status={
              leftEntry?.kind === "path"
                ? describePathLookup(pathLookup, pathQuery)
                : null
            }
            narrow={previewThread !== undefined}
            routedThreadId={routedThreadId}
            currentProjectId={currentProjectId}
            orderedProjects={orderedProjects}
            resolveProjectId={resolveProjectId}
            draftIds={draftIds}
            onHover={(hoveredThreadId) => {
              setThreadId(hoveredThreadId);
              setColumn("right");
            }}
            onOpen={openThread}
          />
          {previewThread === undefined ? null : (
            <PreviewPane
              containerRef={previewRef}
              thread={previewThread}
              project={orderedProjects.find(
                (project) => project.id === resolveProjectId(previewThread),
              )}
              focused={column === "preview"}
              onFocus={() => setColumn("preview")}
            />
          )}
        </div>
        <PickerHints column={column} />
      </div>
    </div>
  );
}

export function ProjectPicker() {
  const open = useProjectPickerOpen();
  const presence = usePresence(open);
  // Every open mounts a fresh dialog, even one that lands while the previous
  // close is still animating out, so no selection or filter carries over.
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setGeneration((current) => current + 1);
  }
  return presence.mounted ? (
    <ProjectPickerDialog
      key={generation}
      exiting={presence.exiting}
      onExitEnd={presence.onAnimationEnd}
    />
  ) : null;
}
