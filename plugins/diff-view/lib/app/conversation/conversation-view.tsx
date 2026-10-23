import { useContext, useMemo, useState, type ReactNode, type RefObject } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { CommentMeta, ConversationData, ConversationEvent, PullRequestAction, ReactionContent, ReviewVerdict } from "../../types";
import { cn } from "../utils";
import { relativeTime, shortSha } from "../format";
import { githubCommitUrl } from "../links";
import { Badge } from "../ui/badge";
import { ExternalLink } from "../ui/external-link";
import { FAST, PRESS, enter } from "../ui/motion";
import { CURSOR_RING } from "../keys/review-keys-context";
import type { PatchAnnotationProps } from "../patch-annotations";
import { NoRows } from "../file-section";
import { AnnotatedPatch } from "../text/annotated-patch";
import { DiffErrorBoundary } from "../text/diff-error-boundary";
import { CommentBody } from "../suggestions/suggestion-diff";
import { DiffCommentsContext, type DiffCommentActions } from "../comments/context";
import { FileLevelComments } from "../comments/file-level-comments";
import { ThreadStartsOpenContext, useNow } from "../comments/thread-view";
import type { ThreadCode } from "../comments/thread-code";
import type { DiffThread } from "../comments/threads";
import { commitKey, threadKey, threadStartsFolded, type ConversationCommit, type ConversationItem, type ConversationReview } from "./conversation";
import { CheckMark, CommentMetaContext, MetaBadges, Reactions } from "./comment-meta";
import { Button, COMPACT } from "../ui/button";
import { LabelChip, PullRequestHeader, PullRequestStatus } from "./conversation-summary";

const NO_META: ConversationData["comments"] = {};

/** Each place the cursor stops carries its key, for the cursor to find and scroll to. */
export const CONVERSATION_STOP = "data-conversation-stop";

type StopRef = (key: string, node: HTMLElement | null) => void;

const stopProps = (key: string, stopRef: StopRef, focused: boolean) => ({
  ref: (node: HTMLElement | null) => stopRef(key, node),
  [CONVERSATION_STOP]: key,
  "data-cursor": focused ? "" : undefined,
});

/** The round marker on the timeline's rule, holding what kind of entry this is. */
function Marker({ icon, className }: { icon: string; className?: string }) {
  return (
    <span className={cn("relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground", className)}>
      <Icon name={icon} className="size-3.5" />
    </span>
  );
}

function When({ at, now }: { at: string; now: number }) {
  const time = Date.parse(at);
  return Number.isNaN(time) ? null : (
    <time dateTime={at} title={new Date(time).toLocaleString()}>
      {relativeTime(time, now)}
    </time>
  );
}

/** A comment as GitHub boxes it: who and when in a tinted header, then the text. Folded, the header alone shows the first line. */
function CommentCard({
  stopKey,
  stopRef,
  focused,
  author,
  verb,
  at,
  url,
  mine,
  badges,
  meta,
  isAuthor = false,
  body,
  folded: toggled,
  onToggle,
  editing = null,
  now,
}: {
  stopKey: string;
  stopRef: StopRef;
  focused: boolean;
  author: string;
  verb: string;
  at: string;
  url: string | null;
  mine: boolean;
  badges?: ReactNode;
  meta: CommentMeta | null;
  isAuthor?: boolean;
  body: string;
  /** Toggled from how it starts: open, or folded when GitHub hid it. */
  folded: boolean;
  onToggle: () => void;
  /** Set while the reader rewrites the comment. */
  editing?: { save: (body: string) => Promise<void>; cancel: () => void } | null;
  now: number;
}) {
  const folded = toggled !== (meta?.minimized != null) && editing === null;
  const firstLine = body.split("\n").find((text) => text.trim() !== "") ?? "";
  return (
    <div {...stopProps(stopKey, stopRef, focused)} className={cn("min-w-0 flex-1 overflow-hidden rounded-md border border-border bg-card", focused && CURSOR_RING)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <button type="button" className={cn("flex min-w-0 items-baseline gap-1.5 text-left", PRESS)} onClick={onToggle} aria-expanded={!folded} title={folded ? "Show the comment (Enter)" : "Fold the comment (Enter)"}>
          <span className="font-medium text-foreground">{author}</span>
          <span>{verb}</span>
          <When at={at} now={now} />
        </button>
        {mine ? <Badge>you</Badge> : null}
        <MetaBadges meta={meta} author={isAuthor} />
        {badges}
        {folded ? <span className="min-w-0 flex-1 truncate text-foreground">{firstLine}</span> : <span className="flex-1" />}
        {url !== null ? (
          <ExternalLink href={url} title="Open on GitHub (gx)" className="text-muted-foreground hover:text-foreground">
            <Icon name="ExternalLink" className="size-3" />
          </ExternalLink>
        ) : null}
      </div>
      {editing !== null ? (
        <EditBox initial={body} save={editing.save} cancel={editing.cancel} />
      ) : folded ? null : (
        <div className={cn("break-words px-3 py-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto", enter.fade, FAST)}>
          {body.trim() === "" ? <p className="text-xs italic text-muted-foreground">No description provided.</p> : <CommentBody body={body} expected={null} startLine={null} />}
          <Reactions meta={meta} />
        </div>
      )}
    </div>
  );
}

/** Rewriting a comment in place: ⌘↩ saves, Escape (or Cancel) leaves it as it was. */
function EditBox({ initial, save, cancel }: { initial: string; save: (body: string) => Promise<void>; cancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (draft.trim() === "" || draft === initial) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      await save(draft);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div data-escape-cancels="always" className={cn("flex flex-col gap-1.5 px-3 py-2", enter.fade, FAST)}>
      <textarea
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
        }}
      />
      <div className="flex gap-2">
        <Button type="button" className={COMPACT} disabled={saving || draft.trim() === ""} onClick={() => void submit()}>
          Update comment
        </Button>
        <Button type="button" variant="ghost" className={COMPACT} data-escape-cancel="" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** What the reader writes in the conversation; null where the source takes nothing. */
export interface ConversationWriting {
  /** The stop whose comment is being rewritten. */
  editingKey: string | null;
  save: (key: string, body: string) => Promise<void>;
  cancelEdit: () => void;
  draft: string;
  setDraft: (draft: string) => void;
  posting: boolean;
  post: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  react: (subject: string, content: ReactionContent, add: boolean) => void;
  pickReaction: (meta: CommentMeta) => void;
}

/** GitHub's comment box at the end of the conversation: i focuses it, ⌘↩ posts, Escape goes back to the keys keeping the draft. */
function Composer({ writing }: { writing: ConversationWriting }) {
  const { draft, setDraft, posting, post, composerRef } = writing;
  return (
    <section className="mt-3 flex flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2">
      <label className="text-xs font-medium text-muted-foreground" htmlFor="conversation-composer">
        Add a comment
      </label>
      <textarea
        id="conversation-composer"
        ref={composerRef}
        value={draft}
        placeholder="Leave a comment on the pull request (i)"
        onChange={(event) => setDraft(event.target.value)}
        rows={Math.min(16, Math.max(3, draft.split("\n").length + 1))}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") post();
        }}
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Markdown · ⌘↩ posts to GitHub · Esc (twice with vim mode) keeps the draft</span>
        <Button type="button" className={cn(COMPACT, "ml-auto")} disabled={posting || draft.trim() === ""} onClick={post}>
          {posting ? "Posting…" : "Comment"}
        </Button>
      </div>
    </section>
  );
}

const VERDICT: Record<ReviewVerdict, { icon: string; text: string; tone: string }> = {
  APPROVED: { icon: "Check", text: "approved these changes", tone: "border-emerald-500/60 text-emerald-600 dark:text-emerald-400" },
  CHANGES_REQUESTED: { icon: "diff-view-diff", text: "requested changes", tone: "border-destructive/60 text-destructive" },
  COMMENTED: { icon: "diff-view-eye", text: "reviewed", tone: "" },
  DISMISSED: { icon: "diff-view-eye", text: "left a review, since dismissed", tone: "" },
};

/**
 * A thread over its code: the file it is on, the lines it was left on, and the thread under them. Folded, as GitHub
 * shows a resolved or outdated conversation, it is the file's name, its labels, who resolved it, and a Show button.
 */
function ThreadBlock({
  code,
  stopRef,
  focused,
  folded,
  resolvedBy,
  inDiff,
  annotations,
  onToggle,
  onOpen,
}: {
  code: ThreadCode;
  stopRef: StopRef;
  focused: boolean;
  folded: boolean;
  resolvedBy: string | null;
  inDiff: boolean;
  annotations: PatchAnnotationProps;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const thread = code.placed;
  const resolved = thread.resolved === true;
  const comments = thread.entries.length;
  const fileLevel = <FileLevelComments path={code.key} threads={[thread]} composing={false} onSubmit={annotations.onSubmitComposer} onCancel={annotations.onCancelComposer} />;
  const what = resolved ? "resolved" : "outdated";
  return (
    <section {...stopProps(threadKey(thread), stopRef, focused)} className={cn("min-w-0 overflow-hidden rounded-md border border-border", folded && "bg-muted/20", focused && CURSOR_RING)}>
      <div className={cn("flex flex-wrap items-center gap-2 bg-muted/40 px-2 py-1 text-xs", !folded && "border-b border-border")}>
        <button type="button" className={cn("flex min-w-0 items-baseline gap-2 text-left hover:underline", PRESS)} title="Open in the files view (gf)" onClick={onOpen}>
          <code className="min-w-0 truncate">{code.path}</code>
        </button>
        {thread.outdated ? (
          <Badge tone="warning" title="A later push changed the lines this was left on; the code shown is as it was then">
            Outdated
          </Badge>
        ) : !inDiff ? (
          <Badge title="This file is no longer in the diff">not in the diff</Badge>
        ) : null}
        {resolved ? <Badge tone="success">Resolved</Badge> : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {resolved ? `This conversation was marked as resolved${resolvedBy === null ? "" : ` by ${resolvedBy}`}` : null}
          {folded ? `${resolved ? " · " : ""}${comments} comment${comments === 1 ? "" : "s"}` : null}
        </span>
        {resolved || thread.outdated ? (
          <button type="button" aria-expanded={!folded} className={cn("shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)} title="Enter or za" onClick={onToggle}>
            {folded ? `Show ${what}` : `Hide ${what}`}
          </button>
        ) : null}
      </div>
      {folded ? null : code.patch !== null ? (
        <DiffErrorBoundary
          fallback={
            <>
              <NoRows path={code.key} />
              {fileLevel}
            </>
          }
        >
          <AnnotatedPatch key={code.key} {...annotations} path={code.key} patch={code.patch} hunkSeparators="simple" />
        </DiffErrorBoundary>
      ) : (
        fileLevel
      )}
    </section>
  );
}

function CommitRows({
  commits,
  meta,
  stopRef,
  focusedKey,
  repo,
  onOpen,
  now,
}: {
  commits: ConversationCommit[];
  meta: ConversationData["commits"];
  stopRef: StopRef;
  focusedKey: string | null;
  repo: string | null;
  onOpen: (commit: ConversationCommit) => void;
  now: number;
}) {
  const authors = [...new Set(commits.map(({ commit }) => commit.author))];
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <p className="py-0.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{authors.join(", ")}</span> added {commits.length === 1 ? "a commit" : `${commits.length} commits`}
      </p>
      {commits.map((entry) => {
        const key = commitKey(entry.commit);
        const focused = key === focusedKey;
        return (
          <div key={key} {...stopProps(key, stopRef, focused)} className={cn("group/commit flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-state-hover", focused && CURSOR_RING)}>
            <Icon name="diff-view-commit" className="size-3.5 shrink-0 text-muted-foreground" />
            <button type="button" className={cn("min-w-0 flex-1 truncate text-left hover:underline", PRESS)} title="Show this commit's changes (Enter)" onClick={() => onOpen(entry)}>
              {entry.commit.summary}
            </button>
            <span className="hidden shrink-0 text-muted-foreground sm:inline">
              <When at={entry.commit.date} now={now} />
            </span>
            {meta[entry.commit.sha]?.verified === true ? (
              <Badge tone="success" title="Signed with a verified signature">
                Verified
              </Badge>
            ) : null}
            {meta[entry.commit.sha]?.checks != null ? <CheckMark outcome={meta[entry.commit.sha]!.checks!} /> : null}
            {repo !== null ? (
              <ExternalLink href={githubCommitUrl(repo, entry.commit.sha)} title="Open on GitHub (gx)" className="shrink-0 font-mono text-muted-foreground hover:text-foreground">
                {shortSha(entry.commit.sha)}
              </ExternalLink>
            ) : (
              <code className="shrink-0 text-muted-foreground">{shortSha(entry.commit.sha)}</code>
            )}
          </div>
        );
      })}
    </div>
  );
}

const ACTION: Record<PullRequestAction, { icon: string; text: (detail: string | null) => string }> = {
  merged: { icon: "diff-view-merge", text: (detail) => (detail === null ? "merged this pull request" : `merged commit ${shortSha(detail)}`) },
  closed: { icon: "diff-view-circle-x", text: () => "closed this pull request" },
  reopened: { icon: "GitPullRequest", text: () => "reopened this pull request" },
  "force-pushed": { icon: "diff-view-refresh", text: (detail) => (detail === null ? "force-pushed the branch" : `force-pushed the branch from ${detail}`) },
  "ready-for-review": { icon: "diff-view-eye", text: () => "marked this pull request ready for review" },
  "converted-to-draft": { icon: "GitPullRequest", text: () => "marked this pull request as a draft" },
  "review-requested": { icon: "diff-view-eye", text: (detail) => (detail === null ? "requested a review" : `requested a review from ${detail}`) },
  "review-request-removed": { icon: "diff-view-eye", text: (detail) => (detail === null ? "removed a review request" : `removed the review request for ${detail}`) },
  "review-dismissed": { icon: "diff-view-circle-x", text: (detail) => (detail === null ? "dismissed a review" : `dismissed a review: ${detail}`) },
  renamed: { icon: "diff-view-pencil", text: (detail) => (detail === null ? "changed the title" : `changed the title to ${detail}`) },
  "branch-deleted": { icon: "diff-view-commit", text: () => "deleted the branch" },
  "branch-restored": { icon: "diff-view-commit", text: () => "restored the branch" },
  "base-changed": { icon: "diff-view-commit", text: (detail) => (detail === null ? "changed the base branch" : `changed the base branch from ${detail}`) },
  labeled: { icon: "diff-view-pencil", text: () => "added the label" },
  unlabeled: { icon: "diff-view-pencil", text: () => "removed the label" },
  assigned: { icon: "diff-view-eye", text: (detail) => (detail === null ? "was assigned" : `assigned ${detail}`) },
  unassigned: { icon: "diff-view-eye", text: (detail) => (detail === null ? "was unassigned" : `unassigned ${detail}`) },
  milestoned: { icon: "diff-view-pencil", text: (detail) => `added this to the ${detail ?? ""} milestone` },
  demilestoned: { icon: "diff-view-pencil", text: (detail) => `removed this from the ${detail ?? ""} milestone` },
  "auto-merge-enabled": { icon: "diff-view-merge", text: () => "enabled auto-merge" },
  "auto-merge-disabled": { icon: "diff-view-merge", text: () => "disabled auto-merge" },
  "cross-referenced": { icon: "GitPullRequest", text: (detail) => (detail === null ? "mentioned this pull request" : `mentioned this pull request in ${detail}`) },
};

function ActionRow({ event, stopRef, focused, now }: { event: Extract<ConversationEvent, { kind: "action" }>; stopRef: StopRef; focused: boolean; now: number }) {
  const action = ACTION[event.action];
  return (
    <p {...stopProps(`action:${event.id}`, stopRef, focused)} className={cn("min-w-0 flex-1 rounded px-1 py-1 text-xs text-muted-foreground", focused && CURSOR_RING)}>
      <span className="font-medium text-foreground">{event.actor}</span> {event.action === "labeled" || event.action === "unlabeled" ? action.text(null) : action.text(event.detail)}{" "}
      {(event.action === "labeled" || event.action === "unlabeled") && event.detail !== null ? (
        <>
          <LabelChip name={event.detail} color={event.color ?? ""} />{" "}
        </>
      ) : null}
      <When at={event.createdAt} now={now} />
      {event.url != null ? (
        <>
          {" "}
          <ExternalLink href={event.url} title="Open on GitHub (gx)" className="hover:text-foreground">
            <Icon name="ExternalLink" className="inline size-3" />
          </ExternalLink>
        </>
      ) : null}
    </p>
  );
}

function ItemRow({ marker, children }: { marker: ReactNode; children: ReactNode }) {
  return (
    <li className="relative flex min-w-0 items-start gap-3 py-1.5">
      {marker}
      {children}
    </li>
  );
}

/**
 * The pull request as GitHub's Conversation tab reads: the description, then commits, comments, reviews (each with the
 * threads submitted in it, over their code) and changes to the pull request, oldest first, on one rule. Threads draw
 * as they do in the files view, so the same keys act on them; each may sit on a display line (an outdated one's
 * original line), so replies and resolves go to the thread itself, found by id.
 */
export function ConversationView({
  items,
  data,
  originals,
  error,
  focusedKey,
  folded,
  scrollRef,
  stopRef,
  repo,
  codeOf,
  inDiff,
  annotationsFor,
  onToggle,
  onOpenCommit,
  onOpenThread,
  writing,
}: {
  items: readonly ConversationItem[];
  data: ConversationData | null;
  originals: ReadonlyMap<string, DiffThread>;
  error: string | null;
  focusedKey: string | null;
  folded: ReadonlySet<string>;
  scrollRef: RefObject<HTMLDivElement | null>;
  stopRef: StopRef;
  repo: string | null;
  codeOf: (thread: DiffThread) => ThreadCode;
  inDiff: (path: string) => boolean;
  annotationsFor: (code: ThreadCode) => PatchAnnotationProps;
  onToggle: (key: string) => void;
  onOpenCommit: (commit: ConversationCommit) => void;
  onOpenThread: (thread: DiffThread) => void;
  writing: ConversationWriting | null;
}) {
  const actions = useContext(DiffCommentsContext);
  const scoped = useMemo<DiffCommentActions>(() => {
    const original = (thread: DiffThread) => originals.get(thread.id) ?? thread;
    return { ...actions, onReply: (thread, body, target) => actions.onReply(original(thread), body, target), onResolve: (thread, resolved) => actions.onResolve(original(thread), resolved) };
  }, [actions, originals]);
  const now = useNow();
  const metaOf = (id: string) => data?.comments[id] ?? null;
  const prAuthor = data?.pullRequest?.author ?? null;
  const editingOf = (key: string) => (writing !== null && writing.editingKey === key ? { save: (body: string) => writing.save(key, body), cancel: writing.cancelEdit } : null);
  const metaContext = useMemo(
    () => ({ meta: data?.comments ?? NO_META, react: writing?.react ?? null, pick: writing?.pickReaction ?? null }),
    [data, writing?.react, writing?.pickReaction],
  );
  const thread = (entry: DiffThread) => {
    const code = codeOf(entry);
    const key = threadKey(entry);
    const isFolded = folded.has(key) !== threadStartsFolded(entry);
    return (
      <ThreadBlock
        key={entry.id}
        code={code}
        stopRef={stopRef}
        // Open, the thread's own card shows the cursor.
        focused={isFolded && focusedKey === key}
        folded={isFolded}
        resolvedBy={data?.threads[entry.id]?.resolvedBy ?? null}
        inDiff={inDiff(entry.path)}
        annotations={annotationsFor(code)}
        onToggle={() => onToggle(key)}
        onOpen={() => onOpenThread(entry)}
      />
    );
  };
  const review = (key: string, entry: ConversationReview, threads: DiffThread[]) => {
    const verdict = VERDICT[entry.state];
    const focused = key === focusedKey;
    const addressed = entry.addressedAt !== null ? <Badge tone="success">addressed</Badge> : null;
    return (
      <ItemRow key={key} marker={<Marker icon={verdict.icon} className={verdict.tone} />}>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {entry.body.trim() === "" ? (
            <p {...stopProps(key, stopRef, focused)} className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 rounded px-1 py-1 text-xs text-muted-foreground", focused && CURSOR_RING)}>
              <span className="font-medium text-foreground">{entry.author}</span>
              {verdict.text}
              <When at={entry.createdAt} now={now} />
              {entry.url !== null ? (
                <ExternalLink href={entry.url} title="Open on GitHub (gx)" className="hover:text-foreground">
                  <Icon name="ExternalLink" className="size-3" />
                </ExternalLink>
              ) : null}
            </p>
          ) : (
            <CommentCard
              stopKey={key}
              stopRef={stopRef}
              focused={focused}
              author={entry.author}
              verb={verdict.text}
              at={entry.createdAt}
              url={entry.url}
              mine={entry.mine}
              badges={addressed}
              meta={metaOf(key)}
              isAuthor={entry.author === prAuthor}
              body={entry.body}
              folded={folded.has(key)}
              onToggle={() => onToggle(key)}
              editing={editingOf(key)}
              now={now}
            />
          )}
          {threads.length > 0 ? <div className="flex flex-col gap-2">{threads.map(thread)}</div> : null}
        </div>
      </ItemRow>
    );
  };
  const render = (item: ConversationItem) => {
    switch (item.kind) {
      case "opened":
        return (
          <ItemRow key={item.key} marker={<Marker icon="GitPullRequest" />}>
            <CommentCard
              stopKey={item.key}
              stopRef={stopRef}
              focused={item.key === focusedKey}
              author={item.event.author}
              verb="opened this pull request"
              at={item.event.createdAt}
              url={item.event.url}
              mine={false}
              meta={metaOf(item.event.id)}
              isAuthor
              body={item.event.body}
              folded={folded.has(item.key)}
              onToggle={() => onToggle(item.key)}
              editing={editingOf(item.key)}
              now={now}
            />
          </ItemRow>
        );
      case "comment":
        return (
          <ItemRow key={item.key} marker={<Marker icon="MessageSquare" />}>
            <CommentCard
              stopKey={item.key}
              stopRef={stopRef}
              focused={item.key === focusedKey}
              author={item.comment.author}
              verb="commented"
              at={item.comment.createdAt}
              url={item.comment.url}
              mine={item.comment.mine}
              badges={item.comment.addressedAt !== null ? <Badge tone="success">addressed</Badge> : null}
              meta={metaOf(item.comment.id)}
              isAuthor={item.comment.author === prAuthor}
              body={item.comment.body}
              folded={folded.has(item.key)}
              onToggle={() => onToggle(item.key)}
              editing={editingOf(item.key)}
              now={now}
            />
          </ItemRow>
        );
      case "review":
        return review(item.key, item.review, item.threads);
      case "thread":
        return (
          <ItemRow key={item.key} marker={<Marker icon="MessageSquare" />}>
            <div className="min-w-0 flex-1">{thread(item.thread)}</div>
          </ItemRow>
        );
      case "commits":
        return (
          <ItemRow key={item.key} marker={<Marker icon="diff-view-commit" />}>
            <CommitRows commits={item.commits} meta={data?.commits ?? {}} stopRef={stopRef} focusedKey={focusedKey} repo={repo} onOpen={onOpenCommit} now={now} />
          </ItemRow>
        );
      case "action":
        return (
          <ItemRow key={item.key} marker={<Marker icon={ACTION[item.event.action].icon} />}>
            <ActionRow event={item.event} stopRef={stopRef} focused={item.key === focusedKey} now={now} />
          </ItemRow>
        );
    }
  };
  return (
    <DiffCommentsContext.Provider value={scoped}>
      <CommentMetaContext.Provider value={metaContext}>
      <ThreadStartsOpenContext.Provider value>
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex max-w-5xl flex-col gap-2 px-4 py-3", enter.fade, FAST)}>
          {error !== null ? <p className="text-xs text-destructive">Could not read the pull request's reviews and events: {error}</p> : null}
          {data?.pullRequest != null ? <PullRequestHeader pr={data.pullRequest} stopRef={stopRef} focusedKey={focusedKey} /> : null}
          {items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing here yet: no commits, comments or reviews.</p> : null}
          {/* The rule runs behind the markers, down the middle of their column. */}
          <ol className="relative flex flex-col before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:-translate-x-1/2 before:bg-border">{items.map(render)}</ol>
          {data?.pullRequest != null ? <PullRequestStatus pr={data.pullRequest} stopRef={stopRef} focusedKey={focusedKey} /> : null}
          {writing !== null ? <Composer writing={writing} /> : null}
        </div>
      </div>
      </ThreadStartsOpenContext.Provider>
      </CommentMetaContext.Provider>
    </DiffCommentsContext.Provider>
  );
}
