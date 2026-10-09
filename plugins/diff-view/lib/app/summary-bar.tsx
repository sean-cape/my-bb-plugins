import type { DiffCommentTarget, DiffFile, DiffResult } from "../types";
import { cn } from "./utils";
import { shortSha } from "./format";
import { useDiffSource } from "./source";
import { setDiffPreferences } from "./state";
import { PRESS, TRANSFORM_TRANSITION, enter } from "./ui/motion";

function DiffStats({ files }: { files: readonly DiffFile[] }) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs tabular-nums">
      <span className="text-muted-foreground">{files.length} file{files.length === 1 ? "" : "s"}</span>
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  );
}

/** Where every new comment and reply in the view goes. GitHub replies are only possible in threads that are on GitHub; the rest stay local. */
function CommentTargetSwitch({ target, onChange }: { target: DiffCommentTarget; onChange: (target: DiffCommentTarget) => void }) {
  const { labels } = useDiffSource();
  const option = (value: DiffCommentTarget, label: string, title: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={target === value}
      title={title}
      className={cn("rounded px-1.5 py-0.5", PRESS, target === value ? (value === "github" ? "bg-sky-500/15 text-sky-700 dark:text-sky-300" : "bg-state-active text-foreground") : "text-muted-foreground hover:text-foreground")}
      onClick={() => onChange(value)}
    >
      {label}
    </button>
  );
  return (
    <span className="inline-flex items-center gap-1.5">
      Comments go to
      <span role="radiogroup" aria-label="Where new comments go" className="inline-flex items-center gap-0.5 rounded-md border border-border p-0.5 text-[11px]">
        {option("local", "Local", labels.localTarget)}
        {option("github", "GitHub PR", "Queued as drafts and posted to the pull request when you press Post")}
      </span>
    </span>
  );
}

/** The strip above a non-empty diff: totals, what it is against, keyboard help, where comments go, comment and finding controls, and viewed progress. */
export function SummaryBar({
  diff,
  viewed,
  hasThreads,
  findingTotal,
  showFindings,
  onNextComment,
  onShowKeys,
  commentTarget,
}: {
  diff: DiffResult;
  viewed: ReadonlySet<string>;
  hasThreads: boolean;
  findingTotal: number;
  showFindings: boolean;
  onNextComment: () => void;
  onShowKeys: () => void;
  /** Null unless comments can go to GitHub. */
  commentTarget: { target: DiffCommentTarget; onChange: (target: DiffCommentTarget) => void } | null;
}) {
  const viewedCount = diff.files.filter((entry) => viewed.has(entry.path)).length;
  return (
    <div className={cn("flex flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground", enter.fade)}>
      <DiffStats files={diff.files} />
      {diff.baseRef !== null ? <span>· against {diff.baseRef}</span> : null}
      {diff.headSha !== null ? <span>· {shortSha(diff.headSha)}</span> : null}
      {diff.hiddenVendored !== null ? (
        <span title={`+${diff.hiddenVendored.additions} −${diff.hiddenVendored.deletions} under vendor/, node_modules/ and similar. Turn off "Hide vendored files" in the plugin settings to show them.`}>
          · {diff.hiddenVendored.files} vendored file{diff.hiddenVendored.files === 1 ? "" : "s"} hidden
        </span>
      ) : null}
      <button type="button" className={cn("rounded px-1 text-muted-foreground/70 hover:bg-state-hover hover:text-foreground", PRESS)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={onShowKeys}>
        ⌨
      </button>
      {commentTarget !== null ? <CommentTargetSwitch {...commentTarget} /> : null}
      {hasThreads ? (
        <button type="button" className={cn("rounded border border-border px-1.5 py-0.5 text-xs hover:bg-state-hover", PRESS)} title="Scroll to the next comment (c)" onClick={onNextComment}>
          Next comment
        </button>
      ) : null}
      {findingTotal > 0 ? (
        <button
          type="button"
          aria-pressed={showFindings}
          className={cn("rounded border border-border px-1.5 py-0.5 text-xs hover:bg-state-hover", PRESS, showFindings && "bg-state-active text-foreground")}
          title={showFindings ? "Hide the review's findings in the diff" : "Show the review's findings in the diff"}
          onClick={() => setDiffPreferences({ showFindings: !showFindings })}
        >
          {findingTotal} finding{findingTotal === 1 ? "" : "s"}
        </button>
      ) : null}
      <span className="ml-auto inline-flex items-center gap-2 tabular-nums">
        {viewedCount} of {diff.files.length} viewed
        <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span className={cn("block h-full origin-left bg-emerald-500", TRANSFORM_TRANSITION)} style={{ transform: `scaleX(${viewedCount / diff.files.length})` }} />
        </span>
      </span>
    </div>
  );
}
