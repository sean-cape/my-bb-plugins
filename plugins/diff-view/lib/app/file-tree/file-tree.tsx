import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { DiffFile } from "../../types";
import { Badge } from "../ui/badge";
import { CHEVRON, FAST, STAGGER, enter, stagger } from "../ui/motion";
import { cn } from "../utils";
import { isGeneratedFile } from "../generated";
import { RISK_DOT } from "../risk";
import { buildFileTree, type FileTreeDir } from "./build-file-tree";
import { runListMotion, runListScroll, useKeyHandler } from "../ui/vim-keys";
import { FILE_TREE_KEYMAP, type FileTreeCommand } from "../keys/keymap";
import { ChangeCounts, FileGlyph, FileStatusLetter } from "../file-marks";
import { useNerdFont } from "../ui/nerd-font";

/** Row positions handed out in render order, so a cascade runs top to bottom from wherever it starts. */
interface Cascade {
  next: number;
}

const ROW_ENTER = cn(enter.rise, FAST, STAGGER);
const ROW_FOCUS = "outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70";
/** The key of the "Changed since" group, which no directory path can be. */
const NEW_GROUP = "\0new";

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
  /** What the files changed since the last review count from ("r2"), listed again in a group of their own at the top; null when none did. */
  changedSince: { label: string; has: (path: string) => boolean } | null;
  onSelect: (path: string) => void;
  /** Hands the keyboard back to the diff. */
  onLeave: () => void;
  onHide: () => void;
}) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const nerdFont = useNerdFont();
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
  const listRef = useRef<HTMLUListElement | null>(null);
  // Before the review keys, so j and k move here and a count typed here stays here; Enter is the focused row's own click.
  const onKeyDown = useKeyHandler<FileTreeCommand>({
    keymap: FILE_TREE_KEYMAP,
    counts: true,
    onCommand: (command, { count }) => {
      const list = listRef.current;
      if (list === null) return false;
      switch (command.kind) {
        case "list":
          return runListMotion(list, command.motion, { count });
        case "scroll":
          return runListScroll(list, command.step, 0.5);
        case "leave":
          onLeave();
          return;
        case "hide":
          onHide();
          return;
      }
    },
  });
  const renderDir = (dir: FileTreeDir, depth: number, cascade: Cascade): ReactNode => {
    const isClosed = closed.has(dir.path);
    return (
      <li key={`dir:${dir.path}`} data-nav-group="">
        <button
          type="button"
          onClick={() => toggle(dir.path)}
          className={cn("flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs font-medium text-muted-foreground hover:bg-state-hover", ROW_ENTER, ROW_FOCUS)}
          style={{ paddingLeft: 8 + depth * 12, ...stagger(cascade.next++) }}
          data-nav-row="group"
          aria-expanded={!isClosed}
          data-bbm-open={!isClosed}
        >
          <Icon name="ChevronRight" className={cn("size-3 shrink-0", CHEVRON)} />
          <TruncatedName text={dir.name} full={dir.path} />
          <ChangeCounts additions={dir.additions} deletions={dir.deletions} className="font-normal opacity-70" />
        </button>
        {isClosed ? null : <ul>{renderChildren(dir, depth + 1, dir.path === lastOpened ? { next: 0 } : cascade)}</ul>}
      </li>
    );
  };
  const renderFile = (file: DiffFile, depth: number, cascade: Cascade, group = ""): ReactNode => {
    const count = commentCount(file.path);
    const isViewed = viewed.has(file.path);
    const generated = isGeneratedFile(file);
    const name = file.path.split("/").pop() ?? file.path;
    const fileRisk = isViewed ? null : risk(file.path);
    return (
      <li key={`${group}${file.path}`}>
        <button
          type="button"
          onClick={() => onSelect(file.path)}
          className={cn("flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs hover:bg-state-hover", ROW_ENTER, file.path === activePath && "bg-state-active", ROW_FOCUS)}
          style={{ paddingLeft: 8 + depth * 12 + 16, ...stagger(cascade.next++) }}
          data-nav-row="item"
          data-file-tree-path={file.path}
        >
          <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden={isViewed ? undefined : "true"}>
            {isViewed ? <Icon name="Check" className="size-3 text-emerald-600 dark:text-emerald-400" /> : fileRisk !== null ? <span className={cn("size-1.5 rounded-full", RISK_DOT[fileRisk])} /> : null}
          </span>
          {nerdFont ? <FileGlyph file={file} className={cn("text-[13px]", (isViewed || generated) && "opacity-50")} /> : null}
          <TruncatedName
            text={name}
            full={file.path}
            extra={fileRisk === null ? null : `review attention ${fileRisk}/5`}
            className={cn((isViewed || generated) && "text-muted-foreground", isViewed && "line-through decoration-muted-foreground/50")}
          />
          <span className="flex shrink-0 items-center gap-1">
            {group === "" && changedSince?.has(file.path) === true ? <span className="rounded border border-sky-500/40 px-1 text-[10px] leading-4 text-sky-700 dark:text-sky-300" title={`Changed since ${changedSince.label}`}>new</span> : null}
            {generated ? <span className="rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">gen</span> : null}
            {findingCount(file.path) > 0 ? <Badge tone="danger" title="Review findings in this file">{findingCount(file.path)}</Badge> : null}
            {count > 0 ? <Badge tone="warning" title="Open comment threads in this file">{count}</Badge> : null}
            {nerdFont ? null : <FileStatusLetter file={file} />}
          </span>
          <ChangeCounts additions={file.additions} deletions={file.deletions} />
        </button>
      </li>
    );
  };
  const renderChildren = (dir: FileTreeDir, depth: number, cascade: Cascade): ReactNode[] => [
    ...dir.dirs.map((child) => renderDir(child, depth, cascade)),
    ...dir.files.map((file) => renderFile(file, depth, cascade)),
  ];
  const changed = changedSince === null ? [] : files.filter((file) => changedSince.has(file.path));
  const cascade: Cascade = { next: 0 };
  const newGroupClosed = closed.has(NEW_GROUP);
  return (
    <Tooltip.Provider>
      <ul ref={listRef} onKeyDown={onKeyDown}>
        {/* Every file changed since is the tree itself again; the rows' "new" marks say it. */}
        {changedSince !== null && changed.length > 0 && changed.length < files.length ? (
          <li key={NEW_GROUP} data-nav-group="" className="mb-1 border-b border-border/60 pb-1">
            <button
              type="button"
              onClick={() => toggle(NEW_GROUP)}
              className={cn("flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs font-medium text-sky-700 hover:bg-state-hover dark:text-sky-300", ROW_ENTER, ROW_FOCUS)}
              style={{ paddingLeft: 8, ...stagger(cascade.next++) }}
              data-nav-row="group"
              aria-expanded={!newGroupClosed}
              data-bbm-open={!newGroupClosed}
              title={`The files that changed since ${changedSince.label}, again in the tree below`}
            >
              <Icon name="ChevronRight" className={cn("size-3 shrink-0", CHEVRON)} />
              <span className="min-w-0 flex-1 truncate">Changed since {changedSince.label}</span>
              <span className="tabular-nums opacity-80">{changed.length}</span>
            </button>
            {newGroupClosed ? null : <ul>{changed.map((file) => renderFile(file, 0, cascade, NEW_GROUP))}</ul>}
          </li>
        ) : null}
        {renderChildren(tree, 0, cascade)}
      </ul>
    </Tooltip.Provider>
  );
}
