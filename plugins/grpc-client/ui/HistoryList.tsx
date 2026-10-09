import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { cx, enter, PRESS, REVEAL, REVEAL_HOST, speed, EntranceScope, usePresenceList } from "bb-motion";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { HistoryEntry, rpcContract } from "../server/rpc-contract";
import { CHANGED_CHANNEL, errorMessage } from "../shared/common";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "./controls";
import { PresenceRow } from "./presence";

const HISTORY_LIST_LIMIT = 200;

function formatWhen(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function HistoryList({ selectedId, onOpen }: { selectedId: number | null; onOpen: (entry: HistoryEntry) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const refetch = useCallback(() => {
    rpc.call("history", { limit: HISTORY_LIST_LIMIT }).then(
      (result) => setEntries(result.entries),
      () => setEntries([]),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED_CHANNEL, refetch);
  const remove = (id: number) => {
    setEntries((current) => current?.filter((entry) => entry.id !== id) ?? null);
    rpc.call("deleteHistory", { ids: [id] }).then(refetch, (cause) => {
      toast.error(errorMessage(cause));
      refetch();
    });
  };
  const presence = usePresenceList(entries ?? [], (entry) => String(entry.id));
  if (entries === null) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (presence.entries.length === 0) return <p className={cx("p-4 text-sm text-muted-foreground", enter.fade)}>Calls you make here or with `bb grpc call` appear here.</p>;
  return (
    <EntranceScope>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="flex items-center justify-between px-2 pb-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recent calls</p>
          {confirmClear ? (
            <span className={cx("flex items-center gap-1 text-xs", enter.fade, speed.fast)}>
              <button
                type="button"
                className={cx("rounded px-1.5 py-0.5 text-destructive hover:bg-destructive/10", PRESS)}
                onClick={() => {
                  setConfirmClear(false);
                  rpc.call("clearHistory").then(refetch, (cause) => toast.error(errorMessage(cause)));
                }}
              >
                Delete all
              </button>
              <button type="button" className={cx("rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground", PRESS)} onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className={cx("text-xs text-muted-foreground hover:text-foreground", enter.fade, speed.fast, PRESS)} onClick={() => setConfirmClear(true)}>
              Clear
            </button>
          )}
        </div>
        {presence.entries.map(({ key, item: entry, exiting }, index) => (
          <PresenceRow
            key={key}
            className={cn("flex items-start rounded-md hover:bg-state-hover", REVEAL_HOST, entry.id === selectedId && "bg-state-active")}
            cascadeIndex={index}
            exiting={exiting}
            onExited={() => presence.onExited(key)}
          >
            <button
              type="button"
              className={cn("flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-2 text-left", FOCUS_RING)}
              title={entry.message || entry.method}
              aria-current={entry.id === selectedId ? "true" : undefined}
              data-nav-row={exiting ? undefined : "item"}
              data-nav-key={`history:${entry.id}`}
              onClick={() => onOpen(entry)}
            >
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <span className={cn("size-2 shrink-0 rounded-full", entry.ok ? "bg-emerald-500" : "bg-destructive")} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-foreground">{entry.method.slice(entry.method.lastIndexOf("/") + 1)}</span>
                <span className={cn("shrink-0 text-xs", entry.ok ? "text-muted-foreground" : "text-destructive")}>{entry.status}</span>
              </span>
              <span className="truncate pl-4 text-xs text-muted-foreground">
                {entry.endpoint} · {formatWhen(entry.at)} · {entry.durationMs} ms
                {entry.origin === "cli" ? " · CLI" : ""}
              </span>
            </button>
            <button
              type="button"
              className={cx("mr-1 mt-2 shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground", REVEAL)}
              aria-label={`Delete ${entry.method} from history`}
              title="Delete from history"
              onClick={() => remove(entry.id)}
            >
              <Icon name="Trash2" className="size-3.5" />
            </button>
          </PresenceRow>
        ))}
      </div>
    </EntranceScope>
  );
}
