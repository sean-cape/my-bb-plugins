// bb-plugin-diff-view — frontend entry.
//
// A Changes button in every thread's top bar opens the thread's diff in its side panel. The view itself lives in
// lib/app so other plugins can bundle and embed it with their own data source.
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import "bb-motion/motion.css";
import { POP, cx, enter, speed } from "bb-motion";
import { DIFF_CHANGED } from "./events";
import type { rpcContract } from "./server";
import { DiffDisplayControls, DiffRefreshButton, DiffView, type DiffSource, type DiffViewLabels, type PendingComments } from "./lib/app/diff-view";
import { registerDiffViewIcons } from "./lib/app/icons";
import { errorMessage } from "./lib/app/format";
import { requestFocus } from "./lib/app/state";
import { Button, COMPACT } from "./lib/app/ui/button";
import { cn } from "./lib/app/utils";

const PANEL_ACTION_ID = "changes";

function instanceKey(threadId: string): string {
  return `thread:${threadId}`;
}

function useThreadDiffSource(threadId: string): DiffSource {
  const rpc = useRpc<typeof rpcContract>();
  return useMemo<DiffSource>(
    () => ({
      getDiff: (refresh) => rpc.call("diff_get", { threadId, refresh }),
      getStructural: (path) => rpc.call("diff_structural", { threadId, path }),
      symbolDefinitions: (symbol) => rpc.call("symbol_definitions", { threadId, symbol }),
      symbolUsages: (symbol) => rpc.call("symbol_usages", { threadId, symbol }),
      peekFile: (path, startLine, endLine) => rpc.call("symbol_peek_file", { threadId, path, startLine, endLine }),
      listViewed: async () => (await rpc.call("diff_viewed_list", { threadId })).paths,
      setViewed: async (path, viewed) => (await rpc.call("diff_viewed_set", { threadId, path, viewed })).paths,
      listComments: async () => (await rpc.call("diff_comments_list", { threadId })).comments,
      addComment: async ({ path, line, side, startLine, startSide, body, inReplyTo }) => {
        await rpc.call("diff_comment_add", { threadId, path, line, side, startLine, startSide, body, inReplyTo });
      },
      updateComment: async (id, { body }) => {
        if (body !== undefined) await rpc.call("diff_comment_update", { id, body });
      },
      deleteComment: async (id) => {
        await rpc.call("diff_comment_delete", { id });
      },
    }),
    [rpc, threadId],
  );
}

/** Counts this plugin's realtime changes for one thread, so the view refetches its comments. */
function useThreadChangeSignal(threadId: string): number {
  const [signal, setSignal] = useState(0);
  useRealtime(DIFF_CHANGED, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) setSignal((value) => value + 1);
  });
  return signal;
}

function SendToThreadBar({ threadId, pending }: { threadId: string; pending: PendingComments }) {
  const rpc = useRpc<typeof rpcContract>();
  const [sending, setSending] = useState(false);
  const count = pending.local.length;
  const send = async () => {
    setSending(true);
    try {
      const { sent } = await rpc.call("diff_comments_send", { threadId });
      toast.success(`Sent ${sent} comment${sent === 1 ? "" : "s"} to the thread`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSending(false);
      pending.reload();
    }
  };
  return (
    <div className={cx("flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-muted/30 px-3 py-2", enter.drop, speed.fast)}>
      <span className="text-sm">
        <span key={count} className={cx("inline-block font-medium tabular-nums", POP)}>{count}</span> comment{count === 1 ? "" : "s"} not sent yet
      </span>
      <span title="Send them to this thread's agent as one message">
        <Button type="button" className={COMPACT} disabled={sending} onClick={() => void send()}>
          <Icon name="diff-view-wrench" className="size-3.5" />
          Send {count} to the thread
        </Button>
      </span>
    </div>
  );
}

const THREAD_LABELS: Partial<DiffViewLabels> = {
  localTarget: "Kept here until you send it to the thread",
  localHint: "Stays here until you send it to the thread",
  noCheckout: "This thread has no local checkout.",
};

function ThreadChanges({ threadId, toolbar }: { threadId: string; toolbar?: ReactNode }) {
  const navigate = useBbNavigate();
  const source = useThreadDiffSource(threadId);
  const signal = useThreadChangeSignal(threadId);
  return (
    <DiffView
      source={source}
      instanceKey={instanceKey(threadId)}
      onOpenThread={(id) => navigate.toThread(id)}
      refreshSignal={signal}
      renderSubmitBar={(pending) => <SendToThreadBar threadId={threadId} pending={pending} />}
      labels={THREAD_LABELS}
      toolbar={toolbar}
    />
  );
}

/** The side-panel tab: the view with its own toolbar, since a panel tab has no title bar to put one in. */
function ThreadChangesPanel({ threadId }: PluginThreadPanelProps) {
  return (
    <ThreadChanges
      threadId={threadId}
      toolbar={
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
          <DiffDisplayControls />
          <span className="ml-auto">
            <DiffRefreshButton instanceKey={instanceKey(threadId)} />
          </span>
        </div>
      }
    />
  );
}

const TOTALS_REFRESH_DELAY_MS = 2_000;

interface ChangeTotals {
  files: number;
  additions: number;
  deletions: number;
}

const NO_CHANGES: ChangeTotals = { files: 0, additions: 0, deletions: 0 };

/** A thread's change totals as bb's changes panel counts them, refetched shortly after the thread updates. */
function useThreadChangeTotals(threadId: string): ChangeTotals | null {
  const sdk = useSdk();
  const { threads } = useSidebarThreads();
  const thread = threads.find((entry) => entry.id === threadId);
  const environmentId = thread?.environment?.id ?? null;
  const updatedAt = thread?.updatedAt ?? null;
  const [totals, setTotals] = useState<({ threadId: string } & ChangeTotals) | null>(null);
  useEffect(() => {
    if (environmentId === null) {
      setTotals({ threadId, ...NO_CHANGES });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        // The same status bb's own changes panel reads: uncommitted files (untracked too) plus the branch's commits
        // since its merge base.
        sdk.environments.status({ environmentId }).then(
          (status) => {
            if (cancelled) return;
            if (status.outcome !== "available") {
              setTotals({ threadId, ...NO_CHANGES });
              return;
            }
            const byPath = new Map<string, { insertions: number | null; deletions: number | null }>();
            for (const file of status.workspace.mergeBase?.files ?? []) byPath.set(file.path, file);
            for (const file of status.workspace.workingTree.files) byPath.set(file.path, file);
            const files = [...byPath.values()];
            setTotals({
              threadId,
              files: files.length,
              additions: files.reduce((sum, file) => sum + (file.insertions ?? 0), 0),
              deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
            });
          },
          () => {
            if (!cancelled) setTotals({ threadId, ...NO_CHANGES });
          },
        );
      },
      totals?.threadId === threadId ? TOTALS_REFRESH_DELAY_MS : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // totals is read only to skip the delay on a thread switch.
  }, [environmentId, sdk, threadId, updatedAt]);
  return totals !== null && totals.threadId === threadId ? totals : null;
}

/** Thread top-bar button: always present, muted and disabled while the thread has nothing to diff; opens the side panel. */
function ChangesButton({ threadId }: { threadId: string; projectId: string; isCompactViewport: boolean }) {
  const navigate = useBbNavigate();
  const totals = useThreadChangeTotals(threadId);
  const empty = totals === null || totals.files === 0;
  const open = () => {
    if (!navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: "Changes" })) toast.message("Open the side panel to see this thread's changes.");
  };
  return (
    <span className="inline-flex" title={empty ? "Changes: none" : `Changes: +${totals.additions} −${totals.deletions}`}>
      <Button
        type="button"
        variant="ghost"
        className={cn(COMPACT, "px-1.5", empty && "text-muted-foreground")}
        disabled={empty}
        aria-label={empty ? "View this thread's changes: no changes" : `View this thread's changes: ${totals.files} ${totals.files === 1 ? "file" : "files"}, +${totals.additions} −${totals.deletions}`}
        onClick={open}
      >
        <Icon name="diff-view-diff" className="size-3.5" />
      </Button>
    </span>
  );
}

export default definePluginApp((app) => {
  registerDiffViewIcons(app);
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Changes",
    icon: "diff-view-diff",
    layout: "flush",
    component: ThreadChangesPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "changes",
    title: "Changes",
    component: ChangesButton,
  });
  app.commands.register({
    id: "review-with-keyboard",
    title: "Changes: review with the keyboard",
    defaultShortcut: { key: "d", mod: true, shift: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId, openPanel }) => {
      if (threadId === null) return;
      if (!openPanel({ actionId: PANEL_ACTION_ID, title: "Changes" })) {
        toast.message("Open the side panel to see this thread's changes.");
        return;
      }
      requestFocus(instanceKey(threadId));
    },
  });
});
