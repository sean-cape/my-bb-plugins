// The changes view: a file tree beside every changed file rendered as a structural (difftastic) or text (Pierre)
// diff, with viewed marks, line comments, ⌘-click symbol peeks and, when the data source has them, review findings,
// hunk explanations and an agent-written narrative that walks the same lines step by step with the same keys. It
// renders whatever a `DiffSource` serves, so any plugin can embed it.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { commitRangeKey, type DiffComment, type DiffFile, type SemanticChange, type SymbolLookup } from "../types";
import { otherLayout, readPreference, requestReload, setDiffPreferences, useDiffInstance, useDiffPreferences, writePreference } from "./state";
import { DEFAULT_LABELS, type DiffSource, type DiffViewLabels } from "./source";
import { DeltaStrip, useDelta } from "./delta-strip";
import { FileSection } from "./file-section";
import type { ShownPatch } from "./patches";
import { useLoadedPatches, useShownPatches } from "./use-patches";
import { BlamePopover, fileActionsFor, type FileMenuActions } from "./file-actions";
import { DiffViewProviders } from "./providers";
import { openInNewTab, type LineSpan } from "./links";
import { WHOLE_FILE, type ComposerAnchor, type PatchAnnotationProps } from "./patch-annotations";
import { riskByPath } from "./risk";
import { STICKY_HEADER_PX, cursorLineY } from "./scroll";
import { ScrollMarkers, useScrollMarkers } from "./scroll-markers";
import { SummaryBar, type DiffViewMode } from "./summary-bar";
import { useDiffResult } from "./use-diff-result";
import { useFileMarks } from "./use-file-marks";
import { useReviewKeys } from "./use-review-keys";
import type { DiffCommentActions } from "./comments/context";
import { threadIsOpen, type DiffThread } from "./comments/threads";
import { useComments } from "./comments/use-comments";
import { useExplanations } from "./explanations/use-explanations";
import { FileTreeSidebar } from "./file-tree/file-tree-sidebar";
import { distinctFindings, filterFindings, findingAnchorId, findingsOutsideDiff, inlineFindingsByPath, type ListedFinding, type PlacedFinding } from "./findings/findings";
import { OUTSIDE_FINDINGS, OutsideFindings } from "./findings/outside-findings";
import { useReviews } from "./findings/use-reviews";
import { semanticsByPath as tourSemanticsByPath } from "./tour/tour-report";
import { useTour } from "./tour/use-tour";
import { NARRATIVE_OUTLINE, NarrativeView, type NarrativeWriting } from "./narrative/narrative-view";
import { NARRATIVE_KEY_HELP, NARRATIVE_KEYMAP, type NarrativeCommand } from "./narrative/narrative-keymap";
import { excerptAnnotations } from "./narrative/excerpts";
import { searchSteps, type StepAddress } from "./narrative/chapters";
import { useNarrativeReader } from "./narrative/use-narrative-reader";
import { useNarrativeStory } from "./narrative/use-narrative-story";
import { cursorAt, cursorPosition, firstPosition, lastPosition, rowIndexOf, type Cursor, type NavFile } from "./keys/nav";
import { KEY_HELP, REVIEW_KEYMAP, type ReviewCommand } from "./keys/keymap";
import { KeysOverlay, Picker, SearchBox, fileItems } from "./keys/overlays";
import { focusAt, runReviewCommand, type FindingAnchor, type ReviewEnv } from "./keys/review-commands";
import { createReviewKeys, useReviewKeysState, type FocusedAnnotation } from "./keys/review-keys-context";
import { LINE_PX, scrollPageBy, scrollerEnv, visibleCursor as paneVisibleCursor, type ScrollerPane } from "./keys/scroller-env";
import { useCursorReveal } from "./keys/use-cursor-reveal";
import { threadCounts } from "./comments/thread-code";
import { conversationItems } from "./conversation/conversation";
import { ConversationView } from "./conversation/conversation-view";
import { CONVERSATION_KEY_HELP, CONVERSATION_KEYMAP, type ConversationCommand } from "./conversation/conversation-keymap";
import { useConversationEvents } from "./conversation/use-conversation-events";
import { useConversationMode } from "./conversation/use-conversation-mode";
import { errorMessage, groupByPath, plural } from "./format";
import { cn } from "./utils";
import { enter } from "./ui/motion";
import { focusRow, focusWhenShown, type Keymap } from "./ui/vim-keys";
import { SkeletonLines } from "./ui/skeleton";
import { TruncationBanner } from "./large-diff";
import { useSuggestions } from "./suggestions/use-suggestions";
import { CommitPicker, CommitsButton, useCommitRange } from "./commits/commit-picker";
import { commitsRange, rangeEndsAtHead, rangeLabel } from "./commits/commit-range";
import { useDiffSearch } from "./search/use-diff-search";
import type { SearchedFile } from "./search/diff-search";
import { NO_FILE_FILTER } from "./file-filter";
import { FILE_FILTER_BUTTON, FileFilterMenu } from "./file-tree/file-filter-menu";
import { useFileFilter } from "./file-tree/use-file-filter";
import { viewCorner } from "./ui/popover-place";

export type { DiffSource, DiffViewLabels } from "./source";
export { DiffRefreshButton } from "./toolbar";

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
  /**
   * Controls above the diff, for surfaces with no title bar of their own (a side panel, say). A function gets the
   * comments waiting to be sent, for a host whose heading row holds the send controls; it then tags their container
   * `data-diff-submit-bar` so `s` reaches them.
   */
  toolbar?: ReactNode | ((pending: PendingComments) => ReactNode);
}

const NO_PLACED_FINDINGS: PlacedFinding[] = [];
const NO_THREADS: DiffThread[] = [];
const SWITCH_TO_ALL_FIRST = "switch to All changes (gr) first";
const NO_FILES: DiffFile[] = [];
const NO_SEMANTICS: SemanticChange[] = [];
const NO_RANGES: Array<[number, number]> = [];
const NO_PATCH: ShownPatch = { patch: null, onlyWhitespace: false, changed: false };
/** How long a focus request (the "Review changes with the keyboard" command) stays good for a view that is still mounting. */
const FOCUS_REQUEST_TTL_MS = 5_000;
/** How many lines `j` reads on by when there is no code line to move onto. */
const PROSE_LINES = 3;
/** How long after a wheel or touch event a scroll still counts as the reader's. */
const SCROLL_INTENT_MS = 250;

/** How long focus waits for the new-comment box, which Pierre mounts a beat late. */
const COMPOSER_MOUNT_MS = 500;
/** How long focus waits for the rows of a file list (or outline) just shown. */
const FILE_TREE_MOUNT_MS = 200;

/** The file list and the narrative outline show from the `@3xl` container width (48rem) up. */
const FILE_TREE_MIN_REM = 48;

/** The vim-style mode and half-typed keys, shown while the view has the keyboard. */
function ModeLabel() {
  const { visual, pending } = useReviewKeysState();
  return (
    <span className="pointer-events-none absolute bottom-2 right-4 z-10 hidden rounded bg-background/85 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground shadow-sm group-focus-within/diff:block">
      {visual !== null ? "-- VISUAL LINE --" : "NORMAL"}
      <span className={cn("ml-2 text-foreground", pending === "" && "hidden")}>{pending}</span>
      <span className="ml-2 opacity-70">? keys</span>
    </span>
  );
}
const DIFF_SKELETON = ["38%", "86%", "72%", "91%", "58%", "80%", "66%"];

/** The file the scroller is in, outside React state so scrolling past a file boundary re-renders only the file list. */
function createActivePath() {
  let value: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: string | null) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
type ActivePath = ReturnType<typeof createActivePath>;

function ActiveFileTreeSidebar({ active, ...props }: { active: ActivePath } & Omit<Parameters<typeof FileTreeSidebar>[0], "activePath">) {
  const activePath = useSyncExternalStore(active.subscribe, active.get);
  return <FileTreeSidebar activePath={activePath} {...props} />;
}

const samePlace = (a: Cursor | null, b: Cursor | null) => a === b || (a !== null && b !== null && a.path === b.path && a.side === b.side && a.line === b.line);

const sourceIds = new WeakMap<DiffSource, number>();
let lastSourceId = 0;

function sourceIdentity(source: DiffSource): number {
  let id = sourceIds.get(source);
  if (id === undefined) {
    id = ++lastSourceId;
    sourceIds.set(source, id);
  }
  return id;
}

/**
 * The whole changes view: the files, or the narrative that walks through them, with one keyboard cursor shared by
 * both. Narrow containers (a side panel) drop the file tree and the outline; wide ones show them beside the diff.
 */
export function DiffView(props: DiffViewProps) {
  // A new source is new data (kanban rebuilds its source when a ticket gains a PR): the commit range, loaded patches
  // and suggestion batch picked over the old one start afresh rather than being sent to the new one.
  return <SourceDiffView key={sourceIdentity(props.source)} {...props} />;
}

function SourceDiffView({ source, instanceKey, onOpenThread, refreshSignal, labels: labelOverrides, renderSubmitBar, deltaActions, toolbar }: DiffViewProps) {
  // The part of the history shown; null is all the changes. A partial range is for reading: see `RangeGate`.
  const { commitRange, setCommitRange, commits, atHead, gate } = useCommitRange(source, instanceKey);
  const { diff, error } = useDiffResult(source, instanceKey, commitRange);
  const notify = (message: string) => toast.message(message, { duration: 1800 });
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...labelOverrides }), [labelOverrides]);
  const comments = useComments(source, refreshSignal);
  const { reviews, toggleFinding, editFinding, markApplied: markFindingsApplied } = useReviews(source, refreshSignal);
  const { explanations, explainHunk } = useExplanations(source, refreshSignal);
  const { tour, busy: tourBusy, generate: generateTour } = useTour(source, refreshSignal);
  // The narrative walks all the changes, so a partial range reads in the files view.
  const narrativeAvailable = source.tour?.story !== undefined && gate.whole;
  // The conversation reads whatever range is picked: GitHub threads show over the hunks GitHub stored.
  const conversationAvailable = source.conversation !== undefined || comments.allThreads.length > 0 || comments.github.length > 0 || (commits?.commits.length ?? 0) > 0;
  const [chosenMode, setChosenMode] = useState<DiffViewMode>(() => (readPreference("viewMode") === "narrative" ? "narrative" : "files"));
  const mode: DiffViewMode = chosenMode === "conversation" ? (conversationAvailable ? "conversation" : "files") : narrativeAvailable ? chosenMode : "files";
  // Read by closures that outlive a render: a reveal queued for after a mode switch, the key scope's keymap.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const setMode = (next: DiffViewMode) => {
    setChosenMode(next);
    // Threads load after the view mounts, so a conversation restored on open would flip in late; it is not kept.
    if (next !== "conversation") writePreference("viewMode", next);
  };
  // The tour reloads on every refresh signal, so the story follows it.
  const narrative = useNarrativeStory(source, tour, mode === "narrative");
  const delta = useDelta(source, diff?.headSha ?? null);
  const preferences = useDiffPreferences();
  const { findingFilter, hideWhitespace } = preferences;
  const { rawPatches, whitespaceOnly, loadedPatchOf, rememberLoadedPatch } = useLoadedPatches(diff, commitRange);
  const { viewed, collapsed, markViewed: markFileViewed, toggleCollapsed, expand, setCollapsedPaths } = useFileMarks(source, diff, (file) => hideWhitespace && whitespaceOnly.has(file.path));
  const currentPaths = useMemo(() => new Set(diff?.files.map((file) => file.path) ?? []), [diff]);
  const reader = useNarrativeReader({ story: narrative.story, instanceKey, currentPaths, viewed });
  const [keys] = useState(createReviewKeys);
  const [overlay, setOverlay] = useState<{ kind: "help" } | { kind: "files" } | { kind: "steps" } | { kind: "symbols"; names: string[]; pick: (name: string) => void } | { kind: "blame"; path: string; span: LineSpan; anchor: DOMRect | null } | { kind: "commits" } | { kind: "search" } | { kind: "fileFilter"; anchor: DOMRect } | null>(null);
  const [lastSearch, setLastSearch] = useState<string | null>(null);
  const [active] = useState(createActivePath);
  const [composer, setComposer] = useState<({ path: string } & ComposerAnchor) | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The cursor's look lives on the root as an attribute, so showing or hiding it re-renders no row.
  useEffect(() => {
    const unsubscribe = keys.subscribe(() => {
      rootRef.current?.toggleAttribute("data-cursor-shown", keys.get().cursorShown);
    });
    return () => {
      unsubscribe();
    };
  }, [keys]);
  const hideCursor = () => {
    if (keys.get().cursorShown) keys.set({ cursorShown: false });
  };
  const mainRef = useRef<HTMLElement | null>(null);
  const narrativeScrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const excerptRefs = useRef(new Map<string, HTMLElement>());
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
      openInNewTab(`https://github.com/${lookup.open.repo}/blob/${lookup.open.sha}/${definition.path}${definition.line === null ? "" : `#L${definition.line}`}`);
      return;
    }
    toast.message(labels.noCheckout);
  };

  const allFindingsByPath = useMemo(() => inlineFindingsByPath(reviews, delta), [reviews, delta]);
  const outsideFindings = useMemo(() => findingsOutsideDiff(reviews), [reviews]);
  const [filteredOpen, setFilteredOpen] = useState(false);
  const findingsByPath = useMemo(() => (gate.findings ? filterFindings(allFindingsByPath, findingFilter) : new Map<string, PlacedFinding[]>()), [allFindingsByPath, findingFilter, gate]);
  const allFindings = useMemo(() => distinctFindings([...allFindingsByPath.values()].flat()), [allFindingsByPath]);
  const shownFindingCount = useMemo(() => distinctFindings([...findingsByPath.values()].flat()).length, [findingsByPath]);
  const newFindings = allFindings.filter((item) => item.isNew);
  const touchedFindings = allFindings.filter((item) => item.touched);
  const semanticsByPath = useMemo(() => tourSemanticsByPath(tour), [tour]);
  const risk = useMemo(() => riskByPath(tour, allFindingsByPath), [tour, allFindingsByPath]);
  const changedRangesByPath = useMemo(() => new Map((gate.whole ? (delta?.files ?? []) : []).map((file) => [file.path, file.ranges] as const)), [delta, gate]);
  const shownThreads = useMemo(() => gate.threads(comments.threads), [comments.threads, gate]);
  // `H` leaves every thread out of the files and the narrative; the conversation still lists them.
  const inlineThreads = preferences.hideThreads ? NO_THREADS : shownThreads;
  // Stable per file, so a re-render of the view (scrolling moves the active file) leaves each file's diff untouched.
  const threadsByPath = useMemo(() => groupByPath(inlineThreads), [inlineThreads]);
  const forPath = (path: string) => threadsByPath.get(path) ?? NO_THREADS;
  const shownPatches = useShownPatches({ rawPatches, hideWhitespace, whitespaceOnly, threadsByPath, findingsByPath });
  const { fileFilter, setFileFilter, fileFiltered, fileMarks, shownFiles, unhide } = useFileFilter({ instanceKey, diff, viewed, allThreads: comments.allThreads, findingsByPath, notify });
  // What `/` searches: each file's patch as drawn, so hidden whitespace changes never match.
  const searchFiles = useMemo((): SearchedFile[] => shownFiles.map((file) => ({ path: file.path, patch: shownPatches.get(file.path)?.patch ?? null })), [shownFiles, shownPatches]);
  const textSearch = useDiffSearch({ keys, files: searchFiles, scroller: () => mainRef.current, painting: mode === "files" });
  const searchCount = textSearch.query === "" ? "" : textSearch.total === 0 ? "No matches" : textSearch.index === null ? plural(textSearch.total, "match", "matches") : `${textSearch.index + 1} of ${textSearch.total}`;
  const toggleWhitespace = () => {
    const hide = !hideWhitespace;
    setDiffPreferences({ hideWhitespace: hide });
    setCollapsedPaths([...whitespaceOnly].filter((path) => !viewed.has(path)), hide);
    notify(hide ? "Whitespace changes hidden" : "Whitespace changes shown");
  };
  const openThreadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of comments.threads) if (threadIsOpen(thread)) counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
    return counts;
  }, [comments.threads]);
  const allThreadCounts = useMemo(() => threadCounts(comments.allThreads), [comments.allThreads]);
  const threadById = useMemo(() => new Map(comments.allThreads.map((thread) => [thread.id, thread])), [comments.allThreads]);
  const suggestions = useSuggestions({
    source,
    diff,
    patches: rawPatches,
    threadById,
    instanceKey,
    onApplied: comments.loadComments,
    refusal: atHead ? null : "Suggestions apply to the head's lines; switch to All changes (gr) or a range ending at the head to apply them",
    onFindingsApplied: (findings) => void markFindingsApplied(findings),
    onPosted: comments.loadComments,
  });

  // Pierre mounts annotations into its slots after the render that adds them, too late for the box's autoFocus.
  const composerOpened = useRef(false);
  useEffect(() => {
    if (!composerOpened.current || composer === null) return;
    composerOpened.current = false;
    return focusWhenShown(() => rootRef.current?.querySelector<HTMLTextAreaElement>('[data-comment-form="new"] textarea') ?? null, {
      timeoutMs: COMPOSER_MOUNT_MS,
      focus: (box) => {
        if (document.activeElement !== box) box.focus();
      },
    });
  }, [composer]);
  const parkCursor = (path: string) => {
    const want = keys.get().cursor?.want ?? "RIGHT";
    keys.set({ cursor: { path, side: want, line: null, want }, visual: null, focused: null });
  };
  /**
   * The "Filter files" menu, under the element it was opened from; from `gf`, under the file list's funnel while the
   * list shows, else at the top of the view. Opened again from its funnel, it closes.
   */
  const openFileFilter = (from: Element | null) => {
    if (diff === null || diff.files.length === 0) {
      notify("No changed files to filter");
      return;
    }
    if (overlay?.kind === "fileFilter") {
      closeOverlay();
      return;
    }
    const funnel = Array.from(rootRef.current?.querySelectorAll(`[${FILE_FILTER_BUTTON}]`) ?? []).find((button) => button.getClientRects().length > 0) ?? null;
    setOverlay({ kind: "fileFilter", anchor: (from ?? funnel)?.getBoundingClientRect() ?? viewCorner(rootRef.current?.getBoundingClientRect()) });
  };
  const jumpTo = (path: string) => {
    const unhid = unhide(path);
    active.set(path);
    expand(path);
    parkCursor(path);
    if (unhid) requestAnimationFrame(() => sectionRefs.current.get(path)?.scrollIntoView({ block: "start" }));
    else sectionRefs.current.get(path)?.scrollIntoView({ block: "start" });
  };
  const startComment = (path: string, anchor: ComposerAnchor) => {
    const refusal = gate.commentRefusal(anchor);
    if (refusal !== null) {
      notify(refusal);
      return;
    }
    setComposer({ path, ...anchor });
    composerOpened.current = true;
    if (anchor.line === null) parkCursor(path);
    else keys.set({ cursor: { path, side: anchor.side, line: anchor.line, want: anchor.side }, visual: null });
  };

  // One reveal for both modes: it finds the scroller showing the diff at call time, so a reveal queued across a mode
  // switch lands in the view that mounts.
  const { reveal, onScreen } = useCursorReveal(
    keys,
    () => (modeRef.current === "narrative" ? narrativeScrollRef.current : modeRef.current === "conversation" ? conversationMode.scrollRef.current : mainRef.current),
    (path) => (modeRef.current === "narrative" ? excerptRefs.current.get(path) : modeRef.current === "conversation" ? null : sectionRefs.current.get(path)) ?? null,
    () => modeRef.current === "files",
  );
  const revealRef = useRef(reveal);
  revealRef.current = reveal;

  // The files view mounts on the render after the switch, so what the narrative asked of it runs once it has.
  const afterFilesMount = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (mode !== "files" || afterFilesMount.current === null) return;
    const action = afterFilesMount.current;
    afterFilesMount.current = null;
    const frame = requestAnimationFrame(action);
    return () => cancelAnimationFrame(frame);
  }, [mode]);
  const inFiles = (action: () => void) => {
    afterFilesMount.current = action;
    setMode("files");
    rootRef.current?.focus({ preventScroll: true });
  };
  /**
   * The files view with `cursor` centred, and `focused` the annotation the keys act on. Without `focused`, the cursor
   * and its focus are left as they stand when the files view mounts.
   */
  const showInFiles = (cursor: Cursor | null, focused?: FocusedAnnotation | null) => {
    if (cursor !== null) unhide(cursor.path);
    inFiles(() => {
      const at = focused === undefined ? keys.get().cursor : cursor;
      if (at === null || !currentPaths.has(at.path)) return;
      if (focused !== undefined) keys.set({ cursor: at, visual: null, focused });
      active.set(at.path);
      expand(at.path);
      revealRef.current(at, "center");
    });
  };
  /** The files view at a file's header. */
  const openFileInFiles = (path: string) => {
    unhide(path);
    inFiles(() => jumpTo(path));
  };
  /** Back to the files view with the cursor where it stands, centred; a cursor on a header lands on that file. */
  const leaveToFiles = () => showInFiles(keys.get().cursor);
  /** The files view on `path`: at the cursor when it is on that file's lines, else at the file's header. */
  const openInFiles = (path: string) => {
    if (!currentPaths.has(path)) {
      notify(`${path} is not in the current diff`);
      return;
    }
    const cursor = keys.get().cursor;
    if (cursor !== null && cursor.path === path && cursor.line !== null) leaveToFiles();
    else openFileInFiles(path);
  };
  const markViewed = (path: string, isViewed: boolean): boolean => {
    if (gate.viewedRefusal !== null) {
      notify(gate.viewedRefusal);
      return false;
    }
    markFileViewed(path, isViewed);
    return true;
  };
  const enterNarrative = () => {
    if (!narrativeAvailable) {
      notify(!gate.whole ? `The narrative covers all the changes; ${SWITCH_TO_ALL_FIRST}` : "This view has no narrative review");
      return;
    }
    setMode("narrative");
    rootRef.current?.focus({ preventScroll: true });
  };

  const navFiles = (): NavFile[] => shownFiles.map((file) => ({ path: file.path, collapsed: collapsed.has(file.path), rows: keys.models.get(file.path)?.rows ?? null }));
  const navFilesRef = useRef(navFiles);
  navFilesRef.current = navFiles;
  // A newly opened diff starts the cursor on its first line, not on whatever line is mid-screen when a key is first
  // pressed. Files count as collapsed until their viewed marks load and their rows arrive after that, so this retries
  // on every render and every published file until the first open file has rows; a refresh leaves the cursor alone.
  const initialCursor = useRef<{ instanceKey: string; placed: Cursor | null; done: boolean } | null>(null);
  const placeInitialCursor = () => {
    const state = initialCursor.current;
    if (state === null || state.done || modeRef.current !== "files") return;
    // The reader got there first.
    if (state.placed !== null && keys.get().cursor !== state.placed) {
      state.done = true;
      return;
    }
    const files = navFilesRef.current();
    const fileIndex = files.findIndex((file) => !file.collapsed);
    const file = files[fileIndex];
    // A fold of hidden lines above the first change is not a line to start on.
    const row = file?.rows?.findIndex((entry) => entry.expander !== true) ?? -1;
    const next = file === undefined ? firstPosition(files, "RIGHT") : cursorAt(files, { fileIndex, row }, "RIGHT");
    if (next === null) return;
    state.done = file !== undefined && file.rows !== null;
    // Setting the cursor re-renders the view, which runs this again; an unchanged spot must not set it again.
    if (samePlace(state.placed, next)) return;
    state.placed = next;
    keys.set({ cursor: next, visual: null, focused: null });
  };
  const placeInitialCursorRef = useRef(placeInitialCursor);
  placeInitialCursorRef.current = placeInitialCursor;
  const hasFiles = diff !== null && diff.files.length > 0;
  useEffect(() => {
    // A new range is a new diff to start at the top of.
    const placeKey = `${instanceKey}|${commitRangeKey(commitRange)}`;
    if (hasFiles && initialCursor.current?.instanceKey !== placeKey) initialCursor.current = { instanceKey: placeKey, placed: null, done: false };
    placeInitialCursorRef.current();
  });
  useEffect(() => {
    const unsubscribe = keys.onModel(() => placeInitialCursorRef.current());
    return () => {
      unsubscribe();
    };
  }, [keys]);

  /** The line at the middle of the screen, where the files view's cursor rests. */
  const seat = (): Cursor | null => {
    const main = mainRef.current;
    if (main === null || shownFiles.length === 0) return null;
    const files = navFiles();
    const middle = cursorLineY(main);
    const want = keys.get().cursor?.want ?? "RIGHT";
    const other = want === "LEFT" ? "RIGHT" : "LEFT";
    for (const [fileIndex, file] of shownFiles.entries()) {
      const box = sectionRefs.current.get(file.path)?.getBoundingClientRect();
      if (box === undefined || box.bottom <= middle) continue;
      const model = collapsed.has(file.path) ? undefined : keys.models.get(file.path);
      if (model !== undefined && box.top + STICKY_HEADER_PX <= middle) {
        // The last row starting above the middle; a row with no line on the wanted side is measured on the other.
        let row = -1;
        for (let index = 0; index < model.rows.length; index++) {
          const top = (model.element(index, want) ?? model.element(index, other))?.getBoundingClientRect().top;
          if (top === undefined) continue;
          if (top > middle) break;
          row = index;
        }
        if (row !== -1) return cursorAt(files, { fileIndex, row }, want);
      }
      return cursorAt(files, { fileIndex, row: -1 }, want);
    }
    return lastPosition(files, want);
  };
  const findingAnchors = useMemo(
    () => [...findingsByPath].flatMap(([path, list]) => list.map((entry): FindingAnchor => ({ id: findingAnchorId(entry), path, side: "RIGHT", line: entry.line, item: entry.item }))),
    [findingsByPath],
  );
  const commitsControl = commits === null || (commits.commits.length === 0 && gate.whole) ? null : { label: rangeLabel(commitRange, commits), partial: commitRange !== null, onOpen: () => setOverlay({ kind: "commits" }) };
  /** Blame under the line it is about (or the element it was asked from), once that line is in view. */
  const openBlame = (path: string, span: LineSpan, anchor: Element | null) => {
    const model = keys.models.get(path);
    const row = model === undefined ? -1 : rowIndexOf(model.rows, span.side, span.end);
    const line = row === -1 ? null : (model?.element(row, span.side) ?? null);
    // A structural row is both sides' cells; the popover goes by the side's code, not the row's left edge.
    const cell = line?.querySelector(`[data-line-text~="${span.side}"]`) ?? line;
    setOverlay({ kind: "blame", path, span, anchor: (anchor ?? cell ?? sectionRefs.current.get(path) ?? null)?.getBoundingClientRect() ?? null });
  };
  const fileActions = fileActionsFor({ diff, navigate, notify, noCheckout: labels.noCheckout, blame: source.blame === undefined ? null : (path, span) => openBlame(path, span, null) });
  const fileMenuActions: FileMenuActions = { actions: fileActions, blameFrom: openBlame };
  const fileTreeFits = () => (rootRef.current?.clientWidth ?? 0) >= FILE_TREE_MIN_REM * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const returnToDiff = () => rootRef.current?.focus({ preventScroll: true });
  const makeFindingCard = async ({ reviewId, finding }: ListedFinding): Promise<string | null> => {
    try {
      const card = await source.reviews!.makeCard!(reviewId, finding.id);
      if (card.created) toast.success(`Added “${card.title}” to the board`);
      else toast.message(`Already on the board as “${card.title}”`);
      return card.cardId;
    } catch (cause) {
      toast.error(errorMessage(cause));
      return null;
    }
  };
  const stopFocusingTree = useRef(() => {});
  useEffect(() => () => stopFocusingTree.current(), []);
  /** Moves the keyboard into a list beside the diff (the file tree or the outline), on `preferred` or its first row. */
  const focusList = (selector: string, preferred: string | null) => {
    stopFocusingTree.current();
    // A list that was hidden renders after this key; wait for its rows.
    stopFocusingTree.current = focusWhenShown(
      () => {
        const list = rootRef.current?.querySelector<HTMLElement>(selector) ?? null;
        return (preferred === null ? null : (list?.querySelector<HTMLElement>(preferred) ?? null)) ?? list?.querySelector<HTMLElement>("[data-nav-row]") ?? null;
      },
      { timeoutMs: FILE_TREE_MOUNT_MS, focus: focusRow },
    );
  };

  /** What the keys can read and do in the files view. */
  const filesEnv = (): ReviewEnv => ({
    keys,
    files: navFiles(),
    threads: inlineThreads,
    findings: findingAnchors,
    viewed,
    target: source.canPostToGithub === true ? { value: comments.target, set: comments.setTarget } : null,
    seat,
    onScreen,
    reveal,
    scrollPage: (fraction) => scrollPageBy(mainRef.current, fraction),
    startComment: (path, range) => {
      expand(path);
      startComment(path, range);
    },
    focusComposer: () => {
      const root = rootRef.current;
      const focused = keys.get().focused;
      const box =
        root?.querySelector<HTMLTextAreaElement>('[data-comment-form="new"] textarea') ??
        (focused?.kind !== "thread" ? null : root?.querySelector<HTMLTextAreaElement>(`[data-thread-id="${CSS.escape(focused.id)}"] textarea`)) ??
        null;
      if (box === null) return false;
      // An empty box moves to the cursor; one holding a draft is finished first, so the draft is never lost.
      if (box.closest('[data-comment-form="new"]') !== null && box.value.trim() === "") return false;
      box.focus();
      box.scrollIntoView({ block: "nearest" });
      return true;
    },
    closeEmptyComposer: () => {
      const box = rootRef.current?.querySelector<HTMLTextAreaElement>('[data-comment-form="new"] textarea') ?? null;
      if (composer === null || (box !== null && box.value.trim() !== "")) return false;
      setComposer(null);
      return true;
    },
    setCollapsed: setCollapsedPaths,
    markViewed,
    deleteComment: (id) => {
      void comments.deleteComment(id);
      notify("Comment deleted");
    },
    canPostToGithub: source.canPostToGithub ?? false,
    moveComment: (id, target) => void comments.moveComment(id, target),
    canResolve: source.setThreadResolved !== undefined,
    openUrl: openInNewTab,
    openThread: onOpenThread,
    toggleFinding,
    explain: explainHunk,
    toggleLayout: () => setDiffPreferences({ layout: otherLayout(preferences.layout) }),
    toggleFileTree: () => {
      const open = !preferences.fileTreeOpen;
      setDiffPreferences({ fileTreeOpen: open });
      if (open && !fileTreeFits()) notify("The file list needs a wider view");
    },
    focusFileTree: () => {
      if (!fileTreeFits()) return false;
      if (!preferences.fileTreeOpen) setDiffPreferences({ fileTreeOpen: true });
      const path = keys.get().cursor?.path ?? null;
      focusList("[data-file-tree]", path === null ? null : `[data-file-tree-path="${CSS.escape(path)}"]`);
      return true;
    },
    findingFilter: allFindings.length === 0 ? null : { value: findingFilter, set: (filter) => setDiffPreferences({ findingFilter: filter }) },
    filteredFindings: outsideFindings.filtered.length === 0 ? null : { open: filteredOpen, set: setFilteredOpen },
    focusOutsideFindings: () => {
      const first = rootRef.current?.querySelector<HTMLElement>(`${OUTSIDE_FINDINGS} [data-nav-row]`) ?? null;
      if (first !== null) focusRow(first);
      return first !== null;
    },
    refresh: () => requestReload(instanceKey),
    focusSendBar: () => {
      // The bar's first action, past any checkbox or toggle that only sets an option for it, unless the host marks a
      // control to start on (an option picker whose Enter sends).
      const button =
        rootRef.current?.querySelector<HTMLElement>(
          '[data-diff-submit-bar] [data-send-bar-focus], [data-diff-submit-bar] button:not(:disabled):not([role="checkbox"]):not([role="switch"]):not([role="radio"]):not([role="tab"]):not([aria-pressed])',
        ) ?? null;
      button?.focus();
      return button !== null;
    },
    leaveSendBar: () => {
      if (document.activeElement?.closest("[data-diff-submit-bar]") == null) return false;
      returnToDiff();
      return true;
    },
    openOverlay: (kind) => {
      if (kind === "fileFilter") {
        openFileFilter(null);
        return;
      }
      if (kind === "search") textSearch.open(keys.get().cursor);
      setOverlay({ kind });
    },
    search: textSearch.env,
    jump: jumpTo,
    pickSymbol: (names, pick) => setOverlay({ kind: "symbols", names, pick }),
    notify,
    toggleWhitespace,
    fileActions,
    toggleThreadsHidden: () => {
      const hidden = !preferences.hideThreads;
      setDiffPreferences({ hideThreads: hidden });
      return hidden;
    },
    suggestions,
    openCommits: commitsControl === null ? null : commitsControl.onOpen,
  });
  const runFilesCommand = (command: ReviewCommand, count: number) => {
    if (command.kind === "narrative") {
      enterNarrative();
      return;
    }
    if (command.kind === "conversation") {
      conversationMode.enter();
      return;
    }
    runReviewCommand(command, count, filesEnv());
  };

  const conversationEvents = useConversationEvents(source, refreshSignal, mode === "conversation");
  const conversation = useMemo(
    () => conversationItems({ threads: comments.allThreads, github: comments.github, commits: commits?.commits ?? [], events: conversationEvents.events }),
    [comments.allThreads, comments.github, commits, conversationEvents.events],
  );
  const conversationMode = useConversationMode({
    keys,
    mode,
    setMode,
    available: conversationAvailable,
    items: conversation,
    narrativeAvailable,
    enterNarrative,
    threadById,
    files: diff?.files ?? NO_FILES,
    currentPaths,
    repo: diff?.repo ?? null,
    addComment: comments.addComment,
    onToggleFinding: toggleFinding,
    onEditFinding: editFinding,
    filesEnv,
    focusRoot: () => rootRef.current?.focus({ preventScroll: true }),
    showInFiles,
    openFileInFiles,
    openCommit: ({ index }) => {
      if (commits === null) return;
      const pick = commitsRange(commits, index, index);
      if (pick.kind === "unknown") {
        notify("Where this commit starts is unknown; gr picks a range");
        return;
      }
      if (commitRangeKey(pick.range) !== commitRangeKey(commitRange)) setCommitRange(pick.range);
      notify(pick.range === null ? "Showing all changes" : `Showing ${rangeLabel(pick.range, commits)}`);
      showInFiles(null);
    },
    openUrl: openInNewTab,
    notify,
  });

  // ---- The narrative: the same cursor over a step's excerpts.

  /** The step's excerpts as the cursor sees them, in the step's order. */
  const narrativeFiles = (): NavFile[] => reader.excerpts.map((excerpt) => ({ path: excerpt.path, collapsed: reader.collapsed.has(excerpt.path), rows: keys.models.get(excerpt.path)?.rows ?? null }));
  const narrativeFilesRef = useRef(narrativeFiles);
  narrativeFilesRef.current = narrativeFiles;
  const narrativePane: ScrollerPane = { keys, scroller: () => narrativeScrollRef.current, files: narrativeFiles, section: (path) => excerptRefs.current.get(path), reveal, park: parkCursor };
  /** The first (or, going up, last) excerpt header or line in view; null when the page shows no code on screen. */
  const visibleCursor = (direction: 1 | -1): Cursor | null => paneVisibleCursor(narrativePane, direction);
  /** Whether the cursor can act on a path's lines here: only the current narrative's lines are today's lines. */
  const canTouch = (path: string): boolean => {
    if (!reader.describesCurrentDiff) {
      notify(reader.chapter?.kind === "revision" ? "Revision steps point into the delta; comment from the current narrative's steps or the files view" : "These lines are from an earlier head; comment from the current narrative's steps or the files view");
      return false;
    }
    if (!currentPaths.has(path)) {
      notify(`${path} is not in the current diff`);
      return false;
    }
    return true;
  };
  /** Whether an excerpt of the step shows a line (or, a null line, the file), so the comment keys reach only what is drawn. */
  const excerptShows = (path: string, side: "LEFT" | "RIGHT", line: number | null): boolean => {
    if (!reader.describesCurrentDiff || !reader.excerpts.some((excerpt) => excerpt.path === path)) return false;
    if (line === null) return true;
    const rows = keys.models.get(path)?.rows;
    const row = rows === undefined ? -1 : rowIndexOf(rows, side, line);
    return row !== -1 && rows![row]!.expander !== true;
  };
  const narrativeEnv = (): ReviewEnv => ({
    ...filesEnv(),
    // The step's prose reads top to bottom; the cursor scrolls only when it would leave the screen.
    ...scrollerEnv(narrativePane),
    // The anchors the keys step through are the ones the excerpts draw, as `excerptAnnotations` cuts them.
    threads: inlineThreads.filter((thread) => excerptShows(thread.path, thread.side, thread.line)),
    findings: findingAnchors.filter((finding) => finding.line !== null && excerptShows(finding.path, finding.side, finding.line)),
    startComment: (path, range) => {
      if (canTouch(path)) startComment(path, range);
    },
    markViewed: (path, isViewed) => {
      if (currentPaths.has(path)) return markViewed(path, isViewed);
      notify(`${path} is not in the current diff`);
      return false;
    },
    setCollapsed: reader.setCollapsed,
    toggleLayout: () => setDiffPreferences({ narrativeLayout: otherLayout(preferences.narrativeLayout) }),
    toggleFileTree: () => {
      const open = !reader.outline;
      reader.setOutline(open);
      if (open && !fileTreeFits()) notify("The outline needs a wider view");
    },
    focusFileTree: () => {
      if (!fileTreeFits()) return false;
      if (!reader.outline) reader.setOutline(true);
      focusList(NARRATIVE_OUTLINE, '[data-nav-row][aria-current="step"]');
      return true;
    },
    focusOutsideFindings: () => false,
    search: null,
  });
  // Which end of a page the reader arrives at by key, placed once the page's excerpts have published their rows.
  const arrive = useRef<"start" | "end" | null>(null);
  const placeOnArrival = () => {
    const where = arrive.current;
    if (where === null || modeRef.current !== "narrative") return;
    const files = narrativeFilesRef.current();
    const scroller = narrativeScrollRef.current;
    const want = keys.get().cursor?.want ?? "RIGHT";
    if (files.length === 0) {
      // A step of prose alone: nothing to put a cursor on.
      arrive.current = null;
      if (where === "end") scroller?.scrollTo({ top: scroller.scrollHeight });
      return;
    }
    if (where === "start") {
      const first = files[0]!;
      const row = first.rows?.findIndex((entry) => entry.expander !== true) ?? -1;
      const next = cursorAt(files, { fileIndex: 0, row }, want);
      // The header serves until the rows arrive; the page stays scrolled to its top, so the prose is read first.
      if (first.rows !== null) arrive.current = null;
      if (!samePlace(keys.get().cursor, next)) keys.set({ cursor: next, visual: null, focused: focusAt(narrativeEnv(), next) });
      return;
    }
    if (files.some((file) => !file.collapsed && file.rows === null)) return;
    const last = lastPosition(files, want);
    arrive.current = null;
    if (last === null) return;
    keys.set({ cursor: last, visual: null, focused: focusAt(narrativeEnv(), last) });
    scroller?.scrollTo({ top: scroller.scrollHeight });
    revealRef.current(last, "nearest");
  };
  const placeOnArrivalRef = useRef(placeOnArrival);
  placeOnArrivalRef.current = placeOnArrival;
  useEffect(() => {
    arrive.current = reader.arrival.where;
    placeOnArrivalRef.current();
  }, [reader.arrival]);
  useEffect(() => {
    placeOnArrivalRef.current();
  });
  useEffect(() => {
    const unsubscribe = keys.onModel(() => placeOnArrivalRef.current());
    return () => {
      unsubscribe();
    };
  }, [keys]);
  // Entering the narrative keeps a cursor that is on a line the step shows (back from the files view, say) and
  // otherwise starts the page afresh.
  useEffect(() => {
    if (mode !== "narrative") return;
    const cursor = keys.get().cursor;
    const file = narrativeFilesRef.current().find((entry) => entry.path === cursor?.path);
    const shown = cursor !== null && file !== undefined && (cursor.line === null || (file.rows !== null && rowIndexOf(file.rows, cursor.side, cursor.line) !== -1));
    if (!shown) {
      arrive.current = "start";
      placeOnArrivalRef.current();
      return;
    }
    arrive.current = null;
    const frame = requestAnimationFrame(() => revealRef.current(cursor, "nearest"));
    return () => cancelAnimationFrame(frame);
  }, [mode, keys]);

  /** Turns to another page, arriving at its start (scrolled to the top) or its end. */
  const turnTo = (next: StepAddress | null, where: "start" | "end" = "start"): boolean => {
    if (!reader.go(next, where)) return false;
    if (where === "start") narrativeScrollRef.current?.scrollTo({ top: 0 });
    return true;
  };
  const startGenerate = () => {
    if (tourBusy) return;
    if (narrative.story?.running != null) notify("A narrative is already being written");
    else void generateTour().then(narrative.reload);
  };
  const runNarrativeCommand = (command: NarrativeCommand, count: number) => {
    const scroller = narrativeScrollRef.current;
    const state = keys.get();
    const files = narrativeFiles();
    switch (command.kind) {
      case "step":
        if (!turnTo(reader.movePage(command.direction * count))) notify(command.direction === 1 ? "This is the last step" : "This is the first step");
        return;
      case "chapter":
        if (!turnTo(reader.moveChapter(command.direction))) notify(command.direction === 1 ? "This is the last chapter" : "This is the first chapter");
        return;
      case "affected": {
        const id = reader.step?.affects[0];
        if (id === undefined) notify("This step names no step of the new narrative");
        else if (!turnTo(reader.affected(id))) notify("That step is not in the current narrative");
        return;
      }
      case "openInFiles": {
        const path = state.cursor !== null && files.some((file) => file.path === state.cursor!.path) ? state.cursor.path : (reader.excerpts[0]?.path ?? null);
        if (path === null) notify("This step shows no code");
        else if (reader.describesCurrentDiff) openInFiles(path);
        else notify(reader.chapter?.kind === "revision" ? "Revision steps point into the delta; open lines from the current narrative's steps" : "These lines are from an earlier head; open them from the current narrative's steps");
        return;
      }
      case "narratedViewed":
        if (reader.narratedUnviewed.length === 0) notify("No file has had all of its steps read yet");
        else {
          for (const path of reader.narratedUnviewed) markViewed(path, true);
          notify(`Marked ${reader.narratedUnviewed.length} file${reader.narratedUnviewed.length === 1 ? "" : "s"} viewed`);
        }
        return;
      case "generate":
        startGenerate();
        return;
      case "narrative":
        leaveToFiles();
        return;
      case "findFile":
        if (diff === null || diff.files.length === 0) notify("No changed files to search");
        else setOverlay({ kind: "files" });
        return;
      case "searchText":
        if (reader.chapters.length === 0) notify("No narrative to search");
        else setOverlay({ kind: "steps" });
        return;
      case "searchNext": {
        if (reader.lastSearch === null) {
          notify("Search steps with / first");
          return;
        }
        const hit = reader.searchHit(command.direction, count);
        if (hit === null) notify(`No step matches “${reader.lastSearch}”`);
        else turnTo(hit);
        return;
      }
      case "fileTree":
        narrativeEnv().toggleFileTree();
        return;
      case "conversation":
        conversationMode.enter();
        return;
      case "side":
        // Past the old side, or from an excerpt header, the next step left is the outline.
        if (command.side === "LEFT" && state.cursor !== null && (state.cursor.line === null || state.cursor.side === "LEFT" || state.cursor.want === "LEFT")) {
          if (!narrativeEnv().focusFileTree()) notify("The outline needs a wider view");
          return;
        }
        runReviewCommand(command, count, narrativeEnv());
        return;
      case "top":
      case "bottom": {
        const edge = command.kind === "top" ? firstPosition(files, state.cursor?.want ?? "RIGHT") : lastPosition(files, state.cursor?.want ?? "RIGHT");
        scroller?.scrollTo({ top: command.kind === "top" ? 0 : scroller.scrollHeight });
        if (edge === null) return;
        keys.set({ cursor: edge, visual: null, focused: null });
        if (command.kind === "bottom") reveal(edge, "nearest");
        return;
      }
      case "page": {
        if (scroller === null) return;
        scroller.scrollBy({ top: command.fraction * count * scroller.clientHeight, behavior: "auto" });
        // The cursor follows onto the code now in view, when it scrolled away.
        if (state.cursor !== null && cursorPosition(files, state.cursor) !== null && onScreen(state.cursor) === true) return;
        const next = visibleCursor(command.fraction > 0 ? 1 : -1);
        if (next !== null) keys.set({ cursor: next, visual: null, focused: null });
        return;
      }
      case "line": {
        // On a code line in view, j and k are the review's; with nothing left to move onto they read the page on,
        // and past its end they turn to the next step (or back to the end of the one before).
        const inCode = state.cursor !== null && cursorPosition(files, state.cursor) !== null && onScreen(state.cursor) === true;
        if (inCode) {
          runReviewCommand(command, count, narrativeEnv());
          const after = keys.get();
          if (!samePlace(state.cursor, after.cursor) || state.focused !== after.focused) return;
        }
        if (scroller === null) return;
        const top = scroller.scrollTop;
        scroller.scrollBy({ top: command.direction * count * PROSE_LINES * LINE_PX, behavior: "auto" });
        if (scroller.scrollTop !== top) {
          // A cursor the scroll brought into view is kept; one still out of view gives way to the code now showing.
          if (inCode || (state.cursor !== null && onScreen(state.cursor) === true)) return;
          const next = visibleCursor(command.direction);
          if (next !== null) keys.set({ cursor: next, visual: null, focused: null });
          return;
        }
        if (!turnTo(reader.movePage(command.direction), command.direction === 1 ? "start" : "end")) notify(command.direction === 1 ? "This is the end of the narrative" : "This is the start of the narrative");
        return;
      }
      default:
        runReviewCommand(command, count, narrativeEnv());
    }
  };

  const pickKeymap = useCallback(
    (): Keymap<NarrativeCommand | ConversationCommand> => (modeRef.current === "narrative" ? NARRATIVE_KEYMAP : modeRef.current === "conversation" ? CONVERSATION_KEYMAP : REVIEW_KEYMAP),
    [],
  );
  useReviewKeys(rootRef, keys, overlay === null, pickKeymap, (command, count) => {
    if (mode === "narrative") runNarrativeCommand(command as NarrativeCommand, count);
    else if (mode === "conversation") conversationMode.run(command as ConversationCommand, count);
    else runFilesCommand(command as ReviewCommand, count);
  });
  const runFilesCommandRef = useRef(runFilesCommand);
  runFilesCommandRef.current = runFilesCommand;
  // Scrolling by hand (wheel, trackpad, touch, the scrollbar) drags the cursor along, so it stays on the middle line.
  // The diff's own scrolls, which put the cursor there, carry no such intent and are left alone.
  const lastScrollIntent = useRef(0);
  const draggingScrollbar = useRef(false);
  const followFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(followFrame.current), []);
  const markScrollIntent = () => {
    lastScrollIntent.current = performance.now();
  };
  const onMainScroll = () => {
    trackActive();
    if (keys.get().cursor === null) return;
    if (!draggingScrollbar.current && performance.now() - lastScrollIntent.current > SCROLL_INTENT_MS) return;
    cancelAnimationFrame(followFrame.current);
    followFrame.current = requestAnimationFrame(() => runFilesCommandRef.current({ kind: "follow" }, 1));
  };
  const closeOverlay = () => {
    setOverlay(null);
    returnToDiff();
  };
  const { focusRequestedAt } = useDiffInstance(instanceKey);
  useEffect(() => {
    if (Date.now() - focusRequestedAt < FOCUS_REQUEST_TTL_MS) rootRef.current?.focus({ preventScroll: true });
  }, [focusRequestedAt]);
  useEffect(
    () =>
      active.subscribe(() => {
        const path = active.get();
        if (path !== null) rootRef.current?.querySelector(`[data-file-tree-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
      }),
    [active],
  );
  const markers = useScrollMarkers(mainRef, [diff, inlineThreads, collapsed, mode, shownFiles]);
  // The sidebar tracks whichever file header is at (or just above) the top of the scroller, like GitHub's file tree.
  const trackActive = () => {
    const main = mainRef.current;
    if (main === null || diff === null) return;
    const top = main.getBoundingClientRect().top + 8;
    let current: string | null = null;
    for (const entry of shownFiles) {
      const section = sectionRefs.current.get(entry.path);
      if (section === undefined) continue;
      if (section.getBoundingClientRect().top <= top) current = entry.path;
      else break;
    }
    active.set(current ?? shownFiles[0]?.path ?? null);
  };

  const annotationsFor = (path: string): PatchAnnotationProps => {
    const fileComposer = composer !== null && composer.path === path ? composer : null;
    return {
      path,
      threads: forPath(path),
      composer: fileComposer,
      onStartComment: (anchor) => startComment(path, anchor),
      onCancelComposer: () => setComposer(null),
      onSubmitComposer: (body, target) => (fileComposer === null ? Promise.resolve() : comments.addComment(path, fileComposer, body, target)),
      findings: findingsByPath.get(path) ?? NO_PLACED_FINDINGS,
      onToggleFinding: toggleFinding,
      onEditFinding: editFinding,
    };
  };
  /** An excerpt's annotations: the file's, cut to the lines it shows; none while the step's lines are not today's. */
  const excerptAnnotationsFor = (path: string, patch: string): PatchAnnotationProps | null => {
    if (!reader.describesCurrentDiff || !currentPaths.has(path)) return null;
    const full = annotationsFor(path);
    return { ...full, ...excerptAnnotations(patch, full.threads, full.findings, full.composer), onStartComment: (anchor) => narrativeEnv().startComment(path, anchor) };
  };
  const commentActions: DiffCommentActions = {
    canPostToGithub: source.canPostToGithub ?? false,
    canResolve: source.setThreadResolved !== undefined,
    onReply: comments.reply,
    onResolve: comments.resolveThread,
    onEdit: comments.editComment,
    target: comments.target,
    onMoveComment: comments.moveComment,
    onDelete: (id) => void comments.deleteComment(id),
    onOpenThread,
  };
  const sourceContext = useMemo(() => ({ source, labels }), [source, labels]);
  const { localPending, githubDrafts } = comments;
  const stale = narrative.story?.stale ?? tour?.stale ?? false;
  const writing: NarrativeWriting = {
    running: narrative.story?.running ?? null,
    failed: tour?.narrative?.status === "failed" ? { threadId: tour.narrative.threadId } : null,
    threadId: tour?.narrative?.status === "completed" ? tour.narrative.threadId : null,
    starting: tourBusy,
    label: reader.chapters.length === 0 ? "Write narrative" : stale ? "Write update" : "Rewrite",
    generate: startGenerate,
    openThread: onOpenThread,
  };

  return (
    <DiffViewProviders range={commitRange} source={sourceContext} comments={commentActions} suggestions={suggestions} keys={keys} fileActions={fileMenuActions} searchCss={textSearch.css}>
          {/* A wheel or a click means the reader is on the mouse; the cursor hides until the next key. */}
          <div ref={rootRef} data-diff-root="" tabIndex={-1} className="group/diff @container flex h-full min-h-0 flex-col outline-none" onWheelCapture={hideCursor} onPointerDownCapture={hideCursor}>
            <style>{textSearch.css}</style>
            {typeof toolbar === "function" ? toolbar({ local: localPending, githubDrafts, reload: comments.loadComments }) : toolbar}
            {renderSubmitBar !== undefined && (localPending.length > 0 || githubDrafts.length > 0) ? (
              <div data-diff-submit-bar="">{renderSubmitBar({ local: localPending, githubDrafts, reload: comments.loadComments })}</div>
            ) : null}

            {error !== null ? <p className={cn("px-3 py-2 text-sm text-destructive", enter.fade)}>{error}</p> : null}
            {diff !== null && diff.message !== null ? <p className="px-3 py-2 text-sm text-muted-foreground">{diff.message}</p> : null}
            {diff?.truncated === true ? <TruncationBanner diff={diff} /> : null}
            {diff !== null && diff.files.length > 0 ? (
              <SummaryBar
                diff={diff}
                viewed={viewed}
                findingTotal={allFindings.length}
                findingShown={shownFindingCount}
                findingFilter={findingFilter}
                commentTarget={source.canPostToGithub === true ? { target: comments.target, onChange: comments.setTarget } : null}
                mode={
                  narrativeAvailable || conversationAvailable
                    ? {
                        value: mode,
                        stale,
                        narrative: narrativeAvailable,
                        conversation: conversationAvailable,
                        onChange: (next) => (next === mode ? undefined : next === "conversation" ? conversationMode.enter() : next === "narrative" ? enterNarrative() : leaveToFiles()),
                      }
                    : null
                }
                progress={mode === "narrative" ? { position: reader.position, total: reader.total } : null}
                whitespace={{ hidden: hideWhitespace, onToggle: toggleWhitespace }}
                search={mode === "files" && textSearch.active ? { query: textSearch.query, count: searchCount, onClear: textSearch.clear } : null}
                fileFilter={mode === "files" && fileFiltered ? { shown: shownFiles.length, total: diff.files.length, onClear: () => setFileFilter(NO_FILE_FILTER) } : null}
                threads={
                  mode === "conversation"
                    ? null
                    : {
                        resolved: allThreadCounts.resolved,
                        outdated: allThreadCounts.outdated,
                        hidden: preferences.hideThreads,
                        onOpen: conversationMode.enter,
                        onShow: () => setDiffPreferences({ hideThreads: false }),
                      }
                }
                suggestions={
                  suggestions.apply === null || suggestions.batch.length === 0
                    ? null
                    : { count: suggestions.batch.length, busy: suggestions.busy, onCommit: () => void suggestions.apply?.([...suggestions.batch]) }
                }
                layout={
                  mode === "narrative"
                    ? { value: preferences.narrativeLayout, onToggle: () => setDiffPreferences({ narrativeLayout: otherLayout(preferences.narrativeLayout) }) }
                    : { value: preferences.layout, onToggle: () => setDiffPreferences({ layout: otherLayout(preferences.layout) }) }
                }
                commits={commitsControl}
              />
            ) : null}
            {diff !== null && diff.files.length === 0 && !gate.whole && commitsControl !== null ? (
              <div className="border-b border-border px-3 py-1">
                <CommitsButton {...commitsControl} />
              </div>
            ) : null}

            <div className="relative flex min-h-0 flex-1">
              {mode === "narrative" ? (
                <NarrativeView
                  reader={reader}
                  scrollRef={narrativeScrollRef}
                  sectionRef={(path, node) => {
                    if (node === null) excerptRefs.current.delete(path);
                    else excerptRefs.current.set(path, node);
                  }}
                  loaded={narrative.story !== null}
                  error={narrative.error}
                  stale={stale}
                  writing={writing}
                  viewed={viewed}
                  annotationsFor={excerptAnnotationsFor}
                  onMarkViewed={markViewed}
                  onCommentOnFile={(path) => narrativeEnv().startComment(path, WHOLE_FILE)}
                  onOpenExcerpt={(path) => {
                    if (reader.describesCurrentDiff) openInFiles(path);
                    else notify(reader.chapter?.kind === "revision" ? "Revision steps point into the delta; open lines from the current narrative's steps" : "These lines are from an earlier head; open them from the current narrative's steps");
                  }}
                  onOpenPath={(path) => openInFiles(path)}
                  onNarratedViewed={() => runNarrativeCommand({ kind: "narratedViewed" }, 1)}
                  onLeaveOutline={returnToDiff}
                />
              ) : mode === "conversation" ? (
                <ConversationView
                  items={conversation}
                  originals={threadById}
                  error={conversationEvents.error}
                  focusedKey={conversationMode.cursorKey}
                  folded={conversationMode.folded}
                  scrollRef={conversationMode.scrollRef}
                  stopRef={conversationMode.stopRef}
                  repo={diff?.repo ?? null}
                  codeOf={conversationMode.codeOf}
                  inDiff={(path) => currentPaths.has(path)}
                  annotationsFor={conversationMode.annotationsFor}
                  onToggle={conversationMode.toggle}
                  onOpenCommit={conversationMode.openCommit}
                  onOpenThread={conversationMode.openThread}
                />
              ) : (
                <>
                  <ActiveFileTreeSidebar
                    active={active}
                    diff={diff}
                    files={shownFiles}
                    filter={{ active: fileFiltered, onOpen: openFileFilter }}
                    viewed={viewed}
                    commentCount={(path) => openThreadCounts.get(path) ?? 0}
                    findingCount={(path) => findingsByPath.get(path)?.length ?? 0}
                    risk={(path) => risk.get(path) ?? null}
                    changedSince={(path) => changedRangesByPath.has(path)}
                    onSelect={(path) => {
                      jumpTo(path);
                      returnToDiff();
                    }}
                    onLeave={returnToDiff}
                  />
                  <div className="relative flex min-h-0 min-w-0 flex-1">
                    <main
                      ref={mainRef}
                      onScroll={onMainScroll}
                      onWheel={markScrollIntent}
                      onTouchMove={markScrollIntent}
                      onPointerDown={(event) => {
                        // A press on the scroller itself, not its content, is on the scrollbar.
                        if (event.target !== event.currentTarget) return;
                        draggingScrollbar.current = true;
                        window.addEventListener("pointerup", () => (draggingScrollbar.current = false), { once: true });
                      }}
                      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
                    >
                      {gate.whole && delta !== null && delta.files.length > 0 ? (
                        <DeltaStrip delta={delta} newFindings={newFindings} touchedFindings={touchedFindings} findingFilter={findingFilter} onJump={jumpTo} actions={deltaActions} />
                      ) : null}
                      {diff !== null && diff.files.length > 0 && (outsideFindings.preExisting.length > 0 || outsideFindings.filtered.length > 0) ? (
                        <OutsideFindings
                          preExisting={outsideFindings.preExisting}
                          filtered={outsideFindings.filtered}
                          filteredOpen={filteredOpen}
                          onFilteredOpen={setFilteredOpen}
                          onMakeCard={source.reviews?.makeCard === undefined ? null : makeFindingCard}
                          onLeave={returnToDiff}
                        />
                      ) : null}
                      {diff === null && error === null ? <SkeletonLines widths={DIFF_SKELETON} label="Loading changes" className="p-4" /> : null}
                      {diff !== null && diff.files.length === 0 ? (
                        <p className={cn("p-4 text-sm text-muted-foreground", enter.fade)}>
                          {diff.hiddenVendored === null ? "No changes." : `Only vendored files changed (${diff.hiddenVendored.files} hidden by the "Hide vendored files" setting).`}
                        </p>
                      ) : null}
                      {diff !== null && diff.files.length > 0 && shownFiles.length === 0 ? (
                        <p className={cn("p-4 text-sm text-muted-foreground", enter.fade)}>
                          No files match the file filter.{" "}
                          <button type="button" className="underline hover:text-foreground" onClick={() => setFileFilter(NO_FILE_FILTER)}>
                            Clear filters
                          </button>{" "}
                          (or gf to change it)
                        </p>
                      ) : null}
                      {shownFiles.map((file, index) => (
                        <FileSection
                          key={`${commitRangeKey(commitRange)}:${file.path}`}
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
                          annotations={annotationsFor(file.path)}
                          onOpenFile={openDefinition}
                          explanations={explanations.filter((entry) => entry.path === file.path)}
                          onExplain={explainHunk === null ? null : (side, startLine, endLine) => explainHunk(file.path, side, startLine, endLine)}
                          semantics={semanticsByPath.get(file.path) ?? NO_SEMANTICS}
                          changedRanges={changedRangesByPath.get(file.path) ?? NO_RANGES}
                          shown={shownPatches.get(file.path) ?? NO_PATCH}
                          loadedPatch={loadedPatchOf(file)}
                          onPatchLoaded={(patch) => rememberLoadedPatch(file, patch)}
                          searchLine={textSearch.reached?.path === file.path ? textSearch.reached : null}
                        />
                      ))}
                    </main>
                    <ScrollMarkers markers={markers} mainRef={mainRef} />
                  </div>
                </>
              )}
              <ModeLabel />
              {overlay?.kind === "help" ? <KeysOverlay onClose={closeOverlay} sections={mode === "narrative" ? NARRATIVE_KEY_HELP : mode === "conversation" ? CONVERSATION_KEY_HELP : KEY_HELP} /> : null}
              {overlay?.kind === "files" && diff !== null ? (
                <Picker
                  label="Search file names"
                  placeholder="Search file names…"
                  initialQuery={lastSearch ?? ""}
                  rank={(query) => fileItems(shownFiles, query)}
                  onPick={(path, query) => {
                    closeOverlay();
                    setLastSearch(query.trim() === "" ? null : query);
                    if (mode === "narrative") openInFiles(path);
                    else jumpTo(path);
                  }}
                  onClose={closeOverlay}
                />
              ) : null}
              {overlay?.kind === "steps" ? (
                <Picker
                  label="Search steps"
                  placeholder="Search step titles and text…"
                  initialQuery={reader.lastSearch ?? ""}
                  rank={(query) =>
                    searchSteps(reader.chapters, query).map((hit) => ({
                      id: `${hit.chapter}:${hit.step}`,
                      label: reader.chapters[hit.chapter]!.steps[hit.step]!.title,
                      detail: <span className="shrink-0 text-muted-foreground">{reader.chapters[hit.chapter]!.kind === "revision" ? "revision" : reader.chapters[hit.chapter]!.current ? "current" : "earlier"}</span>,
                    }))
                  }
                  onPick={(id, query) => {
                    closeOverlay();
                    reader.setLastSearch(query.trim() === "" ? null : query);
                    const [chapterIndex, stepIndex] = id.split(":").map(Number);
                    turnTo({ chapter: chapterIndex!, step: stepIndex! });
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
              {overlay?.kind === "search" ? (
                <SearchBox
                  initialQuery={textSearch.query}
                  count={searchCount}
                  onChange={textSearch.type}
                  onCommit={(query) => {
                    const searching = textSearch.commit(query);
                    closeOverlay();
                    if (!searching) return;
                    keys.set({ cursorShown: true });
                    runFilesCommand({ kind: "searchNext", direction: 1 }, 1);
                  }}
                  onCancel={() => {
                    textSearch.cancel();
                    closeOverlay();
                  }}
                />
              ) : null}
              {overlay?.kind === "commits" && commits !== null ? (
                <CommitPicker
                  commits={commits}
                  current={commitRange}
                  notify={notify}
                  onClose={closeOverlay}
                  onPick={(next, note) => {
                    closeOverlay();
                    if (commitRangeKey(next) === commitRangeKey(commitRange)) {
                      if (note !== null) notify(note);
                      return;
                    }
                    setCommitRange(next);
                    notify(note ?? (next === null ? "Showing all changes" : `Showing ${rangeLabel(next, commits)}${rangeEndsAtHead(next, commits) ? "" : ": switch to All changes to comment or mark files viewed"}`));
                  }}
                />
              ) : null}
              {overlay?.kind === "fileFilter" && diff !== null ? (
                <FileFilterMenu
                  files={diff.files}
                  filter={fileFilter}
                  marks={fileMarks}
                  findings={allFindings.length > 0}
                  anchor={overlay.anchor}
                  onChange={setFileFilter}
                  onClose={(refocus) => (refocus ? closeOverlay() : setOverlay(null))}
                />
              ) : null}
              {overlay?.kind === "blame" ? <BlamePopover path={overlay.path} span={overlay.span} anchor={overlay.anchor} repo={diff?.repo ?? null} onClose={closeOverlay} /> : null}
            </div>
          </div>
    </DiffViewProviders>
  );
}
