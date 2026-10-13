import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import { POPOVER_MOTION } from "bb-motion";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { toastError } from "./actions";
import { type ProjectOption, useCreateProjectFromFolder } from "./data";

const PREFIX_TIMEOUT_MS = 500;
const NONE_LABEL = "No project (no thread)";

type Row = { kind: "none" } | { kind: "project"; project: ProjectOption } | { kind: "new" };

function rowKey(row: Row): string {
  return row.kind === "project" ? row.project.id : row.kind;
}

/**
 * A project picker whose open list takes vim keys, which a native select's popup never sees: j/k or the arrows move,
 * gg/G jump to the ends, Ctrl-D/Ctrl-U move half a list, Enter picks, / or i filters, and Escape closes (or leaves
 * the filter box). It starts with "New project from folder…", which makes a project of a directory picked in the native
 * folder dialog and selects it.
 */
export function ProjectSelect({
  projects,
  value,
  onChange,
  allowNone,
  className,
}: {
  projects: ProjectOption[];
  value: string;
  onChange: (value: string) => void;
  allowNone: boolean;
  className?: string;
}) {
  const createProject = useCreateProjectFromFolder();
  const [creating, setCreating] = useState(false);
  // Shown until the refetched project list catches up, so the picker can display the new project at once.
  const [created, setCreated] = useState<ProjectOption | null>(null);
  const [open, setOpen] = useState(false);
  /** Null until / opens the filter box; it stays applied after Escape leaves the box. */
  const [filter, setFilter] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const pendingG = useRef(0);
  const listId = useId();
  const portalScope = usePortalScopeProps();

  const options = created === null || projects.some((project) => project.id === created.id) ? projects : [...projects, created];
  const current = options.find((project) => project.id === value);
  const query = filter?.trim().toLowerCase() ?? "";
  const rows: Row[] = [
    { kind: "new" },
    ...(allowNone && query === "" ? [{ kind: "none" } as const] : []),
    ...options.filter((project) => project.name.toLowerCase().includes(query)).map((project) => ({ kind: "project", project }) as const),
  ];
  const active = Math.min(highlight, rows.length - 1);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = (next: boolean) => {
    if (next && creating) return;
    if (next) {
      setFilter(null);
      const at = rows.findIndex((row) => (row.kind === "project" ? row.project.id === value : row.kind === "none" && value === ""));
      setHighlight(Math.max(0, at));
    }
    setOpen(next);
  };

  const create = () => {
    setCreating(true);
    createProject()
      .then((project) => {
        if (project === null) return;
        setCreated(project);
        onChange(project.id);
        toast.success(`Created project ${project.name}`);
      }, toastError)
      .finally(() => setCreating(false));
  };

  const pick = (row: Row | undefined) => {
    if (row === undefined) return;
    setOpen(false);
    if (row.kind === "new") create();
    else if (row.kind === "none") onChange("");
    else if (row.project.id !== value) onChange(row.project.id);
  };

  const halfPage = () => {
    const node = list.current;
    const item = node?.querySelector<HTMLElement>('[role="option"]');
    if (node == null || item == null || item.offsetHeight === 0) return 1;
    return Math.max(1, Math.floor(node.clientHeight / item.offsetHeight / 2));
  };

  /** Keys the list and the filter box both take; returns whether the key was one. */
  const sharedKey = (key: string): boolean => {
    const last = rows.length - 1;
    const moves: Record<string, () => void> = {
      ArrowDown: () => setHighlight(Math.min(active + 1, last)),
      ArrowUp: () => setHighlight(Math.max(active - 1, 0)),
      Enter: () => pick(rows[active]),
    };
    moves[key]?.();
    return moves[key] !== undefined;
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    const last = rows.length - 1;
    let handled = true;
    if (event.ctrlKey) {
      if (event.key === "d") setHighlight(Math.min(active + halfPage(), last));
      else if (event.key === "u") setHighlight(Math.max(active - halfPage(), 0));
      else handled = false;
    } else if (event.key === "g") {
      if (event.timeStamp - pendingG.current <= PREFIX_TIMEOUT_MS) {
        pendingG.current = 0;
        setHighlight(0);
      } else {
        pendingG.current = event.timeStamp;
      }
    } else {
      pendingG.current = 0;
      switch (event.key) {
        case "j":
          setHighlight(Math.min(active + 1, last));
          break;
        case "k":
          setHighlight(Math.max(active - 1, 0));
          break;
        case "G":
        case "End":
          setHighlight(last);
          break;
        case "Home":
          setHighlight(0);
          break;
        case "/":
        case "i":
          setFilter(filter ?? "");
          // The box mounts with this render when it is new.
          requestAnimationFrame(() => filterInput.current?.select());
          break;
        default:
          handled = sharedKey(event.key);
      }
    }
    if (!handled) return;
    event.preventDefault();
    // The card panel and the board would also act on these motions; the open list owns them.
    event.stopPropagation();
  };

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    if (sharedKey(event.key)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={show}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Project"
          aria-haspopup="listbox"
          className={cn(
            "flex h-9 w-full min-w-0 items-center gap-1.5 rounded-md border border-input bg-transparent px-2 text-left text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className,
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate", (creating || current === undefined) && "text-muted-foreground")}>
            {creating ? "Choosing a folder…" : (current?.name ?? (allowNone && value === "" ? NONE_LABEL : "Choose a project"))}
          </span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalScope}
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            "z-50 flex max-h-80 min-w-56 max-w-80 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg",
            POPOVER_MOTION,
          )}
          style={{ width: "var(--radix-popover-trigger-width)" }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            list.current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            // The first Escape leaves the filter box with its filter applied; the next closes the list.
            if (document.activeElement !== filterInput.current) return;
            event.preventDefault();
            list.current?.focus({ preventScroll: true });
          }}
        >
          {filter !== null ? (
            <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
              <span className="font-mono text-xs text-muted-foreground">/</span>
              <input
                ref={filterInput}
                autoFocus
                className="h-6 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                placeholder="Filter projects"
                aria-label="Filter projects"
                aria-controls={listId}
                value={filter}
                spellCheck={false}
                data-vim-ignore=""
                onChange={(event) => {
                  setFilter(event.target.value);
                  // The first match, under the always-present "New project" row.
                  setHighlight(1);
                }}
                onKeyDown={onFilterKeyDown}
              />
            </div>
          ) : null}
          <div
            ref={list}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label="Projects"
            aria-activedescendant={`${listId}-${active}`}
            className="min-h-0 flex-1 overflow-y-auto p-1 focus:outline-none"
            onKeyDown={onListKeyDown}
          >
            {rows.map((row, index) => {
              const selected = row.kind === "project" ? row.project.id === value : row.kind === "none" && value === "";
              return (
                <div
                  key={rowKey(row)}
                  id={`${listId}-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    index === active && "bg-state-hover",
                    row.kind !== "project" && "text-muted-foreground",
                    row.kind === "new" && "mb-1 border-b border-border",
                  )}
                  onPointerMove={() => setHighlight(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => pick(row)}
                >
                  {row.kind === "new" ? <Icon name="FolderPlus" className="size-3.5 shrink-0" /> : null}
                  <span className="min-w-0 flex-1 truncate">
                    {row.kind === "project" ? row.project.name : row.kind === "none" ? NONE_LABEL : "New project from folder…"}
                  </span>
                  {selected ? <Icon name="Check" className="size-3.5 shrink-0" /> : null}
                </div>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
