// bb-plugin-kanban — frontend entry.
//
// A kanban board page in the sidebar. Every card is a ticket; most tickets are
// backed by a thread, whose live status shows on the card. Cards drag between
// columns; the same moves are available to agents through `bb kanban move`.
import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DragEvent, FormEvent, ReactNode } from "react";
import {
  Markdown,
  definePluginApp,
  experimental_Diff as Diff,
  experimental_useCodeTheme as useCodeTheme,
  useBbNavigate,
  experimental_usePluginId as usePluginId,
  experimental_useAppPanel as useAppPanel,
  experimental_useFixedTabTarget as useFixedTabTarget,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { PatchDiff, useWorkerPool } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs/react";
import { toast } from "sonner";
import type { Board, Column, CommentApply, DiffComment, DiffFile, Dump, Finding, FindingSeverity, PrComment, ProposedTicket, Review, Source, SourceKind, StructuralDiff, SymbolLookup, Ticket, TicketDiff, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const BOARD_CHANGED = "board-changed";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

interface ProjectOption {
  id: string;
  name: string;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** GitHub links open in the system browser: an explicit target bypasses bb's in-app routing. */
function ExternalLink({ href, className, children, title }: { href: string; className?: string; children: ReactNode; title?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={className}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  );
}

/**
 * Collapse the host's right panel. The SDK can open fixed tabs but has no close
 * call, so this presses the host's own toggle, found by its accessible label.
 * If the host renames it, the card still clears; only the collapse is lost.
 */
function collapseRightPanel(): void {
  document.querySelector<HTMLButtonElement>('button[aria-label^="Hide right panel"]')?.click();
}

/**
 * Page-level UI state shared between the host title bar (`headerContent`) and
 * the page body, which the host mounts as separate React trees.
 */
interface PageUiState {
  dialog: "new" | "columns" | "sources" | null;
  /** Text (Pierre) or structural (difftastic) rendering of a file's changes. */
  diffMode: "text" | "structural";
  /** Show subtasks as their own cards on the board (default: only in their parent's panel). */
  showSubtasks: boolean;
  newTicketColumn: string | null;
  diffView: "unified" | "split";
  diffReloadNonce: number;
  diffLoading: boolean;
}
const pageUi = (() => {
  let showSubtasks = false;
  try {
    showSubtasks = window.localStorage.getItem("kanban:showSubtasks") === "true";
  } catch {
    showSubtasks = false;
  }
  let diffMode: "text" | "structural" = "text";
  try {
    diffMode = window.localStorage.getItem("kanban:diffMode") === "structural" ? "structural" : "text";
  } catch {
    diffMode = "text";
  }
  let state: PageUiState = { dialog: null, newTicketColumn: null, showSubtasks, diffMode, diffView: "unified", diffReloadNonce: 0, diffLoading: false };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (patch: Partial<PageUiState>) => {
      state = { ...state, ...patch };
      if (patch.diffMode !== undefined) {
        try {
          window.localStorage.setItem("kanban:diffMode", patch.diffMode);
        } catch {
          // ignore
        }
      }
      if (patch.showSubtasks !== undefined) {
        try {
          window.localStorage.setItem("kanban:showSubtasks", String(patch.showSubtasks));
        } catch {
          // ignore
        }
      }
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
function usePageUi(): PageUiState {
  return useSyncExternalStore(pageUi.subscribe, pageUi.get, pageUi.get);
}

/** The right-panel tab that shows the selected card; targeted by ticket id. */
const TICKET_TAB = {
  panelId: "board",
  id: "ticket",
  experimental_target: {
    validate: (value: unknown): value is { ticketId: string } =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { ticketId?: unknown }).ticketId === "string",
  },
} as const;

function relativeTime(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("board_get").then(
      (next) => {
        setBoard(next);
        setError(null);
      },
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(BOARD_CHANGED, refetch);
  return { rpc, board, setBoard, error, refetch };
}

function useProjects(): ProjectOption[] {
  const sdk = useSdk();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    sdk.projects.list().then(
      (list) => {
        if (cancelled) return;
        setProjects(list.map((project) => ({ id: project.id, name: project.name })));
      },
      () => {
        if (!cancelled) setProjects([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk]);
  return projects;
}

function useThreadIndex(): ReadonlyMap<string, PluginSidebarThread> {
  const { threads } = useSidebarThreads({ experimental_lifecycles: ["active", "archived"] });
  return useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
}

/** "Push after applying" is a per-user habit, so it lives in localStorage rather than on the card. */
function usePushPreference(): [boolean, (next: boolean) => void] {
  const pluginId = usePluginId();
  const key = `${pluginId}:pushAfterApply`;
  const [push, setPush] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(key) !== "false";
    } catch {
      return true;
    }
  });
  const update = (next: boolean) => {
    setPush(next);
    try {
      window.localStorage.setItem(key, String(next));
    } catch {
      // Private mode or quota: keep the in-memory value for this session.
    }
  };
  return [push, update];
}

function PushToggle({ push, onChange, disabled }: { push: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <label
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", disabled && "opacity-50")}
      title={push ? "The apply thread commits and pushes to the PR branch." : "The apply thread commits in its worktree and leaves pushing to you."}
    >
      <Checkbox checked={push} disabled={disabled} onCheckedChange={(checked) => onChange(checked === true)} aria-label="Push to the PR branch after applying" />
      and push
    </label>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "outline" | "accent" | "warning" | "danger" | "success";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium leading-4",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "outline" && "border border-border text-muted-foreground",
        tone === "accent" && "bg-primary/10 text-primary",
        tone === "warning" && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        tone === "danger" && "bg-destructive/10 text-destructive",
        tone === "success" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
      )}
    >
      {children}
    </span>
  );
}

function ThreadStatusDot({ thread }: { thread: PluginSidebarThread | null | undefined }) {
  if (thread === undefined) {
    return <span title="Thread not loaded" className="size-2 rounded-full bg-border" />;
  }
  if (thread === null) return null;
  const status = thread.runtimeStatus;
  const busy = status === "active" || status === "starting" || status === "stopping" || status === "provisioning";
  const label = thread.hasPendingInteraction
    ? "Thread needs your input"
    : thread.isArchived
      ? "Thread archived"
      : `Thread ${status}`;
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "size-2 shrink-0 rounded-full",
        thread.hasPendingInteraction && "bg-amber-500",
        !thread.hasPendingInteraction && busy && "animate-pulse bg-primary",
        !thread.hasPendingInteraction && !busy && status === "error" && "bg-destructive",
        !thread.hasPendingInteraction && !busy && status !== "error" && "bg-muted-foreground/50",
      )}
    />
  );
}

function PrBadges({ ticket }: { ticket: Ticket }) {
  if (ticket.pr === null) return null;
  const { pr } = ticket;
  const repoName = pr.repo.split("/")[1] ?? pr.repo;
  const stateTone =
    pr.state === "merged" ? "success" : pr.state === "closed" ? "danger" : pr.state === "draft" ? "neutral" : "accent";
  return (
    <>
      <ExternalLink href={pr.url} title={`Open ${pr.repo}#${pr.number} on GitHub`} className="inline-flex max-w-full">
        <Badge title={pr.repo}>
          <Icon name="GitPullRequest" className="size-3" />
          {repoName}#{pr.number}
        </Badge>
      </ExternalLink>
      {pr.state !== "open" ? <Badge tone={stateTone}>{pr.state}</Badge> : null}
    </>
  );
}

function JiraBadges({ ticket }: { ticket: Ticket }) {
  if (ticket.jira === null) return null;
  const { jira } = ticket;
  const tone = jira.statusCategory === "done" ? "success" : jira.statusCategory === "indeterminate" ? "accent" : "neutral";
  return (
    <>
      <ExternalLink href={jira.url} title={`Open ${jira.key} in Jira`} className="inline-flex max-w-full">
        <Badge title={jira.issueType}>
          <Icon name="kanban-ticket" className="size-3" />
          {jira.key}
        </Badge>
      </ExternalLink>
      {jira.status !== "" ? <Badge tone={tone}>{jira.status}</Badge> : null}
      {jira.priority !== null ? <Badge title="Priority">{jira.priority}</Badge> : null}
    </>
  );
}

function TagBadges({ tags, onRemove }: { tags: readonly string[]; onRemove?: (tag: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((tag) => (
        <Badge key={tag} tone="outline">
          #{tag}
          {onRemove !== undefined ? (
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              className="-mr-0.5 rounded hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onRemove(tag);
              }}
            >
              <Icon name="X" className="size-3" />
            </button>
          ) : null}
        </Badge>
      ))}
    </>
  );
}

/** Splits "Fix thing #infra #urgent" into a title and tags. */
function parseQuickAdd(text: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  const title = text
    .replace(/(^|\s)#([a-z0-9][a-z0-9._-]*)/giu, (_match, _space: string, tag: string) => {
      tags.push(tag.toLowerCase());
      return " ";
    })
    .replace(/\s+/gu, " ")
    .trim();
  return { title, tags: [...new Set(tags)] };
}

function TagEditor({ ticket, rpc, run, suggestions }: { ticket: Ticket; rpc: Rpc; run: (action: () => Promise<unknown>) => Promise<void>; suggestions: readonly string[] }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const next = parseQuickAdd(draft.split(/[\s,]+/u).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")).tags;
    if (next.length === 0) return;
    setDraft("");
    void run(() => rpc.call("ticket_set_tags", { id: ticket.id, tags: [...ticket.tags, ...next] }));
  };
  const unused = suggestions.filter((tag) => !ticket.tags.includes(tag));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <TagBadges
          tags={ticket.tags}
          onRemove={(tag) => void run(() => rpc.call("ticket_set_tags", { id: ticket.id, tags: ticket.tags.filter((entry) => entry !== tag) }))}
        />
        <input
          list={`tags-${ticket.id}`}
          value={draft}
          aria-label="Add tag"
          placeholder={ticket.tags.length === 0 ? "Add tag…" : "+ tag"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
          className="h-6 w-28 bg-transparent px-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none"
        />
        <datalist id={`tags-${ticket.id}`}>
          {unused.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

function Select({
  value,
  onChange,
  children,
  "aria-label": ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  "aria-label": string;
  className?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </select>
  );
}

function Textarea({
  value,
  onChange,
  placeholder,
  "aria-label": ariaLabel,
  rows = 4,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  "aria-label": string;
  rows?: number;
}) {
  return (
    <textarea
      aria-label={ariaLabel}
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

function ProjectSelect({
  projects,
  value,
  onChange,
  allowNone,
  className,
}: {
  projects: ProjectOption[];
  value: string;
  onChange: (value: string) => void;
  allowNone: boolean;
  className?: string;
}) {
  return (
    <Select aria-label="Project" value={value} onChange={onChange} className={className}>
      {allowNone ? <option value="">No project (no thread)</option> : null}
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </Select>
  );
}

/** Compact control sizing for the card panel: the panel is narrow, so chrome stays small. */
const COMPACT = "h-7 gap-1.5 px-2 text-xs [&_[data-icon-root]]:size-3.5";

/** A collapsible block whose header carries the one-line summary; details live inside. */
function Group({
  title,
  summary,
  menu,
  defaultOpen,
  children,
}: {
  title: string;
  summary?: ReactNode;
  menu?: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-md border border-border">
      <div className="flex items-center gap-1 pl-1.5 pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1.5 text-left hover:text-foreground"
        >
          <Icon name="ChevronDown" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          <span className="text-xs font-semibold text-foreground">{title}</span>
          {summary !== undefined ? <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">{summary}</span> : null}
        </button>
        {menu}
      </div>
      {open ? <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2.5">{children}</div> : null}
    </section>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-1 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

function shortSha(sha: string | null): string {
  return sha === null ? "?" : sha.slice(0, 7);
}

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

function ReviewScoreBadges({ scores, compact = false }: { scores: NonNullable<Ticket["latestReview"]>["scores"]; compact?: boolean }) {
  if (scores === null) return null;
  const tone = (value: number): "success" | "neutral" | "warning" => (value >= 4 ? "success" : value >= 3 ? "neutral" : "warning");
  const importanceTone = (value: number): "danger" | "warning" | "neutral" => (value >= 5 ? "danger" : value >= 4 ? "warning" : "neutral");
  return (
    <>
      <Badge
        tone={importanceTone(scores.maxImportance)}
        title={`Highest importance across ${scores.scored} scored finding(s); mean ${scores.meanImportance}/5`}
      >
        {compact ? "imp" : "importance"} {scores.maxImportance}/5
      </Badge>
      <Badge
        tone={tone(scores.meanScopeFit)}
        title={`Average scope fit across ${scores.scored} scored finding(s): 5 = fixes stay inside the PR, 1 = separate work`}
      >
        {compact ? "scope" : "scope fit"} {scores.meanScopeFit}/5
      </Badge>
    </>
  );
}

function ReviewBadge({ ticket }: { ticket: Ticket }) {
  const review = ticket.latestReview;
  if (review === null) return null;
  if (review.status === "running") return <Badge tone="accent">reviewing…</Badge>;
  if (review.status === "failed") return <Badge tone="danger">review failed</Badge>;
  if (review.apply !== null && review.apply.completedAt === null) return <Badge tone="accent">applying…</Badge>;
  if (review.apply !== null) {
    return <Badge tone="success" title={`Fixes pushed as ${review.apply.pushedCommit ?? "unknown"}`}>applied</Badge>;
  }
  const counts = review.counts;
  if (counts === null) return <Badge title={`Reviewed at commit ${review.commitSha ?? "unknown"}`}>reviewed</Badge>;
  const total = counts.critical + counts.important + counts.minor;
  if (total === 0) return <Badge tone="success">no findings</Badge>;
  return (
    <Badge
      tone={counts.critical > 0 ? "danger" : counts.important > 0 ? "warning" : "neutral"}
      title={`${counts.critical} critical, ${counts.important} important, ${counts.minor} minor`}
    >
      {total} finding{total === 1 ? "" : "s"}
      {review.selectedCount !== null ? ` · ${review.selectedCount} to apply` : ""}
    </Badge>
  );
}

function locationLabel(location: Finding["locations"][number]): string {
  if (location.startLine === null) return location.file;
  if (location.endLine === null || location.endLine === location.startLine) return `${location.file}:${location.startLine}`;
  return `${location.file}:${location.startLine}-${location.endLine}`;
}

function ScoreBadge({ label, value, title }: { label: string; value: number | null; title: string }) {
  if (value === null) return null;
  return (
    <Badge tone={value >= 4 ? "success" : value >= 3 ? "neutral" : "warning"} title={title}>
      {label} {value}/5
    </Badge>
  );
}

function FindingCard({
  finding,
  selected,
  overridden,
  onToggle,
}: {
  finding: Finding;
  selected: boolean | null;
  overridden: boolean;
  onToggle: ((selected: boolean) => void) | null;
}) {
  return (
    <li className={cn("rounded-md border border-border bg-card p-2.5", selected === false && "opacity-60")}>
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
        <ScoreBadge label="importance" value={finding.importance} title="How much it matters to fix before merge (1–5)" />
        <ScoreBadge label="scope" value={finding.scopeFit} title="How well the fix stays inside this PR's scope (5 = local edit, 1 = separate piece of work)" />
        {overridden ? <Badge title="You changed this from the suggested selection">manual</Badge> : null}
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
          <span>
            <span className="font-medium text-foreground tabular-nums">{selectedCount}</span> of {report.findings.length} selected for the apply round
            {overriddenCount > 0 ? ` (${overriddenCount} changed by you)` : " (suggested: critical, or importance ≥ 3 and scope ≥ 3)"}
          </span>
          {onReset !== null && overriddenCount > 0 ? (
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onReset}>
              Reset to suggested
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
        {report.reviewers.map((reviewer) => (
          <Badge key={reviewer} tone="accent">
            {reviewer}
          </Badge>
        ))}
        {report.skippedReviewers.map((skipped) => (
          <Badge key={skipped.name} title={skipped.reason}>
            {skipped.name} skipped
          </Badge>
        ))}
        {report.range !== null ? <code className="ml-auto">{report.range}</code> : null}
      </div>
      {grouped.length === 0 ? <p className="text-sm text-muted-foreground">No findings.</p> : null}
      {grouped.map(({ severity, findings }) => (
        <section key={severity} aria-label={SEVERITY_LABEL[severity]}>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {SEVERITY_LABEL[severity]} <span className="font-normal tabular-nums">{findings.length}</span>
          </h3>
          <ul className="flex flex-col gap-2">
            {findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                selected={review.selection[finding.id] ?? null}
                overridden={finding.id in review.selectionOverrides}
                onToggle={onToggle === null ? null : (selected) => onToggle(finding.id, selected)}
              />
            ))}
          </ul>
        </section>
      ))}
      {report.skippedFiles.length > 0 ? (
        <p className="text-xs text-muted-foreground">Skipped generated files: {report.skippedFiles.join(", ")}</p>
      ) : null}
    </div>
  );
}

function ReviewStatusChips({ review }: { review: Ticket["latestReview"] }) {
  if (review === null) return <Badge>Not reviewed</Badge>;
  if (review.status === "running") return <Badge tone="accent">Reviewing…</Badge>;
  if (review.status === "failed") return <Badge tone="danger">Review failed</Badge>;
  return (
    <>
      <Badge title={`Reviewed at commit ${review.commitSha ?? "unknown"}`}>
        {shortSha(review.commitSha)}
        {review.sinceCommitSha !== null ? ` since ${shortSha(review.sinceCommitSha)}` : ""}
      </Badge>
      <SeverityCountBadges counts={review.counts} />
      <ReviewScoreBadges scores={review.scores} />
    </>
  );
}

function ReviewPanel({
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
  run: (action: () => Promise<unknown>, successMessage?: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const [autoApprove, setAutoApprove] = useState(false);
  const [push, setPush] = usePushPreference();
  const [showFindings, setShowFindings] = useState(false);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const review = ticket.latestReview;
  useEffect(() => {
    if (!showFindings) return;
    let cancelled = false;
    rpc.call("review_list", { ticketId: ticket.id }).then(
      (result) => {
        if (!cancelled) setReviews(result.reviews);
      },
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [showFindings, ticket.id, ticket.latestReview?.completedAt, ticket.latestReview?.selectedCount, rpc]);

  const applying = review?.apply !== null && review?.apply !== undefined && review.apply.completedAt === null;
  const selectedCount = review?.selectedCount ?? null;
  const findingCount = review?.counts === null || review?.counts === undefined ? null : review.counts.critical + review.counts.important + review.counts.minor;
  const updateReview = (updated: Review) =>
    setReviews((current) => (current === null ? current : current.map((entry) => (entry.id === updated.id ? updated : entry))));
  const toggleFinding = (reviewId: string, findingId: string, selected: boolean) =>
    rpc.call("review_set_selection", { reviewId, findingId, selected }).then(updateReview, (cause: unknown) => toast.error(errorMessage(cause)));
  const resetSelection = (reviewId: string) =>
    rpc.call("review_reset_selection", { reviewId }).then(updateReview, (cause: unknown) => toast.error(errorMessage(cause)));
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
        <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onOpenThread(review.threadId)}>
            <Icon name="MessageSquare" className="size-4 text-muted-foreground" />
            Open review thread
          </DropdownMenu.Item>
          {review.apply !== null ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onOpenThread(review.apply!.threadId)}>
              <Icon name="kanban-wrench" className="size-4 text-muted-foreground" />
              Open apply thread
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {canIncremental ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={!canStart} onSelect={() => startReview("incremental")}>
              <Icon name="kanban-search-check" className="size-4 text-muted-foreground" />
              Review changes since {shortSha(review.commitSha)}
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={!canStart} onSelect={() => startReview("full")}>
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
                  <Icon name="Check" className="size-4" />
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
    <Group title="Code review" summary={<ReviewStatusChips review={review} />} menu={menu} defaultOpen={review !== null}>
      {review === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" className={COMPACT} disabled={!canStart} onClick={() => startReview("full")}>
            <Icon name="kanban-search-check" className="size-3.5" />
            Review this PR
          </Button>
          <span className="text-xs text-muted-foreground">
            {canReview ? "Checks the PR out in a fresh worktree and runs the code-review skill." : "Start the card's thread in a project first; reviews run there."}
          </span>
        </div>
      ) : review.status === "running" ? (
        <button type="button" onClick={() => onOpenThread(review.threadId)} className="flex items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground">
          <ThreadStatusDot thread={threads.get(review.threadId)} />
          The review thread is running. Open it to watch progress.
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
            <PushToggle push={push} onChange={setPush} disabled={pending || applying} />
            {review.hasBody ? (
              <Button type="button" variant="ghost" className={COMPACT} onClick={() => setShowFindings((open) => !open)}>
                <Icon name={showFindings ? "ChevronUp" : "ChevronDown"} className="size-4" />
                {showFindings ? "Hide findings" : `Show ${findingCount ?? ""} findings`}
              </Button>
            ) : null}
            {review.apply !== null ? (
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
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
          {selectedCount === 0 ? <p className="text-xs text-muted-foreground">No findings are selected. Tick at least one to enable apply.</p> : null}
          {autoApprove ? <p className="text-xs text-muted-foreground">Apply will skip the triage confirmation.</p> : null}
          {showFindings ? (
            <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
              {reviews === null ? (
                <p className="text-muted-foreground">Loading…</p>
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

// ---------------------------------------------------------------------------
// PR comments
// ---------------------------------------------------------------------------

function commentWhere(comment: PrComment): string {
  if (comment.kind === "review-comment") return `${comment.path ?? "?"}${comment.line === null ? "" : `:${comment.line}`}`;
  if (comment.kind === "review") return `review · ${(comment.reviewState ?? "COMMENTED").toLowerCase().replace("_", " ")}`;
  return "conversation";
}

function CommentRow({
  comment,
  replies,
  now,
  onSelect,
  onAddressed,
}: {
  comment: PrComment;
  replies: PrComment[];
  now: number;
  onSelect: (comment: PrComment, selected: boolean) => void;
  onAddressed: (comment: PrComment, addressed: boolean) => void;
}) {
  const addressed = comment.addressedAt !== null;
  return (
    <li className={cn("rounded-md border border-border bg-card p-2.5", (addressed || comment.mine) && "opacity-70")}>
      <div className="flex items-start gap-2">
        <Checkbox
          checked={comment.selected}
          disabled={addressed}
          onCheckedChange={(checked) => onSelect(comment, checked === true)}
          aria-label={`${comment.selected ? "Exclude" : "Include"} this comment in the apply round`}
          className="mt-0.5"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{comment.author}</span>
            {comment.mine ? <Badge>you</Badge> : null}
            <code className="truncate">{commentWhere(comment)}</code>
            <span>{relativeTime(Date.parse(comment.createdAt), now)}</span>
            {addressed ? <Badge tone="success">addressed</Badge> : null}
            {comment.selectionOverride !== null ? <Badge title="You changed this from the suggested selection">manual</Badge> : null}
            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                aria-label={addressed ? "Mark as not addressed" : "Mark as addressed"}
                title={addressed ? "Mark as not addressed" : "Mark as addressed"}
                className={cn("flex size-6 items-center justify-center rounded hover:bg-state-hover", addressed ? "text-emerald-600 dark:text-emerald-300" : "text-muted-foreground hover:text-foreground")}
                onClick={() => onAddressed(comment, !addressed)}
              >
                <Icon name="CircleCheck" className="size-3.5" />
              </button>
              <ExternalLink href={comment.url} title="Open on GitHub" className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground">
                <Icon name="ExternalLink" className="size-3.5" />
              </ExternalLink>
            </span>
          </div>
          {comment.body.trim() !== "" ? <Markdown content={comment.body} className="text-sm" /> : <p className="text-xs italic text-muted-foreground">(no text)</p>}
          {replies.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-2 border-l-2 border-border pl-3">
              {replies.map((reply) => (
                <li key={reply.id} className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={reply.selected}
                      disabled={reply.addressedAt !== null}
                      onCheckedChange={(checked) => onSelect(reply, checked === true)}
                      aria-label={`${reply.selected ? "Exclude" : "Include"} this reply in the apply round`}
                    />
                    <span className="font-medium text-foreground">{reply.author}</span>
                    {reply.mine ? <Badge>you</Badge> : null}
                    <span>{relativeTime(Date.parse(reply.createdAt), now)}</span>
                  </div>
                  <Markdown content={reply.body} className="text-sm" />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function CommentsPanel({
  ticket,
  threads,
  rpc,
  pending,
  canApply,
  run,
  onOpenThread,
}: {
  ticket: Ticket;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  rpc: Rpc;
  pending: boolean;
  canApply: boolean;
  run: (action: () => Promise<unknown>, successMessage?: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const now = useNow();
  const [push, setPush] = usePushPreference();
  const [autoApprove, setAutoApprove] = useState(false);
  const [showAddressed, setShowAddressed] = useState(false);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ comments: PrComment[]; applies: CommentApply[] } | null>(null);
  const counts = ticket.comments;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    rpc.call("comments_list", { ticketId: ticket.id }).then(
      (result) => {
        if (!cancelled) setData(result);
      },
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [open, ticket.id, counts?.total, counts?.open, counts?.selected, rpc]);

  const patch = (updated: PrComment) =>
    setData((current) => (current === null ? current : { ...current, comments: current.comments.map((entry) => (entry.id === updated.id ? updated : entry)) }));
  const select = (comment: PrComment, selected: boolean) =>
    rpc.call("comment_set_selected", { id: comment.id, selected }).then(patch, (cause: unknown) => toast.error(errorMessage(cause)));
  const address = (comment: PrComment, addressed: boolean) =>
    rpc.call("comment_set_addressed", { id: comment.id, addressed }).then(patch, (cause: unknown) => toast.error(errorMessage(cause)));

  const running = data?.applies.find((apply) => apply.completedAt === null) ?? null;
  const last = data?.applies[0] ?? null;
  const comments = data?.comments ?? [];
  const topLevel = comments.filter((comment) => comment.inReplyTo === null && (showAddressed || comment.addressedAt === null));
  const repliesOf = (id: string) => comments.filter((comment) => comment.inReplyTo === id);
  const addressedCount = comments.filter((comment) => comment.addressedAt !== null).length;

  if (counts === null) return null;
  return (
    <Group
      title="PR comments"
      summary={
        <>
          {counts.total === 0 ? <Badge>none yet</Badge> : null}
          {counts.open > 0 ? <Badge tone="warning">{counts.open} open</Badge> : null}
          {counts.total > 0 && counts.open === 0 ? <Badge tone="success">all addressed</Badge> : null}
        </>
      }
      defaultOpen={counts.open > 0}
    >
      {counts.total === 0 ? (
        <p className="text-xs text-muted-foreground">Comments appear here after the next sync once someone comments on the PR.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {counts.open > 0 || running !== null ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  className={COMPACT}
                  disabled={pending || !canApply || counts.selected === 0 || running !== null}
                  onClick={() => void run(() => rpc.call("comments_apply", { ticketId: ticket.id, autoApprove, push }), "Apply thread started")}
                >
                  <Icon name="kanban-wrench" className="size-3.5" />
                  {running !== null ? "Applying…" : `Apply ${counts.selected} comment${counts.selected === 1 ? "" : "s"}`}
                </Button>
                <PushToggle push={push} onChange={setPush} disabled={pending || running !== null} />
              </>
            ) : null}
            <Button type="button" variant="ghost" className={COMPACT} onClick={() => setOpen((value) => !value)}>
              <Icon name={open ? "ChevronUp" : "ChevronDown"} className="size-4" />
              {open ? "Hide comments" : `Show ${counts.total} comment${counts.total === 1 ? "" : "s"}`}
            </Button>
            {last !== null ? (
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onOpenThread(last.threadId)}
              >
                <ThreadStatusDot thread={threads.get(last.threadId)} />
                {last.completedAt === null
                  ? "Apply thread running"
                  : last.push
                    ? `Pushed ${shortSha(last.pushedCommit)}`
                    : `Committed ${shortSha(last.pushedCommit)}, not pushed`}
              </button>
            ) : null}
          </div>
          {!canApply ? <p className="text-xs text-muted-foreground">Start the card's thread in a project first; the apply thread runs there.</p> : null}
          {counts.selected === 0 && counts.open > 0 ? <p className="text-xs text-muted-foreground">No comments are selected. Tick at least one to enable apply.</p> : null}
          {open ? (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>{counts.selected} selected for the apply round (suggested: everything others wrote that is not yet addressed)</span>
                {addressedCount > 0 ? (
                  <label className="ml-auto inline-flex items-center gap-1.5">
                    <Checkbox checked={showAddressed} onCheckedChange={(checked) => setShowAddressed(checked === true)} aria-label="Show addressed comments" />
                    Show {addressedCount} addressed
                  </label>
                ) : null}
                <label className="inline-flex items-center gap-1.5">
                  <Checkbox checked={autoApprove} onCheckedChange={(checked) => setAutoApprove(checked === true)} aria-label="Skip triage confirmation when applying" />
                  Skip triage confirmation
                </label>
              </div>
              {data === null ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : topLevel.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing open.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {topLevel.map((comment) => (
                    <CommentRow key={comment.id} comment={comment} replies={repliesOf(comment.id)} now={now} onSelect={(entry, selected) => void select(entry, selected)} onAddressed={(entry, addressed) => void address(entry, addressed)} />
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </>
      )}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Changes (diff) view
// ---------------------------------------------------------------------------

function useTicketDiff(ticketId: string, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [diff, setDiff] = useState<TicketDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      rpc.call("diff_get", { ticketId, refresh }).then(
        (result) => {
          setDiff(result);
          setError(null);
          setLoading(false);
        },
        (cause: unknown) => {
          setError(errorMessage(cause));
          setLoading(false);
        },
      );
    },
    [rpc, ticketId],
  );
  useEffect(() => {
    if (enabled) load(false);
  }, [enabled, load]);
  return { diff, error, loading, reload: () => load(true) };
}

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

function ChangesGroup({ ticket, rpc, onOpenDiff }: { ticket: Ticket; rpc: Rpc; onOpenDiff: (ticketId: string) => void }) {
  void rpc;
  const { diff, error, loading } = useTicketDiff(ticket.id, true);
  return (
    <Group
      title="Changes"
      summary={
        diff !== null && diff.files.length > 0 ? (
          <DiffStats files={diff.files} />
        ) : loading ? (
          <span className="text-xs text-muted-foreground">loading…</span>
        ) : (
          <span className="text-xs text-muted-foreground">none</span>
        )
      }
      defaultOpen={false}
    >
      {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
      {diff?.message !== null && diff?.message !== undefined ? <p className="text-xs text-muted-foreground">{diff.message}</p> : null}
      {diff !== null && diff.files.length > 0 ? (
        <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto text-xs">
          {diff.files.map((file) => (
            <li key={file.path} className="flex items-center gap-2">
              <button type="button" className="min-w-0 flex-1 truncate text-left font-mono hover:underline" onClick={() => onOpenDiff(ticket.id)}>
                {file.path}
              </button>
              <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
              <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">−{file.deletions}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" className={COMPACT} onClick={() => onOpenDiff(ticket.id)}>
          <Icon name="kanban-diff" className="size-3.5" />
          Open full diff
        </Button>
        {ticket.pendingDiffComments > 0 ? (
          <span className="text-xs text-muted-foreground">
            {ticket.pendingDiffComments} comment{ticket.pendingDiffComments === 1 ? "" : "s"} waiting to be submitted
          </span>
        ) : null}
      </div>
    </Group>
  );
}

function DiffCommentForm({
  path,
  line,
  side,
  onSubmit,
  onCancel,
}: {
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async () => {
    if (body.trim() === "") return;
    setPending(true);
    try {
      await onSubmit(body.trim());
      setBody("");
      onCancel();
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="my-1 flex flex-col gap-2 rounded-md border border-primary/40 bg-card p-2.5 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon name="MessageSquare" className="size-3.5" />
        <span className="truncate font-mono">{path}</span>
        <code>{line === null ? "whole file" : `${side === "LEFT" ? "old " : ""}line ${line}`}</code>
      </div>
      <textarea
        autoFocus
        value={body}
        rows={3}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
          if (event.key === "Escape") onCancel();
        }}
        placeholder="What should change here? (⌘↩ to add, Esc to cancel)"
        aria-label="Comment"
        className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" className={COMPACT} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="secondary" className={COMPACT} disabled={pending || body.trim() === ""} onClick={() => void submit()}>
          Add comment
        </Button>
      </div>
    </div>
  );
}

function DiffCommentItem({ comment, onDelete }: { comment: DiffComment; onDelete: () => void }) {
  const state = comment.addressedAt !== null ? "addressed" : comment.applyId !== null ? "submitted" : comment.postedAt !== null ? "posted" : "pending";
  return (
    <li className={cn("my-1 flex flex-col gap-1 rounded-md border border-border bg-card p-2.5 text-sm", state !== "pending" && "opacity-70")}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <code>{comment.line === null ? "whole file" : `${comment.side === "LEFT" ? "old " : ""}line ${comment.line}`}</code>
        {state === "pending" ? <Badge tone="warning">pending</Badge> : state === "submitted" ? <Badge tone="accent">submitted</Badge> : state === "posted" ? <Badge tone="accent">posted</Badge> : <Badge tone="success">addressed</Badge>}
        {comment.postedUrl !== null ? (
          <ExternalLink href={comment.postedUrl} className="hover:text-foreground">
            <Icon name="ExternalLink" className="size-3" />
          </ExternalLink>
        ) : null}
        {state === "pending" ? (
          <button type="button" aria-label="Delete comment" className="ml-auto flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-destructive" onClick={onDelete}>
            <Icon name="Trash2" className="size-3.5" />
          </button>
        ) : null}
      </div>
      <Markdown content={comment.body} className="text-sm" />
    </li>
  );
}

type AnnotationMeta = { kind: "comment"; comment: DiffComment } | { kind: "composer" };

/**
 * The Pierre theme names the host itself renders with. bb registers its code
 * theme in the shared highlighter and publishes the registered names on the
 * document element, so these are the only names guaranteed to resolve.
 */
function useHostPierreThemes(fallbackMode: "dark" | "light"): { dark: string; light: string } {
  const read = () => {
    const data = typeof document === "undefined" ? undefined : document.documentElement.dataset;
    return JSON.stringify({ dark: data?.bbCodeThemeDark ?? "github-dark", light: data?.bbCodeThemeLight ?? "github-light" });
  };
  const subscribe = (listener: () => void) => {
    if (typeof document === "undefined") return () => {};
    const observer = new MutationObserver(listener);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-bb-code-theme-dark", "data-bb-code-theme-light"] });
    return () => observer.disconnect();
  };
  const json = useSyncExternalStore(subscribe, read, read);
  void fallbackMode;
  return JSON.parse(json) as { dark: string; light: string };
}

/** Keeps a renderer failure inside the diff pane: shows the error and falls back to the host's plain diff. */
class DiffErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { errors: string[] }> {
  state: { errors: string[] } = { errors: [] };
  static getDerivedStateFromError(error: Error) {
    return { errors: [error.message] };
  }
  componentDidCatch(error: Error) {
    // React can report a second error from the unmount of the failed subtree; keep every message so the first (root) cause is visible.
    this.setState((state) => (state.errors.includes(error.message) ? state : { errors: [...state.errors, error.message] }));
  }
  render() {
    if (this.state.errors.length > 0) {
      return (
        <div className="flex flex-col gap-2">
          <div className="mx-3 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <p>Line-comment diff failed to render; showing the plain diff instead.</p>
            <ul className="mt-1 list-disc pl-4">
              {this.state.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
          {this.props.fallback}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Pierre's diff renderer used directly (the host's Diff wrapper exposes no line
 * events): a "+" gutter button on hover starts a comment on that line, and
 * comments render inline as line annotations.
 */
function AnnotatedPatch({
  path,
  patch,
  view,
  themes,
  themeMode,
  disableWorkerPool,
  comments,
  composer,
  onStartComment,
  onCancelComposer,
  onSubmitComposer,
  onDeleteComment,
}: {
  path: string;
  patch: string;
  view: "unified" | "split";
  themes: { dark: string; light: string };
  themeMode: "dark" | "light";
  disableWorkerPool: boolean;
  comments: DiffComment[];
  composer: { line: number | null; side: "LEFT" | "RIGHT" } | null;
  onStartComment: (line: number | null, side: "LEFT" | "RIGHT") => void;
  onCancelComposer: () => void;
  onSubmitComposer: (body: string) => Promise<void>;
  onDeleteComment: (id: string) => void;
}) {
  // GitHub patches lack the `diff --git` header Pierre expects; synthesize one for the file.
  const fullPatch = useMemo(
    () => (patch.startsWith("diff --git") ? patch : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}`),
    [patch, path],
  );
  const toSide = (side: "LEFT" | "RIGHT"): "deletions" | "additions" => (side === "LEFT" ? "deletions" : "additions");
  const fromSide = (side: "deletions" | "additions"): "LEFT" | "RIGHT" => (side === "deletions" ? "LEFT" : "RIGHT");
  const fileLevel = comments.filter((comment) => comment.line === null);
  const annotations = useMemo<DiffLineAnnotation<AnnotationMeta>[]>(() => {
    const list: DiffLineAnnotation<AnnotationMeta>[] = comments
      .filter((comment): comment is DiffComment & { line: number } => comment.line !== null)
      .map((comment) => ({ side: toSide(comment.side), lineNumber: comment.line, metadata: { kind: "comment", comment } }));
    if (composer !== null && composer.line !== null) {
      list.push({ side: toSide(composer.side), lineNumber: composer.line, metadata: { kind: "composer" } });
    }
    return list;
  }, [comments, composer]);
  const selected = composer !== null && composer.line !== null ? { start: composer.line, end: composer.line, side: toSide(composer.side), endSide: toSide(composer.side) } : undefined;
  const options = useMemo(
    () => ({
      diffStyle: view,
      theme: themes,
      themeType: themeMode,
      disableFileHeader: true,
      overflow: "scroll" as const,
      lineHoverHighlight: "both" as const,
      enableGutterUtility: true,
      onGutterUtilityClick: (range: { start: number; side?: "deletions" | "additions" }) => onStartComment(range.start, fromSide(range.side ?? "additions")),
      onLineNumberClick: (props: { lineNumber: number; annotationSide: "deletions" | "additions" }) => onStartComment(props.lineNumber, fromSide(props.annotationSide)),
    }),
    [view, themes, themeMode, onStartComment],
  );
  return (
    <>
      {composer !== null && composer.line === null ? (
        <div className="px-3">
          <DiffCommentForm path={path} line={null} side="RIGHT" onSubmit={onSubmitComposer} onCancel={onCancelComposer} />
        </div>
      ) : null}
      {fileLevel.length > 0 ? (
        <ul className="px-3">
          {fileLevel.map((comment) => (
            <DiffCommentItem key={comment.id} comment={comment} onDelete={() => onDeleteComment(comment.id)} />
          ))}
        </ul>
      ) : null}
    <PatchDiff<AnnotationMeta>
      patch={fullPatch}
      options={options}
      lineAnnotations={annotations}
      {...(selected === undefined ? {} : { selectedLines: selected })}
      disableWorkerPool={disableWorkerPool}
      className="text-xs"
      renderAnnotation={(annotation) => {
        if (annotation.metadata.kind === "composer") {
          return <DiffCommentForm path={path} line={composer?.line ?? null} side={composer?.side ?? "RIGHT"} onSubmit={onSubmitComposer} onCancel={onCancelComposer} />;
        }
        const { comment } = annotation.metadata;
        return (
          <ul className="list-none">
            <DiffCommentItem comment={comment} onDelete={() => onDeleteComment(comment.id)} />
          </ul>
        );
      }}
    />
    </>
  );
}

const HIGHLIGHT_CLASS: Record<string, string> = {
  keyword: "text-violet-600 dark:text-violet-300",
  string: "text-emerald-700 dark:text-emerald-300",
  type: "text-sky-700 dark:text-sky-300",
  comment: "text-muted-foreground italic",
  delimiter: "text-muted-foreground",
  treesittererror: "underline decoration-wavy decoration-destructive",
  normal: "",
};
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/gu;

/** One side's line: changed spans tinted by difftastic, identifiers made ⌘-clickable. */
function StructuralLine({
  text,
  changes,
  side,
  onSymbol,
}: {
  text: string;
  changes: StructuralDiff["chunks"][number][number]["lhs"];
  side: "LEFT" | "RIGHT";
  onSymbol: (symbol: string, anchor: HTMLElement) => void;
}) {
  // Build segments: [start,end) ranges with a highlight kind, gaps are plain.
  const spans = (changes?.changes ?? []).slice().sort((a, b) => a.start - b.start);
  const segments: Array<{ text: string; changed: boolean; highlight: string }> = [];
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > cursor) segments.push({ text: text.slice(cursor, start), changed: false, highlight: "normal" });
    if (end > start) segments.push({ text: text.slice(start, end), changed: true, highlight: span.highlight });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), changed: false, highlight: "normal" });
  if (segments.length === 0) segments.push({ text: "", changed: false, highlight: "normal" });
  const renderTokens = (segment: string, key: string) => {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of segment.matchAll(IDENTIFIER)) {
      const index = match.index ?? 0;
      if (index > last) parts.push(segment.slice(last, index));
      const word = match[0];
      parts.push(
        <span
          key={`${key}-${index}`}
          data-symbol={word}
          className="rounded-sm [.symbol-mode_&]:cursor-pointer [.symbol-mode_&]:hover:bg-primary/15 [.symbol-mode_&]:hover:underline"
          onClick={(event) => {
            if (!(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            event.stopPropagation();
            onSymbol(word, event.currentTarget);
          }}
        >
          {word}
        </span>,
      );
      last = index + word.length;
    }
    if (last < segment.length) parts.push(segment.slice(last));
    return parts;
  };
  return (
    <>
      {segments.map((segment, index) => (
        <span
          key={index}
          className={cn(
            HIGHLIGHT_CLASS[segment.highlight] ?? "",
            segment.changed && (side === "LEFT" ? "rounded-sm bg-red-500/25" : "rounded-sm bg-emerald-500/25"),
          )}
        >
          {renderTokens(segment.text, `${index}`)}
        </span>
      ))}
    </>
  );
}

function StructuralPatch({
  ticketId,
  path,
  comments,
  composer,
  onStartComment,
  onCancelComposer,
  onSubmitComposer,
  onDeleteComment,
  onOpenFile,
}: {
  ticketId: string;
  path: string;
  comments: DiffComment[];
  composer: { line: number | null; side: "LEFT" | "RIGHT" } | null;
  onStartComment: (line: number | null, side: "LEFT" | "RIGHT") => void;
  onCancelComposer: () => void;
  onSubmitComposer: (body: string) => Promise<void>;
  onDeleteComment: (id: string) => void;
  onOpenFile: (lookup: SymbolLookup, definition: SymbolLookup["definitions"][number]) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [diff, setDiff] = useState<StructuralDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<{ symbol: string; result: SymbolLookup | null; anchor: DOMRect } | null>(null);
  const [symbolMode, setSymbolMode] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    rpc.call("diff_structural", { ticketId, path }).then(
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
  }, [rpc, ticketId, path]);
  // ⌘/Ctrl held → identifiers become links, like an IDE.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") setSymbolMode(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") setSymbolMode(false);
    };
    const blur = () => setSymbolMode(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const lookupSymbol = (symbol: string, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setLookup({ symbol, result: null, anchor: rect });
    rpc.call("symbol_definitions", { ticketId, symbol }).then(
      (result) => setLookup((current) => (current?.symbol === symbol ? { ...current, result } : current)),
      (cause: unknown) => {
        toast.error(errorMessage(cause));
        setLookup(null);
      },
    );
  };
  if (error !== null) return <p className="p-4 text-sm text-destructive">{error}</p>;
  if (diff === null) return <p className="p-4 text-sm text-muted-foreground">Running difftastic…</p>;
  if (!diff.available) {
    return (
      <div className="m-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        <p>Structural diff unavailable.</p>
        <p className="mt-1 text-xs">{diff.reason}</p>
        <Button type="button" variant="secondary" className={cn(COMPACT, "mt-2")} onClick={() => pageUi.set({ diffMode: "text" })}>
          Show text diff
        </Button>
      </div>
    );
  }
  const oldLines = diff.oldText.split("\n");
  const newLines = diff.newText.split("\n");
  const commentsAt = (side: "LEFT" | "RIGHT", line: number) => comments.filter((comment) => comment.line === line && comment.side === side);
  const lineCell = (sideLine: StructuralDiff["chunks"][number][number]["lhs"], side: "LEFT" | "RIGHT") => {
    const lines = side === "LEFT" ? oldLines : newLines;
    if (sideLine === null) return <td className="w-1/2 bg-muted/20" colSpan={2} />;
    const text = lines[sideLine.line - 1] ?? "";
    const changed = sideLine.changes.length > 0;
    return (
      <>
        <td
          className={cn("group/ln w-10 select-none border-r border-border/60 pr-2 text-right align-top text-muted-foreground/70", changed && (side === "LEFT" ? "bg-red-500/10" : "bg-emerald-500/10"))}
        >
          <button
            type="button"
            className="relative w-full text-right tabular-nums hover:text-foreground"
            title="Comment on this line"
            onClick={() => onStartComment(sideLine.line, side)}
          >
            <span className="group-hover/ln:invisible">{sideLine.line}</span>
            <span className="absolute inset-0 hidden items-center justify-end pr-0.5 text-primary group-hover/ln:flex">+</span>
          </button>
        </td>
        <td className={cn("w-1/2 whitespace-pre-wrap break-words pl-2 pr-3 align-top", changed && (side === "LEFT" ? "bg-red-500/10" : "bg-emerald-500/10"))}>
          <StructuralLine text={text} changes={sideLine} side={side} onSymbol={lookupSymbol} />
        </td>
      </>
    );
  };
  const annotationRow = (side: "LEFT" | "RIGHT", line: number) => {
    const list = commentsAt(side, line);
    const composing = composer !== null && composer.line === line && composer.side === side;
    if (list.length === 0 && !composing) return null;
    return (
      <tr key={`${side}-${line}-notes`}>
        <td colSpan={4} className="px-3 py-1">
          {composing ? <DiffCommentForm path={path} line={line} side={side} onSubmit={onSubmitComposer} onCancel={onCancelComposer} /> : null}
          {list.length > 0 ? (
            <ul className="list-none">
              {list.map((comment) => (
                <DiffCommentItem key={comment.id} comment={comment} onDelete={() => onDeleteComment(comment.id)} />
              ))}
            </ul>
          ) : null}
        </td>
      </tr>
    );
  };
  return (
    <div className={cn("relative", symbolMode && "symbol-mode")}>
      <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-muted-foreground">
        <span>difftastic · {diff.language ?? "text"} · {diff.status}</span>
        <span className="ml-auto">⌘-click an identifier to find its definition</span>
      </div>
      {diff.chunks.length === 0 ? <p className="px-3 py-2 text-sm text-muted-foreground">No structural changes.</p> : null}
      <table className="w-full table-fixed border-collapse font-mono text-[12px] leading-5">
        <tbody>
          {diff.chunks.map((chunk, chunkIndex) => (
            <Fragment key={chunkIndex}>
              {chunkIndex > 0 ? (
                <tr>
                  <td colSpan={4} className="border-y border-border/60 bg-muted/30 px-3 py-0.5 text-[11px] text-muted-foreground">
                    ⋯
                  </td>
                </tr>
              ) : null}
              {chunk.map((pair, pairIndex) => (
                <Fragment key={pairIndex}>
                  <tr className="hover:bg-state-hover/40">
                    {lineCell(pair.lhs, "LEFT")}
                    {lineCell(pair.rhs, "RIGHT")}
                  </tr>
                  {pair.lhs !== null ? annotationRow("LEFT", pair.lhs.line) : null}
                  {pair.rhs !== null ? annotationRow("RIGHT", pair.rhs.line) : null}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      {lookup !== null ? (
        <div
          role="dialog"
          aria-label={`Definitions of ${lookup.symbol}`}
          className="fixed z-50 w-96 max-w-[90vw] rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
          style={{ top: Math.min(lookup.anchor.bottom + 6, window.innerHeight - 260), left: Math.min(lookup.anchor.left, window.innerWidth - 400) }}
        >
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <code className="text-foreground">{lookup.symbol}</code>
            {lookup.result !== null ? <span>· {lookup.result.searched === "workspace" ? "git grep in workspace" : lookup.result.searched === "github" ? "GitHub code search" : "no searchable checkout"}</span> : <span>· searching…</span>}
            <button type="button" aria-label="Close" className="ml-auto rounded p-0.5 hover:bg-state-hover" onClick={() => setLookup(null)}>
              <Icon name="X" className="size-3.5" />
            </button>
          </div>
          {lookup.result !== null && lookup.result.definitions.length === 0 ? <p className="px-1 py-1 text-xs text-muted-foreground">No definition found.</p> : null}
          <ul className="max-h-56 overflow-y-auto">
            {lookup.result?.definitions.map((definition, index) => (
              <li key={`${definition.path}:${definition.line ?? index}`}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-0.5 rounded px-1.5 py-1 text-left hover:bg-state-hover"
                  onClick={() => {
                    onOpenFile(lookup.result!, definition);
                    setLookup(null);
                  }}
                >
                  <span className="truncate font-mono text-xs">
                    {definition.path}
                    {definition.line !== null ? `:${definition.line}` : ""}
                  </span>
                  {definition.snippet !== "" ? <span className="truncate font-mono text-[11px] text-muted-foreground">{definition.snippet}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function DiffView({ ticketId, onBack, onOpenThread }: { ticketId: string; onBack: () => void; onOpenThread: (threadId: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const { board, refetch } = useBoard();
  const ticket = board?.tickets.find((entry) => entry.id === ticketId) ?? null;
  const { diff, error, loading, reload } = useTicketDiff(ticketId, true);
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [composer, setComposer] = useState<{ path: string; line: number | null; side: "LEFT" | "RIGHT" } | null>(null);
  const { diffView: view, diffMode, diffReloadNonce } = usePageUi();
  const navigate = useBbNavigate();
  const openDefinition = (lookup: SymbolLookup, definition: SymbolLookup["definitions"][number]) => {
    if (lookup.open.kind === "environment") {
      const accepted = navigate.experimental_openFilePreview({
        target: { kind: "workspace", environmentId: lookup.open.environmentId, path: definition.path },
        location: definition.line === null ? null : { kind: "line", line: definition.line, column: null },
      });
      if (accepted) return;
    }
    if (lookup.open.kind === "github") {
      window.open(`https://github.com/${lookup.open.repo}/blob/${lookup.open.sha}/${definition.path}${definition.line === null ? "" : `#L${definition.line}`}`, "_blank", "noopener,noreferrer");
      return;
    }
    toast.message("No checkout to open this file in; start the card's thread first.");
  };
  const lastReload = useRef(diffReloadNonce);
  useEffect(() => {
    if (lastReload.current !== diffReloadNonce) {
      lastReload.current = diffReloadNonce;
      reload();
    }
  });
  useEffect(() => {
    pageUi.set({ diffLoading: loading });
  }, [loading]);
  const codeTheme = useCodeTheme();
  const hostThemes = useHostPierreThemes(codeTheme.mode);
  const workerPool = useWorkerPool();
  const [push, setPush] = usePushPreference();
  const [postToGithub, setPostToGithub] = useState<boolean | null>(null);
  const [address, setAddress] = useState(true);
  const [autoApprove, setAutoApprove] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const loadComments = useCallback(() => {
    rpc.call("diff_comments_list", { ticketId }).then((result) => setComments(result.comments), (cause: unknown) => toast.error(errorMessage(cause)));
  }, [rpc, ticketId]);
  useEffect(loadComments, [loadComments]);
  useRealtime(BOARD_CHANGED, loadComments);
  useEffect(() => {
    if (selectedPath === null && diff !== null && diff.files.length > 0) setSelectedPath(diff.files[0]!.path);
  }, [diff, selectedPath]);

  const canPost = ticket?.canPostToGithub ?? false;
  const willPost = postToGithub ?? canPost;
  const pending = comments.filter((comment) => comment.addressedAt === null && comment.applyId === null);
  const forPath = (path: string) => comments.filter((comment) => comment.path === path);
  const file = diff?.files.find((entry) => entry.path === selectedPath) ?? null;
  const index = diff === null || file === null ? -1 : diff.files.indexOf(file);
  const step = (delta: number) => {
    if (diff === null) return;
    const next = diff.files[index + delta];
    if (next !== undefined) setSelectedPath(next.path);
  };

  const addComment = async (path: string, line: number | null, side: "LEFT" | "RIGHT", body: string) => {
    try {
      await rpc.call("diff_comment_add", { ticketId, path, line, side, body });
      loadComments();
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  const deleteComment = async (id: string) => {
    try {
      await rpc.call("diff_comment_delete", { id });
      loadComments();
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  const submit = async () => {
    setSubmitting(true);
    try {
      const result = await rpc.call("diff_comments_submit", { ticketId, postToGithub: willPost, address, autoApprove, push });
      const parts: string[] = [];
      if (result.posted > 0) parts.push(`posted ${result.posted} to GitHub`);
      if (result.apply !== null) parts.push("address thread started");
      toast.success(parts.join(" · ") || "Submitted");
      loadComments();
      refetch();
      if (result.apply !== null) onOpenThread(result.apply.threadId);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  if (ticket === null) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {board === null ? "Loading…" : "This card no longer exists."}{" "}
        <button type="button" className="underline" onClick={onBack}>
          Back to board
        </button>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {pending.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-muted/30 px-3 py-2">
          <span className="text-sm">
            <span className="font-medium tabular-nums">{pending.length}</span> comment{pending.length === 1 ? "" : "s"} ready
          </span>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={address} onCheckedChange={(checked) => setAddress(checked === true)} aria-label="Have Claude address the comments" />
            Have Claude address them
          </label>
          {address ? <PushToggle push={push} onChange={setPush} /> : null}
          {address ? (
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={autoApprove} onCheckedChange={(checked) => setAutoApprove(checked === true)} aria-label="Skip triage confirmation" />
              skip triage
            </label>
          ) : null}
          <label className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", !canPost && "opacity-50")} title={canPost ? "Posts one review with these comments on the pull request." : `Only PR cards tagged with the review tag post to GitHub.`}>
            <Checkbox checked={willPost} disabled={!canPost} onCheckedChange={(checked) => setPostToGithub(checked === true)} aria-label="Post comments to the GitHub pull request" />
            Post to GitHub PR
          </label>
          <Button type="button" className={cn(COMPACT, "ml-auto")} disabled={submitting || (!address && !willPost)} onClick={() => void submit()}>
            <Icon name="kanban-wrench" className="size-3.5" />
            Submit {pending.length} comment{pending.length === 1 ? "" : "s"}
          </Button>
        </div>
      ) : null}

      {error !== null ? <p className="px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {diff !== null && diff.message !== null ? <p className="px-3 py-2 text-sm text-muted-foreground">{diff.message}</p> : null}
      {diff !== null && diff.files.length > 0 ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground">
          <DiffStats files={diff.files} />
          {diff.baseRef !== null ? <span>· against {diff.baseRef}</span> : null}
          {diff.headSha !== null ? <span>· {shortSha(diff.headSha)}</span> : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-r border-border py-1 md:block">
          {diff === null ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
          ) : (
            <ul>
              {diff.files.map((entry) => {
                const count = forPath(entry.path).filter((comment) => comment.addressedAt === null).length;
                return (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => setSelectedPath(entry.path)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-state-hover",
                        entry.path === selectedPath && "bg-state-active",
                      )}
                      title={entry.path}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">{entry.path}</span>
                      {count > 0 ? <Badge tone="warning">{count}</Badge> : null}
                      <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{entry.additions}</span>
                      <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">−{entry.deletions}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {diff?.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground">File list truncated.</p> : null}
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {file === null ? (
            <p className="p-4 text-sm text-muted-foreground">{diff !== null && diff.files.length === 0 ? "No changes." : "Select a file."}</p>
          ) : (
            <>
              <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1.5">
                <Button type="button" variant="ghost" className={cn(COMPACT, "px-1.5")} disabled={index <= 0} onClick={() => step(-1)} aria-label="Previous file">
                  <Icon name="ChevronUp" className="size-3.5" />
                </Button>
                <Button type="button" variant="ghost" className={cn(COMPACT, "px-1.5")} disabled={diff === null || index >= diff.files.length - 1} onClick={() => step(1)} aria-label="Next file">
                  <Icon name="ChevronDown" className="size-3.5" />
                </Button>
                <code className="min-w-0 flex-1 truncate text-xs">
                  {file.previousPath !== null ? `${file.previousPath} → ` : ""}
                  {file.path}
                </code>
                {file.status !== "modified" ? <Badge>{file.status}</Badge> : null}
                <span className="text-xs tabular-nums text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                <span className="text-xs tabular-nums text-red-600 dark:text-red-400">−{file.deletions}</span>
                <Button type="button" variant="secondary" className={COMPACT} onClick={() => setComposer({ path: file.path, line: null, side: "RIGHT" })}>
                  <Icon name="MessageSquare" className="size-3.5" />
                  Comment on file
                </Button>
              </div>
              {file.patch !== null && diffMode === "structural" ? (
                <StructuralPatch
                  key={`structural-${file.path}`}
                  ticketId={ticketId}
                  path={file.path}
                  comments={forPath(file.path)}
                  composer={composer !== null && composer.path === file.path ? composer : null}
                  onStartComment={(line, side) => setComposer({ path: file.path, line, side })}
                  onCancelComposer={() => setComposer(null)}
                  onSubmitComposer={(body) => (composer === null ? Promise.resolve() : addComment(file.path, composer.line, composer.side, body))}
                  onDeleteComment={(id) => void deleteComment(id)}
                  onOpenFile={openDefinition}
                />
              ) : file.patch !== null ? (
                <DiffErrorBoundary key={file.path} fallback={<Diff patch={file.patch} path={file.path} view={view} className="text-xs" />}>
                <AnnotatedPatch
                  key={file.path}
                  path={file.path}
                  patch={file.patch}
                  view={view}
                  themes={hostThemes}
                  themeMode={codeTheme.mode}
                  disableWorkerPool={workerPool === undefined}
                  comments={forPath(file.path)}
                  composer={composer !== null && composer.path === file.path ? composer : null}
                  onStartComment={(line, side) => setComposer({ path: file.path, line, side })}
                  onCancelComposer={() => setComposer(null)}
                  onSubmitComposer={(body) => (composer === null ? Promise.resolve() : addComment(file.path, composer.line, composer.side, body))}
                  onDeleteComment={(id) => void deleteComment(id)}
                />
                </DiffErrorBoundary>
              ) : (
                <>
                  {composer !== null && composer.path === file.path ? (
                    <div className="px-3">
                      <DiffCommentForm path={file.path} line={null} side="RIGHT" onSubmit={(body) => addComment(file.path, null, "RIGHT", body)} onCancel={() => setComposer(null)} />
                    </div>
                  ) : null}
                  {forPath(file.path).length > 0 ? (
                    <ul className="px-3">
                      {forPath(file.path).map((comment) => (
                        <DiffCommentItem key={comment.id} comment={comment} onDelete={() => void deleteComment(comment.id)} />
                      ))}
                    </ul>
                  ) : null}
                  <p className="p-4 text-sm text-muted-foreground">No text diff for this file (binary or too large).</p>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------

function SubtaskProgress({ ticket }: { ticket: Ticket }) {
  if (ticket.children.total === 0) return null;
  const { done, total } = ticket.children;
  return (
    <Badge tone={done === total ? "success" : "neutral"} title={`${done} of ${total} subtasks done`}>
      <Icon name="ListTodo" className="size-3" />
      {done}/{total}
    </Badge>
  );
}

function SubtasksGroup({
  ticket,
  tickets,
  columns,
  threads,
  rpc,
  pending,
  run,
  onOpenTicket,
  onOpenThread,
}: {
  ticket: Ticket;
  tickets: readonly Ticket[];
  columns: Column[];
  threads: ReadonlyMap<string, PluginSidebarThread>;
  rpc: Rpc;
  pending: boolean;
  run: (action: () => Promise<unknown>, successMessage?: string) => Promise<void>;
  onOpenTicket: (ticketId: string) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const children = tickets.filter((entry) => entry.parentId === ticket.id).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  const doneId = columns.find((column) => column.id === "done")?.id ?? columns.at(-1)?.id ?? null;
  const todoId = columns.find((column) => column.id === "todo")?.id ?? columns[0]?.id ?? null;
  const open = children.filter((child) => child.columnId !== doneId);
  const unstarted = open.filter((child) => child.threadId === null);
  const canRun = ticket.projectId !== null || ticket.threadId !== null;
  const add = () => {
    const { title, tags } = parseQuickAdd(draft);
    if (title === "") return;
    setDraft("");
    void run(() => rpc.call("ticket_create", { title, tags, parentId: ticket.id, ...(todoId === null ? {} : { columnId: todoId }) }));
  };
  return (
    <Group
      title="Subtasks"
      summary={
        children.length === 0 ? (
          <span className="text-xs text-muted-foreground">none</span>
        ) : (
          <>
            <SubtaskProgress ticket={ticket} />
            {open.some((child) => child.threadId !== null && threads.get(child.threadId)?.runtimeStatus === "active") ? <Badge tone="accent">working</Badge> : null}
          </>
        )
      }
      defaultOpen={children.length > 0}
    >
      {children.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {children.map((child) => {
            const thread = child.threadId === null ? null : threads.get(child.threadId);
            const isDone = child.columnId === doneId;
            return (
              <li key={child.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-state-hover">
                <Checkbox
                  checked={isDone}
                  aria-label={isDone ? `Reopen "${child.title}"` : `Mark "${child.title}" done`}
                  onCheckedChange={() =>
                    void run(() => rpc.call("ticket_move", { id: child.id, columnId: isDone ? (todoId ?? child.columnId) : (doneId ?? child.columnId), index: null }))
                  }
                />
                <button type="button" className={cn("min-w-0 flex-1 truncate text-left hover:underline", isDone && "text-muted-foreground line-through")} onClick={() => onOpenTicket(child.id)}>
                  {child.title}
                </button>
                <span className="shrink-0 text-[11px] text-muted-foreground">{columns.find((column) => column.id === child.columnId)?.name ?? child.columnId}</span>
                {child.children.total > 0 ? <SubtaskProgress ticket={child} /> : null}
                {child.threadId !== null ? (
                  <button type="button" aria-label="Open subtask thread" className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground" onClick={() => onOpenThread(child.threadId!)}>
                    <ThreadStatusDot thread={thread} />
                  </button>
                ) : (
                  <span className="w-6 shrink-0" />
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a subtask… (#tag allowed)" aria-label="New subtask" className="h-7 text-xs" />
        <Button type="submit" variant="secondary" className={COMPACT} disabled={pending || parseQuickAdd(draft).title === ""}>
          <Icon name="Plus" className="size-3.5" />
          Add
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="secondary" className={COMPACT} disabled={pending || !canRun} onClick={() => setGuidanceOpen((value) => !value)}>
          <Icon name="kanban-search-check" className="size-3.5" />
          Break down with AI
        </Button>
        {open.length > 0 ? (
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <Button type="button" className={COMPACT} disabled={pending || !canRun}>
                <Icon name="Play" className="size-3.5" />
                Start {unstarted.length > 0 ? `${unstarted.length} subtask${unstarted.length === 1 ? "" : "s"}` : "subtasks"}
                <Icon name="ChevronDown" className="size-3 opacity-70" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="start" sideOffset={4} className="z-50 min-w-64 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                <DropdownMenu.Item
                  className={cn(MENU_ITEM_CLASS, "items-start")}
                  disabled={unstarted.length === 0}
                  onSelect={() => void run(() => rpc.call("ticket_start_children", { id: ticket.id, mode: "parallel" }), "Subtask threads started")}
                >
                  <Icon name="Play" className="mt-0.5 size-4 text-muted-foreground" />
                  <span className="flex flex-col">
                    <span>One thread per subtask</span>
                    <span className="text-xs text-muted-foreground">{unstarted.length} start in parallel, nested under this card's thread</span>
                  </span>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={cn(MENU_ITEM_CLASS, "items-start")}
                  onSelect={() => void run(() => rpc.call("ticket_start_children", { id: ticket.id, mode: "sequential" }), "Subtask thread started")}
                >
                  <Icon name="ListTodo" className="mt-0.5 size-4 text-muted-foreground" />
                  <span className="flex flex-col">
                    <span>One thread, in order</span>
                    <span className="text-xs text-muted-foreground">Works through the {open.length} open subtask{open.length === 1 ? "" : "s"} sequentially</span>
                  </span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
        {!canRun ? <span className="text-xs text-muted-foreground">Start this card's thread in a project first.</span> : null}
      </div>
      {guidanceOpen ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
          <textarea
            autoFocus
            value={guidance}
            rows={2}
            onChange={(event) => setGuidance(event.target.value)}
            placeholder="Optional guidance for the split (e.g. 'one subtask per service', 'keep the migration separate')"
            aria-label="Breakdown guidance"
            className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" className={COMPACT} onClick={() => setGuidanceOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              className={COMPACT}
              disabled={pending}
              onClick={() => {
                setGuidanceOpen(false);
                void run(() => rpc.call("ticket_breakdown", { id: ticket.id, guidance }), ticket.threadId === null ? "Breakdown thread started" : "Asked the card's thread to break it down");
              }}
            >
              Ask the agent to split it
            </Button>
          </div>
        </div>
      ) : null}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Cards and columns
// ---------------------------------------------------------------------------

function threadStatusText(thread: PluginSidebarThread | null | undefined): string {
  if (thread === undefined) return "thread";
  if (thread === null) return "no thread";
  if (thread.hasPendingInteraction) return "needs you";
  if (thread.isArchived) return "archived";
  switch (thread.runtimeStatus) {
    case "active":
    case "starting":
      return "working";
    case "error":
      return "error";
    case "provisioning":
    case "waiting-for-host":
      return "provisioning";
    default:
      return "idle";
  }
}

function CardView({
  ticket,
  thread,
  hiddenTags,
  isDragging,
  onOpen,
  onOpenThread,
  onOpenReview,
  onReview,
  onOpenDiff,
  onDragStart,
  onDragEnd,
}: {
  ticket: Ticket;
  thread: PluginSidebarThread | null | undefined;
  /** Tags applied by the card's source; every card from that source carries them, so they are noise here. */
  hiddenTags: ReadonlySet<string>;
  isDragging: boolean;
  onOpen: () => void;
  onOpenThread: () => void;
  onOpenReview: () => void;
  onReview: () => void;
  onOpenDiff: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const review = ticket.latestReview;
  const ownTags = ticket.tags.filter((tag) => !hiddenTags.has(tag));
  const iconButton = "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground";
  // Only states that need the eye get words; a quiet idle thread is just a dot.
  const status = ticket.threadId === null ? null : threadStatusText(thread);
  const loud = status === "working" || status === "needs you" || status === "error" || status === "provisioning";
  const findings = review?.counts === null || review?.counts === undefined ? null : review.counts.critical + review.counts.important + review.counts.minor;
  return (
    <div
      data-ticket-id={ticket.id}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group flex cursor-grab flex-col gap-1.5 rounded-md border border-border bg-card p-2.5 text-left text-sm shadow-sm transition-opacity hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      <span className="line-clamp-2 break-words font-medium leading-5">{ticket.title}</span>
      {ticket.pr !== null || ticket.jira !== null || ownTags.length > 0 || ticket.parentId !== null ? (
        <div className="flex flex-wrap items-center gap-1">
          <PrBadges ticket={ticket} />
          <JiraBadges ticket={ticket} />
          <TagBadges tags={ownTags} />
          {ticket.parentId !== null ? <Badge tone="outline">↳ subtask</Badge> : null}
        </div>
      ) : null}
      <div className="flex h-6 items-center gap-1.5 text-[11px] text-muted-foreground">
        {ticket.threadId !== null ? (
          <span className="inline-flex shrink-0 items-center gap-1.5" title={`Thread ${status ?? ""}`}>
            <ThreadStatusDot thread={thread} />
            {loud ? <span>{status}</span> : null}
          </span>
        ) : (
          <span className="size-2 shrink-0 rounded-full border border-border" title="No thread yet" />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {ticket.children.total > 0 ? <SubtaskProgress ticket={ticket} /> : null}
          {review !== null && review.status !== "completed" ? <ReviewBadge ticket={ticket} /> : null}
          {review !== null && review.status === "completed" && review.apply !== null && review.apply.completedAt !== null ? (
            <Badge tone="success" title={`Review fixes ${review.apply.push ? "pushed" : "committed"} as ${shortSha(review.apply.pushedCommit)}`}>applied</Badge>
          ) : review !== null && review.status === "completed" && findings !== null ? (
            <Badge
              tone={review.counts!.critical > 0 ? "danger" : review.counts!.important > 0 ? "warning" : "neutral"}
              title={`${review.counts!.critical} critical, ${review.counts!.important} important, ${review.counts!.minor} minor · ${review.selectedCount ?? 0} selected to apply`}
            >
              <Icon name="kanban-search-check" className="size-3" />
              {findings}
            </Badge>
          ) : null}
          {ticket.comments !== null && ticket.comments.open > 0 ? (
            <Badge tone="warning" title={`${ticket.comments.open} PR comment(s) not yet addressed`}>
              <Icon name="MessageSquare" className="size-3" />
              {ticket.comments.open}
            </Badge>
          ) : null}
          {ticket.pendingDiffComments > 0 ? (
            <Badge tone="warning" title={`${ticket.pendingDiffComments} diff comment(s) waiting to be submitted`}>
              <Icon name="kanban-diff" className="size-3" />
              {ticket.pendingDiffComments}
            </Badge>
          ) : null}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {ticket.pr !== null ? (
            <button
              type="button"
              aria-label={review === null ? "Review PR" : "Open PR review"}
              title={review === null ? "Run the code-review skill on this PR" : "Open the PR review"}
              className={iconButton}
              onClick={(event) => {
                event.stopPropagation();
                if (review === null) onReview();
                else onOpenReview();
              }}
            >
              <Icon name="kanban-search-check" className="size-3.5" />
            </button>
          ) : null}
          {ticket.pr !== null || ticket.threadId !== null ? (
            <button
              type="button"
              aria-label="View changes"
              title="View changes"
              className={iconButton}
              onClick={(event) => {
                event.stopPropagation();
                onOpenDiff();
              }}
            >
              <Icon name="kanban-diff" className="size-3.5" />
            </button>
          ) : null}
          {ticket.threadId !== null ? (
            <button
              type="button"
              aria-label="Open thread"
              title="Open thread"
              className={iconButton}
              onClick={(event) => {
                event.stopPropagation();
                onOpenThread();
              }}
            >
              <Icon name="MessageSquare" className="size-3.5" />
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

interface DropTarget {
  columnId: string;
  index: number;
}

function ColumnView({
  column,
  tickets,
  threads,
  hiddenTags,
  draggingId,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onOpen,
  onOpenThread,
  onReview,
  onOpenDiff,
  onAdd,
}: {
  column: Column;
  tickets: Ticket[];
  threads: ReadonlyMap<string, PluginSidebarThread>;
  hiddenTags: ReadonlySet<string>;
  draggingId: string | null;
  dropTarget: DropTarget | null;
  onDragStart: (ticketId: string, event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (target: DropTarget, event: DragEvent<HTMLElement>) => void;
  onDrop: (target: DropTarget, event: DragEvent<HTMLElement>) => void;
  onOpen: (ticket: Ticket) => void;
  onOpenThread: (threadId: string) => void;
  onReview: (ticket: Ticket) => void;
  onOpenDiff: (ticket: Ticket) => void;
  onAdd: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const indexFromPointer = (event: DragEvent<HTMLElement>): number => {
    const list = listRef.current;
    if (list === null) return tickets.length;
    const cards = Array.from(list.querySelectorAll<HTMLElement>("[data-ticket-id]"));
    let index = 0;
    for (const card of cards) {
      if (card.dataset.ticketId === draggingId) continue;
      const rect = card.getBoundingClientRect();
      if (event.clientY > rect.top + rect.height / 2) index += 1;
    }
    return index;
  };
  const isTarget = dropTarget?.columnId === column.id;
  return (
    <section
      aria-label={column.name}
      onDragOver={(event) => onDragOver({ columnId: column.id, index: indexFromPointer(event) }, event)}
      onDrop={(event) => onDrop({ columnId: column.id, index: indexFromPointer(event) }, event)}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/30",
        isTarget && draggingId !== null && "border-primary/50 bg-primary/5",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{column.name}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{tickets.length}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          aria-label={`Add card to ${column.name}`}
          onClick={onAdd}
        >
          <Icon name="Plus" className="size-3.5" />
        </Button>
      </header>
      <div ref={listRef} className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tickets.map((ticket, index) => (
          <div key={ticket.id} className="flex flex-col gap-2">
            {isTarget && dropTarget.index === index && draggingId !== ticket.id ? (
              <div className="h-0.5 rounded bg-primary" />
            ) : null}
            <CardView
              ticket={ticket}
              thread={ticket.threadId === null ? null : threads.get(ticket.threadId)}
              hiddenTags={hiddenTags}
              isDragging={draggingId === ticket.id}
              onOpen={() => onOpen(ticket)}
              onOpenThread={() => {
                if (ticket.threadId !== null) onOpenThread(ticket.threadId);
              }}
              onOpenReview={() => {
                if (ticket.reviewThreadId !== null) onOpenThread(ticket.reviewThreadId);
              }}
              onReview={() => onReview(ticket)}
              onOpenDiff={() => onOpenDiff(ticket)}
              onDragStart={(event) => onDragStart(ticket.id, event)}
              onDragEnd={onDragEnd}
            />
          </div>
        ))}
        {isTarget && dropTarget.index >= tickets.length ? <div className="h-0.5 rounded bg-primary" /> : null}
        {tickets.length === 0 && !isTarget ? (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">Drop cards here</p>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** Records microphone audio and transcribes it with bb's voice service. */
function useDictation(onText: (text: string) => void) {
  const sdk = useSdk();
  const [state, setState] = useState<"idle" | "recording" | "transcribing" | "unsupported">(() =>
    typeof navigator === "undefined" || navigator.mediaDevices === undefined || typeof MediaRecorder === "undefined" ? "unsupported" : "idle",
  );
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const media = new MediaRecorder(stream, mime === undefined ? undefined : { mimeType: mime });
      chunks.current = [];
      media.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      media.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks.current, { type: media.mimeType || "audio/webm" });
        if (blob.size === 0) {
          setState("idle");
          return;
        }
        setState("transcribing");
        try {
          const result = await sdk.system.transcribeVoice({ file: blob, prompt: "Software tasks, tickets, pull requests, code names." });
          const text = (result as { text?: string; transcript?: string }).text ?? (result as { transcript?: string }).transcript ?? "";
          if (text.trim() !== "") onText(text.trim());
        } catch (cause) {
          toast.error(`Transcription failed: ${errorMessage(cause)}`);
        } finally {
          setState("idle");
        }
      };
      recorder.current = media;
      media.start();
      setState("recording");
    } catch (cause) {
      toast.error(`Microphone unavailable: ${errorMessage(cause)}`);
      setState("idle");
    }
  };
  const stop = () => recorder.current?.stop();
  useEffect(() => () => recorder.current?.stream.getTracks().forEach((track) => track.stop()), []);
  return { state, start, stop };
}

function NewTicketDialog({
  open,
  onOpenChange,
  columns,
  initialColumnId,
  projects,
  rpc,
  onCreated,
  onOpenProposals,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: Column[];
  initialColumnId: string | null;
  projects: ProjectOption[];
  rpc: Rpc;
  onCreated: () => void;
  onOpenProposals: () => void;
}) {
  const [mode, setMode] = useState<"single" | "dump">("single");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [columnId, setColumnId] = useState(initialColumnId ?? columns[0]?.id ?? "");
  const [projectId, setProjectId] = useState("");
  const [startThread, setStartThread] = useState(true);
  const [pending, setPending] = useState(false);
  const [dump, setDump] = useState("");
  const [dumpProject, setDumpProject] = useState("");
  const dictation = useDictation((text) => setDump((current) => (current.trim() === "" ? text : `${current.trimEnd()}\n\n${text}`)));
  useEffect(() => {
    if (open) {
      setColumnId(initialColumnId ?? columns[0]?.id ?? "");
      if (dumpProject === "" && projects[0] !== undefined) setDumpProject(projects[0].id);
    }
  }, [open, initialColumnId, columns, projects, dumpProject]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim() === "" || pending) return;
    setPending(true);
    const parsed = parseQuickAdd(title);
    const extraTags = parseQuickAdd(tags.split(/[\s,]+/u).filter(Boolean).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")).tags;
    try {
      await rpc.call("ticket_create", {
        title: parsed.title,
        description,
        columnId,
        tags: [...new Set([...parsed.tags, ...extraTags])],
        projectId: projectId === "" ? null : projectId,
        startThread: projectId !== "" && startThread,
      });
      setTitle("");
      setDescription("");
      setTags("");
      onOpenChange(false);
      onCreated();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const submitDump = async () => {
    if (dump.trim() === "" || dumpProject === "" || pending) return;
    setPending(true);
    try {
      await rpc.call("dump_create", { text: dump.trim(), projectId: dumpProject });
      setDump("");
      onOpenChange(false);
      onCreated();
      toast.success("Planning in the background. Check Proposals when it is done.");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="sr-only">New card</DialogTitle>
          <DialogDescription className="sr-only">Create one card, or dictate a brain dump to be planned into several.</DialogDescription>
          <div role="tablist" aria-label="Mode" className="flex w-fit rounded-md border border-border p-0.5">
            {(["single", "dump"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={mode === entry}
                onClick={() => setMode(entry)}
                className={cn("rounded px-2.5 py-1 text-xs font-medium", mode === entry ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {entry === "single" ? "One card" : "Brain dump"}
              </button>
            ))}
          </div>
        </DialogHeader>
        {mode === "single" ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title (use #tag for tags)" aria-label="Title" />
            <Textarea aria-label="Description" value={description} onChange={setDescription} placeholder="What needs to happen? (markdown, sent to the agent as the first prompt)" />
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Tags, comma or space separated" aria-label="Tags" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Column
                <Select aria-label="Column" value={columnId} onChange={setColumnId}>
                  {columns.map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Project
                <ProjectSelect projects={projects} value={projectId} onChange={setProjectId} allowNone />
              </label>
            </div>
            <label className={cn("flex items-center gap-2 text-sm", projectId === "" && "pointer-events-none opacity-50")}>
              <Checkbox checked={startThread} onCheckedChange={(checked) => setStartThread(checked === true)} aria-label="Start a thread now" />
              Start a thread now
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || parseQuickAdd(title).title === ""}>
                Create
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Ramble about everything that needs doing. An agent reads the project, splits it into proposed cards with open questions, and you review the result under Proposals when it is ready.
            </p>
            <div className="relative">
              <textarea
                autoFocus
                value={dump}
                rows={9}
                onChange={(event) => setDump(event.target.value)}
                placeholder="e.g. We need to move the HSS provisioning to the new sim service, the frontends still show deactivated lines, also someone should look at why the kafka consumer drops…"
                aria-label="Brain dump"
                className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 pr-12 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {dictation.state !== "unsupported" ? (
                <button
                  type="button"
                  aria-label={dictation.state === "recording" ? "Stop dictating" : "Dictate"}
                  title={dictation.state === "recording" ? "Stop dictating" : "Dictate with your microphone"}
                  disabled={dictation.state === "transcribing"}
                  onClick={() => (dictation.state === "recording" ? dictation.stop() : void dictation.start())}
                  className={cn(
                    "absolute right-2 top-2 flex size-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:text-foreground",
                    dictation.state === "recording" && "animate-pulse border-destructive bg-destructive/10 text-destructive",
                    dictation.state === "transcribing" && "opacity-60",
                  )}
                >
                  <Icon name={dictation.state === "transcribing" ? "kanban-refresh" : "Mic"} className={cn("size-4", dictation.state === "transcribing" && "animate-spin")} />
                </button>
              ) : null}
            </div>
            {dictation.state === "recording" ? <p className="text-xs text-destructive">Recording… press the mic again to stop and transcribe.</p> : null}
            {dictation.state === "transcribing" ? <p className="text-xs text-muted-foreground">Transcribing…</p> : null}
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Project the agent should read while planning
              <ProjectSelect projects={projects} value={dumpProject} onChange={setDumpProject} allowNone={false} />
            </label>
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" className="text-muted-foreground" onClick={onOpenProposals}>
                View proposals
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="button" disabled={pending || dump.trim() === "" || dumpProject === "" || dictation.state !== "idle"} onClick={() => void submitDump()}>
                  <Icon name="kanban-search-check" className="size-4" />
                  Plan tickets in background
                </Button>
              </div>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TicketDetails({
  ticket,
  columns,
  projects,
  thread,
  threads,
  allTags,
  rpc,
  onClose,
  onChanged,
  onOpenThread,
  onOpenDiff,
  tickets,
  onOpenTicket,
}: {
  ticket: Ticket;
  columns: Column[];
  projects: ProjectOption[];
  thread: PluginSidebarThread | null | undefined;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  allTags: readonly string[];
  rpc: Rpc;
  onClose: () => void;
  onChanged: () => void;
  onOpenThread: (threadId: string) => void;
  onOpenDiff: (ticketId: string) => void;
  tickets: readonly Ticket[];
  onOpenTicket: (ticketId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setTitle(ticket.title);
    setDescription(ticket.description);
    setProjectId(ticket.projectId ?? projects[0]?.id ?? "");
    setConfirmDelete(false);
    // Reset the form only when a different card is shown or its stored text changes.
  }, [ticket.id, ticket.title, ticket.description, ticket.projectId, projects]);

  const run = async (action: () => Promise<unknown>, successMessage?: string) => {
    setPending(true);
    try {
      await action();
      onChanged();
      if (successMessage !== undefined) toast.success(successMessage);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  // Title and description save when the field loses focus, like the other controls apply immediately.
  const saveText = () => {
    const nextTitle = title.trim() === "" ? ticket.title : title.trim();
    if (nextTitle === ticket.title && description === ticket.description) return;
    void run(() => rpc.call("ticket_update", { id: ticket.id, title: nextTitle, description }));
  };
  const kindLabel = ticket.pr !== null ? "Pull request" : ticket.jira !== null ? "Jira issue" : "Card";
  const columnName = columns.find((column) => column.id === ticket.columnId)?.name ?? ticket.columnId;
  const externalUrl = ticket.pr?.url ?? ticket.jira?.url ?? null;
  const parent = ticket.parentId === null ? null : (tickets.find((entry) => entry.id === ticket.parentId) ?? null);
  // Candidates to nest under: anything except this card and its own descendants.
  const descendants = new Set<string>();
  const collect = (id: string) => {
    for (const entry of tickets) {
      if (entry.parentId === id && !descendants.has(entry.id)) {
        descendants.add(entry.id);
        collect(entry.id);
      }
    }
  };
  collect(ticket.id);
  const parentOptions = tickets.filter((entry) => entry.id !== ticket.id && !descendants.has(entry.id));
  const externalLabel = ticket.pr !== null ? "GitHub" : "Jira";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveText}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
          aria-label="Title"
          readOnly={ticket.kind !== "adhoc"}
          className="-mx-1 w-full rounded bg-transparent px-1 text-base font-semibold leading-6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {parent !== null ? (
          <button type="button" className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => onOpenTicket(parent.id)}>
            <Icon name="ChevronUp" className="size-3" />
            <span className="truncate">{parent.title}</span>
          </button>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {parent !== null ? "Subtask" : kindLabel} · <code>{ticket.id}</code> · {columnName}
          {ticket.pr !== null ? ` · ${ticket.pr.repo.split("/")[1]}#${ticket.pr.number} · ${ticket.pr.state}` : ""}
          {ticket.jira !== null ? ` · ${ticket.jira.key} · ${ticket.jira.status || "unknown"}` : ""}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-1.5">
        {ticket.threadId !== null ? (
          <Button type="button" variant="outline" className={COMPACT} onClick={() => onOpenThread(ticket.threadId!)}>
            <ThreadStatusDot thread={thread} />
            Open thread
          </Button>
        ) : null}
        {ticket.pr !== null || ticket.threadId !== null ? (
          <Button type="button" variant="outline" className={COMPACT} onClick={() => onOpenDiff(ticket.id)}>
            <Icon name="kanban-diff" className="size-3.5" />
            View changes
            {ticket.pendingDiffComments > 0 ? <Badge tone="warning">{ticket.pendingDiffComments}</Badge> : null}
          </Button>
        ) : null}
        {externalUrl !== null ? (
          <Button variant="outline" className={COMPACT} asChild>
            <a href={externalUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="ExternalLink" className="size-3.5" />
              Open on {externalLabel}
            </a>
          </Button>
        ) : null}
      </div>

      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
        <Property label="Column">
          <Select
            aria-label="Column"
            value={ticket.columnId}
            className="h-7 w-auto"
            onChange={(columnId) => void run(() => rpc.call("ticket_move", { id: ticket.id, columnId, index: null }))}
          >
            {columns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name}
              </option>
            ))}
          </Select>
        </Property>
        <Property label="Tags">
          <TagEditor ticket={ticket} rpc={rpc} run={run} suggestions={allTags} />
        </Property>
        <Property label="Parent">
          <Select
            aria-label="Parent card"
            value={ticket.parentId ?? ""}
            className="h-7 w-auto max-w-full"
            onChange={(value) => void run(() => rpc.call("ticket_set_parent", { id: ticket.id, parentId: value === "" ? null : value }))}
          >
            <option value="">None (top-level)</option>
            {parentOptions.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title.length > 60 ? `${entry.title.slice(0, 60)}…` : entry.title}
              </option>
            ))}
          </Select>
        </Property>
        <Property label="Thread">
          {ticket.threadId !== null ? (
            <button
              type="button"
              onClick={() => onOpenThread(ticket.threadId!)}
              className="flex max-w-full items-center gap-1.5 text-left text-sm hover:underline"
            >
              <span className="truncate">{thread?.displayTitle ?? "Thread"}</span>
              <span className="shrink-0 text-xs text-muted-foreground">· {threadStatusText(thread)}</span>
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <ProjectSelect projects={projects} value={projectId} onChange={setProjectId} allowNone={false} className="h-7 w-auto max-w-48" />
              <Button
                type="button"
                variant="secondary"
                className={COMPACT}
                disabled={pending || projectId === ""}
                onClick={() => void run(() => rpc.call("ticket_start_thread", { id: ticket.id, projectId }), "Thread started")}
              >
                <Icon name="Play" className="size-3.5" />
                Start
              </Button>
            </div>
          )}
        </Property>
        {ticket.pr !== null ? (
          <Property label="Author">
            <span>{ticket.pr.author || "unknown"}</span>
            {ticket.pr.role === "authored" ? <span className="text-xs text-muted-foreground"> (you)</span> : null}
          </Property>
        ) : null}
        {ticket.jira !== null ? (
          <>
            <Property label="Type">{ticket.jira.issueType || "issue"}</Property>
            {ticket.jira.priority !== null ? <Property label="Priority">{ticket.jira.priority}</Property> : null}
            {ticket.jira.assignee !== null ? <Property label="Assignee">{ticket.jira.assignee}</Property> : null}
          </>
        ) : null}
      </dl>

      <SubtasksGroup ticket={ticket} tickets={tickets} columns={columns} threads={threads} rpc={rpc} pending={pending} run={run} onOpenTicket={onOpenTicket} onOpenThread={onOpenThread} />

      {ticket.pr !== null || ticket.threadId !== null ? <ChangesGroup ticket={ticket} rpc={rpc} onOpenDiff={onOpenDiff} /> : null}

      {ticket.pr !== null ? (
        <ReviewPanel
          ticket={ticket}
          threads={threads}
          rpc={rpc}
          pending={pending}
          canReview={ticket.projectId !== null}
          run={run}
          onOpenThread={onOpenThread}
        />
      ) : null}

      {ticket.pr !== null ? (
        <CommentsPanel
          ticket={ticket}
          threads={threads}
          rpc={rpc}
          pending={pending}
          canApply={ticket.projectId !== null}
          run={run}
          onOpenThread={onOpenThread}
        />
      ) : null}

      <Group
        title={ticket.kind === "adhoc" ? "Description" : "Notes"}
        summary={description.trim() === "" ? <span className="text-xs text-muted-foreground">empty</span> : undefined}
        defaultOpen={ticket.kind === "adhoc" || ticket.description.trim() !== ""}
      >
        <textarea
          aria-label={ticket.kind === "adhoc" ? "Description" : "Notes"}
          value={description}
          rows={ticket.kind === "adhoc" ? 6 : 3}
          placeholder={ticket.kind === "adhoc" ? "What needs to happen? Sent to the agent as its first prompt." : "Your notes about this item (not synced anywhere)."}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={saveText}
          className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </Group>

      <footer className="flex items-center justify-between gap-2 pt-1">
        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Delete this card? Threads are kept.</span>
            <Button
              type="button"
              variant="destructive"
              className={COMPACT}
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await rpc.call("ticket_delete", { id: ticket.id });
                  onClose();
                }, "Card deleted")
              }
            >
              Delete
            </Button>
            <Button type="button" variant="ghost" className={COMPACT} onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <Button type="button" variant="ghost" className={cn(COMPACT, "text-muted-foreground hover:text-destructive")} onClick={() => setConfirmDelete(true)}>
            <Icon name="Trash2" className="size-3.5" />
            Delete
          </Button>
        )}
        <Button type="button" variant="ghost" className={COMPACT} onClick={onClose}>
          Close
        </Button>
      </footer>
    </div>
  );
}

type TicketDetailsProps = Parameters<typeof TicketDetails>[0];

/** Fallback for surfaces without a right panel (compact viewports). */
function TicketDialog(props: Omit<TicketDetailsProps, "ticket"> & { ticket: Ticket | null }) {
  if (props.ticket === null) return null;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="sr-only">Card {props.ticket.id}</DialogTitle>
          <DialogDescription className="sr-only">Edit the card, move it, or open its thread.</DialogDescription>
        </DialogHeader>
        <TicketDetails {...props} ticket={props.ticket} />
      </DialogContent>
    </Dialog>
  );
}

/** Right-panel tab: shows the card targeted from the board or todo list. */
function TicketTab() {
  const target = useFixedTabTarget(TICKET_TAB);
  const { rpc, board, refetch } = useBoard();
  const projects = useProjects();
  const threads = useThreadIndex();
  const actions = useSidebarThreadActions();
  const navigate = useBbNavigate();
  const appPanel = useAppPanel();
  const ticket = target === null ? null : (board?.tickets.find((entry) => entry.id === target.target.ticketId) ?? null);
  // Escape clears the card like closing a dialog would. Radix dialogs (new card, columns, sources)
  // take precedence: while one is open, Escape belongs to it.
  useEffect(() => {
    if (target === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"]') !== null) return;
      event.preventDefault();
      target.clear();
      collapseRightPanel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [target]);
  if (target === null || ticket === null) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        {board === null ? "Loading…" : target === null ? "Select a card to see its details here." : "This card no longer exists."}
      </p>
    );
  }
  const detailProps = {
    columns: board!.columns,
    projects,
    thread: ticket.threadId === null ? null : threads.get(ticket.threadId),
    threads,
    allTags: board!.tags,
    rpc,
    onChanged: refetch,
    onOpenThread: (threadId: string) => actions.open(threadId),
    onOpenDiff: (ticketId: string) => navigate.toPluginPanel("board", { subPath: `diff/${ticketId}` }),
    tickets: board!.tickets,
    onOpenTicket: (ticketId: string) => appPanel.openFixedTab({ surface: { kind: "current" }, tab: TICKET_TAB, target: { ticketId } }),
  };
  return (
    <TicketDetails
      {...detailProps}
      ticket={ticket}
      onClose={() => {
        target.clear();
        collapseRightPanel();
      }}
    />
  );
}

function ColumnsDialog({
  open,
  onOpenChange,
  columns,
  rpc,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: Column[];
  rpc: Rpc;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Column[]>(columns);
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (open) setDraft(columns);
  }, [open, columns]);
  const slug = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || `col-${draft.length + 1}`;
  const move = (index: number, delta: number) => {
    const next = [...draft];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setDraft(next);
  };
  const save = async () => {
    setPending(true);
    try {
      await rpc.call("columns_set", { columns: draft });
      onOpenChange(false);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Columns</DialogTitle>
          <DialogDescription>
            Cards in a removed column move to the first column. Agents refer to columns by id.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {draft.map((column, index) => (
            <li key={column.id} className="flex items-center gap-2">
              <Input
                value={column.name}
                aria-label={`Name of column ${column.id}`}
                onChange={(event) =>
                  setDraft(draft.map((entry) => (entry.id === column.id ? { ...entry, name: event.target.value } : entry)))
                }
              />
              <code className="w-24 shrink-0 truncate text-xs text-muted-foreground">{column.id}</code>
              <Button variant="ghost" size="icon" className="size-7" aria-label="Move up" onClick={() => move(index, -1)}>
                <Icon name="ChevronUp" className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7" aria-label="Move down" onClick={() => move(index, 1)}>
                <Icon name="ChevronDown" className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label={`Remove column ${column.name}`}
                disabled={draft.length <= 1}
                onClick={() => setDraft(draft.filter((entry) => entry.id !== column.id))}
              >
                <Icon name="X" className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newName.trim();
            if (name === "") return;
            let id = slug(name);
            while (draft.some((column) => column.id === id)) id = `${id}-2`;
            setDraft([...draft, { id, name }]);
            setNewName("");
          }}
        >
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="New column name"
            aria-label="New column name"
          />
          <Button type="submit" variant="secondary" disabled={newName.trim() === "" || draft.length >= 12}>
            Add
          </Button>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending || draft.some((column) => column.name.trim() === "")} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SOURCE_KIND_LABELS: Record<SourceKind, string> = { "github-search": "GitHub search", "jira-jql": "Jira (JQL)" };

function newSource(kind: SourceKind, id: string): Source {
  const base = { id, name: kind === "jira-jql" ? "Jira issues" : "GitHub search", tags: [], doneWhenGone: false, enabled: true, projectId: null };
  return kind === "jira-jql"
    ? { ...base, kind, jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC" }
    : { ...base, kind, query: "" };
}

function sourceQuery(source: Source): string {
  return source.kind === "github-search" ? source.query : source.jql;
}

function withQuery(source: Source, value: string): Source {
  return source.kind === "github-search" ? { ...source, query: value } : { ...source, jql: value };
}

function SourcesDialog({
  open,
  onOpenChange,
  sources,
  projects,
  jiraSite,
  rpc,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: Source[];
  projects: ProjectOption[];
  jiraSite: string | null;
  rpc: Rpc;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Source[]>(sources);
  const [newKind, setNewKind] = useState<SourceKind>("github-search");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (open) setDraft(sources);
  }, [open, sources]);
  const update = (id: string, patch: (source: Source) => Source) =>
    setDraft(draft.map((source) => (source.id === id ? patch(source) : source)));
  const slug = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || `source-${draft.length + 1}`;
  const save = async () => {
    setPending(true);
    try {
      await rpc.call("sources_set", {
        sources: draft.map((source) => ({
          ...source,
          tags: parseQuickAdd(source.tags.map((tag) => `#${tag}`).join(" ")).tags,
        })),
      });
      onOpenChange(false);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const hasJira = draft.some((source) => source.kind === "jira-jql");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Ticket sources</DialogTitle>
          <DialogDescription>
            Each source is a saved search; every result becomes a card carrying the source's tags. Saving runs a sync. The two
            defaults are ordinary sources you can edit or remove.
          </DialogDescription>
        </DialogHeader>
        {hasJira && jiraSite === null ? (
          <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            Jira sources need the Jira site URL, account email, and API token in the plugin settings (Settings → Installed plugins → Kanban).
          </p>
        ) : null}
        <ul className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
          {draft.map((source) => (
            <li key={source.id} className={cn("flex flex-col gap-3 rounded-md border border-border p-3", !source.enabled && "opacity-60")}>
              <div className="flex items-center gap-2">
                <span className="shrink-0">
                  <Badge tone="accent">{SOURCE_KIND_LABELS[source.kind]}</Badge>
                </span>
                <Input
                  value={source.name}
                  aria-label={`Name of source ${source.id}`}
                  placeholder="Source name"
                  className="h-8 min-w-0 flex-1 font-medium"
                  onChange={(event) => update(source.id, (entry) => ({ ...entry, name: event.target.value }))}
                />
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={source.enabled}
                    onCheckedChange={(checked) => update(source.id, (entry) => ({ ...entry, enabled: checked === true }))}
                    aria-label="Enabled"
                  />
                  Enabled
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove source ${source.name}`}
                  onClick={() => setDraft(draft.filter((entry) => entry.id !== source.id))}
                >
                  <Icon name="X" className="size-4" />
                </Button>
              </div>
              <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 text-sm">
                <dt className="pt-1.5 text-xs text-muted-foreground">{source.kind === "github-search" ? "GitHub query" : "JQL"}</dt>
                <dd>
                  <Input
                    value={sourceQuery(source)}
                    aria-label={`${source.kind === "github-search" ? "GitHub search query" : "JQL"} for ${source.name}`}
                    placeholder={
                      source.kind === "github-search"
                        ? "is:pr is:open author:@me archived:false"
                        : "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
                    }
                    className="h-8 font-mono text-xs"
                    onChange={(event) => update(source.id, (entry) => withQuery(entry, event.target.value))}
                  />
                </dd>
                <dt className="pt-1.5 text-xs text-muted-foreground">Tags</dt>
                <dd className="flex flex-wrap items-center gap-1">
                  <TagBadges tags={source.tags} onRemove={(tag) => update(source.id, (entry) => ({ ...entry, tags: entry.tags.filter((value) => value !== tag) }))} />
                  <input
                    placeholder={source.tags.length === 0 ? "Add tag and press Enter" : "+ tag"}
                    aria-label={`Add tag to ${source.name}`}
                    className="h-7 min-w-32 flex-1 rounded border border-dashed border-border bg-transparent px-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== ",") return;
                      event.preventDefault();
                      const input = event.target as HTMLInputElement;
                      const tags = parseQuickAdd(input.value.split(/[\s,]+/u).filter(Boolean).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")).tags;
                      if (tags.length === 0) return;
                      update(source.id, (entry) => ({ ...entry, tags: [...new Set([...entry.tags, ...tags])] }));
                      input.value = "";
                    }}
                  />
                </dd>
                <dt className="pt-1.5 text-xs text-muted-foreground">Threads run in</dt>
                <dd>
                  <Select
                    aria-label={`Project for ${source.name} threads`}
                    value={source.projectId ?? ""}
                    className="h-8"
                    onChange={(value) => update(source.id, (entry) => ({ ...entry, projectId: value === "" ? null : value }))}
                  >
                    <option value="">{source.kind === "github-search" ? "Project matching the repo's remote, else the fallback setting" : "The fallback project setting"}</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </Select>
                </dd>
                <dt className="pt-1.5 text-xs text-muted-foreground">When an item leaves this search</dt>
                <dd>
                  <Select
                    aria-label={`What happens when an item leaves ${source.name}`}
                    value={source.doneWhenGone ? "done" : "keep"}
                    className="h-8"
                    onChange={(value) => update(source.id, (entry) => ({ ...entry, doneWhenGone: value === "done" }))}
                  >
                    <option value="keep">Keep the card where it is</option>
                    <option value="done">Move the card to Done</option>
                  </Select>
                </dd>
              </dl>
              <p className="text-[11px] text-muted-foreground">
                Source id <code>{source.id}</code> is fixed at creation; cards remember which source made them by this id, and <code>bb kanban sources</code> lists it.
              </p>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Add</span>
          <Select aria-label="New source type" value={newKind} onChange={(value) => setNewKind(value as SourceKind)} className="h-8 max-w-48">
            {(Object.keys(SOURCE_KIND_LABELS) as SourceKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {SOURCE_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            disabled={draft.length >= 20}
            onClick={() => {
              let id = slug(`${newKind === "jira-jql" ? "jira" : "github"} ${draft.length + 1}`);
              while (draft.some((source) => source.id === id)) id = `${id}-2`;
              setDraft([...draft, newSource(newKind, id)]);
            }}
          >
            <Icon name="Plus" className="size-4" />
            Add source
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || draft.some((source) => source.name.trim() === "" || sourceQuery(source).trim() === "")}
            onClick={() => void save()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Todo (list) view
// ---------------------------------------------------------------------------

function TodoView({
  board,
  threads,
  rpc,
  onOpen,
  onOpenThread,
  refetch,
}: {
  board: Board;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  rpc: Rpc;
  onOpen: (ticket: Ticket) => void;
  onOpenThread: (threadId: string) => void;
  refetch: () => void;
}) {
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [quick, setQuick] = useState("");
  const doneId = board.columns.find((column) => column.id === "done")?.id ?? board.columns.at(-1)?.id ?? null;
  const todoId = board.columns.find((column) => column.id === "todo")?.id ?? board.columns[0]?.id ?? null;
  const matches = (ticket: Ticket) => (showDone || ticket.columnId !== doneId) && tagFilter.every((tag) => ticket.tags.includes(tag));
  const byId = new Map(board.tickets.map((ticket) => [ticket.id, ticket]));
  // A subtask shows under its parent when the parent is listed; otherwise it stands on its own.
  const visible = board.tickets
    .filter((ticket) => matches(ticket) && (ticket.parentId === null || !byId.has(ticket.parentId) || !matches(byId.get(ticket.parentId)!)))
    .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  const childrenOf = (id: string) => board.tickets.filter((ticket) => ticket.parentId === id && matches(ticket)).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  const byColumn = board.columns
    .map((column) => ({ column, tickets: visible.filter((ticket) => ticket.columnId === column.id) }))
    .filter((group) => group.tickets.length > 0);
  const toggleDone = async (ticket: Ticket) => {
    const target = ticket.columnId === doneId ? todoId : doneId;
    if (target === null) return;
    try {
      await rpc.call("ticket_move", { id: ticket.id, columnId: target, index: null });
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
    refetch();
  };
  const quickAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { title, tags } = parseQuickAdd(quick);
    if (title === "" || todoId === null) return;
    try {
      await rpc.call("ticket_create", { title, tags: [...new Set([...tags, ...tagFilter])], columnId: todoId });
      setQuick("");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
    refetch();
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-5">
      <form onSubmit={quickAdd} className="flex items-center gap-2">
        <Input
          value={quick}
          onChange={(event) => setQuick(event.target.value)}
          placeholder="Add a todo… use #tag for tags"
          aria-label="New todo"
        />
        <Button type="submit" disabled={parseQuickAdd(quick).title === ""}>
          <Icon name="Plus" className="size-4" />
          Add
        </Button>
      </form>
      {board.tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {board.tags.map((tag) => {
            const active = tagFilter.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={active}
                onClick={() => setTagFilter(active ? tagFilter.filter((entry) => entry !== tag) : [...tagFilter, tag])}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs",
                  active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                #{tag}
              </button>
            );
          })}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={showDone} onCheckedChange={(checked) => setShowDone(checked === true)} aria-label="Show done" />
            Show done
          </label>
        </div>
      ) : null}
      {byColumn.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing to do{tagFilter.length > 0 ? " with these tags" : ""}.
        </p>
      ) : null}
      {byColumn.map(({ column, tickets }) => (
        <section key={column.id} aria-label={column.name}>
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {column.name} <span className="font-normal tabular-nums">{tickets.length}</span>
          </h2>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {tickets.flatMap((ticket) => [ticket, ...childrenOf(ticket.id)]).map((ticket) => (
              <li key={ticket.id} className={cn("flex items-center gap-3 px-3 py-2 text-sm", ticket.parentId !== null && "pl-9")}>
                <Checkbox
                  checked={ticket.columnId === doneId}
                  onCheckedChange={() => void toggleDone(ticket)}
                  aria-label={ticket.columnId === doneId ? `Reopen "${ticket.title}"` : `Mark "${ticket.title}" done`}
                />
                <button
                  type="button"
                  onClick={() => onOpen(ticket)}
                  className={cn("min-w-0 flex-1 truncate text-left hover:underline", ticket.columnId === doneId && "text-muted-foreground line-through")}
                >
                  {ticket.title}
                </button>
                <div className="hidden flex-wrap items-center gap-1 sm:flex">
                  <PrBadges ticket={ticket} />
        <JiraBadges ticket={ticket} />
                  <TagBadges tags={ticket.tags} />
                  <ReviewBadge ticket={ticket} />
                  {ticket.latestReview?.status === "completed" ? <ReviewScoreBadges scores={ticket.latestReview.scores} compact /> : null}
                </div>
                {ticket.threadId !== null ? (
                  <button
                    type="button"
                    aria-label="Open thread"
                    onClick={() => onOpenThread(ticket.threadId!)}
                    className="flex shrink-0 items-center gap-1.5 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
                  >
                    <ThreadStatusDot thread={threads.get(ticket.threadId)} />
                    <Icon name="MessageSquare" className="size-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proposals (brain dump review)
// ---------------------------------------------------------------------------

function DumpStatusBadge({ dump }: { dump: Dump }) {
  switch (dump.status) {
    case "planning":
      return <Badge tone="accent">planning…</Badge>;
    case "ready":
      return <Badge tone="success">ready to review</Badge>;
    case "failed":
      return <Badge tone="danger">failed</Badge>;
    case "done":
      return <Badge>created</Badge>;
    default:
      return <Badge>discarded</Badge>;
  }
}

function ProposalsList({ onOpen }: { onOpen: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [dumps, setDumps] = useState<Dump[] | null>(null);
  const now = useNow();
  const load = useCallback(() => {
    rpc.call("dumps_list", { includeClosed: true }).then((result) => setDumps(result.dumps), (cause: unknown) => toast.error(errorMessage(cause)));
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(BOARD_CHANGED, load);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4 md:p-5">
      {dumps === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {dumps !== null && dumps.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No brain dumps yet. Use New card → Brain dump to dictate one.
        </p>
      ) : null}
      {dumps?.map((dump) => (
        <button key={dump.id} type="button" onClick={() => onOpen(dump.id)} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left hover:border-foreground/30">
          <div className="flex items-center gap-2">
            <DumpStatusBadge dump={dump} />
            {dump.proposal !== null ? (
              <span className="text-xs text-muted-foreground">
                {dump.proposal.tickets.length} ticket{dump.proposal.tickets.length === 1 ? "" : "s"}
                {dump.proposal.questions.length > 0 ? ` · ${dump.proposal.questions.length} question${dump.proposal.questions.length === 1 ? "" : "s"}` : ""}
              </span>
            ) : null}
            <span className="ml-auto text-xs text-muted-foreground">{relativeTime(dump.updatedAt, now)}</span>
          </div>
          <p className="line-clamp-2 text-sm">{dump.text}</p>
        </button>
      ))}
    </div>
  );
}

function ProposalView({ dumpId, columns, onBack, onOpenThread, onOpenTicket }: { dumpId: string; columns: Column[]; onBack: () => void; onOpenThread: (threadId: string) => void; onOpenTicket: (ticketId: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [dump, setDump] = useState<Dump | null>(null);
  const [drafts, setDrafts] = useState<Array<ProposedTicket & { include: boolean }>>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [columnId, setColumnId] = useState(columns.find((column) => column.id === "todo")?.id ?? columns[0]?.id ?? "");
  const [startThreads, setStartThreads] = useState(false);
  const [pending, setPending] = useState(false);
  const [showText, setShowText] = useState(false);
  const loadedProposal = useRef<string | null>(null);
  const load = useCallback(() => {
    rpc.call("dumps_list", { includeClosed: true }).then(
      (result) => setDump(result.dumps.find((entry) => entry.id === dumpId) ?? null),
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
  }, [rpc, dumpId]);
  useEffect(load, [load]);
  useRealtime(BOARD_CHANGED, load);
  // Seed editable drafts from each new proposal revision, keeping user edits between realtime refreshes.
  useEffect(() => {
    if (dump?.proposal === null || dump?.proposal === undefined) return;
    const key = JSON.stringify(dump.proposal);
    if (loadedProposal.current === key) return;
    loadedProposal.current = key;
    setDrafts(dump.proposal.tickets.map((ticket) => ({ ...ticket, include: true })));
    setAnswers(Object.fromEntries(dump.proposal.questions.map((question) => [question.id, dump.answers[question.id] ?? ""])));
  }, [dump]);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setPending(true);
    try {
      await action();
      if (success !== undefined) toast.success(success);
      load();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const updateDraft = (id: string, patch: Partial<ProposedTicket & { include: boolean }>) =>
    setDrafts((current) => current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  const included = drafts.filter((draft) => draft.include);

  if (dump === null) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading…{" "}
        <button type="button" className="underline" onClick={onBack}>
          Back
        </button>
      </div>
    );
  }
  const closed = dump.status === "done" || dump.status === "discarded";
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <DumpStatusBadge dump={dump} />
        {dump.threadId !== null ? (
          <Button type="button" variant="ghost" className={COMPACT} onClick={() => onOpenThread(dump.threadId!)}>
            <Icon name="MessageSquare" className="size-3.5" />
            Planning thread
          </Button>
        ) : null}
        <Button type="button" variant="ghost" className={COMPACT} onClick={() => setShowText((value) => !value)}>
          {showText ? "Hide dictation" : "Show dictation"}
        </Button>
        {!closed ? (
          <Button type="button" variant="ghost" className={cn(COMPACT, "ml-auto text-muted-foreground hover:text-destructive")} disabled={pending} onClick={() => void run(() => rpc.call("dump_discard", { id: dump.id }), "Discarded")}>
            <Icon name="Trash2" className="size-3.5" />
            Discard
          </Button>
        ) : null}
      </div>
      {showText ? <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs">{dump.text}</pre> : null}
      {dump.status === "planning" ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">The agent is reading the project and drafting tickets. This page updates when it finishes; you can leave.</p>
      ) : null}
      {dump.status === "failed" ? (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <p className="text-destructive">Planning did not produce a proposal.</p>
          {dump.error !== null ? <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{dump.error}</pre> : null}
          <div>
            <Button type="button" variant="secondary" className={COMPACT} disabled={pending || dump.threadId === null} onClick={() => void run(() => rpc.call("dump_refine", { id: dump.id, notes: "Please try again and make sure to end with the kanban-proposal block." }), "Asked the thread to retry")}>
              Ask it to try again
            </Button>
          </div>
        </div>
      ) : null}
      {dump.proposal !== null ? (
        <>
          {dump.proposal.summary !== "" ? <Markdown content={dump.proposal.summary} className="text-sm" /> : null}
          {dump.proposal.questions.length > 0 && !closed ? (
            <Group title={`Open questions (${dump.proposal.questions.length})`} defaultOpen>
              {dump.proposal.questions.map((question) => (
                <div key={question.id} className="flex flex-col gap-1 rounded-md border border-border p-2.5">
                  <div className="flex items-start gap-2 text-sm">
                    <Badge tone="warning">{question.id}</Badge>
                    <span className="min-w-0 flex-1 font-medium">{question.question}</span>
                  </div>
                  {question.why !== "" ? <p className="text-xs text-muted-foreground">{question.why}</p> : null}
                  {question.affects.length > 0 ? <p className="text-xs text-muted-foreground">Affects: {question.affects.join(", ")}</p> : null}
                  {question.options.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {question.options.map((option) => (
                        <button key={option} type="button" className={cn("rounded-full border px-2 py-0.5 text-xs", answers[question.id] === option ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}>
                          {option}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <Input value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="Your answer…" aria-label={`Answer to ${question.id}`} className="h-7 text-xs" />
                </div>
              ))}
              <textarea value={notes} rows={2} onChange={(event) => setNotes(event.target.value)} placeholder="Anything else to tell the planner (optional)" aria-label="Notes for the planner" className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              <div>
                <Button type="button" variant="secondary" className={COMPACT} disabled={pending || dump.status === "planning"} onClick={() => void run(() => rpc.call("dump_refine", { id: dump.id, answers, notes }), "Sent to the planner")}>
                  <Icon name="kanban-refresh" className="size-3.5" />
                  Send answers & refine
                </Button>
              </div>
            </Group>
          ) : null}
          <Group title={`Proposed tickets (${included.length}/${drafts.length})`} defaultOpen>
            <ul className="flex flex-col gap-2">
              {drafts.map((draft) => (
                <li key={draft.id} className={cn("flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5", !draft.include && "opacity-60")}>
                  <div className="flex items-start gap-2">
                    {!closed ? <Checkbox checked={draft.include} onCheckedChange={(checked) => updateDraft(draft.id, { include: checked === true })} aria-label={`Include ${draft.id}`} className="mt-1" /> : null}
                    <Badge>{draft.id}</Badge>
                    {closed ? (
                      <span className="min-w-0 flex-1 text-sm font-medium">{draft.title}</span>
                    ) : (
                      <input value={draft.title} onChange={(event) => updateDraft(draft.id, { title: event.target.value })} aria-label={`Title of ${draft.id}`} className="min-w-0 flex-1 rounded bg-transparent px-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                    )}
                    {draft.estimate !== null ? <Badge tone="outline">{draft.estimate}</Badge> : null}
                    {draft.dependsOn.length > 0 ? <Badge tone="outline" title="Depends on">after {draft.dependsOn.join(", ")}</Badge> : null}
                  </div>
                  {closed ? (
                    draft.description !== "" ? <Markdown content={draft.description} className="text-sm" /> : null
                  ) : (
                    <textarea value={draft.description} rows={3} onChange={(event) => updateDraft(draft.id, { description: event.target.value })} aria-label={`Description of ${draft.id}`} className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                  )}
                  <div className="flex flex-wrap items-center gap-1">
                    <TagBadges tags={draft.tags} onRemove={closed ? undefined : (tag) => updateDraft(draft.id, { tags: draft.tags.filter((entry) => entry !== tag) })} />
                    {!closed ? (
                      <input
                        placeholder="+ tag"
                        aria-label={`Add tag to ${draft.id}`}
                        className="h-6 w-20 bg-transparent px-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none"
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          const value = (event.target as HTMLInputElement).value.trim().toLowerCase();
                          if (value === "") return;
                          updateDraft(draft.id, { tags: [...new Set([...draft.tags, value])] });
                          (event.target as HTMLInputElement).value = "";
                        }}
                      />
                    ) : null}
                  </div>
                  {draft.subtasks.length > 0 ? (
                    <ul className="ml-4 list-disc text-xs text-muted-foreground">
                      {draft.subtasks.map((sub, index) => (
                        <li key={index} className="flex items-center gap-1">
                          <span className="flex-1">{sub.title}</span>
                          {!closed ? (
                            <button type="button" aria-label={`Remove subtask ${sub.title}`} className="text-muted-foreground hover:text-destructive" onClick={() => updateDraft(draft.id, { subtasks: draft.subtasks.filter((_, i) => i !== index) })}>
                              <Icon name="X" className="size-3" />
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
            {!closed ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Column
                  <Select aria-label="Column for new cards" value={columnId} onChange={setColumnId} className="h-7 w-auto">
                    {columns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox checked={startThreads} onCheckedChange={(checked) => setStartThreads(checked === true)} aria-label="Start a thread for each card" />
                  start a thread per card
                </label>
                <Button
                  type="button"
                  className={cn(COMPACT, "ml-auto")}
                  disabled={pending || included.length === 0 || dump.status === "planning"}
                  onClick={() =>
                    void run(
                      () => rpc.call("dump_finalize", { id: dump.id, tickets: included.map(({ include, ...ticket }) => ticket), columnId, startThreads }),
                      `Created ${included.length} card${included.length === 1 ? "" : "s"}`,
                    )
                  }
                >
                  <Icon name="Plus" className="size-3.5" />
                  Create {included.length} card{included.length === 1 ? "" : "s"}
                </Button>
              </div>
            ) : null}
            {dump.status === "done" && dump.createdTicketIds.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-xs text-muted-foreground">
                Created:
                {dump.createdTicketIds.map((id) => (
                  <button key={id} type="button" className="rounded border border-border px-1.5 py-0.5 font-mono hover:text-foreground" onClick={() => onOpenTicket(id)}>
                    {id}
                  </button>
                ))}
              </div>
            ) : null}
          </Group>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function syncSummary(board: Board, now: number): string {
  const { sync } = board;
  if (sync.lastSyncAt === null) return "Not synced yet";
  const prCount = board.tickets.filter((ticket) => ticket.kind === "pr").length;
  const jiraCount = board.tickets.filter((ticket) => ticket.kind === "jira").length;
  const parts = [`${prCount} PR${prCount === 1 ? "" : "s"}${sync.login !== null ? ` as @${sync.login}` : ""}`];
  if (jiraCount > 0) parts.push(`${jiraCount} Jira`);
  return `${parts.join(" · ")} · synced ${relativeTime(sync.lastSyncAt, now)}`;
}

const MENU_ITEM_CLASS =
  "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-state-hover";

function BoardSettingsMenu({
  board,
  syncing,
  onColumns,
  onSources,
  onSync,
}: {
  board: Board | null;
  syncing: boolean;
  onColumns: () => void;
  onSources: () => void;
  onSync: () => void;
}) {
  const now = useNow();
  const { showSubtasks } = usePageUi();
  const error = board?.sync.lastError ?? null;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" className="relative size-7" aria-label="Board settings">
          <Icon name="Settings" className={cn("size-4", syncing && "animate-spin")} />
          {error !== null ? (
            <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-destructive" />
          ) : null}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-56 max-w-80 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onColumns}>
            <Icon name="Columns2" className="size-4 text-muted-foreground" />
            Columns…
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onSources}>
            <Icon name="kanban-rss" className="size-4 text-muted-foreground" />
            Sources…
          </DropdownMenu.Item>
          <DropdownMenu.CheckboxItem
            className={cn(MENU_ITEM_CLASS, "pl-7")}
            checked={showSubtasks}
            onCheckedChange={(checked) => pageUi.set({ showSubtasks: checked === true })}
            onSelect={(event) => event.preventDefault()}
          >
            <DropdownMenu.ItemIndicator className="absolute left-2">
              <Icon name="Check" className="size-4" />
            </DropdownMenu.ItemIndicator>
            Show subtasks on the board
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item className={cn(MENU_ITEM_CLASS, "items-start")} disabled={syncing} onSelect={onSync}>
            <Icon name="kanban-refresh" className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", syncing && "animate-spin")} />
            <span className="flex min-w-0 flex-col">
              <span>{syncing ? "Syncing sources…" : "Sync sources now"}</span>
              {board !== null ? (
                <span className={cn("truncate text-xs", error !== null ? "text-destructive" : "text-muted-foreground")} title={error ?? undefined}>
                  {error ?? syncSummary(board, now)}
                </span>
              ) : null}
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function BoardPage({ subPath }: { subPath: string }) {
  const trimmed = subPath.replace(/^\/+|\/+$/gu, "");
  const diffTicketId = trimmed.startsWith("diff/") ? trimmed.slice("diff/".length) : null;
  const proposalId = trimmed.startsWith("proposals/") ? trimmed.slice("proposals/".length) : null;
  const proposalsList = trimmed === "proposals";
  const view: "board" | "todo" = trimmed === "todo" ? "todo" : "board";
  const navigate = useBbNavigate();
  const { rpc, board, setBoard, error, refetch } = useBoard();
  const projects = useProjects();
  const threads = useThreadIndex();
  const actions = useSidebarThreadActions();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const { dialog, newTicketColumn, showSubtasks } = usePageUi();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const ticketsByColumn = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const ticket of board?.tickets ?? []) {
      if (!showSubtasks && ticket.parentId !== null) continue;
      const list = map.get(ticket.columnId) ?? [];
      list.push(ticket);
      map.set(ticket.columnId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
    return map;
  }, [board, showSubtasks]);

  const selected = board?.tickets.find((ticket) => ticket.id === selectedId) ?? null;
  const sourceTags = useMemo(() => new Set((board?.sources ?? []).flatMap((source) => source.tags)), [board]);
  const appPanel = useAppPanel();
  const showTicket = (ticketId: string) => {
    const opened = appPanel.openFixedTab({ surface: { kind: "current" }, tab: TICKET_TAB, target: { ticketId } });
    if (!opened) setSelectedId(ticketId);
  };

  const openThread = (threadId: string) => {
    actions.open(threadId);
  };
  const openDiff = (ticketId: string) => navigate.toPluginPanel("board", { subPath: `diff/${ticketId}` });

  if (diffTicketId !== null) {
    return <DiffView ticketId={diffTicketId} onBack={() => navigate.toPluginPanel("board", { subPath: "" })} onOpenThread={openThread} />;
  }
  if (proposalsList) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <ProposalsList onOpen={(id) => navigate.toPluginPanel("board", { subPath: `proposals/${id}` })} />
      </div>
    );
  }
  if (proposalId !== null && board !== null) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <ProposalView dumpId={proposalId} columns={board.columns} onBack={() => navigate.toPluginPanel("board", { subPath: "proposals" })} onOpenThread={openThread} onOpenTicket={showTicket} />
      </div>
    );
  }

  const reviewPr = async (ticket: Ticket) => {
    if (ticket.projectId === null) {
      // No matched project: the card view has the project picker.
      showTicket(ticket.id);
      toast.message("Pick a project to run the review in");
      return;
    }
    try {
      const updated = await rpc.call("ticket_review_pr", { id: ticket.id, projectId: null });
      toast.success("Review started");
      if (updated.reviewThreadId !== null) openThread(updated.reviewThreadId);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
    refetch();
  };

  const onDrop = async (target: DropTarget, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const id = draggingId ?? event.dataTransfer.getData("text/plain");
    setDraggingId(null);
    setDropTarget(null);
    if (id === "" || board === null) return;
    const ticket = board.tickets.find((entry) => entry.id === id);
    if (ticket === undefined) return;
    // Optimistic reorder so the card lands where it was dropped before the server answers.
    const siblings = (ticketsByColumn.get(target.columnId) ?? []).filter((entry) => entry.id !== id);
    siblings.splice(Math.min(target.index, siblings.length), 0, { ...ticket, columnId: target.columnId });
    const positions = new Map(siblings.map((entry, index) => [entry.id, index + 1]));
    setBoard({
      ...board,
      tickets: board.tickets.map((entry) =>
        positions.has(entry.id)
          ? { ...entry, columnId: target.columnId, position: positions.get(entry.id)! }
          : entry,
      ),
    });
    try {
      await rpc.call("ticket_move", { id, columnId: target.columnId, index: target.index });
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
    refetch();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error !== null ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {view === "todo" && board !== null ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TodoView
            board={board}
            threads={threads}
            rpc={rpc}
            onOpen={(ticket) => showTicket(ticket.id)}
            onOpenThread={openThread}
            refetch={refetch}
          />
        </div>
      ) : null}
      <div
        className={cn("flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto p-4", view === "todo" && "hidden")}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropTarget(null);
        }}
      >
        {board === null && error === null ? (
          <p className="text-sm text-muted-foreground">Loading board…</p>
        ) : null}
        {board?.columns.map((column) => (
          <ColumnView
            key={column.id}
            column={column}
            tickets={ticketsByColumn.get(column.id) ?? []}
            threads={threads}
            hiddenTags={sourceTags}
            draggingId={draggingId}
            dropTarget={dropTarget}
            onDragStart={(ticketId, event) => {
              event.dataTransfer.setData("text/plain", ticketId);
              event.dataTransfer.effectAllowed = "move";
              setDraggingId(ticketId);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setDropTarget(null);
            }}
            onDragOver={(target, event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (dropTarget?.columnId !== target.columnId || dropTarget.index !== target.index) {
                setDropTarget(target);
              }
            }}
            onDrop={(target, event) => void onDrop(target, event)}
            onOpen={(ticket) => showTicket(ticket.id)}
            onOpenThread={openThread}
            onReview={(ticket) => void reviewPr(ticket)}
            onOpenDiff={(ticket) => openDiff(ticket.id)}
            onAdd={() => pageUi.set({ dialog: "new", newTicketColumn: column.id })}
          />
        ))}
      </div>
      {board !== null ? (
        <>
          <NewTicketDialog
            open={dialog === "new"}
            onOpenChange={(open) => pageUi.set({ dialog: open ? "new" : null })}
            columns={board.columns}
            initialColumnId={newTicketColumn}
            projects={projects}
            rpc={rpc}
            onCreated={refetch}
            onOpenProposals={() => {
              pageUi.set({ dialog: null });
              navigate.toPluginPanel("board", { subPath: "proposals" });
            }}
          />
          <ColumnsDialog
            open={dialog === "columns"}
            onOpenChange={(open) => pageUi.set({ dialog: open ? "columns" : null })}
            columns={board.columns}
            rpc={rpc}
            onChanged={refetch}
          />
          <SourcesDialog
            open={dialog === "sources"}
            onOpenChange={(open) => pageUi.set({ dialog: open ? "sources" : null })}
            sources={board.sources}
            projects={projects}
            jiraSite={board.sync.jiraSite}
            rpc={rpc}
            onChanged={refetch}
          />
          <TicketDialog
            ticket={selected}
            columns={board.columns}
            projects={projects}
            thread={selected?.threadId == null ? null : threads.get(selected.threadId)}
            threads={threads}
            allTags={board.tags}
            rpc={rpc}
            onOpenDiff={openDiff}
            tickets={board.tickets}
            onOpenTicket={showTicket}
            onClose={() => setSelectedId(null)}
            onChanged={refetch}
            onOpenThread={(threadId) => {
              setSelectedId(null);
              openThread(threadId);
            }}
          />
        </>
      ) : null}
    </div>
  );
}

/** Controls for the host title bar: board tools on the board, diff tools on a card's changes page. */
function BoardHeader({ subPath }: { subPath: string }) {
  const trimmed = subPath.replace(/^\/+|\/+$/gu, "");
  const diffTicketId = trimmed.startsWith("diff/") ? trimmed.slice("diff/".length) : null;
  const view: "board" | "todo" = trimmed === "todo" ? "todo" : "board";
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const { board, refetch } = useBoard();
  const ui = usePageUi();
  const [syncing, setSyncing] = useState(false);
  const syncNow = async () => {
    setSyncing(true);
    try {
      const status = await rpc.call("sync_now");
      if (status.lastError !== null) toast.error(status.lastError);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSyncing(false);
      refetch();
    }
  };

  const onProposals = trimmed === "proposals" || trimmed.startsWith("proposals/");
  if (onProposals) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Button type="button" variant="ghost" className={COMPACT} onClick={() => navigate.toPluginPanel("board", { subPath: trimmed === "proposals" ? "" : "proposals" })}>
          <Icon name="ChevronDown" className="size-3.5 rotate-90" />
          {trimmed === "proposals" ? "Board" : "Proposals"}
        </Button>
        <span className="text-xs text-muted-foreground">Brain dump proposals</span>
        <Button className={cn(COMPACT, "ml-1")} onClick={() => pageUi.set({ dialog: "new", newTicketColumn: null })}>
          <Icon name="Plus" className="size-3.5" />
          New card
        </Button>
      </div>
    );
  }
  if (diffTicketId !== null) {
    const ticket = board?.tickets.find((entry) => entry.id === diffTicketId) ?? null;
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Button type="button" variant="ghost" className={COMPACT} onClick={() => navigate.toPluginPanel("board", { subPath: "" })}>
          <Icon name="ChevronDown" className="size-3.5 rotate-90" />
          Board
        </Button>
        {ticket !== null ? (
          <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground md:inline-flex">
            <span className="truncate font-medium text-foreground">{ticket.title}</span>
            <span className="shrink-0">· {ticket.pr !== null ? `${ticket.pr.repo.split("/")[1]}#${ticket.pr.number}` : ticket.id}</span>
          </span>
        ) : null}
        <div role="tablist" aria-label="Diff engine" className="flex rounded-md border border-border p-0.5">
          {(["text", "structural"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={ui.diffMode === mode}
              title={mode === "structural" ? "Syntax-aware diff via difftastic" : "Line diff"}
              onClick={() => pageUi.set({ diffMode: mode })}
              className={cn("rounded px-2 py-0.5 text-xs", ui.diffMode === mode ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {mode === "text" ? "Text" : "Structural"}
            </button>
          ))}
        </div>
        <div role="tablist" aria-label="Diff layout" className={cn("flex rounded-md border border-border p-0.5", ui.diffMode === "structural" && "hidden")}>
          {(["unified", "split"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={ui.diffView === mode}
              onClick={() => pageUi.set({ diffView: mode })}
              className={cn("rounded px-2 py-0.5 text-xs", ui.diffView === mode ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {mode === "unified" ? "Unified" : "Split"}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          className={cn(COMPACT, "px-1.5")}
          disabled={ui.diffLoading}
          onClick={() => pageUi.set({ diffReloadNonce: ui.diffReloadNonce + 1 })}
          aria-label="Refresh diff"
        >
          <Icon name="kanban-refresh" className={cn("size-3.5", ui.diffLoading && "animate-spin")} />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <div role="tablist" aria-label="View" className="flex rounded-md border border-border p-0.5">
        {(["board", "todo"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={view === entry}
            onClick={() => navigate.toPluginPanel("board", { subPath: entry === "board" ? "" : "todo" })}
            className={cn("rounded px-2 py-0.5 text-xs font-medium", view === entry ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {entry === "board" ? "Board" : "Todo"}
          </button>
        ))}
      </div>
      <BoardSettingsMenu
        board={board}
        syncing={syncing || board?.sync.inProgress === true}
        onColumns={() => pageUi.set({ dialog: "columns" })}
        onSources={() => pageUi.set({ dialog: "sources" })}
        onSync={() => void syncNow()}
      />
      {board !== null && board.dumps.length > 0 ? (
        <Button type="button" variant="ghost" className={cn(COMPACT, "relative")} onClick={() => navigate.toPluginPanel("board", { subPath: "proposals" })} aria-label="Brain dump proposals">
          <Icon name="kanban-search-check" className={cn("size-3.5", board.dumps.some((dump) => dump.status === "planning") && "animate-pulse")} />
          Proposals
          {board.dumps.filter((dump) => dump.status === "ready").length > 0 ? (
            <Badge tone="success">{board.dumps.filter((dump) => dump.status === "ready").length}</Badge>
          ) : board.dumps.some((dump) => dump.status === "failed") ? (
            <Badge tone="danger">!</Badge>
          ) : null}
        </Button>
      ) : null}
      <Button className={COMPACT} onClick={() => pageUi.set({ dialog: "new", newTicketColumn: null })}>
        <Icon name="Plus" className="size-3.5" />
        New card
      </Button>
    </div>
  );
}

/** Live count of cards that are not done, shown beside the sidebar entry. */
function OpenCardCount() {
  const { board } = useBoard();
  if (board === null) return null;
  const doneId = board.columns.find((column) => column.id === "done")?.id ?? board.columns.at(-1)?.id;
  const open = board.tickets.filter((ticket) => ticket.columnId !== doneId).length;
  return open === 0 ? null : <span className="text-xs tabular-nums text-muted-foreground">{open}</span>;
}

function SettingsSection() {
  const { board } = useBoard();
  const sync = board?.sync ?? null;
  return (
    <div className="space-y-2 text-sm">
      <p>
        Cards come from the GitHub searches configured under Sources on the Kanban page (by default your open PRs
        tagged <code className="text-xs">#my-prs</code> and review requests tagged <code className="text-xs">#pr-reviews</code>).
      </p>
      {sync === null ? null : (
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            Token: {sync.tokenSource === "none" ? "none found" : sync.tokenSource === "setting" ? "plugin setting" : "gh CLI"}
          </li>
          <li>Signed in as: {sync.login ?? "unknown"}</li>
          <li>Jira: {sync.jiraSite ?? "not configured (site URL, email, and API token settings)"}</li>
          <li>Last sync: {sync.lastSyncAt === null ? "never" : new Date(sync.lastSyncAt).toLocaleString()}</li>
          {sync.lastError !== null ? <li className="text-destructive">{sync.lastError}</li> : null}
        </ul>
      )}
    </div>
  );
}

/** Lucide outlines the host does not ship; registered under plugin-prefixed names. */
const PLUGIN_ICONS: Record<string, string> = {
  "kanban-board": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>',
  "kanban-search-check": '<path d="m8 11 2 2 4-4"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  "kanban-wrench":
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  "kanban-refresh":
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  "kanban-rss": '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  "kanban-diff": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>',
  "kanban-ticket":
    '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
};

function pluginIcon(paths: string) {
  return function PluginIcon({ className }: { className?: string }) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={className}
        dangerouslySetInnerHTML={{ __html: paths }}
      />
    );
  };
}

export default definePluginApp((app) => {
  for (const [name, paths] of Object.entries(PLUGIN_ICONS)) {
    app.experimental_icons.register({ name, component: pluginIcon(paths) });
  }
  app.slots.navPanel({
    id: "board",
    title: "Kanban",
    icon: "kanban-board",
    path: "board",
    component: BoardPage,
    headerContent: BoardHeader,
    fixedTabs: [{ ...TICKET_TAB, title: "Card", icon: "PanelRight", component: TicketTab, layout: "padded" }],
    experimental_sidebarAccessory: OpenCardCount,
  });
  app.slots.settingsSection({
    id: "github-sync",
    title: "GitHub sync",
    description: "Where PR cards come from and how the plugin authenticates.",
    component: SettingsSection,
  });
});
