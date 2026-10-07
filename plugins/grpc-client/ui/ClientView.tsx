import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { toast } from "sonner";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { CallResult, HistoryEntry, MetadataEntry, MethodInfo, Overview, rpcContract, ServiceInfo, TypeClosure } from "../server";
import type { DescriptorState } from "../shared/schema";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { EditorOptionsContext, MessageEditor, inputClass } from "./MessageEditor";
import { MethodBadges, MethodList } from "./MethodList";
import { exampleMessage, hasUnsafeIntegers, isObject, type Json, type JsonObject } from "./proto-json";
import { EndpointSwitcher } from "./EndpointSwitcher";
import { Popover } from "./Popover";
import { ResponseView } from "./ResponseView";
import { readStored, useStored, writeStored } from "./storage";

/** Below this the method list becomes an overlay. */
const OVERLAY_LIST_WIDTH = 820;
/** At or above this the request and response sit side by side. */
const SIDE_BY_SIDE_WIDTH = 1650;
const NO_METADATA: MetadataRow[] = [];
const NO_OVERRIDES: Record<string, string> = {};

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Width of an element that may mount after the first render (hence a callback ref). */
function useWidth(): [(node: HTMLDivElement | null) => void, number] {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (node === null) return;
    setWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, width];
}


function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="max-w-lg space-y-3 text-center text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

function EmptyConfig({ errors }: { errors: string[] }) {
  return (
    <Centered>
      <Icon name="grpc-client/brand" className="mx-auto size-8" />
      <p className="text-base font-medium text-foreground">No gRPC endpoints yet</p>
      {errors.map((error) => (
        <p key={error} className="text-destructive">
          {error}
        </p>
      ))}
      <p>Add named endpoints and proto sources from a terminal, or edit the JSON in this plugin's settings.</p>
      <pre className="rounded-lg bg-muted/50 p-3 text-left font-mono text-xs leading-relaxed text-foreground">
        {[
          "bb grpc source add protos --kind protoDir --path ~/src/protos",
          "bb grpc endpoint add local --target localhost:50051 --transport plaintext",
          "bb grpc endpoint add prod --target api.example.com:443 --source protos --protected",
        ].join("\n")}
      </pre>
    </Centered>
  );
}

function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (value: T) => void }) {
  return (
    <div className="flex items-center gap-1" role="tablist">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          className={cn(
            "rounded-md px-2.5 py-1 text-sm",
            value === option.id ? "bg-state-active font-medium text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
          )}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="flex items-center rounded-md border border-border p-0.5" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          className={cn("rounded px-2 py-0.5 text-xs", value === option.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function MenuItem({ children, onClick, disabled, checked }: { children: ReactNode; onClick: () => void; disabled?: boolean; checked?: boolean }) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-state-hover disabled:pointer-events-none disabled:opacity-50"
      onClick={onClick}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {checked ? <Icon name="Check" className="size-3.5 shrink-0" /> : null}
    </button>
  );
}


interface MetadataRow extends MetadataEntry {
  enabled: boolean;
}

function MetadataEditor({ rows, endpoint, onChange }: { rows: MetadataRow[]; endpoint: string; onChange: (rows: MetadataRow[]) => void }) {
  const update = (index: number, patch: Partial<MetadataRow>) => onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Sent with every call to <span className="font-medium text-foreground">{endpoint}</span>. A row overrides an auth or endpoint header with the same name.
      </p>
      {rows.length > 0 ? (
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-foreground"
                checked={row.enabled}
                aria-label={`Send ${row.name || "this header"}`}
                onChange={(event) => update(index, { enabled: event.target.checked })}
              />
              <input
                className={cn(inputClass, "w-48 font-mono text-[13px]")}
                placeholder="name"
                value={row.name}
                spellCheck={false}
                onChange={(event) => update(index, { name: event.target.value.toLowerCase() })}
              />
              <input
                className={cn(inputClass, "flex-1 font-mono text-[13px]")}
                placeholder="value"
                value={row.value}
                spellCheck={false}
                onChange={(event) => update(index, { value: event.target.value })}
              />
              <button
                type="button"
                className="rounded p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground"
                aria-label={`Remove ${row.name || "header"}`}
                onClick={() => onChange(rows.filter((_row, position) => position !== index))}
              >
                <Icon name="Trash2" className="size-4" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <Button variant="outline" size="sm" onClick={() => onChange([...rows, { name: "", value: "", enabled: true }])}>
        <Icon name="Plus" className="size-4" />
        Add header
      </Button>
    </div>
  );
}

function formatWhen(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function HistoryList({ selectedId, onOpen }: { selectedId: number | null; onOpen: (entry: HistoryEntry) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const refetch = useCallback(() => {
    rpc.call("history", { limit: 200 }).then(
      (result) => setEntries(result.entries),
      () => setEntries([]),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("changed", refetch);
  const remove = (id: number) => {
    setEntries((current) => current?.filter((entry) => entry.id !== id) ?? null);
    rpc.call("deleteHistory", { ids: [id] }).then(refetch, (cause) => {
      toast.error(message(cause));
      refetch();
    });
  };
  if (entries === null) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (entries.length === 0) return <p className="p-4 text-sm text-muted-foreground">Calls you make here or with `bb grpc call` appear here.</p>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <div className="flex items-center justify-between px-2 pb-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recent calls</p>
        {confirmClear ? (
          <span className="flex items-center gap-1 text-xs">
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-destructive hover:bg-destructive/10"
              onClick={() => {
                setConfirmClear(false);
                rpc.call("clearHistory").then(refetch, (cause) => toast.error(message(cause)));
              }}
            >
              Delete all
            </button>
            <button type="button" className="rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setConfirmClear(true)}>
            Clear
          </button>
        )}
      </div>
      {entries.map((entry) => (
        <div key={entry.id} className={cn("group flex items-start rounded-md hover:bg-state-hover", entry.id === selectedId && "bg-state-active")}>
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-2 text-left"
            title={entry.message || entry.method}
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
            className="mr-1 mt-2 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={`Delete ${entry.method} from history`}
            title="Delete from history"
            onClick={() => remove(entry.id)}
          >
            <Icon name="Trash2" className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function parseRequest(text: string): { ok: true; value: Json } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

function JsonEditor({ text, onText }: { text: string; onText: (text: string) => void }) {
  return (
    <textarea
      className="min-h-64 w-full flex-1 resize-none rounded-lg border border-input bg-background p-3 font-mono text-[13px] leading-relaxed text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      value={text}
      spellCheck={false}
      onChange={(event) => onText(event.target.value)}
      aria-label="Request JSON"
    />
  );
}

function Notice({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warning" | "error" }) {
  return (
    <p
      className={cn(
        "mb-3 rounded-md px-3 py-2 text-xs",
        tone === "error" && "bg-destructive/10 text-destructive",
        tone === "warning" && "bg-amber-500/10 text-amber-800 dark:text-amber-200",
        tone === "muted" && "bg-muted/50 text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

function RequestBody({
  method,
  closure,
  closureError,
  mode,
  text,
  onText,
}: {
  method: MethodInfo;
  closure: TypeClosure | null;
  closureError: string | null;
  mode: "form" | "json";
  text: string;
  onText: (text: string) => void;
}) {
  const streams = method.kind === "client_streaming" || method.kind === "bidi_streaming";
  if (mode === "json") return <JsonEditor text={text} onText={onText} />;
  const parsed = parseRequest(text);
  if (!parsed.ok) {
    return (
      <>
        <Notice tone="error">The request is not valid JSON ({parsed.error}). Fix it here to go back to the form.</Notice>
        <JsonEditor text={text} onText={onText} />
      </>
    );
  }
  if (hasUnsafeIntegers(text)) {
    return (
      <>
        <Notice tone="warning">
          This request has integers too large to edit in the form without losing digits, so it stays as JSON. Write 64-bit values as strings to use the form.
        </Notice>
        <JsonEditor text={text} onText={onText} />
      </>
    );
  }
  if (closureError !== null) {
    return (
      <>
        <Notice tone="error">{closureError}</Notice>
        <JsonEditor text={text} onText={onText} />
      </>
    );
  }
  if (closure === null) return <p className="text-sm text-muted-foreground">Loading the request type…</p>;

  const write = (value: Json) => onText(JSON.stringify(value, null, 2));
  if (streams) {
    const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Messages are sent in order, then the stream closes.</p>
        {messages.map((entry, index) => (
          <div key={index} className="rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-sm">
              <span className="font-medium text-foreground">Message {index + 1}</span>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
                aria-label={`Remove message ${index + 1}`}
                onClick={() => write(messages.filter((_entry, position) => position !== index))}
              >
                <Icon name="Trash2" className="size-3.5" />
              </button>
            </div>
            <div className="px-3 py-2">
              <MessageEditor
                typeName={method.input}
                closure={closure}
                value={isObject(entry) ? entry : {}}
                onChange={(next) => write(messages.map((existing, position) => (position === index ? next : existing)))}
              />
            </div>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => write([...messages, {}])}>
          <Icon name="Plus" className="size-4" />
          Add message
        </Button>
      </div>
    );
  }
  return <MessageEditor typeName={method.input} closure={closure} value={isObject(parsed.value) ? parsed.value : {}} onChange={write} />;
}

/** Two panes with a draggable divider; the split ratio is remembered. */
function SplitPane({ vertical, first, second }: { vertical: boolean; first: ReactNode; second: ReactNode }) {
  const [ratio, setRatio] = useStored<number>(vertical ? "split:vertical" : "split:horizontal", 0.55);
  const container = useRef<HTMLDivElement>(null);
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const node = container.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      const next = vertical ? (moveEvent.clientY - rect.top) / rect.height : (moveEvent.clientX - rect.left) / rect.width;
      setRatio(Math.min(0.8, Math.max(0.2, next)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  return (
    <div ref={container} className={cn("flex min-h-0 min-w-0 flex-1", vertical ? "flex-col" : "flex-row")}>
      <div className="flex min-h-0 min-w-0 flex-col" style={{ flex: `${ratio} 1 0` }}>
        {first}
      </div>
      <div
        role="separator"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        className={cn("group relative shrink-0 bg-border", vertical ? "h-px cursor-row-resize" : "w-px cursor-col-resize")}
        onPointerDown={startDrag}
      >
        <div className={cn("absolute z-10 group-hover:bg-ring/30", vertical ? "inset-x-0 -top-1 h-2" : "inset-y-0 -left-1 w-2")} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col" style={{ flex: `${1 - ratio} 1 0` }}>
        {second}
      </div>
    </div>
  );
}

interface ServiceData {
  services: ServiceInfo[];
  state: DescriptorState;
}

type ServicesState =
  | { key: string; status: "loading"; data: ServiceData | null }
  | { key: string; status: "ready"; data: ServiceData }
  | { key: string; status: "error"; error: string; data: ServiceData | null };

export function ClientView() {
  const rpc = useRpc<typeof rpcContract>();
  const [rootRef, width] = useWidth();
  const overlayList = width > 0 && width < OVERLAY_LIST_WIDTH;
  const sideBySide = width >= SIDE_BY_SIDE_WIDTH;
  // The request bar folds Form/JSON into its menu when the workspace beside the list is narrow.
  const compactBar = width - (overlayList ? 0 : 320) < 780;

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const loadOverview = useCallback(() => {
    rpc.call("overview").then(
      (next) => {
        setOverview(next);
        setOverviewError(null);
      },
      (cause) => setOverviewError(message(cause)),
    );
  }, [rpc]);
  useEffect(loadOverview, [loadOverview]);

  const [storedEndpoint, setStoredEndpoint] = useStored<string | null>("endpoint", null);
  const [sourceOverrides, setSourceOverrides] = useStored<Record<string, string>>("sources", NO_OVERRIDES);
  const endpoint = overview?.endpoints.find((candidate) => candidate.name === storedEndpoint) ?? overview?.endpoints[0] ?? null;
  const sourceName = endpoint === null ? null : (sourceOverrides[endpoint.name] ?? endpoint.source);
  const servicesKey = endpoint === null || sourceName === null ? null : `${endpoint.name}|${sourceName}`;

  const [services, setServices] = useState<ServicesState | null>(null);
  // Responses for a key the user has since navigated away from are dropped.
  const latestServicesKey = useRef<string | null>(null);
  const loadServices = useCallback(
    (key: string, reload: boolean) => {
      const [endpointName, source] = key.split("|") as [string, string];
      latestServicesKey.current = key;
      setServices((previous) => ({ key, status: "loading", data: previous?.key === key ? previous.data : null }));
      rpc.call("services", { endpoint: endpointName, source, reload }).then(
        (result) => {
          if (latestServicesKey.current !== key) return;
          setServices({ key, status: "ready", data: { services: result.services, state: result.state } });
        },
        (cause) => {
          if (latestServicesKey.current !== key) return;
          setServices((previous) => ({ key, status: "error", error: message(cause), data: previous?.key === key ? previous.data : null }));
        },
      );
    },
    [rpc],
  );
  useEffect(() => {
    if (servicesKey !== null) loadServices(servicesKey, false);
  }, [servicesKey, loadServices]);
  useRealtime("changed", (payload) => {
    if (!isObject(payload) || payload.reason !== "config") return;
    loadOverview();
    // The host rebuilds descriptors only when the source config changed, so this is cheap otherwise.
    if (latestServicesKey.current !== null) loadServices(latestServicesKey.current, false);
  });
  const current = services !== null && services.key === servicesKey ? services : null;
  const serviceData = current?.data ?? null;

  const [storedMethod, setStoredMethod] = useStored<string | null>(`method:${endpoint?.name ?? ""}`, null);
  const method = useMemo(() => {
    if (serviceData === null || storedMethod === null) return null;
    for (const service of serviceData.services) {
      const found = service.methods.find((candidate) => candidate.fullName === storedMethod);
      if (found !== undefined) return found;
    }
    return null;
  }, [serviceData, storedMethod]);

  const closures = useRef(new Map<string, TypeClosure>());
  const [closure, setClosure] = useState<TypeClosure | null>(null);
  const [closureError, setClosureError] = useState<string | null>(null);
  const loadedAt = serviceData?.state.loadedAt ?? 0;
  const endpointName = endpoint?.name ?? null;
  useEffect(() => {
    setClosureError(null);
    if (method === null || endpointName === null || sourceName === null) {
      setClosure(null);
      return;
    }
    const key = `${endpointName}|${sourceName}|${loadedAt}|${method.input}`;
    const cached = closures.current.get(key);
    if (cached !== undefined) {
      setClosure(cached);
      return;
    }
    setClosure(null);
    let cancelled = false;
    rpc.call("types", { endpoint: endpointName, source: sourceName, typeName: method.input }).then(
      (result) => {
        closures.current.set(key, result);
        if (!cancelled) setClosure(result);
      },
      (cause) => {
        if (!cancelled) setClosureError(message(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, method, endpointName, sourceName, loadedAt]);

  const streams = method !== null && (method.kind === "client_streaming" || method.kind === "bidi_streaming");
  const defaultRequest = streams ? "[\n  {}\n]" : "{}";
  const [mode, setMode] = useStored<"form" | "json">("mode", "form");
  const [showDocs, setShowDocs] = useStored<boolean>("showDocs", false);
  const [requestText, setRequestText] = useStored<string>(`request:${method?.fullName ?? ""}`, defaultRequest);
  const [metadata, setMetadata] = useStored<MetadataRow[]>(`metadata:${endpoint?.name ?? ""}`, NO_METADATA);
  const [requestTab, setRequestTab] = useState<"body" | "metadata" | "options">("body");
  const [timeout, setTimeoutText] = useState("");
  const [leftTab, setLeftTab] = useState<"methods" | "history">("methods");
  const [listOpen, setListOpen] = useState(false);
  const [showComment, setShowComment] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** Latest result per endpoint + method; `recordedAt` marks one restored from history. */
  const [results, setResults] = useState<Record<string, { result: CallResult; recordedAt: number | null; historyId: number | null }>>({});
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const resultKey = endpoint === null || method === null ? "" : `${endpoint.name}|${method.fullName}`;
  const activeMetadata = metadata.filter((row) => row.enabled && row.name.trim() !== "");

  const callInput = () => {
    const seconds = Number(timeout);
    // RPC input must be strict JSON, so optional fields are omitted rather than set to undefined.
    return {
      endpoint: endpoint!.name,
      ...(sourceName === null ? {} : { source: sourceName }),
      method: method!.fullName,
      request: requestText,
      metadata: activeMetadata.map(({ name, value }) => ({ name: name.trim(), value })),
      ...(timeout.trim() !== "" && Number.isFinite(seconds) && seconds > 0 ? { timeoutSeconds: seconds } : {}),
    };
  };

  const send = () => {
    if (endpoint === null || method === null || sending) return;
    setConfirming(false);
    setSending(true);
    const key = resultKey;
    rpc.call("invoke", callInput()).then(
      (result) => {
        setResults((previous) => ({ ...previous, [key]: { result, recordedAt: null, historyId: null } }));
        setSending(false);
      },
      (cause) => {
        toast.error(message(cause));
        setSending(false);
      },
    );
  };
  const requestSend = () => {
    if (endpoint?.protected) setConfirming(true);
    else send();
  };
  const copyCommand = () => {
    if (endpoint === null || method === null) return;
    rpc
      .call("command", callInput())
      .then((result) => navigator.clipboard.writeText(result.command))
      .then(
        () => toast.success("Copied the grpcurl command"),
        (cause) => toast.error(message(cause)),
      );
  };
  const resetAuth = () => {
    rpc.call("resetAuth").then(
      (result) => toast.success(result.cleared === 0 ? "No cached tokens to forget" : "Cached tokens forgotten; the next call fetches new ones"),
      (cause) => toast.error(message(cause)),
    );
  };
  const fillExample = () => {
    if (method === null || closure === null) return;
    const example: JsonObject = exampleMessage(method.input, closure);
    setRequestText(JSON.stringify(streams ? [example] : example, null, 2));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      requestSend();
    }
  };
  const selectMethod = (next: MethodInfo) => {
    setStoredMethod(next.fullName);
    setShowComment(false);
    setListOpen(false);
  };
  const openHistory = (entry: HistoryEntry) => {
    writeStored(`method:${entry.endpoint}`, entry.method);
    writeStored(`request:${entry.method}`, entry.request);
    // History masks credential values; restoring "***" would override the real auth header.
    const restorable = entry.metadata.filter((row) => row.value !== "***");
    if (restorable.length > 0) {
      const rows = [...readStored<MetadataRow[]>(`metadata:${entry.endpoint}`, NO_METADATA)];
      for (const row of restorable) {
        const index = rows.findIndex((candidate) => candidate.name === row.name);
        if (index === -1) rows.push({ ...row, enabled: true });
        else rows[index] = { ...rows[index]!, value: row.value, enabled: true };
      }
      writeStored(`metadata:${entry.endpoint}`, rows);
    }
    if (overview?.endpoints.some((candidate) => candidate.name === entry.endpoint)) {
      setSourceOverrides({ ...sourceOverrides, [entry.endpoint]: entry.source });
      setStoredEndpoint(entry.endpoint);
    }
    setRequestTab("body");
    setListOpen(false);
    const key = `${entry.endpoint}|${entry.method}`;
    rpc.call("historyResult", { id: entry.id }).then(
      ({ result }) => {
        if (result !== null) setResults((previous) => ({ ...previous, [key]: { result, recordedAt: entry.at, historyId: entry.id } }));
        else toast("This call was recorded before responses were kept in history; only its request was restored.");
      },
      (cause) => toast.error(message(cause)),
    );
  };

  if (overview === null) {
    return <Centered>{overviewError === null ? "Loading…" : <span className="text-destructive">{overviewError}</span>}</Centered>;
  }
  if (endpoint === null) return <EmptyConfig errors={overview.errors} />;

  const errors = [...overview.errors, ...(overviewError ? [overviewError] : [])];
  const shown = results[resultKey] ?? null;
  const loadingServices = current?.status === "loading";
  const methodCount = serviceData?.services.reduce((count, service) => count + service.methods.length, 0) ?? 0;

  const list = (
    <aside
      className={cn(
        "flex min-h-0 flex-col border-r border-border bg-background",
        overlayList ? "absolute inset-y-0 left-0 z-20 w-80 max-w-[85%] shadow-xl" : "w-80 shrink-0",
      )}
    >
      <div className="flex items-center gap-1 border-b border-border px-1.5 py-1.5">
        <EndpointSwitcher
          overview={overview}
          endpoint={endpoint}
          sourceName={sourceName ?? ""}
          descriptors={serviceData?.state ?? null}
          loading={loadingServices}
          onEndpoint={setStoredEndpoint}
          onSource={(next) => setSourceOverrides({ ...sourceOverrides, [endpoint.name]: next })}
          onReload={() => servicesKey && loadServices(servicesKey, true)}
        />
        <button
          type="button"
          className={cn(
            "rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground",
            leftTab === "history" && "bg-state-active text-foreground",
          )}
          aria-label="Call history"
          aria-pressed={leftTab === "history"}
          title="Call history"
          onClick={() => setLeftTab(leftTab === "history" ? "methods" : "history")}
        >
          <Icon name="grpc-client/history" className="size-4" />
        </button>
        {overlayList ? (
          <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground" aria-label="Close method list" onClick={() => setListOpen(false)}>
            <Icon name="X" className="size-4" />
          </button>
        ) : null}
      </div>
      {leftTab === "history" ? (
        <HistoryList selectedId={shown?.historyId ?? null} onOpen={openHistory} />
      ) : current?.status === "error" && serviceData === null ? (
        <div className="space-y-3 p-4">
          <p className="text-sm font-medium text-foreground">Could not load the protos</p>
          <p className="whitespace-pre-wrap break-words text-xs text-destructive">{current.error}</p>
          <Button variant="outline" size="sm" onClick={() => servicesKey && loadServices(servicesKey, true)}>
            Try again
          </Button>
        </div>
      ) : serviceData === null ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Icon name="Spinner" className="size-4" />
          Loading protos…
        </div>
      ) : (
        <MethodList key={servicesKey ?? ""} services={serviceData.services} selected={method?.fullName ?? null} filterKey={sourceName ?? ""} onSelect={selectMethod} />
      )}
    </aside>
  );

  const requestPane =
    method === null ? null : (
      <>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-3">
          {requestTab === "body" ? (
            <EditorOptionsContext.Provider value={{ showDocs }}>
              <RequestBody key={method.fullName} method={method} closure={closure} closureError={closureError} mode={mode} text={requestText} onText={setRequestText} />
            </EditorOptionsContext.Provider>
          ) : null}
          {requestTab === "metadata" ? <MetadataEditor rows={metadata} endpoint={endpoint.name} onChange={setMetadata} /> : null}
          {requestTab === "options" ? (
            <div className="max-w-xl space-y-5 text-sm">
              <label className="block space-y-1">
                <span className="font-medium text-foreground">Deadline</span>
                <span className="flex items-center gap-2">
                  <input
                    className={cn(inputClass, "w-28")}
                    placeholder={String(overview.timeoutSeconds)}
                    inputMode="decimal"
                    value={timeout}
                    onChange={(event) => setTimeoutText(event.target.value)}
                  />
                  <span className="text-muted-foreground">seconds (default {overview.timeoutSeconds})</span>
                </span>
              </label>
              <div className="space-y-2">
                <span className="font-medium text-foreground">Auth</span>
                <p className="text-muted-foreground">
                  {method.auth === null ? "No auth profile, so no token is added." : `Profile “${method.auth}”`}
                  {method.authReason ? ` · ${method.authReason}` : ""}
                </p>
                {method.auth !== null ? (
                  <Button variant="outline" size="sm" onClick={resetAuth}>
                    Forget cached tokens
                  </Button>
                ) : null}
              </div>
              <dl className="space-y-1">
                <dt className="font-medium text-foreground">Types</dt>
                <dd className="break-all font-mono text-xs text-muted-foreground">request {method.input}</dd>
                <dd className="break-all font-mono text-xs text-muted-foreground">response {method.output}</dd>
              </dl>
            </div>
          ) : null}
        </div>
      </>
    );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {errors.length > 0 ? (
        <div role="alert" className="border-b border-border bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {errors.join(" · ")}
        </div>
      ) : null}
      {current?.status === "error" && serviceData !== null ? (
        <div role="alert" className="border-b border-border bg-destructive/5 px-4 py-2 text-xs text-destructive">
          Reloading the protos failed, so the last good copy is shown: {current.error}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        {!overlayList || listOpen ? list : null}
        {method === null ? (
          <Centered>
            {serviceData === null ? (
              current?.status === "error" ? (
                "The protos could not be loaded; the error is shown in the method list."
              ) : (
                "Loading protos…"
              )
            ) : (
              <>
                <p className="text-base font-medium text-foreground">Pick a method</p>
                <p>
                  {methodCount} methods across {serviceData.services.length} services. Search by service or method name.
                </p>
                {overlayList ? (
                  <Button variant="outline" size="sm" onClick={() => setListOpen(true)}>
                    Browse methods
                  </Button>
                ) : null}
              </>
            )}
          </Centered>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              {overlayList ? (
                <button
                  type="button"
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground"
                  aria-label="Show method list"
                  onClick={() => setListOpen(true)}
                >
                  <Icon name="PanelLeft" className="size-4" />
                </button>
              ) : null}
              <div className="flex min-w-0 items-center gap-1.5">
                <h2 className="truncate text-sm font-semibold text-foreground" title={method.fullName}>
                  {method.name}
                </h2>
                <MethodBadges method={method} showAuthName={!compactBar} />
                {method.deprecated ? <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-800 dark:text-amber-200">deprecated</span> : null}
                {method.comment ? (
                  <button
                    type="button"
                    className={cn("shrink-0 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground", showComment && "text-foreground")}
                    aria-label="Show method description"
                    aria-expanded={showComment}
                    title={method.comment}
                    onClick={() => setShowComment(!showComment)}
                  >
                    <Icon name="grpc-client/info" className="size-3.5" />
                  </button>
                ) : null}
              </div>
              <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
              <Tabs
                value={requestTab}
                onChange={setRequestTab}
                options={[
                  { id: "body", label: "Body" },
                  {
                    id: "metadata",
                    label: (
                      <>
                        Metadata{activeMetadata.length > 0 ? <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{activeMetadata.length}</span> : null}
                      </>
                    ),
                  },
                  { id: "options", label: "Options" },
                ]}
              />
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {requestTab === "body" && !compactBar ? (
                  <Segmented
                    value={mode}
                    onChange={setMode}
                    options={[
                      { id: "form", label: "Form" },
                      { id: "json", label: "JSON" },
                    ]}
                  />
                ) : null}
                <Popover
                  open={moreOpen}
                  onOpenChange={setMoreOpen}
                  label="Request actions"
                  className="left-auto right-0 w-56"
                  trigger={
                    <button
                      type="button"
                      className={cn("rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground", moreOpen && "bg-state-active text-foreground")}
                      aria-label="More request actions"
                      aria-expanded={moreOpen}
                      title="More"
                      onClick={() => setMoreOpen(!moreOpen)}
                    >
                      <Icon name="MoreHorizontal" className="size-4" />
                    </button>
                  }
                >
                  <MenuItem
                    disabled={closure === null}
                    onClick={() => {
                      fillExample();
                      setRequestTab("body");
                      setMoreOpen(false);
                    }}
                  >
                    Fill with example
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      setRequestText(defaultRequest);
                      setMoreOpen(false);
                    }}
                  >
                    Clear request
                  </MenuItem>
                  <MenuItem checked={showDocs} onClick={() => setShowDocs(!showDocs)}>
                    Show field docs
                  </MenuItem>
                  {compactBar ? (
                    <MenuItem
                      checked={mode === "json"}
                      onClick={() => {
                        setMode(mode === "json" ? "form" : "json");
                        setRequestTab("body");
                      }}
                    >
                      Edit as JSON
                    </MenuItem>
                  ) : null}
                  <div className="my-1 h-px bg-border" />
                  <MenuItem
                    onClick={() => {
                      copyCommand();
                      setMoreOpen(false);
                    }}
                  >
                    Copy as grpcurl command
                  </MenuItem>
                </Popover>
                <Button size="sm" className={cn("ml-1 h-7 px-3", endpoint.protected && "bg-amber-600 text-white hover:bg-amber-600/90")} disabled={sending} onClick={requestSend}>
                  <Icon name={sending ? "Spinner" : "grpc-client/send"} className="size-3.5" />
                  {sending ? "Sending" : endpoint.protected ? `Send to ${endpoint.name}` : "Send"}
                </Button>
              </div>
            </div>
            {showComment && method.comment ? (
              <p className="whitespace-pre-line border-b border-border px-4 py-2 text-sm text-muted-foreground">
                <span className="mb-1 block font-mono text-xs">{method.fullName}</span>
                {method.comment}
              </p>
            ) : null}
            <SplitPane vertical={!sideBySide} first={requestPane} second={<ResponseView result={shown?.result ?? null} recordedAt={shown?.recordedAt ?? null} sending={sending} />} />
          </div>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send to {endpoint.name}?</DialogTitle>
            <DialogDescription>
              {endpoint.name} ({endpoint.target}) is protected. This really calls {method?.name ?? "the method"}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={send}>
              Send to {endpoint.name}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
