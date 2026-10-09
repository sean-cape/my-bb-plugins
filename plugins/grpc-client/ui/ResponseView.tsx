import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { toast } from "sonner";
import { cx, enter, NUDGE, OPACITY_TRANSITION, PRESS, speed, stagger, STAGGER, useFlag } from "bb-motion";
import type { CallResult } from "../contract";
import { formatResponse } from "../shared/common";
import { FOCUS_RING } from "./controls";
import { useTextSearch } from "./text-search";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type ResponseTab = "response" | "headers" | "trailers" | "sent";

export const RESPONSE_TABS: readonly ResponseTab[] = ["response", "headers", "trailers", "sent"];

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

const COPIED_MS = 1200;

function CopyButton({ text }: { text: string }) {
  const [copied, flagCopied] = useFlag(COPIED_MS);
  return (
    <>
      <button
        type="button"
        className={cx("ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)}
        aria-label="Copy response"
        title="Copy response"
        onClick={() => navigator.clipboard.writeText(text).then(flagCopied, () => toast.error("Could not copy to the clipboard"))}
      >
        {copied ? (
          <span key="copied" className={cx("flex", enter.pop)}>
            <Icon name="Check" className="size-4 text-emerald-600 dark:text-emerald-400" />
          </span>
        ) : (
          <span key="copy" className={cx("flex", enter.fade, speed.fast)}>
            <Icon name="Copy" className="size-4" />
          </span>
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

// Identity per result object, so the header and body replay their entrance
// for each new response but not on unrelated re-renders.
const resultIds = new WeakMap<CallResult, number>();
let nextResultId = 0;
function resultId(result: CallResult): number {
  let id = resultIds.get(result);
  if (id === undefined) {
    id = nextResultId++;
    resultIds.set(result, id);
  }
  return id;
}

/**
 * The id of a result that arrived while this view was waiting on it, so only a
 * call that just failed shakes, not a failed result revisited later.
 */
function useArrivedId(id: number | null, sending: boolean): number | null {
  const previous = useRef({ id, sending });
  const [arrived, setArrived] = useState<number | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = { id, sending };
    if (before.sending && !sending && id !== before.id) setArrived(id);
    else if (id !== arrived) setArrived(null);
  }, [id, sending, arrived]);
  return arrived;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function formatSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export interface ResponseSearchHandle {
  /** Opens the search box; false when there is no response to search. */
  startSearch: () => boolean;
  next: (step: 1 | -1) => boolean;
  /** Clears the matches; false when there were none. */
  clear: () => boolean;
}

export function ResponseView({
  result,
  recordedAt,
  sending,
  tab,
  onTab,
  search: searchHandle,
}: {
  result: CallResult | null;
  recordedAt: number | null;
  sending: boolean;
  tab: ResponseTab;
  onTab: (tab: ResponseTab) => void;
  search: RefObject<ResponseSearchHandle | null>;
}) {
  const id = result === null ? null : resultId(result);
  const arrivedId = useArrivedId(id, sending);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scroller = useCallback(() => scrollerRef.current, []);
  const search = useTextSearch(scroller, `${id}:${tab}`);
  useImperativeHandle(searchHandle, () => ({
    startSearch: () => {
      if (result === null) return false;
      search.start();
      return true;
    },
    next: search.next,
    clear: search.clear,
  }));
  const backToPane = () => scrollerRef.current?.focus({ preventScroll: true });
  if (result === null) {
    return (
      <div key={sending ? "sending" : "idle"} className={cx("flex h-full flex-col items-center justify-center gap-2 p-6 text-center", enter.fade)}>
        {sending ? (
          <>
            <Icon name="Spinner" className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Calling…</p>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">The response appears here.</p>
            <p className="text-xs text-muted-foreground/80">Send with ⌘↵ / Ctrl↵ · ? lists the keyboard shortcuts</p>
          </>
        )}
      </div>
    );
  }
  const body = result.responses.map(formatResponse).join("\n\n");
  const tabs: { id: ResponseTab; label: string; count?: number }[] = [
    { id: "response", label: result.responses.length > 1 ? `Messages` : "Body", count: result.responses.length > 1 ? result.responses.length : undefined },
    { id: "headers", label: "Headers", count: result.headers.length || undefined },
    { id: "trailers", label: "Trailers", count: result.trailers.length || undefined },
    { id: "sent", label: "Sent", count: result.requestMetadata.length || undefined },
  ];
  const statusLabel = result.ok ? "OK" : result.error !== null ? "Failed" : result.status.name;
  return (
    <div className={cn("flex h-full min-h-0 flex-col", OPACITY_TRANSITION, sending && "opacity-50")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <div key={id} className="flex items-center gap-2.5 text-sm">
          <span className={cx("flex", enter.pop)}>
            <span
              className={cn(
                "rounded-md px-2 py-0.5 font-mono text-xs font-semibold",
                result.ok ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-destructive/15 text-destructive",
                !result.ok && arrivedId === id && NUDGE,
              )}
            >
              {result.ok || result.error !== null ? statusLabel : `${result.status.code} ${statusLabel}`}
            </span>
          </span>
          <span className={cx("tabular-nums text-muted-foreground", enter.fade, STAGGER)} style={stagger(1)}>
            {formatDuration(result.durationMs)}
          </span>
          {body !== "" ? (
            <span className={cx("tabular-nums text-muted-foreground", enter.fade, STAGGER)} style={stagger(2)}>
              {formatSize(body)}
            </span>
          ) : null}
          {recordedAt !== null ? (
            <span
              className={cx("rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground", enter.fade, STAGGER)}
              style={stagger(3)}
              title={new Date(recordedAt).toLocaleString()}
            >
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
                PRESS,
                tab === entry.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
              )}
              onClick={() => onTab(entry.id)}
            >
              {entry.label}
              {entry.count !== undefined ? <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{entry.count}</span> : null}
            </button>
          ))}
          {body !== "" ? <CopyButton text={body} /> : null}
        </div>
      </div>
      <div ref={scrollerRef} key={`${id}:${tab}`} data-grpc-response-scroll="" tabIndex={-1} className={cx("min-h-0 flex-1 overflow-auto px-4 py-3", FOCUS_RING, enter.rise)}>
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
      {search.open || search.query !== "" ? (
        <div className={cx("flex items-center gap-2 border-t border-border px-4 py-1.5", enter.fade, speed.fast)}>
          <span className="font-mono text-sm text-muted-foreground">/</span>
          {search.open ? (
            <input
              autoFocus
              className="h-6 min-w-0 flex-1 bg-transparent font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              placeholder="Search the response"
              value={search.query}
              spellCheck={false}
              aria-label="Search the response"
              data-vim-ignore=""
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  search.commit();
                  backToPane();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  search.cancel();
                  backToPane();
                }
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{search.query}</span>
          )}
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {search.query === "" ? "" : search.count === 0 ? "No matches" : `${search.current + 1} of ${search.count}${search.open ? "" : " · n / N"}`}
          </span>
        </div>
      ) : null}
    </div>
  );
}
