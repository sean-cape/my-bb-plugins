// The changes view: a file tree beside every changed file rendered as a structural (difftastic) or text (Pierre)
// diff, with viewed marks, line comments, ⌘-click symbol peeks and, when the data source has them, review findings,
// an agent-written tour and hunk explanations. It renders whatever a `DiffSource` serves, so any plugin can embed it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { DiffComment, DiffFile, SymbolLookup } from "../types";
import { useDiffPreferences } from "./state";
import { DEFAULT_LABELS, DiffSourceContext, type DiffSource, type DiffViewLabels } from "./source";
import { DeltaStrip, useDelta } from "./delta-strip";
import { FileSection } from "./file-section";
import { WHOLE_FILE, type ComposerAnchor, type PatchAnnotationProps } from "./patch-annotations";
import { riskByPath } from "./risk";
import { stepTo } from "./scroll";
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
  const { viewed, collapsed, markViewed, toggleCollapsed, expand } = useFileMarks(source, diff);
  const { showFindings } = useDiffPreferences();
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

  const jumpTo = (path: string) => {
    setActivePath(path);
    expand(path);
    sectionRefs.current.get(path)?.scrollIntoView({ block: "start" });
  };
  const stepFile = (direction: 1 | -1) => {
    if (diff === null || diff.files.length === 0) return;
    const index = diff.files.findIndex((entry) => entry.path === activePath);
    const next = diff.files[Math.min(diff.files.length - 1, Math.max(0, (index === -1 ? 0 : index) + direction))];
    if (next !== undefined) jumpTo(next.path);
  };
  const stepWithin = (selector: string, direction: 1 | -1) => {
    if (mainRef.current !== null) stepTo(mainRef.current, selector, direction);
  };
  const keyboardScope = useReviewKeys({
    stepHunk: (direction) => stepWithin("[data-hunk]", direction),
    stepFile,
    stepComment: (direction) => stepWithin("[data-comment-anchor]", direction),
    toggleViewed: () => {
      if (activePath !== null) markViewed(activePath, !viewed.has(activePath));
    },
  });
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
      onStartComment: (anchor) => setComposer({ path: file.path, ...anchor }),
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
        <div ref={rootRef} className="@container flex h-full min-h-0 flex-col" {...keyboardScope}>
          {toolbar}
          {renderSubmitBar !== undefined && (localPending.length > 0 || githubDrafts.length > 0) ? renderSubmitBar({ local: localPending, githubDrafts, reload: comments.loadComments }) : null}

          {error !== null ? <p className={cn("px-3 py-2 text-sm text-destructive", enter.fade)}>{error}</p> : null}
          {diff !== null && diff.message !== null ? <p className="px-3 py-2 text-sm text-muted-foreground">{diff.message}</p> : null}
          {diff !== null && diff.files.length > 0 ? (
            <SummaryBar
              diff={diff}
              viewed={viewed}
              hasThreads={comments.threads.length > 0}
              findingTotal={allFindings.length}
              showFindings={showFindings}
              onNextComment={() => stepWithin("[data-comment-anchor]", 1)}
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
                    onCommentOnFile={() => setComposer({ path: file.path, ...WHOLE_FILE })}
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
            </div>
          </div>
        </div>
      </DiffCommentsContext.Provider>
    </DiffSourceContext.Provider>
  );
}
