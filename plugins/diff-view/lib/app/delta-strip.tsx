import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { DiffCommits, DiffDelta, Review } from "../types";
import { WORKTREE_SHA } from "../types";
import { plural, shortSha } from "./format";
import type { DiffSource } from "./source";
import { commitsAfter, sinceName, type ReviewRound } from "./rounds";
import { cn } from "./utils";
import { enter } from "./ui/motion";

/**
 * What changed since `fromSha`, or since the source's default point when null, refetched when the head or the reviews
 * move; null when the source does not track it or nothing changed.
 */
export function useDelta(source: DiffSource, headSha: string | null, fromSha: string | null, reviews: unknown, enabled = true): DiffDelta | null {
  const [delta, setDelta] = useState<DiffDelta | null>(null);
  useEffect(() => {
    if (source.delta === undefined || !enabled) {
      setDelta(null);
      return;
    }
    let cancelled = false;
    source.delta(fromSha).then(
      (result) => {
        if (!cancelled) setDelta(result);
      },
      () => {
        if (!cancelled) setDelta(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, headSha, fromSha, reviews, enabled]);
  return delta;
}

/** What changed after the latest review read the code: "3 commits", "uncommitted changes", or null when unknown. */
function unreviewedLabel(commits: DiffCommits | null, round: ReviewRound): string | null {
  const after = commitsAfter(commits, round.review.commitSha);
  if (after === null || after === 0) return null;
  const uncommitted = commits?.commits.at(-1)?.sha === WORKTREE_SHA;
  const committed = after - (uncommitted ? 1 : 0);
  if (committed === 0) return "uncommitted changes";
  return `${plural(committed, "commit")}${uncommitted ? " and uncommitted changes" : ""}`;
}

/**
 * One line above the diff saying where the AI review stands: the commit it last read, what no review has read since
 * (marked blue in the gutter), a re-review running on it, and how many findings are open, with the host's controls
 * (a re-review button) at the end. Without reviews, the host's own point new code counts from.
 */
export function ChangesStrip({
  rounds,
  running,
  commits,
  delta,
  open,
  actions,
}: {
  rounds: readonly ReviewRound[];
  running: Review | null;
  commits: DiffCommits | null;
  /** What changed since the source's default point, cut to the diff's files. */
  delta: DiffDelta | null;
  /** Open findings shown in the diff. */
  open: number;
  actions: ReactNode;
}) {
  const latest = rounds.at(-1) ?? null;
  const moved = delta !== null && delta.files.length > 0;
  const commit = latest?.review.commitSha ?? null;
  const since = moved ? (latest === null ? null : unreviewedLabel(commits, latest)) : null;
  return (
    <section aria-label="Review status" className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground", enter.fade)}>
      {latest !== null ? (
        <>
          <span className="font-medium text-foreground">AI review</span>
          <span title={rounds.length > 1 ? `${plural(rounds.length, "review")} so far; each re-review re-checks the open findings and resolves the fixed ones` : undefined}>
            read up to {commit === null ? "an unknown commit" : <span className="font-mono">{shortSha(commit)}</span>}
          </span>
          {moved ? (
            <span className="text-sky-700 dark:text-sky-300" title="Code no review has read yet: its lines are marked blue in the gutter (]n / [n step through them, gn shows only them)">
              · {since === null ? "the code changed since" : `${since} since, not reviewed yet`}
            </span>
          ) : (
            <span>· nothing changed since</span>
          )}
          {running !== null ? <span className="animate-pulse text-sky-700 dark:text-sky-300">· re-reviewing…</span> : null}
          <span>· {plural(open, "open finding")}</span>
        </>
      ) : delta !== null ? (
        <span>
          <span className="font-medium text-foreground">Since {sinceName(delta, rounds)}</span> ({shortSha(delta.fromSha)}): {plural(delta.files.length, "file")} changed, marked blue in the gutter
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-1.5">{actions}</span>
    </section>
  );
}
