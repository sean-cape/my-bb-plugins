import { useEffect, useMemo, useRef, useState } from "react";
import type { MethodInfo, ServiceInfo } from "../shared/schema";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<MethodInfo["kind"], string | null> = {
  unary: null,
  server_streaming: "server stream",
  client_streaming: "client stream",
  bidi_streaming: "bidi stream",
};

export function MethodBadges({ method, showAuthName = false }: { method: MethodInfo; showAuthName?: boolean }) {
  const kind = KIND_LABELS[method.kind];
  return (
    <>
      {kind !== null ? <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">{kind}</span> : null}
      {method.auth !== null ? (
        <span
          className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
          title={`Auth profile ${method.auth}${method.authReason ? ` — ${method.authReason}` : ""}`}
        >
          <Icon name="Lock" className="size-3" />
          {showAuthName ? method.auth : null}
        </span>
      ) : null}
    </>
  );
}

function serviceName(typeName: string): string {
  return typeName.slice(typeName.lastIndexOf(".") + 1);
}

function MethodRow({ method, selected, detail, onSelect }: { method: MethodInfo; selected: boolean; detail?: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        selected ? "bg-state-active text-foreground" : "text-foreground/80 hover:bg-state-hover hover:text-foreground",
      )}
      title={method.comment ?? method.fullName}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", method.deprecated && "line-through opacity-70")}>{method.name}</span>
        {detail ? <span className="block truncate text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      <MethodBadges method={method} />
    </button>
  );
}

export function MethodList({
  services,
  selected,
  onSelect,
}: {
  services: ServiceInfo[];
  selected: string | null;
  onSelect: (method: MethodInfo) => void;
}) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = selected === null ? undefined : services.find((service) => service.methods.some((method) => method.fullName === selected));
    return new Set(open === undefined ? [] : [open.typeName]);
  });
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only on mount: later selections come from clicks on rows that are already visible.
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
  }, []);

  const total = useMemo(() => services.reduce((count, service) => count + service.methods.length, 0), [services]);
  const matches = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    return services.flatMap((service) =>
      service.methods.filter((method) => terms.every((term) => method.fullName.toLowerCase().includes(term))),
    );
  }, [services, filter]);

  const toggle = (typeName: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(typeName)) next.delete(typeName);
      else next.add(typeName);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1.5 pt-2">
        <div className="relative">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            placeholder={`Search ${total} methods`}
            value={filter}
            spellCheck={false}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setFilter("");
              if (event.key === "Enter" && matches?.length) onSelect(matches[0]!);
            }}
          />
          {filter !== "" ? (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
              onClick={() => setFilter("")}
            >
              <Icon name="X" className="size-3.5" />
            </button>
          ) : null}
        </div>
        {matches !== null ? (
          <p className="mt-1.5 px-1 text-xs text-muted-foreground">
            {matches.length} of {total} methods{matches.length > 0 ? " · Enter opens the first" : ""}
          </p>
        ) : null}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {matches !== null ? (
          matches.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No methods match “{filter}”.</p>
          ) : (
            matches.map((method) => (
              <MethodRow
                key={method.fullName}
                method={method}
                selected={method.fullName === selected}
                detail={method.fullName.slice(0, method.fullName.indexOf("/"))}
                onSelect={() => onSelect(method)}
              />
            ))
          )
        ) : (
          services.map((service) => {
            const open = expanded.has(service.typeName);
            const containsSelected = service.methods.some((method) => method.fullName === selected);
            return (
              <div key={service.typeName}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-state-hover"
                  title={`${service.typeName}${service.comment ? `\n\n${service.comment}` : ""}`}
                  onClick={() => toggle(service.typeName)}
                  aria-expanded={open}
                >
                  <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className={cn("min-w-0 flex-1 truncate text-sm font-medium", containsSelected ? "text-foreground" : "text-foreground/90")}>
                    {serviceName(service.typeName)}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{service.methods.length}</span>
                </button>
                {open ? (
                  <div className="mb-1 ml-3 border-l border-border pl-1.5">
                    {service.methods.map((method) => (
                      <MethodRow key={method.fullName} method={method} selected={method.fullName === selected} onSelect={() => onSelect(method)} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
