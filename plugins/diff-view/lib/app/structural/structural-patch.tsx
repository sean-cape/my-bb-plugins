import { Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DiffSide, HunkExplanation, SemanticChange, StructuralDiff, SymbolLookup } from "../../types";
import { checkedLineRange } from "../../line-range";
import { Button, COMPACT } from "../ui/button";
import { cn } from "../utils";
import { FAST, PRESS, SHIMMER, enter } from "../ui/motion";
import { errorMessage } from "../format";
import { useDiffSource } from "../source";
import { setDiffPreferences, useDiffPreferences } from "../state";
import { useHostThemeName } from "../theme";
import { rangesOverlap } from "../ranges";
import type { PatchAnnotationProps } from "../patch-annotations";
import { DiffCommentForm } from "../comments/comment-form";
import { DiffCommentsContext } from "../comments/context";
import { FileLevelComments } from "../comments/file-level-comments";
import { DiffThreadView } from "../comments/thread-view";
import { FindingAnnotation } from "../findings/finding-annotation";
import { SymbolHoverCard } from "../symbols/symbol-hover-card";
import { ExplanationStrip } from "../explanations/explanation-strip";
import { SymbolPeek } from "../symbols/symbol-peek";
import { useSymbolNavigation } from "../symbols/use-symbol-navigation";
import { visualRange, type NavRow } from "../keys/nav";
import { useFileCursor, usePublishNavModel, type FileNavModel } from "../keys/review-keys-context";
import { enclosingDefinition } from "./enclosing-definition";
import { detectMoves, type MovedRow } from "./moves";
import { CONTEXT_LINES, hunkSpan, structuralRows, visibleRows } from "./rows";
import { IDENTIFIER, StructuralLine } from "./structural-line";
import { shikiLangFor, useShikiTokens } from "./syntax";

/** Folded runs up to this long expand in one click; longer ones expand this many lines per click. */
const EXPAND_STEP_LINES = 20;
/** Whole-file adds and deletes longer than this show a preview and a "show more" bar instead of a wall of one colour. */
const LARGE_FILE_PREVIEW_ROWS = 60;
/** How far past the preview a whole-file diff may run before it is cut to the preview. */
const LARGE_FILE_PREVIEW_SLACK = 10;

const NO_ROWS: FileNavModel = { rows: [], cutToHunk: false, element: () => null };

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
  changedRanges,
}: PatchAnnotationProps & {
  onOpenFile: (lookup: SymbolLookup, definition: SymbolLookup["definitions"][number]) => void;
  explanations: HunkExplanation[];
  /** Null when the data source cannot explain hunks. */
  onExplain: ((side: "old" | "new", startLine: number, endLine: number) => void) | null;
  semantics: SemanticChange[];
  changedRanges: Array<[number, number]>;
}) {
  const { onOpenThread } = useContext(DiffCommentsContext);
  const { source } = useDiffSource();
  const [diff, setDiff] = useState<StructuralDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [drag, setDrag] = useState<LineDrag | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const { wrap: diffWrap } = useDiffPreferences();
  const themeName = useHostThemeName();
  const shikiLang = shikiLangFor(path);
  const oldTokens = useShikiTokens(diff?.oldText ?? "", shikiLang, themeName);
  const newTokens = useShikiTokens(diff?.newText ?? "", shikiLang, themeName);
  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    setRevealed(new Set());
    setShowAll(false);
    source.getStructural(path).then(
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
  }, [source, path]);
  const symbols = useSymbolNavigation(source);
  const latestSymbols = useRef(symbols);
  latestSymbols.current = symbols;
  const reveal = (from: number, to: number) => {
    setRevealed((current) => {
      const next = new Set(current);
      for (let i = from; i < to; i++) next.add(i);
      return next;
    });
  };
  // GitHub-style hunks: changed rows plus a few lines of context stay visible; everything else collapses behind expanders.
  const shape = useMemo(() => {
    if (diff === null || !diff.available) return null;
    const rows = structuralRows(diff);
    const visible = visibleRows(rows, { revealed, findingLines: findings.map((entry) => entry.line), threads });
    const wholeFile = diff.status === "created" || diff.status === "deleted" || rows.every((row) => row.changed);
    const previewLimit = wholeFile && !showAll && visible.size > LARGE_FILE_PREVIEW_ROWS + LARGE_FILE_PREVIEW_SLACK ? LARGE_FILE_PREVIEW_ROWS : null;
    const displayed = rows.filter((row) => visible.has(row.index)).slice(0, previewLimit ?? undefined);
    let hunk = -1;
    const nav = displayed.map((row): NavRow => {
      if (row.index === 0 || !visible.has(row.index - 1)) hunk += 1;
      return { left: row.lhs, right: row.rhs, hunk, changed: row.changed };
    });
    return { rows, visible, previewLimit, displayed, nav };
  }, [diff, revealed, findings, threads, showAll]);
  const navModel = useMemo<FileNavModel | null>(() => {
    if (error !== null || (diff !== null && !diff.available)) return NO_ROWS;
    if (shape === null) return null;
    const { displayed, nav, visible, previewLimit } = shape;
    const sideLines = { LEFT: diff!.oldText.split("\n"), RIGHT: diff!.newText.split("\n") };
    const rowElement = (row: number) => (displayed[row] === undefined ? null : (tableRef.current?.querySelector(`[data-row="${displayed[row].index}"]`) ?? null));
    return {
      rows: nav,
      cutToHunk: false,
      element: rowElement,
      moreContext: (row) => {
        if (previewLimit !== null) setShowAll(true);
        const at = displayed[row]?.index;
        if (at === undefined) return;
        let start = at;
        let end = at;
        while (visible.has(start - 1)) start -= 1;
        while (visible.has(end + 1)) end += 1;
        reveal(Math.max(0, start - EXPAND_STEP_LINES), start);
        reveal(end + 1, end + 1 + EXPAND_STEP_LINES);
      },
      symbols: {
        at: (row, side) => {
          const line = side === "LEFT" ? nav[row]?.left : nav[row]?.right;
          const text = line == null ? "" : (sideLines[side][line - 1] ?? "");
          return [...new Set([...text.matchAll(IDENTIFIER)].map((match) => match[0]))];
        },
        peek: (row, symbol) => {
          const element = rowElement(row);
          if (element instanceof HTMLElement) latestSymbols.current.lookupSymbol(symbol, element);
        },
      },
    };
  }, [error, diff, shape]);
  usePublishNavModel(path, navModel);
  const fileCursor = useFileCursor(path);
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
  if (error !== null) return <p className="p-4 text-sm text-destructive">{error}</p>;
  if (diff === null || shape === null) return <p className={cn("relative overflow-hidden p-4 text-sm text-muted-foreground", SHIMMER)}>Running difftastic…</p>;
  if (!diff.available) {
    return (
      <div className={cn("m-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground", enter.fade)}>
        <p>Structural diff unavailable.</p>
        <p className="mt-1 text-xs">{diff.reason}</p>
        <Button type="button" variant="secondary" className={cn(COMPACT, "mt-2")} onClick={() => setDiffPreferences({ mode: "text" })}>
          Show text diff
        </Button>
      </div>
    );
  }
  const oldLines = diff.oldText.split("\n");
  const newLines = diff.newText.split("\n");
  const oldChanges = new Map(diff.oldChanges.map((entry) => [entry.line, entry]));
  const newChanges = new Map(diff.newChanges.map((entry) => [entry.line, entry]));
  const { rows, visible, previewLimit } = shape;
  const moved = detectMoves(rows, oldLines, newLines);
  const jumpToRow = (index: number) => {
    reveal(Math.max(0, index - CONTEXT_LINES), Math.min(rows.length, index + CONTEXT_LINES + 1));
    requestAnimationFrame(() => {
      tableRef.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: "center" });
    });
  };
  const threadsAt = (side: DiffSide, line: number) => threads.filter((thread) => thread.line === line && thread.side === side);
  const cursor = fileCursor?.cursor ?? null;
  const visualSelection = fileCursor?.visual != null ? visualRange(shape.nav, fileCursor.visual, fileCursor.cursor, false) : null;
  const selected = (side: DiffSide, line: number): boolean => {
    if (drag !== null) return side === drag.side && line >= Math.min(drag.anchor, drag.current) && line <= Math.max(drag.anchor, drag.current);
    const range = composer !== null && composer.line !== null ? composer : visualSelection;
    if (range === null || range.line === null) return false;
    if (range.startLine === null || range.startSide === null) return side === range.side && line === range.line;
    if (range.startSide === range.side) return side === range.side && line >= range.startLine && line <= range.line;
    return side === range.startSide ? line >= range.startLine : line <= range.line;
  };
  /** A shift-click extends the open comment's range on the same side, from whichever end stays put. */
  const dragAnchor = (side: DiffSide, line: number, extend: boolean): number => {
    if (!extend || composer === null || composer.line === null || composer.side !== side || (composer.startSide ?? side) !== side) return line;
    const start = composer.startLine ?? composer.line;
    return line < start ? composer.line : start;
  };
  const semanticAt = (side: DiffSide, line: number): SemanticChange | null =>
    semantics.find((change) => {
      if (change.kind === "logic") return false;
      const range = side === "LEFT" ? change.oldLines : change.newLines;
      return range !== null && line >= range[0] && line <= range[1];
    }) ?? null;
  const lineCell = (line: number | null, side: DiffSide, rowChanged: boolean, movedRow: MovedRow | null) => {
    if (line === null) {
      return <td className="bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,var(--color-border)_6px,var(--color-border)_7px)] opacity-40" colSpan={2} />;
    }
    const lines = side === "LEFT" ? oldLines : newLines;
    const sideLine = movedRow !== null ? null : ((side === "LEFT" ? oldChanges : newChanges).get(line) ?? null);
    const text = lines[line - 1] ?? "";
    const lineTokens = (side === "LEFT" ? oldTokens : newTokens)?.[line - 1] ?? null;
    const semantic = rowChanged && movedRow === null ? semanticAt(side, line) : null;
    const neutral = movedRow !== null || semantic !== null;
    const inSelection = selected(side, line);
    const atCursor = cursor !== null && cursor.side === side && cursor.line === line;
    const tint = inSelection ? "bg-amber-400/20" : neutral ? "bg-violet-500/10" : rowChanged && (side === "LEFT" ? "bg-red-500/10" : "bg-emerald-500/10");
    const gutterTint = inSelection ? "bg-amber-400/35" : neutral ? "bg-violet-500/20" : rowChanged && (side === "LEFT" ? "bg-red-500/20" : "bg-emerald-500/20");
    const changedSince = side === "RIGHT" && rangesOverlap(line, line, changedRanges);
    const movedLabel =
      movedRow !== null && movedRow.first ? (
        <button
          type="button"
          className={cn("float-right ml-2 rounded border border-violet-500/40 px-1.5 font-sans text-[10px] text-violet-700 hover:bg-violet-500/20 dark:text-violet-300", PRESS)}
          title={side === "LEFT" ? "This block moved; jump to where it went" : "This block moved; jump to where it came from"}
          onClick={() => jumpToRow(movedRow.counterpart)}
        >
          moved {side === "LEFT" ? "to" : "from"} line {movedRow.counterpartLine}
        </button>
      ) : null;
    return (
      <>
        <td
          className={cn("group/ln select-none border-r border-border/60 pr-2 text-right align-top text-muted-foreground/70", gutterTint, changedSince && "shadow-[inset_2px_0_0_0_theme(colors.sky.500)]", atCursor && "bg-primary/25 font-medium text-foreground")}
          title={changedSince ? "Changed since you last looked" : undefined}
        >
          <button
            type="button"
            className="relative w-full touch-none text-right tabular-nums hover:text-foreground"
            title="Comment on this line; drag or shift-click for several"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              // Keeps the drag from selecting text.
              event.preventDefault();
              setDrag({ side, anchor: dragAnchor(side, line, event.shiftKey), current: line });
            }}
            onClick={(event) => {
              // Pointer clicks start from pointerdown; this is the keyboard's Enter or Space.
              if (event.detail === 0) onStartComment(checkedLineRange({ line, side }));
            }}
          >
            <span className="group-hover/ln:invisible">{line}</span>
            <span className="absolute inset-0 hidden items-center justify-end pr-0.5 text-primary group-hover/ln:flex">+</span>
          </button>
        </td>
        <td className={cn(diffWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre", "pl-2 pr-3 align-top", tint, atCursor && "ring-1 ring-inset ring-primary/70")} data-cursor={atCursor ? "" : undefined}>
          {movedLabel}
          <StructuralLine text={text} changes={sideLine} tokens={lineTokens} side={side} onSymbol={symbols.lookupSymbol} onSymbolHover={symbols.hoverSymbol} />
        </td>
      </>
    );
  };
  const annotationRow = (side: DiffSide, line: number) => {
    const list = threadsAt(side, line);
    const composing = composer !== null && composer.line === line && composer.side === side;
    const lineFindings = side === "RIGHT" ? findings.filter((entry) => entry.line === line) : [];
    if (list.length === 0 && !composing && lineFindings.length === 0) return null;
    return (
      <tr key={`${side}-${line}-notes`}>
        <td colSpan={4} className="px-3 py-1">
          {list.map((thread) => (
            <DiffThreadView key={thread.id} thread={thread} />
          ))}
          {composing && composer !== null ? <DiffCommentForm path={path} range={composer} onSubmit={onSubmitComposer} onCancel={onCancelComposer} /> : null}
          {lineFindings.map((entry) => (
            <FindingAnnotation key={`${entry.item.reviewId}:${entry.item.finding.id}`} item={entry.item} onToggle={(selected) => onToggleFinding(entry.item, selected)} onEdit={(edit) => onEditFinding(entry.item, edit)} />
          ))}
        </td>
      </tr>
    );
  };
  const expanderButton = (label: string, title: string, onClick: () => void) => (
    <button type="button" title={title} aria-label={title} className={cn("rounded px-1.5 py-0.5 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300", PRESS)} onClick={onClick}>
      {label}
    </button>
  );
  const gapRow = (from: number, to: number) => {
    const count = to - from;
    const leading = from === 0;
    const trailing = to === rows.length;
    const first = rows[from]!;
    const last = rows[to - 1]!;
    const range = `${first.rhs ?? first.lhs}–${last.rhs ?? last.lhs}`;
    return (
      <tr key={`gap-${from}`} className="bg-sky-500/10 text-[11px] text-muted-foreground">
        <td colSpan={4} className="px-2 py-0.5">
          <div className="flex items-center gap-1">
            {count <= EXPAND_STEP_LINES ? (
              expanderButton("↕", `Show ${count} unchanged lines`, () => reveal(from, to))
            ) : (
              <>
                {!leading ? expanderButton("↓", `Show ${EXPAND_STEP_LINES} lines below`, () => reveal(from, from + EXPAND_STEP_LINES)) : null}
                {!trailing ? expanderButton("↑", `Show ${EXPAND_STEP_LINES} lines above`, () => reveal(to - EXPAND_STEP_LINES, to)) : null}
              </>
            )}
            <span className="ml-2 font-sans">
              {count} unchanged {count === 1 ? "line" : "lines"} ({range})
            </span>
          </div>
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
    return (
      <Fragment key={`hunk-${index}`}>
        <tr className="bg-muted/30 text-[11px] text-muted-foreground">
          <td colSpan={4} className="px-3 py-0.5">
            <div className="flex items-center gap-2">
              <code className="min-w-0 truncate text-muted-foreground/80" title={enclosing ?? undefined}>
                @@ {span.side === "new" ? "" : "old "}{span.start}–{span.stop}
                {enclosing !== null ? ` ${enclosing}` : ""}
              </code>
              {labels.map((change, labelIndex) => (
                <span key={labelIndex} className="inline-flex min-w-0 items-center gap-1 rounded border border-violet-500/40 px-1.5 py-px font-sans text-[10px] text-violet-700 dark:text-violet-300" title={change.label}>
                  <span className="uppercase tracking-wide">{change.kind}</span>
                  <span className="truncate normal-case">{change.label}</span>
                </span>
              ))}
              <span className="ml-auto flex shrink-0 items-center gap-1 font-sans">
                {explanation === null ? (
                  onExplain === null ? null : (
                  <button type="button" className={cn("rounded px-1.5 py-px hover:bg-state-hover hover:text-foreground", PRESS)} title="Ask an agent what this hunk does and why" onClick={() => onExplain(span.side, span.start, span.stop)}>
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
            <td colSpan={4} className="px-3 py-1">
              <ExplanationStrip explanation={explanation} />
            </td>
          </tr>
        ) : null}
      </Fragment>
    );
  };
  const body: ReactNode[] = [];
  let gapStart: number | null = null;
  let emitted = 0;
  for (const row of rows) {
    if (!visible.has(row.index)) {
      gapStart ??= row.index;
      continue;
    }
    if (gapStart !== null) {
      body.push(gapRow(gapStart, row.index));
      gapStart = null;
    }
    if (previewLimit !== null && emitted >= previewLimit) {
      body.push(
        <tr key="preview-more" className="bg-sky-500/10 text-xs text-muted-foreground">
          <td colSpan={4} className="px-3 py-1.5">
            <button type="button" className={cn("rounded px-1.5 py-0.5 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300", PRESS)} onClick={() => setShowAll(true)}>
              Show {visible.size - emitted} more {visible.size - emitted === 1 ? "line" : "lines"} of this {diff.status === "deleted" ? "deleted" : "new"} file
            </button>
          </td>
        </tr>,
      );
      gapStart = null;
      break;
    }
    emitted += 1;
    const startsHunk = row.index === 0 || !visible.has(row.index - 1);
    // Only rows the reader unfolded fade in; a row stays in `revealed` for good, so the class never re-triggers.
    const unfolded = revealed.has(row.index) || (showAll && emitted > LARGE_FILE_PREVIEW_ROWS);
    if (startsHunk) body.push(hunkHeader(row.index));
    body.push(
      <Fragment key={row.index}>
        <tr
          className={cn("hover:bg-state-hover/40", unfolded && [enter.fade, FAST])}
          data-row={row.index}
          onPointerEnter={
            drag === null
              ? undefined
              : () => {
                  const line = drag.side === "LEFT" ? row.lhs : row.rhs;
                  if (line !== null && line !== drag.current) setDrag({ ...drag, current: line });
                }
          }
        >
          {lineCell(row.lhs, "LEFT", row.changed, moved.get(row.index) ?? null)}
          {lineCell(row.rhs, "RIGHT", row.changed, moved.get(row.index) ?? null)}
        </tr>
        {row.lhs !== null ? annotationRow("LEFT", row.lhs) : null}
        {row.rhs !== null ? annotationRow("RIGHT", row.rhs) : null}
        {symbols.peek !== null && symbols.peek.rowIndex === row.index ? (
          <tr key={`peek-${row.index}`}>
            <td colSpan={4} className="px-3 py-1">
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
  if (gapStart !== null && (previewLimit === null || emitted < previewLimit)) body.push(gapRow(gapStart, rows.length));
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
      <div className={cn(!diffWrap && "overflow-x-auto")}>
        <table ref={tableRef} className={cn("border-collapse font-mono text-[12px] leading-5", diffWrap ? "w-full table-fixed" : "min-w-full table-auto")}>
          {/* table-fixed sizes columns from the first row, where an empty side is one colSpan=2 cell; pin the gutters here instead. */}
          <colgroup>
            <col className="w-12" />
            <col />
            <col className="w-12" />
            <col />
          </colgroup>
          <tbody>{body}</tbody>
        </table>
      </div>
      {symbols.hover !== null ? <SymbolHoverCard key={symbols.hover.symbol} symbol={symbols.hover.symbol} data={symbols.symbolData(symbols.hover.symbol)} anchor={symbols.hover.anchor} /> : null}
    </div>
  );
}
