import { useEffect, useState, type RefObject } from "react";
import {
  experimental_useSidebarThreadPullRequest,
  ThreadChat,
  type PluginSidebarPullRequest,
} from "@get-bb/plugin-sdk/app";
import { enter, speed } from "bb-motion";
import { cn } from "@/lib/utils";
import type { SidebarThread } from "../model/sidebar-thread.js";
import type { SidebarProject } from "../model/use-sidebar-data.js";
import { ProjectMonogram } from "../rows/ProjectMonogram.js";
import type { PreviewScroll } from "./picker-keymap.js";
import { formatAge } from "./picker-model.js";
import { findTranscriptScroller } from "./use-pinned-to-bottom.js";

// Long enough that holding j doesn't mount a transcript per row.
const PREVIEW_DEBOUNCE_MS = 150;
const PREVIEW_LINE_PX = 40;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

/** The thread to preview, trailing the highlight while the cursor moves. */
export function usePreviewThreadId(threadId: string | null): string | null {
  return useDebouncedValue(threadId, PREVIEW_DEBOUNCE_MS);
}

// ThreadChat owns its scroller, so find it when a key needs it rather than
// holding a ref across its re-renders.
export function scrollPreview(root: HTMLElement | null, scroll: PreviewScroll) {
  if (root === null) return;
  const scroller = findTranscriptScroller(root);
  if (scroller === null) return;
  const page = scroller.clientHeight;
  const by = {
    "line-down": PREVIEW_LINE_PX,
    "line-up": -PREVIEW_LINE_PX,
    "half-down": page / 2,
    "half-up": -page / 2,
    "page-down": page - PREVIEW_LINE_PX,
    "page-up": PREVIEW_LINE_PX - page,
    top: -scroller.scrollHeight,
    bottom: scroller.scrollHeight,
  }[scroll];
  scroller.scrollTop = Math.max(
    0,
    Math.min(scroller.scrollTop + by, scroller.scrollHeight - page),
  );
}

const PR_ATTENTION_LABELS: Partial<
  Record<PluginSidebarPullRequest["attention"], string>
> = {
  blocked: "blocked",
  changes_requested: "changes requested",
  checks_failed: "checks failing",
  checks_pending: "checks running",
  closed: "closed",
  conflicts: "conflicts",
  draft: "draft",
  merged: "merged",
  queued: "in merge queue",
  ready_to_merge: "ready to merge",
  review_requested: "review requested",
};

const PR_ATTENTION_ALERT = new Set<PluginSidebarPullRequest["attention"]>([
  "blocked",
  "changes_requested",
  "checks_failed",
  "conflicts",
]);

function PullRequestBadge({ threadId }: { threadId: string }) {
  const { pullRequest } = experimental_useSidebarThreadPullRequest(threadId);
  if (pullRequest === null) return null;
  const attention = PR_ATTENTION_LABELS[pullRequest.attention];
  return (
    <span
      className={cn(
        "shrink-0",
        PR_ATTENTION_ALERT.has(pullRequest.attention) && "text-destructive",
      )}
    >
      #{pullRequest.number}
      {attention ? ` ${attention}` : ""}
    </span>
  );
}

const SEPARATOR = <span aria-hidden="true">·</span>;

/** The full title and where the thread lives; the list truncates both. */
function PreviewHeader({
  thread,
  project,
}: {
  thread: SidebarThread;
  project: SidebarProject | undefined;
}) {
  const branch = thread.environment?.branchName ?? null;
  const age = formatAge(thread.createdAt, Date.now());
  return (
    <div className="shrink-0 border-b border-border px-4 py-2">
      <div className="truncate text-sm font-medium" title={thread.displayTitle}>
        {thread.displayTitle}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {project ? (
          <>
            <ProjectMonogram projectId={project.id} name={project.name} />
            <span className="shrink-0">{project.name}</span>
            {SEPARATOR}
          </>
        ) : null}
        {branch ? (
          <>
            <span className="min-w-0 truncate font-mono" title={branch}>
              {branch}
            </span>
            {SEPARATOR}
          </>
        ) : null}
        <PullRequestBadge threadId={thread.id} />
        <span className="ml-auto shrink-0 tabular-nums">
          {age === "now" ? "just started" : `started ${age} ago`}
        </span>
      </div>
    </div>
  );
}

export function PreviewPane({
  containerRef,
  thread,
  project,
  focused,
  onFocus,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  thread: SidebarThread;
  project: SidebarProject | undefined;
  focused: boolean;
  onFocus: () => void;
}) {
  const threadId = thread.id;
  return (
    <div
      ref={containerRef}
      aria-label="Thread preview"
      data-picker-preview-thread-id={threadId}
      data-picker-column="preview"
      onMouseDown={onFocus}
      className={cn(
        "relative flex min-w-0 flex-1 flex-col border-l border-border",
        enter.slideRight,
        speed.fast,
      )}
    >
      <PreviewHeader thread={thread} project={project} />
      <ThreadChat
        key={threadId}
        threadId={threadId}
        variant="timeline"
        layout="contained"
        className="min-h-0 flex-1"
      />
      {focused ? (
        // Above the chat: its opaque background hides an inset ring.
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-ring"
        />
      ) : null}
    </div>
  );
}
