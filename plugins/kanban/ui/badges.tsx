import { GLYPH, Glyph, useNerdFont } from "bb-nerd-font";
import type { JiraIssue, PullRequest, Ticket } from "../shared/board";
import { LOOP_ROUND_CAP } from "../shared/loop";
import { REVIEW_DEPTH_LABEL } from "../shared/review";
import { chipFor } from "../shared/stages";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useNow } from "./data";
import { dueStatus, PRIORITY_LABEL } from "./format";
import { ExternalLink, Badge } from "./primitives";
import { CHECKS_MARK, PR_STATE_MARK, jiraStatusMark, type SourceMark } from "./source-marks";

/** Nerd Font Mono glyphs fill a cell, so a point above the 11px text matches the lucide icons' optical size. */
const GLYPH_SIZE = "text-[12px]";

export function MarkGlyph({ mark }: { mark: SourceMark }) {
  return <Glyph glyph={GLYPH[mark.glyph]} label={mark.label} title={mark.label} className={cn(GLYPH_SIZE, mark.tone)} />;
}

export function PrStateGlyph({ state }: { state: PullRequest["state"] }) {
  return <MarkGlyph mark={PR_STATE_MARK[state]} />;
}

/** Where the checks tick leads: the failing or pending check's own page when GitHub named one, else the PR's checks tab. */
export function checksHref(pr: PullRequest): string {
  return pr.checksUrl ?? `${pr.url}/checks`;
}

/** The head commit's CI result; with `href` it opens that run on GitHub. */
export function ChecksMark({ checks, nerdFont, href }: { checks: NonNullable<PullRequest["checks"]>; nerdFont: boolean; href?: string }) {
  const mark = CHECKS_MARK[checks];
  const glyph = nerdFont ? (
    <MarkGlyph mark={mark} />
  ) : (
    <span role="img" aria-label={mark.label} title={mark.label} className={cn("inline-flex shrink-0", mark.tone)}>
      <Icon name={mark.icon} className="size-3" />
    </span>
  );
  if (href === undefined) return glyph;
  return (
    <ExternalLink href={href} title={`${mark.label} · open the checks on GitHub`} className="inline-flex shrink-0 rounded-sm hover:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      {glyph}
    </ExternalLink>
  );
}

/** The issue's status category, named by its status; the Jira mark when the status has no category. */
export function JiraStatusGlyph({ jira }: { jira: JiraIssue }) {
  const mark = jiraStatusMark(jira);
  return mark === null ? <Glyph glyph={GLYPH.jira} className={GLYPH_SIZE} /> : <MarkGlyph mark={mark} />;
}

export function PrBadges({ ticket }: { ticket: Ticket }) {
  const nerdFont = useNerdFont();
  if (ticket.pr === null) return null;
  const { pr } = ticket;
  const repoName = pr.repo.split("/")[1] ?? pr.repo;
  const stateTone =
    pr.state === "merged" ? "success" : pr.state === "closed" ? "danger" : pr.state === "draft" ? "neutral" : "accent";
  return (
    <>
      <ExternalLink href={pr.url} title={`Open ${pr.repo}#${pr.number} on GitHub`} className="inline-flex max-w-full">
        <Badge title={pr.repo}>
          {nerdFont ? <PrStateGlyph state={pr.state} /> : <Icon name="GitPullRequest" className="size-3" />}
          {repoName}#{pr.number}
          {pr.checks !== null ? <ChecksMark checks={pr.checks} nerdFont={nerdFont} /> : null}
        </Badge>
      </ExternalLink>
      {!nerdFont && pr.state !== "open" ? <Badge tone={stateTone}>{pr.state}</Badge> : null}
    </>
  );
}

export function JiraBadges({ ticket }: { ticket: Ticket }) {
  const nerdFont = useNerdFont();
  if (ticket.jira === null) return null;
  const { jira } = ticket;
  const tone = jira.statusCategory === "done" ? "success" : jira.statusCategory === "indeterminate" ? "accent" : "neutral";
  const statusMark = nerdFont ? jiraStatusMark(jira) : null;
  return (
    <>
      <ExternalLink href={jira.url} title={`Open ${jira.key} in Jira`} className="inline-flex max-w-full">
        <Badge title={jira.issueType}>
          {nerdFont ? <JiraStatusGlyph jira={jira} /> : <Icon name="kanban-ticket" className="size-3" />}
          {jira.key}
        </Badge>
      </ExternalLink>
      {statusMark === null && jira.status !== "" ? <Badge tone={tone}>{jira.status}</Badge> : null}
      {jira.priority !== null ? <Badge title="Priority">{jira.priority}</Badge> : null}
    </>
  );
}

/** Marks a monitored card with the loop's step in the strip's words, or why it needs you, and a pip per fix round used of the cap. */
export function LoopChip({ ticket }: { ticket: Ticket }) {
  // The chip shows how long a card has waited past an hour, so it re-reads the clock each minute.
  const now = useNow(60_000);
  const chip = ticket.loop === null ? null : chipFor(ticket.loop, now);
  if (chip === null) return null;
  const round = ticket.loop!.round;
  return (
    <Badge tone={chip.tone} title={round === 0 ? chip.title : `${chip.title}. ${round} of ${LOOP_ROUND_CAP} fix rounds used`}>
      <Icon name="kanban-refresh" className="size-3" />
      {chip.label}
      {round === 0 ? null : (
        <span className="ml-0.5 inline-flex gap-0.5" aria-hidden>
          {Array.from({ length: Math.max(LOOP_ROUND_CAP, round) }, (_, index) => (
            <span key={index} className={`size-1.5 rounded-full ${index < round ? "bg-current" : "bg-current opacity-30"}`} />
          ))}
        </span>
      )}
    </Badge>
  );
}

export function ReviewBadge({ ticket }: { ticket: Ticket }) {
  const review = ticket.latestReview;
  if (review === null) return null;
  const depth = review.depth === null ? "" : `${REVIEW_DEPTH_LABEL[review.depth]} review. `;
  if (review.status === "running") return <Badge tone="accent" title={depth === "" ? undefined : depth.trim()}>reviewing…</Badge>;
  if (review.status === "failed") return <Badge tone="danger">review failed</Badge>;
  const { apply, appliedCount } = review;
  if (apply !== null && apply.completedAt === null) return <Badge tone="accent">applying…</Badge>;
  const counts = review.counts;
  if (counts === null) {
    if (apply !== null) return <Badge tone="success" title={`Fixes ${apply.push ? "pushed" : "committed"} as ${apply.pushedCommit ?? "unknown"}`}>applied</Badge>;
    return <Badge title={`${depth}Reviewed at commit ${review.commitSha ?? "unknown"}`}>reviewed</Badge>;
  }
  const total = counts.critical + counts.important + counts.minor;
  if (total === 0) {
    if (appliedCount > 0) return <Badge tone="success" title={`All ${appliedCount} finding${appliedCount === 1 ? "" : "s"} applied`}>all applied</Badge>;
    return <Badge tone="success" title={depth === "" ? undefined : depth.trim()}>no findings</Badge>;
  }
  // One number on the card: what is still open. The split, the applied count and the apply selection are in the tooltip.
  const detail = [
    `${depth}Open: ${counts.critical} critical, ${counts.important} important, ${counts.minor} minor`,
    appliedCount > 0 ? `${appliedCount} applied` : null,
    review.selectedCount !== null ? `${review.selectedCount} selected for the apply round` : null,
  ].filter((line) => line !== null);
  return (
    <Badge tone={counts.critical > 0 ? "danger" : counts.important > 0 ? "warning" : "neutral"} title={detail.join("; ")}>
      {total} finding{total === 1 ? "" : "s"}
    </Badge>
  );
}

export const PRIORITY_TONE: Record<number, string> = {
  1: "text-destructive",
  2: "text-amber-700 dark:text-amber-300",
  3: "text-sky-700 dark:text-sky-300",
  4: "text-muted-foreground",
};

/** A flag and `P1`..`P4`; nothing for a card without a priority. */
export function PriorityMark({ priority, className }: { priority: number | null; className?: string }) {
  if (priority === null) return null;
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums", PRIORITY_TONE[priority], className)} title={`Priority ${priority}: ${PRIORITY_LABEL[priority]}`}>
      <Icon name="kanban-flag" className="size-3" />P{priority}
    </span>
  );
}

/** Shown only where snoozed cards are let back in view: when the card comes back. */
export function SnoozeMark({ snoozedUntil, today, className }: { snoozedUntil: string | null; today: string; className?: string }) {
  if (snoozedUntil === null || snoozedUntil <= today) return null;
  const back = dueStatus(snoozedUntil, today);
  return (
    <span className={cn("inline-flex items-center gap-1 text-muted-foreground", className)} title={`Snoozed until ${back.title.replace(/^Due /u, "")}`}>
      <Icon name="kanban-moon" className="size-3" />
      {back.label}
    </span>
  );
}

export function DueBadge({ ticket, today, isDone }: { ticket: Ticket; today: string; isDone: boolean }) {
  if (ticket.dueDate === null) return null;
  const due = dueStatus(ticket.dueDate, today);
  const tone = isDone ? "neutral" : due.tone === "overdue" ? "danger" : due.tone === "soon" ? "warning" : "neutral";
  return (
    <Badge tone={tone} title={due.title}>
      <Icon name="kanban-calendar" className="size-3" />
      {due.label}
    </Badge>
  );
}
