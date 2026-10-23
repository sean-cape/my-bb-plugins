import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useCallback } from "react";
import { refLabel, type PatchLine } from "../../narrative";
import { cn } from "../utils";
import { Button, COMPACT } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { CHEVRON, OPACITY_TRANSITION, PRESS } from "../ui/motion";
import { CURSOR_RING, CURSOR_SHOWN, useCursorOnHeader } from "../keys/review-keys-context";
import { useDiffPreferences } from "../state";
import type { PatchAnnotationProps } from "../patch-annotations";
import { NoRows } from "../file-section";
import { AnnotatedPatch } from "../text/annotated-patch";
import { DiffErrorBoundary } from "../text/diff-error-boundary";
import type { StepExcerpt } from "./excerpts";

export type { StepExcerpt } from "./excerpts";
export { stepExcerpts } from "./excerpts";

/**
 * One file's lines in a step: a header the cursor can rest on (comment on the file, mark it viewed, open it in the
 * files view) over the same line-diff renderer the files view uses, so comments, findings and the cursor work on its
 * lines exactly as there. `annotations` is null when the step's lines are not today's lines (an earlier narrative, a
 * revision, a stale story), and the excerpt then shows no comments and takes none.
 */
export function ExcerptSection({
  excerpt,
  sectionRef,
  collapsed,
  viewed,
  annotations,
  onToggleCollapsed,
  onMarkViewed,
  onCommentOnFile,
  onOpen,
  onReveal,
}: {
  excerpt: StepExcerpt;
  sectionRef: (node: HTMLElement | null) => void;
  collapsed: boolean;
  viewed: boolean;
  annotations: PatchAnnotationProps | null;
  onToggleCollapsed: () => void;
  onMarkViewed: (viewed: boolean) => void;
  onCommentOnFile: () => void;
  onOpen: () => void;
  /** Open rows of the file's patch the step's cut leaves out. */
  onReveal: (path: string, lines: readonly PatchLine[]) => void;
}) {
  const onHeader = useCursorOnHeader(excerpt.path);
  const reveal = useCallback((lines: readonly PatchLine[]) => onReveal(excerpt.path, lines), [onReveal, excerpt.path]);
  const { narrativeLayout } = useDiffPreferences();
  const inert = annotations === null;
  return (
    <section ref={sectionRef} data-narrative-excerpt={excerpt.path} className="overflow-hidden rounded-lg border border-border">
      <div className={cn("group/header flex flex-wrap items-center gap-2 border-b border-border bg-card px-2 py-1 text-xs", onHeader && CURSOR_RING)} data-cursor={onHeader ? "" : undefined}>
        <Button type="button" variant="ghost" className={cn(COMPACT, "px-1")} onClick={onToggleCollapsed} aria-label={collapsed ? "Expand excerpt" : "Collapse excerpt"} aria-expanded={!collapsed} data-bbm-open={!collapsed}>
          <Icon name="ChevronRight" className={cn("size-3.5", CHEVRON)} />
        </Button>
        <button type="button" className={cn("flex min-w-0 flex-1 items-baseline gap-2 text-left hover:underline", PRESS)} title="Open these lines in the files view (gf)" onClick={onOpen}>
          <code className="min-w-0 truncate font-medium">{excerpt.path}</code>
          <span className="shrink-0 text-muted-foreground">{excerpt.refs.map(refLabel).join(", ")}</span>
        </button>
        {inert ? null : (
          <>
            <span title="Comment on file (O)" className={cn("opacity-0 focus-within:opacity-100 group-hover/header:opacity-100", OPACITY_TRANSITION, onHeader && `${CURSOR_SHOWN}opacity-100`)}>
              <Button type="button" variant="ghost" className={cn(COMPACT, "px-1.5 text-muted-foreground")} onClick={onCommentOnFile} aria-label="Comment on file">
                <Icon name="MessageSquare" className="size-3.5" />
              </Button>
            </span>
            <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-muted-foreground">
              <Checkbox checked={viewed} onCheckedChange={onMarkViewed} aria-label={`Mark ${excerpt.path} as viewed`} />
              Viewed
            </label>
          </>
        )}
      </div>
      {collapsed ? (
        <NoRows path={excerpt.path} />
      ) : excerpt.patch !== null ? (
        <DiffErrorBoundary fallback={<NoRows path={excerpt.path} />}>
          <AnnotatedPatch key={excerpt.path} {...(annotations ?? INERT)} path={excerpt.path} patch={excerpt.patch} layout={narrativeLayout} hunkSeparators="simple" gaps={{ list: excerpt.gaps, reveal }} />
        </DiffErrorBoundary>
      ) : (
        <>
          <NoRows path={excerpt.path} />
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {excerpt.file === null ? "This file is not in the diff the narrative was written against." : excerpt.file.patch === null ? "No text diff for this file (binary or too large)." : "These lines are outside the diff's hunks."}
          </p>
        </>
      )}
    </section>
  );
}

/** Annotations for lines that are not today's: nothing to show, and a comment started by the pointer is dropped. */
const INERT: Omit<PatchAnnotationProps, "path"> = {
  threads: [],
  composer: null,
  onStartComment: () => {},
  onCancelComposer: () => {},
  onSubmitComposer: () => Promise.resolve(),
  findings: [],
  onToggleFinding: () => {},
  onEditFinding: () => Promise.resolve(),
};
