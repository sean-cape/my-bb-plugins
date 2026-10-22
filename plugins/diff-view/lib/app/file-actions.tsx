// Copying a file's path or a link to its lines, opening it, and its blame: the `yp`, `yl`, `gO` and `gb` keys and the
// "…" menu on each file header.
import { createContext, useContext, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { DiffFile, DiffResult } from "../types";
import { errorMessage, relativeTime, shortSha } from "./format";
import { blameCommits, fileLink, fileSide, firstHunkSpan, githubCommitUrl, githubFileUrl, lineRuns, missingSide, type BlameCommit, type LineSpan } from "./links";
import { FILE_POPOVER_KEYMAP, type FilePopoverCommand } from "./keys/keymap";
import type { FileActions } from "./keys/review-commands";
import { usePortalScopeProps } from "./portal-scope";
import { useDiffSource } from "./source";
import { CommitRangeContext } from "./commits/commit-picker";
import { FAST, PRESS, enter } from "./ui/motion";
import { popoverPlace } from "./ui/popover-place";
import { usePopover } from "./ui/use-popover";
import { runListMotion, useKeyHandler } from "./ui/vim-keys";
import { cn } from "./utils";

/** The all-zero sha git blame gives a line not committed yet. */
const UNCOMMITTED = /^0+$/u;
const BLAME_WIDTH_PX = 480;
/** The header menu's `w-44`. */
const MENU_WIDTH_PX = 176;

/** The file actions the keys and the header menus share, for one diff. */
export function fileActionsFor({
  diff,
  navigate,
  notify,
  noCheckout,
  blame,
}: {
  diff: DiffResult | null;
  navigate: ReturnType<typeof useBbNavigate>;
  notify: (message: string) => void;
  noCheckout: string;
  blame: ((path: string, span: LineSpan) => void) | null;
}): FileActions {
  const fileOf = (path: string): DiffFile | null => diff?.files.find((file) => file.path === path) ?? null;
  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied ${what}`, { description: text, duration: 2500 }),
      (cause: unknown) => toast.error(`Could not copy: ${errorMessage(cause)}`),
    );
  };
  return {
    copyPath: (path) => copy(path, "the path"),
    copyLink: (path, span) => {
      const file = fileOf(path);
      if (diff === null || file === null) return;
      const link = fileLink(diff, file, span);
      copy(link, link.startsWith("https://") ? "the link" : "the location");
    },
    open: (path, span) => {
      const file = fileOf(path);
      if (diff === null || file === null) return;
      const side = span?.side ?? fileSide(file);
      if (missingSide(file, side)) {
        notify(side === "LEFT" ? "This file is new; it has no old side to open" : "This file was deleted; it has no new side to open");
        return;
      }
      // A checkout holds the new side only; the old side opens on GitHub at the base, when there is one.
      if (diff.environmentId !== null && side === "RIGHT") {
        const accepted = navigate.experimental_openFilePreview({
          target: { kind: "workspace", environmentId: diff.environmentId, path: file.path },
          location: span === null ? null : { kind: "line", line: span.start, column: null },
        });
        if (accepted) return;
      }
      const url = githubFileUrl(diff, file, span);
      if (url !== null) window.open(url, "_blank", "noopener,noreferrer");
      else notify(side === "LEFT" && diff.environmentId !== null ? "The old side is only on GitHub, and this checkout's commit isn't known there" : noCheckout);
    },
    blame:
      blame === null
        ? null
        : (path, span) => {
            const file = fileOf(path);
            if (file !== null && missingSide(file, span.side)) notify(span.side === "LEFT" ? "This file is new; its old side has no blame" : "This file was deleted; its new side has no blame");
            else blame(path, span);
          },
  };
}

/** What a file header's menu reaches: the actions, and a blame anchored where the menu was opened. */
export interface FileMenuActions {
  actions: FileActions;
  blameFrom: (path: string, span: LineSpan, anchor: Element) => void;
}

export const FileActionsContext = createContext<FileMenuActions | null>(null);

/** Moves focus over a popover's rows and closes it; portalled, so the diff's own keys never see these. */
function usePopoverKeys(list: RefObject<HTMLElement | null>, onClose: () => void) {
  return useKeyHandler<FilePopoverCommand>({
    keymap: FILE_POPOVER_KEYMAP,
    onCommand: (command, { count }) => {
      if (command.kind === "close") {
        onClose();
        return true;
      }
      return list.current !== null && runListMotion(list.current, command.motion, { count });
    },
  });
}

const MENU_ITEM = cn("flex w-full items-center rounded px-2 py-1 text-left text-xs hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none", PRESS);

/** The "…" on a file header: copy its path or a link, open it, or blame its first hunk. */
export function FileHeaderMenu({ file }: { file: DiffFile }) {
  const context = useContext(FileActionsContext);
  const { source } = useDiffSource();
  const portalScope = usePortalScopeProps();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const close = (refocus: boolean) => {
    setAnchor(null);
    if (refocus) button.current?.closest<HTMLElement>("[data-diff-root]")?.focus({ preventScroll: true });
  };
  const { ref: list, onBlur } = usePopover<HTMLDivElement>({ open: anchor !== null, onDismiss: () => close(false) });
  const onKeyDown = usePopoverKeys(list, () => close(true));
  if (context === null) return null;
  const { actions, blameFrom } = context;
  const blameSpan = firstHunkSpan(file.patch);
  const pick = (run: () => void) => {
    close(true);
    run();
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={cn("rounded px-1.5 text-xs leading-5 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)}
        aria-label={`More for ${file.path}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        title="Copy path or link, open, blame (yp, yl, gO, gb)"
        onClick={(event) => setAnchor(anchor === null ? event.currentTarget.getBoundingClientRect() : null)}
      >
        …
      </button>
      {anchor === null
        ? null
        : createPortal(
            <div
              {...portalScope}
              ref={list}
              role="menu"
              aria-label={`Actions for ${file.path}`}
              className={cn("fixed z-50 flex w-44 flex-col rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md", enter.scale, FAST)}
              style={popoverPlace(anchor, { width: MENU_WIDTH_PX })}
              onKeyDown={onKeyDown}
              onBlur={onBlur}
            >
              <button type="button" role="menuitem" data-nav-row="item" tabIndex={-1} className={MENU_ITEM} onClick={() => pick(() => actions.copyPath(file.path))}>
                Copy path
              </button>
              <button type="button" role="menuitem" data-nav-row="item" tabIndex={-1} className={MENU_ITEM} onClick={() => pick(() => actions.copyLink(file.path, null))}>
                Copy link
              </button>
              <button type="button" role="menuitem" data-nav-row="item" tabIndex={-1} className={MENU_ITEM} onClick={() => pick(() => actions.open(file.path, null))}>
                Open file
              </button>
              {source.blame !== undefined && blameSpan !== null ? (
                <button
                  type="button"
                  role="menuitem"
                  data-nav-row="item"
                  tabIndex={-1}
                  className={MENU_ITEM}
                  onClick={() => {
                    const at = button.current;
                    close(false);
                    if (at !== null) blameFrom(file.path, blameSpan, at);
                  }}
                >
                  Blame first hunk
                </button>
              ) : null}
            </div>,
            document.body,
          )}
    </>
  );
}

/**
 * Who last changed the lines, one row per commit: j / k move, Enter opens the commit on GitHub when the repository is
 * known, Escape closes. Portalled to the body like the symbol hover card, under the line it was opened from.
 */
export function BlamePopover({ path, span, anchor, repo, onClose }: { path: string; span: LineSpan; anchor: DOMRect | null; repo: string | null; onClose: () => void }) {
  const { source } = useDiffSource();
  const range = useContext(CommitRangeContext);
  const portalScope = usePortalScopeProps();
  const [state, setState] = useState<{ commits: BlameCommit[] } | { error: string } | null>(null);
  const { ref: root, onBlur } = usePopover<HTMLDivElement>({ ready: state, onDismiss: onClose });
  const list = useRef<HTMLUListElement | null>(null);
  const onKeyDown = usePopoverKeys(list, onClose);
  useEffect(() => {
    let cancelled = false;
    setState(null);
    if (source.blame === undefined) return;
    source.blame(path, span.side, span.start, span.end, range).then(
      (lines) => {
        if (!cancelled) setState({ commits: blameCommits(lines) });
      },
      (cause: unknown) => {
        if (!cancelled) setState({ error: errorMessage(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, path, span.side, span.start, span.end, range]);
  const now = Date.now();
  const box = anchor ?? new DOMRect(window.innerWidth / 2 - BLAME_WIDTH_PX / 2, window.innerHeight / 3, 0, 0);
  const open = (sha: string) => {
    if (UNCOMMITTED.test(sha)) toast.message("Not committed yet");
    else if (repo === null) toast.message("This checkout's GitHub repository isn't known");
    else window.open(githubCommitUrl(repo, sha), "_blank", "noopener,noreferrer");
  };
  const lines = span.end > span.start ? `L${span.start}–${span.end}` : `L${span.start}`;
  return createPortal(
    <div
      {...portalScope}
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-label={`Blame of ${path} ${lines}`}
      className={cn("fixed z-50 flex max-h-80 max-w-[90vw] flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none", enter.scale, FAST)}
      style={{ ...popoverPlace(box, { width: BLAME_WIDTH_PX }), width: BLAME_WIDTH_PX }}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2 py-1 text-xs">
        <span className="font-medium">Blame</span>
        <code className="min-w-0 truncate text-muted-foreground" title={path}>
          {path} {span.side === "LEFT" ? "old " : ""}
          {lines}
        </code>
        <span className="ml-auto shrink-0 text-muted-foreground">j / k · Enter opens · Esc</span>
      </div>
      {state === null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
      ) : "error" in state ? (
        <p className="px-3 py-2 text-xs text-destructive">{state.error}</p>
      ) : state.commits.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No blame for these lines.</p>
      ) : (
        <ul ref={list} className="min-h-0 overflow-y-auto py-1 text-xs">
          {state.commits.map((commit) => {
            const uncommitted = UNCOMMITTED.test(commit.sha);
            return (
              <li key={commit.sha}>
                <button
                  type="button"
                  data-nav-row="item"
                  tabIndex={-1}
                  className={cn("flex w-full flex-col gap-0.5 px-2 py-1 text-left hover:bg-state-hover focus-visible:bg-state-active focus-visible:outline-none", PRESS)}
                  onClick={() => open(commit.sha)}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <code className="shrink-0 text-muted-foreground">{uncommitted ? "uncommitted" : shortSha(commit.sha)}</code>
                    <span className="min-w-0 truncate font-medium">{uncommitted ? "Not committed yet" : commit.summary}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{lineRuns(commit.lines)}</span>
                  </span>
                  {uncommitted ? null : (
                    <span className="text-muted-foreground">
                      {commit.author} · {relativeTime(commit.time, now)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>,
    document.body,
  );
}
