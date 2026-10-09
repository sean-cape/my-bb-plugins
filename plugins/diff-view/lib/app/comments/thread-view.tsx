import { useContext, useEffect, useRef, useState } from "react";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Badge } from "../ui/badge";
import { Button, COMPACT } from "../ui/button";
import { ExternalLink } from "../ui/external-link";
import { cn } from "../utils";
import { CHEVRON, FAST, OPACITY_TRANSITION, PRESS, enter, useOpenedSinceMount } from "../ui/motion";
import { relativeTime } from "../format";
import { useDiffSource } from "../source";
import { longLineLabel, shortLineLabel } from "../../line-range";
import { DiffCommentForm } from "./comment-form";
import { DiffCommentsContext } from "./context";
import { isUnsent, localCommentState, threadIsOpen, threadKeyActions, type DiffThread, type LocalCommentState, type ThreadEntry } from "./threads";
import { returnToDiff, useIsFocusedThread, useThreadControls } from "../keys/review-keys-context";

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const LOCAL_STATE_LABEL: Record<LocalCommentState, string> = {
  pending: "local · not sent",
  draft: "GitHub draft",
  submitted: "sent to agent",
  posted: "posted to GitHub",
  addressed: "addressed",
  agent: "agent reply",
};

function entryKey(entry: ThreadEntry): string {
  return `${entry.source}:${entry.comment.id}`;
}

/** `arrived` marks a reply that came in while its thread was on screen; it is read once, at mount. */
function ThreadEntryView({
  entry,
  thread,
  isRoot,
  now,
  arrived = false,
  editing,
  setEditing,
}: {
  entry: ThreadEntry;
  thread: DiffThread;
  isRoot: boolean;
  now: number;
  arrived?: boolean;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}) {
  const actions = useContext(DiffCommentsContext);
  const { labels } = useDiffSource();
  const [entrance] = useState(() => (arrived ? cn(enter.rise, FAST) : undefined));
  const [draft, setDraft] = useState("");
  // Seeded when editing starts (from a click or the keyboard), not on every refetch, which would wipe the edit.
  const body = useRef("");
  body.current = entry.source === "local" ? entry.comment.body : "";
  useEffect(() => {
    if (editing) setDraft(body.current);
  }, [editing]);
  const [saving, setSaving] = useState(false);
  if (entry.source === "github") {
    const { comment } = entry;
    return (
      <div className={cn("flex flex-col gap-0.5", entrance)}>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <Icon name="GitPullRequest" className="size-3 shrink-0" />
          <span className="font-medium text-foreground">{comment.author}</span>
          {comment.mine ? <Badge>you</Badge> : null}
          <span>{relativeTime(Date.parse(comment.createdAt), now)}</span>
          {comment.addressedAt !== null ? <Badge tone="success">addressed</Badge> : null}
          <ExternalLink href={comment.url} title="Open on GitHub" className="ml-auto text-muted-foreground hover:text-foreground">
            <Icon name="ExternalLink" className="size-3" />
          </ExternalLink>
        </div>
        {comment.body.trim() !== "" ? <Markdown content={comment.body} className="text-sm" /> : <p className="text-xs italic text-muted-foreground">(no text)</p>}
      </div>
    );
  }
  const { comment } = entry;
  const state = localCommentState(comment);
  const unsent = state === "pending" || state === "draft";
  const githubAllowed = isRoot ? comment.line !== null : thread.onGithub;
  const save = async () => {
    if (draft.trim() === "" || draft === comment.body) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await actions.onEdit(comment.id, draft.trim());
      returnToDiff(document.activeElement);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={cn("flex flex-col gap-0.5", entrance)}>
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {state === "agent" ? <Icon name="diff-view-wrench" className="size-3 shrink-0" /> : <Icon name="MessageSquare" className="size-3 shrink-0" />}
        <span className="font-medium text-foreground">{state === "agent" ? "agent" : "you"}</span>
        <span className={cn("rounded px-1 text-[10px]", unsent ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : state === "addressed" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-muted")}>{LOCAL_STATE_LABEL[state]}</span>
        <span>{relativeTime(comment.createdAt, now)}</span>
        <span className="ml-auto flex items-center gap-1">
          {state === "agent" && comment.authorThreadId !== null ? (
            <button type="button" className={cn("rounded px-1 hover:bg-state-hover hover:text-foreground", PRESS)} onClick={() => actions.onOpenThread(comment.authorThreadId!)}>
              Open thread
            </button>
          ) : null}
          {comment.postedUrl !== null ? (
            <ExternalLink href={comment.postedUrl} title="Open on GitHub" className="text-muted-foreground hover:text-foreground">
              <Icon name="ExternalLink" className="size-3" />
            </ExternalLink>
          ) : null}
          {unsent && actions.canPostToGithub && (state === "draft" || githubAllowed) ? (
            <button
              type="button"
              className={cn("rounded px-1 hover:bg-state-hover hover:text-foreground", PRESS)}
              title={state === "draft" ? labels.makeLocal : "Post this to the pull request instead"}
              onClick={() => void actions.onMoveComment(comment.id, state === "draft" ? "local" : "github")}
            >
              {state === "draft" ? "Make local" : "Move to GitHub"}
            </button>
          ) : null}
          {unsent && !editing ? (
            <button
              type="button"
              className={cn("rounded px-1 hover:bg-state-hover hover:text-foreground", PRESS)}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          ) : null}
          {unsent || state === "agent" ? (
            <button type="button" aria-label="Delete comment" title={isRoot ? "Delete this comment and its replies" : "Delete this reply"} className={cn("flex size-5 items-center justify-center rounded hover:bg-state-hover hover:text-destructive", PRESS)} onClick={() => actions.onDelete(comment.id)}>
              <Icon name="Trash2" className="size-3" />
            </button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <div className={cn("flex flex-col gap-1.5 pb-1", enter.fade, FAST)}>
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void save();
              if (event.key !== "Escape") return;
              returnToDiff(event.currentTarget);
              if (draft === comment.body) setEditing(false);
            }}
          />
          <div className="flex gap-2">
            <Button type="button" className={COMPACT} disabled={saving || draft.trim() === ""} onClick={() => void save()}>
              Save
            </Button>
            <Button type="button" variant="ghost" className={COMPACT} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Markdown content={comment.body} className="text-sm" />
      )}
    </div>
  );
}

/** The keys that act on the thread under the cursor, so they are discoverable without the `?` sheet. */
function ThreadKeyHint({ thread, open }: { thread: DiffThread; open: boolean }) {
  const { canPostToGithub } = useContext(DiffCommentsContext);
  const actions = threadKeyActions(thread, canPostToGithub);
  const hints = [
    actions.canReply ? "r reply" : null,
    actions.ownUnsent !== null ? "e edit" : null,
    actions.ownUnsent !== null ? "dd delete" : null,
    actions.moveTo === "github" ? "M move to GitHub" : actions.moveTo === "local" ? "M make local" : null,
    actions.url !== null ? "gx open on GitHub" : null,
    actions.agentThread !== null ? "go open agent thread" : null,
    open ? "za fold" : "za unfold",
    "c next",
  ].filter((hint): hint is string => hint !== null);
  return <p className={cn("border-t border-border/60 px-2.5 py-1 font-mono text-[10px] text-muted-foreground", enter.fade, FAST)}>{hints.join(" · ")}</p>;
}

/** One thread under its line: the root, its replies (GitHub and local interleaved by time), and a reply box. Resolved threads start collapsed. */
export function DiffThreadView({ thread }: { thread: DiffThread }) {
  const actions = useContext(DiffCommentsContext);
  const now = useNow();
  const [open, setOpen] = useState(thread.resolved !== true);
  const [replying, setReplying] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const focused = useIsFocusedThread(thread.id);
  useThreadControls(thread.id, {
    toggle: () => setOpen((value) => !value),
    reply: () => {
      if (thread.orphaned) return;
      setOpen(true);
      setReplying(true);
    },
    edit: (commentId) => {
      setOpen(true);
      setEditingId(commentId);
    },
  });
  const entryEditing = (entry: ThreadEntry) => ({
    editing: entry.source === "local" && editingId === entry.comment.id,
    setEditing: (editing: boolean) => setEditingId(editing ? entry.comment.id : null),
  });
  const root = thread.entries[0]!;
  const replies = thread.entries.slice(1);
  const unsent = thread.entries.some(isUnsent);
  const firstLine = root.comment.body.split("\n").find((text) => text.trim() !== "") ?? "";
  const where = shortLineLabel(thread) ?? (thread.outdated ? "outdated" : "file");
  const reveal = useOpenedSinceMount(open) ? cn(enter.rise, FAST) : undefined;
  // Replies already here when the thread mounted (or seen before a collapse) arrive with it, not one by one.
  const seenReplies = useRef<Set<string> | null>(null);
  const seen = (seenReplies.current ??= new Set(replies.map(entryKey)));
  useEffect(() => {
    for (const entry of replies) seen.add(entryKey(entry));
  });
  return (
    <div
      data-comment-anchor=""
      data-comment-state={unsent ? "pending" : "done"}
      data-thread-id={thread.id}
      className={cn("my-1 min-w-0 max-w-full break-words rounded-md border bg-card text-sm [&_pre]:max-w-full [&_pre]:overflow-x-auto", enter.fade, FAST, OPACITY_TRANSITION, unsent ? "border-amber-500/60" : "border-border", !threadIsOpen(thread) && "opacity-75", focused && "ring-1 ring-primary/70")}
    >
      <button type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs" onClick={() => setOpen((value) => !value)} aria-expanded={open} data-bbm-open={open}>
        <Icon name="ChevronRight" className={cn("size-3 shrink-0 text-muted-foreground", CHEVRON)} />
        <span className="shrink-0 font-mono text-muted-foreground">{where}</span>
        {root.source === "github" ? <Badge tone="outline">GitHub</Badge> : null}
        {thread.resolved === true ? <Badge tone="success">resolved</Badge> : null}
        {thread.outdated ? <Badge title={`Left on ${longLineLabel(root.comment) ?? "a line"}, which the latest push changed`}>outdated · {shortLineLabel(root.comment) ?? "L?"}</Badge> : null}
        {!open ? <span className="min-w-0 flex-1 truncate text-foreground">{firstLine}</span> : <span className="flex-1" />}
        {replies.length > 0 ? <span className="shrink-0 text-muted-foreground">{replies.length} repl{replies.length === 1 ? "y" : "ies"}</span> : null}
      </button>
      {open ? (
        <div className={cn("flex flex-col gap-2 px-2.5 pb-2", reveal)}>
          <ThreadEntryView entry={root} thread={thread} isRoot now={now} {...entryEditing(root)} />
          {replies.length > 0 ? (
            <div className="flex flex-col gap-2 border-l-2 border-border pl-3">
              {replies.map((entry) => (
                <ThreadEntryView key={entryKey(entry)} entry={entry} thread={thread} isRoot={false} now={now} arrived={!seen.has(entryKey(entry))} {...entryEditing(entry)} />
              ))}
            </div>
          ) : null}
          {thread.orphaned ? (
            <p className="text-xs italic text-muted-foreground">The comment these replied to is gone.</p>
          ) : replying ? (
            <DiffCommentForm
              path={thread.path}
              range={thread}
              reply
              githubAllowed={thread.onGithub}
              onSubmit={(body, target) => actions.onReply(thread, body, target)}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <div>
              <button type="button" className={cn("rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)} onClick={() => setReplying(true)}>
                Reply
              </button>
            </div>
          )}
        </div>
      ) : null}
      {focused ? <ThreadKeyHint thread={thread} open={open} /> : null}
    </div>
  );
}
