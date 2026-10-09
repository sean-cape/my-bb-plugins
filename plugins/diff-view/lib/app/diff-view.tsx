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
import { STICKY_HEADER_PX, revealElement } from "./scroll";
import { ScrollMarkers, useScrollMarkers } from "./scroll-markers";
import { SummaryBar } from "./summary-bar";
import { useDiffResult } from "./use-diff-result";
import { useFileMarks } from "./use-file-marks";
import { useReviewKeys } from "./use-review-keys";
import { DiffCommentsContext, type DiffCommentActions } from "./comments/context";
import { threadIsOpen } from "./comments/threads";
import { useComments } from "./comments/use-comments";
import { useExplanations } from "./explanations/use-explanations";
import { FileTreeSidebar } from "./file-tree/file-tree-sidebar";
import { inlineFindingsByPath, type PlacedFinding } from "./findings/findings";
import { useReviews } from "./findings/use-reviews";
import { TourPanel } from "./tour/tour-panel";
import { semanticsByPath as tourSemanticsByPath } from "./tour/tour-report";
import { useTour } from "./tour/use-tour";
import { cursorAt, rowIndexOf, type Cursor, type NavFile } from "./keys/nav";
import { KeyHelp, Picker, fileItems } from "./keys/overlays";
import { rankFiles } from "./keys/rank-files";
import { runReviewCommand, type FindingAnchor, type ReviewEnv } from "./keys/review-commands";
import { ReviewKeysContext, createReviewKeys, useReviewKeysState } from "./keys/review-keys-context";
import { cn } from "./utils";
import { enter } from "./ui/motion";
import { SkeletonLines } from "./ui/skeleton";

export type { DiffSource, DiffViewLabels } from "./source";
export { DiffDisplayControls, DiffRefreshButton } from "./toolbar";

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

const NO_FINDINGS: ReadonlyMap<string, PlacedFinding[]> = new Map();
/** How long a focus request (the "Review changes with the keyboard" command) stays good for a view that is still mounting. */
const FOCUS_REQUEST_TTL_MS = 5_000;
/** Approximate height of one diff line, for turning a page scroll into cursor rows. */
const LINE_PX = 20;

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
  const { showFindings } = preferences;
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
  const findingsByPath = showFindings ? allFindingsByPath : NO_FINDINGS;
  const allFindings = useMemo(() => [...allFindingsByPath.values()].flat(), [allFindingsByPath]);
  const newFindingCount = allFindings.filter((entry) => entry.item.isNew).length;
  const touchedFindingCount = allFindings.filter((entry) => entry.item.touched).length;
  const semanticsByPath = useMemo(() => tourSemanticsByPath(tour), [tour]);
  const risk = useMemo(() => riskByPath(tour, allFindingsByPath), [tour, allFindingsByPath]);
  const changedRangesByPath = useMemo(() => new Map((delta?.files ?? []).map((file) => [file.path, file.ranges] as const)), [delta]);
  const forPath = (path: string) => comments.threads.filter((thread) => thread.path === path);

  const parkCursor = (path: string) => {
    const want = keys.get().cursor?.want ?? "RIGHT";
    keys.set({ cursor: { path, side: want, line: null, want }, visual: null, focusedThread: null });
  };
  const jumpTo = (path: string) => {
    setActivePath(path);
    expand(path);
    parkCursor(path);
    sectionRefs.current.get(path)?.scrollIntoView({ block: "start" });
  };
  const startComment = (path: string, anchor: ComposerAnchor) => {
    setComposer({ path, ...anchor });
    if (anchor.line === null) parkCursor(path);
    else keys.set({ cursor: { path, side: anchor.side, line: anchor.line, want: anchor.side }, visual: null });
  };

  const navFiles = (): NavFile[] => (diff?.files ?? []).map((file) => ({ path: file.path, collapsed: collapsed.has(file.path), rows: keys.models.get(file.path)?.rows ?? null }));
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
    const element = cursor.line === null ? null : elementFor(cursor);
    if (element === null) {
      pendingReveal.current = cursor.line === null ? null : { cursor, block, tries: 0 };
      sectionRefs.current.get(cursor.path)?.scrollIntoView({ block: "start" });
      return;
    }
    pendingReveal.current = null;
    revealElement(main, element, block);
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

  const seat = (): Cursor | null => {
    const main = mainRef.current;
    if (main === null || diff === null || diff.files.length === 0) return null;
    const files = navFiles();
    const top = main.getBoundingClientRect().top + STICKY_HEADER_PX;
    const want = keys.get().cursor?.want ?? "RIGHT";
    for (const [fileIndex, file] of diff.files.entries()) {
      const box = sectionRefs.current.get(file.path)?.getBoundingClientRect();
      if (box === undefined || box.bottom <= top) continue;
      const model = collapsed.has(file.path) ? undefined : keys.models.get(file.path);
      // The file's header is stuck to the top, so the reader is somewhere in its lines.
      if (model !== undefined && box.top < top - STICKY_HEADER_PX) {
        const row = model.rows.findIndex((_, index) => (model.element(index, want)?.getBoundingClientRect().top ?? -Infinity) >= top - 2);
        if (row !== -1) return cursorAt(files, { fileIndex, row }, want);
      }
      return cursorAt(files, { fileIndex, row: -1 }, want);
    }
    return cursorAt(files, { fileIndex: 0, row: -1 }, want);
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
    () => [...findingsByPath].flatMap(([path, list]) => list.map((entry): FindingAnchor => ({ id: `${entry.item.reviewId}:${entry.item.finding.id}:${entry.line}`, path, side: "RIGHT", line: entry.line, item: entry.item }))),
    [findingsByPath],
  );
  const notify = (message: string) => toast.message(message, { duration: 1800 });
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
        const focused = keys.get().focusedThread;
        const box =
          root?.querySelector<HTMLTextAreaElement>('[data-comment-form="new"] textarea') ??
          (focused === null ? null : root?.querySelector<HTMLTextAreaElement>(`[data-thread-id="${CSS.escape(focused)}"] textarea`)) ??
          null;
        if (box === null) return false;
        // An empty box moves to the cursor; one holding a draft is finished first, so the draft is never lost.
        if (box.closest('[data-comment-form="new"]') !== null && box.value.trim() === "") return false;
        box.focus();
        box.scrollIntoView({ block: "nearest" });
        return true;
      },
      setCollapsed: setCollapsedPaths,
      markViewed,
      deleteComment: (id) => {
        void comments.deleteComment(id);
        notify("Comment deleted");
      },
      toggleFinding,
      explain: explainHunk,
      setDisplay: (setting) => {
        if (setting === "mode") setDiffPreferences({ mode: preferences.mode === "text" ? "structural" : "text" });
        else if (setting === "layout") setDiffPreferences({ layout: preferences.layout === "split" ? "unified" : "split" });
        else setDiffPreferences({ wrap: !preferences.wrap });
      },
      refresh: () => requestReload(instanceKey),
      focusSendBar: () => {
        const button = rootRef.current?.querySelector<HTMLElement>("[data-diff-submit-bar] button:not(:disabled)") ?? null;
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
      findings: findingsByPath.get(file.path) ?? [],
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
                showFindings={showFindings}
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
                onSelect={jumpTo}
              />
              <div className="relative flex min-h-0 min-w-0 flex-1">
                <main ref={mainRef} onScroll={trackActive} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
                  {source.tour !== undefined && diff !== null && diff.files.length > 0 ? (
                    <TourPanel tour={tour} busy={tourBusy} onGenerate={() => void generateTour()} onJump={jumpTo} onOpenThread={onOpenThread} files={diff.files} />
                  ) : null}
                  {delta !== null && delta.files.length > 0 ? (
                    <DeltaStrip delta={delta} newFindingCount={newFindingCount} touchedFindingCount={touchedFindingCount} onJump={jumpTo} actions={deltaActions} />
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
