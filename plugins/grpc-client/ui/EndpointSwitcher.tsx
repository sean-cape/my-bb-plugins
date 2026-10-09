import { useRef } from "react";
import { cx, enter, exit, PRESS, speed, TRANSFORM_TRANSITION, usePresence } from "bb-motion";
import type { EndpointSummary, Overview } from "../server/rpc-contract";
import type { DescriptorState } from "../shared/schema";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePanelKeys } from "./client-keys";
import { FOCUS_RING } from "./controls";
import { useDismiss, useInertWhileClosing } from "./hooks";

/**
 * The endpoint and proto source rarely change, so they live behind one compact
 * chip; the dropdown also carries the connection details and descriptor reload.
 */
export function EndpointSwitcher({
  overview,
  endpoint,
  sourceName,
  descriptors,
  loading,
  open,
  onOpenChange: setOpen,
  onEndpoint,
  onSource,
  onReload,
}: {
  overview: Overview;
  endpoint: EndpointSummary;
  sourceName: string;
  descriptors: DescriptorState | null;
  loading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEndpoint: (name: string) => void;
  onSource: (name: string) => void;
  onReload: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useDismiss(root, open, setOpen);
  const panel = useRef<HTMLDivElement>(null);
  const presence = usePresence(open);
  useInertWhileClosing(root, panel, presence.exiting);
  const onPanelKeyDown = usePanelKeys(panel, open);

  const sources = overview.sources.some((source) => source.name === sourceName)
    ? overview.sources
    : [...overview.sources, { name: sourceName, kind: "missing" }];

  return (
    <div ref={root} className="relative min-w-0 flex-1">
      <button
        type="button"
        className={cx("flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-state-hover", PRESS)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${endpoint.target} · ${sourceName}`}
        onClick={() => setOpen(!open)}
      >
        <span className={cn("size-2 shrink-0 rounded-full", endpoint.protected ? "bg-amber-500" : "bg-emerald-500")} aria-hidden />
        <span className="truncate text-sm font-medium text-foreground">{endpoint.name}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{sourceName}</span>
        <Icon
          name="ChevronDown"
          className={cx("ml-auto size-3.5 shrink-0 text-muted-foreground", TRANSFORM_TRANSITION)}
          style={open ? { transform: "rotate(180deg)" } : undefined}
        />
      </button>
      {presence.mounted ? (
        <div
          ref={panel}
          role="dialog"
          aria-label="Endpoint"
          aria-hidden={presence.exiting || undefined}
          data-state={presence.exiting ? "closed" : "open"}
          className={cx(
            "absolute left-0 top-full z-30 mt-1 w-80 rounded-lg border border-border bg-background p-1.5 shadow-lg",
            presence.exiting ? exit.fade : cx(enter.drop, speed.fast),
          )}
          onAnimationEnd={presence.onAnimationEnd}
          onKeyDown={onPanelKeyDown}
        >
          <p className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Endpoint</p>
          {overview.endpoints.map((option) => (
            <button
              key={option.name}
              type="button"
              aria-current={option.name === endpoint.name ? "true" : undefined}
              className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-state-hover", FOCUS_RING, option.name === endpoint.name && "bg-state-active")}
              onClick={() => {
                onEndpoint(option.name);
                setOpen(false);
              }}
            >
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", option.protected ? "bg-amber-500" : "bg-emerald-500")} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm text-foreground">
                  {option.name}
                  {option.protected ? <span className="text-[10px] text-amber-700 dark:text-amber-300">protected</span> : null}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {option.transport === "tls" ? "" : `${option.transport} · `}
                  {option.target}
                </span>
                {option.description ? <span className="block truncate text-xs text-muted-foreground">{option.description}</span> : null}
              </span>
              {option.name === endpoint.name ? <Icon name="Check" className="mt-1 size-3.5 shrink-0 text-foreground" /> : null}
            </button>
          ))}
          <div className="mt-1.5 space-y-1.5 border-t border-border px-2 pb-1 pt-2">
            <label className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-xs text-muted-foreground">Protos</span>
              <select
                className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                value={sourceName}
                onChange={(event) => onSource(event.target.value)}
              >
                {sources.map((source) => (
                  <option key={source.name} value={source.name}>
                    {source.name} · {source.kind}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {descriptors === null
                  ? "Descriptors not loaded"
                  : `${descriptors.fileCount} files · loaded ${new Date(descriptors.loadedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
              </span>
              <button
                type="button"
                className={cx("flex items-center gap-1 rounded px-1.5 py-1 hover:bg-state-hover hover:text-foreground disabled:opacity-50", PRESS)}
                disabled={loading}
                onClick={onReload}
              >
                <Icon name={loading ? "Spinner" : "Repeat"} className="size-3.5" />
                Reload protos
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
