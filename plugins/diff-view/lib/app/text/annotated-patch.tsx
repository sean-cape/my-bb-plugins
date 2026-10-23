import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { PatchDiff, VirtualizerContext, useWorkerPool, type DiffLineAnnotation } from "@pierre/diffs/react";
import { useDiffPreferences } from "../state";
import { useHostPierreThemes } from "../theme";
import { WHOLE_FILE, type PatchAnnotationProps } from "../patch-annotations";
import { DiffCommentForm } from "../comments/comment-form";
import { FileLevelComments } from "../comments/file-level-comments";
import { DiffThreadView } from "../comments/thread-view";
import { FindingAnnotation } from "../findings/finding-annotation";
import { visualRange, type NavRow } from "../keys/nav";
import { useCursorShown, useFileCursor, usePublishNavModel, type FileNavModel } from "../keys/review-keys-context";
import type { DiffSide, LineRange } from "../../types";
import type { ExcerptGap } from "../../narrative";
import { buildLineAnnotations, fromPierreSide, toPierreSide, type AnnotationMeta, type PierreSide } from "./line-annotations";
import { navRows, patchRows, selectionRange } from "./patch-rows";
import { SearchHighlightCss } from "../search/use-diff-search";
import { GapBand } from "./gap-band";
import { gapEnter, gapPart, navWithGaps, type PatchGaps } from "./patch-gaps";
import type { NewSince } from "../new-since";
import { newSinceCss } from "./new-since-css";

/**
 * Pierre sizes each code column `1fr`, which cannot shrink below its widest unbreakable content: a long token or an
 * inline comment then widens its column, squeezes the other side of a split diff to a sliver, and pushes the comment's
 * buttons off screen. A zero minimum keeps the columns to the panel and lets their content wrap.
 */
const COLUMN_CSS = "[data-diff],[data-file]{--diffs-code-grid:var(--diffs-grid-number-column-width) minmax(0, 1fr)}";

interface PierreSelection {
  start: number;
  side?: PierreSide;
  end: number;
  endSide?: PierreSide;
}

function toSelection(range: LineRange): PierreSelection | null {
  if (range.line === null) return null;
  return { start: range.startLine ?? range.line, side: toPierreSide(range.startSide ?? range.side), end: range.line, endSide: toPierreSide(range.side) };
}

const NO_GAPS: readonly ExcerptGap[] = [];
const NO_REVEAL = () => {};

/** A band under the last row before each gap between two of the excerpt's rows. */
function gapAnnotations(gaps: readonly ExcerptGap[]): DiffLineAnnotation<AnnotationMeta>[] {
  return gaps.flatMap((gap, index) => {
    const { after } = gap;
    if (after === null || gap.before === null) return [];
    const anchor = after.new !== null ? { side: "additions" as const, lineNumber: after.new } : { side: "deletions" as const, lineNumber: after.old! };
    return [{ ...anchor, metadata: { key: `gap:${index}`, kind: "gap" as const, index } }];
  });
}

/**
 * The element Pierre renders for one side of a row, inside its shadow root. A context line carries both numbers
 * (`data-line` for the side it is drawn on, `data-alt-line` for the other), so it is matched on the pair.
 */
function pierreLine(host: HTMLElement | null, row: NavRow, side: DiffSide): Element | null {
  const root = host?.querySelector("diffs-container")?.shadowRoot ?? null;
  if (root === null) return null;
  if (row.left === null || row.right === null) {
    const line = row.left ?? row.right;
    return root.querySelector(`[data-line="${line}"][data-line-type="${row.left === null ? "change-addition" : "change-deletion"}"]`);
  }
  const [mine, other] = side === "LEFT" ? [row.left, row.right] : [row.right, row.left];
  return root.querySelector(`[data-line="${mine}"][data-alt-line="${other}"]`) ?? root.querySelector(`[data-line="${other}"][data-alt-line="${mine}"]`);
}

/**
 * Pierre's diff renderer used directly (the host's Diff wrapper exposes no line events). As on GitHub, clicking or
 * dragging line numbers (shift-click extends) or dragging the hover "+" starts a comment on those lines, and comments
 * render inline as line annotations under their last line.
 *
 * The selection is controlled so it can show the open composer's lines. Pierre only draws a controlled selection
 * once it is passed back in, so a drag in progress is mirrored through `dragged`. Setting the selection fires
 * `onLineSelected`, so comments start from `onLineSelectionEnd`, which only the pointer fires.
 */
export function AnnotatedPatch({
  path,
  patch,
  findings,
  onToggleFinding,
  onEditFinding,
  threads,
  composer,
  onStartComment,
  onCancelComposer,
  onSubmitComposer,
  layout: layoutOverride,
  hunkSeparators,
  gaps,
  newSince,
}: PatchAnnotationProps & {
  patch: string;
  /** Split or unified; the view's line-diff layout preference when absent. */
  layout?: "unified" | "split";
  /** How the gap before a hunk is drawn; Pierre's default (the count of hidden lines) when absent. */
  hunkSeparators?: "simple" | "metadata" | "line-info" | "line-info-basic";
  /** An excerpt's gaps, drawn as bands the reader opens; the cursor stops on each one that hides rows. */
  gaps?: PatchGaps;
  /** The lines to mark new since the last review; none when absent. */
  newSince?: NewSince;
}) {
  const { layout: preferredLayout } = useDiffPreferences();
  const layout = layoutOverride ?? preferredLayout;
  const { mode: themeMode } = useCodeTheme();
  const themes = useHostPierreThemes();
  const workerPool = useWorkerPool();
  const searchCss = useContext(SearchHighlightCss);
  const freshRanges = newSince?.ranges;
  const freshCss = useMemo(() => newSinceCss(freshRanges ?? []), [freshRanges]);
  // GitHub patches lack the `diff --git` header Pierre expects; synthesize one for the file.
  const fullPatch = useMemo(
    () => (patch.startsWith("diff --git") ? patch : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}`),
    [patch, path],
  );
  const rows = useMemo(() => patchRows(fullPatch), [fullPatch]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gapList = gaps?.list ?? NO_GAPS;
  const revealGap = gaps?.reveal;
  const { rows: nav, gapAt } = useMemo(() => navWithGaps(navRows(rows, layout), gapList), [rows, layout, gapList]);
  const element = useCallback(
    (row: number, side: DiffSide) => {
      const gap = gapAt.get(row);
      if (gap !== undefined) return hostRef.current?.querySelector(`[data-excerpt-gap="${gap}"]`) ?? null;
      return nav[row] === undefined ? null : pierreLine(hostRef.current, nav[row], side);
    },
    [nav, gapAt],
  );
  const navModel = useMemo<FileNavModel>(() => {
    if (revealGap === undefined) return { rows: nav, cutToHunk: true, element };
    return {
      rows: nav,
      cutToHunk: true,
      element,
      expand: (row) => {
        const gap = gapAt.get(row);
        if (gap === undefined) return null;
        const { reveal, cursor } = gapEnter(gapList[gap]!);
        revealGap(reveal);
        return cursor === null ? null : { left: cursor.old, right: cursor.new };
      },
      // The gaps either side of the cursor's run of rows each open a step toward it.
      moreContext: (row) => {
        let above: number | undefined;
        let below: number | undefined;
        for (let at = row - 1; at >= 0 && above === undefined; at--) above = gapAt.get(at);
        for (let at = row + 1; at < nav.length && below === undefined; at++) below = gapAt.get(at);
        revealGap([...(above === undefined ? [] : gapPart(gapList[above]!, "last")), ...(below === undefined ? [] : gapPart(gapList[below]!, "first"))]);
      },
    };
  }, [nav, gapAt, gapList, revealGap, element]);
  usePublishNavModel(path, navModel);
  const fileCursor = useFileCursor(path);
  const cursorShown = useCursorShown();
  const cursorSelection = useMemo<PierreSelection | null>(() => {
    if (fileCursor === null) return null;
    const { cursor, visual } = fileCursor;
    // A cursor on a gap stands on a line Pierre does not draw.
    if (visual === null && cursor.line !== null && nav.some((row, index) => gapAt.has(index) && (cursor.side === "LEFT" ? row.left : row.right) === cursor.line)) return null;
    const range = visual === null ? null : visualRange(nav, visual, cursor, true);
    return toSelection(range ?? { line: cursor.line, side: cursor.side, startLine: null, startSide: null });
  }, [fileCursor, nav, gapAt]);
  // Gaps go last, so opening one shifts no other annotation's slot.
  const annotations = useMemo(() => [...buildLineAnnotations(threads, composer, findings), ...gapAnnotations(gapList)], [threads, composer, findings, gapList]);
  // A key already on screen at the last commit that mounts again was shifted to another slot, not added.
  const committedKeys = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    committedKeys.current = new Set(annotations.map((annotation) => annotation.metadata.key));
  }, [annotations]);
  const [dragged, setDragged] = useState<PierreSelection | null>(null);
  const composerLine = composer?.line ?? null;
  const composerSide = composer?.side ?? "RIGHT";
  const composerStartLine = composer?.startLine ?? null;
  const composerStartSide = composer?.startSide ?? null;
  const composerSelection = useMemo<PierreSelection | null>(
    () => toSelection({ line: composerLine, side: composerSide, startLine: composerStartLine, startSide: composerStartSide }),
    [composerLine, composerSide, composerStartLine, composerStartSide],
  );
  const dragging = dragged !== null;
  // A pointer cancel ends a drag without any selection event.
  useEffect(() => {
    if (!dragging) return;
    const clear = () => setDragged(null);
    document.addEventListener("pointercancel", clear);
    return () => document.removeEventListener("pointercancel", clear);
  }, [dragging]);
  // Read through a ref: a new options object makes Pierre re-render the whole file, and hosts pass a fresh callback each render.
  const startComment = useRef(onStartComment);
  startComment.current = onStartComment;
  const options = useMemo(() => {
    const finish = (selection: PierreSelection | null) => {
      setDragged(null);
      if (selection === null) return;
      startComment.current(
        selectionRange(rows, { line: selection.start, side: fromPierreSide(selection.side) }, { line: selection.end, side: fromPierreSide(selection.endSide ?? selection.side) }),
      );
    };
    return {
      diffStyle: layout,
      ...(hunkSeparators === undefined ? {} : { hunkSeparators }),
      theme: themes,
      themeType: themeMode,
      disableFileHeader: true,
      overflow: "wrap" as const,
      unsafeCSS: COLUMN_CSS + searchCss + freshCss,
      lineHoverHighlight: "both" as const,
      enableGutterUtility: true,
      enableLineSelection: true,
      onGutterUtilityClick: finish,
      onLineSelectionStart: setDragged,
      onLineSelectionChange: setDragged,
      onLineSelectionEnd: finish,
    };
  }, [layout, hunkSeparators, themes, themeMode, rows, searchCss, freshCss]);
  // Stable across cursor moves, which re-render this file for its selection, so Pierre leaves the annotations alone.
  const renderAnnotation = useCallback(
    ({ metadata }: DiffLineAnnotation<AnnotationMeta>) => {
      if (metadata.kind === "composer") {
        return <DiffCommentForm key={metadata.key} path={path} range={composer ?? WHOLE_FILE} onSubmit={onSubmitComposer} onCancel={onCancelComposer} />;
      }
      if (metadata.kind === "finding") {
        const item = metadata.finding;
        return <FindingAnnotation key={metadata.key} item={item} anchorId={metadata.anchorId} entrance={!committedKeys.current.has(metadata.key)} onToggle={(selected) => onToggleFinding(item, selected)} onEdit={(edit) => onEditFinding(item, edit)} />;
      }
      if (metadata.kind === "gap") return <GapBand key={metadata.key} path={path} gap={gapList[metadata.index]!} index={metadata.index} onReveal={revealGap ?? NO_REVEAL} />;
      return <DiffThreadView key={metadata.key} thread={metadata.thread} />;
    },
    [path, composer, onSubmitComposer, onCancelComposer, onToggleFinding, onEditFinding, gapList, revealGap],
  );
  // The bands at the top and bottom have no line to hang under, so they sit outside the diff, across both sides.
  const edgeBand = (index: number) => <GapBand key={index} path={path} gap={gapList[index]!} index={index} onReveal={revealGap ?? NO_REVEAL} />;
  const leadingGap = gapList.findIndex((gap) => gap.after === null);
  const trailingGap = gapList.findIndex((gap) => gap.after !== null && gap.before === null);
  return (
    <div ref={hostRef}>
      <FileLevelComments
        path={path}
        threads={threads.filter((thread) => thread.line === null)}
        composing={composer !== null && composer.line === null}
        onSubmit={onSubmitComposer}
        onCancel={onCancelComposer}
      />
      {/* bb's thread page provides a virtualizer for its own scroller; under it Pierre re-renders these diffs on every
          scroll of ours, which flickers. Each file here is mounted near the viewport by LazyMount instead. */}
      {leadingGap === -1 ? null : edgeBand(leadingGap)}
      <VirtualizerContext.Provider value={undefined}>
        <PatchDiff<AnnotationMeta>
          patch={fullPatch}
          options={options}
          lineAnnotations={annotations}
          selectedLines={dragged ?? composerSelection ?? (cursorShown ? cursorSelection : null)}
          disableWorkerPool={workerPool === undefined}
          className="text-xs"
          renderAnnotation={renderAnnotation}
        />
      </VirtualizerContext.Provider>
      {trailingGap === -1 ? null : edgeBand(trailingGap)}
    </div>
  );
}
