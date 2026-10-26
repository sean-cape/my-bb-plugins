import { z } from "zod";
import { DEFAULT_COLUMNS, DEFAULT_SOURCES, PRE_LOOP_DEFAULT_COLUMNS, columnSchema, sourceSchema, type Column, type JiraIssue, type PullRequest, type Source, type Ticket } from "../shared/board";
import { COLUMN, doneColumnId } from "../shared/columns";
import type { DiffCommentTarget } from "../shared/comments";
import type { Review } from "../shared/review";
import type { KanbanContext } from "./context";
import { rowToComment, rowToReview, rowToTicket, type TicketRow } from "./db/rows";
import { defaultGates, INITIAL_LOOP_STATE, type LoopGates } from "../shared/loop";
import { reduce } from "./loop/reducer";
import type { Spend } from "./spend/spend";
import { errorMessage, normalizeTags, parseStringArray, shortId } from "./util";

/** Columns a brand-new card lands in, by what the card is. */
export function initialColumn(columns: Column[], pr: PullRequest | null, jira: JiraIssue | null = null): string {
  const ids = new Set(columns.map((column) => column.id));
  const pick = (...preferred: string[]) =>
    preferred.find((id) => ids.has(id)) ?? columns[0]!.id;
  if (jira !== null) {
    if (jira.statusCategory === "done") return pick(COLUMN.done);
    if (jira.statusCategory === "indeterminate") return pick(COLUMN.inProgress, COLUMN.todo);
    return pick(COLUMN.todo, COLUMN.backlog);
  }
  if (pr === null) return pick(COLUMN.backlog, COLUMN.todo);
  if (pr.state === "merged" || pr.state === "closed") return pick(COLUMN.done);
  // Every new PR card, authored or review-requested, starts as work to do.
  return pick(COLUMN.todo, COLUMN.backlog);
}

/** Columns are never empty: storage falls back to the defaults and `columns_set` requires one. */
export function doneColumn(columns: Column[]): string {
  return doneColumnId(columns)!;
}

/** Names for loop columns a board gets back or gains; columns it already has keep their own names. */
const LOOP_COLUMN_NAMES: Record<string, string> = Object.fromEntries(DEFAULT_COLUMNS.map((column) => [column.id, column.name]));

/**
 * The board with every column the review loop moves cards to: a missing `review` goes before the column finished
 * cards go to, a missing `in-progress` before the loop's later columns, and `checking` just before `review`. The same
 * array when nothing is missing.
 */
export function withLoopColumns(columns: Column[]): Column[] {
  const next = [...columns];
  const has = (id: string) => next.some((column) => column.id === id);
  const insertBefore = (id: string, before: string | undefined) => {
    const at = before === undefined ? -1 : next.findIndex((column) => column.id === before);
    next.splice(at === -1 ? next.length : at, 0, { id, name: LOOP_COLUMN_NAMES[id]! });
  };
  if (!has(COLUMN.review)) insertBefore(COLUMN.review, next.length > 1 ? doneColumnId(next)! : undefined);
  if (!has(COLUMN.inProgress)) insertBefore(COLUMN.inProgress, has(COLUMN.checking) ? COLUMN.checking : COLUMN.review);
  if (!has(COLUMN.checking)) insertBefore(COLUMN.checking, COLUMN.review);
  return next.length === columns.length ? columns : next;
}

/** Tables whose rows belong to one card through `ticket_id` and go with it when it's deleted. */
const TICKET_TABLES = ["reviews", "pr_comments", "comment_applies", "diff_comments", "diff_viewed", "narratives", "hunk_explanations", "checks_runs", "classify_runs"] as const;
/** How long a deleted card can still be put back. */
const DELETED_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

interface DeletedTicket {
  ticket: TicketRow;
  children: string[];
  rows: Partial<Record<(typeof TICKET_TABLES)[number], Row[]>>;
}

/** Cards, columns, sources and tags: the board's own storage. */
export function createBoardStore(ctx: KanbanContext, { spend }: { spend: Spend }) {
  const { bb, db, stmts, publish } = ctx;

  function latestReviewFor(ticketId: string): Review | null {
    const row = stmts.latestReview.get(ticketId);
    return row === undefined ? null : rowToReview(row);
  }

  function commentCounts(row: TicketRow): Ticket["comments"] {
    if (row.kind !== "pr") return null;
    const comments = stmts.commentsForTicket.all(row.id).map(rowToComment);
    return {
      total: comments.length,
      open: comments.filter((comment) => comment.addressedAt === null && !comment.mine).length,
      selected: comments.filter((comment) => comment.selected).length,
    };
  }

  let reviewTagCache = "pr-reviews";
  let monitorTagsCache = new Set<string>();
  function canPostToGithub(row: TicketRow): boolean {
    return row.kind === "pr" && row.pr_repo !== null && row.pr_number !== null;
  }

  function defaultCommentTarget(row: TicketRow): DiffCommentTarget {
    return canPostToGithub(row) && parseStringArray(row.tags).includes(reviewTagCache) ? "github" : "local";
  }

  let doneColumnCache: string = COLUMN.done;
  function childCounts(row: TicketRow): Ticket["children"] {
    const children = stmts.childrenOf.all(row.id);
    return {
      total: children.length,
      done: children.filter((child) => child.column_id === doneColumnCache).length,
      withThread: children.filter((child) => child.thread_id !== null).length,
    };
  }

  function hydrate(row: TicketRow): Ticket {
    return rowToTicket(row, latestReviewFor(row.id), commentCounts(row), {
      pendingDiffComments: stmts.pendingDiffCommentCount.get(row.id)?.n ?? 0,
      canPostToGithub: canPostToGithub(row),
      defaultCommentTarget: defaultCommentTarget(row),
      children: childCounts(row),
      spend: spend.spendOf(row.id),
      checksThreadId: stmts.runningChecksRuns.all(row.id)[0]?.thread_id ?? null,
      classifyThreadId: stmts.runningClassifyRuns.all(row.id)[0]?.thread_id ?? null,
    });
  }

  /** Walk up from `parentId`; true when `id` is an ancestor (or the same card), which would make a cycle. */
  function wouldCycle(id: string, parentId: string): boolean {
    let current: string | null = parentId;
    for (let depth = 0; current !== null && depth < 64; depth += 1) {
      if (current === id) return true;
      current = stmts.byId.get(current)?.parent_id ?? null;
    }
    return false;
  }

  function setParent(id: string, parentId: string | null): Ticket {
    getTicket(id);
    if (parentId !== null) {
      if (stmts.byId.get(parentId) === undefined) throw new Error(`No ticket with id ${parentId}`);
      if (wouldCycle(id, parentId)) throw new Error("A card cannot be nested inside itself or one of its own subtasks");
    }
    stmts.setParent.run(parentId, Date.now(), id);
    publish();
    return getTicket(id);
  }

  async function getColumns(): Promise<Column[]> {
    const stored = await bb.storage.kv.get<Column[]>("columns");
    const parsed = z.array(columnSchema).min(1).safeParse(stored);
    const columns = parsed.success ? parsed.data : DEFAULT_COLUMNS;
    doneColumnCache = doneColumn(columns);
    return columns;
  }

  async function getSources(): Promise<Source[]> {
    const stored = await bb.storage.kv.get<Source[]>("sources");
    const parsed = z.array(sourceSchema).safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_SOURCES;
  }

  function allTags(): string[] {
    const tags = new Set<string>();
    for (const row of stmts.all.all()) for (const tag of parseStringArray(row.tags)) tags.add(tag);
    return [...tags].sort();
  }

  function setTags(id: string, tags: readonly string[]): Ticket {
    stmts.setTags.run(JSON.stringify(normalizeTags(tags)), Date.now(), id);
    publish();
    return getTicket(id);
  }

  function setDueDate(id: string, dueDate: string | null): Ticket {
    getTicket(id);
    stmts.setDueDate.run(dueDate, Date.now(), id);
    publish();
    return getTicket(id);
  }

  function getTicket(id: string): Ticket {
    const row = stmts.byId.get(id);
    if (row === undefined) throw new Error(`No ticket with id ${id}`);
    return hydrate(row);
  }

  function nextPosition(columnId: string): number {
    return (stmts.maxPosition.get(columnId)?.max ?? 0) + 1;
  }

  function moveTicket(id: string, columnId: string, index: number | null): Ticket {
    const now = Date.now();
    const move = db.transaction(() => {
      const current = stmts.byId.get(id);
      if (current === undefined) throw new Error(`No ticket with id ${id}`);
      const siblings = stmts.inColumn
        .all(columnId)
        .filter((row) => row.id !== id);
      const at = index === null ? siblings.length : Math.min(index, siblings.length);
      siblings.splice(at, 0, current);
      siblings.forEach((row, position) => {
        if (row.id === id) stmts.setColumn.run({ column_id: columnId, position: position + 1, now, id });
        else if (row.position !== position + 1) stmts.setPosition.run(position + 1, row.id);
      });
    });
    move();
    publish();
    return getTicket(id);
  }

  function createTicket(input: {
    title: string;
    description: string;
    columnId: string;
    kind: Ticket["kind"];
    tags?: readonly string[];
    sourceId?: string | null;
    threadId: string | null;
    projectId: string | null;
    pr: PullRequest | null;
    jira?: JiraIssue | null;
    parentId?: string | null;
    dueDate?: string | null;
    /** The card's own monitoring flag, which wins over the defaults; absent, its tags decide. */
    monitored?: boolean;
    /** The gates a monitored card runs with; absent, its kind picks the defaults. */
    gates?: LoopGates;
  }): Ticket {
    const now = Date.now();
    const id = shortId();
    stmts.insert.run({
      id,
      title: input.title,
      description: input.description,
      column_id: input.columnId,
      kind: input.kind,
      tags: JSON.stringify(normalizeTags(input.tags ?? [])),
      source_id: input.sourceId ?? null,
      thread_id: input.threadId,
      project_id: input.projectId,
      parent_id: input.parentId ?? null,
      pr_repo: input.pr?.repo ?? null,
      pr_number: input.pr?.number ?? null,
      pr_url: input.pr?.url ?? null,
      pr_role: input.pr?.role ?? null,
      pr_state: input.pr?.state ?? null,
      pr_author: input.pr?.author ?? null,
      pr_updated_at: input.pr?.updatedAt ?? null,
      pr_head_ref: input.pr?.headRef ?? null,
      pr_checks: input.pr?.checks ?? null,
      pr_checks_url: input.pr?.checksUrl ?? null,
      pr_body: input.pr?.body ?? null,
      jira_key: input.jira?.key ?? null,
      jira_url: input.jira?.url ?? null,
      jira_status: input.jira?.status ?? null,
      jira_status_category: input.jira?.statusCategory ?? null,
      jira_issue_type: input.jira?.issueType ?? null,
      jira_priority: input.jira?.priority ?? null,
      jira_assignee: input.jira?.assignee ?? null,
      jira_updated_at: input.jira?.updatedAt ?? null,
      due_date: input.dueDate ?? null,
      position: nextPosition(input.columnId),
      created_at: now,
      updated_at: now,
    });
    const tags = normalizeTags(input.tags ?? []);
    if (input.monitored ?? tags.some((tag) => monitorTagsCache.has(tag))) {
      // A new card has no thread to tell, so the monitor event's only other action is the columns.
      const state = reduce(INITIAL_LOOP_STATE, { type: "monitor", hasThread: false, gates: input.gates ?? defaultGates(input.kind) }).state;
      stmts.setLoopState.run(JSON.stringify({ ...state, phaseSince: now }), id);
      ensureLoopColumns().catch((error: unknown) => bb.log.warn(`could not add the review loop's columns: ${errorMessage(error)}`));
    }
    return getTicket(id);
  }

  function setMonitorTags(raw: string): void {
    monitorTagsCache = new Set(normalizeTags(raw.split(",")));
  }

  function setReviewTag(raw: string): void {
    reviewTagCache = normalizeTags([raw])[0] ?? "pr-reviews";
  }

  function updateText(id: string, title: string | undefined, description: string | undefined): Ticket {
    const current = getTicket(id);
    // Sync keeps a title the user has changed instead of taking the PR's or issue's again.
    const edited = title !== undefined && title !== current.title ? 1 : 0;
    stmts.setText.run(title ?? current.title, edited, description ?? current.description, Date.now(), id);
    publish();
    return getTicket(id);
  }

  function deleteTicket(id: string): { deleted: boolean } {
    const deleted = db.transaction(() => {
      const row = stmts.byId.get(id);
      if (row === undefined) return false;
      const now = Date.now();
      const snapshot: DeletedTicket = {
        ticket: row,
        children: stmts.childrenOf.all(id).map((child) => child.id),
        rows: Object.fromEntries(TICKET_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} WHERE ticket_id = ?`).all(id) as Row[]])),
      };
      stmts.forgetDeletedBefore.run(now - DELETED_KEPT_MS);
      stmts.saveDeleted.run(id, JSON.stringify(snapshot), now);
      // Subtasks outlive their parent as top-level cards rather than disappearing with it.
      stmts.detachChildren.run(now, id);
      stmts.deleteReviewsForTicket.run(id);
      stmts.deleteCommentsForTicket.run(id);
      stmts.deleteCommentAppliesForTicket.run(id);
      stmts.deleteDiffCommentsForTicket.run(id);
      stmts.deletePendingReview.run(id);
      stmts.deleteViewedForTicket.run(id);
      stmts.deleteNarrativesForTicket.run(id);
      stmts.deleteExplanationsForTicket.run(id);
      stmts.deleteChecksRunsForTicket.run(id);
      stmts.deleteClassifyRunsForTicket.run(id);
      stmts.remove.run(id);
      return true;
    })();
    if (deleted) publish();
    return { deleted };
  }

  /** Puts a deleted card back as it was, subtasks included. False when it can't come back, such as sync having already made a new card for its PR or issue. */
  function restoreTicket(id: string): { restored: boolean } {
    const restored = db.transaction(() => {
      const saved = stmts.deletedById.get(id);
      if (saved === undefined || stmts.byId.get(id) !== undefined) return false;
      const { ticket, children, rows } = JSON.parse(saved.snapshot) as DeletedTicket;
      if (ticket.pr_repo !== null && ticket.pr_number !== null && stmts.byPr.get(ticket.pr_repo, ticket.pr_number) !== undefined) return false;
      if (ticket.jira_key !== null && stmts.byJira.get(ticket.jira_key) !== undefined) return false;
      const parentId = ticket.parent_id !== null && stmts.byId.get(ticket.parent_id) !== undefined ? ticket.parent_id : null;
      insertRow("tickets", { ...ticket, parent_id: parentId });
      for (const table of TICKET_TABLES) for (const row of rows[table] ?? []) insertRow(table, row);
      const now = Date.now();
      for (const child of children) {
        if (!wouldCycle(child, id)) stmts.reattachChild.run(id, now, child);
      }
      stmts.forgetDeleted.run(id);
      return true;
    })();
    if (restored) publish();
    return { restored };
  }

  function insertRow(table: string, row: Row): void {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`).run(row);
  }

  async function setColumns(columns: Column[]): Promise<{ columns: Column[] }> {
    const ids = new Set<string>();
    for (const column of columns) {
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(column.id)) {
        throw new Error(`Column id "${column.id}" must be lowercase letters, digits, and dashes`);
      }
      if (ids.has(column.id)) throw new Error(`Duplicate column id "${column.id}"`);
      ids.add(column.id);
    }
    const previous = await getColumns();
    const fallback = columns[0]!.id;
    const now = Date.now();
    db.transaction(() => {
      for (const column of previous) {
        if (!ids.has(column.id)) stmts.moveColumn.run(fallback, now, now, column.id);
      }
    })();
    await bb.storage.kv.set("columns", columns);
    publish();
    return { columns };
  }

  /** Adds the columns the review loop needs to a board that lacks them; a no-op once it has them. */
  async function ensureLoopColumns(): Promise<void> {
    const columns = await getColumns();
    const next = withLoopColumns(columns);
    if (next === columns) return;
    await bb.storage.kv.set("columns", next);
    publish();
  }

  /**
   * A board in use that never saved its columns showed the defaults of its day; it keeps those names rather than
   * taking the loop's renamed defaults, which are for new boards.
   */
  async function keepPreLoopDefaults(): Promise<void> {
    if ((await bb.storage.kv.get("columns")) != null) return;
    if (stmts.all.all().length === 0) return;
    await bb.storage.kv.set("columns", PRE_LOOP_DEFAULT_COLUMNS);
  }

  return {
    hydrate,
    getTicket,
    createTicket,
    moveTicket,
    updateText,
    deleteTicket,
    restoreTicket,
    setParent,
    setTags,
    setDueDate,
    allTags,
    getColumns,
    setColumns,
    ensureLoopColumns,
    keepPreLoopDefaults,
    getSources,
    setReviewTag,
    setMonitorTags,
  };
}

export type BoardStore = ReturnType<typeof createBoardStore>;
