import type { DiffCommentTarget, LineRange } from "../../types";
import { checkedLineRange } from "../../line-range";
import { isUnsent, type DiffThread } from "../comments/threads";
import type { InlineFinding } from "../findings/findings";
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
import type { ReviewKeys } from "./review-keys-context";

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
  setCollapsed: (paths: readonly string[], collapsed: boolean) => void;
  markViewed: (path: string, viewed: boolean) => void;
  deleteComment: (id: string) => void;
  toggleFinding: (item: InlineFinding, selected: boolean) => void;
  explain: ((path: string, side: "old" | "new", startLine: number, endLine: number) => void) | null;
  setDisplay: (setting: "mode" | "layout" | "wrap") => void;
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

function threadAt(env: ReviewEnv, cursor: Cursor): DiffThread | null {
  return anchorsAtCursor(env.files, cursor, env.threads)[0] ?? null;
}

function focusedThread(env: ReviewEnv, cursor: Cursor): DiffThread | null {
  const id = env.keys.get().focusedThread;
  return env.threads.find((thread) => thread.id === id) ?? threadAt(env, cursor);
}

/** The reader's own comment that is still editable in a thread: the latest unsent one. */
function ownUnsent(thread: DiffThread): string | null {
  const entry = thread.entries.filter(isUnsent).at(-1);
  return entry === undefined ? null : entry.comment.id;
}

function go(env: ReviewEnv, cursor: Cursor, options: { block?: "center" | "start" | "end"; thread?: string | null } = {}): void {
  env.keys.set({ cursor, focusedThread: options.thread !== undefined ? options.thread : (threadAt(env, cursor)?.id ?? null) });
  env.reveal(cursor, options.block);
}

/** In visual mode the cursor stays on the selection's file and off its header. */
function withinSelection(env: ReviewEnv, next: Cursor): boolean {
  const { visual } = env.keys.get();
  return visual === null || (next.path === visual.path && next.line !== null);
}

export function runReviewCommand(command: ReviewCommand, count: number, env: ReviewEnv): void {
  const state = env.keys.get();
  // A cursor the reader scrolled away from (or whose file a refresh dropped) restarts at the top of the screen, as in vim.
  const kept = state.cursor !== null && cursorPosition(env.files, state.cursor) !== null && env.onScreen(state.cursor) !== false ? state.cursor : null;
  const cursor = kept ?? env.seat();
  if (cursor === null) return;
  if (cursor !== state.cursor) env.keys.set({ cursor, focusedThread: threadAt(env, cursor)?.id ?? null });
  const { files } = env;
  const model = env.keys.models.get(cursor.path) ?? null;
  const row = model === null || cursor.line === null ? -1 : rowIndexOf(model.rows, cursor.side, cursor.line);
  const move = (next: Cursor, block?: "center" | "start" | "end") => {
    if (withinSelection(env, next)) go(env, next, { block });
  };

  switch (command.kind) {
    case "line":
      move(moveLines(files, cursor, command.direction * count));
      return;
    case "side": {
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
      if (next !== null) move(next, "start");
      return;
    }
    case "bottom": {
      const next = lastPosition(files, cursor.want);
      if (next !== null) move(next, "end");
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
      move(moveHunk(files, cursor, command.direction, count), "start");
      return;
    case "file":
      move(moveFile(files, cursor, command.direction, count), "start");
      return;
    case "thread": {
      const thread = nextAnchor(files, cursor, env.threads, command.direction, count);
      if (thread === null) {
        env.notify(env.threads.length === 0 ? "No comments yet" : command.direction === 1 ? "No more comments below" : "No more comments above");
        return;
      }
      if (files.find((file) => file.path === thread.path)?.collapsed === true) env.setCollapsed([thread.path], false);
      // The line may not be laid out yet (a collapsed or unmounted file); the view finds it once it is.
      const next = thread.line === null ? cursorOnAnchor(files, thread, cursor.want) : { path: thread.path, side: thread.side, line: thread.line, want: cursor.want };
      env.keys.set({ visual: null });
      go(env, next, { block: "center", thread: thread.id });
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
      go(env, finding.line === null ? cursorOnAnchor(files, finding, cursor.want) : { path: finding.path, side: "RIGHT", line: finding.line, want: cursor.want }, { block: "center" });
      return;
    }
    case "scroll":
      env.reveal(cursor, command.block);
      return;
    case "fold": {
      const header = { ...cursor, line: null };
      switch (command.action) {
        case "toggle": {
          const thread = focusedThread(env, cursor);
          if (thread !== null) {
            env.keys.threads.get(thread.id)?.toggle();
            return;
          }
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
          go(env, header, { block: "start" });
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
      if (thread === null) env.notify("No comment thread on this line");
      else if (thread.orphaned) env.notify("The comment this thread answers is gone");
      else env.keys.threads.get(thread.id)?.reply();
      return;
    }
    case "edit":
    case "delete": {
      const thread = focusedThread(env, cursor);
      const id = thread === null ? null : ownUnsent(thread);
      if (thread === null || id === null) {
        env.notify(thread === null ? "No comment thread on this line" : "Nothing unsent of yours in this thread");
        return;
      }
      if (command.kind === "edit") env.keys.threads.get(thread.id)?.edit(id);
      else env.deleteComment(id);
      return;
    }
    case "toggleFinding": {
      const finding = anchorsAtCursor(files, cursor, env.findings)[0];
      if (finding === undefined) env.notify("No review finding on this line");
      else env.toggleFinding(finding.item, !finding.item.selected);
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
      go(env, moveFile(folded, { ...cursor, line: null }, 1, 1), { block: "start" });
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
    case "display":
      env.setDisplay(command.setting);
      return;
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
      if (symbols === undefined) env.notify("Symbol peeks are in the structural view (gm switches to it)");
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
      return;
  }
}
