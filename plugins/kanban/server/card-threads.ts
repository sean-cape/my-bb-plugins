import type { Column, Ticket } from "../shared/board";
import type { BoardStore } from "./board";
import type { KanbanContext } from "./context";
import { prShortName } from "./github";
import { threadTitle } from "./util";

/** The thread behind each card: starting it, prompting it, and linking existing threads. */
export function createCardThreads(ctx: KanbanContext, { board }: { board: BoardStore }) {
  const { bb, stmts, publish } = ctx;
  const { getTicket, getColumns } = board;

  function threadPrompt(ticket: Ticket, columns: Column[]): string {
    const columnList = columns.map((column) => `\`${column.id}\` (${column.name})`).join(", ");
    const footer = [
      "",
      `This thread is kanban ticket ${ticket.id}. Columns: ${columnList}.`,
      "Move the card as the work progresses with `bb kanban move <column-id>` (it finds this thread's card automatically).",
      "Do not post comments or reviews on GitHub unless the user explicitly asks.",
    ].join("\n");
    if (ticket.jira !== null) {
      const body = ticket.description.trim();
      return [
        `This thread tracks Jira issue ${ticket.jira.key}: "${ticket.title}" (${ticket.jira.url}). Type: ${ticket.jira.issueType || "unknown"}; status: ${ticket.jira.status || "unknown"}.`,
        "",
        body === "" ? "(The issue has no description.)" : body,
        "",
        "Read the relevant code to understand what the issue asks for, propose a short plan, and wait for the user before changing anything. Do not update the Jira issue.",
        footer,
      ].join("\n");
    }
    if (ticket.pr === null) {
      const body = ticket.description.trim();
      const parent = ticket.parentId === null ? null : stmts.byId.get(ticket.parentId);
      const context = parent === undefined || parent === null ? "" : `\n\nThis is a subtask of "${parent.title}" (ticket ${parent.id}). Keep the change scoped to this subtask.`;
      return `${ticket.title}${body === "" ? "" : `\n\n${body}`}${context}\n${footer}`;
    }
    const { repo, number, role } = ticket.pr;
    if (role === "other") {
      return [
        `You were asked to look at pull request ${repo}#${number}: "${ticket.title}" (${ticket.pr.url}).`,
        "",
        `1. Run \`gh pr view ${number} --repo ${repo}\` and \`gh pr diff ${number} --repo ${repo}\` to read the description and the change.`,
        "2. Review it for correctness, edge cases, and anything risky. Be concise and concrete; cite file paths.",
        "3. Summarize your findings here and stop. The user decides what to post.",
        footer,
      ].join("\n");
    }
    return [
      `This thread tracks your pull request ${repo}#${number}: "${ticket.title}" (${ticket.pr.url}).`,
      "",
      `1. Run \`gh pr view ${number} --repo ${repo} --json state,isDraft,reviewDecision,mergeable,statusCheckRollup,reviews,comments\` and \`gh pr checks ${number} --repo ${repo}\`.`,
      "2. Give a short status: CI, review decision, unresolved review comments, merge conflicts.",
      "3. If something needs action (failing checks, requested changes), say what and wait for instructions before changing code.",
      footer,
    ].join("\n");
  }

  async function spawnThreadForTicket(ticketId: string, projectId: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    if (ticket.threadId !== null) return ticket;
    const columns = await getColumns();
    const title =
      ticket.pr !== null
        ? `${prShortName(ticket.pr)}: ${ticket.title}`
        : ticket.jira !== null
          ? `${ticket.jira.key}: ${ticket.title}`
          : ticket.title;
    const parentThreadId = ticket.parentId === null ? null : (stmts.byId.get(ticket.parentId)?.thread_id ?? null);
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      prompt: threadPrompt(ticket, columns),
      title: threadTitle(title),
      ...(parentThreadId === null ? {} : { parentThreadId }),
      pluginMetadata: { ticketId: ticket.id },
    });
    stmts.setThread.run(thread.id, projectId, Date.now(), ticket.id);
    publish();
    return getTicket(ticket.id);
  }

  /** Start a thread for a card, or send a prompt into its existing thread. */
  async function promptTicketThread(ticket: Ticket, projectId: string, prompt: string, title: string, role: string): Promise<Ticket> {
    if (ticket.threadId !== null) {
      await bb.sdk.threads.send({ threadId: ticket.threadId, mode: "auto", input: [{ type: "text", text: prompt, mentions: [] }] });
      return ticket;
    }
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      prompt,
      title: threadTitle(title),
      pluginMetadata: { ticketId: ticket.id, role },
    });
    stmts.setThread.run(thread.id, projectId, Date.now(), ticket.id);
    publish();
    return getTicket(ticket.id);
  }

  async function linkThread(ticketId: string, threadId: string): Promise<Ticket> {
    const ticket = getTicket(ticketId);
    const thread = await bb.sdk.threads.get({ threadId });
    stmts.setThread.run(thread.id, thread.projectId, Date.now(), ticket.id);
    try {
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        pluginId: bb.pluginId,
        set: { ticketId: ticket.id },
      });
    } catch (error) {
      bb.log.warn(`could not tag thread ${threadId} with ticket ${ticket.id}: ${String(error)}`);
    }
    publish();
    return getTicket(ticket.id);
  }

  /** The machine the project's checkout lives on; a worktree is created there. */
  async function projectHostId(projectId: string): Promise<string> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error(`No project with id ${projectId}`);
    const source = project.sources.find((candidate) => candidate.isDefault) ?? project.sources[0];
    if (source === undefined) throw new Error(`Project ${project.name} has no checkout to create a worktree in`);
    return source.hostId;
  }

  /** A new managed worktree off the default branch, on the machine that holds the project's checkout. */
  async function freshWorktree(projectId: string) {
    return {
      type: "host" as const,
      hostId: await projectHostId(projectId),
      workspace: { type: "managed-worktree" as const, baseBranch: { kind: "default" as const } },
    };
  }

  /**
   * What a worker thread the board starts for a card (checks, classify, review, narrative) takes from the card's
   * thread. It isn't that thread's child, because bb posts a child's final message into its parent, and the card's
   * thread took each one as work to do and reported ready again mid-review. So it is owned by the card's thread
   * instead, archived and deleted with it, and runs the provider and options a child would have inherited.
   */
  async function workerOptions(ticket: Ticket) {
    if (ticket.threadId === null) return {};
    const thread = await bb.sdk.threads.get({ threadId: ticket.threadId });
    let execution: Awaited<ReturnType<typeof bb.sdk.threads.defaultExecutionOptions>> = null;
    try {
      execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id });
    } catch (error) {
      bb.log.warn(`could not read the execution options of thread ${thread.id}: ${String(error)}`);
    }
    return {
      providerId: thread.providerId,
      // Only a live thread can own another.
      ...(thread.archivedAt === null ? { lifecycleOwnerThreadId: thread.id } : {}),
      ...(execution === null ? {} : { model: execution.model, permissionMode: execution.permissionMode, reasoningLevel: execution.reasoningLevel, serviceTier: execution.serviceTier }),
    };
  }

  return { spawnThreadForTicket, promptTicketThread, linkThread, projectHostId, freshWorktree, workerOptions };
}

export type CardThreads = ReturnType<typeof createCardThreads>;

/** Where a spawned thread runs: a fresh worktree, or an existing environment that already has the code checked out. */
export type ThreadEnvironment = Awaited<ReturnType<CardThreads["freshWorktree"]>> | { type: "reuse"; environmentId: string };
