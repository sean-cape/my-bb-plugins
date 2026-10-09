import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { cx, enter, exit, PRESS, speed, usePresence } from "bb-motion";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { CallResult } from "../contract";
import type { HistoryEntry, Overview, rpcContract } from "../server/rpc-contract";
import { CHANGED_CHANNEL, MASKED_VALUE, errorMessage, isClientStreaming } from "../shared/common";
import type { MethodInfo } from "../shared/schema";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { activateRow, deleteRow, editField, FIELD_ROW, focusRow, rowCells, isTextEntry, NAV_ROW, readRows, useClientKeys } from "./client-keys";
import { type Caret, type ClientCommand, cycle, listAction, type ListMotion } from "./client-nav";
import { Centered, FOCUS_RING, MenuItem, Segmented, Tabs } from "./controls";
import { EndpointSwitcher } from "./EndpointSwitcher";
import { HistoryList } from "./HistoryList";
import { useServices, useTypeClosure, useWidth } from "./hooks";
import { EditorOptionsContext, inputClass } from "./MessageEditor";
import { MetadataEditor, type MetadataRow } from "./MetadataEditor";
import { KeysDialog } from "./KeysDialog";
import { MethodBadges, MethodList, type MethodListHandle } from "./MethodList";
import { Popover } from "./Popover";
import { exampleMessage, isObject, type JsonObject } from "./proto-json";
import { RequestBody } from "./RequestBody";
import { RESPONSE_TABS, ResponseView, type ResponseTab } from "./ResponseView";
import { SplitPane } from "./SplitPane";
import { readStored, useStored, writeStored } from "./storage";

/** Below this the method list becomes an overlay. */
const OVERLAY_LIST_WIDTH = 820;
/** At or above this the request and response sit side by side. */
const SIDE_BY_SIDE_WIDTH = 1650;
/** Below this much room beside the list, the request bar folds Form/JSON into its menu. */
const COMPACT_BAR_WIDTH = 780;
const NO_METADATA: MetadataRow[] = [];
const DEFAULT_LIST_WIDTH = 320;
const MIN_LIST_WIDTH = 220;
/** The docked list never takes more than this share of the view. */
const MAX_LIST_SHARE = 0.6;
/** Dragging the list narrower than this collapses it. */
const COLLAPSE_LIST_WIDTH = 160;
const NO_OVERRIDES: Record<string, string> = {};
const REQUEST_TABS = ["body", "metadata", "options"] as const;
/** A key's focus request that waits for its panel to mount; older ones are dropped. */
const PENDING_FOCUS_MS = 2000;
const PENDING_FOCUS_RETRY_MS = 50;
const REQUEST_FIELDS = "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)";

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

export function ClientView() {
  const rpc = useRpc<typeof rpcContract>();
  const [rootRef, width, root] = useWidth();
  const overlayList = width > 0 && width < OVERLAY_LIST_WIDTH;
  const sideBySide = width >= SIDE_BY_SIDE_WIDTH;
  const [storedListWidth, setListWidth] = useStored<number>("listWidth", DEFAULT_LIST_WIDTH);
  const [listCollapsed, setListCollapsed] = useStored<boolean>("listCollapsed", false);
  const listWidth = Math.round(Math.min(Math.max(storedListWidth, MIN_LIST_WIDTH), Math.max(MIN_LIST_WIDTH, width * MAX_LIST_SHARE)));
  const listDocked = !overlayList && !listCollapsed;
  const compactBar = width - (listDocked ? listWidth : 0) < COMPACT_BAR_WIDTH;

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const loadOverview = useCallback(() => {
    rpc.call("overview").then(
      (next) => {
        setOverview(next);
        setOverviewError(null);
      },
      (cause) => setOverviewError(errorMessage(cause)),
    );
  }, [rpc]);
  useEffect(loadOverview, [loadOverview]);

  const [storedEndpoint, setStoredEndpoint] = useStored<string | null>("endpoint", null);
  const [sourceOverrides, setSourceOverrides] = useStored<Record<string, string>>("sources", NO_OVERRIDES);
  const endpoint = overview?.endpoints.find((candidate) => candidate.name === storedEndpoint) ?? overview?.endpoints[0] ?? null;
  const sourceName = endpoint === null ? null : (sourceOverrides[endpoint.name] ?? endpoint.source);
  const servicesKey = endpoint === null || sourceName === null ? null : `${endpoint.name}|${sourceName}`;

  const services = useServices(servicesKey);
  useRealtime(CHANGED_CHANNEL, (payload) => {
    if (!isObject(payload) || payload.reason !== "config") return;
    loadOverview();
    // The host rebuilds descriptors only when the source config changed, so this is cheap otherwise.
    services.refresh();
  });
  const current = services.current;
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

  const { closure, closureError } = useTypeClosure(method, endpoint?.name ?? null, sourceName, serviceData?.state.loadedAt ?? 0);

  const streams = method !== null && isClientStreaming(method.kind);
  const defaultRequest = streams ? "[\n  {}\n]" : "{}";
  const [mode, setMode] = useStored<"form" | "json">("mode", "form");
  const [showDocs, setShowDocs] = useStored<boolean>("showDocs", false);
  const [requestText, setRequestText] = useStored<string>(`request:${method?.fullName ?? ""}`, defaultRequest);
  const [metadata, setMetadata] = useStored<MetadataRow[]>(`metadata:${endpoint?.name ?? ""}`, NO_METADATA);
  const [requestTab, setRequestTab] = useState<(typeof REQUEST_TABS)[number]>("body");
  const [responseTab, setResponseTab] = useState<ResponseTab>("response");
  const [timeout, setTimeoutText] = useState("");
  const [leftTab, setLeftTab] = useState<"methods" | "history">("methods");
  const [listOpen, setListOpen] = useState(false);
  const overlayPresence = usePresence(listOpen);
  /** Set once the user reopens the docked list, so it slides in then but not on first paint. */
  const [listReopened, setListReopened] = useState(false);
  const [showComment, setShowComment] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  /** Latest result per endpoint + method; `recordedAt` marks one restored from history. */
  const [results, setResults] = useState<Record<string, { result: CallResult; recordedAt: number | null; historyId: number | null }>>({});
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const resultKey = endpoint === null || method === null ? "" : `${endpoint.name}|${method.fullName}`;
  const activeMetadata = metadata.filter((row) => row.enabled && row.name.trim() !== "");

  const callRequest = (endpointName: string, methodName: string) => {
    const seconds = Number(timeout);
    // RPC input must be strict JSON, so optional fields are omitted rather than set to undefined.
    return {
      endpoint: endpointName,
      ...(sourceName === null ? {} : { source: sourceName }),
      method: methodName,
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
    rpc.call("invoke", callRequest(endpoint.name, method.fullName)).then(
      (result) => {
        setResults((previous) => ({ ...previous, [key]: { result, recordedAt: null, historyId: null } }));
        setSending(false);
      },
      (cause) => {
        toast.error(errorMessage(cause));
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
      .call("command", callRequest(endpoint.name, method.fullName))
      .then((result) => navigator.clipboard.writeText(result.command))
      .then(
        () => toast.success("Copied the grpcurl command"),
        (cause) => toast.error(errorMessage(cause)),
      );
  };
  const resetAuth = () => {
    rpc.call("resetAuth").then(
      (result) => toast.success(result.cleared === 0 ? "No cached tokens to forget" : "Cached tokens forgotten; the next call fetches new ones"),
      (cause) => toast.error(errorMessage(cause)),
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
    const restorable = entry.metadata.filter((row) => row.value !== MASKED_VALUE);
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
      (cause) => toast.error(errorMessage(cause)),
    );
  };

  const listRef = useRef<HTMLElement>(null);
  const methodListRef = useRef<MethodListHandle>(null);
  const requestPaneRef = useRef<HTMLDivElement>(null);
  /** The row the list cursor was last on, so keys resume there after focus leaves the list. */
  const lastRowKey = useRef<string | null>(null);
  /** The request field the cursor was last on; fields remount per method, so this is the element. */
  const lastFieldRow = useRef<HTMLElement | null>(null);
  /** Where hjkl go when focus is in neither pane. */
  const lastPane = useRef<"list" | "fields">("list");
  const [pendingFocus, setPendingFocus] = useState<{ target: "cursor" | "fields" | "search" | "filters"; at: number } | null>(null);
  const [, retryPendingFocus] = useReducer((count: number) => count + 1, 0);
  const listShown = overlayList ? listOpen : !listCollapsed;

  const showList = () => {
    if (overlayList) setListOpen(true);
    else {
      setListCollapsed(false);
      setListReopened(true);
    }
  };
  const revealList = (target: "cursor" | "search" | "filters") => {
    if (!listShown) showList();
    setPendingFocus({ target, at: Date.now() });
  };
  const landCursor = (list: HTMLElement): boolean => {
    const rows = [...list.querySelectorAll<HTMLElement>(NAV_ROW)];
    const row = rows.find((candidate) => candidate.dataset.navKey === lastRowKey.current) ?? rows.find((candidate) => candidate.getAttribute("aria-current") === "true") ?? rows[0];
    if (row === undefined) return false;
    focusRow(row);
    return true;
  };
  const savedFieldRow = (): HTMLElement | null => {
    const row = lastFieldRow.current;
    return row !== null && row.isConnected && requestPaneRef.current?.contains(row) === true ? row : null;
  };
  const landFieldCursor = (): boolean => {
    const row = savedFieldRow() ?? (requestPaneRef.current === null ? undefined : readRows(requestPaneRef.current).elements[0]);
    if (row == null) return false;
    focusRow(row);
    return true;
  };
  useEffect(() => {
    if (pendingFocus === null) return;
    if (Date.now() - pendingFocus.at > PENDING_FOCUS_MS) {
      setPendingFocus(null);
      return;
    }
    const handle = methodListRef.current;
    const landed =
      pendingFocus.target === "cursor" ? listRef.current !== null && landCursor(listRef.current) : pendingFocus.target === "fields" ? landFieldCursor() : handle !== null;
    if (!landed) {
      // Rows can arrive in a child's own render (call history loads itself), which doesn't re-run this.
      const timer = setTimeout(retryPendingFocus, PENDING_FOCUS_RETRY_MS);
      return () => clearTimeout(timer);
    }
    if (pendingFocus.target === "search") handle?.focusSearch();
    if (pendingFocus.target === "filters") handle?.openFilters();
    setPendingFocus(null);
  });

  const focusedRow = (container: HTMLElement | null): HTMLElement | null => {
    const row = document.activeElement?.closest<HTMLElement>(NAV_ROW) ?? null;
    return row !== null && container?.contains(row) === true ? row : null;
  };
  const currentPane = (): "list" | "fields" => {
    const active = document.activeElement;
    if (requestPaneRef.current?.contains(active)) return "fields";
    if (listRef.current?.contains(active)) return "list";
    return lastPane.current;
  };
  const backToList = () => {
    lastPane.current = "list";
    if (listShown && listRef.current !== null) landCursor(listRef.current);
    else revealList("cursor");
  };

  const moveListCursor = (motion: ListMotion) => {
    const list = listRef.current;
    if (!listShown || list === null) {
      revealList("cursor");
      return;
    }
    const { elements, rows } = readRows(list);
    const focused = focusedRow(list);
    let current = focused === null ? -1 : elements.indexOf(focused);
    if (current === -1) current = elements.findIndex((element) => element.dataset.navKey === lastRowKey.current);
    const start = Math.max(0, elements.findIndex((element) => element.getAttribute("aria-current") === "true"));
    const action = listAction(rows, current === -1 ? null : current, motion, start);
    if (action === null) return;
    const element = elements[action.index]!;
    focusRow(element);
    if (action.kind !== "activate") return;
    element.click();
    // Opening a method from the keyboard carries the cursor on into its request fields.
    if (element.dataset.navKey?.startsWith("method:")) {
      lastPane.current = "fields";
      setPendingFocus({ target: "fields", at: Date.now() });
    }
  };

  const moveFieldCursor = (motion: ListMotion) => {
    const pane = requestPaneRef.current;
    if (pane === null) {
      backToList();
      return;
    }
    const { elements, rows } = readRows(pane);
    const cursor = focusedRow(pane) ?? savedFieldRow();
    const current = cursor === null ? -1 : elements.indexOf(cursor);
    // On a field, l and h step across the buttons beside its box instead of editing it.
    if (cursor !== null && rows[current]?.kind === "item" && !(cursor instanceof HTMLButtonElement) && (motion === "right" || motion === "left")) {
      const cells = rowCells(cursor);
      const at = cells.indexOf(document.activeElement as HTMLElement);
      if (motion === "right") {
        const next = cells[at + 1];
        if (next !== undefined) next.focus({ preventScroll: true });
        return;
      }
      if (at !== -1) {
        focusRow(cells[at - 1] ?? cursor);
        return;
      }
    }
    const action = listAction(rows, current === -1 ? null : current, motion, 0);
    if (action === null) {
      if (motion === "left") backToList();
      return;
    }
    const element = elements[action.index]!;
    focusRow(element);
    if (action.kind === "activate") activateFieldRow(element);
  };

  /** Edits a field row, or presses its button; a "Set" button swaps the row for a section, which keeps the cursor. */
  const activateFieldRow = (row: HTMLElement, caret: Caret = "end") => {
    const pane = requestPaneRef.current;
    const index = pane === null ? -1 : readRows(pane).elements.indexOf(row);
    activateRow(row, caret);
    setTimeout(() => {
      if (row.isConnected || pane === null || index === -1) return;
      const replacement = readRows(pane).elements[index];
      if (replacement !== undefined) focusRow(replacement);
    }, 0);
  };

  const deleteField = (): boolean => {
    const pane = requestPaneRef.current;
    const row = focusedRow(pane) ?? savedFieldRow();
    if (pane === null || row === null) return false;
    const index = readRows(pane).elements.indexOf(row);
    if (!deleteRow(row)) return false;
    // A removed item plays its exit as an inert ghost and an unset section turns back into a
    // plain row, so the cursor takes whatever row now sits in the same place.
    setTimeout(() => {
      if (row.isConnected && row.closest("[inert]") === null) {
        focusRow(row);
        return;
      }
      const { elements } = readRows(pane);
      const next = elements[Math.min(index, elements.length - 1)];
      if (next !== undefined) focusRow(next);
    }, 0);
    return true;
  };

  const runCommand = (command: ClientCommand): boolean | void => {
    const hasMethod = endpoint !== null && method !== null;
    switch (command.kind) {
      case "list":
        if (currentPane() === "fields") moveFieldCursor(command.motion);
        else moveListCursor(command.motion);
        return;
      case "search":
      case "filters":
        setLeftTab("methods");
        revealList(command.kind);
        return;
      case "endpoint":
        if (!listShown) showList();
        setEndpointOpen(true);
        return;
      case "history":
        setLeftTab(leftTab === "history" ? "methods" : "history");
        revealList("cursor");
        return;
      case "toggleList":
        if (!listShown) {
          revealList("cursor");
          return;
        }
        if (listRef.current?.contains(document.activeElement)) root?.focus({ preventScroll: true });
        if (overlayList) setListOpen(false);
        else setListCollapsed(true);
        return;
      case "edit": {
        const row = focusedRow(requestPaneRef.current) ?? savedFieldRow();
        if (row !== null) {
          activateFieldRow(row, command.caret);
          return;
        }
        const fields = [...(requestPaneRef.current?.querySelectorAll<HTMLElement>(REQUEST_FIELDS) ?? [])];
        const field = fields.find(isTextEntry) ?? fields[0];
        if (field === undefined) return false;
        editField(field, command.caret);
        field.scrollIntoView({ block: "nearest" });
        return;
      }
      case "requestTab":
        if (!hasMethod) return false;
        setRequestTab(cycle(REQUEST_TABS, requestTab, command.step));
        return;
      case "responseTab":
        if (results[resultKey] === undefined) return false;
        setResponseTab(cycle(RESPONSE_TABS, responseTab, command.step));
        return;
      case "mode":
        if (!hasMethod) return false;
        setMode(mode === "json" ? "form" : "json");
        setRequestTab("body");
        return;
      case "copyCommand":
        if (!hasMethod) return false;
        copyCommand();
        return;
      case "scroll": {
        const pane = root?.querySelector<HTMLElement>("[data-grpc-response-scroll]");
        if (pane == null) return false;
        pane.scrollBy({ top: (command.step * pane.clientHeight) / 2 });
        return;
      }
      case "delete":
        return currentPane() === "fields" && deleteField();
      case "escape":
        if (command.fromField) {
          const row = document.activeElement?.parentElement?.closest<HTMLElement>(NAV_ROW);
          if (row != null && requestPaneRef.current?.contains(row)) focusRow(row);
          else root?.focus({ preventScroll: true });
          return;
        }
        {
          // From a button beside a field's box, Escape goes back to the field.
          const row = focusedRow(requestPaneRef.current);
          if (row !== null && row !== document.activeElement) {
            focusRow(row);
            return;
          }
        }
        if (methodListRef.current?.clearSearch()) {
          // The result rows the cursor was on are gone; it goes back to the open method.
          if (method !== null) lastRowKey.current = `method:${method.fullName}`;
          revealList("cursor");
          return;
        }
        if (overlayList && listOpen) {
          setListOpen(false);
          return;
        }
        return false;
      case "help":
        setKeysOpen(true);
        return;
    }
  };
  useClientKeys(root, overview !== null && endpoint !== null, runCommand);

  if (overview === null) {
    return <Centered>{overviewError === null ? "Loading…" : <span className="text-destructive">{overviewError}</span>}</Centered>;
  }
  if (endpoint === null) return <EmptyConfig errors={overview.errors} />;

  const errors = [...overview.errors, ...(overviewError ? [overviewError] : [])];
  const shown = results[resultKey] ?? null;
  const loadingServices = current?.status === "loading";
  const methodCount = serviceData?.services.reduce((count, service) => count + service.methods.length, 0) ?? 0;

  const startListResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = listWidth;
    const previousSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const move = (moveEvent: PointerEvent) => {
      const next = startWidth + moveEvent.clientX - startX;
      if (next < COLLAPSE_LIST_WIDTH) {
        setListCollapsed(true);
        stop();
        return;
      }
      setListWidth(Math.max(MIN_LIST_WIDTH, next));
    };
    const stop = () => {
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  const list = (
    <aside
      ref={listRef}
      className={cn(
        "relative flex min-h-0 flex-col border-r border-border bg-background",
        overlayList ? "absolute inset-y-0 left-0 z-20 w-80 max-w-[85%] shadow-xl" : "shrink-0",
        overlayList ? (overlayPresence.exiting ? exit.fade : enter.slideLeft) : listReopened && enter.slideLeft,
      )}
      style={overlayList ? undefined : { width: listWidth }}
      onAnimationEnd={overlayList ? overlayPresence.onAnimationEnd : undefined}
      onFocus={(event) => {
        lastPane.current = "list";
        const key = (event.target as Element).closest<HTMLElement>(NAV_ROW)?.dataset.navKey;
        if (key !== undefined) lastRowKey.current = key;
      }}
    >
      <div className="flex items-center gap-1 border-b border-border px-1.5 py-1.5">
        <EndpointSwitcher
          overview={overview}
          endpoint={endpoint}
          sourceName={sourceName ?? ""}
          descriptors={serviceData?.state ?? null}
          loading={loadingServices}
          open={endpointOpen}
          onOpenChange={setEndpointOpen}
          onEndpoint={setStoredEndpoint}
          onSource={(next) => setSourceOverrides({ ...sourceOverrides, [endpoint.name]: next })}
          onReload={services.reload}
        />
        <button
          type="button"
          className={cn(
            "rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground",
            PRESS,
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
          <button type="button" className={cx("rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)} aria-label="Close method list" onClick={() => setListOpen(false)}>
            <Icon name="X" className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            className={cx("rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)}
            aria-label="Collapse method list"
            title="Collapse method list"
            onClick={() => setListCollapsed(true)}
          >
            <Icon name="PanelLeft" className="size-4" />
          </button>
        )}
      </div>
      {leftTab === "history" ? (
        <HistoryList selectedId={shown?.historyId ?? null} onOpen={openHistory} />
      ) : current?.status === "error" && serviceData === null ? (
        <div className="space-y-3 p-4">
          <p className="text-sm font-medium text-foreground">Could not load the protos</p>
          <p className="whitespace-pre-wrap break-words text-xs text-destructive">{current.error}</p>
          <Button variant="outline" size="sm" onClick={services.reload}>
            Try again
          </Button>
        </div>
      ) : serviceData === null ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Icon name="Spinner" className="size-4" />
          Loading protos…
        </div>
      ) : (
        <MethodList key={servicesKey ?? ""} services={serviceData.services} selected={method?.fullName ?? null} filterKey={sourceName ?? ""} handle={methodListRef} onSelect={selectMethod} />
      )}
      {overlayList ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize method list"
          title="Drag to resize · double-click to reset"
          className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-ring/30"
          onPointerDown={startListResize}
          onDoubleClick={() => setListWidth(DEFAULT_LIST_WIDTH)}
        />
      )}
    </aside>
  );

  const requestPane =
    method === null ? null : (
      <>
        <div
          ref={requestPaneRef}
          className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-3"
          onFocus={(event) => {
            lastPane.current = "fields";
            const row = (event.target as Element).closest<HTMLElement>(NAV_ROW);
            if (row !== null) lastFieldRow.current = row;
          }}
        >
          {requestTab === "body" ? (
            <EditorOptionsContext.Provider value={{ showDocs }}>
              <RequestBody key={method.fullName} method={method} closure={closure} closureError={closureError} mode={mode} text={requestText} onText={setRequestText} />
            </EditorOptionsContext.Provider>
          ) : null}
          {requestTab === "metadata" ? <MetadataEditor rows={metadata} endpoint={endpoint.name} onChange={setMetadata} /> : null}
          {requestTab === "options" ? (
            <div className={cx("max-w-xl space-y-5 text-sm", enter.rise)} data-vim-ignore="">
              <label {...FIELD_ROW} className={cn("block space-y-1 rounded-md", FOCUS_RING)}>
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
                  <Button variant="outline" size="sm" data-nav-row="item" onClick={resetAuth}>
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
    <div ref={rootRef} tabIndex={-1} data-grpc-keys="" className="flex h-full min-h-0 flex-1 flex-col outline-none" onKeyDown={onKeyDown}>
      {errors.length > 0 ? (
        <div role="alert" className={cx("border-b border-border bg-destructive/5 px-4 py-2 text-xs text-destructive", enter.drop)}>
          {errors.join(" · ")}
        </div>
      ) : null}
      {current?.status === "error" && serviceData !== null ? (
        <div role="alert" className={cx("border-b border-border bg-destructive/5 px-4 py-2 text-xs text-destructive", enter.drop)}>
          Reloading the protos failed, so the last good copy is shown: {current.error}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        {(overlayList ? overlayPresence.mounted : !listCollapsed) ? list : null}
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
                <p className="text-xs text-muted-foreground/80">j and k move through the list, / searches, ? lists every shortcut</p>
                {listDocked ? null : (
                  <Button variant="outline" size="sm" onClick={showList}>
                    Browse methods
                  </Button>
                )}
              </>
            )}
          </Centered>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              {listDocked ? null : (
                <button
                  type="button"
                  className={cx("shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)}
                  aria-label="Show method list"
                  title="Show method list"
                  onClick={showList}
                >
                  <Icon name="PanelLeft" className="size-4" />
                </button>
              )}
              <div key={method.fullName} className={cx("flex min-w-0 items-center gap-1.5", enter.fade, speed.fast)}>
                <h2 className="truncate text-sm font-semibold text-foreground" title={method.fullName}>
                  {method.name}
                </h2>
                <MethodBadges method={method} showAuthName={!compactBar} />
                {method.deprecated ? <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-800 dark:text-amber-200">deprecated</span> : null}
                {method.comment ? (
                  <button
                    type="button"
                    className={cn("shrink-0 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS, showComment && "text-foreground")}
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
                      className={cn("rounded-md p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS, moreOpen && "bg-state-active text-foreground")}
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
                  <MenuItem
                    onClick={() => {
                      setMoreOpen(false);
                      setKeysOpen(true);
                    }}
                  >
                    <span className="flex items-center justify-between">
                      Keyboard shortcuts
                      <kbd className="font-mono text-xs text-muted-foreground">?</kbd>
                    </span>
                  </MenuItem>
                </Popover>
                <Button size="sm" className={cn("ml-1 h-7 px-3", endpoint.protected && "bg-amber-600 text-white hover:bg-amber-600/90")} disabled={sending} onClick={requestSend}>
                  <span key={sending ? "sending" : "idle"} className={cx("flex", sending ? cx(enter.fade, speed.fast) : enter.pop)}>
                    <Icon name={sending ? "Spinner" : "grpc-client/send"} className="size-3.5" />
                  </span>
                  {sending ? "Sending" : endpoint.protected ? `Send to ${endpoint.name}` : "Send"}
                </Button>
              </div>
            </div>
            {showComment && method.comment ? (
              <p className={cx("whitespace-pre-line border-b border-border px-4 py-2 text-sm text-muted-foreground", enter.drop, speed.fast)}>
                <span className="mb-1 block font-mono text-xs">{method.fullName}</span>
                {method.comment}
              </p>
            ) : null}
            <SplitPane vertical={!sideBySide} first={requestPane} second={<ResponseView result={shown?.result ?? null} recordedAt={shown?.recordedAt ?? null} sending={sending} tab={responseTab} onTab={setResponseTab} />} />
          </div>
        )}
      </div>

      <KeysDialog open={keysOpen} onOpenChange={setKeysOpen} />
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
