import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { DiffFile } from "../../types";
import { Badge } from "../ui/badge";
import { CHEVRON, FAST, STAGGER, enter, stagger } from "../ui/motion";
import { cn } from "../utils";
import { isGeneratedFile } from "../generated";
import { RISK_DOT, riskTint } from "../risk";
import { buildFileTree, type FileTreeDir } from "./build-file-tree";
import { keyToken } from "../keys/keymap";

/** Row positions handed out in render order, so a cascade runs top to bottom from wherever it starts. */
interface Cascade {
  next: number;
}

const ROW_ENTER = cn(enter.rise, FAST, STAGGER);
const ROW_FOCUS = "outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70";
/** As the diff's `gg`: how long the first `g` waits for the second. */
const PENDING_TIMEOUT_MS = 1000;

/** A truncating label whose tooltip (the full text, plus optional extra lines) appears only when the text is actually clipped. */
function TruncatedName({ text, full, className, extra }: { text: string; full: string; className?: string; extra?: string | null }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const show = () => {
    const node = ref.current;
    if (node !== null && (node.scrollWidth > node.clientWidth + 1 || text !== full)) setOpen(true);
  };
  return (
    <Tooltip.Root open={open} onOpenChange={(next) => (next ? show() : setOpen(false))} delayDuration={250}>
      <Tooltip.Trigger asChild>
        <span ref={ref} className={cn("min-w-0 flex-1 truncate font-mono", className)}>
          {text}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="right" sideOffset={6} className="z-50 max-w-[80vw] rounded-md border border-border bg-popover px-2 py-1 font-mono text-xs text-popover-foreground shadow-md">
          {full}
          {extra !== null && extra !== undefined ? <div className="mt-0.5 font-sans text-muted-foreground">{extra}</div> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function FileTree({
  files,
  activePath,
  viewed,
  commentCount,
  findingCount,
  risk,
  changedSince,
  onSelect,
  onLeave,
  onHide,
}: {
  files: DiffFile[];
  activePath: string | null;
  viewed: ReadonlySet<string>;
  commentCount: (path: string) => number;
  findingCount: (path: string) => number;
  risk: (path: string) => number | null;
  changedSince: (path: string) => boolean;
  onSelect: (path: string) => void;
  /** Hands the keyboard back to the diff. */
  onLeave: () => void;
  onHide: () => void;
}) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  // The folder opened last cascades its rows from its own top instead of from the top of the tree.
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const toggle = (path: string) => {
    if (closed.has(path)) setLastOpened(path);
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const pendingG = useRef(0);
  // Vim keys over the visible rows, in the order they are drawn; Enter is the focused button's own click.
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const token = keyToken(event);
    if (token === null) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-tree-row]"));
    const current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-tree-row]") : null;
    const index = current === null ? -1 : rows.indexOf(current);
    const focusRow = (next: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
      row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    };
    const isDir = current?.dataset.treeRow === "dir";
    const isOpen = current?.getAttribute("aria-expanded") === "true";
    const halfList = Math.max(1, Math.floor((event.currentTarget.parentElement?.clientHeight ?? 0) / (current?.offsetHeight || 24) / 2));
    const secondG = token === "g" && performance.now() - pendingG.current < PENDING_TIMEOUT_MS;
    pendingG.current = token === "g" && !secondG ? performance.now() : 0;
    switch (token) {
      case "j":
      case "<Down>":
        focusRow(index + 1);
        break;
      case "k":
      case "<Up>":
        focusRow(index - 1);
        break;
      case "g":
        if (secondG) focusRow(0);
        break;
      case "G":
        focusRow(rows.length - 1);
        break;
      case "<C-d>":
        focusRow(index + halfList);
        break;
      case "<C-u>":
        focusRow(index - halfList);
        break;
      case "l":
      case "<Right>":
        if (isDir && isOpen) focusRow(index + 1);
        else current?.click();
        break;
      case "h":
      case "<Left>":
        if (isDir && isOpen) current?.click();
        else current?.closest("li")?.parentElement?.closest("li")?.querySelector<HTMLButtonElement>(":scope > [data-tree-row]")?.focus();
        break;
      case "<Esc>":
        onLeave();
        break;
      case "t":
        onHide();
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  const renderDir = (dir: FileTreeDir, depth: number, cascade: Cascade): ReactNode => {
    const isClosed = closed.has(dir.path);
    return (
      <li key={`dir:${dir.path}`}>
        <button
          type="button"
          onClick={() => toggle(dir.path)}
          className={cn("flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs text-muted-foreground hover:bg-state-hover", ROW_ENTER, ROW_FOCUS)}
          style={{ paddingLeft: 8 + depth * 12, ...stagger(cascade.next++) }}
          data-tree-row="dir"
          aria-expanded={!isClosed}
          data-bbm-open={!isClosed}
        >
          <Icon name="ChevronRight" className={cn("size-3 shrink-0", CHEVRON)} />
          <TruncatedName text={dir.name} full={dir.path} />
          <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{dir.additions}</span>
          <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">−{dir.deletions}</span>
        </button>
        {isClosed ? null : <ul>{renderChildren(dir, depth + 1, dir.path === lastOpened ? { next: 0 } : cascade)}</ul>}
      </li>
    );
  };
  const renderFile = (file: DiffFile, depth: number, cascade: Cascade): ReactNode => {
    const count = commentCount(file.path);
    const isViewed = viewed.has(file.path);
    const generated = isGeneratedFile(file);
    const name = file.path.split("/").pop() ?? file.path;
    const fileRisk = isViewed ? null : risk(file.path);
    return (
      <li key={file.path}>
        <button
          type="button"
          onClick={() => onSelect(file.path)}
          className={cn("flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs hover:bg-state-hover", ROW_ENTER, riskTint(fileRisk), file.path === activePath && "bg-state-active", ROW_FOCUS)}
          style={{ paddingLeft: 8 + depth * 12 + 16, ...stagger(cascade.next++) }}
          data-tree-row="file"
          data-file-tree-path={file.path}
        >
          {isViewed ? <Icon name="Check" className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" /> : fileRisk !== null ? <span className={cn("size-1.5 shrink-0 rounded-full", RISK_DOT[fileRisk])} aria-hidden="true" /> : null}
          {changedSince(file.path) ? <span className="shrink-0 rounded border border-sky-500/50 px-1 text-[10px] text-sky-700 dark:text-sky-300" title="Changed since you last looked">changed</span> : null}
          <TruncatedName
            text={name}
            full={file.path}
            extra={fileRisk === null ? null : `review attention ${fileRisk}/5`}
            className={cn((isViewed || generated) && "text-muted-foreground", isViewed && "line-through decoration-muted-foreground/50")}
          />
          {generated ? <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">gen</span> : null}
          {findingCount(file.path) > 0 ? <Badge tone="danger" title="Review findings in this file">{findingCount(file.path)}</Badge> : null}
          {count > 0 ? <Badge tone="warning">{count}</Badge> : null}
          <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
          <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">−{file.deletions}</span>
        </button>
      </li>
    );
  };
  const renderChildren = (dir: FileTreeDir, depth: number, cascade: Cascade): ReactNode[] => [
    ...dir.dirs.map((child) => renderDir(child, depth, cascade)),
    ...dir.files.map((file) => renderFile(file, depth, cascade)),
  ];
  return (
    <Tooltip.Provider>
      <ul onKeyDown={onKeyDown}>{renderChildren(tree, 0, { next: 0 })}</ul>
    </Tooltip.Provider>
  );
}
