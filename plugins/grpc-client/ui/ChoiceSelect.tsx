import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cx, enter, exit, speed, usePresence } from "bb-motion";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { NAV_ROW } from "./client-keys";
import { matchesQuery } from "./filter";
import { useInertWhileClosing } from "./hooks";

export interface Choice {
  value: string;
  label: string;
  title?: string;
}

const EMPTY_LABEL = "—";
/** Matches the list's max-h-64. */
const LIST_MAX_HEIGHT = 256;
const LIST_GAP = 4;

/**
 * Where the list goes: under the box, or above it when the box sits low. It is portaled so the
 * request pane's scrolling and the split pane's clipping don't cut it off.
 */
function listPosition(trigger: HTMLElement): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom;
  const up = below < LIST_MAX_HEIGHT + LIST_GAP && rect.top > below;
  return {
    position: "fixed",
    left: rect.left,
    minWidth: rect.width,
    maxHeight: Math.min(LIST_MAX_HEIGHT, (up ? rect.top : below) - 2 * LIST_GAP),
    ...(up ? { bottom: window.innerHeight - rect.top + LIST_GAP } : { top: rect.bottom + LIST_GAP }),
  };
}

/**
 * A select whose open list takes vim keys, which a native select's popup never sees: j/k or the
 * arrows move, g/G jump to the ends, Enter or Space picks, / filters, and Escape closes without
 * changing it. Closing from the keyboard hands the cursor back to the field row.
 */
export function ChoiceSelect({
  value,
  choices,
  onChange,
  className,
}: {
  /** "" is unset. */
  value: string;
  choices: Choice[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const options: Choice[] = [{ value: "", label: EMPTY_LABEL }, ...choices];
  const [open, setOpen] = useState(false);
  /** Null until / opens the filter box; it stays applied after Escape leaves the box. */
  const [filter, setFilter] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const presence = usePresence(open);
  useInertWhileClosing(root, panel, presence.exiting);
  const listId = useId();
  const portalScope = usePortalScopeProps();
  const current = options.find((option) => option.value === value);
  const visible = filter === null || filter.trim() === "" ? options : options.filter((option) => option.value !== "" && matchesQuery(option.label, filter));
  const [position, setPosition] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || trigger.current === null) return;
    const place = () => {
      if (trigger.current !== null) setPosition(listPosition(trigger.current));
    };
    place();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  useEffect(() => {
    if (open) panel.current?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const show = () => {
    setFilter(null);
    setHighlight(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };
  const close = (backToRow: boolean) => {
    setOpen(false);
    const row = trigger.current?.parentElement?.closest<HTMLElement>(NAV_ROW);
    if (backToRow && row != null) row.focus({ preventScroll: true });
    else trigger.current?.focus({ preventScroll: true });
  };
  const pick = (index: number, backToRow: boolean) => {
    const option = visible[index];
    if (option !== undefined && option.value !== value) onChange(option.value);
    close(backToRow);
  };
  const startFilter = () => {
    setFilter(filter ?? "");
    // The box mounts with this render when it is new.
    requestAnimationFrame(() => filterInput.current?.select());
  };

  /** Keys both the box and the filter take; returns whether the key was one. */
  const listKey = (key: string): boolean => {
    const last = visible.length - 1;
    const moves: Record<string, () => void> = {
      ArrowDown: () => setHighlight(Math.min(highlight + 1, last)),
      ArrowUp: () => setHighlight(Math.max(highlight - 1, 0)),
      Home: () => setHighlight(0),
      End: () => setHighlight(last),
      Enter: () => pick(highlight, true),
    };
    moves[key]?.();
    return moves[key] !== undefined;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open || event.metaKey || event.ctrlKey || event.altKey) return;
    const last = visible.length - 1;
    const moves: Record<string, () => void> = {
      j: () => setHighlight(Math.min(highlight + 1, last)),
      k: () => setHighlight(Math.max(highlight - 1, 0)),
      g: () => setHighlight(0),
      G: () => setHighlight(last),
      " ": () => pick(highlight, true),
      "/": startFilter,
      Escape: () => close(true),
    };
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const move = moves[event.key];
    if (move === undefined && !["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault();
    // Escape and the motions would also reach the view's keys; this list owns them while open.
    event.stopPropagation();
    if (move !== undefined) move();
    else listKey(event.key);
  };

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.metaKey || event.altKey) return;
    if (event.key === "Escape") {
      // Leaves the box with the filter applied, so j/k carry on through the matches.
      event.preventDefault();
      event.stopPropagation();
      trigger.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (listKey(event.key)) event.preventDefault();
  };

  return (
    <div ref={root} className={cn("relative min-w-0", className)}>
      <button
        ref={trigger}
        type="button"
        data-choice=""
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && visible.length > 0 ? `${listId}-${highlight}` : undefined}
        title={current?.title}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className={cn("min-w-0 flex-1 truncate", current === undefined || current.value === "" ? "text-muted-foreground" : null)}>
          {current?.label ?? value}
        </span>
        <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {presence.mounted
        ? createPortal(
            <div {...portalScope}>
              <div
                ref={panel}
                aria-hidden={presence.exiting || undefined}
                style={position}
                className={cx(
                  "z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg",
                  presence.exiting ? exit.fade : cx(enter.drop, speed.fast),
                )}
                onAnimationEnd={presence.onAnimationEnd}
              >
                {filter !== null ? (
                  <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
                    <span className="font-mono text-xs text-muted-foreground">/</span>
                    <input
                      ref={filterInput}
                      autoFocus
                      className="h-6 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                      placeholder="Filter"
                      value={filter}
                      spellCheck={false}
                      aria-controls={listId}
                      aria-activedescendant={visible.length > 0 ? `${listId}-${highlight}` : undefined}
                      data-vim-ignore=""
                      onChange={(event) => {
                        setFilter(event.target.value);
                        setHighlight(0);
                      }}
                      onKeyDown={onFilterKeyDown}
                    />
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {visible.length}/{choices.length}
                    </span>
                  </div>
                ) : null}
                <div id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
                  {visible.length === 0 ? <p className="px-2 py-1 text-sm text-muted-foreground">No matches</p> : null}
                  {visible.map((option, index) => (
                    <div
                      key={option.value}
                      id={`${listId}-${index}`}
                      data-index={index}
                      role="option"
                      aria-selected={option.value === value}
                      title={option.title}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-2 py-1 text-sm",
                        index === highlight ? "bg-state-hover text-foreground" : "text-foreground/80",
                        option.value === "" && "text-muted-foreground",
                      )}
                      onPointerMove={() => setHighlight(index)}
                      // Picking with the pointer must not blur the trigger first.
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => pick(index, false)}
                    >
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.value === value && option.value !== "" ? <Icon name="Check" className="size-3.5 shrink-0" /> : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
