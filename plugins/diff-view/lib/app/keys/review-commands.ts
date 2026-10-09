import type { DiffCommentTarget, LineRange } from "../../types";
import { checkedLineRange } from "../../line-range";
import { threadKeyActions, type DiffThread } from "../comments/threads";
import { FINDING_FILTER_LABEL, nextFindingFilter, type FindingFilter, type InlineFinding } from "../findings/findings";
import { WHOLE_FILE } from "../patch-annotations";
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
  markViewed: (path: string, viewed: boolean) => void;
  deleteComment: (id: string) => void;
  canPostToGithub: boolean;
  moveComment: (id: string, target: DiffCommentTarget) => void;
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
  refresh: () => void;
  focusSendBar: () => boolean;
  openOverlay: (overlay: "help" | "files") => void;
  /** The last `/` search, and the files it matches. */
  search: { query: string; matches: ReadonlySet<string> } | null;
  /** Expands a file and puts the cursor on its header. */
  jump: (path: string) => void;
  pickSymbol: (names: string[], onPick: (name: string) => void) => void;
  notify: (message: string) => void;
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

export function runReviewCommand(command: ReviewCommand, count: number, env: ReviewEnv): void {
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
          if (model?.moreContext === undefined) env.notify("Only the structural view folds unchanged lines");
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
      env.markViewed(cursor.path, nowViewed);
      if (!nowViewed) return;
      // Marking a file viewed folds it away, so the review carries on at the next file.
      const folded = files.map((file) => (file.path === cursor.path ? { ...file, collapsed: true } : file));
      go(env, moveFile(folded, { ...cursor, line: null }, 1, 1));
      return;
    }
    case "target":
      if (env.target === null) env.notify("Comments here can only stay local");
      else {
        const next = env.target.value === "github" ? "local" : "github";
        env.target.set(next);
        env.notify(next === "github" ? "New comments go to the GitHub PR" : "New comments stay local");
      }
      return;
    case "layout":
      env.toggleLayout();
      return;
    case "fileTree":
      env.toggleFileTree();
      return;
    case "findingFilter": {
      if (env.findingFilter === null) {
        env.notify("No review findings");
        return;
      }
      const next = nextFindingFilter(env.findingFilter.value);
      env.findingFilter.set(next);
      env.notify(next === "off" ? "Review findings hidden" : `Review findings: ${FINDING_FILTER_LABEL[next]}`);
      return;
    }
    case "refresh":
      env.refresh();
      return;
    case "send":
      if (!env.focusSendBar()) env.notify("No comments waiting to be sent");
      return;
    case "findFile":
      env.openOverlay("files");
      return;
    case "searchNext": {
      if (env.search === null) {
        env.notify("Search file names with / first");
        return;
      }
      const { query, matches } = env.search;
      const here = files.findIndex((file) => file.path === cursor.path);
      // Wraps past the end, as vim's search does.
      const order = command.direction === 1 ? [...files.slice(here + 1), ...files.slice(0, here + 1)] : [...files.slice(0, Math.max(0, here)).reverse(), ...files.slice(Math.max(0, here)).reverse()];
      const hits = order.filter((file) => matches.has(file.path));
      const target = hits[Math.min(count, hits.length) - 1];
      if (target === undefined) env.notify(`No file matches “${query}”`);
      else env.jump(target.path);
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
    case "help":
      env.openOverlay("help");
      return;
    case "escape":
      if (state.visual !== null) env.keys.set({ visual: null });
      else env.closeEmptyComposer();
      return;
  }
}
