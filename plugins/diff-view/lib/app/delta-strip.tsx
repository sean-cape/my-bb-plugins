import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DiffCommits, DiffDelta, Review } from "../types";
import { WORKTREE_SHA } from "../types";
import { plural, shortSha } from "./format";
import type { DiffSource } from "./source";
import { passesFindingFilter, type FindingFilter, type InlineFinding } from "./findings/findings";
import { commitsAfter, roundName, roundOf, sameSha, sinceName, type ReviewRound } from "./rounds";
import { cn } from "./utils";
import { FAST, PRESS, STAGGER, enter, stagger } from "./ui/motion";
import { runListMotion, useKeyHandler } from "./ui/vim-keys";
import { OUTSIDE_FINDINGS_KEYMAP, type OutsideFindingsCommand } from "./keys/keymap";

/** Changed files named in the strip; the rest are counted as "+N more". */
const NAMED_FILES = 8;

/** The selector the review keys use to hand the keyboard to the strip. */
export const CHANGES_STRIP = "[data-changes-strip]";

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

/** " · 3 new findings (1 hidden)", naming how many the findings filter keeps out of the diff. */
function findingCount(findings: readonly InlineFinding[], filter: FindingFilter, noun: (count: number) => string): string {
  if (findings.length === 0) return "";
  const hidden = findings.filter((item) => !passesFindingFilter(item.finding.severity, filter)).length;
  return ` · ${findings.length} ${noun(findings.length)}${hidden > 0 ? ` (${hidden} hidden)` : ""}`;
}

const CHIP = cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70", PRESS);

function roundDetail(round: ReviewRound): string {
  if (round.number === 1 && round.carried === 0 && round.resolved === 0) return plural(round.reported, "finding");
  return [round.reported > 0 ? `${round.reported} new` : null, round.carried > 0 ? `${round.carried} still open` : null, round.resolved > 0 ? `${round.resolved} fixed` : null]
    .filter((part) => part !== null)
    .join(" · ") || "no findings";
}

/** What changed after the latest round read the code: "+3 commits", "uncommitted changes", or just that it moved. */
function unreviewedLabel(commits: DiffCommits | null, round: ReviewRound): string {
  const after = commitsAfter(commits, round.review.commitSha);
  if (after === null || after === 0) return "changed since";
  const uncommitted = commits?.commits.at(-1)?.sha === WORKTREE_SHA;
  const committed = after - (uncommitted ? 1 : 0);
  if (committed === 0) return "uncommitted changes since";
  return `+${plural(committed, "commit")}${uncommitted ? " and uncommitted changes" : ""} since`;
}

/** An earlier finding a round found fixed, as the strip lists it: where it was, when its review is still loaded. */
interface FixedFinding {
  id: string;
  title: string;
  path: string | null;
}

function fixedFindings(round: ReviewRound, rounds: readonly ReviewRound[]): FixedFinding[] {
  return (round.review.report?.resolved ?? []).map((entry) => {
    const at = entry.id.lastIndexOf("/");
    const earlier = roundOf(rounds, entry.id.slice(0, at));
    const finding = earlier?.review.report?.findings.find((candidate) => candidate.id === entry.id.slice(at + 1));
    return { id: entry.id.slice(at + 1), title: entry.title || finding?.title || "", path: finding?.locations[0]?.file ?? null };
  });
}

/**
 * Above the diff: the change's review rounds, oldest first, then what came after the latest one (and a review running
 * on it); the files changed since the round the highlight counts from (the latest, unless another round was picked),
 * with "Only new"; and the findings the latest round found fixed. Picking a round counts "new" from its commit. Its
 * own list keys move across it (gh reaches it); Escape hands the keyboard back.
 */
export function ChangesStrip({
  rounds,
  running,
  commits,
  delta,
  latestDelta,
  picked,
  onPick,
  newFindings,
  touchedFindings,
  findingFilter,
  onlyNew,
  onJump,
  inDiff,
  actions,
  onLeave,
}: {
  rounds: readonly ReviewRound[];
  running: Review | null;
  commits: DiffCommits | null;
  /** What the diff highlights: changes since the picked round, else since the source's default point. */
  delta: DiffDelta | null;
  /** Changes since the source's default point, whatever was picked. */
  latestDelta: DiffDelta | null;
  /** The commit of the round picked to count from; null is the default. */
  picked: string | null;
  onPick: (sha: string | null) => void;
  newFindings: readonly InlineFinding[];
  touchedFindings: readonly InlineFinding[];
  findingFilter: FindingFilter;
  onlyNew: { on: boolean; onToggle: () => void };
  onJump: (path: string) => void;
  inDiff: (path: string) => boolean;
  actions: ReactNode;
  onLeave: () => void;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  // Before the review keys, so j and k move here; Enter is the focused button's own click.
  const onKeyDown = useKeyHandler<OutsideFindingsCommand>({
    keymap: OUTSIDE_FINDINGS_KEYMAP,
    onCommand: (command) => {
      const section = sectionRef.current;
      if (section === null) return false;
      switch (command.kind) {
        case "list":
          return runListMotion(section, command.motion);
        case "leave":
          onLeave();
          return;
      }
    },
  });
  const latest = rounds.at(-1) ?? null;
  const defaultRound = latestDelta?.since?.kind === "review" ? roundOf(rounds, latestDelta.since.reviewId) : latest;
  const countingFrom = picked === null ? (defaultRound ?? null) : (rounds.find((round) => sameSha(round.review.commitSha, picked)) ?? null);
  const moved = latestDelta !== null && latestDelta.files.length > 0;
  const files = delta?.files ?? [];
  const since = delta === null ? null : sinceName(delta, rounds);
  const fixed = latest === null || picked !== null ? [] : fixedFindings(latest, rounds);
  return (
    <section ref={sectionRef} data-changes-strip="" aria-label="Changes since the last review" className={cn("flex flex-col gap-1 border-b border-border bg-muted/20 px-3 py-1.5 text-xs", enter.fade)} onKeyDown={onKeyDown}>
      <div data-nav-row="toolbar" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground">
        {rounds.length === 0 && delta !== null ? (
          <span>
            <span className="font-medium text-foreground">Since {since}</span> ({shortSha(delta.fromSha)})
          </span>
        ) : (
          <span className="mr-0.5 font-medium text-foreground">Reviews</span>
        )}
        {rounds.map((round, index) => {
          const selected = round === countingFrom && files.length > 0;
          return (
            <span key={round.review.id} className="inline-flex items-center gap-1.5">
              {index > 0 ? <span aria-hidden="true">›</span> : null}
              <button
                type="button"
                className={cn(CHIP, selected ? "border-sky-500/50 bg-sky-500/10 text-foreground" : "border-border hover:bg-state-hover hover:text-foreground", enter.pop, FAST, STAGGER)}
                style={stagger(index)}
                aria-pressed={selected}
                title={
                  round.review.commitSha == null
                    ? `Review ${roundName(round.number)}`
                    : `Review ${roundName(round.number)} read the code at ${shortSha(round.review.commitSha)}${round.review.sinceCommitSha !== null ? `, re-reviewing from ${shortSha(round.review.sinceCommitSha)}` : ""}. Highlight what changed since it.`
                }
                onClick={() => onPick(round === defaultRound ? null : (round.review.commitSha ?? null))}
              >
                <span className="font-medium">{roundName(round.number)}</span>
                {round.review.commitSha != null ? <span className="font-mono text-[11px]">{shortSha(round.review.commitSha)}</span> : null}
                <span>· {roundDetail(round)}</span>
              </button>
            </span>
          );
        })}
        {latest !== null && moved ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true">›</span>
            <span className="rounded-md border border-dashed border-sky-500/50 px-1.5 py-px text-sky-700 dark:text-sky-300" title="Code no review has read yet; its lines are marked in blue">
              {unreviewedLabel(commits, latest)} {roundName(latest.number)}
            </span>
          </span>
        ) : latest !== null ? (
          <span className="ml-0.5">· nothing changed since {roundName(latest.number)}</span>
        ) : null}
        {running !== null ? <span className="ml-0.5 animate-pulse text-sky-700 dark:text-sky-300">· {roundName(rounds.length + 1)} reviewing…</span> : null}
        <span className="ml-auto flex items-center gap-1.5">{actions}</span>
      </div>
      {files.length > 0 ? (
        <div data-nav-row="toolbar" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted-foreground">
            <span className="font-medium text-sky-700 dark:text-sky-300">Changed since {since}</span> · {plural(files.length, "file")}
            {findingCount(newFindings, findingFilter, (count) => `new finding${count === 1 ? "" : "s"}`)}
            {findingCount(touchedFindings, findingFilter, (count) => `finding${count === 1 ? "" : "s"} on changed lines`)}
          </span>
          {files.slice(0, NAMED_FILES).map((file, index) => (
            <button
              key={file.path}
              type="button"
              className={cn(CHIP, "border-sky-500/40 font-mono text-[11px] text-sky-700 hover:bg-sky-500/15 dark:text-sky-300", enter.pop, FAST, STAGGER)}
              style={stagger(index)}
              title={file.path}
              onClick={() => onJump(file.path)}
            >
              {file.path.split("/").pop()}
            </button>
          ))}
          {files.length > NAMED_FILES ? <span className="text-muted-foreground">+{files.length - NAMED_FILES} more</span> : null}
          <button
            type="button"
            className={cn(CHIP, "ml-auto", onlyNew.on ? "border-sky-500/50 bg-sky-500/15 text-foreground" : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground")}
            aria-pressed={onlyNew.on}
            title={`Show only the files and hunks that changed since ${since}; the rest fold away (gn). ]n / [n step through the new changes.`}
            onClick={onlyNew.onToggle}
          >
            Only new
          </button>
        </div>
      ) : null}
      {fixed.length > 0 && latest !== null ? (
        <div data-nav-row="toolbar" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
          <span>
            Fixed by {roundName(latest.number)}: {fixed.length}
          </span>
          {fixed.map((entry) => {
            const path = entry.path;
            const reachable = path !== null && inDiff(path);
            return (
              <button
                key={entry.id}
                type="button"
                className={cn(CHIP, "border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 disabled:opacity-60 dark:text-emerald-300")}
                disabled={!reachable}
                title={reachable ? `Jump to ${path}, where ${entry.id} was` : `${entry.id}: its file is not in the diff`}
                onClick={() => {
                  if (path !== null) onJump(path);
                }}
              >
                <span className="font-mono text-[11px]">{entry.id}</span>
                <span className="max-w-[24ch] truncate">{entry.title}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
