import { useCallback, useEffect, useState, type ReactNode } from "react";
import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { FileEntry } from "../contract";
import { localTime } from "../shared/daily";
import { noteTitle } from "../shared/obsidian";
import { CaptureInput, openToday, startRoutine } from "./capture";
import { errorMessage, useOpenNote, useVaultChanges } from "./state";
import type { Vault } from "./vault-actions";
import type { PluginRpcResult } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../server";

type DashboardData = PluginRpcResult<(typeof rpcContract)["dashboard"]>;

const ACTIVITY_REFRESH_MS = 60_000;

/** Shows wikilinks as their label; the dashboard lists text, not rendered markdown. */
function plain(text: string): string {
  return text.replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) => alias ?? target).replace(/\*\*([^*]+)\*\*/g, "$1");
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        {count === undefined ? null : <span className="ml-1.5 normal-case tracking-normal">· {count}</span>}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">{children}</p>;
}

export function Dashboard({ vault, recent }: { vault: Vault; recent: readonly FileEntry[] }) {
  const { rpc, status } = vault;
  const openNote = useOpenNote();
  const navigate = useBbNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    rpc.call("dashboard").then(
      (next) => {
        setData(next);
        setError(null);
      },
      (cause) => setError(errorMessage(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, ACTIVITY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  useVaultChanges(() => refresh());

  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const activeTickets = data?.tickets.filter((ticket) => !ticket.done) ?? [];
  const doneTickets = (data?.tickets.length ?? 0) - activeTickets.length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 pb-16 pt-10">
        <p className="text-sm text-muted-foreground">{status?.vaultName}</p>
        <h2 className="text-xl font-semibold">{dateLabel}</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void openToday()}>
            {data?.today.exists === false ? "Create today's note" : "Open today's note"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void startRoutine("start")}>
            Start day
          </Button>
          <Button size="sm" variant="outline" onClick={() => void startRoutine("wrap")}>
            Wrap up day
          </Button>
        </div>
        <CaptureInput className="ob-capture-dashboard mt-4" />
        <p className="mt-1.5 text-xs text-muted-foreground">
          <kbd>⌘⇧L</kbd> logs from anywhere in bb · “Save to today's daily note” on any chat message · <code>bb obsidian log</code> from agents
        </p>
        {error === null ? null : <p className="mt-4 text-sm text-destructive">{error}</p>}

        <Section title="Today's inbox" count={data?.today.inbox.length}>
          {data === null ? (
            <Empty>Loading…</Empty>
          ) : data.today.inbox.length === 0 ? (
            <Empty>Nothing captured yet today.</Empty>
          ) : (
            <ul className="space-y-1 text-sm">
              {data.today.inbox.map((line, index) => (
                <li key={index} className="ob-dash-row whitespace-pre-wrap">
                  {plain(line)}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {data !== null && data.carryForward.items.length > 0 ? (
          <Section title="Carried forward" count={data.carryForward.items.length}>
            <ul className="space-y-1 text-sm">
              {data.carryForward.items.map((item, index) => (
                <li key={index} className="ob-dash-row">
                  ☐ {plain(item)}
                </li>
              ))}
            </ul>
            {data.carryForward.path === null ? null : (
              <button type="button" className="ob-link mt-1.5 text-xs" onClick={() => openNote(data.carryForward.path!)}>
                from {noteTitle(data.carryForward.path)}
              </button>
            )}
          </Section>
        ) : null}

        <Section title="bb threads today" count={data?.activity.length}>
          {data === null || data.activity.length === 0 ? (
            <Empty>No bb thread activity recorded yet today. Threads show up here when they finish a turn.</Empty>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {data.activity.map((item) => (
                <li key={item.threadId}>
                  <button type="button" className="ob-recent-row flex-col !items-start" onClick={() => navigate.toThread(item.threadId)}>
                    <span className="flex w-full items-center justify-between gap-3">
                      <span className="truncate font-medium">{item.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {item.projectName} · {localTime(new Date(item.firstAt))}–{localTime(new Date(item.lastAt))}
                      </span>
                    </span>
                    {item.lastText === "" ? null : <span className="line-clamp-2 text-xs text-muted-foreground">{item.lastText}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Active tickets" count={activeTickets.length}>
          {activeTickets.length === 0 ? (
            <Empty>No open ticket notes. The daily-note routines create one in Tickets/ when you start on a Jira ticket.</Empty>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {activeTickets.map((ticket) => (
                <li key={ticket.path} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <button type="button" className="ob-link shrink-0 font-medium" onClick={() => openNote(ticket.path)}>
                    {ticket.key}
                  </button>
                  <span className="min-w-0 flex-1 truncate">{ticket.summary}</span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{ticket.status || "—"}</span>
                  {ticket.url === null ? null : (
                    <UrlLink href={ticket.url} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
                      Jira
                    </UrlLink>
                  )}
                </li>
              ))}
            </ul>
          )}
          {doneTickets > 0 ? <p className="mt-1.5 text-xs text-muted-foreground">{doneTickets} closed ticket notes not shown.</p> : null}
        </Section>

        <Section title="Recently edited">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {recent.map((file) => (
              <li key={file.path}>
                <button type="button" className="ob-recent-row" onClick={() => openNote(file.path)}>
                  <span className="truncate">{noteTitle(file.path)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{new Date(file.mtimeMs).toLocaleDateString()}</span>
                </button>
              </li>
            ))}
            {recent.length === 0 ? <li className="px-3 py-2 text-sm text-muted-foreground">No notes yet.</li> : null}
          </ul>
        </Section>
      </div>
    </div>
  );
}
