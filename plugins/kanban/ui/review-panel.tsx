import { useEffect, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { OPACITY_TRANSITION, STAGGER, enter, speed, stagger, POPOVER_MOTION } from "bb-motion";
import type { Ticket } from "../shared/board";
import { locationLabel } from "../shared/finding-location";
import type { Finding, FindingSeverity, Review } from "../shared/review";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { shortSha } from "./format";
import { type Rpc, usePushPreference } from "./data";
import { PushToggle, Badge, ThreadStatusDot, COMPACT, Group, MENU_ITEM_CLASS } from "./primitives";
import { type RunAction, toastError } from "./actions";

const SEVERITY_LABEL: Record<FindingSeverity, string> = { critical: "Critical", important: "Important", minor: "Minor" };
const SEVERITY_TONE: Record<FindingSeverity, "danger" | "warning" | "neutral"> = {
  critical: "danger",
  important: "warning",
  minor: "neutral",
};

function SeverityCountBadges({ counts }: { counts: NonNullable<Ticket["latestReview"]>["counts"] }) {
  if (counts === null) return null;
  const total = counts.critical + counts.important + counts.minor;
  if (total === 0) return <Badge tone="success">no findings</Badge>;
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

function FindingCard({
  finding,
  index,
  selected,
  overridden,
  onToggle,
}: {
  finding: Finding;
  /** Position across all severity groups, so the whole report cascades as one list. */
  index: number;
  selected: boolean | null;
  overridden: boolean;
  onToggle: ((selected: boolean) => void) | null;
}) {
  return (
    <li style={stagger(index)} className={cn("rounded-md border border-border bg-card p-2.5", enter.rise, speed.fast, STAGGER, OPACITY_TRANSITION, selected === false && "opacity-60")}>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        {selected !== null && onToggle !== null ? (
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onToggle(checked === true)}
            aria-label={`${selected ? "Exclude" : "Include"} ${finding.id} in the apply round`}
            className="mt-0.5"
          />
        ) : null}
        <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.id}</Badge>
        <span className="min-w-0 flex-1 text-sm font-medium leading-5">{finding.title}</span>
        {finding.importance !== null && finding.scopeFit !== null ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title="importance / scope fit (1–5)">
            {finding.importance}/{finding.scopeFit}
          </span>
        ) : null}
        {finding.carriedFrom !== null ? (
          <span className="shrink-0 text-xs text-muted-foreground" title={`Still open from an earlier review, where it was ${finding.carriedFrom.split("/").pop()}`}>
            carried
          </span>
        ) : null}
        {overridden ? <span className="shrink-0 text-xs text-muted-foreground" title="You changed this from the suggested selection">manual</span> : null}
      </div>
      {finding.locations.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {finding.locations.map((location) => (
            <code key={locationLabel(location)} className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
              {locationLabel(location)}
            </code>
          ))}
        </div>
      ) : null}
      {finding.description !== "" ? <Markdown content={finding.description} className="mt-1.5 text-sm" /> : null}
      {finding.fix !== null && finding.fix !== "" ? (
        <div className="mt-1.5 flex gap-1.5 text-sm">
          <Icon name="kanban-wrench" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <Markdown content={finding.fix} className="min-w-0 flex-1" />
        </div>
      ) : null}
      {finding.flaggedBy.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {finding.flaggedBy.map((reviewer) => (
            <Badge key={reviewer}>{reviewer}</Badge>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function StructuredReview({
  review,
  onToggle,
  onReset,
}: {
  review: Review;
  /** Null makes the view read-only (old reviews). */
  onToggle: ((findingId: string, selected: boolean) => void) | null;
  onReset: (() => void) | null;
}) {
  const report = review.report!;
  const grouped = (["critical", "important", "minor"] as const)
    .map((severity) => ({ severity, findings: report.findings.filter((finding) => finding.severity === severity) }))
    .filter((group) => group.findings.length > 0);
  const selectedCount = Object.values(review.selection).filter(Boolean).length;
  const overriddenCount = Object.keys(review.selectionOverrides).length;
  return (
    <div className="flex flex-col gap-3">
      {report.summary !== "" ? <Markdown content={report.summary} className="text-sm" /> : null}
      {report.findings.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span title={overriddenCount > 0 ? `${overriddenCount} changed by you` : "Suggested: critical, or importance ≥ 3 and scope ≥ 3"}>
            <span className="font-medium text-foreground tabular-nums">{selectedCount}</span> of {report.findings.length} selected
          </span>
          {onReset !== null && overriddenCount > 0 ? (
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onReset}>
              Reset to suggested
            </Button>
          ) : null}
        </div>
      ) : null}
      {grouped.length === 0 ? <p className={cn("text-sm text-muted-foreground", enter.fade)}>No findings.</p> : null}
      {grouped.map(({ severity, findings }, groupIndex) => (
        <section key={severity} aria-label={SEVERITY_LABEL[severity]}>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {SEVERITY_LABEL[severity]} <span className="font-normal tabular-nums">{findings.length}</span>
          </h3>
          <ul className="flex flex-col gap-2">
            {findings.map((finding, index) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                index={grouped.slice(0, groupIndex).reduce((sum, group) => sum + group.findings.length, 0) + index}
                selected={review.selection[finding.id] ?? null}
                overridden={finding.id in review.selectionOverrides}
                onToggle={onToggle === null ? null : (selected) => onToggle(finding.id, selected)}
              />
            ))}
          </ul>
        </section>
      ))}
      {report.resolved.length > 0 ? (
        <section aria-label="Resolved since the last review">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Resolved since the last review <span className="font-normal tabular-nums">{report.resolved.length}</span>
          </h3>
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
      {report.skippedFiles.length > 0 ? (
        <p className="text-xs text-muted-foreground">Skipped generated files: {report.skippedFiles.join(", ")}</p>
      ) : null}
    </div>
  );
}

function ReviewStatusChips({ review }: { review: Ticket["latestReview"] }) {
  if (review === null) return null;
  if (review.status === "running") return <Badge tone="accent">Reviewing…</Badge>;
  if (review.status === "failed") return <Badge tone="danger">failed</Badge>;
  return (
    <span className="inline-flex items-center gap-1" title={`Reviewed at ${review.commitSha ?? "unknown"}${review.sinceCommitSha !== null ? ` (since ${review.sinceCommitSha})` : ""}`}>
      <SeverityCountBadges counts={review.counts} />
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
}: {
  ticket: Ticket;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  rpc: Rpc;
  pending: boolean;
  canReview: boolean;
  run: RunAction;
  onOpenThread: (threadId: string) => void;
}) {
  const [autoApprove, setAutoApprove] = useState(false);
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
  }, [showFindings, ticket.id, ticket.latestReview?.completedAt, ticket.latestReview?.selectedCount, rpc]);

  const applying = review?.apply !== null && review?.apply !== undefined && review.apply.completedAt === null;
  const selectedCount = review?.selectedCount ?? null;
  const updateReview = (updated: Review) =>
    setReviews((current) => (current === null ? current : current.map((entry) => (entry.id === updated.id ? updated : entry))));
  const toggleFinding = (reviewId: string, findingId: string, selected: boolean) =>
    rpc.call("review_set_selection", { reviewId, findingId, selected }).then(updateReview, toastError);
  const resetSelection = (reviewId: string) =>
    rpc.call("review_reset_selection", { reviewId }).then(updateReview, toastError);
  const startReview = (mode: "full" | "incremental") =>
    void run(() => rpc.call("ticket_review_pr", { id: ticket.id, projectId: null, mode }), "Review started");
  const canStart = canReview && !pending && review?.status !== "running";
  const canIncremental = review?.status === "completed" && review.commitSha !== null;

  const menu = review === null ? null : (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Review options">
          <Icon name="MoreHorizontal" className="size-4" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...usePortalScopeProps()} align="end" sideOffset={4} className={cn("z-50 min-w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md", POPOVER_MOTION)}>
          {review.apply !== null ? (
            <>
              <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onOpenThread(review.apply!.threadId)}>
                <Icon name="kanban-wrench" className="size-4 text-muted-foreground" />
                Open apply thread
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            </>
          ) : null}
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
          {review.status === "completed" ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.CheckboxItem
                className={cn(MENU_ITEM_CLASS, "pl-7")}
                checked={autoApprove}
                onCheckedChange={(checked) => setAutoApprove(checked === true)}
                onSelect={(event) => event.preventDefault()}
              >
                <DropdownMenu.ItemIndicator className="absolute left-2">
                  <Icon name="Check" className={cn("size-4", enter.pop)} />
                </DropdownMenu.ItemIndicator>
                Skip triage confirmation when applying
              </DropdownMenu.CheckboxItem>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  return (
    <Group title="Code review" summary={<ReviewStatusChips review={review} />} menu={menu} defaultOpen>
      {review === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span title={canReview ? "Runs the code-review skill on the PR in its own worktree" : "Start the card's thread in a project first; reviews run there"}>
            <Button type="button" variant="secondary" className={COMPACT} disabled={!canStart} onClick={() => startReview("full")}>
              <Icon name="kanban-search-check" className="size-3.5" />
              Review this PR
            </Button>
          </span>
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
          <button type="button" onClick={() => onOpenThread(review.threadId)} className="text-xs text-muted-foreground hover:text-foreground">
            See why it failed
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span title={selectedCount === 0 ? "Tick at least one finding to apply" : autoApprove ? "Applies the selected findings, skipping the triage confirmation" : "Applies the selected findings"}>
              <Button
                type="button"
                variant="secondary"
                className={COMPACT}
                disabled={pending || applying || !review.hasBody || selectedCount === 0}
                onClick={() =>
                  void run(() => rpc.call("review_apply", { ticketId: ticket.id, reviewId: review.id, autoApprove, push }), "Apply thread started")
                }
              >
                <Icon name="kanban-wrench" className="size-3.5" />
                {applying ? "Applying…" : `Apply ${selectedCount ?? ""}${selectedCount === null ? "review" : selectedCount === 1 ? " finding" : " findings"}`}
              </Button>
            </span>
            <PushToggle push={push} onChange={setPush} disabled={pending || applying} />
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
                {review.apply.completedAt === null
                  ? "Apply thread running"
                  : review.apply.push
                    ? `Pushed ${shortSha(review.apply.pushedCommit)}`
                    : `Committed ${shortSha(review.apply.pushedCommit)}, not pushed`}
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
                                {shortSha(entry.commitSha)}
                                {entry.sinceCommitSha !== null ? ` (since ${shortSha(entry.sinceCommitSha)})` : ""} ·{" "}
                                {new Date(entry.completedAt ?? entry.createdAt).toLocaleString()}
                              </summary>
                              <div className="mt-2">
                                {entry.report !== null ? <StructuredReview review={entry} onToggle={null} onReset={null} /> : <Markdown content={entry.body ?? ""} />}
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
