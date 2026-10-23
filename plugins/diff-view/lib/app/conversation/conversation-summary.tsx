// The pull request's facts around its timeline, as GitHub's Conversation tab has them: what it merges and its
// reviewers, labels, assignees, milestone and issues above; its checks, reviews and mergeability below.
import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PullRequestSummary, ReviewVerdict } from "../../types";
import { cn } from "../utils";
import { plural } from "../format";
import { ExternalLink } from "../ui/external-link";
import { CURSOR_RING } from "../keys/review-keys-context";
import { CheckMark, checkLabel } from "./comment-meta";

type StopRef = (key: string, node: HTMLElement | null) => void;

const STATE: Record<PullRequestSummary["state"], { label: string; className: string }> = {
  open: { label: "Open", className: "bg-emerald-600 text-white" },
  draft: { label: "Draft", className: "bg-muted-foreground text-background" },
  merged: { label: "Merged", className: "bg-violet-600 text-white" },
  closed: { label: "Closed", className: "bg-destructive text-white" },
};

const REVIEWER: Record<ReviewVerdict | "REQUESTED", { icon: string; className: string; title: string }> = {
  APPROVED: { icon: "Check", className: "text-emerald-600 dark:text-emerald-400", title: "Approved these changes" },
  CHANGES_REQUESTED: { icon: "diff-view-diff", className: "text-destructive", title: "Requested changes" },
  COMMENTED: { icon: "MessageSquare", className: "text-muted-foreground", title: "Left review comments" },
  DISMISSED: { icon: "diff-view-eye", className: "text-muted-foreground", title: "Review dismissed" },
  REQUESTED: { icon: "Circle", className: "text-amber-500", title: "Awaiting a review" },
};

/** A label in its GitHub colour, with text dark or light to read on it. */
export function LabelChip({ name, color }: { name: string; color: string }) {
  const hex = /^[0-9a-f]{6}$/iu.test(color) ? color : "888888";
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
  const light = (r * 299 + g * 587 + b * 114) / 1000 > 150;
  return (
    <span className="inline-flex max-w-full items-center truncate rounded-full px-2 text-[11px] font-medium leading-5" style={{ backgroundColor: `#${hex}`, color: light ? "#1f2328" : "#ffffff" }}>
      {name}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">{children}</div>
    </div>
  );
}

export function PullRequestHeader({ pr, stopRef, focusedKey }: { pr: PullRequestSummary; stopRef: StopRef; focusedKey: string | null }) {
  const state = STATE[pr.state];
  const commits = plural(pr.commitCount, "commit");
  const verb = pr.state === "merged" ? `merged ${commits} into` : `wants to merge ${commits} into`;
  return (
    <section
      ref={(node) => stopRef("summary", node)}
      data-conversation-stop="summary"
      className={cn("flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs", focusedKey === "summary" && CURSOR_RING)}
    >
      <p className="flex min-w-0 flex-wrap items-center gap-2">
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", state.className)}>
          <Icon name={pr.state === "merged" ? "diff-view-merge" : "GitPullRequest"} className="size-3" />
          {state.label}
        </span>
        <span className="text-muted-foreground">
          <span className="font-medium text-foreground">{pr.author}</span> {verb} <code className="rounded bg-muted px-1 text-foreground">{pr.baseRef}</code> from{" "}
          <code className="rounded bg-muted px-1 text-foreground">{pr.headRef}</code>
        </span>
        <ExternalLink href={pr.url} title="Open on GitHub (gx)" className="ml-auto text-muted-foreground hover:text-foreground">
          <Icon name="ExternalLink" className="size-3" />
        </ExternalLink>
      </p>
      <Row label="Reviewers">
        {pr.reviewers.length === 0 ? (
          <span className="text-muted-foreground">None yet</span>
        ) : (
          pr.reviewers.map((reviewer) => {
            const mark = REVIEWER[reviewer.state];
            return (
              <span key={reviewer.name} className="inline-flex items-center gap-1" title={mark.title}>
                <Icon name={mark.icon} className={cn("size-3", mark.className)} />
                {reviewer.name}
              </span>
            );
          })
        )}
      </Row>
      {pr.assignees.length > 0 ? <Row label="Assignees">{pr.assignees.map((login) => <span key={login}>{login}</span>)}</Row> : null}
      {pr.labels.length > 0 ? (
        <Row label="Labels">
          {pr.labels.map((label) => (
            <LabelChip key={label.name} {...label} />
          ))}
        </Row>
      ) : null}
      {pr.milestone !== null ? (
        <Row label="Milestone">
          <ExternalLink href={pr.milestone.url} className="hover:underline">
            {pr.milestone.title}
          </ExternalLink>
        </Row>
      ) : null}
      {pr.linkedIssues.length > 0 ? (
        <Row label="Closes">
          {pr.linkedIssues.map((issue) => {
            const key = `issue:${issue.number}`;
            return (
              <span key={key} ref={(node) => stopRef(key, node)} data-conversation-stop={key} className={cn("inline-flex min-w-0 items-center gap-1 rounded px-0.5", focusedKey === key && CURSOR_RING)}>
                <Icon name={issue.open ? "Circle" : "CircleCheck"} className={cn("size-3", issue.open ? "text-emerald-600" : "text-violet-600")} />
                <ExternalLink href={issue.url} title="Open on GitHub (gx)" className="truncate hover:underline">
                  #{issue.number} {issue.title}
                </ExternalLink>
              </span>
            );
          })}
        </Row>
      ) : null}
    </section>
  );
}

const DECISION: Record<NonNullable<PullRequestSummary["reviewDecision"]>, { icon: string; className: string; title: string; detail: string }> = {
  APPROVED: { icon: "Check", className: "text-emerald-600 dark:text-emerald-400", title: "Changes approved", detail: "A reviewer with write access approved these changes." },
  CHANGES_REQUESTED: { icon: "diff-view-diff", className: "text-destructive", title: "Changes requested", detail: "A reviewer asked for changes before this can merge." },
  REVIEW_REQUIRED: { icon: "Circle", className: "text-amber-500", title: "Review required", detail: "At least one approving review is required to merge." },
};

const MERGE_STATE: Record<string, string> = {
  CLEAN: "Nothing stops it merging.",
  BLOCKED: "Merging is blocked by a branch rule.",
  BEHIND: "The branch is behind its base.",
  DIRTY: "Merging is blocked by conflicts.",
  UNSTABLE: "Some checks are not passing, though merging is allowed.",
  HAS_HOOKS: "Merging will run pre-receive hooks.",
  DRAFT: "Drafts cannot be merged.",
  UNKNOWN: "GitHub is still working out whether it can merge.",
};

/** The merge box without its button: the head's checks, the review decision, and whether it merges cleanly. */
export function PullRequestStatus({ pr, stopRef, focusedKey }: { pr: PullRequestSummary; stopRef: StopRef; focusedKey: string | null }) {
  const decision = pr.reviewDecision === null ? null : DECISION[pr.reviewDecision];
  const runs = pr.checks?.runs ?? [];
  const failing = runs.filter((run) => run.outcome === "failure").length;
  const pending = runs.filter((run) => run.outcome === "pending").length;
  const summary = pr.checks === null ? "No checks" : failing > 0 ? `${failing} failing` : pending > 0 ? `${pending} pending` : "All checks have passed";
  const conflicted = pr.mergeable === "CONFLICTING";
  return (
    <section
      ref={(node) => stopRef("status", node)}
      data-conversation-stop="status"
      className={cn("mt-2 flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border bg-card text-xs", focusedKey === "status" && CURSOR_RING)}
    >
      {decision !== null ? (
        <div className="flex items-start gap-2 px-3 py-2">
          <Icon name={decision.icon} className={cn("mt-0.5 size-4 shrink-0", decision.className)} />
          <div>
            <p className="font-medium">{decision.title}</p>
            <p className="text-muted-foreground">{decision.detail}</p>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-1 px-3 py-2">
        <p className="flex items-center gap-2">
          {pr.checks !== null ? <CheckMark outcome={pr.checks.outcome} /> : null}
          <span className="font-medium">{summary}</span>
          {runs.length > 0 ? <span className="text-muted-foreground">{plural(runs.length, "check")}</span> : null}
        </p>
        {runs.map((run, index) => {
          const key = `check:${index}`;
          return (
            <div key={key} ref={(node) => stopRef(key, node)} data-conversation-stop={key} className={cn("flex min-w-0 items-center gap-2 rounded px-1 py-0.5", focusedKey === key && CURSOR_RING)}>
              <CheckMark outcome={run.outcome} title={checkLabel(run.outcome)} />
              <span className="shrink-0 font-medium">{run.name}</span>
              {run.description !== null ? <span className="min-w-0 truncate text-muted-foreground">{run.description}</span> : null}
              {run.url !== null ? (
                <ExternalLink href={run.url} title="Open the check (gx)" className="ml-auto shrink-0 text-muted-foreground hover:text-foreground">
                  Details
                </ExternalLink>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex items-start gap-2 px-3 py-2">
        <Icon name={conflicted ? "X" : pr.mergeable === "MERGEABLE" ? "Check" : "Circle"} className={cn("mt-0.5 size-4 shrink-0", conflicted ? "text-destructive" : pr.mergeable === "MERGEABLE" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")} />
        <div>
          <p className="font-medium">{pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed" : conflicted ? "This branch has conflicts that must be resolved" : pr.mergeable === "MERGEABLE" ? "This branch has no conflicts with the base branch" : "Checking for conflicts"}</p>
          {pr.state === "open" || pr.state === "draft" ? <p className="text-muted-foreground">{MERGE_STATE[pr.mergeState] ?? pr.mergeState}</p> : null}
        </div>
      </div>
    </section>
  );
}
