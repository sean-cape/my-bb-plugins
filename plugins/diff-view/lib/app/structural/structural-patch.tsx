import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DiffSide, HunkExplanation, SemanticChange, StructuralDiff, SymbolLookup } from "../../types";
import { checkedLineRange } from "../../line-range";
import { rowKey } from "../text/patch-rows";
import { cn } from "../utils";
import { FAST, OPACITY_TRANSITION, PRESS, SHIMMER, enter } from "../ui/motion";
import { errorMessage } from "../format";
import { useDiffSource } from "../source";
import { useDiffPreferences } from "../state";
import { useHostThemeName } from "../theme";
import { rangesOverlap } from "../ranges";
import type { PatchAnnotationProps } from "../patch-annotations";
import { DiffCommentForm } from "../comments/comment-form";
import { DiffCommentsContext } from "../comments/context";
import { FileLevelComments } from "../comments/file-level-comments";
import { DiffThreadView } from "../comments/thread-view";
import { FindingAnnotation } from "../findings/finding-annotation";
import { findingAnchorId } from "../findings/findings";
import { SymbolHoverCard } from "../symbols/symbol-hover-card";
import { ExplanationStrip } from "../explanations/explanation-strip";
import { SymbolPeek } from "../symbols/symbol-peek";
import { useSymbolNavigation } from "../symbols/use-symbol-navigation";
import { visualRange, type NavRow } from "../keys/nav";
import { useFileSelection, usePublishNavModel, type FileNavModel } from "../keys/review-keys-context";
import { enclosingDefinition } from "./enclosing-definition";
import { detectMoves } from "./moves";
import { CONTEXT_LINES, hunkSpan, newRows, structuralRows, visibleRows } from "./rows";
import type { NewSince } from "../new-since";
import { IDENTIFIER } from "./structural-line";
import { GapRow, StructuralRowView, UnifiedRowView, type RowContext } from "./structural-row";
import { EXPAND_STEP_LINES } from "../text/patch-gaps";
import { shikiLangFor, useShikiTokens } from "./syntax";
import { tableEntries, unifiedHalf, unifiedRows } from "./unified-rows";
import { CommitRangeContext } from "../commits/commit-picker";

/** Column widths: the gutters pinned, the code columns sharing the rest (one column in unified, under both gutters). */
const SPLIT_COLUMNS = ["w-12", "", "w-12", ""];
const UNIFIED_COLUMNS = ["w-12", "w-12", ""];

/** The hidden row whose lines a fold's cursor takes: the one next to the code the fold opens toward. */
function foldCursorIndex(entry: { from: number; to: number }): number {
  return entry.from === 0 ? entry.to - 1 : entry.from;
}

/** A line-number drag in progress: one side's lines from `anchor` to `current`, in either direction. */
interface LineDrag {
  side: DiffSide;
  anchor: number;
  current: number;
}

/**
 * difftastic's side-by-side diff of one file, folded to GitHub-style hunks, with comments, findings, symbol peeks and
 * the tour's semantic labels inline. Clicking a line number comments on that line; dragging over line numbers, or
 * shift-clicking with the comment form open, comments on a range of one side's lines.
 */
export function StructuralPatch({
  path,
  threads,
  composer,
  onStartComment,
  onCancelComposer,
  onSubmitComposer,
  onOpenFile,
  findings,
  onToggleFinding,
  onEditFinding,
  explanations,
  onExplain,
  semantics,
  newSince,
  fallback,
  fallbackNote,
  unchangedNote,
  searchLine = null,
}: PatchAnnotationProps & {
  /** The file's text diff, shown instead when difftastic cannot diff it. */
  fallback: ReactNode;
  /** The line above the fallback, when it is not a line diff. */
  fallbackNote?: string;
  onOpenFile: (lookup: SymbolLookup, definition: SymbolLookup["definitions"][number]) => void;
  explanations: HunkExplanation[];
  /** Null when the data source cannot explain hunks. */
  onExplain: ((side: "old" | "new", startLine: number, endLine: number) => void) | null;
  semantics: SemanticChange[];
  newSince: NewSince;
  /** Shows the fallback, under this line, when difftastic finds no change (it ignores formatting the line diff has). */
  unchangedNote?: string;
  /** The patch line a search took the cursor to, unfolded when it sits in a fold. */
  searchLine?: { left: number | null; right: number | null } | null;
}) {
  const { onOpenThread } = useContext(DiffCommentsContext);
  const { source } = useDiffSource();
  const range = useContext(CommitRangeContext);
  const [diff, setDiff] = useState<StructuralDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const [drag, setDrag] = useState<LineDrag | null>(null);
  const { layout } = useDiffPreferences();
  const tableRef = useRef<HTMLTableElement | null>(null);
  const themeName = useHostThemeName();
  const shikiLang = shikiLangFor(path);
  const oldTokens = useShikiTokens(diff?.oldText ?? "", shikiLang, themeName);
  const newTokens = useShikiTokens(diff?.newText ?? "", shikiLang, themeName);
  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    setRevealed(new Set());
    source.getStructural(path, range).then(
      (result) => {
        if (!cancelled) setDiff(result);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, path, range]);
  const unchangedFallback = unchangedNote !== undefined && diff !== null && diff.available && diff.status === "unchanged";
  const symbols = useSymbolNavigation(source);
  const latestSymbols = useRef(symbols);
  latestSymbols.current = symbols;
  const reveal = useCallback((from: number, to: number) => {
    setRevealed((current) => {
      const next = new Set(current);
      for (let i = from; i < to; i++) next.add(i);
      return next;
    });
  }, []);
  // GitHub-style hunks: changed rows plus a few lines of context stay visible; everything else collapses behind expanders.
  const allRows = useMemo(() => (diff === null || !diff.available ? null : structuralRows(diff)), [diff]);
  const drawnRows = useMemo(() => (allRows === null ? null : layout === "unified" ? unifiedRows(allRows) : allRows), [allRows, layout]);
  const text = useMemo(() => {
    if (diff === null || allRows === null) return null;
    const oldLines = diff.oldText.split("\n");
    const newLines = diff.newText.split("\n");
    return {
      oldLines,
      newLines,
      oldChanges: new Map(diff.oldChanges.map((entry) => [entry.line, entry])),
      newChanges: new Map(diff.newChanges.map((entry) => [entry.line, entry])),
      moved: detectMoves(allRows, oldLines, newLines),
    };
  }, [diff, allRows]);
  const shape = useMemo(() => {
    if (diff === null || allRows === null || drawnRows === null) return null;
    const rows = allRows;
    const fresh = newRows(rows, newSince.ranges);
    const visible = visibleRows(rows, { revealed, findingLines: findings.map((entry) => entry.line), threads, onlyChanges: newSince.only ? fresh : null });
    // The cursor's rows in display order: shown lines, and the folds between them, which the cursor can stop on.
    const entries = tableEntries(drawnRows, visible);
    const nav: NavRow[] = entries.map((entry) => {
      if (entry.kind === "row") return { left: entry.row.lhs, right: entry.row.rhs, hunk: entry.hunk, changed: entry.row.changed };
      const at = rows[foldCursorIndex(entry)]!;
      return { left: at.lhs, right: at.rhs, hunk: entry.hunk, changed: false, expander: true };
    });
    return { rows, visible, entries, nav, fresh };
  }, [diff, allRows, drawnRows, revealed, findings, threads, newSince]);
  const navModel = useMemo<FileNavModel | null>(() => {
    // The fallback text diff publishes its own rows.
    if (error !== null || (diff !== null && !diff.available) || unchangedFallback) return null;
    if (shape === null || text === null) return null;
    const { entries, nav, visible, rows } = shape;
    const sideLines = { LEFT: text.oldLines, RIGHT: text.newLines };
    const rowElement = (row: number) => {
      const entry = entries[row];
      if (entry === undefined) return null;
      const half = entry.kind === "row" ? unifiedHalf(entry.row, layout === "unified") : null;
      const selector = entry.kind === "row" ? `[data-row="${entry.row.index}"]${half === null ? "" : `[data-side="${half}"]`}` : `[data-gap="${entry.from}"]`;
      return tableRef.current?.querySelector(selector) ?? null;
    };
    const linesOf = (index: number) => ({ left: rows[index]!.lhs, right: rows[index]!.rhs });
    return {
      rows: nav,
      cutToHunk: false,
      element: rowElement,
      moreContext: (row) => {
        const entry = entries[row];
        if (entry?.kind !== "row") return;
        const at = entry.row.index;
        let start = at;
        let end = at;
        while (visible.has(start - 1)) start -= 1;
        while (visible.has(end + 1)) end += 1;
        reveal(Math.max(0, start - EXPAND_STEP_LINES), start);
        reveal(end + 1, end + 1 + EXPAND_STEP_LINES);
      },
      expand: (row) => {
        const entry = entries[row];
        if (entry === undefined || entry.kind === "row") return null;
        const { from, to } = entry;
        const leading = from === 0;
        // Like the fold's buttons: a short fold opens whole, a long one a step at a time toward the code it borders,
        // with the cursor left on what remains of it so Enter keeps opening.
        if (to - from <= EXPAND_STEP_LINES) {
          reveal(from, to);
          return linesOf(leading ? to - 1 : from);
        }
        if (leading) {
          reveal(to - EXPAND_STEP_LINES, to);
          return linesOf(to - EXPAND_STEP_LINES - 1);
        }
        reveal(from, from + EXPAND_STEP_LINES);
        return linesOf(from + EXPAND_STEP_LINES);
      },
      symbols: {
        at: (row, side) => {
          if (nav[row]?.expander === true) return [];
          const line = side === "LEFT" ? nav[row]?.left : nav[row]?.right;
          const text = line == null ? "" : (sideLines[side][line - 1] ?? "");
          return [...new Set([...text.matchAll(IDENTIFIER)].map((match) => match[0]))];
        },
        peek: (row, symbol) => {
          const element = rowElement(row);
          if (element instanceof HTMLElement) latestSymbols.current.lookupSymbol(symbol, element);
        },
        close: () => {
          if (latestSymbols.current.peek === null) return false;
          latestSymbols.current.closePeek();
          return true;
        },
      },
    };
  }, [error, diff, shape, text, reveal, unchangedFallback, layout]);
  usePublishNavModel(path, navModel);
  const searchLeft = searchLine?.left ?? null;
  const searchRight = searchLine?.right ?? null;
  useEffect(() => {
    if (shape === null || (searchLeft === null && searchRight === null)) return;
    const row = shape.rows.find((entry) => (searchRight !== null ? entry.rhs === searchRight : entry.lhs === searchLeft));
    if (row === undefined || shape.visible.has(row.index)) return;
    reveal(Math.max(0, row.index - CONTEXT_LINES), Math.min(shape.rows.length, row.index + CONTEXT_LINES + 1));
  }, [shape, searchLeft, searchRight, reveal]);
  const fileSelection = useFileSelection(path);
  // Rows read handlers through this, so their context stays stable while the composer and the hosts' callbacks change.
  const latest = useRef({ composer, onStartComment, rows: allRows });
  latest.current = { composer, onStartComment, rows: allRows };
  const rowContext = useMemo<RowContext | null>(() => {
    if (text === null) return null;
    return {
      path,
      ...text,
      oldTokens,
      newTokens,
      semantics,
      changedRanges: newSince.ranges,
      newLabel: newSince.label,
      onLinePress: (side, line, extend) => {
        const { composer: open } = latest.current;
        // A shift-click extends the open comment's range on the same side, from whichever end stays put.
        let anchor = line;
        if (extend && open !== null && open.line !== null && open.side === side && (open.startSide ?? side) === side) {
          const start = open.startLine ?? open.line;
          anchor = line < start ? open.line : start;
        }
        setDrag({ side, anchor, current: line });
      },
      onLineActivate: (side, line) => latest.current.onStartComment(checkedLineRange({ line, side })),
      onDragOver: (row) =>
        setDrag((current) => {
          if (current === null) return current;
          const line = current.side === "LEFT" ? row.lhs : row.rhs;
          return line === null || line === current.current ? current : { ...current, current: line };
        }),
      jumpToRow: (index) => {
        const total = latest.current.rows?.length ?? 0;
        reveal(Math.max(0, index - CONTEXT_LINES), Math.min(total, index + CONTEXT_LINES + 1));
        requestAnimationFrame(() => {
          tableRef.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: "center" });
        });
      },
      onSymbol: (symbol, anchor) => latestSymbols.current.lookupSymbol(symbol, anchor),
      onSymbolHover: (symbol, anchor) => latestSymbols.current.hoverSymbol(symbol, anchor),
    };
  }, [path, text, oldTokens, newTokens, semantics, newSince, reveal]);
  const notesByLine = useMemo(() => {
    const byLine = new Map<string, { threads: typeof threads; findings: typeof findings }>();
    const at = (side: DiffSide, line: number) => {
      const key = rowKey(side, line);
      let entry = byLine.get(key);
      if (entry === undefined) byLine.set(key, (entry = { threads: [], findings: [] }));
      return entry;
    };
    for (const thread of threads) if (thread.line !== null) at(thread.side, thread.line).threads.push(thread);
    for (const entry of findings) if (entry.line !== null) at("RIGHT", entry.line).findings.push(entry);
    return byLine;
  }, [threads, findings]);
  useEffect(() => {
    if (drag === null) return;
    const finish = () => {
      setDrag(null);
      const [from, to] = drag.anchor <= drag.current ? [drag.anchor, drag.current] : [drag.current, drag.anchor];
      onStartComment(checkedLineRange({ line: to, side: drag.side, startLine: from, startSide: drag.side }));
    };
    const cancel = () => setDrag(null);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancel);
    return () => {
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancel);
    };
  }, [drag, onStartComment]);
  if (error !== null || (diff !== null && !diff.available) || unchangedFallback) {
    return (
      <>
        <p className="px-3 pt-1.5 text-[11px] text-muted-foreground" title={error ?? diff?.reason ?? undefined}>
          {unchangedFallback ? unchangedNote : (fallbackNote ?? "Shown as a line diff: difftastic could not diff this file")}
        </p>
        {fallback}
      </>
    );
  }
  if (diff === null || shape === null || text === null || rowContext === null) return <p className={cn("relative overflow-hidden p-4 text-sm text-muted-foreground", SHIMMER)}>Running difftastic…</p>;
  const { oldLines, newLines } = text;
  const { rows, visible, fresh } = shape;
  const unified = layout === "unified";
  const columns = unified ? 3 : 4;
  const visualSelection = fileSelection?.visual != null ? visualRange(shape.nav, fileSelection.visual, fileSelection.cursor, false) : null;
  const selected = (side: DiffSide, line: number): boolean => {
    if (drag !== null) return side === drag.side && line >= Math.min(drag.anchor, drag.current) && line <= Math.max(drag.anchor, drag.current);
    const range = composer !== null && composer.line !== null ? composer : visualSelection;
    if (range === null || range.line === null) return false;
    if (range.startLine === null || range.startSide === null) return side === range.side && line === range.line;
    if (range.startSide === range.side) return side === range.side && line >= range.startLine && line <= range.line;
    return side === range.startSide ? line >= range.startLine : line <= range.line;
  };
  const annotationRow = (side: DiffSide, line: number) => {
    const notes = notesByLine.get(rowKey(side, line));
    const list = notes?.threads ?? [];
    const composing = composer !== null && composer.line === line && composer.side === side;
    const lineFindings = notes?.findings ?? [];
    if (list.length === 0 && !composing && lineFindings.length === 0) return null;
    return (
      <tr key={`${side}-${line}-notes`}>
        <td colSpan={columns} className="px-3 py-0.5">
          {list.map((thread) => (
            <DiffThreadView key={thread.id} thread={thread} />
          ))}
          {composing && composer !== null ? <DiffCommentForm path={path} range={composer} onSubmit={onSubmitComposer} onCancel={onCancelComposer} /> : null}
          {lineFindings.map((entry) => (
            <FindingAnnotation key={`${entry.item.reviewId}:${entry.item.finding.id}`} item={entry.item} anchorId={findingAnchorId(entry)} onToggle={(selected) => onToggleFinding(entry.item, selected)} onEdit={(edit) => onEditFinding(entry.item, edit)} />
          ))}
        </td>
      </tr>
    );
  };
  const hunkHeader = (index: number) => {
    const span = hunkSpan(rows, visible, index);
    const first = rows[index]!;
    const enclosing = first.rhs !== null ? enclosingDefinition(newLines, first.rhs) : first.lhs !== null ? enclosingDefinition(oldLines, first.lhs) : null;
    const labels = semantics.filter((change) => {
      const range = span.side === "new" ? change.newLines : change.oldLines;
      return range !== null && rangesOverlap(span.start, span.stop, [range]);
    });
    const explanation = explanations.find((entry) => entry.side === span.side && entry.startLine <= span.stop && entry.endLine >= span.start) ?? null;
    let isNew = false;
    for (let at = index; at <= span.end && !isNew; at++) isNew = fresh.has(at);
    // A hunk that is the whole file (an added or deleted file) says nothing a reader doesn't know; K still asks for an explanation.
    const wholeFile = span.start === 1 && span.stop === (span.side === "new" ? newLines : oldLines).length;
    if (wholeFile && labels.length === 0 && explanation === null && !isNew) return null;
    return (
      <Fragment key={`hunk-${index}`}>
        {/* Plain and ruled above, where a fold is a tinted band: the two rows that break a file up read as different things. */}
        <tr className="group/hunk border-t border-border/60 text-[11px] text-muted-foreground">
          <td colSpan={columns} className="px-3 py-0.5">
            <div className="flex items-center gap-2">
              <code className="min-w-0 truncate" title={enclosing ?? undefined}>
                <span className="text-muted-foreground/70">
                  @@ {span.side === "new" ? "" : "old "}
                  {span.start}–{span.stop}
                </span>
                {enclosing !== null ? <span className="text-foreground/80"> {enclosing}</span> : null}
              </code>
              {isNew ? (
                <span className="shrink-0 rounded border border-sky-500/50 bg-sky-500/10 px-1.5 py-px font-sans text-[10px] text-sky-700 dark:text-sky-300" title={`Changed since ${newSince.label}: the lines marked blue in the gutter (]n / [n step through them)`}>
                  new
                </span>
              ) : null}
              {labels.map((change, labelIndex) => (
                <span key={labelIndex} className="inline-flex min-w-0 items-center gap-1 rounded border border-violet-500/40 px-1.5 py-px font-sans text-[10px] text-violet-700 dark:text-violet-300" title={change.label}>
                  <span className="uppercase tracking-wide">{change.kind}</span>
                  <span className="truncate normal-case">{change.label}</span>
                </span>
              ))}
              <span className="ml-auto flex shrink-0 items-center gap-1 font-sans">
                {explanation === null ? (
                  onExplain === null ? null : (
                  <button type="button" className={cn("rounded px-1.5 py-px opacity-0 hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 group-hover/hunk:opacity-100", OPACITY_TRANSITION, PRESS)} title="Ask an agent what this hunk does and why (K)" onClick={() => onExplain(span.side, span.start, span.stop)}>
                    Explain
                  </button>
                  )
                ) : explanation.status === "running" ? (
                  <button type="button" className={cn("rounded px-1.5 py-px hover:bg-state-hover hover:text-foreground", PRESS)} title="Open the explanation thread" onClick={() => onOpenThread(explanation.threadId)}>
                    explaining…
                  </button>
                ) : explanation.status === "failed" ? (
                  <>
                    <button type="button" className={cn("rounded px-1.5 py-px text-destructive hover:bg-state-hover", PRESS)} onClick={() => onExplain?.(span.side, span.start, span.stop)}>
                      explanation failed · retry
                    </button>
                    <button type="button" className={cn("rounded px-1.5 py-px hover:bg-state-hover hover:text-foreground", PRESS)} onClick={() => onOpenThread(explanation.threadId)}>
                      thread
                    </button>
                  </>
                ) : null}
              </span>
            </div>
          </td>
        </tr>
        {explanation !== null && explanation.status === "completed" && explanation.body !== null ? (
          <tr key={`explain-${index}`}>
            <td colSpan={columns} className="px-3 py-1">
              <ExplanationStrip explanation={explanation} />
            </td>
          </tr>
        ) : null}
      </Fragment>
    );
  };
  const gapRow = (from: number, to: number) => {
    // "Only new" folds the older changes too; the fold says it holds some.
    let older = 0;
    if (newSince.only) for (let at = from; at < to; at++) if (rows[at]!.changed) older += 1;
    return (
      <GapRow
        key={`gap-${from}`}
        path={path}
        from={from}
        to={to}
        total={rows.length}
        first={rows[from]!}
        last={rows[to - 1]!}
        at={rows[foldCursorIndex({ from, to })]!}
        onReveal={reveal}
        columns={columns}
        older={older === 0 ? null : { changed: older, label: newSince.label }}
      />
    );
  };
  const body: ReactNode[] = [];
  for (const entry of shape.entries) {
    if (entry.kind === "gap") {
      body.push(gapRow(entry.from, entry.to));
      continue;
    }
    const { row } = entry;
    // Only rows the reader unfolded fade in; a row stays in `revealed` for good, so the class never re-triggers.
    const unfolded = revealed.has(row.index);
    if (entry.hunkStart !== null) body.push(hunkHeader(entry.hunkStart));
    const RowView = unified ? UnifiedRowView : StructuralRowView;
    // Both halves of a modified pair in unified share the aligned row; the peek opens under one, the new half where there is one.
    const half = unifiedHalf(row, unified);
    const peekHere = half !== "LEFT" || rows[row.index]!.rhs === null;
    body.push(
      <Fragment key={half === null ? row.index : `${row.index}:${half}`}>
        <RowView
          row={row}
          context={rowContext}
          selectedLeft={row.lhs !== null && selected("LEFT", row.lhs)}
          selectedRight={row.rhs !== null && selected("RIGHT", row.rhs)}
          unfolded={unfolded}
          dragging={drag !== null}
        />
        {row.lhs !== null ? annotationRow("LEFT", row.lhs) : null}
        {row.rhs !== null ? annotationRow("RIGHT", row.rhs) : null}
        {symbols.peek !== null && symbols.peek.rowIndex === row.index && peekHere ? (
          <tr key={`peek-${row.index}`}>
            <td colSpan={columns} className="px-3 py-1">
              <SymbolPeek
                trail={symbols.peek.trail}
                data={symbols.symbolData(symbols.peek.trail.at(-1)!)}
                onNavigate={symbols.drillInto}
                onBack={symbols.back}
                onClose={symbols.closePeek}
                onOpenFile={onOpenFile}
                onSymbolHover={symbols.hoverSymbol}
              />
            </td>
          </tr>
        ) : null}
      </Fragment>,
    );
  }
  const hasChanges = rows.some((row) => row.changed);
  return (
    <div className={cn("relative", enter.fade, FAST, symbols.symbolMode && "symbol-mode")}>
      <FileLevelComments
        path={path}
        threads={threads.filter((thread) => thread.line === null)}
        composing={composer !== null && composer.line === null}
        onSubmit={onSubmitComposer}
        onCancel={onCancelComposer}
      />
      {!hasChanges ? <p className="px-3 py-2 text-sm text-muted-foreground">No structural changes.</p> : null}
      {/* Two equal halves (or, unified, one code column) at any width, never a sideways scroll: long lines wrap at spaces under their own indentation. */}
      <div>
        <table ref={tableRef} className="w-full table-fixed border-collapse font-mono text-[12px] leading-5 [tab-size:4]">
          {/* table-fixed sizes columns from the first row, where an empty side is one colSpan=2 cell; pin the gutters here instead. */}
          <colgroup>
            {(unified ? UNIFIED_COLUMNS : SPLIT_COLUMNS).map((width, index) => (
              <col key={index} className={width === "" ? undefined : width} />
            ))}
          </colgroup>
          <tbody>{body}</tbody>
        </table>
      </div>
      {symbols.hover !== null ? <SymbolHoverCard key={symbols.hover.symbol} symbol={symbols.hover.symbol} data={symbols.symbolData(symbols.hover.symbol)} anchor={symbols.hover.anchor} /> : null}
    </div>
  );
}
