import { useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { CallResult } from "../contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Tab = "response" | "headers" | "trailers" | "sent";

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Pretty-printed JSON with keys, strings, numbers and literals coloured. */
function JsonView({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const [token, string, colon, literal, number] = match;
    if (string !== undefined && colon !== undefined) {
      parts.push(
        <span key={index} className="text-sky-700 dark:text-sky-300">
          {string}
        </span>,
        colon,
      );
    } else if (string !== undefined) {
      parts.push(
        <span key={index} className="text-emerald-700 dark:text-emerald-300">
          {string}
        </span>,
      );
    } else if (literal !== undefined) {
      parts.push(
        <span key={index} className="text-violet-700 dark:text-violet-300">
          {literal}
        </span>,
      );
    } else if (number !== undefined) {
      parts.push(
        <span key={index} className="text-amber-700 dark:text-amber-300">
          {number}
        </span>,
      );
    } else {
      parts.push(token);
    }
    last = index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-foreground">{parts}</pre>;
}

function MetadataTable({ entries, empty }: { entries: [string, string][]; empty: string }) {
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <dl className="divide-y divide-border rounded-lg border border-border text-sm">
      {entries.map(([name, value], index) => (
        <div key={`${name}-${index}`} className="grid grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)] gap-3 px-3 py-2">
          <dt className="truncate font-mono text-[13px] text-muted-foreground" title={name}>
            {name}
          </dt>
          <dd className="break-all font-mono text-[13px] text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success("Copied"),
    () => toast.error("Could not copy to the clipboard"),
  );
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function formatSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function ResponseView({ result, recordedAt, sending }: { result: CallResult | null; recordedAt: number | null; sending: boolean }) {
  const [tab, setTab] = useState<Tab>("response");
  if (result === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        {sending ? (
          <>
            <Icon name="Spinner" className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Calling…</p>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">The response appears here.</p>
            <p className="text-xs text-muted-foreground/80">Send with ⌘↵ / Ctrl↵</p>
          </>
        )}
      </div>
    );
  }
  const body = result.responses.map((response) => (typeof response === "string" ? response : JSON.stringify(response, null, 2))).join("\n\n");
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "response", label: result.responses.length > 1 ? `Messages` : "Body", count: result.responses.length > 1 ? result.responses.length : undefined },
    { id: "headers", label: "Headers", count: result.headers.length || undefined },
    { id: "trailers", label: "Trailers", count: result.trailers.length || undefined },
    { id: "sent", label: "Sent", count: result.requestMetadata.length || undefined },
  ];
  const statusLabel = result.ok ? "OK" : result.error !== null ? "Failed" : result.status.name;
  return (
    <div className={cn("flex h-full min-h-0 flex-col transition-opacity", sending && "opacity-50")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2.5 text-sm">
          <span
            className={cn(
              "rounded-md px-2 py-0.5 font-mono text-xs font-semibold",
              result.ok ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-destructive/15 text-destructive",
            )}
          >
            {result.ok || result.error !== null ? statusLabel : `${result.status.code} ${statusLabel}`}
          </span>
          <span className="tabular-nums text-muted-foreground">{formatDuration(result.durationMs)}</span>
          {body !== "" ? <span className="tabular-nums text-muted-foreground">{formatSize(body)}</span> : null}
          {recordedAt !== null ? (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={new Date(recordedAt).toLocaleString()}>
              from history · {new Date(recordedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-1" role="tablist">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={cn(
                "rounded-md px-2.5 py-1 text-sm",
                tab === entry.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
              )}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
              {entry.count !== undefined ? <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{entry.count}</span> : null}
            </button>
          ))}
          {body !== "" ? (
            <button
              type="button"
              className="ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground"
              aria-label="Copy response"
              title="Copy response"
              onClick={() => copy(body)}
            >
              <Icon name="Copy" className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {tab === "response" ? (
          <div className="space-y-3">
            {!result.ok ? (
              <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <p className="whitespace-pre-wrap break-words text-sm text-destructive">{result.error ?? (result.status.message || result.status.name)}</p>
                {result.status.details.length > 0 ? <JsonView text={JSON.stringify(result.status.details, null, 2)} /> : null}
                {result.stderr && result.stderr !== result.error ? (
                  <pre className="whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{result.stderr}</pre>
                ) : null}
              </div>
            ) : null}
            {body !== "" ? <JsonView text={body} /> : result.ok ? <p className="text-sm text-muted-foreground">No response messages.</p> : null}
          </div>
        ) : null}
        {tab === "headers" ? <MetadataTable entries={result.headers} empty="No response headers." /> : null}
        {tab === "trailers" ? <MetadataTable entries={result.trailers} empty="No trailers." /> : null}
        {tab === "sent" ? <MetadataTable entries={result.requestMetadata} empty="No request metadata was sent." /> : null}
      </div>
    </div>
  );
}
