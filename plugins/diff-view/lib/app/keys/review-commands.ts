import type { DiffCommentTarget, LineRange, SuggestionItem } from "../../types";
import { checkedLineRange } from "../../line-range";
import { threadKeyActions, type DiffThread } from "../comments/threads";
import { FINDING_FILTER_LABEL, nextFindingFilter, type FindingFilter, type InlineFinding } from "../findings/findings";
import { cursorSpan, type LineSpan } from "../links";
import { WHOLE_FILE, type ComposerAnchor } from "../patch-annotations";
import { suggestionBlock, suggestionLines } from "../../suggestions";
import type { SuggestionActions } from "../suggestions/actions";
import type { TextSearchEnv } from "../search/use-diff-search";
import type { ReviewCommand } from "./keymap";
import {
  anchorsAtCursor,
  cursorOnAnchor,
  cursorPosition,
  firstPosition,
  hunkSpanAt,
  lastPosition,
  lineOn,
  moveChange,
  moveFile,
  moveHunk,
  moveLines,
  nextAnchor,
  rowIndexOf,
  visualRange,
  type Cursor,
  type NavAnchor,
  type NavFile,
} from "./nav";
import type { FocusedAnnotation, ReviewKeys } from "./review-keys-context";
import { LINES_NOT_SHOWN } from "../suggestions/thread-suggestion";

const CANT_APPLY_HERE = "This view can't apply suggestions";
const CANT_APPLY_THIS = "This suggestion can't be applied";
const ALREADY_APPLYING = "Already applying suggestions";

export type FindingAnchor = NavAnchor & { item: InlineFinding };

/** Everything the review keys can read and do in one view. */
export interface ReviewEnv {
  keys: ReviewKeys;
  files: NavFile[];
  threads: readonly DiffThread[];
  findings: readonly FindingAnchor[];
  viewed: ReadonlySet<string>;
  /** Where new comments go, when they can go to GitHub at all. */
  target: { value: DiffCommentTarget; set: (target: DiffCommentTarget) => void } | null;
  /** A cursor on the first line in view, for when there is none yet or the reader scrolled away from it. */
  seat: () => Cursor | null;
  /** Whether the cursor's line is on screen; null when it is not rendered at all. */
  onScreen: (cursor: Cursor) => boolean | null;
  reveal: (cursor: Cursor, block?: "center" | "start" | "end") => void;
  /** Scrolls by a fraction of the viewport and returns how many rows that is. */
  scrollPage: (fraction: number) => number;
  startComment: (path: string, range: LineRange) => void;
  /** Focuses the open new-comment box; false when none is open. */
  focusComposer: () => boolean;
  /** Closes the new-comment box when it holds no text; false when there is none or it has a draft. */
  closeEmptyComposer: () => boolean;
  setCollapsed: (paths: readonly string[], collapsed: boolean) => void;
  /** False when the view refused the mark (a commit range that doesn't end at the head). */
  markViewed: (path: string, viewed: boolean) => boolean;
  deleteComment: (id: string) => void;
  canPostToGithub: boolean;
  moveComment: (id: string, target: DiffCommentTarget) => void;
  /** The source can resolve GitHub review threads. */
  canResolve: boolean;
  openUrl: (url: string) => void;
  openThread: (threadId: string) => void;
  toggleFinding: (item: InlineFinding, selected: boolean) => void;
  explain: ((path: string, side: "old" | "new", startLine: number, endLine: number) => void) | null;
  toggleLayout: () => void;
  /** Shows or hides the file list. */
  toggleFileTree: () => void;
  /** Moves the keyboard into the file list, on the cursor's file; false when the view is too narrow to show it. */
  focusFileTree: () => boolean;
  /** Which findings the diff shows; null when there are none to filter. */
  findingFilter: { value: FindingFilter; set: (filter: FindingFilter) => void } | null;
  /** Whether the findings the verifier filtered out are listed; null when it filtered none. */
  filteredFindings: { open: boolean; set: (open: boolean) => void } | null;
  /** Moves the keyboard into the findings listed above the diff; false when there are none. */
  focusOutsideFindings: () => boolean;
  refresh: () => void;
  focusSendBar: () => boolean;
  /** Hands the keyboard from the send bar back to the diff; false when focus is not in the bar. */
  leaveSendBar: () => boolean;
  openOverlay: (overlay: "help" | "files" | "search" | "fileFilter") => void;
  /** The last `/` search of the diff's text; null before one. */
  search: TextSearchEnv | null;
  /** Expands a file and puts the cursor on its header. */
  jump: (path: string) => void;
  pickSymbol: (names: string[], onPick: (name: string) => void) => void;
  notify: (message: string) => void;
  toggleWhitespace: () => void;
  /** Copies, opens and blames a file's lines; a null span is the whole file. */
  fileActions: FileActions;
  /** Hides or shows every comment thread inline; returns whether they are hidden now. */
  toggleThreadsHidden: () => boolean;
  /** The lines `I` puts in a suggestion block, and the suggestions `A`, `B` and `gB` apply. */
  suggestions: SuggestionActions;
  /** Opens the commit picker; null when the source lists no commits. */
  openCommits: (() => void) | null;
}

export interface FileActions {
  copyPath: (path: string) => void;
  copyLink: (path: string, span: LineSpan | null) => void;
  open: (path: string, span: LineSpan | null) => void;
  /** Null when the source has no blame. */
  blame: ((path: string, span: LineSpan) => void) | null;
}

type Annotation = { kind: "thread"; thread: DiffThread } | { kind: "finding"; finding: FindingAnchor };
type AnnotationAnchor = NavAnchor & { annotation: Annotation };

const focusOf = (annotation: Annotation): FocusedAnnotation =>
  annotation.kind === "thread" ? { kind: "thread", id: annotation.thread.id } : { kind: "finding", id: annotation.finding.id };

/** Threads and findings as one list, threads first on a shared line as both views render them; ids are kept apart by kind. */
function annotationAnchors(env: ReviewEnv): AnnotationAnchor[] {
  return [
    ...env.threads.map((thread): AnnotationAnchor => ({ id: `thread:${thread.id}`, path: thread.path, side: thread.side, line: thread.line, annotation: { kind: "thread", thread } })),
    ...env.findings.map((finding): AnnotationAnchor => ({ id: `finding:${finding.id}`, path: finding.path, side: finding.side, line: finding.line, annotation: { kind: "finding", finding } })),
  ];
}

function annotationsAt(env: ReviewEnv, cursor: Cursor): Annotation[] {
  return anchorsAtCursor(env.files, cursor, annotationAnchors(env)).map((anchor) => anchor.annotation);
}

/** The first comment thread or finding on a cursor's line, for a view placing the cursor itself, as a key move would focus it. */
export function focusAt(env: ReviewEnv, cursor: Cursor): FocusedAnnotation | null {
  const first = annotationsAt(env, cursor)[0];
  return first === undefined ? null : focusOf(first);
}

/** The annotation the comment keys act on: the one focused on this line, else the line's first. */
function focusedAnnotation(env: ReviewEnv, cursor: Cursor): Annotation | null {
  const focused = env.keys.get().focused;
  const here = annotationsAt(env, cursor);
  return here.find((annotation) => focused !== null && focusOf(annotation).kind === focused.kind && focusOf(annotation).id === focused.id) ?? here[0] ?? null;
}

function focusedThread(env: ReviewEnv, cursor: Cursor): DiffThread | null {
  const annotation = focusedAnnotation(env, cursor);
  return annotation?.kind === "thread" ? annotation.thread : null;
}

function go(env: ReviewEnv, cursor: Cursor, options: { block?: "center" | "start" | "end"; focused?: FocusedAnnotation | null } = {}): void {
  const first = annotationsAt(env, cursor)[0];
  env.keys.set({ cursor, focused: options.focused !== undefined ? options.focused : first === undefined ? null : focusOf(first) });
  env.reveal(cursor, options.block);
}

/** In visual mode the cursor stays on the selection's file and off its header. */
function withinSelection(env: ReviewEnv, next: Cursor): boolean {
  const { visual } = env.keys.get();
  return visual === null || (next.path === visual.path && next.line !== null);
}

/** Closes every open symbol peek; false when none was open. */
function closePeeks(env: ReviewEnv): boolean {
  return Array.from(env.keys.models.values()).filter((model) => model.symbols?.close() === true).length > 0;
}

/**
 * Commands about the view rather than a line, which work before there is a line to put the cursor on: a diff still
 * loading, or one with no changes. False for the rest.
 */
function runViewCommand(command: ReviewCommand, env: ReviewEnv): boolean {
  switch (command.kind) {
    case "target":
      if (env.target === null) env.notify("Comments here can only stay local");
      else {
        const next = env.target.value === "github" ? "local" : "github";
        env.target.set(next);
        env.notify(next === "github" ? "New comments go to the GitHub PR" : "New comments stay local");
      }
      return true;
    case "layout":
      env.toggleLayout();
      return true;
    case "fileTree":
      env.toggleFileTree();
      return true;
    case "findingFilter": {
      if (env.findingFilter === null) {
        env.notify("No review findings");
        return true;
      }
      const next = nextFindingFilter(env.findingFilter.value);
      env.findingFilter.set(next);
      env.notify(next === "off" ? "Review findings hidden" : `Review findings: ${FINDING_FILTER_LABEL[next]}`);
      return true;
    }
    case "filteredFindings": {
      if (env.filteredFindings === null) {
        env.notify("The review filtered out no findings");
        return true;
      }
      const open = !env.filteredFindings.open;
      env.filteredFindings.set(open);
      env.notify(open ? "Filtered findings listed above the diff" : "Filtered findings folded");
      return true;
    }
    case "outsideFindings":
      if (!env.focusOutsideFindings()) env.notify("No pre-existing or filtered findings");
      return true;
    case "refresh":
      env.refresh();
      return true;
    case "send":
      if (!env.focusSendBar()) env.notify("No comments waiting to be sent");
      return true;
    case "findFile":
      if (env.files.length === 0) env.notify("No changed files to search");
      else env.openOverlay("files");
      return true;
    case "help":
      env.openOverlay("help");
      return true;
    case "escape":
      // One thing per Escape, the one on top first: a peek, the send bar, the line selection, an empty comment box.
      if (closePeeks(env) || env.leaveSendBar()) return true;
      if (env.keys.get().visual !== null) env.keys.set({ visual: null });
      else if (!env.closeEmptyComposer()) env.search?.clear();
      return true;
    case "whitespace":
      env.toggleWhitespace();
      return true;
    case "hideThreads":
      env.notify(env.toggleThreadsHidden() ? "Comment threads hidden (H shows them, gc lists them)" : "Comment threads shown");
      return true;
    case "commitSuggestions": {
      const { apply, batch, busy } = env.suggestions;
      if (apply === null) env.notify(CANT_APPLY_HERE);
      else if (batch.length === 0) env.notify("No suggestions in the batch (B adds the one under the cursor)");
      else if (busy) env.notify(ALREADY_APPLYING);
      else void apply([...batch]);
      return true;
    }
    case "searchText":
      if (env.files.length === 0) env.notify("No changes to search");
      else env.openOverlay("search");
      return true;
    case "commits":
      if (env.openCommits === null) env.notify("No commits to pick from here (they need a pull request or a local checkout)");
      else env.openCommits();
      return true;
    case "fileFilter":
      env.openOverlay("fileFilter");
      return true;
    default:
      return false;
  }
}

export function runReviewCommand(command: ReviewCommand, count: number, env: ReviewEnv): void {
  if (runViewCommand(command, env)) return;
  const state = env.keys.get();
  if (command.kind === "follow") {
    const next = env.seat();
    const current = state.cursor;
    if (next === null || (current !== null && next.path === current.path && next.side === current.side && next.line === current.line)) return;
    if (!withinSelection(env, next)) return;
    const first = annotationsAt(env, next)[0];
    env.keys.set({ cursor: next, focused: first === undefined ? null : { ...focusOf(first), passive: true } });
    return;
  }
  // A cursor the reader scrolled away from (or whose file a refresh dropped) restarts at the top of the screen, as in vim.
  const kept = state.cursor !== null && cursorPosition(env.files, state.cursor) !== null && env.onScreen(state.cursor) !== false ? state.cursor : null;
  const cursor = kept ?? env.seat();
  if (cursor === null) return;
  if (cursor !== state.cursor) {
    const first = annotationsAt(env, cursor)[0];
    env.keys.set({ cursor, focused: first === undefined ? null : focusOf(first) });
  }
  const { files } = env;
  const model = env.keys.models.get(cursor.path) ?? null;
  const row = model === null || cursor.line === null ? -1 : rowIndexOf(model.rows, cursor.side, cursor.line);
  const move = (next: Cursor, block?: "center" | "start" | "end") => {
    if (withinSelection(env, next)) go(env, next, { block });
  };

  switch (command.kind) {
    case "line": {
      // Several comments or findings under one line are stepped through before the cursor leaves it, in the order
      // they sit on screen: down from the line reaches the first, up from the line below reaches the last.
      let at = cursor;
      let focused = state.focused;
      for (let step = 0; step < count; step++) {
        const here = annotationsAt(env, at).map(focusOf);
        const index = focused === null ? -1 : here.findIndex((entry) => entry.kind === focused!.kind && entry.id === focused!.id);
        // Scrolled onto by hand, it was never opened; the first step down opens it instead of passing it.
        if (focused?.passive === true && index !== -1 && command.direction === 1) {
          focused = here[index]!;
          continue;
        }
        const next = index === -1 ? -1 : index + command.direction;
        if (next >= 0 && next < here.length) {
          focused = here[next]!;
          continue;
        }
        const moved = moveLines(files, at, command.direction);
        if (moved === at || !withinSelection(env, moved)) break;
        at = moved;
        const there = annotationsAt(env, at).map(focusOf);
        focused = (command.direction === 1 ? there[0] : there.at(-1)) ?? null;
      }
      if (at === cursor && focused === state.focused) return;
      go(env, at, { focused });
      return;
    }
    case "side": {
      // Past the old side, or from a file header, the next step left is the file list.
      if (command.side === "LEFT" && (cursor.line === null || cursor.side === "LEFT" || cursor.want === "LEFT")) {
        if (!env.focusFileTree()) env.notify("The file list needs a wider view");
        return;
      }
      const at = model?.rows[row];
      if (at === undefined || lineOn(at, command.side) === null) {
        env.keys.set({ cursor: { ...cursor, want: command.side } });
        return;
      }
      go(env, { ...cursor, side: command.side, line: lineOn(at, command.side), want: command.side });
      return;
    }
    case "top": {
      const next = firstPosition(files, cursor.want);
      if (next !== null) move(next);
      return;
    }
    case "bottom": {
      const next = lastPosition(files, cursor.want);
      if (next !== null) move(next);
      return;
    }
    case "page": {
      const rows = env.scrollPage(command.fraction * count);
      move(moveLines(files, cursor, rows));
      return;
    }
    case "change":
      move(moveChange(files, cursor, command.direction, count), "center");
      return;
    case "hunk":
      move(moveHunk(files, cursor, command.direction, count));
      return;
    case "file":
      move(moveFile(files, cursor, command.direction, count));
      return;
    case "thread": {
      const anchors = annotationAnchors(env);
      const from = state.focused === null ? null : `${state.focused.kind}:${state.focused.id}`;
      const anchor = nextAnchor(files, cursor, anchors, command.direction, count, from);
      if (anchor === null) {
        env.notify(anchors.length === 0 ? "No comments or findings yet" : command.direction === 1 ? "No more comments below" : "No more comments above");
        return;
      }
      if (files.find((file) => file.path === anchor.path)?.collapsed === true) env.setCollapsed([anchor.path], false);
      // The line may not be laid out yet (a collapsed or unmounted file); the view finds it once it is.
      const next = anchor.line === null ? cursorOnAnchor(files, anchor, cursor.want) : { path: anchor.path, side: anchor.side, line: anchor.line, want: cursor.want };
      env.keys.set({ visual: null });
      go(env, next, { block: "center", focused: focusOf(anchor.annotation) });
      return;
    }
    case "finding": {
      const finding = nextAnchor(files, cursor, env.findings, command.direction, count);
      if (finding === null) {
        env.notify(env.findings.length === 0 ? "No review findings shown" : command.direction === 1 ? "No more findings below" : "No more findings above");
        return;
      }
      if (files.find((file) => file.path === finding.path)?.collapsed === true) env.setCollapsed([finding.path], false);
      env.keys.set({ visual: null });
      go(env, finding.line === null ? cursorOnAnchor(files, finding, cursor.want) : { path: finding.path, side: "RIGHT", line: finding.line, want: cursor.want }, { block: "center", focused: { kind: "finding", id: finding.id } });
      return;
    }
    case "scroll":
      env.reveal(cursor, command.block);
      return;
    case "fold": {
      const header = { ...cursor, line: null };
      switch (command.action) {
        case "toggle":
        case "annotation": {
          // On a fold of hidden lines, Enter (and za) opens it.
          const fold = model !== null && row !== -1 && model.rows[row]?.expander === true ? model.expand?.(row) : undefined;
          if (fold !== undefined) {
            if (fold === null) return;
            const line = cursor.side === "LEFT" ? fold.left : fold.right;
            const side = line === null ? (cursor.side === "LEFT" ? "RIGHT" : "LEFT") : cursor.side;
            go(env, { ...cursor, side, line: line ?? (side === "LEFT" ? fold.left : fold.right) });
            return;
          }
          const annotation = focusedAnnotation(env, cursor);
          if (annotation !== null) {
            if (annotation.kind === "thread") env.keys.threads.get(annotation.thread.id)?.toggle();
            else env.keys.findings.get(annotation.finding.id)?.toggle();
            return;
          }
          // Enter folds a file only from its header; on a code line it would be an easy accident.
          if (command.action === "annotation" && cursor.line !== null) return;
          const collapsed = files.find((file) => file.path === cursor.path)?.collapsed === true;
          if (command.action === "annotation" && model?.loadPatch !== undefined && !collapsed) {
            model.loadPatch();
            return;
          }
          env.setCollapsed([cursor.path], !collapsed);
          if (!collapsed) go(env, header);
          return;
        }
        case "open":
          env.setCollapsed([cursor.path], false);
          return;
        case "close":
          env.setCollapsed([cursor.path], true);
          go(env, header);
          return;
        case "openAll":
          env.setCollapsed(files.map((file) => file.path), false);
          return;
        case "closeAll":
          env.setCollapsed(files.map((file) => file.path), true);
          go(env, header);
          return;
        case "moreContext":
          if (model?.moreContext === undefined) env.notify("Only the structural view and the narrative's excerpts fold lines");
          else if (row !== -1) model.moreContext(row);
          return;
      }
      return;
    }
    case "visual":
      if (state.visual !== null) env.keys.set({ visual: null });
      else if (cursor.line !== null) env.keys.set({ visual: cursor });
      return;
    case "comment": {
      if (env.focusComposer()) return;
      if (model !== null && row !== -1 && model.rows[row]?.expander === true) {
        env.notify("Open the fold first (Enter), then comment on a line");
        return;
      }
      const { visual } = env.keys.get();
      env.keys.set({ visual: null });
      if (cursor.line === null) {
        env.startComment(cursor.path, WHOLE_FILE);
        return;
      }
      const range = visual !== null && model !== null ? visualRange(model.rows, visual, cursor, model.cutToHunk) : null;
      env.startComment(cursor.path, range ?? checkedLineRange({ line: cursor.line, side: cursor.side }));
      return;
    }
    case "commentFile":
      env.keys.set({ visual: null });
      env.startComment(cursor.path, WHOLE_FILE);
      return;
    case "reply": {
      const thread = focusedThread(env, cursor);
      if (thread === null) env.notify(focusedAnnotation(env, cursor) === null ? "No comment thread on this line" : "Review findings take no replies; i comments on the line");
      else if (thread.orphaned) env.notify("The comment this thread answers is gone");
      else env.keys.threads.get(thread.id)?.reply();
      return;
    }
    case "edit":
    case "delete": {
      const annotation = focusedAnnotation(env, cursor);
      if (annotation?.kind === "finding") {
        if (command.kind === "edit") env.keys.findings.get(annotation.finding.id)?.edit();
        else env.notify("Findings can't be deleted; x excludes one from the apply round");
        return;
      }
      const thread = focusedThread(env, cursor);
      const id = thread === null ? null : (threadKeyActions(thread, env.canPostToGithub).ownUnsent?.id ?? null);
      if (thread === null || id === null) {
        env.notify(thread === null ? "No comment thread on this line" : "Nothing unsent of yours in this thread");
        return;
      }
      if (command.kind === "edit") env.keys.threads.get(thread.id)?.edit(id);
      else env.deleteComment(id);
      return;
    }
    case "resolve": {
      const thread = focusedThread(env, cursor);
      if (thread === null) env.notify(focusedAnnotation(env, cursor) === null ? "No comment thread on this line" : "That key acts on comment threads, not findings");
      else if (!env.canResolve || !threadKeyActions(thread, env.canPostToGithub).canResolve) env.notify("Only GitHub review threads can be resolved");
      else {
        const resolved = thread.resolved !== true;
        env.keys.threads.get(thread.id)?.resolve(resolved);
        env.notify(resolved ? "Resolving the thread on GitHub" : "Reopening the thread on GitHub");
      }
      return;
    }
    case "move":
    case "openGithub":
    case "openThread": {
      const thread = focusedThread(env, cursor);
      if (thread === null) {
        env.notify(focusedAnnotation(env, cursor) === null ? "No comment thread on this line" : "That key acts on comment threads, not findings");
        return;
      }
      const actions = threadKeyActions(thread, env.canPostToGithub);
      if (command.kind === "move") {
        if (actions.ownUnsent === null || actions.moveTo === null) env.notify(actions.ownUnsent === null ? "Nothing unsent of yours in this thread" : "This comment can only stay local");
        else {
          env.moveComment(actions.ownUnsent.id, actions.moveTo);
          env.notify(actions.moveTo === "github" ? "Moved to the GitHub PR drafts" : "Made local");
        }
      } else if (command.kind === "openGithub") {
        if (actions.url === null) env.notify("This thread is not on GitHub");
        else env.openUrl(actions.url);
      } else if (actions.agentThread === null) env.notify("No agent has replied in this thread");
      else env.openThread(actions.agentThread);
      return;
    }
    case "toggleFinding": {
      const annotation = focusedAnnotation(env, cursor);
      // A thread may hold focus on a line that also has findings; x still means the line's first finding.
      const finding = annotation?.kind === "finding" ? annotation.finding : anchorsAtCursor(files, cursor, env.findings)[0];
      if (finding === undefined) {
        env.notify("No review finding on this line");
        return;
      }
      env.toggleFinding(finding.item, !finding.item.selected);
      env.keys.set({ focused: { kind: "finding", id: finding.id } });
      return;
    }
    case "explain": {
      const span = model === null || row === -1 ? null : hunkSpanAt(model.rows, row);
      if (env.explain === null) env.notify("This view cannot explain hunks");
      else if (span === null) env.notify("Move onto a hunk to explain it");
      else {
        env.explain(cursor.path, span.side, span.start, span.stop);
        env.notify("Asking an agent to explain this hunk");
      }
      return;
    }
    case "viewed": {
      const nowViewed = !env.viewed.has(cursor.path);
      if (!env.markViewed(cursor.path, nowViewed) || !nowViewed) return;
      // Marking a file viewed folds it away, so the review carries on at the next file.
      const folded = files.map((file) => (file.path === cursor.path ? { ...file, collapsed: true } : file));
      go(env, moveFile(folded, { ...cursor, line: null }, 1, 1));
      return;
    }
    case "searchNext": {
      if (env.search === null) {
        env.notify("Search the diff with / first");
        return;
      }
      const reached = env.search.step(cursor, command.direction, count);
      if (reached === null) {
        env.notify(`Nothing in the diff matches “${env.search.query}”`);
        return;
      }
      const next = reached.cursor;
      if (files.find((file) => file.path === next.path)?.collapsed === true) env.setCollapsed([next.path], false);
      if (reached.wrapped) env.notify(command.direction === 1 ? "Search hit the bottom, continuing at the top" : "Search hit the top, continuing at the bottom");
      env.keys.set({ visual: null });
      go(env, next, { block: "center" });
      return;
    }
    case "peek": {
      const symbols = model?.symbols;
      if (symbols === undefined) env.notify("Symbol peeks need a structural diff, which this file has none of");
      else if (row === -1) env.notify("Move onto a line to peek at a symbol on it");
      else {
        const names = symbols.at(row, cursor.side);
        if (names.length === 0) env.notify("No symbols on this line");
        else if (names.length === 1) symbols.peek(row, names[0]!);
        else env.pickSymbol(names, (name) => symbols.peek(row, name));
      }
      return;
    }
    // The view switches modes before these reach here.
    case "narrative":
    case "commentsView":
      return;
    case "copyPath":
      env.fileActions.copyPath(cursor.path);
      return;
    case "copyLink":
    case "openFile":
    case "blame": {
      const span = cursorSpan(model?.rows ?? null, cursor, state.visual);
      if (command.kind === "blame") {
        if (env.fileActions.blame === null) env.notify("This view has no blame");
        else if (span === null) env.notify("Move onto a line to blame it");
        else env.fileActions.blame(cursor.path, span);
        return;
      }
      // Like vim's y, a yank ends the selection.
      if (state.visual !== null) env.keys.set({ visual: null });
      if (command.kind === "copyLink") env.fileActions.copyLink(cursor.path, span);
      else env.fileActions.open(cursor.path, span);
      return;
    }
    case "suggest": {
      if (env.focusComposer()) return;
      if (model !== null && row !== -1 && model.rows[row]?.expander === true) {
        env.notify("Open the fold first (Enter), then suggest on a line");
        return;
      }
      if (cursor.line === null) {
        env.notify("Move onto a line (or V to select some) to suggest a change");
        return;
      }
      const { visual } = env.keys.get();
      const range = (visual !== null && model !== null ? visualRange(model.rows, visual, cursor, model.cutToHunk) : null) ?? checkedLineRange({ line: cursor.line, side: cursor.side });
      const lines = suggestionLines(range);
      if (lines === null) {
        env.notify("Suggestions replace new-side lines; l moves to the new side");
        return;
      }
      const text = env.suggestions.linesAt(cursor.path, lines.startLine, lines.endLine);
      if (text === null) {
        env.notify("The diff doesn't show all of those lines; suggest on changed lines or their context");
        return;
      }
      env.keys.set({ visual: null });
      const anchor: ComposerAnchor = { ...range, initialBody: suggestionBlock(text) };
      env.startComment(cursor.path, anchor);
      return;
    }
    case "applySuggestion":
    case "batchSuggestion": {
      const annotation = focusedAnnotation(env, cursor);
      if (annotation?.kind === "finding") {
        const state = env.suggestions.forFinding(annotation.finding.item);
        if (state === null) env.notify("This finding has no suggested change");
        else runSuggestion(env, command.kind, state.item, state.reason);
        return;
      }
      const thread = annotation?.kind === "thread" ? annotation.thread : null;
      const suggestion = thread === null ? null : env.suggestions.forThread(thread);
      if (thread === null || suggestion === null) {
        env.notify(thread === null ? "No comment thread or review finding on this line" : "No suggested change in this thread");
        return;
      }
      runSuggestion(env, command.kind, suggestion.item, suggestion.reason);
      return;
    }
    case "postSuggestion": {
      const annotation = focusedAnnotation(env, cursor);
      const finding = annotation?.kind === "finding" ? annotation.finding : anchorsAtCursor(files, cursor, env.findings)[0];
      if (finding === undefined) {
        env.notify("No review finding on this line");
        return;
      }
      const state = env.suggestions.forFinding(finding.item);
      if (env.suggestions.post === null) env.notify("Suggestions post to a pull request, and this view has none");
      else if (state === null) env.notify("This finding has no suggested change");
      else if (state.applied) env.notify("Already applied");
      else if (env.suggestions.posted.has(state.id)) env.notify("Already posted as a draft on the pull request");
      else if (state.current === null) env.notify(`${LINES_NOT_SHOWN}, so GitHub can't take a comment on them`);
      else {
        env.keys.set({ focused: { kind: "finding", id: finding.id } });
        void env.suggestions.post(finding.item, state);
      }
      return;
    }
  }
}

/** `A` applies a suggestion now, `B` adds it to the batch or takes it out. */
function runSuggestion(env: ReviewEnv, kind: "applySuggestion" | "batchSuggestion", item: SuggestionItem | null, reason: string | null): void {
  if (item === null) {
    env.notify(reason ?? CANT_APPLY_THIS);
    return;
  }
  const { apply, busy, toggleBatch } = env.suggestions;
  if (apply === null) env.notify(CANT_APPLY_HERE);
  else if (kind === "batchSuggestion") {
    const added = toggleBatch(item);
    const count = env.suggestions.batch.length + (added ? 1 : -1);
    env.notify(added ? `Added to the batch (${count}; gB applies it)` : "Taken out of the batch");
  } else if (busy) env.notify(ALREADY_APPLYING);
  else void apply([item]);
}
