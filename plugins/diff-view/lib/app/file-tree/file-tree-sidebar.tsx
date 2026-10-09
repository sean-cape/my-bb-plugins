import { useState } from "react";
import type { ComponentProps, PointerEvent as ReactPointerEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { DiffResult } from "../../types";
import { cn } from "../utils";
import { PRESS } from "../ui/motion";
import { SkeletonLines } from "../ui/skeleton";
import { readPreference, setDiffPreferences, useDiffPreferences, writePreference } from "../state";
import { FileTree } from "./file-tree";

const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 180;
const MAX_WIDTH = 720;

const FILE_SKELETON = ["70%", "55%", "82%", "48%", "64%"];

const WIDTH_KEY = "fileTreeWidth";

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

function readWidth(): number {
  const stored = Number.parseInt(readPreference(WIDTH_KEY) ?? "", 10);
  return Number.isFinite(stored) ? clampWidth(stored) : DEFAULT_WIDTH;
}

/**
 * The file tree beside the diff, from the `@3xl` container width up: hideable to a thin rail and resizable by its
 * edge, both remembered across views. Renders as siblings of the diff inside the view's flex row.
 */
export function FileTreeSidebar({ diff, ...tree }: { diff: DiffResult | null } & Omit<ComponentProps<typeof FileTree>, "files" | "onHide">) {
  const { fileTreeOpen: open } = useDiffPreferences();
  const setOpen = (value: boolean) => setDiffPreferences({ fileTreeOpen: value });
  const [width, setWidth] = useState<number>(readWidth);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let next = startWidth;
    const move = (moveEvent: PointerEvent) => {
      next = clampWidth(startWidth + moveEvent.clientX - startX);
      setWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      writePreference(WIDTH_KEY, String(next));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <>
      {!open ? (
        <div className="hidden w-7 shrink-0 flex-col items-center border-r border-border pt-1 @3xl:flex">
          <button type="button" className={cn("rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)} aria-label="Show file list" title="Show file list (t)" onClick={() => setOpen(true)}>
            <Icon name="ChevronDown" className="size-3.5 -rotate-90" />
          </button>
          {diff !== null ? <span className="mt-1 text-[10px] tabular-nums text-muted-foreground">{diff.files.length}</span> : null}
        </div>
      ) : null}
      <aside data-file-tree="" className={cn("relative hidden shrink-0 flex-col border-r border-border @3xl:flex", !open && "@3xl:hidden")} style={{ width }}>
        <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">Files{diff !== null ? ` · ${diff.files.length}` : ""}</span>
          <button type="button" className={cn("rounded p-0.5 hover:bg-state-hover hover:text-foreground", PRESS)} aria-label="Hide file list" title="Hide file list (t)" onClick={() => setOpen(false)}>
            <Icon name="ChevronDown" className="size-3.5 rotate-90" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {diff === null ? <SkeletonLines widths={FILE_SKELETON} label="Loading files" className="px-3 py-2" lineClassName="h-2.5" /> : <FileTree
              files={diff.files}
              {...tree}
              onHide={() => {
                setOpen(false);
                tree.onLeave();
              }}
            />}
          {diff?.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground">File list truncated.</p> : null}
        </div>
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file list"
        title="Drag to resize the file list; double-click to reset"
        className={cn("hidden w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/40 active:bg-primary/60 @3xl:block", !open && "@3xl:hidden")}
        onPointerDown={startResize}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          writePreference(WIDTH_KEY, String(DEFAULT_WIDTH));
        }}
      />
    </>
  );
}
