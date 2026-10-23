// The conversation as a mode of the changes view: entering and leaving it (`gc`), the cursor over its rows, and what
// the keys do there. The thread keys act on the thread under the cursor as they do on a line's in the diff.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CommentMeta, ConversationData, DiffCommentTarget, LineRange, PullRequestSummary } from "../../types";
import { githubCommitUrl } from "../links";
import type { NarrativePatchFile } from "../../narrative";
import type { Cursor } from "../keys/nav";
import { runReviewCommand, runThreadCommand, type ReviewEnv } from "../keys/review-commands";
import type { FocusedAnnotation, ReviewKeys } from "../keys/review-keys-context";
import type { PatchAnnotationProps } from "../patch-annotations";
import { flipped, withMembers } from "../sets";
import type { DiffViewMode } from "../summary-bar";
import { threadCode, type ThreadCode } from "../comments/thread-code";
import type { DiffThread } from "../comments/threads";
import { commitKey, conversationStops, threadKey, threadStartsFolded, type ConversationCommit, type ConversationItem, type ConversationStop } from "./conversation";
import type { ConversationCommand } from "./conversation-keymap";
import type { useConversationWriting } from "./use-conversation-writing";

const NO_FINDINGS: PatchAnnotationProps["findings"] = [];
const NOT_A_THREAD = "That key acts on comment threads (c goes to the next one)";

export interface ConversationModeOptions {
  keys: ReviewKeys;
  mode: DiffViewMode;
  setMode: (mode: DiffViewMode) => void;
  available: boolean;
  items: readonly ConversationItem[];
  pullRequest: PullRequestSummary | null;
  data: ConversationData | null;
  writer: ReturnType<typeof useConversationWriting>;
  narrativeAvailable: boolean;
  enterNarrative: () => void;
  threadById: ReadonlyMap<string, DiffThread>;
  files: readonly NarrativePatchFile[];
  currentPaths: ReadonlySet<string>;
  repo: string | null;
  addComment: (path: string, range: LineRange, body: string, target: DiffCommentTarget) => Promise<void>;
  onToggleFinding: PatchAnnotationProps["onToggleFinding"];
  onEditFinding: PatchAnnotationProps["onEditFinding"];
  /** The files view's keys, which the view-wide keys (help, refresh, send) run with. */
  filesEnv: () => ReviewEnv;
  focusRoot: () => void;
  /** The files view with the cursor here (see `DiffView`'s `showInFiles`). */
  showInFiles: (cursor: Cursor | null, focused?: FocusedAnnotation | null) => void;
  /** The files view at a file's header. */
  openFileInFiles: (path: string) => void;
  /** The files view showing one commit's changes. */
  openCommit: (commit: ConversationCommit) => void;
  openUrl: (url: string) => void;
  notify: (message: string) => void;
}

function stopUrl(stop: ConversationStop, repo: string | null): string | null {
  if (stop.kind === "commit") return repo === null ? null : githubCommitUrl(repo, stop.commit.commit.sha);
  if (stop.kind === "thread") return null;
  if (stop.kind === "link") return stop.url;
  const { item } = stop;
  switch (item.kind) {
    case "opened":
      return item.event.url;
    case "review":
      return item.review.url;
    case "comment":
      return item.comment.url;
    case "action":
      return item.event.url ?? null;
  }
}

/** The GitHub comment a stop stands for, as the writing keys act on it; null for commits, events and the summary. */
function commentAt(stop: ConversationStop | null, data: ConversationData | null): { id: string; body: string; mine: boolean; deletable: boolean; meta: CommentMeta | null } | null {
  if (stop === null) return null;
  const meta = (id: string) => data?.comments[id] ?? null;
  if (stop.kind === "thread") {
    const root = stop.thread.entries[0]!;
    if (root.source !== "github") return null;
    // Inline comments are edited from GitHub's own thread; here they take quotes and reactions.
    return { id: root.comment.id, body: root.comment.body, mine: false, deletable: false, meta: meta(root.comment.id) };
  }
  if (stop.kind !== "item") return null;
  const { item } = stop;
  switch (item.kind) {
    case "opened":
      return { id: item.event.id, body: item.event.body, mine: data?.viewer != null && data.viewer === item.event.author, deletable: false, meta: meta(item.event.id) };
    case "comment":
      return { id: item.comment.id, body: item.comment.body, mine: item.comment.mine, deletable: true, meta: meta(item.comment.id) };
    case "review":
      return { id: item.review.id, body: item.review.body, mine: item.review.mine, deletable: false, meta: meta(item.review.id) };
    case "action":
      return null;
  }
}

export function useConversationMode(options: ConversationModeOptions) {
  const { keys, mode, items, pullRequest, data, writer, files, threadById, currentPaths, notify } = options;
  const stops = useMemo(() => conversationStops(items, pullRequest), [items, pullRequest]);
  // Null keeps the cursor on the first entry until the reader moves it: the PR's description and reviews load after
  // the view opens, and land before what was first until then.
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stopRefs = useRef(new Map<string, HTMLElement>());
  const codes = useMemo(() => {
    const threads = items.flatMap((item) => (item.kind === "thread" ? [item.thread] : item.kind === "review" ? item.threads : []));
    return new Map(threads.map((thread) => [thread.id, threadCode(thread, files)]));
  }, [items, files]);
  const codeOf = (thread: DiffThread): ThreadCode => codes.get(thread.id) ?? threadCode(thread, files);

  const index = cursorKey === null ? (stops.length > 0 ? 0 : -1) : stops.findIndex((stop) => stop.key === cursorKey);
  const current = index === -1 ? null : stops[index]!;
  const original = (thread: DiffThread) => threadById.get(thread.id) ?? thread;

  // The thread under the cursor is the one the diff's keys and its own card see as focused.
  const focusedThread = current?.kind === "thread" ? current.thread.id : null;
  useEffect(() => {
    if (mode !== "conversation") return;
    keys.set({ cursor: null, visual: null, focused: focusedThread === null ? null : { kind: "thread", id: focusedThread } });
  }, [mode, focusedThread, keys]);

  const reveal = (key: string, block: ScrollLogicalPosition = "nearest") => stopRefs.current.get(key)?.scrollIntoView({ block });
  const moveTo = (at: number, block?: ScrollLogicalPosition) => {
    const stop = stops[Math.max(0, Math.min(stops.length - 1, at))];
    if (stop === undefined) return;
    setCursorKey(stop.key);
    reveal(stop.key, block);
  };

  /** Where `gc` returns to: the view it was pressed in, and the cursor there. */
  const back = useRef<{ mode: "files" | "narrative"; cursor: Cursor | null } | null>(null);
  const enter = () => {
    if (!options.available) {
      notify("Nothing to show yet: no commits, comments or reviews");
      return;
    }
    back.current = { mode: mode === "narrative" ? "narrative" : "files", cursor: keys.get().cursor };
    options.setMode("conversation");
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
  useEffect(() => {
    if (mode !== "conversation") return;
    scrollRef.current?.scrollTo({ top: 0 });
    setCursorKey(null);
  }, [mode]);

  /**
   * Runs a thread key once its card is on screen: a folded block opens first, and the card registers its controls as
   * it mounts, a frame or two later.
   */
  const withThreadShown = (thread: DiffThread, run: () => void) => {
    const key = threadKey(thread);
    if (folded.has(key) === threadStartsFolded(thread)) {
      run();
      return;
    }
    setFolded((set) => flipped(set, key));
    requestAnimationFrame(() => requestAnimationFrame(run));
  };

  /** `gf` on a thread: the files view at its line, or at its file when the diff has no line for it today. */
  const openThread = (thread: DiffThread) => {
    const target = original(thread);
    if (!currentPaths.has(target.path)) {
      notify(`${target.path} is not in the current diff`);
      return;
    }
    if (target.outdated || target.line === null) options.openFileInFiles(target.path);
    else options.showInFiles({ path: target.path, side: target.side, line: target.line, want: target.side }, { kind: "thread", id: target.id });
  };

  /** The first stop at least partly in view below (or above) the cursor's, after a page scroll. */
  const inView = (direction: 1 | -1): number => {
    const scroller = scrollRef.current;
    if (scroller === null) return -1;
    const view = scroller.getBoundingClientRect();
    const order = direction === 1 ? stops.map((_, at) => at) : stops.map((_, at) => stops.length - 1 - at);
    return (
      order.find((at) => {
        const rect = stopRefs.current.get(stops[at]!.key)?.getBoundingClientRect();
        return rect !== undefined && rect.bottom > view.top && rect.top < view.bottom;
      }) ?? -1
    );
  };

  const run = (command: ConversationCommand, count: number) => {
    switch (command.kind) {
      case "conversation":
        leave();
        return;
      case "narrative":
        options.enterNarrative();
        return;
      case "line":
        moveTo(index === -1 ? 0 : index + command.direction * count);
        return;
      case "top":
        scrollRef.current?.scrollTo({ top: 0 });
        moveTo(0);
        return;
      case "bottom":
        // The status box's last rows (mergeability) are no stop, so the scroll goes to the very end.
        moveTo(stops.length - 1, "end");
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        return;
      case "page": {
        const scroller = scrollRef.current;
        if (scroller === null) return;
        scroller.scrollBy({ top: command.fraction * count * scroller.clientHeight, behavior: "auto" });
        const at = inView(command.fraction > 0 ? 1 : -1);
        if (at !== -1 && at !== index) setCursorKey(stops[at]!.key);
        return;
      }
      case "thread": {
        let at = index;
        for (let step = 0; step < count; step++) {
          let next = at + command.direction;
          while (next >= 0 && next < stops.length && stops[next]!.kind !== "thread") next += command.direction;
          if (next < 0 || next >= stops.length) break;
          at = next;
        }
        if (at === index) notify(command.direction === 1 ? "No comment thread below" : "No comment thread above");
        else moveTo(at, "center");
        return;
      }
      case "scroll":
        if (current !== null) reveal(current.key, command.block);
        return;
      case "fold": {
        if (current === null) return;
        if (command.action !== "toggle" && command.action !== "annotation") {
          notify("Enter or za opens and closes the entry");
          return;
        }
        if (current.kind === "thread") {
          if (threadStartsFolded(current.thread) || folded.has(current.key)) setFolded((set) => flipped(set, current.key));
          else keys.threads.get(current.thread.id)?.toggle();
        }
        else if (current.kind === "commit") options.openCommit(current.commit);
        else if (current.kind === "link") {
          if (current.url === null) notify("Nothing to open here");
          else options.openUrl(current.url);
        } else if (current.item.kind !== "action" && (current.item.kind !== "review" || current.item.review.body.trim() !== "")) setFolded((set) => flipped(set, current.key));
        return;
      }
      case "openInFiles":
        if (current?.kind === "thread") openThread(current.thread);
        else if (current?.kind === "commit") options.openCommit(current.commit);
        else notify("gf opens a thread's line or a commit's changes in the files view");
        return;
      case "openGithub": {
        if (current?.kind === "thread") {
          runThreadCommand(command, original(current.thread), options.filesEnv());
          return;
        }
        const url = current === null ? null : stopUrl(current, options.repo);
        if (url === null) notify("This entry is not on GitHub");
        else options.openUrl(url);
        return;
      }
      case "comment":
        if (writer.writing === null) notify("This conversation only reads; comment on GitHub (gx)");
        else writer.focusComposer();
        return;
      case "quote": {
        const comment = commentAt(current, data);
        if (writer.writing === null) notify("This conversation only reads; comment on GitHub (gx)");
        else if (comment === null || comment.body.trim() === "") notify("No comment here to quote");
        else writer.quote(comment.body);
        return;
      }
      case "react": {
        const comment = commentAt(current, data);
        if (writer.writing === null) notify("Reactions need a pull request");
        else if (comment?.meta?.subject == null) notify("No comment here to react to");
        else writer.writing.pickReaction(comment.meta);
        return;
      }
      case "edit":
      case "delete": {
        if (current?.kind === "thread") {
          const thread = current.thread;
          withThreadShown(thread, () => runThreadCommand(command, original(thread), options.filesEnv()));
          return;
        }
        const comment = commentAt(current, data);
        if (comment === null) notify(NOT_A_THREAD);
        else if (writer.writing === null || !comment.mine) notify(command.kind === "edit" ? "Only your own comments can be edited" : "Only your own comments can be deleted");
        else if (command.kind === "edit") writer.edit(current!.key, comment.id);
        else if (!comment.deletable) notify("GitHub keeps reviews and the description; e edits them");
        else writer.remove(comment.id);
        return;
      }
      case "reply":
      case "resolve":
        if (current?.kind !== "thread") {
          notify(NOT_A_THREAD);
          return;
        }
        withThreadShown(current.thread, () => {
          runThreadCommand(command, original(current.thread), options.filesEnv());
          // Resolving folds the conversation as GitHub does: the block goes back to how a resolved thread starts.
          if (command.kind === "resolve" && current.thread.resolved !== true) setFolded((set) => withMembers(set, [current.key], false));
        });
        return;
      case "move":
      case "openThread":
      case "applySuggestion":
      case "batchSuggestion":
        if (current?.kind === "thread") runThreadCommand(command, original(current.thread), options.filesEnv());
        else notify(NOT_A_THREAD);
        return;
      default:
        // The view-wide keys (help, refresh, send, target, hide threads, commits, layout) mean what they do in the files view.
        runReviewCommand(command, count, options.filesEnv());
    }
  };

  const annotationsFor = (code: ThreadCode): PatchAnnotationProps => ({
    path: code.key,
    threads: [code.placed],
    composer: null,
    onStartComment: () => notify("Comment on lines from the files view (gf opens the thread's line)"),
    onCancelComposer: () => undefined,
    onSubmitComposer: (body, target) => options.addComment(code.path, code.placed, body, target),
    findings: NO_FINDINGS,
    onToggleFinding: options.onToggleFinding,
    onEditFinding: options.onEditFinding,
  });

  return {
    enter,
    run,
    cursorKey: current?.key ?? null,
    folded,
    scrollRef,
    stopRef: (key: string, node: HTMLElement | null) => {
      if (node === null) stopRefs.current.delete(key);
      else stopRefs.current.set(key, node);
    },
    codeOf,
    annotationsFor,
    openThread,
    openCommit: (commit: ConversationCommit) => {
      setCursorKey(commitKey(commit.commit));
      options.openCommit(commit);
    },
    toggle: (key: string) => {
      setCursorKey(key);
      setFolded((set) => flipped(set, key));
    },
  };
}
