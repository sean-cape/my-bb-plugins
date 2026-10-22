import { useContext, useMemo, type RefObject } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { cn } from "../utils";
import { plural } from "../format";
import { Badge } from "../ui/badge";
import { Button, COMPACT } from "../ui/button";
import { CHEVRON, FAST, PRESS, enter } from "../ui/motion";
import { CURSOR_RING, useCursorOnHeader } from "../keys/review-keys-context";
import type { PatchAnnotationProps } from "../patch-annotations";
import { NoRows } from "../file-section";
import { AnnotatedPatch } from "../text/annotated-patch";
import { DiffErrorBoundary } from "../text/diff-error-boundary";
import { DiffCommentsContext, type DiffCommentActions } from "./context";
import { FileLevelComments } from "./file-level-comments";
import { THREAD_FILTERS, THREAD_FILTER_LABEL, type CommentSection, type ThreadFilter, type ThreadStatus } from "./comment-sections";
import type { DiffThread } from "./threads";

/** The comments view's scroller holds one of these per section, for the cursor to find. */
export const COMMENT_SECTION = "data-comment-section";

function SectionView({
  section,
  sectionRef,
  collapsed,
  inDiff,
  annotations,
  onToggleCollapsed,
  onOpen,
}: {
  section: CommentSection;
  sectionRef: (node: HTMLElement | null) => void;
  collapsed: boolean;
  inDiff: boolean;
  annotations: PatchAnnotationProps;
  onToggleCollapsed: () => void;
  onOpen: () => void;
}) {
  const onHeader = useCursorOnHeader(section.key);
  const count = section.threads.length;
  const fileLevel = (
    <FileLevelComments path={section.key} threads={section.threads} composing={annotations.composer !== null && annotations.composer.line === null} onSubmit={annotations.onSubmitComposer} onCancel={annotations.onCancelComposer} />
  );
  return (
    <section ref={sectionRef} {...{ [COMMENT_SECTION]: section.key }} className="overflow-hidden rounded-md border border-border">
      <div className={cn("group/header flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-2 py-1 text-xs", onHeader && CURSOR_RING)} data-cursor={onHeader ? "" : undefined}>
        <Button type="button" variant="ghost" className={cn(COMPACT, "px-1")} onClick={onToggleCollapsed} aria-label={collapsed ? "Expand" : "Collapse"} aria-expanded={!collapsed} data-bbm-open={!collapsed}>
          <Icon name="ChevronRight" className={cn("size-3.5", CHEVRON)} />
        </Button>
        <button type="button" className={cn("flex min-w-0 flex-1 items-baseline gap-2 text-left hover:underline", PRESS)} title="Open in the files view (gf)" onClick={onOpen}>
          <code className="min-w-0 truncate">{section.path}</code>
        </button>
        {section.kind === "outdated" ? (
          <Badge title="The lines as they were when the comment was left, as GitHub stored them; a later push changed them">code at the comment</Badge>
        ) : !inDiff ? (
          <Badge title="This file is no longer in the diff">not in the diff</Badge>
        ) : null}
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {plural(count, "thread")}
        </span>
      </div>
      {collapsed ? (
        <NoRows path={section.key} />
      ) : section.patch !== null ? (
        <DiffErrorBoundary
          fallback={
            <>
              <NoRows path={section.key} />
              {fileLevel}
            </>
          }
        >
          <AnnotatedPatch key={section.key} {...annotations} path={section.key} patch={section.patch} hunkSeparators="simple" />
        </DiffErrorBoundary>
      ) : (
        <>
          <NoRows path={section.key} />
          {fileLevel}
        </>
      )}
    </section>
  );
}

/**
 * Every comment thread, grouped by file in diff order, each over its code: today's lines, or the hunk GitHub stored
 * for an outdated thread. Threads are drawn where the files view draws them, so the same keys act on them. Each
 * thread here may sit on a display line (an outdated one's original line); replies and resolves go to the thread
 * itself, found by id.
 */
export function CommentsView({
  sections,
  originals,
  filter,
  counts,
  onFilter,
  scrollRef,
  sectionRef,
  collapsed,
  inDiff,
  annotationsFor,
  onToggleCollapsed,
  onOpen,
}: {
  sections: CommentSection[];
  originals: ReadonlyMap<string, DiffThread>;
  filter: ThreadFilter;
  counts: Record<ThreadStatus, number>;
  onFilter: (filter: ThreadFilter) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  sectionRef: (key: string, node: HTMLElement | null) => void;
  collapsed: ReadonlySet<string>;
  inDiff: (path: string) => boolean;
  annotationsFor: (section: CommentSection) => PatchAnnotationProps;
  onToggleCollapsed: (key: string) => void;
  onOpen: (section: CommentSection) => void;
}) {
  const actions = useContext(DiffCommentsContext);
  const scoped = useMemo<DiffCommentActions>(() => {
    const original = (thread: DiffThread) => originals.get(thread.id) ?? thread;
    return { ...actions, onReply: (thread, body, target) => actions.onReply(original(thread), body, target), onResolve: (thread, resolved) => actions.onResolve(original(thread), resolved) };
  }, [actions, originals]);
  const total = counts.open + counts.resolved + counts.outdated;
  const countOf = (value: ThreadFilter) => (value === "all" ? total : counts[value]);
  return (
    <DiffCommentsContext.Provider value={scoped}>
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className={cn("flex flex-col gap-3 px-4 py-3", enter.fade, FAST)}>
          <div role="radiogroup" aria-label="Which threads show" className="flex flex-wrap items-center gap-1 text-[11px]">
            {THREAD_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                title="F cycles the filter"
                className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", PRESS, filter === value ? "border-primary/50 bg-state-active text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                onClick={() => onFilter(value)}
              >
                {THREAD_FILTER_LABEL[value]}
                <span className="tabular-nums opacity-70">{countOf(value)}</span>
              </button>
            ))}
            <span className="ml-auto text-muted-foreground">F filter · gf open in files · gc back</span>
          </div>
          {sections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No {filter === "all" ? "" : `${THREAD_FILTER_LABEL[filter].toLowerCase()} `}comment threads. F shows the others.</p>
          ) : null}
          {sections.map((section) => (
            <SectionView
              key={section.key}
              section={section}
              sectionRef={(node) => sectionRef(section.key, node)}
              collapsed={collapsed.has(section.key)}
              inDiff={inDiff(section.path)}
              annotations={annotationsFor(section)}
              onToggleCollapsed={() => onToggleCollapsed(section.key)}
              onOpen={() => onOpen(section)}
            />
          ))}
        </div>
      </div>
    </DiffCommentsContext.Provider>
  );
}
