import type { DiffCommentTarget, DiffResult } from "../types";
import { cn } from "./utils";
import { shortSha } from "./format";
import { useDiffSource } from "./source";
import { setDiffPreferences } from "./state";
import { FINDING_FILTER_LABEL, nextFindingFilter, type FindingFilter } from "./findings/findings";
import { PRESS, TRANSFORM_TRANSITION, enter } from "./ui/motion";
import { CommitsButton } from "./commits/commit-picker";

/** Totals, with what the diff is against and what it leaves out in the tooltip. */
function DiffStats({ diff }: { diff: DiffResult }) {
  const { files, hiddenVendored } = diff;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const details = [
    diff.baseRef !== null ? `Against ${diff.baseRef}` : null,
    diff.headSha !== null ? `Head ${shortSha(diff.headSha)}` : null,
    hiddenVendored !== null
      ? `${hiddenVendored.files} vendored file${hiddenVendored.files === 1 ? "" : "s"} hidden (+${hiddenVendored.additions} −${hiddenVendored.deletions} under vendor/, node_modules/ and similar). Turn off "Hide vendored files" in the plugin settings to show them.`
      : null,
  ].filter((line) => line !== null);
  return (
    <span className={cn("inline-flex items-center gap-2 text-xs tabular-nums", details.length > 0 && "cursor-help")} title={details.length > 0 ? details.join("\n") : undefined}>
      <span className="font-medium text-foreground">
        {files.length} file{files.length === 1 ? "" : "s"}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
        <span className="text-red-600 dark:text-red-400">−{deletions}</span>
      </span>
    </span>
  );
}

/** A small bordered control in the bar: a chip whose label reads as a setting, lit in a hue while it is on. */
const CHIP = "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs";

/**
 * Where every new comment and reply in the view goes, as one button that names the current target and switches on
 * press (T does the same). GitHub replies are only possible in threads that are on GitHub; the rest stay local.
 */
function CommentTargetSwitch({ target, onChange }: { target: DiffCommentTarget; onChange: (target: DiffCommentTarget) => void }) {
  const { labels } = useDiffSource();
  const github = target === "github";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={github}
      aria-label="New comments go to the GitHub PR"
      title={`New comments go to ${github ? "the GitHub PR, as drafts until you post them" : `the board: ${labels.localTarget.charAt(0).toLowerCase()}${labels.localTarget.slice(1)}`}. Click or T to switch.`}
      className={cn(CHIP, PRESS, github ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300" : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground")}
      onClick={() => onChange(github ? "local" : "github")}
    >
      <span aria-hidden="true" className="opacity-70">→</span>
      {github ? "GitHub PR" : "Local"}
    </button>
  );
}

export type DiffViewMode = "files" | "narrative" | "conversation";

/** Files, the narrative review or the conversation: the ways of reading the same change. */
function ModeSwitch({ mode, stale, onChange, narrative = true, conversation = false }: { mode: DiffViewMode; stale: boolean; onChange: (mode: DiffViewMode) => void; narrative?: boolean; conversation?: boolean }) {
  const option = (value: DiffViewMode, label: string, title: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      title={title}
      className={cn("relative rounded-[5px] px-2 py-0.5", PRESS, mode === value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
      onClick={() => onChange(value)}
    >
      {label}
      {value === "narrative" && stale ? <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-amber-500" aria-hidden="true" /> : null}
    </button>
  );
  return (
    <span role="radiogroup" aria-label="How to read the change" className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/50 p-0.5 text-xs">
      {option("files", "Files", "Every changed file in one scroll (S switches)")}
      {narrative ? option("narrative", "Narrative", stale ? "The agent's step-by-step walk through the change; the code moved since it was written (S switches)" : "The agent's step-by-step walk through the change, the same keys on each step's lines (S switches)") : null}
      {conversation ? option("conversation", "Conversation", "The description, commits, comments and reviews in the order they happened, as on GitHub (gc switches)") : null}
    </span>
  );
}

/**
 * The strip above a non-empty diff: the files / narrative / conversation switch where the source has a narrative or a
 * conversation, totals (what the diff is against in their tooltip), the commits shown, where comments go, the findings
 * filter, whitespace, hidden threads and those left out of the diff, the suggestion batch, the `/` search, split or
 * unified, the file filter, and progress: files viewed, and in the narrative the page reached. The keys themselves are
 * on `?`, named in the view's corner label.
 */
export function SummaryBar({
  diff,
  viewed,
  findingTotal,
  findingShown,
  findingFilter,
  commentTarget,
  mode,
  progress,
  whitespace,
  threads = null,
  suggestions = null,
  search = null,
  layout,
  commits = null,
  fileFilter = null,
}: {
  diff: DiffResult;
  viewed: ReadonlySet<string>;
  findingTotal: number;
  findingShown: number;
  findingFilter: FindingFilter;
  /** Null unless comments can go to GitHub. */
  commentTarget: { target: DiffCommentTarget; onChange: (target: DiffCommentTarget) => void } | null;
  /** Null when the source has no narrative review to switch to. */
  mode: { value: DiffViewMode; stale: boolean; onChange: (mode: DiffViewMode) => void; narrative?: boolean; conversation?: boolean } | null;
  /** The narrative's page reached, while it is showing. */
  progress: { position: number; total: number } | null;
  whitespace: { hidden: boolean; onToggle: () => void };
  /** The threads left out of the diff (resolved, outdated, or all of them by `H`); null in the conversation. */
  threads?: { resolved: number; outdated: number; hidden: boolean; onOpen: () => void; onShow: () => void } | null;
  /** The batch of suggestions `B` built; null while it is empty. */
  suggestions?: { count: number; busy: boolean; onCommit: () => void } | null;
  /** The `/` search while its matches are highlighted: what was searched and "k of N". */
  search?: { query: string; count: string; onClear: () => void } | null;
  /** Split or unified, for the files view's diffs or the narrative's excerpts, whichever is showing. */
  layout: { value: "split" | "unified"; onToggle: () => void };
  /** Which commits the diff shows; null when the source lists none. */
  commits?: { label: string; partial: boolean; onOpen: () => void } | null;
  /** The file filter while it leaves files out. */
  fileFilter?: { shown: number; total: number; onClear: () => void } | null;
}) {
  const viewedCount = diff.files.filter((entry) => viewed.has(entry.path)).length;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground", enter.fade)}>
      {mode !== null ? <ModeSwitch {...mode} mode={mode.value} /> : null}
      <DiffStats diff={diff} />
      {commits !== null ? <CommitsButton {...commits} /> : null}
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {commentTarget !== null ? <CommentTargetSwitch {...commentTarget} /> : null}
        {findingTotal > 0 ? (
          <button
            type="button"
            className={cn(CHIP, "tabular-nums", PRESS, findingFilter !== "off" ? "border-border bg-background text-foreground hover:bg-state-hover" : "border-dashed border-border text-muted-foreground hover:text-foreground")}
            title={`Review findings shown in the diff: ${FINDING_FILTER_LABEL[findingFilter]}. Click (or F) for ${FINDING_FILTER_LABEL[nextFindingFilter(findingFilter)]}; it cycles all → important+ → critical → off.`}
            onClick={() => setDiffPreferences({ findingFilter: nextFindingFilter(findingFilter) })}
          >
            {findingFilter === "off" ? (
              `${findingTotal} finding${findingTotal === 1 ? "" : "s"} hidden`
            ) : findingShown === findingTotal ? (
              <>
                <span className="font-medium">{findingTotal}</span> finding{findingTotal === 1 ? "" : "s"}
              </>
            ) : (
              <>
                <span className="font-medium">
                  {findingShown} of {findingTotal}
                </span>{" "}
                findings
                <span className="text-muted-foreground">· {FINDING_FILTER_LABEL[findingFilter]}</span>
              </>
            )}
          </button>
        ) : null}
        <button
          type="button"
          aria-pressed={whitespace.hidden}
          className={cn(CHIP, PRESS, whitespace.hidden ? "border-border bg-background text-foreground hover:bg-state-hover" : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground")}
          title={whitespace.hidden ? "Whitespace-only changes are drawn as unchanged lines, and files with nothing else changed are folded. Click (or W) to show them." : "Whitespace changes are drawn like any other. Click (or W) to hide them."}
          onClick={whitespace.onToggle}
        >
          {whitespace.hidden ? "Whitespace hidden" : "Whitespace shown"}
        </button>
        <button
          type="button"
          className={cn(CHIP, PRESS, "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground")}
          title={`${layout.value === "split" ? "Old and new side by side" : "One column, deleted lines above added ones"}. Click (or gl) for ${layout.value === "split" ? "unified" : "split"}.`}
          onClick={layout.onToggle}
        >
          {layout.value === "split" ? "Split" : "Unified"}
        </button>
        {threads !== null && threads.hidden ? (
          <button type="button" className={cn(CHIP, PRESS, "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground")} title="Comment threads are hidden in the diff. Click or H to show them." onClick={threads.onShow}>
            threads hidden
          </button>
        ) : null}
        {threads !== null && threads.resolved + threads.outdated > 0 ? (
          <button type="button" className={cn("rounded-md px-2 py-0.5 text-xs tabular-nums hover:bg-state-hover hover:text-foreground", PRESS)} title="Threads left out of the diff. Click or gc for the conversation, which lists every thread." onClick={threads.onOpen}>
            {[threads.resolved > 0 ? `${threads.resolved} resolved` : null, threads.outdated > 0 ? `${threads.outdated} outdated` : null].filter((part) => part !== null).join(" · ")}
          </button>
        ) : null}
        {suggestions !== null ? (
          <button
            type="button"
            className={cn(CHIP, "tabular-nums", PRESS, "border-primary/50 bg-primary/10 text-foreground hover:bg-primary/20 disabled:opacity-50")}
            disabled={suggestions.busy}
            title="Apply every suggestion in the batch at once: one commit on a pull request, else the checkout's files (gB). B on a thread adds or removes one."
            onClick={suggestions.onCommit}
          >
            Commit <span className="font-medium">{suggestions.count}</span> suggestion{suggestions.count === 1 ? "" : "s"}
          </button>
        ) : null}
        {search !== null ? (
          <button
            type="button"
            className={cn(CHIP, "min-w-0 max-w-64", PRESS, "border-amber-500/40 bg-amber-500/10 text-foreground hover:bg-amber-500/20")}
            title={`Searching the diff for “${search.query}”: n / N step through the matches. Click (or Esc in the diff) to clear the highlights.`}
            onClick={search.onClear}
          >
            <span className="min-w-0 truncate font-mono">/{search.query}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{search.count}</span>
          </button>
        ) : null}
        {fileFilter !== null ? (
          <button
            type="button"
            className={cn(CHIP, "tabular-nums", PRESS, "border-primary/40 bg-primary/10 text-foreground hover:bg-primary/20")}
            title="The file filter leaves the other files out of the list, the scroll, the keys and search. Click to clear it (gf changes it)."
            onClick={fileFilter.onClear}
          >
            Showing <span className="font-medium">{fileFilter.shown} of {fileFilter.total}</span> files
          </button>
        ) : null}
      </span>
      <span className="ml-auto inline-flex items-center gap-x-3 tabular-nums">
        {progress !== null && progress.total > 0 ? (
          <span className="inline-flex items-center gap-2" title="Pages of the narrative: each chapter's summary, then its steps">
            <span>
              page <span className="font-medium text-foreground">{progress.position}</span> of {progress.total}
            </span>
            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span className={cn("block h-full origin-left bg-primary/70", TRANSFORM_TRANSITION)} style={{ transform: `scaleX(${progress.position / progress.total})` }} />
            </span>
          </span>
        ) : null}
        <span className="inline-flex items-center gap-2">
          <span>
            <span className="font-medium text-foreground">{viewedCount}</span> of {diff.files.length} viewed
          </span>
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span className={cn("block h-full origin-left bg-emerald-500", TRANSFORM_TRANSITION)} style={{ transform: `scaleX(${viewedCount / diff.files.length})` }} />
          </span>
        </span>
      </span>
    </div>
  );
}
