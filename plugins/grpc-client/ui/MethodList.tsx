import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { CHEVRON, cx, enter, PRESS, REVEAL, REVEAL_HOST, speed, stagger, STAGGER } from "bb-motion";
import type { MethodInfo, ServiceInfo } from "../shared/schema";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { focusRow, NAV_ROW } from "./client-keys";
import { FOCUS_RING } from "./controls";
import { Popover } from "./Popover";
import { shortName } from "./proto-json";
import { useStored } from "./storage";

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

export interface MethodFilters {
  /** Auth groups to show; empty shows every group. */
  auth: string[];
  /** Fully-qualified services to show; empty shows every service. */
  services: string[];
  hideDeprecated: boolean;
}

const NO_FILTERS: MethodFilters = { auth: [], services: [], hideDeprecated: false };

/** The option value a rule matched, else the profile, so filters work with or without auth rules. */
function authGroup(method: MethodInfo): string {
  if (method.authValue !== null) return method.authValue;
  return method.auth === null ? "none" : `profile:${method.auth}`;
}

/** "AUTH_TYPE_SERVICE_ACCOUNT" → "service account": strips the prefix every option value shares. */
function groupLabeller(groups: string[]): (group: string) => string {
  const values = groups.filter((group) => group !== "none" && !group.startsWith("profile:"));
  let prefix = "";
  if (values.length > 1) {
    prefix = values.reduce((common, value) => {
      let index = 0;
      while (index < common.length && common[index] === value[index]) index += 1;
      return common.slice(0, index);
    });
    prefix = prefix.slice(0, prefix.lastIndexOf("_") + 1);
  }
  return (group) => {
    if (group === "none") return "no auth";
    if (group.startsWith("profile:")) return group.slice("profile:".length);
    return group.slice(prefix.length).replaceAll("_", " ").toLowerCase();
  };
}

function passes(method: MethodInfo, filters: MethodFilters): boolean {
  if (filters.hideDeprecated && method.deprecated) return false;
  return filters.auth.length === 0 || filters.auth.includes(authGroup(method));
}

function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function Checkbox({ checked, label, detail, count, onChange }: { checked: boolean; label: string; detail?: string; count?: number; onChange: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-state-hover has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring">
      <input type="checkbox" className="size-3.5 shrink-0 accent-foreground focus-visible:outline-none" checked={checked} onChange={onChange} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{label}</span>
        {detail ? <span className="block truncate text-[11px] text-muted-foreground">{detail}</span> : null}
      </span>
      {count !== undefined ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span> : null}
    </label>
  );
}

function FilterPanel({
  services,
  filters,
  onChange,
  label,
}: {
  services: ServiceInfo[];
  filters: MethodFilters;
  onChange: (filters: MethodFilters) => void;
  label: (group: string) => string;
}) {
  const [serviceQuery, setServiceQuery] = useState("");
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const service of services) for (const method of service.methods) counts.set(authGroup(method), (counts.get(authGroup(method)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [services]);
  const serviceRows = useMemo(() => {
    const terms = serviceQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = services
      .map((service) => ({ service, count: service.methods.filter((method) => passes(method, { ...filters, services: [] })).length }))
      .filter(({ service, count }) => (count > 0 || filters.services.includes(service.typeName)) && terms.every((term) => service.typeName.toLowerCase().includes(term)));
    // Selected APIs first, so the current scope is visible without scrolling.
    return rows.sort((a, b) => Number(filters.services.includes(b.service.typeName)) - Number(filters.services.includes(a.service.typeName)));
  }, [services, filters, serviceQuery]);

  return (
    <div className="flex max-h-[min(32rem,70vh)] flex-col">
      <div className="flex items-center justify-between px-2 pb-1 pt-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Auth type</span>
        {filters.auth.length > 0 ? (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => onChange({ ...filters, auth: [] })}>
            Any
          </button>
        ) : null}
      </div>
      {groups.map(([group, count]) => (
        <Checkbox key={group} checked={filters.auth.includes(group)} label={label(group)} count={count} onChange={() => onChange({ ...filters, auth: toggled(filters.auth, group) })} />
      ))}
      <Checkbox
        checked={filters.hideDeprecated}
        label="Hide deprecated methods"
        onChange={() => onChange({ ...filters, hideDeprecated: !filters.hideDeprecated })}
      />
      <div className="mt-1.5 flex items-center justify-between border-t border-border px-2 pb-1 pt-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          APIs{filters.services.length > 0 ? ` · ${filters.services.length} selected` : ""}
        </span>
        {filters.services.length > 0 ? (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => onChange({ ...filters, services: [] })}>
            All
          </button>
        ) : null}
      </div>
      <div className="px-1 pb-1">
        <input
          className="h-7 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          placeholder="Find an API"
          value={serviceQuery}
          spellCheck={false}
          data-vim-ignore=""
          onChange={(event) => setServiceQuery(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {serviceRows.length === 0 ? <p className="px-2 py-2 text-xs text-muted-foreground">No APIs match.</p> : null}
        {serviceRows.map(({ service, count }) => (
          <Checkbox
            key={service.typeName}
            checked={filters.services.includes(service.typeName)}
            label={shortName(service.typeName)}
            detail={service.typeName.slice(0, service.typeName.lastIndexOf("."))}
            count={count}
            onChange={() => onChange({ ...filters, services: toggled(filters.services, service.typeName) })}
          />
        ))}
      </div>
    </div>
  );
}

function MethodRow({
  method,
  selected,
  detail,
  className,
  style,
  onSelect,
}: {
  method: MethodInfo;
  selected: boolean;
  detail?: string;
  className?: string;
  style?: CSSProperties;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        FOCUS_RING,
        selected ? "bg-state-active text-foreground" : "text-foreground/80 hover:bg-state-hover hover:text-foreground",
        className,
      )}
      style={style}
      title={method.comment ?? method.fullName}
      aria-current={selected ? "true" : undefined}
      data-nav-row="item"
      data-nav-key={`method:${method.fullName}`}
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

export interface MethodListHandle {
  focusSearch: () => void;
  openFilters: () => void;
  /** Clears the search; false when there was none. */
  clearSearch: () => boolean;
}

export function MethodList({
  services,
  selected,
  filterKey,
  handle,
  onSelect,
}: {
  services: ServiceInfo[];
  selected: string | null;
  /** Filters persist per key (the proto source), since services differ between sources. */
  filterKey: string;
  handle: RefObject<MethodListHandle | null>;
  onSelect: (method: MethodInfo) => void;
}) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useStored<MethodFilters>(`filters:${filterKey}`, NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchAll, setSearchAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = selected === null ? undefined : services.find((service) => service.methods.some((method) => method.fullName === selected));
    return new Set(open === undefined ? [] : [open.typeName]);
  });
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(handle, () => ({
    // Like vim's /, a new search replaces the last one; Escape out of it still keeps the old query.
    focusSearch: () => searchRef.current?.select(),
    openFilters: () => setFiltersOpen(true),
    clearSearch: () => {
      if (query === "") return false;
      setQuery("");
      const service = selected === null ? undefined : services.find((entry) => entry.methods.some((method) => method.fullName === selected));
      if (service !== undefined) setExpanded((current) => new Set(current).add(service.typeName));
      return true;
    },
  }));
  useEffect(() => {
    // Only on mount: later selections come from clicks on rows that are already visible.
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
  }, []);
  useEffect(() => setSearchAll(false), [query]);

  const label = useMemo(() => {
    const groups = new Set<string>();
    for (const service of services) for (const method of service.methods) groups.add(authGroup(method));
    return groupLabeller([...groups]);
  }, [services]);

  const total = useMemo(() => services.reduce((count, service) => count + service.methods.length, 0), [services]);
  // Saved APIs that no longer exist in these protos must not hide everything.
  const scope = useMemo(() => {
    const known = new Set(services.map((service) => service.typeName));
    return filters.services.filter((name) => known.has(name));
  }, [services, filters.services]);
  const active = filters.auth.length > 0 || scope.length > 0 || filters.hideDeprecated;
  const visibleServices = useMemo(
    () =>
      services
        .filter((service) => scope.length === 0 || scope.includes(service.typeName))
        .map((service) => ({ service, methods: service.methods.filter((method) => passes(method, filters)) }))
        .filter((entry) => entry.methods.length > 0),
    [services, filters, scope],
  );
  const visibleCount = visibleServices.reduce((count, entry) => count + entry.methods.length, 0);

  const search = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    const matches = (method: MethodInfo) => terms.every((term) => method.fullName.toLowerCase().includes(term));
    const inScope = visibleServices.flatMap((entry) => entry.methods.filter(matches));
    const everywhere = services.flatMap((service) => service.methods.filter(matches));
    return { inScope, everywhere };
  }, [services, visibleServices, query]);
  const results = search === null ? null : searchAll ? search.everywhere : search.inScope;
  const hiddenMatches = search === null ? 0 : search.everywhere.length - search.inScope.length;

  const toggle = (typeName: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(typeName)) next.delete(typeName);
      else next.add(typeName);
      return next;
    });

  const summary = [
    ...filters.auth.map(label),
    ...(scope.length === 1 ? [shortName(scope[0]!)] : scope.length > 1 ? [`${scope.length} APIs`] : []),
    ...(filters.hideDeprecated ? ["no deprecated"] : []),
  ].join(" · ");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 px-2 pb-1.5 pt-2">
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-7 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              placeholder={active ? `Search ${visibleCount} of ${total} methods` : `Search ${total} methods`}
              value={query}
              spellCheck={false}
              // A filter box, like a palette's: vim editing would take its Escape and arrows.
              data-vim-ignore=""
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                const rows = listRef.current?.querySelectorAll<HTMLElement>(NAV_ROW);
                if (event.key === "Escape") {
                  event.preventDefault();
                  if (query !== "") setQuery("");
                  else {
                    const cursor = listRef.current?.querySelector<HTMLElement>(`${NAV_ROW}[aria-current="true"]`) ?? rows?.[0];
                    if (cursor) focusRow(cursor);
                  }
                }
                if (event.key === "ArrowDown" && rows?.[0]) {
                  event.preventDefault();
                  focusRow(rows[0]);
                }
                if (event.key === "Enter" && results?.length) {
                  onSelect(results[0]!);
                  // Leaves the search with the cursor on the match, so j/k carry on through the rest.
                  if (rows?.[0]) focusRow(rows[0]);
                }
              }}
            />
            {query !== "" ? (
              <button
                type="button"
                className={cx("absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground", enter.fade, speed.fast, PRESS)}
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <Icon name="X" className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Popover
            open={filtersOpen}
            onOpenChange={setFiltersOpen}
            label="Method filters"
            className="w-80"
            trigger={
              <button
                type="button"
                className={cn(
                  "flex h-8 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-state-hover hover:text-foreground",
                  PRESS,
                  (active || filtersOpen) && "bg-state-active text-foreground",
                )}
                aria-label="Filter methods"
                aria-expanded={filtersOpen}
                title="Filter methods"
                onClick={() => setFiltersOpen(!filtersOpen)}
              >
                <Icon name="FilterHorizontal" className="size-4" />
              </button>
            }
          >
            <FilterPanel services={services} filters={{ ...filters, services: scope }} onChange={setFilters} label={label} />
          </Popover>
        </div>
        {active ? (
          <div className={cx("flex items-center gap-1.5 px-1 text-xs", enter.fade, speed.fast)}>
            <button type="button" className="min-w-0 flex-1 truncate text-left text-foreground/80 hover:text-foreground" title={summary} onClick={() => setFiltersOpen(true)}>
              {summary}
            </button>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {visibleCount}/{total}
            </span>
            <button
              type="button"
              className={cx("shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground", PRESS)}
              aria-label="Clear filters"
              title="Clear filters"
              onClick={() => setFilters(NO_FILTERS)}
            >
              <Icon name="X" className="size-3.5" />
            </button>
          </div>
        ) : null}
        {results !== null ? (
          <p className={cx("px-1 text-xs text-muted-foreground", enter.fade, speed.fast)}>
            {results.length} match{results.length === 1 ? "" : "es"}
            {searchAll && active ? " across all APIs" : ""}
            {results.length > 0 ? " · Enter opens the first" : ""}
          </p>
        ) : null}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {results !== null ? (
          <>
            {results.length === 0 && hiddenMatches === 0 ? <p className="px-2 py-6 text-center text-sm text-muted-foreground">No methods match “{query}”.</p> : null}
            {results.map((method) => (
              <MethodRow
                key={method.fullName}
                method={method}
                selected={method.fullName === selected}
                detail={method.fullName.slice(0, method.fullName.indexOf("/"))}
                onSelect={() => onSelect(method)}
              />
            ))}
            {!searchAll && hiddenMatches > 0 ? (
              <button
                type="button"
                className={cn("mt-1 w-full rounded-md px-2 py-2 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground", FOCUS_RING)}
                data-nav-row="item"
                data-nav-key="search-all"
                onClick={() => setSearchAll(true)}
              >
                {results.length === 0 ? "No matches in your filters. " : ""}Show {hiddenMatches} more outside your filters
              </button>
            ) : null}
          </>
        ) : visibleServices.length === 0 ? (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
            <p>No methods match these filters.</p>
            <button type="button" className="mt-2 text-xs underline-offset-2 hover:text-foreground hover:underline" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
          </div>
        ) : (
          visibleServices.map(({ service, methods }) => {
            const open = expanded.has(service.typeName) || visibleServices.length === 1;
            const containsSelected = methods.some((method) => method.fullName === selected);
            const focused = scope.length === 1 && scope[0] === service.typeName;
            return (
              <div key={service.typeName} data-nav-group="">
                <div className={cx("flex items-center rounded-md hover:bg-state-hover", REVEAL_HOST)}>
                  <button
                    type="button"
                    className={cn("flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left", FOCUS_RING)}
                    title={`${service.typeName}${service.comment ? `\n\n${service.comment}` : ""}`}
                    onClick={() => toggle(service.typeName)}
                    aria-expanded={open}
                    data-nav-row="group"
                    data-nav-key={`service:${service.typeName}`}
                    data-bbm-open={open}
                  >
                    <Icon name="ChevronRight" className={cx("size-3.5 shrink-0 text-muted-foreground", CHEVRON)} />
                    <span className={cn("min-w-0 flex-1 truncate text-sm font-medium", containsSelected ? "text-foreground" : "text-foreground/90")}>
                      {shortName(service.typeName)}
                    </span>
                  </button>
                  {focused ? null : (
                    <button
                      type="button"
                      className={cx("shrink-0 rounded p-1 text-muted-foreground hover:text-foreground", REVEAL)}
                      aria-label={`Show only ${shortName(service.typeName)}`}
                      title="Show only this API"
                      onClick={() => setFilters({ ...filters, services: [service.typeName] })}
                    >
                      <Icon name="Target" className="size-3.5" />
                    </button>
                  )}
                  <span className="w-7 shrink-0 pr-1.5 text-right text-xs tabular-nums text-muted-foreground">{methods.length}</span>
                </div>
                {open ? (
                  <div className="mb-1 ml-3 border-l border-border pl-1.5">
                    {methods.map((method, index) => (
                      <MethodRow
                        key={method.fullName}
                        method={method}
                        selected={method.fullName === selected}
                        className={cx(enter.rise, speed.fast, STAGGER)}
                        style={stagger(index)}
                        onSelect={() => onSelect(method)}
                      />
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
