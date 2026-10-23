import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { NarrativeStep } from "../../types";
import { cn } from "../utils";
import { FAST, PRESS, STAGGER, enter, stagger } from "../ui/motion";
import { runListMotion, runListScroll, useKeyHandler } from "../ui/vim-keys";
import { FILE_TREE_KEYMAP, type FileTreeCommand } from "../keys/keymap";
import type { PatchAnnotationProps } from "../patch-annotations";
import { RISK_DOT } from "../risk";
import { UNCOVERED_STEP_ID, type NarrativeChapter, type StepAddress } from "./chapters";
import { ExcerptSection } from "./step-excerpts";
import type { NarrativeReader } from "./use-narrative-reader";

/** The outline beside the steps; its rows take the list keys before the review keys. */
export const NARRATIVE_OUTLINE = "[data-narrative-outline]";
const ROW_FOCUS = "outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70";
/** A chapter page's section names, set like the view's other labels rather than as small caps. */
const SECTION_HEADING = "border-b border-border pb-1 text-xs font-medium text-foreground";
/** The prose reads in a measured column; the excerpts under it take the pane's whole width, so split diffs wrap less. */
const PROSE = "mx-auto flex w-full max-w-5xl flex-col gap-3";

/**
 * What the view can ask of the agent: write a first narrative, update a stale one, or rewrite; the thread writing
 * one now; the thread whose attempt failed; and the thread that wrote the newest one.
 */
export interface NarrativeWriting {
  running: { threadId: string } | null;
  failed: { threadId: string } | null;
  /** The thread that wrote the newest completed narrative. */
  threadId: string | null;
  starting: boolean;
  label: "Write narrative" | "Write update" | "Rewrite";
  generate: () => void;
  openThread: (threadId: string) => void;
}

/**
 * The narrative review: the agent's walk through the change one step at a time, each step's explanation over just
 * the lines it covers, rendered by the same line-diff renderer as the files view so the cursor and the comment keys
 * work on them. Chapters run oldest first, so a reader who read an earlier narrative steps on through what changed
 * since into the current one. The keys live with the diff view; this renders what the reader hook holds.
 */
export function NarrativeView({
  reader,
  scrollRef,
  sectionRef,
  loaded,
  error,
  stale,
  writing,
  viewed,
  annotationsFor,
  onMarkViewed,
  onCommentOnFile,
  onOpenExcerpt,
  onOpenPath,
  onNarratedViewed,
  onLeaveOutline,
}: {
  reader: NarrativeReader;
  scrollRef: RefObject<HTMLDivElement | null>;
  sectionRef: (path: string, node: HTMLElement | null) => void;
  /** The story has been fetched (even if it holds no narrative). */
  loaded: boolean;
  error: string | null;
  stale: boolean;
  writing: NarrativeWriting;
  viewed: ReadonlySet<string>;
  /** The files view's annotations for a path, cut to the excerpt by the caller; null while the step's lines are not today's. */
  annotationsFor: (path: string, patch: string) => PatchAnnotationProps | null;
  onMarkViewed: (path: string, viewed: boolean) => void;
  onCommentOnFile: (path: string) => void;
  /** Open the files view on the excerpt. */
  onOpenExcerpt: (path: string) => void;
  /** Open the files view on a file named in the reading order; null when the list cannot open files. */
  onOpenPath: ((path: string) => void) | null;
  onNarratedViewed: () => void;
  onLeaveOutline: () => void;
}) {
  const { chapters, address, chapter, step, excerpts } = reader;
  const go = (next: StepAddress) => {
    if (reader.go(next)) scrollRef.current?.scrollTo({ top: 0 });
  };
  return (
    <>
      {reader.outline && chapters.length > 0 ? <NarrativeOutline chapters={chapters} address={address} read={reader.read} stale={stale} writing={writing} onGo={go} onHide={() => reader.setOutline(false)} onLeave={onLeaveOutline} /> : null}
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {error !== null ? <p className={cn("px-4 py-3 text-sm text-destructive", enter.fade)}>{error}</p> : null}
        {!loaded && error === null ? <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p> : null}
        {loaded && chapters.length === 0 ? (
          <div className={cn("mx-auto flex max-w-2xl flex-col items-start gap-3 px-4 py-8 text-sm", enter.fade)}>
            <h2 className="text-base font-semibold">No narrative yet</h2>
            {writing.failed !== null && writing.running === null ? (
              <p className="text-destructive">
                The last attempt failed.{" "}
                <button type="button" className="underline" onClick={() => writing.openThread(writing.failed!.threadId)}>
                  Open its thread
                </button>{" "}
                for details.
              </p>
            ) : null}
            <p className="text-muted-foreground">
              {writing.running !== null
                ? "An agent is writing the narrative; it shows here when the thread finishes."
                : "An agent walks through the change step by step: every changed line in at least one step, each step's explanation over just its lines, with diagrams where they help. The same keys work on those lines as in the files view."}
            </p>
            <WritingButton writing={writing} prominent />
          </div>
        ) : null}
        {chapter !== null && address !== null ? (
          <div key={`${chapter.key}:${address.step}`} className={cn("flex flex-col gap-3 px-4 py-4", enter.fade, FAST)}>
            {step === null ? (
              <div className={PROSE}>
                <ChapterIntro chapter={chapter} stale={chapter.current && stale} writing={writing} onGo={(index) => go({ chapter: address.chapter, step: index })} onOpenPath={chapter.current && !stale ? onOpenPath : null} />
              </div>
            ) : (
              <StepPage
                chapter={chapter}
                step={step}
                index={address.step}
                affected={(id) => {
                  const target = reader.affected(id);
                  return target === null ? null : { title: chapters[target.chapter]!.steps[target.step]!.title, go: () => go(target) };
                }}
              >
                {excerpts.map((excerpt) => (
                  <ExcerptSection
                    key={excerpt.path}
                    excerpt={excerpt}
                    sectionRef={(node) => sectionRef(excerpt.path, node)}
                    collapsed={reader.collapsed.has(excerpt.path)}
                    viewed={viewed.has(excerpt.path)}
                    annotations={excerpt.patch === null ? null : annotationsFor(excerpt.path, excerpt.patch)}
                    onToggleCollapsed={() => reader.setCollapsed([excerpt.path], !reader.collapsed.has(excerpt.path))}
                    onMarkViewed={(isViewed) => onMarkViewed(excerpt.path, isViewed)}
                    onCommentOnFile={() => onCommentOnFile(excerpt.path)}
                    onOpen={() => onOpenExcerpt(excerpt.path)}
                    onReveal={reader.reveal}
                  />
                ))}
              </StepPage>
            )}
            <div className={PROSE}>
              {reader.narratedUnviewed.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Every step of {reader.narratedUnviewed.map((path) => path.split("/").pop()).join(", ")} is read.{" "}
                  <button type="button" className="underline" onClick={onNarratedViewed}>
                    Mark {reader.narratedUnviewed.length === 1 ? "it" : "them"} viewed (gv)
                  </button>
                </p>
              ) : null}
              <PageFooter chapters={chapters} address={address} onGo={go} />
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function WritingButton({ writing, prominent = false }: { writing: NarrativeWriting; prominent?: boolean }) {
  const base = prominent ? "rounded border border-border px-2 py-1 text-xs hover:bg-state-hover" : "rounded px-1.5 py-0.5 hover:bg-state-hover hover:text-foreground";
  if (writing.running !== null) {
    return (
      <button type="button" className={cn(base, PRESS)} title="Open the thread writing the narrative" onClick={() => writing.openThread(writing.running!.threadId)}>
        Writing… open thread
      </button>
    );
  }
  return (
    <button type="button" className={cn(base, "disabled:opacity-50", PRESS)} disabled={writing.starting} title="U" onClick={writing.generate}>
      {writing.starting ? "Starting…" : `${writing.label} (U)`}
    </button>
  );
}

function ChapterIntro({ chapter, stale, writing, onGo, onOpenPath }: { chapter: NarrativeChapter; stale: boolean; writing: NarrativeWriting; onGo: (step: number) => void; onOpenPath: ((path: string) => void) | null }) {
  const coverage = chapter.coverage;
  return (
    <>
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted-foreground">{chapter.kind === "revision" ? "Revision" : chapter.current ? "Current narrative" : "Earlier narrative"}</p>
        {chapter.current ? (
          <span className="ml-auto text-xs text-muted-foreground">
            <WritingButton writing={writing} />
          </span>
        ) : null}
      </div>
      <h2 className="text-base font-semibold">{chapter.title}</h2>
      {stale ? <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-200">The code moved since this narrative was written. U writes an update that explains what changed.</p> : null}
      <Markdown content={chapter.summary} className="text-sm" />
      {chapter.readingOrder.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className={SECTION_HEADING}>Reading order</h3>
          <ol className="flex flex-col gap-0.5">
            {chapter.readingOrder.map((entry, index) => (
              <li key={`${entry.path}-${index}`} className={cn("flex items-baseline gap-2 text-xs", enter.rise, FAST, STAGGER)} style={stagger(index + 1)}>
                <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">{index + 1}</span>
                <span className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", entry.role === "key" ? "bg-red-500" : entry.role === "supporting" ? "bg-sky-500" : "bg-slate-400")} title={entry.role} />
                {onOpenPath !== null ? (
                  <button type="button" className="shrink-0 font-mono hover:underline" title="Open in the files view" onClick={() => onOpenPath(entry.path)}>
                    {entry.path.split("/").pop()}
                  </button>
                ) : (
                  <code className="shrink-0 text-muted-foreground">{entry.path.split("/").pop()}</code>
                )}
                {entry.risk !== null ? (
                  <span className={cn("shrink-0 rounded px-1 text-[10px] text-white", RISK_DOT[entry.risk])} title={`review attention ${entry.risk}/5`}>
                    {entry.risk}
                  </span>
                ) : null}
                {entry.lines.length > 0 ? <span className="shrink-0 text-muted-foreground">L{entry.lines.slice(0, 4).join(", ")}</span> : null}
                {entry.note !== "" ? (
                  <span className={cn("min-w-0 truncate", entry.role === "mechanical" ? "text-muted-foreground" : "text-foreground")} title={entry.note}>
                    {entry.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {chapter.notes.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className={SECTION_HEADING}>{chapter.kind === "revision" ? "Notes" : "Watch out"}</h3>
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {chapter.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {coverage !== null ? (
        <p className="text-xs text-muted-foreground">
          {coverage.uncovered.length === 0
            ? `The steps cover all ${coverage.changedLines} changed line${coverage.changedLines === 1 ? "" : "s"}.`
            : `The steps cover ${coverage.coveredLines} of ${coverage.changedLines} changed lines; the last step shows the rest.`}
        </p>
      ) : null}
      <section className="flex flex-col gap-1">
        <h3 className={SECTION_HEADING}>Steps</h3>
        <ol className="flex flex-col gap-0.5 text-sm">
          {chapter.steps.map((entry, index) => (
            <li key={`${entry.id}-${index}`} className="flex items-baseline gap-2">
              <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
              <button type="button" className={cn("min-w-0 text-left hover:underline", entry.id === UNCOVERED_STEP_ID && "text-amber-700 dark:text-amber-300")} onClick={() => onGo(index)}>
                {entry.title}
              </button>
            </li>
          ))}
        </ol>
      </section>
      {chapter.steps.length > 0 ? <p className="text-xs text-muted-foreground">l starts the first step; j reads on into it.</p> : null}
    </>
  );
}

function StepPage({ chapter, step, index, affected, children }: { chapter: NarrativeChapter; step: NarrativeStep; index: number; affected: (id: string) => { title: string; go: () => void } | null; children: ReactNode }) {
  const uncovered = step.id === UNCOVERED_STEP_ID;
  const links = step.affects.map(affected).filter((link) => link !== null);
  return (
    <>
      <div className={PROSE}>
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span className="font-medium tabular-nums">
            {chapter.kind === "revision" ? "What changed" : "Step"} {index + 1} of {chapter.steps.length}
          </span>
          <span className="min-w-0 truncate">{chapter.title}</span>
        </p>
        <h2 className={cn("text-base font-semibold", uncovered && "text-amber-700 dark:text-amber-300")}>{step.title}</h2>
        {step.body !== "" ? <Markdown content={step.body} className="text-sm" /> : null}
        {links.length > 0 ? (
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
            Shows up in
            {links.map((link, position) => (
              <button key={position} type="button" className={cn("rounded border border-border px-1.5 py-px text-foreground hover:bg-state-hover", PRESS)} title={position === 0 ? "ga" : undefined} onClick={link.go}>
                {link.title}
              </button>
            ))}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </>
  );
}

function PageFooter({ chapters, address, onGo }: { chapters: NarrativeChapter[]; address: StepAddress; onGo: (address: StepAddress) => void }) {
  const all = chapters.flatMap((chapter, index) => [{ chapter: index, step: -1 }, ...chapter.steps.map((_, step) => ({ chapter: index, step }))]);
  const here = all.findIndex((page) => page.chapter === address.chapter && page.step === address.step);
  const previous = all[here - 1];
  const next = all[here + 1];
  const label = (at: StepAddress) => (at.step < 0 ? chapters[at.chapter]!.title : chapters[at.chapter]!.steps[at.step]!.title);
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
      {previous !== undefined ? (
        <button type="button" className={cn("flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-state-hover hover:text-foreground", PRESS)} title="Previous page (h)" onClick={() => onGo(previous)}>
          <Icon name="ChevronLeft" className="size-3 shrink-0" />
          <span className="truncate">{label(previous)}</span>
        </button>
      ) : null}
      <span className="mx-auto tabular-nums">
        {here + 1} / {all.length}
      </span>
      {next !== undefined ? (
        <button type="button" className={cn("flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-state-hover hover:text-foreground", PRESS)} title="Next page (l)" onClick={() => onGo(next)}>
          <span className="truncate">{label(next)}</span>
          <Icon name="ChevronRight" className="size-3 shrink-0" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Chapters and their steps beside the step, in wide views; the read ones are ticked. `h` from the step's code lands
 * here, where j/k move, Enter opens a step and Escape returns, as in the file list.
 */
function NarrativeOutline({
  chapters,
  address,
  read,
  stale,
  writing,
  onGo,
  onHide,
  onLeave,
}: {
  chapters: NarrativeChapter[];
  address: StepAddress | null;
  read: ReadonlySet<string>;
  stale: boolean;
  writing: NarrativeWriting;
  onGo: (address: StepAddress) => void;
  onHide: () => void;
  onLeave: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [address]);
  const onKeyDown = useKeyHandler<FileTreeCommand>({
    keymap: FILE_TREE_KEYMAP,
    counts: true,
    onCommand: (command, { count }) => {
      const list = listRef.current;
      if (list === null) return false;
      switch (command.kind) {
        case "list":
          return runListMotion(list, command.motion, { count });
        case "scroll":
          return runListScroll(list, command.step, 0.5);
        case "leave":
          onLeave();
          return;
        case "hide":
          onHide();
          onLeave();
          return;
      }
    },
  });
  const pick = (next: StepAddress) => {
    onGo(next);
    onLeave();
  };
  return (
    <nav aria-label="Narrative outline" data-narrative-outline="" className="hidden w-64 shrink-0 flex-col border-r border-border text-xs @3xl:flex" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-1 border-b border-border bg-muted/20 px-2 py-1 text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">Outline</span>
        {stale ? (
          <span className="shrink-0 rounded border border-amber-500/50 px-1 text-[10px] text-amber-700 dark:text-amber-300" title="The code moved since the newest narrative">
            stale
          </span>
        ) : null}
        {writing.threadId !== null && writing.running === null ? (
          <button type="button" className={cn("shrink-0 rounded px-1 py-0.5 hover:bg-state-hover hover:text-foreground", PRESS)} title="Open the thread that wrote this narrative" onClick={() => writing.openThread(writing.threadId!)}>
            thread
          </button>
        ) : null}
        {writing.running !== null ? <WritingButton writing={writing} /> : null}
        <button type="button" className={cn("rounded p-0.5 hover:bg-state-hover hover:text-foreground", PRESS)} aria-label="Hide outline" title="Hide outline (t)" onClick={onHide}>
          <Icon name="ChevronDown" className="size-3.5 rotate-90" />
        </button>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-2">
        {chapters.map((chapter, chapterIndex) => {
          const here = address?.chapter === chapterIndex;
          const onIntro = here && address?.step === -1;
          return (
            <section key={chapter.key} className="mb-2">
              <button
                ref={onIntro ? currentRef : undefined}
                type="button"
                tabIndex={-1}
                data-nav-row="item"
                aria-current={onIntro ? "step" : undefined}
                className={cn("w-full px-3 py-1 text-left font-medium hover:bg-state-hover", ROW_FOCUS, onIntro && "bg-state-active", chapter.kind === "revision" && "text-sky-700 dark:text-sky-300")}
                onClick={() => pick({ chapter: chapterIndex, step: -1 })}
              >
                {chapter.title}
              </button>
              <ol>
                {chapter.steps.map((step, stepIndex) => {
                  const current = here && address?.step === stepIndex;
                  const done = read.has(`${chapter.key}/${step.id}`);
                  return (
                    <li key={`${step.id}-${stepIndex}`}>
                      <button
                        ref={current ? currentRef : undefined}
                        type="button"
                        tabIndex={-1}
                        data-nav-row="item"
                        aria-current={current ? "step" : undefined}
                        className={cn(
                          "flex w-full items-baseline gap-1.5 px-3 py-0.5 pl-4 text-left hover:bg-state-hover",
                          ROW_FOCUS,
                          current ? "bg-state-active text-foreground" : "text-muted-foreground",
                          step.id === UNCOVERED_STEP_ID && "text-amber-700 dark:text-amber-300",
                        )}
                        onClick={() => pick({ chapter: chapterIndex, step: stepIndex })}
                      >
                        <span className="w-3 shrink-0 text-center">{done ? "✓" : ""}</span>
                        <span className="min-w-0 truncate">{step.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
    </nav>
  );
}
