// The commit picker (`gr`) and the summary bar's control naming what it picked.
import { createContext, useEffect, useId, useMemo, useState } from "react";
import { commitRangeKey, WORKTREE_SHA, type CommitRange, type DiffCommits } from "../../types";
import { relativeTime } from "../format";
import type { DiffSource } from "../source";
import { useDiffInstance } from "../state";
import { FAST, PRESS, enter } from "../ui/motion";
import { usePopover } from "../ui/use-popover";
import { usePickerKeys } from "../ui/vim-keys";
import { cn } from "../utils";
import { COMMIT_PICKER_KEYMAP, collapsedRangeNote, pickedRange, pickerRows, rangeEndsAtHead, rangeGate, rangeSpan, shortCommit, toggledRangeStart, type CommitRow } from "./commit-range";

/** The part of the history the view shows, for the renderers that fetch a file's diff themselves. */
export const CommitRangeContext = createContext<CommitRange | null>(null);

/** The source's commits, refetched with each refresh of the view; null while loading or when the source has none. */
export function useDiffCommits(source: DiffSource, instanceKey: string): DiffCommits | null {
  const [commits, setCommits] = useState<DiffCommits | null>(null);
  const { reloadNonce } = useDiffInstance(instanceKey);
  useEffect(() => {
    if (source.commits === undefined) {
      setCommits(null);
      return;
    }
    let cancelled = false;
    source.commits().then(
      (result) => {
        if (!cancelled) setCommits(result);
      },
      () => {
        if (!cancelled) setCommits(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, reloadNonce]);
  return commits;
}

/** The part of the history the view shows (null is all the changes), its commits, and what the range lets the view do. */
export function useCommitRange(source: DiffSource, instanceKey: string) {
  const [commitRange, setCommitRange] = useState<CommitRange | null>(null);
  const commits = useDiffCommits(source, instanceKey);
  const atHead = rangeEndsAtHead(commitRange, commits);
  const gate = useMemo(() => rangeGate(commitRange, atHead), [commitRange, atHead]);
  return { commitRange, setCommitRange, commits, atHead, gate };
}

/** The summary bar's "Commits" control: what the diff covers, opening the picker on press (as `gr` does). */
export function CommitsButton({ label, partial, onOpen }: { label: string; partial: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs", PRESS, partial ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300" : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground")}
      title={partial ? "The diff shows only these commits; comments and viewed marks need the range to end at the head. Click (or gr) to pick others." : "The diff shows every commit. Click (or gr) to read one commit, a range, or what changed since a review."}
      onClick={onOpen}
    >
      Commits: {label}
    </button>
  );
}

const PANEL = "absolute inset-x-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none";

/**
 * All changes, the review marks, then every commit, oldest first. Enter (or a click) picks a row; Space or `x` on a commit
 * (or a shift-click) starts a range, and Enter on another commit picks every commit between them.
 */
export function CommitPicker({
  commits,
  current,
  onPick,
  onClose,
  notify,
}: {
  commits: DiffCommits;
  current: CommitRange | null;
  /** `note` says why a started range came out as one commit or all of them. */
  onPick: (range: CommitRange | null, note: string | null) => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const rows = pickerRows(commits);
  const currentKey = commitRangeKey(current);
  const span = current === null ? null : rangeSpan(current, commits);
  const [highlight, setHighlight] = useState(() => {
    const at = rows.findIndex((row) => rowRangeKey(row, commits) === currentKey);
    return at === -1 ? 0 : at;
  });
  const [start, setStart] = useState<number | null>(null);
  const { ref: listRef, onBlur } = usePopover<HTMLUListElement>({ onDismiss: onClose });
  const optionId = useId();
  const now = Date.now();
  useEffect(() => {
    listRef.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const pickRow = (index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    const pick = pickedRange(commits, row, start);
    if (pick.kind === "unknown") notify("Where the first commit starts from is unknown; pick a later commit");
    else onPick(pick.range, collapsedRangeNote(commits, row, start));
  };
  const markStart = (index: number) => {
    const next = toggledRangeStart(rows[index], start);
    if (next === undefined) notify("Ranges run between commits; move onto one first");
    else setStart(next);
  };
  const { onListKeyDown } = usePickerKeys<"mark">({
    length: () => rows.length,
    highlight: () => highlight,
    setHighlight,
    pick: (index) => pickRow(index),
    onListEscape: () => {
      if (start !== null) setStart(null);
      else onClose();
      return true;
    },
    keymap: COMMIT_PICKER_KEYMAP,
    // A held Space would toggle the start straight back off.
    onCommand: (_, { event }) => {
      if (!event.repeat) markStart(highlight);
    },
  });
  const highlighted = rows[highlight];
  const pending = start !== null && highlighted?.kind === "commit" ? [Math.min(start, highlighted.index), Math.max(start, highlighted.index)] : null;

  return (
    <div role="dialog" aria-label="Pick commits" className={cn(PANEL, enter.drop, FAST)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-medium">
        Commits
        <span className="ml-auto text-right text-xs font-normal text-muted-foreground">
          {start === null ? "Enter picks · Space or x starts a range (shift-click) · Esc closes" : "Enter on another commit picks the range · Esc drops the start"}
        </span>
      </div>
      <ul
        ref={listRef}
        tabIndex={-1}
        role="listbox"
        aria-label="Commits"
        aria-activedescendant={`${optionId}-${highlight}`}
        className="overflow-y-auto py-1 text-xs outline-none"
        onKeyDown={onListKeyDown}
        onBlur={onBlur}
      >
        {rows.map((row, index) => {
          const covered = row.kind === "commit" && (pending !== null ? row.index >= pending[0]! && row.index <= pending[1]! : span !== null && row.index >= span[0] && row.index <= span[1]);
          const selected = rowRangeKey(row, commits) === currentKey;
          return (
            <li
              key={row.kind === "commit" ? commits.commits[row.index]!.sha : row.kind === "mark" ? `mark:${row.label}` : "all"}
              id={`${optionId}-${index}`}
              role="option"
              aria-selected={index === highlight}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-3 py-1",
                index === highlight ? "bg-state-active text-foreground" : covered ? "bg-primary/10 text-foreground" : "text-muted-foreground",
                row.kind === "commit" && index > 0 && rows[index - 1]?.kind !== "commit" && "mt-1 border-t border-border pt-1.5",
              )}
              onPointerDown={(event) => {
                event.preventDefault();
                setHighlight(index);
                if (event.shiftKey && start === null) markStart(index);
                else pickRow(index);
              }}
            >
              <span aria-hidden="true" className="w-3 shrink-0 text-foreground">
                {selected ? "✓" : row.kind === "commit" && start === row.index ? "▸" : ""}
              </span>
              <CommitRowLabel row={row} commits={commits} now={now} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CommitRowLabel({ row, commits, now }: { row: CommitRow; commits: DiffCommits; now: number }) {
  if (row.kind === "all") return <span className="min-w-0 flex-1 truncate font-medium">All changes</span>;
  if (row.kind === "mark") {
    return (
      <>
        <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
        <span className="shrink-0 font-mono">{shortCommit(row.sha)}</span>
      </>
    );
  }
  const commit = commits.commits[row.index]!;
  const time = Date.parse(commit.date);
  return (
    <>
      <span className="shrink-0 font-mono">{shortCommit(commit.sha)}</span>
      <span className={cn("min-w-0 flex-1 truncate", commit.sha === WORKTREE_SHA && "italic")}>{commit.summary}</span>
      {commit.author !== "" ? <span className="max-w-[10rem] shrink-0 truncate">{commit.author}</span> : null}
      {commit.sha !== WORKTREE_SHA && !Number.isNaN(time) ? <span className="shrink-0 tabular-nums">{relativeTime(time, now)}</span> : null}
    </>
  );
}

/** The range a row picks on its own, to tick the current one. */
function rowRangeKey(row: CommitRow, commits: DiffCommits): string | null {
  const pick = pickedRange(commits, row, null);
  return pick.kind === "unknown" ? null : commitRangeKey(pick.range);
}

