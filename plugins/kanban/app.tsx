// bb-plugin-kanban — frontend entry.
//
// A kanban board page in the sidebar. Every card is a ticket; most tickets are
// backed by a thread, whose live status shows on the card. Cards drag between
// columns; the same moves are available to agents through `bb kanban move`.
import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DragEvent, FormEvent, ReactNode, RefObject } from "react";
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
import * as Tooltip from "@radix-ui/react-tooltip";
import { getSharedHighlighter } from "@pierre/diffs";
import type { ThemedToken } from "@pierre/diffs";
import { PatchDiff, useWorkerPool } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs/react";
import { toast } from "sonner";
import type { Board, Column, CommentApply, DiffComment, DiffDelta, DiffFile, Dump, Finding, FindingSeverity, HunkExplanation, Narrative, PrComment, ProposedTicket, Review, SemanticChange, Source, SourceKind, StructuralDiff, SymbolLookup, SymbolUsages, Ticket, TicketDiff, rpcContract } from "./server";
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
  /** Wrap long lines (GitHub default) or scroll them horizontally. */
  diffWrap: boolean;
  /** Show the latest review's findings inline in the diff. */
  showFindings: boolean;
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
  let diffMode: "text" | "structural" = "structural";
  try {
    diffMode = window.localStorage.getItem("kanban:diffMode") === "text" ? "text" : "structural";
  } catch {
    diffMode = "structural";
  }
  let diffWrap = true;
  try {
    diffWrap = window.localStorage.getItem("kanban:diffWrap") !== "false";
  } catch {
    diffWrap = true;
  }
  let showFindings = true;
  try {
    showFindings = window.localStorage.getItem("kanban:showFindings") !== "false";
  } catch {
    showFindings = true;
  }
  let state: PageUiState = { dialog: null, newTicketColumn: null, showSubtasks, diffMode, diffView: "unified", diffWrap, showFindings, diffReloadNonce: 0, diffLoading: false };
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
      if (patch.diffWrap !== undefined) {
        try {
          window.localStorage.setItem("kanban:diffWrap", String(patch.diffWrap));
        } catch {
          // ignore
        }
      }
      if (patch.showFindings !== undefined) {
        try {
          window.localStorage.setItem("kanban:showFindings", String(patch.showFindings));
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
        {finding.importance !== null && finding.scopeFit !== null ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title="importance / scope fit (1–5)">
            {finding.importance}/{finding.scopeFit}
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
  if (review === null) return null;
  if (review.status === "running") return <Badge tone="accent">Reviewing…</Badge>;
  if (review.status === "failed") return <Badge tone="danger">failed</Badge>;
  return (
    <span className="inline-flex items-center gap-1" title={`Reviewed at ${review.commitSha ?? "unknown"}${review.sinceCommitSha !== null ? ` (since ${review.sinceCommitSha})` : ""}`}>
      <SeverityCountBadges counts={review.counts} />
    </span>
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
          {showFindings ? (
            <div className="flex flex-col gap-3 text-sm">
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
  const [data, setData] = useState<{ comments: PrComment[]; applies: CommentApply[] } | null>(null);
  const counts = ticket.comments;
  const open = (counts?.total ?? 0) > 0;
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

  if (counts === null || counts.total === 0) return null;
  return (
    <Group
      title="PR comments"
      summary={
        <>
          {counts.open > 0 ? <Badge tone="warning">{counts.open} open</Badge> : null}
          {counts.open === 0 ? <Badge tone="success">all addressed</Badge> : null}
        </>
      }
      defaultOpen
    >
      {(
        <>
          <div className="flex flex-wrap items-center gap-2">
            {counts.open > 0 || running !== null ? (
              <>
                <span title={!canApply ? "Start the card's thread in a project first; the apply thread runs there" : counts.selected === 0 ? "Tick at least one comment to apply" : "Applies the selected comments"}>
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
                </span>
                <PushToggle push={push} onChange={setPush} disabled={pending || running !== null} />
              </>
            ) : null}
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
          {open ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span title="Suggested: everything others wrote that is not yet addressed">{counts.selected} selected</span>
                {addressedCount > 0 ? (
                  <label className="ml-auto inline-flex items-center gap-1.5">
                    <Checkbox checked={showAddressed} onCheckedChange={(checked) => setShowAddressed(checked === true)} aria-label="Show addressed comments" />
                    Show {addressedCount} addressed
                  </label>
                ) : null}
                <label className="inline-flex items-center gap-1.5">
                  <Checkbox checked={autoApprove} onCheckedChange={(checked) => setAutoApprove(checked === true)} aria-label="Skip triage confirmation when applying" />
                  Skip triage
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

const COMMENT_STATE_DOT: Record<"pending" | "submitted" | "posted" | "addressed", string> = {
  pending: "bg-amber-500",
  submitted: "bg-sky-500",
  posted: "bg-sky-500",
  addressed: "bg-emerald-500",
};

/** One of the reviewer's own diff comments: a one-line strip that expands to the full text, editable while still pending. */
function DiffCommentItem({ comment, onDelete, onEdit }: { comment: DiffComment; onDelete: () => void; onEdit: ((body: string) => Promise<void>) | null }) {
  const state = comment.addressedAt !== null ? "addressed" : comment.applyId !== null ? "submitted" : comment.postedAt !== null ? "posted" : "pending";
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  const firstLine = comment.body.split("\n").find((line) => line.trim() !== "") ?? "";
  const where = comment.line === null ? "file" : `${comment.side === "LEFT" ? "old " : ""}L${comment.line}`;
  const save = async () => {
    if (onEdit === null || draft.trim() === "" || draft === comment.body) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onEdit(draft.trim());
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <li data-comment-anchor="" data-comment-state={state} className={cn("my-0.5 border-l-2 pl-2 text-sm", state === "pending" ? "border-amber-500/70" : "border-border", state !== "pending" && "opacity-70")}>
      <div className="flex items-center gap-2 py-0.5 text-xs">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <Icon name="ChevronDown" className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          <span className={cn("size-1.5 shrink-0 rounded-full", COMMENT_STATE_DOT[state])} title={state} />
          <span className="shrink-0 font-mono text-muted-foreground">{where}</span>
          {!open ? <span className="min-w-0 flex-1 truncate text-foreground">{firstLine}</span> : <span className="min-w-0 flex-1 text-muted-foreground">your comment · {state}</span>}
        </button>
        {comment.postedUrl !== null ? (
          <ExternalLink href={comment.postedUrl} className="text-muted-foreground hover:text-foreground">
            <Icon name="ExternalLink" className="size-3" />
          </ExternalLink>
        ) : null}
        {state === "pending" && onEdit !== null && !editing ? (
          <button
            type="button"
            className="rounded px-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
            onClick={() => {
              setDraft(comment.body);
              setEditing(true);
              setOpen(true);
            }}
          >
            Edit
          </button>
        ) : null}
        {state === "pending" ? (
          <button type="button" aria-label="Delete comment" className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-destructive" onClick={onDelete}>
            <Icon name="Trash2" className="size-3" />
          </button>
        ) : null}
      </div>
      {open && !editing ? <Markdown content={comment.body} className="pb-1.5 text-sm" /> : null}
      {editing ? (
        <div className="flex flex-col gap-1.5 pb-1.5">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void save();
              if (event.key === "Escape") setEditing(false);
            }}
          />
          <div className="flex gap-2">
            <Button type="button" className={COMPACT} disabled={saving || draft.trim() === ""} onClick={() => void save()}>
              Save
            </Button>
            <Button type="button" variant="ghost" className={COMPACT} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

type AnnotationMeta = { kind: "comment"; comment: DiffComment } | { kind: "composer" } | { kind: "finding"; finding: InlineFinding };

/** A review finding placed in the diff, with the apply-round selection it carries. */
interface InlineFinding {
  reviewId: string;
  finding: Finding;
  selected: boolean;
  overridden: boolean;
  edited: boolean;
  /** From a review that ran after the reviewer last looked. */
  isNew: boolean;
  /** Its lines changed since the reviewer last looked. */
  touched: boolean;
}

type FindingEditPatch = { title: string; description: string; fix: string | null };

const SEVERITY_DOT: Record<FindingSeverity, string> = { critical: "bg-red-500", important: "bg-amber-500", minor: "bg-slate-400" };
const SEVERITY_BORDER: Record<FindingSeverity, string> = { critical: "border-red-500/70", important: "border-amber-500/70", minor: "border-border" };

/**
 * A review finding under the line it is about: one quiet strip (checkbox, severity, title, scores) that expands to the
 * description and fix, with inline editing of the wording the apply thread will receive.
 */
function FindingAnnotation({ item, onToggle, onEdit }: { item: InlineFinding; onToggle: (selected: boolean) => void; onEdit: (edit: FindingEditPatch | null) => Promise<void> }) {
  const { finding } = item;
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FindingEditPatch>({ title: finding.title, description: finding.description, fix: finding.fix });
  const [saving, setSaving] = useState(false);
  const beginEdit = () => {
    setDraft({ title: finding.title, description: finding.description, fix: finding.fix });
    setEditing(true);
    setOpen(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      await onEdit({ title: draft.title.trim(), description: draft.description, fix: draft.fix === null || draft.fix.trim() === "" ? null : draft.fix });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  const field = "w-full rounded-md border border-border bg-background px-2 py-1 text-xs";
  return (
    <div data-finding-anchor="" className={cn("my-0.5 border-l-2 pl-2 text-sm", SEVERITY_BORDER[finding.severity], !item.selected && "opacity-60")}>
      <div className="flex items-center gap-2 py-0.5 text-xs">
        <Checkbox checked={item.selected} onCheckedChange={(checked) => onToggle(checked === true)} aria-label={`${item.selected ? "Exclude" : "Include"} ${finding.id} in the apply round`} className="size-3.5" />
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <Icon name="ChevronDown" className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          <span className={cn("size-1.5 shrink-0 rounded-full", SEVERITY_DOT[finding.severity])} title={SEVERITY_LABEL[finding.severity]} />
          <span className="shrink-0 font-mono text-muted-foreground">{finding.id}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{finding.title}</span>
        </button>
        {finding.importance !== null && finding.scopeFit !== null ? (
          <span className="shrink-0 tabular-nums text-muted-foreground" title="importance / scope fit (1–5)">
            {finding.importance}/{finding.scopeFit}
          </span>
        ) : null}
        {item.isNew ? <span className="shrink-0 rounded border border-sky-500/50 px-1 text-[10px] text-sky-700 dark:text-sky-300" title="Reported since you last looked">new</span> : null}
        {item.touched ? <span className="shrink-0 rounded border border-amber-500/50 px-1 text-[10px] text-amber-700 dark:text-amber-300" title="These lines changed since you last looked">touched</span> : null}
        {item.edited ? <span className="shrink-0 text-muted-foreground" title="You reworded this finding">edited</span> : null}
        {item.overridden ? <span className="shrink-0 text-muted-foreground" title="You changed this from the suggested selection">manual</span> : null}
        {!editing ? (
          <button type="button" className="rounded px-1 text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={beginEdit}>
            Edit
          </button>
        ) : null}
      </div>
      {open && !editing ? (
        <div className="flex flex-col gap-1 pb-1.5 text-sm">
          {finding.description !== "" ? <Markdown content={finding.description} /> : <p className="text-muted-foreground">No description.</p>}
          {finding.fix !== null && finding.fix !== "" ? (
            <div className="flex gap-1.5">
              <Icon name="kanban-wrench" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <Markdown content={finding.fix} className="min-w-0 flex-1" />
            </div>
          ) : null}
          {item.edited ? (
            <button type="button" className="self-start text-xs text-muted-foreground hover:underline" onClick={() => void onEdit(null)}>
              Revert to the reviewer's wording
            </button>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <div className="flex flex-col gap-1.5 pb-1.5">
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className={field} aria-label="Finding title" />
          <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={4} className={cn(field, "font-mono")} aria-label="Finding description" placeholder="Description (Markdown)" />
          <textarea value={draft.fix ?? ""} onChange={(event) => setDraft({ ...draft, fix: event.target.value })} rows={3} className={cn(field, "font-mono")} aria-label="Suggested fix" placeholder="Suggested fix (optional)" />
          <div className="flex gap-2">
            <Button type="button" className={COMPACT} disabled={saving || draft.title.trim() === ""} onClick={() => void save()}>
              Save
            </Button>
            <Button type="button" variant="ghost" className={COMPACT} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Findings of the latest completed review grouped by file; `null` line means the whole file. */
/** An agent's explanation of a hunk, as a collapsible strip under the hunk header. */
function ExplanationStrip({ explanation }: { explanation: HunkExplanation }) {
  const [open, setOpen] = useState(true);
  const firstLine = (explanation.body ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
  return (
    <div className="my-0.5 border-l-2 border-sky-500/60 pl-2 text-sm">
      <button type="button" className="flex w-full items-center gap-2 py-0.5 text-left text-xs" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Icon name="ChevronDown" className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        <span className="shrink-0 text-muted-foreground">explanation</span>
        {!open ? <span className="min-w-0 flex-1 truncate text-foreground">{firstLine}</span> : null}
      </button>
      {open ? <Markdown content={explanation.body ?? ""} className="pb-1.5 text-sm" /> : null}
    </div>
  );
}

/**
 * The reviews whose findings still stand: the latest full review plus every incremental one after it, oldest first.
 * Earlier full reviews are superseded.
 */
function activeReviews(reviews: Review[]): Review[] {
  const completed = reviews.filter((review) => review.status === "completed" && review.report !== null).sort((a, b) => a.createdAt - b.createdAt);
  let lastFull = -1;
  completed.forEach((review, index) => {
    if (review.sinceCommitSha === null) lastFull = index;
  });
  return lastFull === -1 ? completed : completed.slice(lastFull);
}

function rangesOverlap(start: number, end: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([from, to]) => start <= to && end >= from);
}

function inlineFindingsByPath(reviews: Review[], delta: DiffDelta | null): Map<string, Array<{ item: InlineFinding; line: number | null }>> {
  const byPath = new Map<string, Array<{ item: InlineFinding; line: number | null }>>();
  const active = activeReviews(reviews);
  const newest = active.at(-1) ?? null;
  const changedRanges = new Map((delta?.files ?? []).map((file) => [file.path, file.ranges]));
  for (const review of active) {
    if (review.report === null) continue;
    for (const finding of review.report.findings) {
      const touched = finding.locations.some((location) => {
        const ranges = changedRanges.get(location.file);
        return ranges !== undefined && location.startLine !== null && rangesOverlap(location.startLine, location.endLine ?? location.startLine, ranges);
      });
      const item: InlineFinding = {
        reviewId: review.id,
        finding,
        selected: review.selection[finding.id] ?? false,
        overridden: finding.id in review.selectionOverrides,
        edited: finding.id in review.findingEdits,
        isNew: newest !== null && review.id === newest.id && newest.sinceCommitSha !== null,
        touched,
      };
      for (const location of finding.locations) {
        const list = byPath.get(location.file) ?? [];
        list.push({ item, line: location.startLine });
        byPath.set(location.file, list);
      }
    }
  }
  return byPath;
}

const SEMANTIC_KIND_LABEL: Record<SemanticChange["kind"], string> = {
  rename: "rename",
  move: "move",
  signature: "signature",
  reorder: "reorder",
  reformat: "reformat",
  extract: "extract",
  inline: "inline",
  logic: "logic",
};

/** Risk 1–5 → tint for a file row; null (unscored) → none. */
function riskTint(risk: number | null): string {
  if (risk === null) return "";
  if (risk >= 5) return "bg-red-500/15";
  if (risk === 4) return "bg-orange-500/12";
  if (risk === 3) return "bg-amber-500/10";
  if (risk === 2) return "bg-emerald-500/8";
  return "bg-emerald-500/12";
}
const RISK_DOT: Record<number, string> = { 1: "bg-emerald-500", 2: "bg-emerald-400", 3: "bg-amber-500", 4: "bg-orange-500", 5: "bg-red-500" };

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
  wrap,
  findings,
  onToggleFinding,
  onEditFinding,
  onEditComment,
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
  wrap: boolean;
  findings: Array<{ item: InlineFinding; line: number | null }>;
  onToggleFinding: (item: InlineFinding, selected: boolean) => void;
  onEditFinding: (item: InlineFinding, edit: FindingEditPatch | null) => Promise<void>;
  onEditComment: (id: string, body: string) => Promise<void>;
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
    for (const entry of findings) {
      if (entry.line !== null) list.push({ side: "additions", lineNumber: entry.line, metadata: { kind: "finding", finding: entry.item } });
    }
    return list;
  }, [comments, composer, findings]);
  const selected = composer !== null && composer.line !== null ? { start: composer.line, end: composer.line, side: toSide(composer.side), endSide: toSide(composer.side) } : undefined;
  const options = useMemo(
    () => ({
      diffStyle: view,
      theme: themes,
      themeType: themeMode,
      disableFileHeader: true,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      lineHoverHighlight: "both" as const,
      enableGutterUtility: true,
      onGutterUtilityClick: (range: { start: number; side?: "deletions" | "additions" }) => onStartComment(range.start, fromSide(range.side ?? "additions")),
      onLineNumberClick: (props: { lineNumber: number; annotationSide: "deletions" | "additions" }) => onStartComment(props.lineNumber, fromSide(props.annotationSide)),
    }),
    [view, themes, themeMode, wrap, onStartComment],
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
            <DiffCommentItem key={comment.id} comment={comment} onDelete={() => onDeleteComment(comment.id)} onEdit={(body) => onEditComment(comment.id, body)} />
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
        if (annotation.metadata.kind === "finding") {
          const item = annotation.metadata.finding;
          return <FindingAnnotation item={item} onToggle={(selected) => onToggleFinding(item, selected)} onEdit={(edit) => onEditFinding(item, edit)} />;
        }
        const { comment } = annotation.metadata;
        return (
          <ul className="list-none">
            <DiffCommentItem comment={comment} onDelete={() => onDeleteComment(comment.id)} onEdit={(body) => onEditComment(comment.id, body)} />
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
const STRUCTURAL_CONTEXT = 3;
const STRUCTURAL_EXPAND_STEP = 20;
/** Whole-file adds and deletes longer than this show a preview and a "show more" bar instead of a wall of one colour. */
const LARGE_FILE_PREVIEW_ROWS = 60;
/** Height of a file's sticky header; keyboard jumps land content just below it. */
const DIFF_STICKY_HEADER_PX = 36;
const FILE_TREE_DEFAULT_WIDTH = 288;
const FILE_TREE_MIN_WIDTH = 180;
const FILE_TREE_MAX_WIDTH = 720;
/** A run of identical deleted and added lines at least this long reads as a move rather than a rewrite. */
const MOVE_MIN_LINES = 3;

const DEFINITION_LINE_PATTERNS: RegExp[] = [
  /^\s*(?:(?:export|default|async|pub(?:\([^)]*\))?|static|public|private|protected|abstract|final|override|unsafe|const|declare)\s+)*(?:function\*?|class|interface|type|enum|struct|trait|impl|fn|func|def|module|namespace|describe|it|test|contract|object)\b/u,
  /^\s+(?:(?:public|private|protected|static|async|override|final|abstract|synchronized)\s+)*[\w<>[\],.? ]*\b[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/u,
];

/** The nearest definition line above `line` with shallower indentation: what GitHub prints after `@@` in a hunk header. */
function enclosingDefinition(lines: string[], line: number): string | null {
  const indentOf = (text: string) => text.length - text.trimStart().length;
  let start = line - 1;
  while (start < lines.length && (lines[start] ?? "").trim() === "") start += 1;
  const indent = indentOf(lines[start] ?? "");
  for (let i = Math.min(start, lines.length - 1) - 1; i >= 0; i--) {
    const text = lines[i] ?? "";
    if (text.trim() === "") continue;
    const depth = indentOf(text);
    if (depth >= indent && indent > 0) continue;
    if (DEFINITION_LINE_PATTERNS.some((pattern) => pattern.test(text))) return text.trim();
    if (depth === 0 && indent === 0) break;
  }
  return null;
}

interface MovedRow {
  /** Row index of the matching line on the other side. */
  counterpart: number;
  /** Line number on the other side, for the label. */
  counterpartLine: number;
  first: boolean;
}

/** Pair up blocks of pure deletions with identical blocks of pure additions; difftastic reports both as novel. */
function detectMoves(rows: Array<{ index: number; lhs: number | null; rhs: number | null }>, oldLines: string[], newLines: string[]): Map<number, MovedRow> {
  const moved = new Map<number, MovedRow>();
  const addedByText = new Map<string, number[]>();
  for (const row of rows) {
    if (row.lhs !== null || row.rhs === null) continue;
    const text = (newLines[row.rhs - 1] ?? "").trim();
    if (text === "") continue;
    const list = addedByText.get(text) ?? [];
    list.push(row.index);
    addedByText.set(text, list);
  }
  const isDeleted = (index: number) => rows[index] !== undefined && rows[index]!.rhs === null && rows[index]!.lhs !== null;
  const isAdded = (index: number) => rows[index] !== undefined && rows[index]!.lhs === null && rows[index]!.rhs !== null;
  const textAt = (index: number) => {
    const row = rows[index]!;
    return (row.lhs !== null ? oldLines[row.lhs - 1] : newLines[row.rhs! - 1])?.trim() ?? "";
  };
  for (let i = 0; i < rows.length; i++) {
    if (!isDeleted(i) || moved.has(i)) continue;
    const text = textAt(i);
    if (text === "") continue;
    for (const j of addedByText.get(text) ?? []) {
      if (moved.has(j)) continue;
      let length = 0;
      let nonBlank = 0;
      while (isDeleted(i + length) && isAdded(j + length) && !moved.has(i + length) && !moved.has(j + length) && textAt(i + length) === textAt(j + length)) {
        if (textAt(i + length) !== "") nonBlank += 1;
        length += 1;
      }
      if (length < MOVE_MIN_LINES || nonBlank < 2) continue;
      for (let k = 0; k < length; k++) {
        moved.set(i + k, { counterpart: j + k, counterpartLine: rows[j + k]!.rhs!, first: k === 0 });
        moved.set(j + k, { counterpart: i + k, counterpartLine: rows[i + k]!.lhs!, first: k === 0 });
      }
      i += length - 1;
      break;
    }
  }
  return moved;
}
/** Files longer than this skip Shiki; tokenising both sides of a huge generated file stalls the page. */
const SHIKI_MAX_LINES = 5000;

const SHIKI_LANG_BY_EXTENSION: Record<string, string> = {
  go: "go", ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", rb: "ruby", php: "php", cs: "csharp", swift: "swift", scala: "scala",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "objective-c",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish", ps1: "powershell",
  yaml: "yaml", yml: "yaml", json: "json", jsonc: "jsonc", toml: "toml", xml: "xml", ini: "ini", env: "dotenv",
  md: "markdown", mdx: "mdx", html: "html", htm: "html", css: "css", scss: "scss", less: "less", vue: "vue", svelte: "svelte",
  sql: "sql", proto: "proto", graphql: "graphql", gql: "graphql", tf: "terraform", hcl: "hcl", dockerfile: "docker", lua: "lua", r: "r", dart: "dart", ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell", zig: "zig", nix: "nix", cmake: "cmake", make: "makefile", mk: "makefile",
};

const GENERATED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(node_modules|vendor|dist|build|__snapshots__|\.yarn)\//u,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|flake\.lock|bun\.lockb?)$/u,
  /\.(pb|pb\.gw|pb\.validate|sql|gen|generated|g|min|d|snap|map|swagger|openapi)\.(go|ts|js|py|dart|json|yaml|yml|css|rb|kt|swift)$/u,
  /(^|\/)(zz_generated|wire_gen)[^/]*\.go$/u,
  /(^|\/)(mock_[^/]+\.go|[^/]+_mock\.go|[^/]+\.mock\.ts|[^/]+_string\.go|[^/]+_pb2(_grpc)?\.py|[^/]+_generated\.[^/]+|[^/]+\.generated\.[^/]+)$/u,
];

/** Lockfiles, vendored trees, protobuf and other generated output: collapsed by default so hand-written changes stand out. */
function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function shikiLangFor(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "docker";
  if (lower === "makefile") return "makefile";
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return SHIKI_LANG_BY_EXTENSION[extension] ?? null;
}

type LineTokens = Array<{ content: string; color: string | undefined }>;

/** Shiki tokens per line from the host's shared highlighter; null while loading or when the language is unknown. */
function useShikiTokens(code: string, lang: string | null, theme: string): LineTokens[] | null {
  const [state, setState] = useState<{ key: string; tokens: LineTokens[] } | null>(null);
  const key = `${lang ?? ""}\u0000${theme}\u0000${code.length}\u0000${code.slice(0, 2000)}`;
  useEffect(() => {
    if (lang === null || code === "" || code.split("\n").length > SHIKI_MAX_LINES) return;
    let cancelled = false;
    getSharedHighlighter({ themes: [theme as never], langs: [lang as never] })
      .then((highlighter) => {
        if (cancelled) return;
        const lines = highlighter.codeToTokensBase(code, { lang: lang as never, theme: theme as never }) as ThemedToken[][];
        setState({ key, tokens: lines.map((line) => line.map((token) => ({ content: token.content, color: token.color }))) });
      })
      .catch(() => {
        // Unknown grammar or theme: fall back to unhighlighted text rather than failing the file.
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme, key]);
  return state !== null && state.key === key ? state.tokens : null;
}

/** One side's line: Shiki colours per token, changed spans tinted by difftastic, identifiers made ⌘-clickable. */
function StructuralLine({
  text,
  changes,
  tokens,
  side,
  onSymbol,
  onSymbolHover,
}: {
  text: string;
  changes: StructuralDiff["oldChanges"][number] | null;
  tokens: LineTokens | null;
  side: "LEFT" | "RIGHT";
  onSymbol: (symbol: string, anchor: HTMLElement) => void;
  onSymbolHover?: (symbol: string | null, anchor: HTMLElement | null) => void;
}) {
  // Segment boundaries come from both the Shiki tokens and difftastic's changed spans so each piece has one colour and one tint.
  const spans = (changes?.changes ?? []).slice().sort((a, b) => a.start - b.start);
  const cuts = new Set<number>([0, text.length]);
  for (const span of spans) {
    cuts.add(Math.min(span.start, text.length));
    cuts.add(Math.min(span.end, text.length));
  }
  const tokenStarts: Array<{ start: number; end: number; color: string | undefined }> = [];
  let offset = 0;
  for (const token of tokens ?? []) {
    tokenStarts.push({ start: offset, end: offset + token.content.length, color: token.color });
    offset += token.content.length;
    cuts.add(Math.min(offset, text.length));
  }
  const bounds = [...cuts].sort((a, b) => a - b);
  const segments: Array<{ text: string; changed: boolean; highlight: string; color: string | undefined }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    if (end <= start) continue;
    const span = spans.find((entry) => entry.start <= start && entry.end >= end);
    const token = tokenStarts.find((entry) => entry.start <= start && entry.end >= end);
    segments.push({ text: text.slice(start, end), changed: span !== undefined, highlight: span?.highlight ?? "normal", color: token?.color });
  }
  if (segments.length === 0) segments.push({ text: "", changed: false, highlight: "normal", color: undefined });
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
          onPointerEnter={(event) => onSymbolHover?.(word, event.currentTarget)}
          onPointerLeave={() => onSymbolHover?.(null, null)}
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
          style={segment.color !== undefined ? { color: segment.color } : undefined}
          className={cn(
            segment.color === undefined ? (HIGHLIGHT_CLASS[segment.highlight] ?? "") : "",
            segment.changed && (side === "LEFT" ? "rounded-sm bg-red-500/25" : "rounded-sm bg-emerald-500/25"),
          )}
        >
          {renderTokens(segment.text, `${index}`)}
        </span>
      ))}
    </>
  );
}

/** Per-symbol results shared by the hover preview and the peek panel. */
interface SymbolData {
  lookup: SymbolLookup | null;
  usages: SymbolUsages | null;
  error: string | null;
}

/** A source location shown in the peek's code pane, with the lines fetched so far. */
interface PeekTarget {
  path: string;
  line: number | null;
  startLine: number;
  lines: string[];
}

/** Code lines with numbers and Shiki colouring; identifiers stay ⌘-clickable so you can keep drilling down. */
function PeekCode({
  target,
  highlightLine,
  onSymbol,
  onSymbolHover,
  onWiden,
}: {
  target: PeekTarget;
  highlightLine: number | null;
  onSymbol: (symbol: string, anchor: HTMLElement) => void;
  onSymbolHover: (symbol: string | null, anchor: HTMLElement | null) => void;
  onWiden: (direction: "up" | "down") => void;
}) {
  const codeTheme = useCodeTheme();
  const pierreThemes = useHostPierreThemes(codeTheme.mode);
  const themeName = codeTheme.mode === "dark" ? pierreThemes.dark : pierreThemes.light;
  const tokens = useShikiTokens(target.lines.join("\n"), shikiLangFor(target.path), themeName);
  const widen = (direction: "up" | "down") => (
    <button type="button" className="block w-full bg-sky-500/10 py-px text-center text-[11px] text-sky-700 hover:bg-sky-500/20 dark:text-sky-300" onClick={() => onWiden(direction)}>
      {direction === "up" ? "↑" : "↓"} 20 more lines
    </button>
  );
  return (
    <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5">
      {target.startLine > 1 ? widen("up") : null}
      <table className="w-full border-collapse">
        <tbody>
          {target.lines.map((text, index) => {
            const line = target.startLine + index;
            return (
              <tr key={line} className={cn(line === highlightLine && "bg-amber-500/15")}>
                <td className="w-12 select-none pr-2 text-right align-top text-muted-foreground/70">{line}</td>
                <td className="whitespace-pre pl-2 pr-3 align-top">
                  <StructuralLine text={text} changes={null} tokens={tokens?.[index] ?? null} side="RIGHT" onSymbol={onSymbol} onSymbolHover={onSymbolHover} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {widen("down")}
    </div>
  );
}

/**
 * Inline peek under the clicked line, like an editor's "peek definition": a list of definitions or usages on the left,
 * the selected one's source on the right, a trail of symbols you drilled through, and a way out to the full file.
 */
function SymbolPeek({
  ticketId,
  trail,
  data,
  onNavigate,
  onBack,
  onClose,
  onOpenFile,
  onSymbolHover,
}: {
  ticketId: string;
  trail: string[];
  data: SymbolData | undefined;
  onNavigate: (symbol: string) => void;
  onBack: () => void;
  onClose: () => void;
  onOpenFile: (lookup: SymbolLookup, definition: SymbolLookup["definitions"][number]) => void;
  onSymbolHover: (symbol: string | null, anchor: HTMLElement | null) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const symbol = trail.at(-1)!;
  const [tab, setTab] = useState<"definition" | "usages">("definition");
  const [selected, setSelected] = useState(0);
  const [target, setTarget] = useState<PeekTarget | null>(null);
  const definitions = data?.lookup?.definitions ?? [];
  const usages = data?.usages?.usages ?? [];
  // Reset to the first definition whenever the symbol changes.
  useEffect(() => {
    setTab("definition");
    setSelected(0);
    setTarget(null);
  }, [symbol]);
  const items = tab === "definition" ? definitions : usages;
  const current = items[selected] ?? items[0] ?? null;
  // Definitions arrive with context; usages (and widening) fetch a slice on demand.
  useEffect(() => {
    if (current === null) {
      setTarget(null);
      return;
    }
    const context = "context" in current ? current.context : null;
    if (context !== null && context !== undefined) {
      setTarget({ path: current.path, line: current.line, startLine: context.startLine, lines: context.lines });
      return;
    }
    if (current.line === null) {
      setTarget({ path: current.path, line: null, startLine: 1, lines: [current.snippet] });
      return;
    }
    let cancelled = false;
    rpc.call("symbol_peek_file", { ticketId, path: current.path, startLine: Math.max(1, current.line - 4), endLine: current.line + 16 }).then(
      (slice) => {
        if (!cancelled) setTarget({ path: current.path, line: current.line, startLine: slice.startLine, lines: slice.lines });
      },
      (cause: unknown) => {
        if (!cancelled) setTarget({ path: current.path, line: current.line, startLine: current.line!, lines: [current.snippet] });
        void cause;
      },
    );
    return () => {
      cancelled = true;
    };
  }, [current, rpc, ticketId]);
  const widen = (direction: "up" | "down") => {
    if (target === null) return;
    const startLine = direction === "up" ? Math.max(1, target.startLine - 20) : target.startLine + target.lines.length;
    const endLine = direction === "up" ? target.startLine - 1 : target.startLine + target.lines.length + 19;
    if (endLine < startLine) return;
    rpc.call("symbol_peek_file", { ticketId, path: target.path, startLine, endLine }).then(
      (slice) => {
        if (slice.lines.length === 0) return;
        setTarget((existing) =>
          existing === null
            ? existing
            : direction === "up"
              ? { ...existing, startLine: slice.startLine, lines: [...slice.lines, ...existing.lines] }
              : { ...existing, lines: [...existing.lines, ...slice.lines] },
        );
      },
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
  };
  const byFile = new Map<string, Array<{ index: number; line: number | null; snippet: string }>>();
  items.forEach((item, index) => {
    const list = byFile.get(item.path) ?? [];
    list.push({ index, line: item.line, snippet: item.snippet });
    byFile.set(item.path, list);
  });
  const openTarget = () => {
    if (data?.lookup === undefined || data.lookup === null || current === null) return;
    onOpenFile(data.lookup, { path: current.path, line: current.line, snippet: current.snippet, context: null });
  };
  return (
    <div className="my-1 flex flex-col overflow-hidden rounded-md border border-sky-500/40 bg-background text-sm shadow-sm" role="region" aria-label={`Peek ${symbol}`}>
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2 py-1 text-xs">
        {trail.length > 1 ? (
          <button type="button" className="rounded px-1 text-muted-foreground hover:bg-state-hover hover:text-foreground" title={`Back to ${trail.at(-2)}`} onClick={onBack}>
            ←
          </button>
        ) : null}
        <code className="font-medium">{symbol}</code>
        <div role="tablist" className="flex rounded border border-border p-px">
          {(["definition", "usages"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              className={cn("rounded px-1.5 py-px", tab === entry ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
              onClick={() => {
                setTab(entry);
                setSelected(0);
              }}
            >
              {entry === "definition" ? `Definition${definitions.length > 1 ? ` (${definitions.length})` : ""}` : `Usages${data?.usages ? ` (${usages.length}${data.usages.truncated ? "+" : ""})` : ""}`}
            </button>
          ))}
        </div>
        {data === undefined ? <span className="text-muted-foreground">searching…</span> : null}
        {data?.error ? <span className="text-destructive">{data.error}</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {current !== null ? (
            <button type="button" className="rounded px-1.5 py-px text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={openTarget}>
              Open file
            </button>
          ) : null}
          <button type="button" aria-label="Close peek" className="rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={onClose}>
            <Icon name="X" className="size-3.5" />
          </button>
        </span>
      </div>
      {data !== undefined && items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {tab === "definition" ? (data.lookup?.searched === "none" ? "No searchable checkout; start the card's thread first." : "No definition found.") : "No usages found."}
        </p>
      ) : (
        <div className="flex max-h-[28rem] min-h-0">
          {items.length > 1 || tab === "usages" ? (
            <ul className="w-2/5 min-w-0 shrink-0 overflow-y-auto border-r border-border text-xs">
              {[...byFile.entries()].map(([path, entries]) => (
                <li key={path}>
                  <div className="truncate bg-muted/30 px-2 py-0.5 font-mono text-[11px] text-muted-foreground" title={path}>
                    {path}
                  </div>
                  {entries.map((entry) => (
                    <button
                      key={`${path}:${entry.line ?? entry.index}`}
                      type="button"
                      className={cn("flex w-full items-baseline gap-2 px-2 py-0.5 text-left hover:bg-state-hover", entry.index === (items[selected] === undefined ? 0 : selected) && "bg-state-active")}
                      onClick={() => setSelected(entry.index)}
                    >
                      <span className="w-8 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{entry.line ?? ""}</span>
                      <span className="min-w-0 flex-1 truncate font-mono">{entry.snippet}</span>
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            {target !== null ? (
              <>
                <div className="truncate border-b border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground" title={target.path}>
                  {target.path}
                  {target.line !== null ? `:${target.line}` : ""}
                </div>
                <PeekCode target={target} highlightLine={target.line} onSymbol={(next) => onNavigate(next)} onSymbolHover={onSymbolHover} onWiden={widen} />
              </>
            ) : data === undefined ? null : (
              <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The ⌘-hover card: where a symbol is defined and its first lines, before you commit to a peek. */
function SymbolHoverCard({ symbol, data, anchor }: { symbol: string; data: SymbolData | undefined; anchor: DOMRect }) {
  const definition = data?.lookup?.definitions[0] ?? null;
  const context = definition?.context ?? null;
  const lines = context === null ? [] : context.lines.slice(0, 10);
  const below = anchor.bottom + 320 < window.innerHeight;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 w-[36rem] max-w-[90vw] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
      style={{ top: below ? anchor.bottom + 6 : undefined, bottom: below ? undefined : window.innerHeight - anchor.top + 6, left: Math.max(8, Math.min(anchor.left, window.innerWidth - 600)) }}
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2 py-1 text-xs">
        <code className="font-medium">{symbol}</code>
        {data === undefined ? (
          <span className="text-muted-foreground">searching…</span>
        ) : definition === null ? (
          <span className="text-muted-foreground">no definition found</span>
        ) : (
          <span className="min-w-0 truncate font-mono text-muted-foreground">
            {definition.path}
            {definition.line !== null ? `:${definition.line}` : ""}
            {(data.lookup?.definitions.length ?? 0) > 1 ? ` · +${data.lookup!.definitions.length - 1} more` : ""}
          </span>
        )}
        <span className="ml-auto shrink-0 text-muted-foreground">⌘-click to peek</span>
      </div>
      {lines.length > 0 ? (
        <pre className="max-h-60 overflow-hidden px-2 py-1 font-mono text-[11px] leading-4">
          {lines.map((text, index) => {
            const line = context!.startLine + index;
            return (
              <div key={line} className={cn("whitespace-pre", line === definition!.line && "bg-amber-500/15 font-semibold")}>
                <span className="mr-2 inline-block w-8 text-right text-muted-foreground/60">{line}</span>
                {text}
              </div>
            );
          })}
        </pre>
      ) : definition !== null && definition.snippet !== "" ? (
        <pre className="px-2 py-1 font-mono text-[11px]">{definition.snippet}</pre>
      ) : null}
    </div>
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
  findings,
  onToggleFinding,
  onEditFinding,
  onEditComment,
  explanations,
  onExplain,
  semantics,
  changedRanges,
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
  findings: Array<{ item: InlineFinding; line: number | null }>;
  onToggleFinding: (item: InlineFinding, selected: boolean) => void;
  onEditFinding: (item: InlineFinding, edit: FindingEditPatch | null) => Promise<void>;
  onEditComment: (id: string, body: string) => Promise<void>;
  explanations: HunkExplanation[];
  onExplain: (side: "old" | "new", startLine: number, endLine: number) => void;
  semantics: SemanticChange[];
  changedRanges: Array<[number, number]>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [diff, setDiff] = useState<StructuralDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ rowIndex: number; trail: string[] } | null>(null);
  const [hover, setHover] = useState<{ symbol: string; anchor: DOMRect } | null>(null);
  const symbolCache = useRef(new Map<string, SymbolData>());
  const [, bumpSymbols] = useState(0);
  const hoverTimer = useRef<number | null>(null);
  const [symbolMode, setSymbolMode] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const { diffWrap } = usePageUi();
  const codeTheme = useCodeTheme();
  const pierreThemes = useHostPierreThemes(codeTheme.mode);
  const themeName = codeTheme.mode === "dark" ? pierreThemes.dark : pierreThemes.light;
  const shikiLang = shikiLangFor(path);
  const oldTokens = useShikiTokens(diff?.oldText ?? "", shikiLang, themeName);
  const newTokens = useShikiTokens(diff?.newText ?? "", shikiLang, themeName);
  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    setRevealed(new Set());
    setShowAll(false);
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
  // Definitions and usages are fetched once per symbol and shared by the hover card and the peek.
  const ensureSymbol = (symbol: string) => {
    if (symbolCache.current.has(symbol)) return;
    Promise.all([rpc.call("symbol_definitions", { ticketId, symbol }), rpc.call("symbol_usages", { ticketId, symbol })]).then(
      ([lookup, usages]) => {
        symbolCache.current.set(symbol, { lookup, usages, error: null });
        bumpSymbols((n) => n + 1);
      },
      (cause: unknown) => {
        symbolCache.current.set(symbol, { lookup: null, usages: null, error: errorMessage(cause) });
        bumpSymbols((n) => n + 1);
      },
    );
  };
  /** ⌘-click: open (or re-target) the peek under the clicked line. */
  const lookupSymbol = (symbol: string, anchor: HTMLElement) => {
    const rowAttr = anchor.closest("tr[data-row]")?.getAttribute("data-row");
    const rowIndex = rowAttr === null || rowAttr === undefined ? (peek?.rowIndex ?? null) : Number.parseInt(rowAttr, 10);
    if (rowIndex === null) return;
    setHover(null);
    ensureSymbol(symbol);
    setPeek((current) => (current !== null && current.rowIndex === rowIndex ? { rowIndex, trail: [...current.trail, symbol] } : { rowIndex, trail: [symbol] }));
  };
  /** ⌘-hover: a definition preview after a short pause; leaving the identifier or releasing ⌘ hides it. */
  const hoverSymbol = (symbol: string | null, anchor: HTMLElement | null) => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (symbol === null || anchor === null || !symbolMode) {
      setHover(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    hoverTimer.current = window.setTimeout(() => {
      ensureSymbol(symbol);
      setHover({ symbol, anchor: rect });
    }, 350);
  };
  useEffect(() => {
    if (!symbolMode) setHover(null);
  }, [symbolMode]);
  useEffect(() => {
    if (peek === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPeek(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peek]);
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
  const oldChanges = new Map(diff.oldChanges.map((entry) => [entry.line, entry]));
  const newChanges = new Map(diff.newChanges.map((entry) => [entry.line, entry]));
  const rows = diff.aligned.map(([lhs, rhs], index) => ({
    index,
    lhs,
    rhs,
    changed: lhs === null || rhs === null || oldChanges.has(lhs) || newChanges.has(rhs),
  }));
  const moved = detectMoves(rows, oldLines, newLines);
  const jumpToRow = (index: number) => {
    reveal(Math.max(0, index - STRUCTURAL_CONTEXT), Math.min(rows.length, index + STRUCTURAL_CONTEXT + 1));
    requestAnimationFrame(() => {
      tableRef.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: "center" });
    });
  };
  // GitHub-style hunks: changed rows plus a few lines of context stay visible; everything else collapses behind expanders.
  const visible = new Set<number>();
  for (const row of rows) {
    if (!row.changed) continue;
    for (let i = Math.max(0, row.index - STRUCTURAL_CONTEXT); i <= Math.min(rows.length - 1, row.index + STRUCTURAL_CONTEXT); i++) visible.add(i);
  }
  for (const index of revealed) visible.add(index);
  // Findings sit on new-side lines; keep those rows visible even when the line itself did not change.
  const rowByNewLine = new Map<number, number>();
  for (const row of rows) if (row.rhs !== null) rowByNewLine.set(row.rhs, row.index);
  for (const entry of findings) {
    const index = entry.line === null ? undefined : rowByNewLine.get(entry.line);
    if (index === undefined) continue;
    for (let i = Math.max(0, index - STRUCTURAL_CONTEXT); i <= Math.min(rows.length - 1, index + STRUCTURAL_CONTEXT); i++) visible.add(i);
  }
  const reveal = (from: number, to: number) => {
    setRevealed((current) => {
      const next = new Set(current);
      for (let i = from; i < to; i++) next.add(i);
      return next;
    });
  };
  const commentsAt = (side: "LEFT" | "RIGHT", line: number) => comments.filter((comment) => comment.line === line && comment.side === side);
  const semanticAt = (side: "LEFT" | "RIGHT", line: number): SemanticChange | null =>
    semantics.find((change) => {
      if (change.kind === "logic") return false;
      const range = side === "LEFT" ? change.oldLines : change.newLines;
      return range !== null && line >= range[0] && line <= range[1];
    }) ?? null;
  const lineCell = (line: number | null, side: "LEFT" | "RIGHT", rowChanged: boolean, movedRow: MovedRow | null) => {
    if (line === null) {
      return <td className="bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,var(--color-border)_6px,var(--color-border)_7px)] opacity-40" colSpan={2} />;
    }
    const lines = side === "LEFT" ? oldLines : newLines;
    const sideLine = movedRow !== null ? null : ((side === "LEFT" ? oldChanges : newChanges).get(line) ?? null);
    const text = lines[line - 1] ?? "";
    const lineTokens = (side === "LEFT" ? oldTokens : newTokens)?.[line - 1] ?? null;
    const semantic = rowChanged && movedRow === null ? semanticAt(side, line) : null;
    const neutral = movedRow !== null || semantic !== null;
    const tint = neutral ? "bg-violet-500/10" : rowChanged && (side === "LEFT" ? "bg-red-500/10" : "bg-emerald-500/10");
    const gutterTint = neutral ? "bg-violet-500/20" : rowChanged && (side === "LEFT" ? "bg-red-500/20" : "bg-emerald-500/20");
    const changedSince = side === "RIGHT" && rangesOverlap(line, line, changedRanges);
    const movedLabel =
      movedRow !== null && movedRow.first ? (
        <button
          type="button"
          className="float-right ml-2 rounded border border-violet-500/40 px-1.5 font-sans text-[10px] text-violet-700 hover:bg-violet-500/20 dark:text-violet-300"
          title={side === "LEFT" ? "This block moved; jump to where it went" : "This block moved; jump to where it came from"}
          onClick={() => jumpToRow(movedRow.counterpart)}
        >
          moved {side === "LEFT" ? "to" : "from"} line {movedRow.counterpartLine}
        </button>
      ) : null;
    return (
      <>
        <td className={cn("group/ln select-none border-r border-border/60 pr-2 text-right align-top text-muted-foreground/70", gutterTint, changedSince && "shadow-[inset_2px_0_0_0_theme(colors.sky.500)]")} title={changedSince ? "Changed since you last looked" : undefined}>
          <button
            type="button"
            className="relative w-full text-right tabular-nums hover:text-foreground"
            title="Comment on this line"
            onClick={() => onStartComment(line, side)}
          >
            <span className="group-hover/ln:invisible">{line}</span>
            <span className="absolute inset-0 hidden items-center justify-end pr-0.5 text-primary group-hover/ln:flex">+</span>
          </button>
        </td>
        <td className={cn(diffWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre", "pl-2 pr-3 align-top", tint)}>
          {movedLabel}
          <StructuralLine text={text} changes={sideLine} tokens={lineTokens} side={side} onSymbol={lookupSymbol} onSymbolHover={hoverSymbol} />
        </td>
      </>
    );
  };
  const annotationRow = (side: "LEFT" | "RIGHT", line: number) => {
    const list = commentsAt(side, line);
    const composing = composer !== null && composer.line === line && composer.side === side;
    const lineFindings = side === "RIGHT" ? findings.filter((entry) => entry.line === line) : [];
    if (list.length === 0 && !composing && lineFindings.length === 0) return null;
    return (
      <tr key={`${side}-${line}-notes`}>
        <td colSpan={4} className="px-3 py-1">
          {lineFindings.map((entry) => (
            <FindingAnnotation key={entry.item.finding.id} item={entry.item} onToggle={(selected) => onToggleFinding(entry.item, selected)} onEdit={(edit) => onEditFinding(entry.item, edit)} />
          ))}
          {composing ? <DiffCommentForm path={path} line={line} side={side} onSubmit={onSubmitComposer} onCancel={onCancelComposer} /> : null}
          {list.length > 0 ? (
            <ul className="list-none">
              {list.map((comment) => (
                <DiffCommentItem key={comment.id} comment={comment} onDelete={() => onDeleteComment(comment.id)} onEdit={(body) => onEditComment(comment.id, body)} />
              ))}
            </ul>
          ) : null}
        </td>
      </tr>
    );
  };
  const expanderButton = (label: string, title: string, onClick: () => void) => (
    <button type="button" title={title} aria-label={title} className="rounded px-1.5 py-0.5 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300" onClick={onClick}>
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
            {count <= STRUCTURAL_EXPAND_STEP ? (
              expanderButton("↕", `Show ${count} unchanged lines`, () => reveal(from, to))
            ) : (
              <>
                {!leading ? expanderButton("↓", `Show ${STRUCTURAL_EXPAND_STEP} lines below`, () => reveal(from, from + STRUCTURAL_EXPAND_STEP)) : null}
                {!trailing ? expanderButton("↑", `Show ${STRUCTURAL_EXPAND_STEP} lines above`, () => reveal(to - STRUCTURAL_EXPAND_STEP, to)) : null}
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
  /** The hunk starting at `index`: its last visible row and the line span on each side. */
  const hunkSpan = (index: number) => {
    let end = index;
    while (end + 1 < rows.length && visible.has(end + 1)) end += 1;
    const slice = rows.slice(index, end + 1);
    const news = slice.map((row) => row.rhs).filter((line): line is number => line !== null);
    const olds = slice.map((row) => row.lhs).filter((line): line is number => line !== null);
    const side: "old" | "new" = news.length > 0 ? "new" : "old";
    const lines = side === "new" ? news : olds;
    return { end, side, start: Math.min(...lines), stop: Math.max(...lines) };
  };
  const hunkHeader = (index: number) => {
    const span = hunkSpan(index);
    const first = rows[index]!;
    const enclosing = first.rhs !== null ? enclosingDefinition(newLines, first.rhs) : first.lhs !== null ? enclosingDefinition(oldLines, first.lhs) : null;
    const labels = semantics.filter((change) => {
      const range = span.side === "new" ? change.newLines : change.oldLines;
      return range !== null && rangesOverlap(span.start, span.stop, [range]);
    });
    const explanation = explanations.find((entry) => entry.side === span.side && entry.startLine <= span.stop && entry.endLine >= span.start) ?? null;
    return (
      <Fragment key={`hunk-${index}`}>
        <tr data-hunk="" className="bg-muted/30 text-[11px] text-muted-foreground">
          <td colSpan={4} className="px-3 py-0.5">
            <div className="flex items-center gap-2">
              <code className="min-w-0 truncate text-muted-foreground/80" title={enclosing ?? undefined}>
                @@ {span.side === "new" ? "" : "old "}{span.start}–{span.stop}
                {enclosing !== null ? ` ${enclosing}` : ""}
              </code>
              {labels.map((change, labelIndex) => (
                <span key={labelIndex} className="inline-flex min-w-0 items-center gap-1 rounded border border-violet-500/40 px-1.5 py-px font-sans text-[10px] text-violet-700 dark:text-violet-300" title={change.label}>
                  <span className="uppercase tracking-wide">{SEMANTIC_KIND_LABEL[change.kind]}</span>
                  <span className="truncate normal-case">{change.label}</span>
                </span>
              ))}
              <span className="ml-auto flex shrink-0 items-center gap-1 font-sans">
                {explanation === null ? (
                  <button type="button" className="rounded px-1.5 py-px hover:bg-state-hover hover:text-foreground" title="Ask an agent what this hunk does and why" onClick={() => onExplain(span.side, span.start, span.stop)}>
                    Explain
                  </button>
                ) : explanation.status === "running" ? (
                  <span>explaining…</span>
                ) : explanation.status === "failed" ? (
                  <button type="button" className="rounded px-1.5 py-px text-destructive hover:bg-state-hover" onClick={() => onExplain(span.side, span.start, span.stop)}>
                    explanation failed · retry
                  </button>
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
  const wholeFile = diff.status === "created" || diff.status === "deleted" || rows.every((row) => row.changed);
  const previewLimit = wholeFile && !showAll && visible.size > LARGE_FILE_PREVIEW_ROWS + 10 ? LARGE_FILE_PREVIEW_ROWS : null;
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
            <button type="button" className="rounded px-1.5 py-0.5 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300" onClick={() => setShowAll(true)}>
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
    if (startsHunk) body.push(hunkHeader(row.index));
    body.push(
      <Fragment key={row.index}>
        <tr className="hover:bg-state-hover/40" data-row={row.index}>
          {lineCell(row.lhs, "LEFT", row.changed, moved.get(row.index) ?? null)}
          {lineCell(row.rhs, "RIGHT", row.changed, moved.get(row.index) ?? null)}
        </tr>
        {row.lhs !== null ? annotationRow("LEFT", row.lhs) : null}
        {row.rhs !== null ? annotationRow("RIGHT", row.rhs) : null}
        {peek !== null && peek.rowIndex === row.index ? (
          <tr key={`peek-${row.index}`}>
            <td colSpan={4} className="px-3 py-1">
              <SymbolPeek
                ticketId={ticketId}
                trail={peek.trail}
                data={symbolCache.current.get(peek.trail.at(-1)!)}
                onNavigate={(symbol) => {
                  ensureSymbol(symbol);
                  setPeek({ rowIndex: row.index, trail: [...peek.trail, symbol] });
                }}
                onBack={() => setPeek(peek.trail.length > 1 ? { rowIndex: row.index, trail: peek.trail.slice(0, -1) } : null)}
                onClose={() => setPeek(null)}
                onOpenFile={onOpenFile}
                onSymbolHover={hoverSymbol}
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
    <div className={cn("relative", symbolMode && "symbol-mode")}>
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
      {hover !== null && symbolMode ? <SymbolHoverCard symbol={hover.symbol} data={symbolCache.current.get(hover.symbol)} anchor={hover.anchor} /> : null}
    </div>
  );
}

/** A truncating label whose tooltip (the full text, plus optional extra lines) appears only when the text is actually clipped. */
function TruncatedName({ text, full, className, extra }: { text: string; full: string; className?: string; extra?: string | null }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const show = () => {
    const node = ref.current;
    if (node !== null && (node.scrollWidth > node.clientWidth + 1 || text !== full)) setOpen(true);
  };
  return (
    <Tooltip.Root open={open} onOpenChange={(next) => (next ? show() : setOpen(false))} delayDuration={250}>
      <Tooltip.Trigger asChild>
        <span ref={ref} className={cn("min-w-0 flex-1 truncate font-mono", className)}>
          {text}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="right" sideOffset={6} className="z-50 max-w-[80vw] rounded-md border border-border bg-popover px-2 py-1 font-mono text-xs text-popover-foreground shadow-md">
          {full}
          {extra !== null && extra !== undefined ? <div className="mt-0.5 font-sans text-muted-foreground">{extra}</div> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

interface FileTreeDir {
  name: string;
  path: string;
  dirs: FileTreeDir[];
  files: DiffFile[];
  additions: number;
  deletions: number;
}

/** Nest files by directory, then fold single-child directory chains into one row (`src/server/handlers`). */
function buildFileTree(files: DiffFile[]): FileTreeDir {
  const root: FileTreeDir = { name: "", path: "", dirs: [], files: [], additions: 0, deletions: 0 };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.find((dir) => dir.name === part);
      if (child === undefined) {
        child = { name: part, path: node.path === "" ? part : `${node.path}/${part}`, dirs: [], files: [], additions: 0, deletions: 0 };
        node.dirs.push(child);
      }
      node = child;
    }
    node.files.push(file);
  }
  const fold = (node: FileTreeDir): FileTreeDir => {
    let current = node;
    while (current.dirs.length === 1 && current.files.length === 0 && current !== root) {
      const only = current.dirs[0]!;
      current = { ...only, name: `${current.name}/${only.name}` };
    }
    current.dirs = current.dirs.map(fold).sort((a, b) => a.name.localeCompare(b.name));
    current.files.sort((a, b) => a.path.localeCompare(b.path));
    current.additions = current.files.reduce((sum, file) => sum + file.additions, 0) + current.dirs.reduce((sum, dir) => sum + dir.additions, 0);
    current.deletions = current.files.reduce((sum, file) => sum + file.deletions, 0) + current.dirs.reduce((sum, dir) => sum + dir.deletions, 0);
    return current;
  };
  return fold(root);
}

function FileTree({
  files,
  activePath,
  viewed,
  commentCount,
  findingCount,
  risk,
  changedSince,
  onSelect,
}: {
  files: DiffFile[];
  activePath: string | null;
  viewed: ReadonlySet<string>;
  commentCount: (path: string) => number;
  findingCount: (path: string) => number;
  risk: (path: string) => number | null;
  changedSince: (path: string) => boolean;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const renderDir = (dir: FileTreeDir, depth: number): ReactNode => {
    const isClosed = closed.has(dir.path);
    return (
      <li key={`dir:${dir.path}`}>
        <button
          type="button"
          onClick={() => toggle(dir.path)}
          className="flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs text-muted-foreground hover:bg-state-hover"
          style={{ paddingLeft: 8 + depth * 12 }}
          aria-expanded={!isClosed}
        >
          <Icon name="ChevronDown" className={cn("size-3 shrink-0 transition-transform", isClosed && "-rotate-90")} />
          <TruncatedName text={dir.name} full={dir.path} />
          <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{dir.additions}</span>
          <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">−{dir.deletions}</span>
        </button>
        {isClosed ? null : <ul>{renderChildren(dir, depth + 1)}</ul>}
      </li>
    );
  };
  const renderFile = (file: DiffFile, depth: number): ReactNode => {
    const count = commentCount(file.path);
    const isViewed = viewed.has(file.path);
    const generated = isGeneratedPath(file.path);
    const name = file.path.split("/").pop() ?? file.path;
    const fileRisk = isViewed ? null : risk(file.path);
    return (
      <li key={file.path}>
        <button
          type="button"
          onClick={() => onSelect(file.path)}
          className={cn("flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs hover:bg-state-hover", riskTint(fileRisk), file.path === activePath && "bg-state-active")}
          style={{ paddingLeft: 8 + depth * 12 + 16 }}
          data-file-tree-path={file.path}
        >
          {isViewed ? <Icon name="Check" className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" /> : fileRisk !== null ? <span className={cn("size-1.5 shrink-0 rounded-full", RISK_DOT[fileRisk])} aria-hidden="true" /> : null}
          {changedSince(file.path) ? <span className="shrink-0 rounded border border-sky-500/50 px-1 text-[10px] text-sky-700 dark:text-sky-300" title="Changed since you last looked">changed</span> : null}
          <TruncatedName
            text={name}
            full={file.path}
            extra={fileRisk === null ? null : `review attention ${fileRisk}/5`}
            className={cn((isViewed || generated) && "text-muted-foreground", isViewed && "line-through decoration-muted-foreground/50")}
          />
          {generated ? <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">gen</span> : null}
          {findingCount(file.path) > 0 ? <Badge tone="danger" title="Review findings in this file">{findingCount(file.path)}</Badge> : null}
          {count > 0 ? <Badge tone="warning">{count}</Badge> : null}
          <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
          <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">−{file.deletions}</span>
        </button>
      </li>
    );
  };
  const renderChildren = (dir: FileTreeDir, depth: number): ReactNode[] => [...dir.dirs.map((child) => renderDir(child, depth)), ...dir.files.map((file) => renderFile(file, depth))];
  return (
    <Tooltip.Provider>
      <ul>{renderChildren(tree, 0)}</ul>
    </Tooltip.Provider>
  );
}

/** `diff/<cardId>` → card id; `diff/thread/<threadId>` → `thread:<threadId>`. Decodes in case the host escaped the path. */
function diffSubjectFromSubPath(subPath: string): string | null {
  if (!subPath.startsWith("diff/")) return null;
  const rest = decodeURIComponent(subPath.slice("diff/".length));
  if (rest.startsWith("thread/")) return `thread:${rest.slice("thread/".length)}`;
  return rest;
}

/** The diff route takes a card id or `thread:<threadId>`; a thread that has a card shows as that card. */
function findDiffSubjectTicket(board: Board | null, subjectId: string): Ticket | null {
  if (board === null) return null;
  const direct = board.tickets.find((entry) => entry.id === subjectId);
  if (direct !== undefined) return direct;
  if (!subjectId.startsWith("thread:")) return null;
  const threadId = subjectId.slice("thread:".length);
  return board.tickets.find((entry) => entry.threadId === threadId) ?? null;
}

/** Thread header button: open the changes view for this thread, as its card when it has one. */
function ThreadDiffAction({ threadId, isCompactViewport }: { threadId: string; projectId: string; isCompactViewport: boolean }) {
  const navigate = useBbNavigate();
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(COMPACT, isCompactViewport && "px-1.5")}
      aria-label="View this thread's changes in the Kanban diff view"
      onClick={() => navigate.toPluginPanel("board", { subPath: `diff/thread/${threadId}` })}
    >
      <Icon name="kanban-diff" className="size-3.5" />
      {isCompactViewport ? null : "Changes"}
    </Button>
  );
}

/**
 * The host's own fallback only says "plugin kanban crashed" and logs the cause to the devtools console. This boundary
 * sits inside each slot so the message and component stack show on the page, with a retry that remounts the subtree.
 */
class PluginErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null; stack: string | null }> {
  state: { error: Error | null; stack: string | null } = { error: null, stack: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    this.setState({ stack: info.componentStack ?? null });
    console.error(`[kanban] ${this.props.name} crashed:`, error, info.componentStack);
  }
  render() {
    const { error, stack } = this.state;
    if (error === null) return this.props.children;
    const details = `${error.name}: ${error.message}\n${error.stack ?? ""}\n\nComponent stack:${stack ?? " (none)"}`;
    return (
      <div className="m-3 flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
        <p className="font-medium text-destructive">Kanban {this.props.name} crashed</p>
        <p className="break-words font-mono text-xs">{error.message}</p>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Stack trace</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{details}</pre>
        </details>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className={COMPACT} onClick={() => this.setState({ error: null, stack: null })}>
            Retry
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={COMPACT}
            onClick={() => {
              void navigator.clipboard?.writeText(details);
              toast.message("Error details copied");
            }}
          >
            Copy details
          </Button>
        </div>
      </div>
    );
  }
}

function withErrorBoundary<P extends object>(name: string, Inner: (props: P) => ReactNode) {
  return function Guarded(props: P) {
    return (
      <PluginErrorBoundary name={name}>
        <Inner {...props} />
      </PluginErrorBoundary>
    );
  };
}

const TOUR_ROLE_LABEL: Record<"key" | "supporting" | "mechanical", { label: string; tone: "danger" | "accent" | "neutral" }> = {
  key: { label: "key", tone: "danger" },
  supporting: { label: "supporting", tone: "accent" },
  mechanical: { label: "mechanical", tone: "neutral" },
};

function readTourOpen(): boolean {
  try {
    return window.localStorage.getItem("kanban:tourOpen") === "true";
  } catch {
    return false;
  }
}

/** The agent's reading guide, as one strip above the files: the first sentence when closed, the full tour when opened. */
function TourPanel({
  tour,
  busy,
  onGenerate,
  onJump,
  onOpenThread,
  files,
}: {
  tour: { narrative: Narrative | null; stale: boolean } | null;
  busy: boolean;
  onGenerate: () => void;
  onJump: (path: string) => void;
  onOpenThread: (threadId: string) => void;
  files: DiffFile[];
}) {
  const [open, setOpenState] = useState(readTourOpen);
  const setOpen = (value: boolean) => {
    setOpenState(value);
    try {
      window.localStorage.setItem("kanban:tourOpen", String(value));
    } catch {
      // ignore
    }
  };
  const narrative = tour?.narrative ?? null;
  const report = narrative?.status === "completed" ? narrative.report : null;
  const known = new Set(files.map((file) => file.path));
  const firstSentence = report === null ? "" : (report.summary.match(/^[\s\S]*?[.!?](?=\s|$)/u)?.[0] ?? report.summary);
  const keyCount = report?.readingOrder.filter((entry) => entry.role === "key").length ?? 0;
  const generateLabel = narrative === null ? "Generate tour" : tour?.stale ? "Regenerate for new head" : "Regenerate";
  return (
    <section className="border-b border-border text-xs">
      <div className="flex min-h-7 items-center gap-2 px-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" onClick={() => setOpen(!open)} aria-expanded={open} disabled={report === null}>
          <Icon name="ChevronDown" className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90", report === null && "invisible")} />
          <span className="shrink-0 font-medium">Tour</span>
          {narrative === null ? (
            <span className="truncate text-muted-foreground">An agent can summarise this change and suggest a reading order.</span>
          ) : narrative.status === "running" ? (
            <span className="truncate text-muted-foreground">Writing… this strip fills in when the thread finishes.</span>
          ) : narrative.status === "failed" ? (
            <span className="truncate text-destructive">Failed. Open the thread for details.</span>
          ) : !open ? (
            <span className="min-w-0 truncate text-muted-foreground">{firstSentence}</span>
          ) : null}
          {report !== null && !open && keyCount > 0 ? <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">{keyCount} key</span> : null}
          {tour?.stale ? <span className="shrink-0 rounded border border-amber-500/50 px-1 text-[10px] text-amber-700 dark:text-amber-300">stale</span> : null}
        </button>
        {narrative !== null ? (
          <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => onOpenThread(narrative.threadId)}>
            thread
          </button>
        ) : null}
        {narrative?.status === "running" ? null : (
          <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50" disabled={busy} onClick={onGenerate}>
            {busy ? "Starting…" : generateLabel}
          </button>
        )}
      </div>
      {open && report !== null ? (
        <div className="flex flex-col gap-2 px-3 pb-3 pl-8 text-sm">
          <Markdown content={report.summary} className="text-sm" />
          <ol className="flex flex-col gap-0.5">
            {report.readingOrder.map((entry, index) => (
              <li key={`${entry.path}-${index}`} className="flex items-baseline gap-2 text-xs">
                <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">{index + 1}</span>
                <span className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", entry.role === "key" ? "bg-red-500" : entry.role === "supporting" ? "bg-sky-500" : "bg-slate-400")} title={entry.role} />
                {known.has(entry.path) ? (
                  <button type="button" className="shrink-0 font-mono hover:underline" onClick={() => onJump(entry.path)}>
                    {entry.path.split("/").pop()}
                  </button>
                ) : (
                  <code className="shrink-0 text-muted-foreground">{entry.path}</code>
                )}
                {entry.risk !== null ? <span className={cn("shrink-0 rounded px-1 text-[10px] text-white", RISK_DOT[entry.risk])} title={`review attention ${entry.risk}/5`}>{entry.risk}</span> : null}
                {entry.lines.length > 0 ? <span className="shrink-0 text-muted-foreground">L{entry.lines.slice(0, 4).join(", ")}</span> : null}
                {entry.note !== "" ? (
                  <span className={cn("min-w-0 truncate", entry.role === "mechanical" ? "text-muted-foreground" : "text-foreground")} title={entry.note}>
                    {entry.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          {report.watchOut.length > 0 ? (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {report.watchOut.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Mounts its content once it scrolls near the viewport, then keeps it mounted; the placeholder height keeps far-off files out of view until then. */
function LazyMount({ root, estimateLines, children }: { root: RefObject<HTMLElement | null>; estimateLines: number; children: () => ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (mounted) return;
    const node = ref.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setMounted(true);
      },
      { root: root.current, rootMargin: "1000px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [mounted, root]);
  return (
    <div ref={ref} style={mounted ? undefined : { minHeight: Math.min(Math.max(estimateLines * 20, 80), 600) }}>
      {mounted ? children() : null}
    </div>
  );
}

function DiffView({ ticketId, onBack, onOpenThread }: { ticketId: string; onBack: () => void; onOpenThread: (threadId: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const { board, refetch } = useBoard();
  const ticket = findDiffSubjectTicket(board, ticketId);
  const { diff, error, loading, reload } = useTicketDiff(ticketId, true);
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [markers, setMarkers] = useState<Array<{ fraction: number; pending: boolean; element: Element }>>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [delta, setDelta] = useState<DiffDelta | null>(null);
  const [explanations, setExplanations] = useState<HunkExplanation[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [treeOpen, setTreeOpenState] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("kanban:fileTreeOpen") !== "false";
    } catch {
      return true;
    }
  });
  const setTreeOpen = (value: boolean) => {
    setTreeOpenState(value);
    try {
      window.localStorage.setItem("kanban:fileTreeOpen", String(value));
    } catch {
      // ignore
    }
  };
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    try {
      const stored = Number.parseInt(window.localStorage.getItem("kanban:fileTreeWidth") ?? "", 10);
      return Number.isFinite(stored) ? Math.min(FILE_TREE_MAX_WIDTH, Math.max(FILE_TREE_MIN_WIDTH, stored)) : FILE_TREE_DEFAULT_WIDTH;
    } catch {
      return FILE_TREE_DEFAULT_WIDTH;
    }
  });
  const startTreeResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = treeWidth;
    let width = startWidth;
    const move = (moveEvent: PointerEvent) => {
      width = Math.min(FILE_TREE_MAX_WIDTH, Math.max(FILE_TREE_MIN_WIDTH, startWidth + moveEvent.clientX - startX));
      setTreeWidth(width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        window.localStorage.setItem("kanban:fileTreeWidth", String(width));
      } catch {
        // ignore
      }
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [tour, setTour] = useState<{ narrative: Narrative | null; stale: boolean } | null>(null);
  const [tourBusy, setTourBusy] = useState(false);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const mainRef = useRef<HTMLElement | null>(null);
  const [composer, setComposer] = useState<{ path: string; line: number | null; side: "LEFT" | "RIGHT" } | null>(null);
  const { diffView: view, diffMode, diffWrap, diffReloadNonce } = usePageUi();
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
  const loadReview = useCallback(() => {
    if (ticketId.startsWith("thread:") && ticket === null) return;
    rpc.call("review_list", { ticketId: ticket?.id ?? ticketId }).then(
      (result) => setReviews(result.reviews),
      () => setReviews([]),
    );
  }, [rpc, ticketId, ticket]);
  const loadExplanations = useCallback(() => {
    rpc.call("hunk_explanations_list", { ticketId }).then((result) => setExplanations(result.explanations), () => setExplanations([]));
  }, [rpc, ticketId]);
  useEffect(loadExplanations, [loadExplanations]);
  useRealtime(BOARD_CHANGED, loadExplanations);
  const explainHunk = (path: string, side: "old" | "new", startLine: number, endLine: number) => {
    rpc.call("hunk_explain", { ticketId, path, side, startLine, endLine }).then(
      (explanation) => setExplanations((current) => [...current.filter((entry) => entry.id !== explanation.id), explanation]),
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
  };
  const rereview = async () => {
    if (ticket === null) return;
    setReviewing(true);
    try {
      await rpc.call("ticket_review_pr", { id: ticket.id, mode: "incremental" });
      toast.message("Re-review started");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setReviewing(false);
    }
  };
  useEffect(loadReview, [loadReview]);
  useRealtime(BOARD_CHANGED, loadReview);
  const loadTour = useCallback(() => {
    rpc.call("narrative_get", { ticketId }).then(setTour, () => setTour(null));
  }, [rpc, ticketId]);
  useEffect(loadTour, [loadTour]);
  useRealtime(BOARD_CHANGED, loadTour);
  const generateTour = async () => {
    setTourBusy(true);
    try {
      const narrative = await rpc.call("narrative_generate", { ticketId });
      setTour({ narrative, stale: false });
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setTourBusy(false);
    }
  };
  const { showFindings } = usePageUi();
  const allFindingsByPath = useMemo(() => inlineFindingsByPath(reviews, delta), [reviews, delta]);
  const semanticsByPath = useMemo(() => {
    const map = new Map<string, SemanticChange[]>();
    const report = tour?.narrative?.status === "completed" ? tour.narrative.report : null;
    for (const entry of report?.readingOrder ?? []) if (entry.changes.length > 0) map.set(entry.path, entry.changes);
    return map;
  }, [tour]);
  const riskByPath = useMemo(() => {
    const map = new Map<string, number>();
    const report = tour?.narrative?.status === "completed" && !(tour?.stale ?? false) ? tour.narrative.report : null;
    for (const entry of report?.readingOrder ?? []) if (entry.risk !== null) map.set(entry.path, entry.risk);
    // Without a tour score, the review's worst finding in the file stands in.
    for (const [path, list] of allFindingsByPath) {
      if (map.has(path)) continue;
      const worst = list.reduce<number>((score, entry) => Math.max(score, entry.item.finding.severity === "critical" ? 5 : entry.item.finding.severity === "important" ? 4 : 2), 0);
      if (worst > 0) map.set(path, worst);
    }
    return map;
  }, [tour, allFindingsByPath]);
  const changedRangesByPath = useMemo(() => new Map((delta?.files ?? []).map((file) => [file.path, file.ranges] as const)), [delta]);
  const newFindingCount = useMemo(() => [...allFindingsByPath.values()].flat().filter((entry) => entry.item.isNew).length, [allFindingsByPath]);
  const touchedFindingCount = useMemo(() => [...allFindingsByPath.values()].flat().filter((entry) => entry.item.touched).length, [allFindingsByPath]);
  const findingsByPath = showFindings ? allFindingsByPath : new Map<string, Array<{ item: InlineFinding; line: number | null }>>();
  const findingTotal = useMemo(() => [...allFindingsByPath.values()].reduce((sum, list) => sum + list.length, 0), [allFindingsByPath]);
  const replaceReview = (updated: Review) => setReviews((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
  const toggleFinding = (item: InlineFinding, selected: boolean) => {
    rpc.call("review_set_selection", { reviewId: item.reviewId, findingId: item.finding.id, selected }).then(replaceReview, (cause: unknown) => toast.error(errorMessage(cause)));
  };
  const editFinding = async (item: InlineFinding, edit: FindingEditPatch | null) => {
    try {
      replaceReview(await rpc.call("review_edit_finding", { reviewId: item.reviewId, findingId: item.finding.id, edit }));
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    }
  };
  const editComment = async (id: string, body: string) => {
    try {
      await rpc.call("diff_comment_update", { id, body });
      loadComments();
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    }
  };
  const headSha = diff?.headSha ?? null;
  useEffect(() => {
    rpc.call("diff_delta", { ticketId }).then((result) => setDelta(result.delta), () => setDelta(null));
  }, [rpc, ticketId, headSha]);
  const generatedCollapsedFor = useRef<string | null>(null);
  useEffect(() => {
    if (diff === null) return;
    const key = `${headSha ?? "env"}:${diff.files.length}`;
    if (generatedCollapsedFor.current === key) return;
    generatedCollapsedFor.current = key;
    const generated = diff.files.filter((entry) => isGeneratedPath(entry.path)).map((entry) => entry.path);
    if (generated.length > 0) setCollapsed((current) => new Set([...current, ...generated]));
  }, [diff, headSha]);
  useEffect(() => {
    rpc.call("diff_viewed_list", { ticketId }).then(
      (result) => {
        setViewed(new Set(result.paths));
        setCollapsed((current) => new Set([...current, ...result.paths]));
      },
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
  }, [rpc, ticketId, headSha]);
  const markViewed = (path: string, isViewed: boolean) => {
    setViewed((current) => {
      const next = new Set(current);
      if (isViewed) next.add(path);
      else next.delete(path);
      return next;
    });
    setCollapsed((current) => {
      const next = new Set(current);
      if (isViewed) next.add(path);
      else next.delete(path);
      return next;
    });
    rpc.call("diff_viewed_set", { ticketId, path, viewed: isViewed }).then(
      (result) => setViewed(new Set(result.paths)),
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
  };

  const canPost = ticket?.canPostToGithub ?? false;
  const willPost = postToGithub ?? canPost;
  const pending = comments.filter((comment) => comment.addressedAt === null && comment.applyId === null);
  const forPath = (path: string) => comments.filter((comment) => comment.path === path);
  const jumpTo = (path: string) => {
    setActivePath(path);
    setCollapsed((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    sectionRefs.current.get(path)?.scrollIntoView({ block: "start" });
  };
  const toggleCollapsed = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const scrollMainTo = (element: Element) => {
    const main = mainRef.current;
    if (main === null) return;
    const offset = element.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    main.scrollTo({ top: Math.max(0, offset - DIFF_STICKY_HEADER_PX), behavior: "auto" });
  };
  /** Next (or previous) element matching `selector` strictly below (above) the current reading position. */
  const stepTo = (selector: string, direction: 1 | -1) => {
    const main = mainRef.current;
    if (main === null) return;
    const mainTop = main.getBoundingClientRect().top + DIFF_STICKY_HEADER_PX;
    const elements = Array.from(main.querySelectorAll(selector));
    const target =
      direction === 1
        ? elements.find((element) => element.getBoundingClientRect().top > mainTop + 2)
        : [...elements].reverse().find((element) => element.getBoundingClientRect().top < mainTop - 2);
    if (target !== undefined) scrollMainTo(target);
  };
  const stepFile = (direction: 1 | -1) => {
    if (diff === null || diff.files.length === 0) return;
    const index = diff.files.findIndex((entry) => entry.path === activePath);
    const next = diff.files[Math.min(diff.files.length - 1, Math.max(0, (index === -1 ? 0 : index) + direction))];
    if (next !== undefined) jumpTo(next.path);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      switch (event.key) {
        case "j":
          stepTo("[data-hunk]", 1);
          break;
        case "k":
          stepTo("[data-hunk]", -1);
          break;
        case "n":
          stepFile(1);
          break;
        case "p":
          stepFile(-1);
          break;
        case "c":
          stepTo("[data-comment-anchor]", 1);
          break;
        case "C":
          stepTo("[data-comment-anchor]", -1);
          break;
        case "v":
          if (activePath !== null) markViewed(activePath, !viewed.has(activePath));
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (activePath === null) return;
    document.querySelector(`[data-file-tree-path="${CSS.escape(activePath)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activePath]);
  // Comment positions along the scroller, as fractions of its full height, for the marker track beside the scrollbar.
  const recomputeMarkers = () => {
    const main = mainRef.current;
    if (main === null) return;
    const mainTop = main.getBoundingClientRect().top;
    const total = main.scrollHeight;
    const next = Array.from(main.querySelectorAll("[data-comment-anchor], [data-finding-anchor]")).map((element) => ({
      fraction: total === 0 ? 0 : (element.getBoundingClientRect().top - mainTop + main.scrollTop) / total,
      pending: element.getAttribute("data-comment-state") === "pending" || element.hasAttribute("data-finding-anchor"),
      element,
    }));
    setMarkers((current) => (current.length === next.length && current.every((marker, index) => Math.abs(marker.fraction - next[index]!.fraction) < 0.001 && marker.pending === next[index]!.pending) ? current : next));
  };
  useEffect(() => {
    const main = mainRef.current;
    if (main === null) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(recomputeMarkers);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(main, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [diff, comments, collapsed]);
  // The sidebar tracks whichever file header is at (or just above) the top of the scroller, like GitHub's file tree.
  const trackActive = () => {
    recomputeMarkers();
    const main = mainRef.current;
    if (main === null || diff === null) return;
    const top = main.getBoundingClientRect().top + 8;
    let current: string | null = null;
    for (const entry of diff.files) {
      const section = sectionRefs.current.get(entry.path);
      if (section === undefined) continue;
      if (section.getBoundingClientRect().top <= top) current = entry.path;
      else break;
    }
    setActivePath(current ?? diff.files[0]?.path ?? null);
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

  if (ticket === null && (board === null || !ticketId.startsWith("thread:"))) {
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
          <span className="cursor-help text-muted-foreground/60" title="Keyboard: j/k next/previous change · n/p next/previous file · c/C next/previous comment · v toggle viewed">
            ⌨
          </span>
          {comments.length > 0 ? (
            <button type="button" className="rounded border border-border px-1.5 py-0.5 text-xs hover:bg-state-hover" title="Scroll to the next comment (c)" onClick={() => stepTo("[data-comment-anchor]", 1)}>
              Next comment
            </button>
          ) : null}
          {findingTotal > 0 ? (
            <button
              type="button"
              aria-pressed={showFindings}
              className={cn("rounded border border-border px-1.5 py-0.5 text-xs hover:bg-state-hover", showFindings && "bg-state-active text-foreground")}
              title={showFindings ? "Hide the review's findings in the diff" : "Show the review's findings in the diff"}
              onClick={() => pageUi.set({ showFindings: !showFindings })}
            >
              {findingTotal} finding{findingTotal === 1 ? "" : "s"}
            </button>
          ) : null}
          <span className="ml-auto inline-flex items-center gap-2 tabular-nums">
            {diff.files.filter((entry) => viewed.has(entry.path)).length} of {diff.files.length} viewed
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span className="block h-full bg-emerald-500 transition-[width]" style={{ width: `${(diff.files.filter((entry) => viewed.has(entry.path)).length / diff.files.length) * 100}%` }} />
            </span>
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {!treeOpen ? (
          <div className="hidden w-7 shrink-0 flex-col items-center border-r border-border pt-1 md:flex">
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground" aria-label="Show file list" title="Show file list" onClick={() => setTreeOpen(true)}>
              <Icon name="ChevronDown" className="size-3.5 -rotate-90" />
            </button>
            {diff !== null ? <span className="mt-1 text-[10px] tabular-nums text-muted-foreground">{diff.files.length}</span> : null}
          </div>
        ) : null}
        <aside className={cn("relative hidden shrink-0 flex-col border-r border-border md:flex", !treeOpen && "md:hidden")} style={{ width: treeWidth }}>
          <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">Files{diff !== null ? ` · ${diff.files.length}` : ""}</span>
            <button type="button" className="rounded p-0.5 hover:bg-state-hover hover:text-foreground" aria-label="Hide file list" title="Hide file list" onClick={() => setTreeOpen(false)}>
              <Icon name="ChevronDown" className="size-3.5 rotate-90" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {diff === null ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
          ) : (
            <FileTree
              files={diff.files}
              activePath={activePath}
              viewed={viewed}
              commentCount={(path) => forPath(path).filter((comment) => comment.addressedAt === null).length}
              findingCount={(path) => findingsByPath.get(path)?.length ?? 0}
              risk={(path) => riskByPath.get(path) ?? null}
              changedSince={(path) => changedRangesByPath.has(path)}
              onSelect={jumpTo}
            />
          )}
          {diff?.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground">File list truncated.</p> : null}
          </div>
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file list"
          title="Drag to resize the file list; double-click to reset"
          className={cn("hidden w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/40 active:bg-primary/60 md:block", !treeOpen && "md:hidden")}
          onPointerDown={startTreeResize}
          onDoubleClick={() => {
            setTreeWidth(FILE_TREE_DEFAULT_WIDTH);
            try {
              window.localStorage.setItem("kanban:fileTreeWidth", String(FILE_TREE_DEFAULT_WIDTH));
            } catch {
              // ignore
            }
          }}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1">
        <main ref={mainRef} onScroll={trackActive} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {diff !== null && diff.files.length > 0 ? (
            <TourPanel tour={tour} busy={tourBusy} onGenerate={() => void generateTour()} onJump={jumpTo} onOpenThread={onOpenThread} files={diff.files} />
          ) : null}
          {delta !== null && delta.files.length > 0 ? (
            <section className="border-b border-border px-3 py-1 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">Since you last looked</span>
                <span className="text-muted-foreground">
                  {shortSha(delta.fromSha)} → {shortSha(delta.toSha)} · {delta.files.length} file{delta.files.length === 1 ? "" : "s"} changed
                  {newFindingCount > 0 ? ` · ${newFindingCount} new finding${newFindingCount === 1 ? "" : "s"}` : ""}
                  {touchedFindingCount > 0 ? ` · ${touchedFindingCount} finding${touchedFindingCount === 1 ? "" : "s"} touched` : ""}
                </span>
                {delta.files.slice(0, 8).map((file) => (
                  <button key={file.path} type="button" className="rounded border border-sky-500/40 px-1.5 py-px font-mono text-[11px] text-sky-700 hover:bg-sky-500/15 dark:text-sky-300" title={file.path} onClick={() => jumpTo(file.path)}>
                    {file.path.split("/").pop()}
                  </button>
                ))}
                {delta.files.length > 8 ? <span className="text-muted-foreground">+{delta.files.length - 8} more</span> : null}
                {ticket !== null && ticket.pr !== null ? (
                  <button
                    type="button"
                    className="ml-auto rounded border border-border px-1.5 py-0.5 hover:bg-state-hover disabled:opacity-50"
                    disabled={reviewing || ticket.latestReview?.status === "running"}
                    title="Run the code-review skill on just the commits since the last completed review"
                    onClick={() => void rereview()}
                  >
                    {ticket.latestReview?.status === "running" ? "Review running…" : "Re-review the delta"}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}
          {diff !== null && diff.files.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No changes.</p> : null}
          {diff?.files.map((file) => {
            const isCollapsed = collapsed.has(file.path);
            return (
              <section
                key={file.path}
                ref={(node) => {
                  if (node === null) sectionRefs.current.delete(file.path);
                  else sectionRefs.current.set(file.path, node);
                }}
                className="border-b border-border"
              >
                <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(COMPACT, "px-1.5")}
                    onClick={() => toggleCollapsed(file.path)}
                    aria-label={isCollapsed ? "Expand file" : "Collapse file"}
                    aria-expanded={!isCollapsed}
                  >
                    <Icon name="ChevronDown" className={cn("size-3.5 transition-transform", isCollapsed && "-rotate-90")} />
                  </Button>
                  <code className="min-w-0 flex-1 truncate text-xs">
                    {file.previousPath !== null ? `${file.previousPath} → ` : ""}
                    {file.path}
                  </code>
                  {file.status !== "modified" ? <Badge>{file.status}</Badge> : null}
                  {isGeneratedPath(file.path) ? (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground" title="Looks generated or vendored; collapsed by default">
                      generated
                    </span>
                  ) : null}
                  <span className="text-xs tabular-nums text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                  <span className="text-xs tabular-nums text-red-600 dark:text-red-400">−{file.deletions}</span>
                  <Button type="button" variant="secondary" className={COMPACT} onClick={() => setComposer({ path: file.path, line: null, side: "RIGHT" })}>
                    <Icon name="MessageSquare" className="size-3.5" />
                    Comment on file
                  </Button>
                  <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
                    <Checkbox checked={viewed.has(file.path)} onCheckedChange={(checked) => markViewed(file.path, checked === true)} aria-label={`Mark ${file.path} as viewed`} />
                    Viewed
                  </label>
                </div>
                {isCollapsed
                  ? null
                  : (findingsByPath.get(file.path) ?? [])
                      .filter((entry) => entry.line === null)
                      .map((entry) => (
                        <div key={entry.item.finding.id} className="px-3">
                          <FindingAnnotation item={entry.item} onToggle={(selected) => toggleFinding(entry.item, selected)} onEdit={(edit) => editFinding(entry.item, edit)} />
                        </div>
                      ))}
                {isCollapsed ? null : (
                  <LazyMount root={mainRef} estimateLines={file.additions + file.deletions + 6}>
                    {() =>
                      file.patch !== null && diffMode === "structural" ? (
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
                          findings={findingsByPath.get(file.path) ?? []}
                          onToggleFinding={toggleFinding}
                          onEditFinding={editFinding}
                          onEditComment={editComment}
                          explanations={explanations.filter((entry) => entry.path === file.path)}
                          onExplain={(side, startLine, endLine) => explainHunk(file.path, side, startLine, endLine)}
                          semantics={semanticsByPath.get(file.path) ?? []}
                          changedRanges={changedRangesByPath.get(file.path) ?? []}
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
                            wrap={diffWrap}
                            findings={findingsByPath.get(file.path) ?? []}
                            onToggleFinding={toggleFinding}
                            onEditFinding={editFinding}
                            onEditComment={editComment}
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
                                <DiffCommentItem key={comment.id} comment={comment} onDelete={() => void deleteComment(comment.id)} onEdit={(body) => editComment(comment.id, body)} />
                              ))}
                            </ul>
                          ) : null}
                          <p className="p-4 text-sm text-muted-foreground">No text diff for this file (binary or too large).</p>
                        </>
                      )
                    }
                  </LazyMount>
                )}
              </section>
            );
          })}
        </main>
        {markers.length > 0 ? (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-2" aria-hidden="true">
            {markers.map((marker, index) => (
              <button
                key={index}
                type="button"
                tabIndex={-1}
                className={cn("pointer-events-auto absolute right-0 h-1 w-2 rounded-l-sm", marker.pending ? "bg-amber-500" : "bg-muted-foreground/50")}
                style={{ top: `calc(${marker.fraction * 100}% - 2px)` }}
                title={marker.pending ? "Pending comment" : "Comment"}
                onClick={() => scrollMainTo(marker.element)}
              />
            ))}
          </div>
        ) : null}
        </div>
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
      defaultOpen
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
                  <span>One thread per subtask ({unstarted.length})</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={cn(MENU_ITEM_CLASS, "items-start")}
                  onSelect={() => void run(() => rpc.call("ticket_start_children", { id: ticket.id, mode: "sequential" }), "Subtask thread started")}
                >
                  <Icon name="ListTodo" className="mt-0.5 size-4 text-muted-foreground" />
                  <span>One thread, in order ({open.length})</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </div>
      {guidanceOpen ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
          <textarea
            autoFocus
            value={guidance}
            rows={2}
            onChange={(event) => setGuidance(event.target.value)}
            placeholder="Guidance for the split (optional)"
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
                placeholder="e.g. We need to move billing to the new payments service, the dashboard still shows stale invoices, also someone should look at why the email worker drops…"
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
  const [showParentPicker, setShowParentPicker] = useState(false);
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
        <p className="text-xs text-muted-foreground" title={`${kindLabel} ${ticket.id} · ${columnName}`}>
          {ticket.pr !== null ? `${ticket.pr.repo.split("/")[1]}#${ticket.pr.number} · ${ticket.pr.state}` : ""}
          {ticket.jira !== null ? `${ticket.jira.key} · ${ticket.jira.status || "unknown"}` : ""}
          {ticket.pr === null && ticket.jira === null ? (parent !== null ? "Subtask" : kindLabel) : ""}
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
        {ticket.parentId !== null || showParentPicker ? (
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
        ) : null}
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
        defaultOpen
      >
        <textarea
          aria-label={ticket.kind === "adhoc" ? "Description" : "Notes"}
          value={description}
          rows={ticket.kind === "adhoc" ? 6 : 3}
          placeholder={ticket.kind === "adhoc" ? "What needs to happen?" : "Notes"}
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
          <span className="flex items-center gap-1">
            <Button type="button" variant="ghost" className={cn(COMPACT, "text-muted-foreground hover:text-destructive")} onClick={() => setConfirmDelete(true)}>
              <Icon name="Trash2" className="size-3.5" />
              Delete
            </Button>
            {ticket.parentId === null && !showParentPicker && parentOptions.length > 0 ? (
              <Button type="button" variant="ghost" className={cn(COMPACT, "text-muted-foreground")} onClick={() => setShowParentPicker(true)}>
                Nest under…
              </Button>
            ) : null}
          </span>
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
  const diffTicketId = diffSubjectFromSubPath(trimmed);
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
  const diffTicketId = diffSubjectFromSubPath(trimmed);
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
        <Button className={cn(COMPACT, "ml-1")} onClick={() => pageUi.set({ dialog: "new", newTicketColumn: null })}>
          <Icon name="Plus" className="size-3.5" />
          New card
        </Button>
      </div>
    );
  }
  if (diffTicketId !== null) {
    const ticket = findDiffSubjectTicket(board, diffTicketId);
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
        <button
          type="button"
          aria-pressed={ui.diffWrap}
          title={ui.diffWrap ? "Long lines wrap; click to scroll horizontally instead" : "Long lines scroll horizontally; click to wrap"}
          onClick={() => pageUi.set({ diffWrap: !ui.diffWrap })}
          className={cn("rounded-md border border-border px-2 py-0.5 text-xs", ui.diffWrap ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          Wrap
        </button>
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
    component: withErrorBoundary("board", BoardPage),
    headerContent: withErrorBoundary("header", BoardHeader),
    fixedTabs: [{ ...TICKET_TAB, title: "Card", icon: "PanelRight", component: withErrorBoundary("card panel", TicketTab), layout: "padded" }],
    experimental_sidebarAccessory: OpenCardCount,
  });
  app.slots.experimental_threadHeaderAction({
    id: "changes",
    title: "Kanban changes",
    component: withErrorBoundary("thread action", ThreadDiffAction),
  });
  app.slots.settingsSection({
    id: "github-sync",
    title: "GitHub sync",
    description: "Where PR cards come from and how the plugin authenticates.",
    component: withErrorBoundary("settings", SettingsSection),
  });
});
