import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DiffFile } from "../../types";
import { cn } from "../utils";
import { FAST, enter } from "../ui/motion";
import { KEY_HELP } from "./keymap";
import { rankFiles } from "./rank-files";

const PANEL = "absolute inset-x-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg";

/** The `?` sheet. Escape, `?` or `q` closes it. */
export function KeyHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label="Keyboard shortcuts"
      className={cn(PANEL, "outline-none", enter.drop, FAST)}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "?" || event.key === "q") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-medium">
        Keyboard shortcuts
        <span className="ml-auto text-xs font-normal text-muted-foreground">Esc to close · work anywhere in the diff outside a text box</span>
      </div>
      <div className="grid gap-x-6 gap-y-4 overflow-y-auto p-3 text-xs @2xl:grid-cols-3">
        {KEY_HELP.map(({ group, keys }) => (
          <section key={group} className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group}</h3>
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1">
              {keys.map(({ keys: combo, action }) => (
                <div key={action} className="contents">
                  <dt className="flex gap-1">
                    {combo.map((key) => (
                      <kbd key={key} className="min-w-5 rounded border border-border bg-muted px-1 py-px text-center font-mono text-[11px]">
                        {key}
                      </kbd>
                    ))}
                  </dt>
                  <dd className="text-muted-foreground">{action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}

export interface PickerItem {
  id: string;
  label: string;
  detail?: ReactNode;
}

/** A list filtered as you type: ↑/↓ (or ⌃n/⌃p) to choose, Enter to pick, Escape to close. */
export function Picker({
  label,
  placeholder,
  initialQuery = "",
  rank,
  onPick,
  onClose,
}: {
  label: string;
  placeholder: string;
  initialQuery?: string;
  rank: (query: string) => PickerItem[];
  onPick: (id: string, query: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const matches = rank(query);
  const chosen = Math.min(index, Math.max(0, matches.length - 1));
  useEffect(() => {
    listRef.current?.children[chosen]?.scrollIntoView({ block: "nearest" });
  }, [chosen]);
  return (
    <div role="dialog" aria-label={label} className={cn(PANEL, enter.drop, FAST)}>
      <input
        autoFocus
        // Vim keys would take Escape and the arrows; this box has its own.
        data-vim-ignore=""
        value={query}
        placeholder={placeholder}
        aria-label={label}
        className="border-b border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onBlur={onClose}
        onKeyDown={(event) => {
          const down = event.key === "ArrowDown" || (event.ctrlKey && event.key === "n");
          const up = event.key === "ArrowUp" || (event.ctrlKey && event.key === "p");
          if (!down && !up && event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (down) setIndex(Math.min(matches.length - 1, chosen + 1));
          else if (up) setIndex(Math.max(0, chosen - 1));
          else if (event.key === "Enter" && matches[chosen] !== undefined) onPick(matches[chosen].id, query);
          else onClose();
        }}
      />
      <ul ref={listRef} className="overflow-y-auto py-1 text-xs" role="listbox" aria-label={label}>
        {matches.length === 0 ? <li className="px-3 py-1.5 text-muted-foreground">No matches</li> : null}
        {matches.map((item, position) => (
          <li
            key={item.id}
            role="option"
            aria-selected={position === chosen}
            className={cn("flex cursor-pointer items-center gap-2 px-3 py-1 font-mono", position === chosen ? "bg-state-active text-foreground" : "text-muted-foreground")}
            onPointerDown={(event) => {
              event.preventDefault();
              onPick(item.id, query);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `/` over the diff's files, best file-name matches first. */
export function fileItems(files: readonly DiffFile[], query: string): PickerItem[] {
  return rankFiles(files, query).map((file) => ({
    id: file.path,
    label: file.path,
    detail: (
      <>
        <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
        <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">−{file.deletions}</span>
      </>
    ),
  }));
}
