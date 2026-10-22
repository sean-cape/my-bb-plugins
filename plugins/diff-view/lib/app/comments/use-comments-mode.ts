// The comments view as a mode of the changes view: entering and leaving it (`gc`), its sections, and what the keys
// can read and do there, the same cursor over every thread's code.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffCommentTarget, DiffFile, LineRange } from "../../types";
import type { ExplainHunk } from "../explanations/use-explanations";
import { firstPosition, type Cursor, type NavFile } from "../keys/nav";
import { focusAt, runReviewCommand, type ReviewEnv } from "../keys/review-commands";
import type { FocusedAnnotation, ReviewKeys } from "../keys/review-keys-context";
import { scrollerEnv } from "../keys/scroller-env";
import { excerptAnnotations } from "../narrative/excerpts";
import type { ComposerAnchor, PatchAnnotationProps } from "../patch-annotations";
import type { RevealBlock } from "../scroll";
import { withMembers } from "../sets";
import type { DiffViewMode } from "../summary-bar";
import { THREAD_FILTER_LABEL, commentSections, nextThreadFilter, type CommentSection, type ThreadFilter } from "./comment-sections";
import type { CommentsCommand } from "./comments-keymap";
import type { DiffThread } from "./threads";

const NO_FINDINGS: PatchAnnotationProps["findings"] = [];

export interface CommentsModeOptions {
  keys: ReviewKeys;
  mode: DiffViewMode;
  setMode: (mode: DiffViewMode) => void;
  /** There are threads, and all the changes are shown. */
  available: boolean;
  /** Why it isn't, when it isn't. */
  unavailable: string;
  narrativeAvailable: boolean;
  enterNarrative: () => void;
  allThreads: readonly DiffThread[];
  threadById: ReadonlyMap<string, DiffThread>;
  files: readonly DiffFile[];
  currentPaths: ReadonlySet<string>;
  composer: ({ path: string } & ComposerAnchor) | null;
  setComposer: (composer: null) => void;
  addComment: (path: string, range: LineRange, body: string, target: DiffCommentTarget) => Promise<void>;
  onToggleFinding: PatchAnnotationProps["onToggleFinding"];
  onEditFinding: PatchAnnotationProps["onEditFinding"];
  explainHunk: ExplainHunk | null;
  /** The files view's keys, which the comments view's start from. */
  filesEnv: () => ReviewEnv;
  startComment: (path: string, anchor: ComposerAnchor) => void;
  markViewed: (path: string, isViewed: boolean) => boolean;
  reveal: (cursor: Cursor, block?: RevealBlock) => void;
  parkCursor: (path: string) => void;
  focusRoot: () => void;
  /** The files view with the cursor here (see `DiffView`'s `showInFiles`). */
  showInFiles: (cursor: Cursor | null, focused?: FocusedAnnotation | null) => void;
  /** The files view at a file's header. */
  openFileInFiles: (path: string) => void;
  notify: (message: string) => void;
}

export function useCommentsMode(options: CommentsModeOptions) {
  const { keys, mode, allThreads, files, currentPaths, threadById, composer, notify } = options;
  const [filter, setFilter] = useState<ThreadFilter>("all");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const sections = useMemo(() => commentSections(allThreads, files, filter), [allThreads, files, filter]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  /** Where `gc` returns to: the view it was pressed in, and the cursor there. */
  const back = useRef<{ mode: "files" | "narrative"; cursor: Cursor | null } | null>(null);
  const enter = () => {
    if (!options.available) {
      notify(options.unavailable);
      return;
    }
    back.current = { mode: mode === "narrative" ? "narrative" : "files", cursor: keys.get().cursor };
    options.setMode("comments");
    options.focusRoot();
  };
  const leave = () => {
    const to = back.current ?? { mode: "files" as const, cursor: null };
    back.current = null;
    if (to.mode === "narrative" && options.narrativeAvailable) {
      keys.set({ cursor: to.cursor, visual: null, focused: null });
      options.setMode("narrative");
      options.focusRoot();
      return;
    }
    options.showInFiles(to.cursor, null);
  };

  const navFiles = (): NavFile[] => sections.map((section) => ({ path: section.key, collapsed: collapsed.has(section.key), rows: keys.models.get(section.key)?.rows ?? null }));
  /** Comments start only on today's lines: a section of the current diff, not GitHub's stored hunk. */
  const commentable = (key: string): boolean => {
    const section = sections.find((entry) => entry.key === key);
    if (section?.kind === "outdated") {
      notify("These are the lines as they were; comment on today's lines (gf opens the file)");
      return false;
    }
    if (!currentPaths.has(key)) {
      notify(`${key} is not in the current diff`);
      return false;
    }
    return true;
  };
  const explainHunk = options.explainHunk;
  const env = (): ReviewEnv => ({
    ...options.filesEnv(),
    ...scrollerEnv({ keys, scroller: () => scrollRef.current, files: navFiles, section: (key) => sectionRefs.current.get(key), reveal: options.reveal, park: options.parkCursor }),
    // The keys find threads by the section that draws them; actions take the thread by id.
    threads: sections.flatMap((section) => section.threads.map((thread) => ({ ...thread, path: section.key }))),
    findings: [],
    startComment: (path, range) => {
      if (commentable(path)) options.startComment(path, range);
    },
    markViewed: (path, isViewed) => {
      if (currentPaths.has(path)) return options.markViewed(path, isViewed);
      notify("Mark files viewed from today's lines");
      return false;
    },
    explain: explainHunk === null ? null : (path, side, startLine, endLine) => (commentable(path) ? explainHunk(path, side, startLine, endLine) : undefined),
    setCollapsed: (paths, isCollapsed) => setCollapsed((current) => withMembers(current, paths, isCollapsed)),
    toggleFileTree: () => notify("The comments view has no file list"),
    focusFileTree: () => false,
    findingFilter: null,
    filteredFindings: null,
    focusOutsideFindings: () => false,
    search: null,
  });
  const envRef = useRef(env);
  envRef.current = env;
  // The comments view opens at its top, on the first section.
  useEffect(() => {
    if (mode !== "comments") return;
    scrollRef.current?.scrollTo({ top: 0 });
    const now = envRef.current();
    const first = firstPosition(now.files, keys.get().cursor?.want ?? "RIGHT");
    keys.set({ cursor: first, visual: null, focused: first === null ? null : focusAt(now, first) });
  }, [mode, keys]);

  /** `gf`: the files view at the thread's line, or at its file when the thread has no line there today. */
  const openThread = (section: CommentSection | null) => {
    const state = keys.get();
    const here = section ?? sections.find((entry) => entry.key === state.cursor?.path) ?? null;
    if (here === null) {
      notify("No thread here");
      return;
    }
    const focused = state.focused?.kind === "thread" && state.cursor?.path === here.key ? threadById.get(state.focused.id) : undefined;
    const thread = focused ?? (here.threads[0] === undefined ? undefined : threadById.get(here.threads[0].id));
    const path = thread?.path ?? here.path;
    if (!currentPaths.has(path)) {
      notify(`${path} is not in the current diff`);
      return;
    }
    const want = state.cursor?.want ?? "RIGHT";
    const onLine = section === null && here.kind === "current" && state.cursor !== null && state.cursor.line !== null ? state.cursor : null;
    const target: Cursor | null =
      thread !== undefined && !thread.outdated && thread.line !== null && (onLine === null || focused !== undefined) ? { path, side: thread.side, line: thread.line, want } : onLine;
    if (target === null) options.openFileInFiles(path);
    else options.showInFiles(target, thread === undefined ? null : { kind: "thread", id: thread.id });
  };

  const run = (command: CommentsCommand, count: number) => {
    const state = keys.get();
    switch (command.kind) {
      case "commentsView":
        leave();
        return;
      case "narrative":
        options.enterNarrative();
        return;
      case "threadFilter": {
        const next = nextThreadFilter(filter);
        setFilter(next);
        notify(`Threads: ${THREAD_FILTER_LABEL[next].toLowerCase()}`);
        return;
      }
      case "openInFiles":
        openThread(null);
        return;
      case "findFile":
      case "searchNext":
      case "searchText":
        notify("Search from the files view (gc goes back)");
        return;
      case "side":
        // No file list here to step left into.
        if (command.side === "LEFT" && state.cursor !== null && (state.cursor.line === null || state.cursor.side === "LEFT" || state.cursor.want === "LEFT")) return;
        runReviewCommand(command, count, env());
        return;
      default:
        runReviewCommand(command, count, env());
    }
  };

  const annotationsFor = (section: CommentSection): PatchAnnotationProps => {
    const fileComposer = section.kind === "current" && composer !== null && composer.path === section.key ? composer : null;
    const shownComposer = fileComposer === null || fileComposer.line === null || section.patch === null ? (fileComposer?.line === null ? fileComposer : null) : excerptAnnotations(section.patch, [], [], fileComposer).composer;
    return {
      path: section.key,
      threads: section.threads,
      composer: shownComposer,
      onStartComment: (anchor) => env().startComment(section.key, anchor),
      onCancelComposer: () => options.setComposer(null),
      onSubmitComposer: (body, target) => (fileComposer === null ? Promise.resolve() : options.addComment(section.path, fileComposer, body, target)),
      findings: NO_FINDINGS,
      onToggleFinding: options.onToggleFinding,
      onEditFinding: options.onEditFinding,
    };
  };

  return {
    enter,
    run,
    sections,
    filter,
    setFilter,
    collapsed,
    scrollRef,
    sectionRef: (key: string, node: HTMLElement | null) => {
      if (node === null) sectionRefs.current.delete(key);
      else sectionRefs.current.set(key, node);
    },
    sectionOf: (key: string) => sectionRefs.current.get(key),
    toggleCollapsed: (key: string) => env().setCollapsed([key], !collapsed.has(key)),
    annotationsFor,
    openThread,
  };
}
