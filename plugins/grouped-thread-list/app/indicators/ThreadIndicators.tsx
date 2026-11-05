import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  experimental_usePluginId,
  experimental_useSidebarThreadActions,
  useSidebarThreadDraftIds,
} from "@get-bb/plugin-sdk/app";
import { enter, exit, PRESS, SOFT, speed, usePopOnChange, usePresence } from "bb-motion";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { createThreadProjectResolver } from "../model/active-project.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { threadListIndicatorStateForThread } from "../model/thread-activity.js";
import { useSidebarData, type SidebarProject } from "../model/use-sidebar-data.js";
import { GroupLabel, ROW_NUMBER_CLASS } from "../picker/CurrentMarker.js";
import { formatAge } from "../picker/picker-model.js";
import { openProjectPicker, type PickerStart } from "../picker/picker-store.js";
import { ProjectMonogram } from "../rows/ProjectMonogram.js";
import { ThreadStatusGlyph } from "../rows/ThreadStatusGlyph.js";
import {
  buildThreadInbox,
  describeInbox,
  describePinned,
  formatBadgeCount,
  inboxAgeAt,
} from "./thread-inbox.js";

const FLYOUT_GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 8;
// Sweeping the pointer down the rail shouldn't flash every flyout it crosses,
// and leaving the button needs long enough to reach the flyout beside it.
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 180;
const ROWS_PER_SECTION = 8;

const BUTTON_CLASS = cn(
  "relative flex w-9 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/80 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
  PRESS,
);

const UNREAD_START: PickerStart = { entry: "unread", inThreads: true };
const PINNED_START: PickerStart = { entry: "pinned", inThreads: true };

// bb's rail markup has no plugin contract; if a bb update renames it, the
// indicators fall back to the thread-list slot.
const RAIL = '[data-testid="app-nav-rail"]';
const RAIL_ITEMS = `${RAIL} > div`;

/**
 * bb scopes a plugin's styles to its root, so a host outside the slot wears
 * the root's attributes or the plugin's own utilities wouldn't apply.
 */
function createPluginHost(pluginId: string): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-bb-plugin-root", "");
  element.setAttribute("data-bb-plugin", pluginId);
  return element;
}

/** A body-level host for the flyout, so the sidebar's overflow can't clip it. */
function usePluginPortalHost(active: boolean): HTMLElement | null {
  const pluginId = experimental_usePluginId();
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const element = createPluginHost(pluginId);
    document.body.append(element);
    setHost(element);
    return () => {
      element.remove();
      setHost(null);
    };
  }, [active, pluginId]);
  return host;
}

/**
 * Since bb 0.46 the thread-list slot sits in a column beside bb's icon rail,
 * which collapsing the sidebar hides, so the indicators join the rail itself,
 * right under its items. bb can mount the rail after this slot, or remount it.
 */
function useRailHost(): HTMLElement | null {
  const pluginId = experimental_usePluginId();
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const element = createPluginHost(pluginId);
    const attach = () => {
      if (element.isConnected) return;
      const items = document.querySelector(RAIL_ITEMS);
      items?.append(element);
      setHost(items === null ? null : element);
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      element.remove();
      setHost(null);
    };
  }, [pluginId]);
  return host;
}

function useHoverFlyout() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const schedule = (next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);
  return {
    open,
    show: () => schedule(true, open ? 0 : OPEN_DELAY_MS),
    hide: () => schedule(false, CLOSE_DELAY_MS),
    close: () => {
      clearTimeout(timer.current);
      setOpen(false);
    },
  };
}

function IndicatorButton({
  label,
  start,
  className,
  face,
  flyout,
}: {
  label: string;
  start: PickerStart;
  className?: string;
  face: ReactNode;
  flyout: (close: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const hover = useHoverFlyout();
  const presence = usePresence(hover.open);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );
  const host = usePluginPortalHost(presence.mounted);
  useEffect(() => {
    const button = ref.current;
    if (!hover.open || button === null) return;
    const rect = button.getBoundingClientRect();
    // Past the rail's edge rather than the button's, which sits inset in it.
    const railRight =
      button.closest(RAIL)?.getBoundingClientRect().right ?? rect.right;
    setAnchor({
      left: Math.max(rect.right, railRight) + FLYOUT_GAP_PX,
      top: rect.top,
    });
  }, [hover.open]);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-expanded={hover.open}
        className={cn(BUTTON_CLASS, hover.open && "bg-sidebar-accent text-sidebar-foreground", className)}
        onMouseEnter={hover.show}
        onMouseLeave={hover.hide}
        onFocus={hover.show}
        onBlur={hover.hide}
        onClick={() => {
          hover.close();
          openProjectPicker(start);
        }}
      >
        {face}
      </button>
      {presence.mounted && anchor !== null && host !== null
        ? createPortal(
            <div
              role="dialog"
              aria-label={label}
              aria-hidden={presence.exiting || undefined}
              inert={presence.exiting}
              style={{
                left: anchor.left,
                top: anchor.top,
                maxHeight: `calc(100vh - ${anchor.top + VIEWPORT_MARGIN_PX}px)`,
              }}
              className={cn(
                "fixed z-[70] flex w-96 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg",
                presence.exiting ? exit.fade : cn(enter.slideLeft, speed.fast),
              )}
              onMouseEnter={hover.show}
              onMouseLeave={hover.hide}
              onAnimationEnd={presence.onAnimationEnd}
            >
              <div className="min-h-0 overflow-y-auto p-1">
                {flyout(hover.close)}
              </div>
            </div>,
            host,
          )
        : null}
    </>
  );
}

function FlyoutRow({
  thread,
  project,
  running,
  hasDraft,
  onDone,
}: {
  thread: SidebarThread;
  project: SidebarProject | undefined;
  running: boolean;
  hasDraft: boolean;
  onDone: () => void;
}) {
  const actions = experimental_useSidebarThreadActions();
  const openThread = (event: MouseEvent) => {
    // Shift- and Alt-clicks, like middle-clicks, keep the browser's own link handling.
    if (event.button !== 0 || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onDone();
    actions.open(thread.id, { split: event.metaKey || event.ctrlKey });
  };
  const markRead = () => {
    void actions
      .setRead(thread.id, true)
      .catch(() => toast.error("Failed to mark the thread read."));
  };
  return (
    <div className="group relative">
      <a
        href={thread.href}
        data-thread-indicator-row={thread.id}
        className={cn(
          "flex h-8 select-none items-center gap-2 rounded-md px-2 text-sm hover:bg-state-hover",
          PRESS,
          SOFT,
        )}
        onClick={openThread}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <ThreadStatusGlyph
            {...threadListIndicatorStateForThread(thread, hasDraft)}
          />
        </span>
        {project ? (
          <ProjectMonogram projectId={project.id} name={project.name} />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{thread.displayTitle}</span>
        <span
          className={cn(
            ROW_NUMBER_CLASS,
            thread.isUnread && "group-hover:invisible",
          )}
        >
          {formatAge(inboxAgeAt(thread, running), Date.now())}
        </span>
      </a>
      {thread.isUnread ? (
        <button
          type="button"
          aria-label={`Mark ${thread.displayTitle} read`}
          className="absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-state-active hover:text-foreground group-hover:flex"
          onClick={markRead}
        >
          <Icon name="Check" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function FlyoutSection({
  label,
  threads,
  running = false,
  accent = false,
  projectFor,
  draftIds,
  onDone,
}: {
  label: string;
  threads: readonly SidebarThread[];
  running?: boolean;
  /** The section the badge in the rail counts in the primary colour. */
  accent?: boolean;
  projectFor: (thread: SidebarThread) => SidebarProject | undefined;
  draftIds: ReadonlySet<string>;
  onDone: () => void;
}) {
  if (threads.length === 0) return null;
  const hidden = threads.length - ROWS_PER_SECTION;
  return (
    <section aria-label={label}>
      <GroupLabel label={label} count={threads.length} accent={accent} />
      {threads.slice(0, ROWS_PER_SECTION).map((thread) => (
        <FlyoutRow
          key={thread.id}
          thread={thread}
          project={projectFor(thread)}
          running={running}
          hasDraft={draftIds.has(thread.id)}
          onDone={onDone}
        />
      ))}
      {hidden > 0 ? (
        <div className="px-2 py-1 text-[11px] text-muted-foreground">
          {hidden} more
        </div>
      ) : null}
    </section>
  );
}

function FlyoutEmpty({ children }: { children: ReactNode }) {
  return <div className="px-2 py-2 text-sm text-muted-foreground">{children}</div>;
}

const BADGE_CLASS =
  "pointer-events-none absolute -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[10px] font-medium tabular-nums leading-none";

/** A count in the icon's corner; zero shows no badge, so an idle sidebar shows bare icons. */
function CornerBadge({ value, className }: { value: number; className: string }) {
  const pop = usePopOnChange(value);
  if (value === 0) return null;
  return (
    <span
      key={pop.key}
      aria-hidden="true"
      className={cn(BADGE_CLASS, className, pop.className)}
      onAnimationEnd={pop.onAnimationEnd}
    >
      {formatBadgeCount(value)}
    </span>
  );
}

/**
 * At-a-glance counts in the sidebar's rail: threads that need you and threads
 * still running, then pinned threads. Hovering one lists its threads; clicking
 * it opens the picker on them, which is also the keyboard path.
 */
export function ThreadIndicators() {
  const railHost = useRailHost();
  const { projects } = useSidebarData();
  const draftIds = useSidebarThreadDraftIds();
  const threads = useMemo(
    () => projects.flatMap((project) => project.threads),
    [projects],
  );
  const inbox = useMemo(
    () => buildThreadInbox(threads, createThreadProjectResolver(threads)),
    [threads],
  );
  const projectFor = useMemo(() => {
    const resolve = createThreadProjectResolver(threads);
    // Like the picker's mixed lists, Unassociated threads carry no monogram.
    const byId = new Map(
      projects
        .filter((project) => !project.isPersonal)
        .map((project) => [project.id, project]),
    );
    return (thread: SidebarThread) => byId.get(resolve(thread));
  }, [projects, threads]);
  const needsYou = inbox.needsYou.length;
  const running = inbox.running.length;
  const pinned = inbox.pinned.length;
  const indicators = (
    <div
      data-thread-indicators=""
      className={
        railHost === null
          ? "flex flex-wrap items-start justify-center gap-2 px-2 pb-2"
          : "flex flex-col items-center gap-2.5"
      }
    >
      <span
        aria-hidden="true"
        className="mb-1 h-px w-full max-w-6 bg-sidebar-border"
      />
      <IndicatorButton
        label={describeInbox(needsYou, running)}
        start={UNREAD_START}
        className="size-9"
        face={
          <>
            <Icon name="Mail" className="size-[18px]" />
            <CornerBadge
              value={needsYou}
              className="-top-0.5 bg-primary text-primary-foreground"
            />
            <CornerBadge
              value={running}
              className="-bottom-0.5 bg-muted-foreground text-background"
            />
          </>
        }
        flyout={(close) =>
          needsYou + running === 0 ? (
            <FlyoutEmpty>Nothing needs you and nothing is running.</FlyoutEmpty>
          ) : (
            <>
              <FlyoutSection
                label="Needs you"
                threads={inbox.needsYou}
                accent
                projectFor={projectFor}
                draftIds={draftIds}
                onDone={close}
              />
              <FlyoutSection
                label="Running"
                threads={inbox.running}
                running
                projectFor={projectFor}
                draftIds={draftIds}
                onDone={close}
              />
            </>
          )
        }
      />
      <IndicatorButton
        label={describePinned(pinned)}
        start={PINNED_START}
        className="size-9"
        face={
          <>
            <Icon name="Pin" className="size-[18px]" />
            <CornerBadge
              value={pinned}
              className="-bottom-0.5 bg-muted-foreground text-background"
            />
          </>
        }
        flyout={(close) =>
          pinned === 0 ? (
            <FlyoutEmpty>No pinned threads.</FlyoutEmpty>
          ) : (
            <FlyoutSection
              label="Pinned"
              threads={inbox.pinned}
              projectFor={projectFor}
              draftIds={draftIds}
              onDone={close}
            />
          )
        }
      />
    </div>
  );
  return railHost === null ? indicators : createPortal(indicators, railHost);
}
