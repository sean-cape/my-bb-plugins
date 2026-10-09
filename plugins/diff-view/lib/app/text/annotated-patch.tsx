import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { PatchDiff, VirtualizerContext, useWorkerPool } from "@pierre/diffs/react";
import { useDiffPreferences } from "../state";
import { useHostPierreThemes } from "../theme";
import { WHOLE_FILE, type PatchAnnotationProps } from "../patch-annotations";
import { DiffCommentForm } from "../comments/comment-form";
import { FileLevelComments } from "../comments/file-level-comments";
import { DiffThreadView } from "../comments/thread-view";
import { FindingAnnotation } from "../findings/finding-annotation";
import { visualRange, type NavRow } from "../keys/nav";
import { useFileCursor, usePublishNavModel, type FileNavModel } from "../keys/review-keys-context";
import type { DiffSide, LineRange } from "../../types";
import { buildLineAnnotations, fromPierreSide, toPierreSide, type AnnotationMeta, type PierreSide } from "./line-annotations";
import { navRows, patchRows, selectionRange } from "./patch-rows";

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
}: PatchAnnotationProps & { patch: string }) {
  const { layout } = useDiffPreferences();
  const { mode: themeMode } = useCodeTheme();
  const themes = useHostPierreThemes();
  const workerPool = useWorkerPool();
  // GitHub patches lack the `diff --git` header Pierre expects; synthesize one for the file.
  const fullPatch = useMemo(
    () => (patch.startsWith("diff --git") ? patch : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}`),
    [patch, path],
  );
  const rows = useMemo(() => patchRows(fullPatch), [fullPatch]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const nav = useMemo(() => navRows(rows, layout), [rows, layout]);
  const element = useCallback((row: number, side: DiffSide) => (nav[row] === undefined ? null : pierreLine(hostRef.current, nav[row], side)), [nav]);
  const navModel = useMemo<FileNavModel>(() => ({ rows: nav, cutToHunk: true, element }), [nav, element]);
  usePublishNavModel(path, navModel);
  const fileCursor = useFileCursor(path);
  const cursorSelection = useMemo<PierreSelection | null>(() => {
    if (fileCursor === null) return null;
    const { cursor, visual } = fileCursor;
    const range = visual === null ? null : visualRange(nav, visual, cursor, true);
    return toSelection(range ?? { line: cursor.line, side: cursor.side, startLine: null, startSide: null });
  }, [fileCursor, nav]);
  const annotations = useMemo(() => buildLineAnnotations(threads, composer, findings), [threads, composer, findings]);
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
      theme: themes,
      themeType: themeMode,
      disableFileHeader: true,
      overflow: "wrap" as const,
      unsafeCSS: COLUMN_CSS,
      lineHoverHighlight: "both" as const,
      enableGutterUtility: true,
      enableLineSelection: true,
      onGutterUtilityClick: finish,
      onLineSelectionStart: setDragged,
      onLineSelectionChange: setDragged,
      onLineSelectionEnd: finish,
    };
  }, [layout, themes, themeMode, rows]);
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
      <VirtualizerContext.Provider value={undefined}>
        <PatchDiff<AnnotationMeta>
          patch={fullPatch}
          options={options}
          lineAnnotations={annotations}
          selectedLines={dragged ?? composerSelection ?? cursorSelection}
          disableWorkerPool={workerPool === undefined}
          className="text-xs"
          renderAnnotation={({ metadata }) => {
            if (metadata.kind === "composer") {
              return <DiffCommentForm key={metadata.key} path={path} range={composer ?? WHOLE_FILE} onSubmit={onSubmitComposer} onCancel={onCancelComposer} />;
            }
            if (metadata.kind === "finding") {
              const item = metadata.finding;
              return <FindingAnnotation key={metadata.key} item={item} entrance={!committedKeys.current.has(metadata.key)} onToggle={(selected) => onToggleFinding(item, selected)} onEdit={(edit) => onEditFinding(item, edit)} />;
            }
            return <DiffThreadView key={metadata.key} thread={metadata.thread} />;
          }}
        />
      </VirtualizerContext.Provider>
    </div>
  );
}
