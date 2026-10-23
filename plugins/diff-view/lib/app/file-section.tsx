import { useState, type RefObject } from "react";
import { experimental_Diff as Diff, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { DiffFile, HunkExplanation, SemanticChange, SymbolLookup } from "../types";
import { Badge } from "./ui/badge";
import { Button, COMPACT } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { CHEVRON, FAST, OPACITY_TRANSITION, STAGGER, STAGGER_CAP, enter, stagger, useOpenedSinceMount } from "./ui/motion";
import { cn } from "./utils";
import { useDiffPreferences } from "./state";
import { LARGE_FILE_CHANGED_LINES, isGeneratedFile, isLargeFile } from "./generated";
import { LazyMount } from "./lazy-mount";
import type { PatchAnnotationProps } from "./patch-annotations";
import { FileLevelComments } from "./comments/file-level-comments";
import { FindingAnnotation } from "./findings/finding-annotation";
import { findingAnchorId } from "./findings/findings";
import { StructuralPatch } from "./structural/structural-patch";
import { AnnotatedPatch } from "./text/annotated-patch";
import { DiffErrorBoundary } from "./text/diff-error-boundary";
import { CURSOR_RING, CURSOR_SHOWN, useCursorOnHeader, usePublishNavModel, type FileNavModel } from "./keys/review-keys-context";
import { ChangeCounts, FileGlyph } from "./file-marks";
import { useNerdFont } from "./ui/nerd-font";
import { PatchPlaceholder } from "./large-diff";
import { FileHeaderMenu } from "./file-actions";
import type { ShownPatch } from "./patches";
import type { NewSince } from "./new-since";

export type { ShownPatch } from "./patches";

const NO_ROWS: FileNavModel = { rows: [], cutToHunk: false, element: () => null };

/** A file with no diff to step through still tells the keyboard it has loaded, so the cursor moves past it. */
export function NoRows({ path }: { path: string }) {
  usePublishNavModel(path, NO_ROWS);
  return null;
}

/**
 * One changed file: a sticky header (collapse, name, stats, comment on file, viewed) over its whole-file findings and
 * its diff, mounted once scrolled near. Vendored files and files without a structural diff fall back to text.
 */
export function FileSection({
  file,
  index,
  sectionRef,
  scrollRoot,
  collapsed,
  viewed,
  onToggleCollapsed,
  onMarkViewed,
  onCommentOnFile,
  annotations,
  onOpenFile,
  explanations,
  onExplain,
  semantics,
  newSince,
  shown,
  loadedPatch,
  onPatchLoaded,
  searchLine = null,
}: {
  file: DiffFile;
  /** Position in the file list, for the entrance cascade. */
  index: number;
  sectionRef: (node: HTMLElement | null) => void;
  scrollRoot: RefObject<HTMLElement | null>;
  collapsed: boolean;
  viewed: boolean;
  onToggleCollapsed: () => void;
  onMarkViewed: (viewed: boolean) => void;
  onCommentOnFile: () => void;
  annotations: PatchAnnotationProps;
  onOpenFile: (lookup: SymbolLookup, definition: SymbolLookup["definitions"][number]) => void;
  explanations: HunkExplanation[];
  onExplain: ((side: "old" | "new", startLine: number, endLine: number) => void) | null;
  semantics: SemanticChange[];
  newSince: NewSince;
  shown: ShownPatch;
  /** The patch "Load diff" fetched for a file the diff came without one for. */
  loadedPatch: string | null;
  onPatchLoaded: (patch: string) => void;
  /** The patch line a search took the cursor to in this file, for a structural diff to unfold. */
  searchLine?: { left: number | null; right: number | null } | null;
}) {
  const { layout } = useDiffPreferences();
  const onHeader = useCursorOnHeader(file.path);
  const nerdFont = useNerdFont();
  const reveal = useOpenedSinceMount(!collapsed) ? cn(enter.rise, FAST) : undefined;
  // Sections past the cap are below the fold when the list mounts; animating hundreds of full diffs at once costs a
  // compositor layer each for nothing. Decided at mount, so a refresh that moves a shown file up the list leaves it be.
  const [entrance] = useState(() => (index <= STAGGER_CAP ? { className: cn(enter.fade, STAGGER), style: stagger(index) } : null));
  const patch = file.patch ?? loadedPatch;
  const drawn = shown.patch;
  return (
    <section ref={sectionRef} className={cn("border-b border-border", entrance?.className)} style={entrance?.style}>
      {/* bg-card is opaque: the header is sticky, so the code scrolling under it must not show through. */}
      <div className={cn("group/header sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-1.5", onHeader && CURSOR_RING)} data-cursor={onHeader ? "" : undefined}>
        <Button type="button" variant="ghost" className={cn(COMPACT, "px-1.5")} onClick={onToggleCollapsed} aria-label={collapsed ? "Expand file" : "Collapse file"} aria-expanded={!collapsed} data-bbm-open={!collapsed}>
          <Icon name="ChevronRight" className={cn("size-3.5", CHEVRON)} />
        </Button>
        {nerdFont ? <FileGlyph file={file} className="text-[14px]" /> : null}
        <code className={cn("min-w-0 flex-1 truncate text-xs font-medium", viewed && "text-muted-foreground")}>
          {file.previousPath !== null ? <span className="font-normal text-muted-foreground">{file.previousPath} → </span> : null}
          {file.path}
        </code>
        {!nerdFont && file.status !== "modified" ? <Badge tone="outline">{file.status}</Badge> : null}
        {isGeneratedFile(file) ? (
          <Badge tone="outline" title={file.vendored ? "Vendored; collapsed by default and shown as a text diff" : "Looks generated; collapsed by default"}>
            {file.vendored ? "vendored" : "generated"}
          </Badge>
        ) : isLargeFile(file) ? (
          <Badge tone="outline" title={`Over ${LARGE_FILE_CHANGED_LINES.toLocaleString()} changed lines; collapsed by default`}>
            large
          </Badge>
        ) : null}
        {shown.onlyWhitespace ? (
          <Badge tone="outline" title="Every change in this file is whitespace, which is hidden; collapsed by default (W shows whitespace changes)">
            Only whitespace changed
          </Badge>
        ) : null}
        {newSince.changed ? (
          <Badge tone="fresh" title={`This file changed since ${newSince.label}; its new lines are marked blue in the gutter (]n / [n step through them)`}>
            new since {newSince.label}
          </Badge>
        ) : null}
        <ChangeCounts additions={file.additions} deletions={file.deletions} className="text-xs" />
        <span title="Comment on file (O)" className={cn("opacity-0 focus-within:opacity-100 group-hover/header:opacity-100", OPACITY_TRANSITION, onHeader && `${CURSOR_SHOWN}opacity-100`)}>
          <Button type="button" variant="ghost" className={cn(COMPACT, "px-1.5 text-muted-foreground")} onClick={onCommentOnFile} aria-label="Comment on file">
            <Icon name="MessageSquare" className="size-3.5" />
          </Button>
        </span>
        <FileHeaderMenu file={file} />
        <label className={cn("inline-flex cursor-pointer select-none items-center gap-1.5 text-xs", viewed ? "text-foreground" : "text-muted-foreground")}>
          <Checkbox checked={viewed} onCheckedChange={onMarkViewed} aria-label={`Mark ${file.path} as viewed`} />
          Viewed
        </label>
      </div>
      {collapsed
        ? null
        : annotations.findings
            .filter((entry) => entry.line === null)
            .map((entry) => (
              <div key={`${entry.item.reviewId}:${entry.item.finding.id}`} className={cn("px-3 py-1", reveal)}>
                <FindingAnnotation item={entry.item} anchorId={findingAnchorId(entry)} onToggle={(selected) => annotations.onToggleFinding(entry.item, selected)} onEdit={(edit) => annotations.onEditFinding(entry.item, edit)} />
              </div>
            ))}
      {collapsed ? null : (
        <LazyMount root={scrollRoot} estimateLines={file.additions + file.deletions + 6} className={reveal}>
          {() => {
            // GitHub leaves the patch out of a very large file; difftastic reads the checkout, so it still gets a structural diff.
            const textDiff =
              patch === null ? (
                <>
                  <FileLevelComments
                    path={file.path}
                    threads={annotations.threads}
                    composing={annotations.composer !== null}
                    onSubmit={annotations.onSubmitComposer}
                    onCancel={annotations.onCancelComposer}
                  />
                  <PatchPlaceholder file={file} onLoaded={onPatchLoaded} />
                </>
              ) : drawn === null ? (
                <>
                  <NoRows path={file.path} />
                  <FileLevelComments
                    path={file.path}
                    threads={annotations.threads}
                    composing={annotations.composer !== null}
                    onSubmit={annotations.onSubmitComposer}
                    onCancel={annotations.onCancelComposer}
                  />
                  <p className="p-4 text-sm text-muted-foreground">Only whitespace changed (W shows whitespace changes).</p>
                </>
              ) : (
                <DiffErrorBoundary key={file.path} fallback={
                    <>
                      <NoRows path={file.path} />
                      <Diff patch={drawn} path={file.path} view={layout} className="text-xs" />
                    </>
                  }>
                  <AnnotatedPatch key={file.path} {...annotations} patch={drawn} newSince={newSince} />
                </DiffErrorBoundary>
              );
            // difftastic ignores whitespace already, so a file with nothing else changed skips it while whitespace is hidden.
            return !file.vendored && file.binary !== true && !shown.onlyWhitespace ? (
              <StructuralPatch
                key={`structural-${file.path}`}
                {...annotations}
                onOpenFile={onOpenFile}
                explanations={explanations}
                onExplain={onExplain}
                semantics={semantics}
                newSince={newSince}
                fallback={textDiff}
                fallbackNote={file.patch === null ? "difftastic could not diff this file" : undefined}
                unchangedNote={shown.changed ? "Shown as a line diff: difftastic finds no change beyond formatting" : undefined}
                searchLine={searchLine}
              />
            ) : (
              textDiff
            );
          }}
        </LazyMount>
      )}
    </section>
  );
}
