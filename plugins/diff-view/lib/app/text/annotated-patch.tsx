import { useEffect, useMemo, useRef, useState } from "react";
import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { PatchDiff, useWorkerPool } from "@pierre/diffs/react";
import { useDiffPreferences } from "../state";
import { useHostPierreThemes } from "../theme";
import { WHOLE_FILE, type PatchAnnotationProps } from "../patch-annotations";
import { DiffCommentForm } from "../comments/comment-form";
import { FileLevelComments } from "../comments/file-level-comments";
import { DiffThreadView } from "../comments/thread-view";
import { FindingAnnotation } from "../findings/finding-annotation";
import { buildLineAnnotations, fromPierreSide, toPierreSide, type AnnotationMeta, type PierreSide } from "./line-annotations";
import { patchRows, selectionRange } from "./patch-rows";

interface PierreSelection {
  start: number;
  side?: PierreSide;
  end: number;
  endSide?: PierreSide;
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
  const { layout, wrap } = useDiffPreferences();
  const { mode: themeMode } = useCodeTheme();
  const themes = useHostPierreThemes();
  const workerPool = useWorkerPool();
  // GitHub patches lack the `diff --git` header Pierre expects; synthesize one for the file.
  const fullPatch = useMemo(
    () => (patch.startsWith("diff --git") ? patch : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}`),
    [patch, path],
  );
  const rows = useMemo(() => patchRows(fullPatch), [fullPatch]);
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
    () =>
      composerLine === null
        ? null
        : { start: composerStartLine ?? composerLine, side: toPierreSide(composerStartSide ?? composerSide), end: composerLine, endSide: toPierreSide(composerSide) },
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
  const options = useMemo(() => {
    const finish = (selection: PierreSelection | null) => {
      setDragged(null);
      if (selection === null) return;
      onStartComment(
        selectionRange(rows, { line: selection.start, side: fromPierreSide(selection.side) }, { line: selection.end, side: fromPierreSide(selection.endSide ?? selection.side) }),
      );
    };
    return {
      diffStyle: layout,
      theme: themes,
      themeType: themeMode,
      disableFileHeader: true,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      lineHoverHighlight: "both" as const,
      enableGutterUtility: true,
      enableLineSelection: true,
      onGutterUtilityClick: finish,
      onLineSelectionStart: setDragged,
      onLineSelectionChange: setDragged,
      onLineSelectionEnd: finish,
    };
  }, [layout, themes, themeMode, wrap, onStartComment, rows]);
  return (
    <>
      <FileLevelComments
        path={path}
        threads={threads.filter((thread) => thread.line === null)}
        composing={composer !== null && composer.line === null}
        onSubmit={onSubmitComposer}
        onCancel={onCancelComposer}
      />
      <PatchDiff<AnnotationMeta>
        patch={fullPatch}
        options={options}
        lineAnnotations={annotations}
        selectedLines={dragged ?? composerSelection}
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
    </>
  );
}
