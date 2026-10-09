// The changes view: a file tree beside every changed file rendered as a structural (difftastic) or text (Pierre)
// diff, with viewed marks, line comments, ⌘-click symbol peeks and, when the data source has them, review findings,
// an agent-written tour and hunk explanations. It renders whatever a `DiffSource` serves, so any plugin can embed it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { DiffComment, DiffFile, SymbolLookup } from "../types";
import { requestReload, setDiffPreferences, useDiffInstance, useDiffPreferences } from "./state";
import { DEFAULT_LABELS, DiffSourceContext, type DiffSource, type DiffViewLabels } from "./source";
import { DeltaStrip, useDelta } from "./delta-strip";
import { FileSection } from "./file-section";
import { WHOLE_FILE, type ComposerAnchor, type PatchAnnotationProps } from "./patch-annotations";
import { riskByPath } from "./risk";
import { STICKY_HEADER_PX, cursorLineY, revealBox } from "./scroll";
import { ScrollMarkers, useScrollMarkers } from "./scroll-markers";
import { SummaryBar } from "./summary-bar";
import { useDiffResult } from "./use-diff-result";
import { useFileMarks } from "./use-file-marks";
import { useReviewKeys } from "./use-review-keys";
import { DiffCommentsContext, type DiffCommentActions } from "./comments/context";
import { threadIsOpen, type DiffThread } from "./comments/threads";
import { useComments } from "./comments/use-comments";
import { useExplanations } from "./explanations/use-explanations";
import { FileTreeSidebar } from "./file-tree/file-tree-sidebar";
import { distinctFindings, filterFindings, findingAnchorId, inlineFindingsByPath, type PlacedFinding } from "./findings/findings";
import { useReviews } from "./findings/use-reviews";
import { TourPanel } from "./tour/tour-panel";
import { semanticsByPath as tourSemanticsByPath } from "./tour/tour-report";
import { useTour } from "./tour/use-tour";
import { cursorAt, firstPosition, lastPosition, rowIndexOf, type Cursor, type NavFile } from "./keys/nav";
import { KeyHelp, Picker, fileItems } from "./keys/overlays";
import { rankFiles } from "./keys/rank-files";
import { runReviewCommand, type FindingAnchor, type ReviewEnv } from "./keys/review-commands";
import { ReviewKeysContext, createReviewKeys, useReviewKeysState } from "./keys/review-keys-context";
import { cn } from "./utils";
import { enter } from "./ui/motion";
import { SkeletonLines } from "./ui/skeleton";

export type { DiffSource, DiffViewLabels } from "./source";
export { DiffRefreshButton } from "./toolbar";

/** Comments waiting to be sent, handed to the host's submit bar. */
export interface PendingComments {
  local: DiffComment[];
  githubDrafts: DiffComment[];
  /** Refetch comments after the host sent some. */
  reload: () => void;
}

export interface DiffViewProps {
  source: DiffSource;
  /** Pairs the view with a `DiffRefreshButton` rendered elsewhere, such as the host title bar. */
  instanceKey: string;
  onOpenThread: (threadId: string) => void;
  /** Refetch comments, reviews, the tour and explanations whenever this value changes (a realtime event counter, say). */
  refreshSignal?: unknown;
  labels?: Partial<DiffViewLabels>;
  /** The bar shown while comments are waiting to be sent; the host decides where they go. */
  renderSubmitBar?: (pending: PendingComments) => ReactNode;
  /** Extra controls at the end of the "since you last looked" strip. */
  deltaActions?: ReactNode;
  /** Controls above the diff, for surfaces with no title bar of their own (a side panel, say). */
  toolbar?: ReactNode;
}

const NO_PLACED_FINDINGS: PlacedFinding[] = [];
const NO_THREADS: DiffThread[] = [];
/** How long a focus request (the "Review changes with the keyboard" command) stays good for a view that is still mounting. */
const FOCUS_REQUEST_TTL_MS = 5_000;
/** Approximate height of one diff line, for turning a page scroll into cursor rows. */
const LINE_PX = 20;
/** How long after a wheel or touch event a scroll still counts as the reader's. */
const SCROLL_INTENT_MS = 250;

/** The file list shows from the `@3xl` container width (48rem) up. */
const FILE_TREE_MIN_REM = 48;

/** The vim-style mode and half-typed keys, shown while the view has the keyboard. */
function ModeLabel() {
  const { visual, pending } = useReviewKeysState();
  return (
    <span className="pointer-events-none absolute bottom-2 right-4 z-10 hidden rounded bg-background/85 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground shadow-sm group-focus-within/diff:block">
      {visual !== null ? "-- VISUAL LINE --" : "NORMAL"}
      {pending !== "" ? <span className="ml-2 text-foreground">{pending}</span> : null}
      <span className="ml-2 opacity-70">? keys</span>
    </span>
  );
}
const DIFF_SKELETON = ["38%", "86%", "72%", "91%", "58%", "80%", "66%"];

/** The whole changes view. Narrow containers (a side panel) drop the file tree; wide ones show it beside the diff. */
export function DiffView({ source, instanceKey, onOpenThread, refreshSignal, labels: labelOverrides, renderSubmitBar, deltaActions, toolbar }: DiffViewProps) {
  const { diff, error } = useDiffResult(source, instanceKey);
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...labelOverrides }), [labelOverrides]);
  const comments = useComments(source, refreshSignal);
  const { reviews, toggleFinding, editFinding } = useReviews(source, refreshSignal);
  const { explanations, explainHunk } = useExplanations(source, refreshSignal);
  const { tour, busy: tourBusy, generate: generateTour } = useTour(source, refreshSignal);
  const delta = useDelta(source, diff?.headSha ?? null);
  const preferences = useDiffPreferences();
  const { findingFilter } = preferences;
  const { viewed, collapsed, markViewed, toggleCollapsed, expand, setCollapsedPaths } = useFileMarks(source, diff);
  const [keys] = useState(createReviewKeys);
  const [overlay, setOverlay] = useState<{ kind: "help" } | { kind: "files" } | { kind: "symbols"; names: string[]; pick: (name: string) => void } | null>(null);
  const [lastSearch, setLastSearch] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [composer, setComposer] = useState<({ path: string } & ComposerAnchor) | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const navigate = useBbNavigate();

  const openDefinition = (lookup: SymbolLookup, definition: SymbolLookup["definitions"][number]) => {
    if (lookup.open.kind === "environment") {
      const accepted = navigate.experimental_openFilePreview({
        target: { kind: "workspace", environmentId: lookup.open.environmentId, path: definition.path },
        location: definition.line === null ? null : { kind: "line", line: definition.line, column: null },
      });
      if (accepted) return;
    }
    if (lookup.open.kind === "github") {
      window.open(`https://github.com/${lookup.open.repo}/blob/${lookup.open.sha}/${definition.path}${definition.line === null ? "" : `#L${definition.line}`}`, "_blank", "noopener,noreferrer");
      return;
    }
    toast.message(labels.noCheckout);
  };

  const allFindingsByPath = useMemo(() => inlineFindingsByPath(reviews, delta), [reviews, delta]);
  const findingsByPath = useMemo(() => filterFindings(allFindingsByPath, findingFilter), [allFindingsByPath, findingFilter]);
  const allFindings = useMemo(() => distinctFindings([...allFindingsByPath.values()].flat()), [allFindingsByPath]);
  const shownFindingCount = useMemo(() => distinctFindings([...findingsByPath.values()].flat()).length, [findingsByPath]);
  const newFindings = allFindings.filter((item) => item.isNew);
  const touchedFindings = allFindings.filter((item) => item.touched);
  const semanticsByPath = useMemo(() => tourSemanticsByPath(tour), [tour]);
  const risk = useMemo(() => riskByPath(tour, allFindingsByPath), [tour, allFindingsByPath]);
  const changedRangesByPath = useMemo(() => new Map((delta?.files ?? []).map((file) => [file.path, file.ranges] as const)), [delta]);
  // Stable per file, so a re-render of the view (scrolling moves the active file) leaves each file's diff untouched.
  const threadsByPath = useMemo(() => {
    const byPath = new Map<string, DiffThread[]>();
    for (const thread of comments.threads) byPath.set(thread.path, [...(byPath.get(thread.path) ?? []), thread]);
    return byPath;
  }, [comments.threads]);
  const forPath = (path: string) => threadsByPath.get(path) ?? NO_THREADS;

  // Pierre mounts annotations into its slots after the render that adds them, too late for the box's autoFocus.
  const composerOpened = useRef(false);
  useEffect(() => {
    if (!composerOpened.current || composer === null) return;
    composerOpened.current = false;
    let frames = 0;
    let frame = 0;
    const focus = () => {
      const box = rootRef.current?.querySelector<HTMLTextAreaElement>('[data-comment-form="new"] textarea');
      if (box !== null && box !== undefined) {
        if (document.activeElement !== box) box.focus();
        return;
      }
      if (++frames < 30) frame = requestAnimationFrame(focus);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [composer]);
  const parkCursor = (path: string) => {
    const want = keys.get().cursor?.want ?? "RIGHT";
    keys.set({ cursor: { path, side: want, line: null, want }, visual: null, focused: null });
  };
  const jumpTo = (path: string) => {
    setActivePath(path);
    expand(path);
    parkCursor(path);
    sectionRefs.current.get(path)?.scrollIntoView({ block: "start" });
  };
  const startComment = (path: string, anchor: ComposerAnchor) => {
    setComposer({ path, ...anchor });
    composerOpened.current = true;
    if (anchor.line === null) parkCursor(path);
    else keys.set({ cursor: { path, side: anchor.side, line: anchor.line, want: anchor.side }, visual: null });
  };

  const navFiles = (): NavFile[] => (diff?.files ?? []).map((file) => ({ path: file.path, collapsed: collapsed.has(file.path), rows: keys.models.get(file.path)?.rows ?? null }));
  const navFilesRef = useRef(navFiles);
  navFilesRef.current = navFiles;
  // A newly opened diff starts the cursor on its first line, not on whatever line is mid-screen when a key is first
  // pressed. Files count as collapsed until their viewed marks load and their rows arrive after that, so this retries
  // on every render and every published file until the first open file has rows; a refresh leaves the cursor alone.
  const initialCursor = useRef<{ instanceKey: string; placed: Cursor | null; done: boolean } | null>(null);
  const placeInitialCursor = () => {
    const state = initialCursor.current;
    if (state === null || state.done) return;
    // The reader got there first.
    if (state.placed !== null && keys.get().cursor !== state.placed) {
      state.done = true;
      return;
    }
    const files = navFilesRef.current();
    const fileIndex = files.findIndex((file) => !file.collapsed);
    const file = files[fileIndex];
    // A fold of hidden lines above the first change is not a line to start on.
    const row = file?.rows?.findIndex((entry) => entry.expander !== true) ?? -1;
    const next = file === undefined ? firstPosition(files, "RIGHT") : cursorAt(files, { fileIndex, row }, "RIGHT");
    if (next === null) return;
    state.done = file !== undefined && file.rows !== null;
    // Setting the cursor re-renders the view, which runs this again; an unchanged spot must not set it again.
    const same = state.placed !== null && state.placed.path === next.path && state.placed.side === next.side && state.placed.line === next.line;
    if (same) return;
    state.placed = next;
    keys.set({ cursor: next, visual: null, focused: null });
  };
  const placeInitialCursorRef = useRef(placeInitialCursor);
  placeInitialCursorRef.current = placeInitialCursor;
  const hasFiles = diff !== null && diff.files.length > 0;
  useEffect(() => {
    if (hasFiles && initialCursor.current?.instanceKey !== instanceKey) initialCursor.current = { instanceKey, placed: null, done: false };
    placeInitialCursorRef.current();
  });
  useEffect(() => {
    const unsubscribe = keys.onModel(() => placeInitialCursorRef.current());
    return () => {
      unsubscribe();
    };
  }, [keys]);
  const elementFor = (cursor: Cursor): Element | null => {
    if (cursor.line === null) return sectionRefs.current.get(cursor.path) ?? null;
    const model = keys.models.get(cursor.path);
    const row = model === undefined ? -1 : rowIndexOf(model.rows, cursor.side, cursor.line);
    return row === -1 ? null : model!.element(row, cursor.side);
  };
  // A cursor sent to a line that is not laid out yet (a file still mounting or loading) is scrolled to once it is.
  const pendingReveal = useRef<{ cursor: Cursor; block?: "center" | "start" | "end"; tries: number } | null>(null);
  const reveal = (cursor: Cursor, block?: "center" | "start" | "end") => {
    const main = mainRef.current;
    if (main === null) return;
    if (cursor.line === null) {
      // A stuck header reports where it sticks, not where it sits; the section's top is where it sits.
      const section = sectionRefs.current.get(cursor.path);
      pendingReveal.current = null;
      if (section !== undefined) revealBox(main, { top: section.getBoundingClientRect().top, height: STICKY_HEADER_PX }, block);
      return;
    }
    const element = elementFor(cursor);
    if (element === null) {
      pendingReveal.current = { cursor, block, tries: 0 };
      sectionRefs.current.get(cursor.path)?.scrollIntoView({ block: "start" });
      return;
    }
    pendingReveal.current = null;
    const box = element.getBoundingClientRect();
    revealBox(main, { top: box.top, height: box.height }, block);
  };
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => {
    let timer = 0;
    const retry = () => {
      const pending = pendingReveal.current;
      if (pending === null || keys.get().cursor !== pending.cursor) return;
      if (elementFor(pending.cursor) !== null) revealRef.current(pending.cursor, pending.block);
      // Pierre fills its shadow DOM a beat after it mounts.
      else if (++pending.tries < 20) timer = window.setTimeout(retry, 100);
    };
    const unsubscribe = keys.onModel((path) => {
      if (pendingReveal.current?.cursor.path !== path) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(retry, 0);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
    // elementFor reads only refs and the stable store.
  }, [keys]);

  /** The line at the middle of the screen, where the cursor rests. */
  const seat = (): Cursor | null => {
    const main = mainRef.current;
    if (main === null || diff === null || diff.files.length === 0) return null;
    const files = navFiles();
    const middle = cursorLineY(main);
    const want = keys.get().cursor?.want ?? "RIGHT";
    const other = want === "LEFT" ? "RIGHT" : "LEFT";
    for (const [fileIndex, file] of diff.files.entries()) {
      const box = sectionRefs.current.get(file.path)?.getBoundingClientRect();
      if (box === undefined || box.bottom <= middle) continue;
      const model = collapsed.has(file.path) ? undefined : keys.models.get(file.path);
      if (model !== undefined && box.top + STICKY_HEADER_PX <= middle) {
        // The last row starting above the middle; a row with no line on the wanted side is measured on the other.
        let row = -1;
        for (let index = 0; index < model.rows.length; index++) {
          const top = (model.element(index, want) ?? model.element(index, other))?.getBoundingClientRect().top;
          if (top === undefined) continue;
          if (top > middle) break;
          row = index;
        }
        if (row !== -1) return cursorAt(files, { fileIndex, row }, want);
      }
      return cursorAt(files, { fileIndex, row: -1 }, want);
    }
    return lastPosition(files, want);
  };
  const onScreen = (cursor: Cursor): boolean | null => {
    const main = mainRef.current;
    const element = elementFor(cursor);
    if (main === null || element === null) return null;
    const view = main.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return box.bottom > view.top + (cursor.line === null ? 0 : STICKY_HEADER_PX) && box.top < view.bottom;
  };
  const findingAnchors = useMemo(
    () => [...findingsByPath].flatMap(([path, list]) => list.map((entry): FindingAnchor => ({ id: findingAnchorId(entry), path, side: "RIGHT", line: entry.line, item: entry.item }))),
    [findingsByPath],
  );
  const notify = (message: string) => toast.message(message, { duration: 1800 });
  const fileTreeFits = () => (rootRef.current?.clientWidth ?? 0) >= FILE_TREE_MIN_REM * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const returnFromFileTree = () => rootRef.current?.focus({ preventScroll: true });
  const runCommand: Parameters<typeof useReviewKeys>[3] = (command, count) => {
    const env: ReviewEnv = {
      keys,
      files: navFiles(),
      threads: comments.threads,
      findings: findingAnchors,
      viewed,
      target: source.canPostToGithub === true ? { value: comments.target, set: comments.setTarget } : null,
      seat,
      onScreen,
      reveal,
      scrollPage: (fraction) => {
        const main = mainRef.current;
        if (main === null) return 0;
        main.scrollBy({ top: fraction * main.clientHeight, behavior: "auto" });
        return Math.round((fraction * main.clientHeight) / LINE_PX);
      },
      startComment: (path, range) => {
        expand(path);
        startComment(path, range);
      },
      focusComposer: () => {
        const root = rootRef.current;
        const focused = keys.get().focused;
        const box =
          root?.querySelector<HTMLTextAreaElement>('[data-comment-form="new"] textarea') ??
          (focused?.kind !== "thread" ? null : root?.querySelector<HTMLTextAreaElement>(`[data-thread-id="${CSS.escape(focused.id)}"] textarea`)) ??
          null;
        if (box === null) return false;
        // An empty box moves to the cursor; one holding a draft is finished first, so the draft is never lost.
        if (box.closest('[data-comment-form="new"]') !== null && box.value.trim() === "") return false;
        box.focus();
        box.scrollIntoView({ block: "nearest" });
        return true;
      },
      closeEmptyComposer: () => {
        const box = rootRef.current?.querySelector<HTMLTextAreaElement>('[data-comment-form="new"] textarea') ?? null;
        if (composer === null || (box !== null && box.value.trim() !== "")) return false;
        setComposer(null);
        return true;
      },
      setCollapsed: setCollapsedPaths,
      markViewed,
      deleteComment: (id) => {
        void comments.deleteComment(id);
        notify("Comment deleted");
      },
      canPostToGithub: source.canPostToGithub ?? false,
      moveComment: (id, target) => void comments.moveComment(id, target),
      openUrl: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      openThread: onOpenThread,
      toggleFinding,
      explain: explainHunk,
      toggleLayout: () => setDiffPreferences({ layout: preferences.layout === "split" ? "unified" : "split" }),
      toggleFileTree: () => {
        const open = !preferences.fileTreeOpen;
        setDiffPreferences({ fileTreeOpen: open });
        if (open && !fileTreeFits()) notify("The file list needs a wider view");
      },
      focusFileTree: () => {
        if (!fileTreeFits()) return false;
        if (!preferences.fileTreeOpen) setDiffPreferences({ fileTreeOpen: true });
        const path = keys.get().cursor?.path ?? null;
        // A list that was hidden renders after this key; wait for its rows.
        let frames = 0;
        const focus = () => {
          const tree = rootRef.current?.querySelector<HTMLElement>("[data-file-tree]") ?? null;
          const visible = tree !== null && tree.getClientRects().length > 0;
          const row = !visible ? null : ((path === null ? null : tree.querySelector<HTMLElement>(`[data-file-tree-path="${CSS.escape(path)}"]`)) ?? tree.querySelector<HTMLElement>("[data-tree-row]"));
          if (row !== null) {
            row.focus();
            row.scrollIntoView({ block: "nearest" });
          } else if (++frames < 10) requestAnimationFrame(focus);
        };
        focus();
        return true;
      },
      findingFilter: allFindings.length === 0 ? null : { value: findingFilter, set: (filter) => setDiffPreferences({ findingFilter: filter }) },
      refresh: () => requestReload(instanceKey),
      focusSendBar: () => {
        // The bar's first action, past any checkbox or toggle that only sets an option for it.
        const button = rootRef.current?.querySelector<HTMLElement>('[data-diff-submit-bar] button:not(:disabled):not([role="checkbox"]):not([role="switch"]):not([role="radio"]):not([aria-pressed])') ?? null;
        button?.focus();
        return button !== null;
      },
      openOverlay: (kind) => setOverlay({ kind }),
      search: lastSearch === null || diff === null ? null : { query: lastSearch, matches: new Set(rankFiles(diff.files, lastSearch).map((file) => file.path)) },
      jump: jumpTo,
      pickSymbol: (names, pick) => setOverlay({ kind: "symbols", names, pick }),
      notify,
    };
    runReviewCommand(command, count, env);
  };
  const keyboardScope = useReviewKeys(rootRef, keys, overlay === null, runCommand);
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  // Scrolling by hand (wheel, trackpad, touch, the scrollbar) drags the cursor along, so it stays on the middle line.
  // The diff's own scrolls, which put the cursor there, carry no such intent and are left alone.
  const lastScrollIntent = useRef(0);
  const draggingScrollbar = useRef(false);
  const followFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(followFrame.current), []);
  const markScrollIntent = () => {
    lastScrollIntent.current = performance.now();
  };
  const onMainScroll = () => {
    trackActive();
    if (keys.get().cursor === null) return;
    if (!draggingScrollbar.current && performance.now() - lastScrollIntent.current > SCROLL_INTENT_MS) return;
    cancelAnimationFrame(followFrame.current);
    followFrame.current = requestAnimationFrame(() => runCommandRef.current({ kind: "follow" }, 1));
  };
  const closeOverlay = () => {
    setOverlay(null);
    rootRef.current?.focus({ preventScroll: true });
  };
  const { focusRequestedAt } = useDiffInstance(instanceKey);
  useEffect(() => {
    if (Date.now() - focusRequestedAt < FOCUS_REQUEST_TTL_MS) rootRef.current?.focus({ preventScroll: true });
  }, [focusRequestedAt]);
  useEffect(() => {
    if (activePath === null) return;
    rootRef.current?.querySelector(`[data-file-tree-path="${CSS.escape(activePath)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activePath]);
  const { markers, recompute: recomputeMarkers } = useScrollMarkers(mainRef, [diff, comments.threads, collapsed]);
  // The sidebar tracks whichever file header is at (or just above) the top of the scroller, like GitHub's file tree.
  const trackActive = () => {
    recomputeMarkers();
    const main = mainRef.current;
    if (main === null || diff === null) return;
    const top = main.getBoundingClientRect().top + 8;
    let current: string | null = null;
    for (const entry of diff.files) {
      const section = sectionRefs.current.get(entry.path);
      if (section === undefined) continue;
      if (section.getBoundingClientRect().top <= top) current = entry.path;
      else break;
    }
    setActivePath(current ?? diff.files[0]?.path ?? null);
  };

  const annotationsFor = (file: DiffFile): PatchAnnotationProps => {
    const fileComposer = composer !== null && composer.path === file.path ? composer : null;
    return {
      path: file.path,
      threads: forPath(file.path),
      composer: fileComposer,
      onStartComment: (anchor) => startComment(file.path, anchor),
      onCancelComposer: () => setComposer(null),
      onSubmitComposer: (body, target) => (fileComposer === null ? Promise.resolve() : comments.addComment(file.path, fileComposer, body, target)),
      findings: findingsByPath.get(file.path) ?? NO_PLACED_FINDINGS,
      onToggleFinding: toggleFinding,
      onEditFinding: editFinding,
    };
  };
  const commentActions: DiffCommentActions = {
    canPostToGithub: source.canPostToGithub ?? false,
    onReply: comments.reply,
    onEdit: comments.editComment,
    target: comments.target,
    onMoveComment: comments.moveComment,
    onDelete: (id) => void comments.deleteComment(id),
    onOpenThread,
  };
  const sourceContext = useMemo(() => ({ source, labels }), [source, labels]);
  const { localPending, githubDrafts } = comments;

  return (
    <DiffSourceContext.Provider value={sourceContext}>
      <DiffCommentsContext.Provider value={commentActions}>
        <ReviewKeysContext.Provider value={keys}>
          <div ref={rootRef} data-diff-root="" tabIndex={-1} className="group/diff @container flex h-full min-h-0 flex-col outline-none" {...keyboardScope}>
            {toolbar}
            {renderSubmitBar !== undefined && (localPending.length > 0 || githubDrafts.length > 0) ? (
              <div data-diff-submit-bar="">{renderSubmitBar({ local: localPending, githubDrafts, reload: comments.loadComments })}</div>
            ) : null}

            {error !== null ? <p className={cn("px-3 py-2 text-sm text-destructive", enter.fade)}>{error}</p> : null}
            {diff !== null && diff.message !== null ? <p className="px-3 py-2 text-sm text-muted-foreground">{diff.message}</p> : null}
            {diff !== null && diff.files.length > 0 ? (
              <SummaryBar
                diff={diff}
                viewed={viewed}
                hasThreads={comments.threads.length > 0}
                findingTotal={allFindings.length}
                findingShown={shownFindingCount}
                findingFilter={findingFilter}
                onNextComment={() => runCommand({ kind: "thread", direction: 1 }, 1)}
                onShowKeys={() => setOverlay({ kind: "help" })}
                commentTarget={source.canPostToGithub === true ? { target: comments.target, onChange: comments.setTarget } : null}
              />
            ) : null}

            <div className="flex min-h-0 flex-1">
              <FileTreeSidebar
                diff={diff}
                activePath={activePath}
                viewed={viewed}
                commentCount={(path) => forPath(path).filter(threadIsOpen).length}
                findingCount={(path) => findingsByPath.get(path)?.length ?? 0}
                risk={(path) => risk.get(path) ?? null}
                changedSince={(path) => changedRangesByPath.has(path)}
                onSelect={(path) => {
                  jumpTo(path);
                  returnFromFileTree();
                }}
                onLeave={returnFromFileTree}
              />
              <div className="relative flex min-h-0 min-w-0 flex-1">
                <main
                  ref={mainRef}
                  onScroll={onMainScroll}
                  onWheel={markScrollIntent}
                  onTouchMove={markScrollIntent}
                  onPointerDown={(event) => {
                    // A press on the scroller itself, not its content, is on the scrollbar.
                    if (event.target !== event.currentTarget) return;
                    draggingScrollbar.current = true;
                    window.addEventListener("pointerup", () => (draggingScrollbar.current = false), { once: true });
                  }}
                  className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
                  {source.tour !== undefined && diff !== null && diff.files.length > 0 ? (
                    <TourPanel tour={tour} busy={tourBusy} onGenerate={() => void generateTour()} onJump={jumpTo} onOpenThread={onOpenThread} files={diff.files} />
                  ) : null}
                  {delta !== null && delta.files.length > 0 ? (
                    <DeltaStrip delta={delta} newFindings={newFindings} touchedFindings={touchedFindings} findingFilter={findingFilter} onJump={jumpTo} actions={deltaActions} />
                  ) : null}
                  {diff === null && error === null ? <SkeletonLines widths={DIFF_SKELETON} label="Loading changes" className="p-4" /> : null}
                  {diff !== null && diff.files.length === 0 ? (
                    <p className={cn("p-4 text-sm text-muted-foreground", enter.fade)}>
                      {diff.hiddenVendored === null ? "No changes." : `Only vendored files changed (${diff.hiddenVendored.files} hidden by the "Hide vendored files" setting).`}
                    </p>
                  ) : null}
                  {diff?.files.map((file, index) => (
                    <FileSection
                      key={file.path}
                      file={file}
                      index={index}
                      sectionRef={(node) => {
                        if (node === null) sectionRefs.current.delete(file.path);
                        else sectionRefs.current.set(file.path, node);
                      }}
                      scrollRoot={mainRef}
                      collapsed={collapsed.has(file.path)}
                      viewed={viewed.has(file.path)}
                      onToggleCollapsed={() => toggleCollapsed(file.path)}
                      onMarkViewed={(isViewed) => markViewed(file.path, isViewed)}
                      onCommentOnFile={() => startComment(file.path, WHOLE_FILE)}
                      annotations={annotationsFor(file)}
                      onOpenFile={openDefinition}
                      explanations={explanations.filter((entry) => entry.path === file.path)}
                      onExplain={explainHunk === null ? null : (side, startLine, endLine) => explainHunk(file.path, side, startLine, endLine)}
                      semantics={semanticsByPath.get(file.path) ?? []}
                      changedRanges={changedRangesByPath.get(file.path) ?? []}
                    />
                  ))}
                </main>
                <ScrollMarkers markers={markers} mainRef={mainRef} />
                <ModeLabel />
                {overlay?.kind === "help" ? <KeyHelp onClose={closeOverlay} /> : null}
                {overlay?.kind === "files" && diff !== null ? (
                  <Picker
                    label="Search file names"
                    placeholder="Search file names…"
                    initialQuery={lastSearch ?? ""}
                    rank={(query) => fileItems(diff.files, query)}
                    onPick={(path, query) => {
                      closeOverlay();
                      setLastSearch(query.trim() === "" ? null : query);
                      jumpTo(path);
                    }}
                    onClose={closeOverlay}
                  />
                ) : null}
                {overlay?.kind === "symbols" ? (
                  <Picker
                    label="Peek at a symbol"
                    placeholder="Peek at a symbol on this line…"
                    rank={(query) => overlay.names.filter((name) => name.toLowerCase().includes(query.toLowerCase())).map((name) => ({ id: name, label: name }))}
                    onPick={(name) => {
                      closeOverlay();
                      overlay.pick(name);
                    }}
                    onClose={closeOverlay}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </ReviewKeysContext.Provider>
      </DiffCommentsContext.Provider>
    </DiffSourceContext.Provider>
  );
}
