import type { Ticket } from "../shared/board";
import type { Dump, ProposedTicket } from "../shared/dump";
import type { LoopGates } from "../shared/loop";
import { parseProposal } from "./agent-output";
import { initialColumn, type BoardStore } from "./board";
import type { CardThreads } from "./card-threads";
import type { KanbanContext } from "./context";
import { rowToDump } from "./db/rows";
import { errorMessage, shortId } from "./util";

const PROPOSAL_FORMAT = [
  "Reply with a short plain-language summary, then end your message with exactly one fenced block:",
  "```json kanban-proposal",
  '{ "version": 1, "summary": "<one paragraph>", "tickets": [ { "id": "T1", "title": "<imperative, ≤ 80 chars>", "description": "<what, why, what done looks like, files or areas involved>", "tags": ["<lowercase-tag>"], "subtasks": [ { "title": "...", "description": "..." } ], "dependsOn": ["T2"], "estimate": "S" | "M" | "L" } ], "questions": [ { "id": "Q1", "question": "<what you need to know>", "why": "<what changes depending on the answer>", "affects": ["T1"], "options": ["<plausible answer>", "..."] } ] }',
  "```",
  "Rules: one ticket per independently shippable piece of work; split anything bigger than a day into subtasks; put real uncertainties in `questions` instead of guessing (but do not ask about things the code answers); keep ids stable across revisions. Do not create cards yourself and do not start any work.",
].join("\n");

function dumpPrompt(dump: Dump): string {
  return [
    "The user dictated the following stream of tasks and thoughts. Turn it into a proposed set of Kanban tickets.",
    "",
    "Read the relevant parts of this project first, so titles, scopes, and the questions you raise are grounded in the actual code.",
    "",
    "---- dictation ----",
    dump.text.trim(),
    "---- end ----",
    "",
    PROPOSAL_FORMAT,
  ].join("\n");
}

function refinePrompt(dump: Dump, answers: Record<string, string>, notes: string): string {
  const questions = dump.proposal?.questions ?? [];
  const answered = Object.entries(answers)
    .filter(([, answer]) => answer.trim() !== "")
    .map(([id, answer]) => `- ${id} (${questions.find((question) => question.id === id)?.question ?? "?"}): ${answer.trim()}`);
  return [
    "Revise the proposal using the answers and notes below. Keep ticket ids stable where the ticket is unchanged; drop resolved questions and add new ones only if the answers raise them.",
    "",
    answered.length > 0 ? `Answers:\n${answered.join("\n")}` : "No questions were answered.",
    notes.trim() === "" ? "" : `\nNotes from the user:\n${notes.trim()}`,
    "",
    PROPOSAL_FORMAT,
  ].join("\n");
}

/** Brain dumps: a planning thread turns dictation into proposed cards the user edits and accepts. */
export function createDumps(ctx: KanbanContext, { board, threads }: { board: BoardStore; threads: CardThreads }) {
  const { bb, stmts, publish } = ctx;
  const { getTicket, getColumns, createTicket } = board;
  const { spawnThreadForTicket } = threads;

  async function archivePlanningThread(threadId: string | null): Promise<void> {
    if (threadId === null) return;
    try {
      await bb.sdk.threads.archive({ threadId });
    } catch (error) {
      bb.log.warn(`could not archive planning thread ${threadId}: ${String(error)}`);
    }
  }

  async function createDump(text: string, projectId: string): Promise<Dump> {
    const now = Date.now();
    const id = shortId();
    stmts.insertDump.run({ id, text, project_id: projectId, thread_id: null, created_at: now, updated_at: now });
    const dump = rowToDump(stmts.dumpById.get(id)!);
    try {
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        prompt: dumpPrompt(dump),
        title: `Plan: ${text.trim().split("\n")[0]!.slice(0, 80)}`,
        pluginMetadata: { dumpId: id, role: "plan" },
      });
      stmts.setDumpThread.run(thread.id, Date.now(), id);
    } catch (error) {
      stmts.setDumpFailed.run(errorMessage(error), Date.now(), id);
    }
    publish();
    return rowToDump(stmts.dumpById.get(id)!);
  }

  async function refineDump(id: string, answers: Record<string, string>, notes: string): Promise<Dump> {
    const row = stmts.dumpById.get(id);
    if (row === undefined) throw new Error(`No brain dump with id ${id}`);
    if (row.thread_id === null) throw new Error("This dump has no planning thread; start a new one");
    if (row.status === "planning") throw new Error("The planning thread is still working");
    const dump = rowToDump(row);
    await bb.sdk.threads.send({ threadId: row.thread_id, mode: "auto", input: [{ type: "text", text: refinePrompt(dump, answers, notes), mentions: [] }] });
    stmts.setDumpPlanning.run(JSON.stringify(answers), Date.now(), id);
    publish();
    return rowToDump(stmts.dumpById.get(id)!);
  }

  /** `monitored` and `gates` are each card's own, as for `ticket_create`; absent, the tags' monitoring default and the kind's gates decide. */
  async function finalizeDump(
    id: string,
    proposed: ProposedTicket[],
    columnId: string | undefined,
    { startThreads, monitored, gates }: { startThreads: boolean; monitored?: boolean; gates?: LoopGates },
  ): Promise<{ dump: Dump; tickets: Ticket[] }> {
    const row = stmts.dumpById.get(id);
    if (row === undefined) throw new Error(`No brain dump with id ${id}`);
    if (row.status === "done" || row.status === "discarded") throw new Error("This dump was already closed");
    const columns = await getColumns();
    const target = columnId !== undefined && columns.some((column) => column.id === columnId) ? columnId : initialColumn(columns, null);
    const created: Ticket[] = [];
    for (const item of proposed) {
      const ticket = createTicket({
        title: item.title.trim(),
        description: item.description.trim(),
        columnId: target,
        kind: "adhoc",
        tags: item.tags,
        threadId: null,
        projectId: row.project_id,
        pr: null,
        ...(monitored === undefined ? {} : { monitored }),
        ...(gates === undefined ? {} : { gates }),
      });
      for (const sub of item.subtasks) {
        createTicket({
          title: sub.title.trim(),
          description: sub.description.trim(),
          columnId: target,
          kind: "adhoc",
          tags: item.tags,
          threadId: null,
          projectId: row.project_id,
          pr: null,
          parentId: ticket.id,
        });
      }
      created.push(getTicket(ticket.id));
    }
    stmts.setDumpDone.run(JSON.stringify(created.map((ticket) => ticket.id)), Date.now(), id);
    publish();
    await archivePlanningThread(row.thread_id);
    if (startThreads) {
      for (const ticket of created) {
        try {
          await spawnThreadForTicket(ticket.id, row.project_id);
        } catch (error) {
          bb.log.warn(`could not start a thread for ${ticket.id}: ${String(error)}`);
        }
      }
    }
    return { dump: rowToDump(stmts.dumpById.get(id)!), tickets: created.map((ticket) => getTicket(ticket.id)) };
  }

  async function discardDump(id: string): Promise<Dump> {
    const row = stmts.dumpById.get(id);
    if (row === undefined) throw new Error(`No brain dump with id ${id}`);
    stmts.setDumpDiscarded.run(Date.now(), id);
    publish();
    await archivePlanningThread(row.thread_id);
    return rowToDump(stmts.dumpById.get(id)!);
  }

  function listDumps(includeClosed: boolean): { dumps: Dump[] } {
    return { dumps: (includeClosed ? stmts.dumpsAll.all() : stmts.dumpsOpen.all()).map(rowToDump) };
  }

  /** The planning thread went idle: capture its proposal, or why there is none. */
  function handleIdle(threadId: string, lastAssistantText: string | null): boolean {
    const dumpRow = stmts.dumpByThread.get(threadId);
    if (dumpRow !== undefined && dumpRow.status === "planning") {
      const proposal = parseProposal(lastAssistantText);
      if (proposal === null) {
        stmts.setDumpFailed.run(
          lastAssistantText === null ? "The planning thread ended without a proposal." : `The planning thread replied without a kanban-proposal block. Its last message:\n\n${lastAssistantText.slice(0, 2000)}`,
          Date.now(),
          dumpRow.id,
        );
      } else {
        stmts.setDumpProposal.run(JSON.stringify(proposal), Date.now(), dumpRow.id);
      }
      publish();
      return true;
    }
    return false;
  }

  return { createDump, refineDump, finalizeDump, discardDump, listDumps, handleIdle };
}

export type Dumps = ReturnType<typeof createDumps>;
