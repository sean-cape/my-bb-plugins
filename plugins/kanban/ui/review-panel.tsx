import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { CHEVRON, OPACITY_TRANSITION, PRESS, STAGGER, enter, speed, stagger, usePopOnChange, POPOVER_MOTION } from "bb-motion";
import { reviewRounds, roundName } from "bb-diff-view/app/rounds";
import type { Ticket } from "../shared/board";
import { locationLabel } from "../shared/finding-location";
import {
  CONFIDENCE_BAR,
  DEFAULT_REVIEW_DEPTH,
  NOT_COVERED_REPORT_VERSION,
  REVIEW_DEPTH_LABEL,
  TRIAGED_REPORT_VERSION,
  VERIFIED_REPORT_VERSION,
  closedFindingIds,
  findingTallies,
  reviewDepthSchema,
  type Finding,
  type FindingSeverity,
  type Review,
  type ReviewDepth,
} from "../shared/review";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { firstSentence, shortSha } from "./format";
import { type Rpc, usePushPreference, useReviewUnavailableReason } from "./data";
import { PushToggle, Badge, ThreadStatusDot, COMPACT, Group, KANBAN_MENU, MENU_ITEM_CLASS, SegmentedTabs, menuVimKeys } from "./primitives";
import { type RunAction, toastError } from "./actions";

const SEVERITY_LABEL: Record<FindingSeverity, string> = { critical: "Critical", important: "Important", minor: "Minor" };
const MAKE_CARD_TITLE = "Add a Backlog card carrying this finding's title, description, fix and locations";
const SEVERITY_TONE: Record<FindingSeverity, "danger" | "warning" | "neutral"> = {
  critical: "danger",
  important: "warning",
  minor: "neutral",
};

function SeverityCountBadges({ counts, appliedCount }: { counts: NonNullable<Ticket["latestReview"]>["counts"]; appliedCount: number }) {
  if (counts === null) return null;
  const total = counts.critical + counts.important + counts.minor;
  if (total === 0) return <Badge tone="success">{appliedCount > 0 ? "all applied" : "no findings"}</Badge>;
  return (
    <>
      {(["critical", "important", "minor"] as const)
        .filter((severity) => counts[severity] > 0)
        .map((severity) => (
          <Badge key={severity} tone={SEVERITY_TONE[severity]} title={`${counts[severity]} ${SEVERITY_LABEL[severity].toLowerCase()} finding(s)`}>
            {counts[severity]} {severity}
          </Badge>
        ))}
    </>
  );
}

/** `a.ts:12`, or the first of several with how many more; the file's name alone, since the row has no room for its directory and the tooltip has the full paths. */
function whereLabel(finding: Finding): string | null {
  const first = finding.locations[0];
  if (first === undefined) return null;
  const label = locationLabel({ ...first, file: first.file.split("/").pop() ?? first.file });
  return finding.locations.length === 1 ? label : `${label} +${finding.locations.length - 1}`;
}

/** Severity shows twice in a list: the rule down its section and the dot on each row, in the same hue. */
const SEVERITY_DOT: Record<FindingSeverity, string> = { critical: "bg-red-500", important: "bg-amber-500", minor: "bg-slate-400" };
const SEVERITY_RULE: Record<FindingSeverity, string> = { critical: "border-red-500/50", important: "border-amber-500/50", minor: "border-slate-400/50" };

/** Rows share one border, so a report reads as a few lists rather than a stack of boxes; dashed for findings outside the apply round. */
function FindingList({ dashed = false, children }: { dashed?: boolean; children: ReactNode }) {
  return <ul className={cn("flex flex-col divide-y divide-border rounded-md border border-border bg-card", dashed && "border-dashed")}>{children}</ul>;
}

function SectionHeading({ label, count, hint, tone }: { label: string; count: number; hint?: string; tone?: FindingSeverity }) {
  return (
    <div className="mb-1.5 flex flex-col gap-0.5">
      <h3 className="flex items-baseline gap-1.5 text-xs">
        {tone === undefined ? <span className="font-medium">{label}</span> : <Badge tone={SEVERITY_TONE[tone]}>{label}</Badge>}
        <span className="tabular-nums text-muted-foreground">{count}</span>
      </h3>
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * One finding as a single row (checkbox, severity, title, where) that opens to its details on click or Enter. The
 * scores the review gave it sit in the id's tooltip once open, since they shaped the triage and seldom change what the
 * reader does with it.
 */
function FindingCard({
  finding,
  index,
  verified,
  selected = null,
  overridden = false,
  closed = null,
  onToggle = null,
  onResolve = null,
  action = null,
  kind = "introduced",
}: {
  finding: Finding;
  /** Position across all severity groups, so the whole report cascades as one list. */
  index: number;
  /** The report went through the verify pass, so a finding without a confidence is unverified rather than older. */
  verified: boolean;
  selected?: boolean | null;
  overridden?: boolean;
  /** An apply round fixed it, or the reviewer resolved it: it is folded to its title and kept out of the next round. */
  closed?: "applied" | "resolved" | null;
  onToggle?: ((selected: boolean) => void) | null;
  /** Resolves it, or (false) reopens it however it was closed. */
  onResolve?: ((resolved: boolean) => void) | null;
  /** A button at the end of the header line. */
  action?: ReactNode;
  /** Pre-existing and deferred ones are drawn dashed; filtered ones dimmed, with the verifier's reason. */
  kind?: "introduced" | "deferred" | "pre-existing" | "filtered";
}) {
  const applied = closed !== null;
  const appliedPop = usePopOnChange(applied);
  const [open, setOpen] = useState(false);
  const where = whereLabel(finding);
  return (
    <li
      style={stagger(index)}
      className={cn(
        "px-2 py-1 first:rounded-t-[5px] last:rounded-b-[5px]",
        enter.rise,
        speed.fast,
        STAGGER,
        OPACITY_TRANSITION,
        (selected === false || applied || kind === "filtered") && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        {selected !== null && onToggle !== null && !applied ? (
          <Checkbox checked={selected} onCheckedChange={(checked) => onToggle(checked === true)} aria-label={`${selected ? "Exclude" : "Include"} ${finding.id} in the apply round`} />
        ) : null}
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left" aria-expanded={open} data-bbm-open={open} onClick={() => setOpen(!open)}>
          <Icon name="ChevronRight" className={cn("size-3 shrink-0 text-muted-foreground", CHEVRON)} />
          <span className={cn("size-1.5 shrink-0 rounded-full", applied ? "bg-emerald-500" : SEVERITY_DOT[finding.severity])} title={SEVERITY_LABEL[finding.severity]} />
          <span className={cn("min-w-0 flex-1 truncate text-sm", applied && "text-muted-foreground line-through")} title={finding.title}>
            {finding.title}
          </span>
          {/* A fixed block on the right, so every row's location starts in the same column and the title takes the rest. */}
          {where !== null ? (
            <code className="hidden w-36 shrink-0 truncate text-right font-mono text-[11px] text-muted-foreground sm:inline" title={finding.locations.map(locationLabel).join("\n")}>
              {where}
            </code>
          ) : null}
        </button>
        {closed !== null ? <Badge tone="success">{closed}</Badge> : null}
        {onResolve !== null ? (
          <button
            type="button"
            aria-label={applied ? `Reopen ${finding.id}` : `Resolve ${finding.id}`}
            title={
              applied
                ? "Reopen: show it in the diff again, and in the next apply round and re-review"
                : "Resolve: take it out of the diff and the apply round, as a GitHub thread is resolved; re-reviews leave it be"
            }
            className={cn("flex size-6 shrink-0 items-center justify-center rounded hover:bg-state-hover", PRESS, applied ? "text-emerald-600 dark:text-emerald-300" : "text-muted-foreground hover:text-foreground")}
            onClick={() => onResolve(!applied)}
          >
            {/* The pop lives on a wrapper so remounting it never takes focus from the button. */}
            <span key={appliedPop.key} onAnimationEnd={appliedPop.onAnimationEnd} className={cn("flex", appliedPop.className)}>
              <Icon name="CircleCheck" className="size-3.5" />
            </span>
          </button>
        ) : null}
        {action}
      </div>
      {open ? <FindingDetails finding={finding} verified={verified} overridden={overridden && !applied} kind={kind} /> : null}
    </li>
  );
}

function FindingDetails({ finding, verified, overridden, kind }: { finding: Finding; verified: boolean; overridden: boolean; kind: "introduced" | "deferred" | "pre-existing" | "filtered" }) {
  const instances = finding.locations.length;
  const meta = [
    SEVERITY_LABEL[finding.severity],
    instances > 1 ? `${instances} instances` : null,
    finding.carriedFrom !== null ? `still open from ${finding.carriedFrom.split("/").pop()}` : null,
    overridden ? "selection changed by you" : null,
    finding.confidence === null && verified ? "unverified" : null,
  ].filter((part) => part !== null);
  const scores = [
    finding.importance !== null && finding.scopeFit !== null ? `importance ${finding.importance}/5 · scope fit ${finding.scopeFit}/5` : null,
    finding.confidence !== null ? `verifier confidence ${finding.confidence} (how sure it is real, not how much it matters)` : null,
    finding.class !== null && finding.class !== "" ? `class: ${finding.class}` : null,
  ].filter((part) => part !== null);
  return (
    <div className={cn("flex flex-col gap-1.5 pb-1.5 pl-7 pt-1", enter.rise, speed.fast)}>
      <p className="text-xs text-muted-foreground">
        <span className={cn("font-mono", scores.length > 0 && "cursor-help underline decoration-dotted underline-offset-2")} title={scores.length > 0 ? scores.join("\n") : undefined}>
          {finding.id}
        </span>
        {" · "}
        {meta.join(" · ")}
      </p>
      {finding.locations.length > 1 ? (
        <div className="flex flex-wrap gap-1">
          {finding.locations.map((location) => (
            <code key={locationLabel(location)} className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
              {locationLabel(location)}
            </code>
          ))}
        </div>
      ) : null}
      {kind === "filtered" && finding.verification !== null && finding.verification !== "" ? <p className="text-xs text-muted-foreground">Verifier: {finding.verification}</p> : null}
      {finding.triage !== null && finding.triage.decision !== "apply" && finding.triage.reason !== "" ? (
        <p className="text-xs text-muted-foreground">
          Triage: {finding.triage.decision === "defer" ? "deferred" : "dropped"} — {finding.triage.reason}
        </p>
      ) : null}
      {finding.description !== "" ? <Markdown content={finding.description} className="text-sm" /> : null}
      {finding.fix !== null && finding.fix !== "" ? (
        <div className="flex gap-1.5 text-sm">
          <Icon name="kanban-wrench" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <Markdown content={finding.fix} className="min-w-0 flex-1" />
        </div>
      ) : null}
    </div>
  );
}

/** The review's summary paragraph, cut to its first sentence until asked for whole. */
function ReviewSummary({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  const first = firstSentence(summary);
  const more = first.length < summary.trim().length;
  return (
    <div className="flex flex-col gap-1">
      <Markdown content={open || !more ? summary : first} className="text-sm" />
      {more ? (
        <button type="button" className="self-start text-xs text-muted-foreground hover:text-foreground hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  );
}

/** Make a card, or open the one made; disabled while the request runs so two presses can't race. */
function CardAction({ card, onMakeCard, onOpenCard }: { card: string | null; onMakeCard: (() => Promise<void>) | null; onOpenCard: (ticketId: string) => void }) {
  const [making, setMaking] = useState(false);
  if (card !== null) {
    return (
      <Button type="button" variant="ghost" size="sm" className="-my-0.5 h-6 px-2 text-xs" onClick={() => onOpenCard(card)}>
        <Icon name="ArrowUpRight" className="size-3.5" />
        Open card
      </Button>
    );
  }
  if (onMakeCard === null) return null;
  return (
    <span title={MAKE_CARD_TITLE}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-my-0.5 h-6 px-2 text-xs"
        disabled={making}
        onClick={() => {
          setMaking(true);
          void onMakeCard().finally(() => setMaking(false));
        }}
      >
        <Icon name="Plus" className="size-3.5" />
        Make a card
      </Button>
    </span>
  );
}

/** Findings kept for a look, folded under their count until asked for. */
function FoldedFindings({ label, count, title, children }: { label: string; count: number; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label={`${label[0]!.toUpperCase()}${label.slice(1)} findings`}>
      <button
        type="button"
        aria-expanded={open}
        data-bbm-open={open}
        className="flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground"
        title={title}
        onClick={() => setOpen(!open)}
      >
        <Icon name="ChevronRight" className={cn("size-3.5", CHEVRON)} />
        <span className="font-medium tabular-nums">{count}</span> {label}
      </button>
      {open ? (
        <div className="mt-1.5">
          <FindingList dashed>{children}</FindingList>
        </div>
      ) : null}
    </section>
  );
}

function StructuredReview({
  review,
  onToggle,
  onReset,
  onResolve,
  onMakeCard,
  onOpenCard,
}: {
  review: Review;
  /** Null makes the view read-only (old reviews). */
  onToggle: ((findingId: string, selected: boolean) => void) | null;
  onReset: (() => void) | null;
  /** Resolves a finding, or reopens one however it was closed. */
  onResolve: ((findingId: string, resolved: boolean, closed: "applied" | "resolved" | null) => void) | null;
  /** Resolves to the card made from the finding, new or made before. */
  onMakeCard: ((findingId: string) => Promise<string | null>) | null;
  onOpenCard: (ticketId: string) => void;
}) {
  const report = review.report!;
  const verified = report.version >= VERIFIED_REPORT_VERSION;
  const tallies = findingTallies(report, review.selection, [...closedFindingIds(review)]);
  const { introduced, deferred, dropped, preExisting } = tallies;
  const [cards, setCards] = useState<Record<string, string>>({});
  const triagedOut = new Set([...deferred, ...dropped]);
  const grouped = (["critical", "important", "minor"] as const)
    .map((severity) => ({ severity, findings: introduced.filter((finding) => finding.severity === severity && !triagedOut.has(finding)) }))
    .filter((group) => group.findings.length > 0);
  const listed = grouped.reduce((sum, group) => sum + group.findings.length, 0);
  const applied = new Set(review.appliedFindingIds);
  const resolvedByYou = new Set(review.resolvedFindingIds);
  const closedAs = (id: string) => (resolvedByYou.has(id) ? "resolved" : applied.has(id) ? "applied" : null);
  const overriddenCount = Object.keys(review.selectionOverrides).length;
  const suggested = report.version >= TRIAGED_REPORT_VERSION ? "Suggested: the findings the review's triage applies" : "Suggested: critical, or importance ≥ 3 and scope ≥ 3";
  const ownCard = (finding: Finding, index: number, kind: "introduced" | "deferred" = "introduced", action: ReactNode = null) => (
    <FindingCard
      key={finding.id}
      finding={finding}
      index={index}
      verified={verified}
      kind={kind}
      selected={review.selection[finding.id] ?? null}
      overridden={finding.id in review.selectionOverrides}
      closed={closedAs(finding.id)}
      onToggle={onToggle === null ? null : (selected) => onToggle(finding.id, selected)}
      onResolve={onResolve === null ? null : (resolved) => onResolve(finding.id, resolved, closedAs(finding.id))}
      action={action}
    />
  );
  const cardAction = (finding: Finding) => (
    <CardAction
      card={cards[finding.id] ?? null}
      onMakeCard={
        onMakeCard === null
          ? null
          : () =>
              onMakeCard(finding.id).then((ticketId) => {
                if (ticketId !== null) setCards((current) => ({ ...current, [finding.id]: ticketId }));
              })
      }
      onOpenCard={onOpenCard}
    />
  );
  return (
    <div className="flex flex-col gap-3">
      {report.summary !== "" ? <ReviewSummary summary={report.summary} /> : null}
      {introduced.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span title={overriddenCount > 0 ? `${overriddenCount} changed by you` : suggested}>
            <span className="font-semibold text-foreground tabular-nums">{tallies.selected}</span> of <span className="tabular-nums">{tallies.open}</span> open selected
            {tallies.applied > 0 ? <> · <span className="tabular-nums">{tallies.applied}</span> applied or resolved</> : null}
          </span>
          {onReset !== null && overriddenCount > 0 ? (
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onReset}>
              Reset to suggested
            </Button>
          ) : null}
        </div>
      ) : null}
      {grouped.length === 0 ? (
        <p className={cn("text-sm text-muted-foreground", enter.fade)}>
          {introduced.length > 0 ? "Triage applies none of this change's findings." : preExisting.length > 0 ? "No findings in this change." : "No findings."}
        </p>
      ) : null}
      {grouped.map(({ severity, findings }, groupIndex) => (
        <section key={severity} aria-label={SEVERITY_LABEL[severity]} className={cn("border-l-2 pl-3", SEVERITY_RULE[severity])}>
          <SectionHeading label={SEVERITY_LABEL[severity]} count={findings.length} tone={severity} />
          <FindingList>{findings.map((finding, index) => ownCard(finding, grouped.slice(0, groupIndex).reduce((sum, group) => sum + group.findings.length, 0) + index))}</FindingList>
        </section>
      ))}
      {deferred.length > 0 ? (
        <section aria-label="Deferred">
          <SectionHeading label="Deferred" count={deferred.length} hint="Real, but triage judged the fix separate work: make it a card, or tick it to fix it in this change." />
          <FindingList dashed>{deferred.map((finding, index) => ownCard(finding, listed + index, "deferred", cardAction(finding)))}</FindingList>
        </section>
      ) : null}
      {dropped.length > 0 ? (
        <FoldedFindings label="dropped" count={dropped.length} title="Findings triage judged not worth their churn, or against the project's conventions; tick one to fix it anyway">
          {dropped.map((finding, index) => ownCard(finding, index))}
        </FoldedFindings>
      ) : null}
      {preExisting.length > 0 ? (
        <section aria-label="Pre-existing">
          <SectionHeading label="Pre-existing" count={preExisting.length} hint="Already in the code before this change, so never part of an apply round." />
          <FindingList dashed>
            {preExisting.map((finding, index) => (
              <FindingCard key={finding.id} finding={finding} index={introduced.length + index} verified={verified} kind="pre-existing" action={cardAction(finding)} />
            ))}
          </FindingList>
        </section>
      ) : null}
      {report.filtered.length > 0 ? (
        <FoldedFindings label="filtered" count={report.filtered.length} title={`Findings the verifier scored below ${CONFIDENCE_BAR} for being real; never selected or applied`}>
          {report.filtered.map((finding, index) => (
            <FindingCard key={finding.id} finding={finding} index={index} verified={verified} kind="filtered" />
          ))}
        </FoldedFindings>
      ) : null}
      {report.resolved.length > 0 ? (
        <section aria-label="Resolved since the last review">
          <SectionHeading label="Resolved since the last review" count={report.resolved.length} />
          <ul className="flex flex-col gap-1 text-sm">
            {report.resolved.map((entry) => (
              <li key={entry.id} className="flex gap-1.5">
                <Icon name="Check" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="text-muted-foreground line-through">{entry.title === "" ? entry.id.split("/").pop() : entry.title}</span>
                  {entry.note !== "" ? <span className="text-muted-foreground"> — {entry.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.version >= NOT_COVERED_REPORT_VERSION ? (
        <section aria-label="Not covered">
          <SectionHeading
            label="Not covered"
            count={report.notCovered.length}
            hint={report.notCovered.length === 0 ? "The review found nothing the checks miss." : "Neither the checks nor the review could confirm these; look at them yourself."}
          />
          {report.notCovered.length === 0 ? null : (
            <>
              <ul className="flex flex-col gap-1 text-sm">
                {report.notCovered.map((entry) => (
                  <li key={entry} className="flex gap-1.5">
                    <Icon name="Circle" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <Markdown content={entry} className="min-w-0 flex-1" />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}
      {report.skippedFiles.length > 0 ? (
        <p className="text-xs text-muted-foreground">Skipped generated files: {report.skippedFiles.join(", ")}</p>
      ) : null}
    </div>
  );
}

function applyStatusLabel(apply: NonNullable<Review["apply"]>, local: boolean): string {
  if (apply.completedAt === null) return local ? "Card thread applying" : "Apply thread running";
  if (local) return `Committed ${shortSha(apply.pushedCommit)}`;
  return apply.push ? `Pushed ${shortSha(apply.pushedCommit)}` : `Committed ${shortSha(apply.pushedCommit)}, not pushed`;
}

const DEPTH_OPTIONS = reviewDepthSchema.options.map((value) => ({ value, label: REVIEW_DEPTH_LABEL[value] }));
const DEPTH_TITLE =
  "Which finders the review runs. Quick: correctness, CLAUDE.md compliance, scope and style. Standard adds testing and git history. Deep adds security. Every depth verifies and triages its findings.";

function DepthBadge({ depth }: { depth: ReviewDepth | null }) {
  if (depth === null) return null;
  return (
    <Badge tone="outline" title={`Ran at ${REVIEW_DEPTH_LABEL[depth]} depth. ${DEPTH_TITLE}`}>
      {REVIEW_DEPTH_LABEL[depth]}
    </Badge>
  );
}

/** Picks the next review's depth; from the keys, h/l choose and Enter starts the review. */
function DepthPicker({ depth, onChange, onStart }: { depth: ReviewDepth; onChange: (depth: ReviewDepth) => void; onStart: () => void }) {
  return (
    <span title={`${DEPTH_TITLE} From the keys, h/l choose and Enter starts the review.`}>
      <SegmentedTabs label="Review depth" value={depth} options={DEPTH_OPTIONS} onChange={onChange} onActivate={onStart} className="shrink-0" tabClassName="whitespace-nowrap px-2 py-0.5" />
    </span>
  );
}

/** What a completed review read, in plain text: `at abc1234`, or `def5678..abc1234` for a re-review of the commits since. */
function reviewedRange(review: { commitSha: string | null; sinceCommitSha: string | null }): string | null {
  if (review.commitSha === null) return null;
  return review.sinceCommitSha === null ? `at ${shortSha(review.commitSha)}` : `${shortSha(review.sinceCommitSha)}..${shortSha(review.commitSha)}`;
}

function ReviewStatusChips({ review, round }: { review: Ticket["latestReview"]; round: string | null }) {
  if (review === null) return null;
  if (review.status === "running") {
    return (
      <span className="inline-flex items-center gap-1">
        <Badge tone="accent">Reviewing…</Badge>
        <DepthBadge depth={review.depth} />
      </span>
    );
  }
  if (review.status === "failed") return <Badge tone="danger">failed</Badge>;
  const range = reviewedRange(review);
  return (
    <span className="inline-flex items-center gap-1" title={`Reviewed at ${review.commitSha ?? "unknown"}${review.sinceCommitSha !== null ? ` (the commits since ${review.sinceCommitSha})` : ""}`}>
      {round !== null ? <span className="text-[11px] font-medium text-muted-foreground">{round}</span> : null}
      {range !== null ? <span className="font-mono text-[11px] text-muted-foreground">{range}</span> : null}
      <DepthBadge depth={review.depth} />
      <SeverityCountBadges counts={review.counts} appliedCount={review.appliedCount} />
    </span>
  );
}

export function ReviewPanel({
  ticket,
  threads,
  rpc,
  pending,
  canReview,
  run,
  onOpenThread,
  onOpenTicket,
}: {
  ticket: Ticket;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  rpc: Rpc;
  pending: boolean;
  canReview: boolean;
  run: RunAction;
  onOpenThread: (threadId: string) => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  const [push, setPush] = usePushPreference();
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const review = ticket.latestReview;
  const showFindings = review !== null && review.hasBody;
  useEffect(() => {
    if (!showFindings) return;
    let cancelled = false;
    rpc.call("review_list", { ticketId: ticket.id }).then(
      (result) => {
        if (!cancelled) setReviews(result.reviews);
      },
      toastError,
    );
    return () => {
      cancelled = true;
    };
  }, [showFindings, ticket.id, ticket.latestReview?.completedAt, ticket.latestReview?.selectedCount, ticket.latestReview?.appliedCount, rpc]);

  // The same r1, r2, … the changes view names its review rounds by.
  const rounds = useMemo(() => reviewRounds(reviews ?? []), [reviews]);
  const roundNameOf = (reviewId: string | null): string | null => {
    const round = rounds.find((entry) => entry.review.id === reviewId);
    return round === undefined ? null : roundName(round.number);
  };
  const applying = review?.apply !== null && review?.apply !== undefined && review.apply.completedAt === null;
  const selectedCount = review?.selectedCount ?? null;
  const updateReview = (updated: Review) =>
    setReviews((current) => (current === null ? current : current.map((entry) => (entry.id === updated.id ? updated : entry))));
  const toggleFinding = (reviewId: string, findingId: string, selected: boolean) =>
    rpc.call("review_set_selection", { reviewId, findingId, selected }).then(updateReview, toastError);
  const resetSelection = (reviewId: string) =>
    rpc.call("review_reset_selection", { reviewId }).then(updateReview, toastError);
  /** Resolving goes in as the reviewer's; reopening undoes whichever closed it. */
  const setResolved = (reviewId: string, findingId: string, resolved: boolean, closed: "applied" | "resolved" | null) =>
    (resolved || closed === "resolved"
      ? rpc.call("review_set_resolved", { reviewId, findingId, resolved })
      : rpc.call("review_set_applied", { reviewId, findingId, applied: false })
    ).then(updateReview, toastError);
  const makeCard = (reviewId: string, findingId: string) =>
    rpc.call("review_make_card", { reviewId, findingId }).then(
      ({ ticket: card, created }) => {
        if (created) toast.success(`Added “${card.title}” to the board`);
        else toast(`Already on the board as “${card.title}”`);
        return card.id;
      },
      (cause: unknown) => {
        toastError(cause);
        return null;
      },
    );
  const [depth, setDepth] = useState<ReviewDepth>(DEFAULT_REVIEW_DEPTH);
  const startReview = (mode: "full" | "incremental") =>
    void run(() => rpc.call("ticket_review_pr", { id: ticket.id, projectId: null, mode, depth }), `${REVIEW_DEPTH_LABEL[depth]} review started`);
  const localReason = useReviewUnavailableReason(ticket);
  const unavailable = canReview ? localReason : "Start the card's thread in a project first; reviews run there";
  const canStart = unavailable === null && !pending && review?.status !== "running";
  const depthPicker = (
    <DepthPicker
      depth={depth}
      onChange={setDepth}
      onStart={() => {
        if (canStart) startReview("full");
      }}
    />
  );
  // The next review is of the card's kind, and only continues from a review of the same kind.
  const reviewsLocally = ticket.pr === null;
  const canIncremental = review?.status === "completed" && review.commitSha !== null && review.subjectKind === (reviewsLocally ? "local" : "pr");
  const unavailableNote = unavailable === null ? null : <span className="text-xs text-muted-foreground">{unavailable}</span>;
  const appliesLocally = review?.subjectKind === "local";

  const menu = review === null ? null : (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Review options">
          <Icon name="MoreHorizontal" className="size-4" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...usePortalScopeProps()} align="end" sideOffset={4} className={cn("z-50 min-w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md", POPOVER_MOTION, KANBAN_MENU)} onKeyDown={menuVimKeys}>
          {review.apply !== null ? (
            <>
              <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onOpenThread(review.apply!.threadId)}>
                <Icon name="kanban-wrench" className="size-4 text-muted-foreground" />
                {appliesLocally ? "Open the card's thread" : "Open apply thread"}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            </>
          ) : null}
          {unavailable !== null && review.status !== "running" ? <DropdownMenu.Label className="max-w-64 px-2 py-1 text-xs text-muted-foreground">{unavailable}</DropdownMenu.Label> : null}
          <DropdownMenu.Label className="px-2 pt-1 text-xs text-muted-foreground" title={DEPTH_TITLE}>
            Depth of the next review
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={depth} onValueChange={(value) => setDepth(reviewDepthSchema.parse(value))}>
            {DEPTH_OPTIONS.map((option) => (
              // Choosing a depth keeps the menu open, so the review items below take it.
              <DropdownMenu.RadioItem key={option.value} value={option.value} className={MENU_ITEM_CLASS} onSelect={(event) => event.preventDefault()}>
                <span className="inline-flex size-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Icon name="Check" className="size-4" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {option.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {canIncremental ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={!canStart} onSelect={() => startReview("incremental")}>
              <Icon name="kanban-search-check" className="size-4 text-muted-foreground" />
              Review changes since {shortSha(review.commitSha)}
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={!canStart} onSelect={() => startReview("full")} title="Starts over: earlier findings and your choices on them are not carried forward">
            <Icon name="kanban-refresh" className="size-4 text-muted-foreground" />
            Run a full review again
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  return (
    <Group title="Code review" summary={<ReviewStatusChips review={review} round={roundNameOf(review?.id ?? null)} />} menu={menu} defaultOpen>
      {review === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span title={unavailable ?? (reviewsLocally ? "Runs the code-review skill on the card thread's commits, in a worktree of their own" : "Runs the code-review skill on the PR in its own worktree")}>
            <Button type="button" variant="secondary" className={COMPACT} disabled={!canStart} onClick={() => startReview("full")}>
              <Icon name="kanban-search-check" className="size-3.5" />
              {reviewsLocally ? "Review the commits" : "Review this PR"}
            </Button>
          </span>
          {depthPicker}
          {unavailableNote}
        </div>
      ) : review.status === "running" ? (
        <button type="button" onClick={() => onOpenThread(review.threadId)} className="flex items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground">
          <ThreadStatusDot thread={threads.get(review.threadId)} />
          Reviewing… open thread
        </button>
      ) : review.status === "failed" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" className={COMPACT} disabled={!canStart} onClick={() => startReview("full")}>
            <Icon name="kanban-refresh" className="size-3.5" />
            Retry review
          </Button>
          {depthPicker}
          <button type="button" onClick={() => onOpenThread(review.threadId)} className="text-xs text-muted-foreground hover:text-foreground">
            See why it failed
          </button>
          {unavailableNote}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span title={selectedCount === 0 ? "Tick at least one open finding to apply" : appliesLocally ? "Sends the selected open findings to the card's thread to fix and commit" : "Applies the selected findings that are still open"}>
              <Button
                type="button"
                variant="secondary"
                className={COMPACT}
                disabled={pending || applying || !review.hasBody || selectedCount === 0}
                onClick={() =>
                  void run(() => rpc.call("review_apply", { ticketId: ticket.id, reviewId: review.id, push: !appliesLocally && push }), appliesLocally ? "Sent to the card's thread" : "Apply thread started")
                }
              >
                <Icon name="kanban-wrench" className="size-3.5" />
                {applying ? "Applying…" : `Apply ${selectedCount ?? ""}${selectedCount === null ? "review" : selectedCount === 1 ? " finding" : " findings"}`}
              </Button>
            </span>
            {appliesLocally ? null : <PushToggle push={push} onChange={setPush} disabled={pending || applying} />}
            <button type="button" className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => onOpenThread(review.threadId)}>
              <Icon name="MessageSquare" className="size-3.5" />
              Review thread
            </button>
            {review.apply !== null ? (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onOpenThread(review.apply!.threadId)}
              >
                <ThreadStatusDot thread={threads.get(review.apply.threadId)} />
                {applyStatusLabel(review.apply, appliesLocally)}
              </button>
            ) : null}
          </div>
          {showFindings ? (
            <div className="flex flex-col gap-3 text-sm">
              {reviews === null ? (
                <p className={cn("text-muted-foreground", enter.fade)}>Loading…</p>
              ) : (
                <>
                  {(() => {
                    const latest = reviews.find((entry) => entry.id === review.id);
                    if (latest === undefined || latest.body === null) return null;
                    return latest.report !== null ? (
                      <StructuredReview
                        review={latest}
                        onToggle={(findingId, selected) => void toggleFinding(latest.id, findingId, selected)}
                        onReset={() => void resetSelection(latest.id)}
                        onResolve={(findingId, resolved, closed) => void setResolved(latest.id, findingId, resolved, closed)}
                        onMakeCard={(findingId) => makeCard(latest.id, findingId)}
                        onOpenCard={onOpenTicket}
                      />
                    ) : (
                      <Markdown content={latest.body} />
                    );
                  })()}
                  {reviews.filter((entry) => entry.id !== review.id && entry.body !== null).length > 0 ? (
                    <details className="border-t border-border pt-2">
                      <summary className="cursor-pointer text-xs text-muted-foreground">Previous reviews</summary>
                      <div className="mt-2 flex flex-col gap-3">
                        {reviews
                          .filter((entry) => entry.id !== review.id && entry.body !== null)
                          .map((entry) => (
                            <details key={entry.id}>
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                {roundNameOf(entry.id) === null ? "" : `${roundNameOf(entry.id)} · `}
                                {reviewedRange(entry) ?? shortSha(entry.commitSha)} ·{" "}
                                {new Date(entry.completedAt ?? entry.createdAt).toLocaleString()}
                              </summary>
                              <div className="mt-2">
                                {entry.report !== null ? <StructuredReview review={entry} onToggle={null} onReset={null} onResolve={null} onMakeCard={null} onOpenCard={onOpenTicket} /> : <Markdown content={entry.body ?? ""} />}
                              </div>
                            </details>
                          ))}
                      </div>
                    </details>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </>
      )}
    </Group>
  );
}
