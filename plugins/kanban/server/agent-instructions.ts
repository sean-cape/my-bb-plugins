import { parseLoopState } from "../shared/loop";
import type { KanbanContext } from "./context";
import type { TicketRow } from "./db/rows";
import type { Statements } from "./db/statements";
import { builderContract } from "./loop/prompts";
import type { ProjectSettingsStore } from "./project-settings";

function ticketLabel(row: TicketRow): string {
  return `kanban ticket ${JSON.stringify(row.id)} (${JSON.stringify(row.title)})`;
}

/** Threads a card spawns for one job, keyed by the `role` in their plugin metadata; any other thread on a card gets the card's own instructions. */
const ROLE_INSTRUCTIONS = new Map<string, (row: TicketRow) => string>([
  [
    "review",
    (row) =>
      `This thread is a code review for ${ticketLabel(row)}. Review only; do not move the card and do not post to GitHub. Record the reviewed commit with \`bb kanban review-record --commit <sha>\` and end your final message with "Reviewed commit: <sha>".`,
  ],
  [
    "apply-comments",
    (row) =>
      `This thread addresses PR review comments for ${ticketLabel(row)} with the apply-pr-comments skill. Commit and push to the PR branch only, never force-push, never post to GitHub, and finish with \`bb kanban comments-applied --commit <sha>\`.`,
  ],
  [
    "apply",
    (row) =>
      `This thread applies a persisted code review to the PR of ${ticketLabel(row)}. Commit and push to the PR branch only, never force-push, never post to GitHub, and finish with \`bb kanban review-applied --commit <sha>\` (plus \`--skipped <ids>\` for findings you could not apply).`,
  ],
  [
    "checks",
    (row) =>
      `This thread re-runs the checks of ${ticketLabel(row)} at the commit its agent reported ready. Change, commit and push nothing, do not move the card, never post to GitHub, and record the result with \`bb kanban checks-record --exit-code <code> --output-file <path>\`.`,
  ],
  [
    "classify",
    (row) =>
      `This thread scores the risk of each file changed by ${ticketLabel(row)}, which picks how deep the board's review goes. Change, commit and push nothing, do not move the card, never post to GitHub, and end with the \`\`\`json kanban-classify block.`,
  ],
  [
    "subtasks",
    (row) =>
      `This thread works through the subtasks of ${ticketLabel(row)}: list them with \`bb kanban subtasks --ticket ${row.id}\`, move each with \`bb kanban move <column> --ticket <subtask-id>\` as you go, and never move or finish a subtask you did not actually complete.`,
  ],
]);

function cardInstructions(stmts: Statements, projectSettings: ProjectSettingsStore, row: TicketRow): string {
  const pr =
    row.pr_repo !== null && row.pr_number !== null
      ? ` It tracks GitHub PR ${JSON.stringify(`${row.pr_repo}#${row.pr_number}`)}.`
      : "";
  const parentRow = row.parent_id === null ? undefined : stmts.byId.get(row.parent_id);
  const parentNote = parentRow === undefined ? "" : ` It is a subtask of ${JSON.stringify(parentRow.title)} (ticket ${JSON.stringify(parentRow.id)}).`;
  const childCount = stmts.childrenOf.all(row.id).length;
  const childNote = childCount === 0 ? "" : ` It has ${childCount} subtask(s): \`bb kanban subtasks\` lists them; add more with \`bb kanban add "<title>" --parent ${row.id}\`.`;
  const dueNote = row.due_date === null ? "" : ` It is due ${row.due_date}.`;
  const loop = parseLoopState(row.loop_state);
  const workflow = loop.monitored
    ? builderContract(row.kind === "pr", projectSettings.projectSettings(row.project_id).checkCommand, loop.phase === "planning")
    : "When you start working move it with `bb kanban move in-progress`; when the work is finished and verified, `bb kanban move done`. Run `bb kanban columns` to see the available columns.";
  return [
    `This thread is kanban ticket ${JSON.stringify(row.id)} titled ${JSON.stringify(row.title)}, currently in column ${JSON.stringify(row.column_id)}.${pr}${dueNote}${parentNote}${childNote}`,
    workflow,
  ].join(" ");
}

/** Instructions injected into every thread a card, review, apply, checks, plan or subtask run owns; a monitored card's own thread is held to the review loop's contract. */
export function registerAgentInstructions(ctx: KanbanContext, { projectSettings }: { projectSettings: ProjectSettingsStore }): void {
  const { bb, stmts } = ctx;

  bb.agents.configure((context) => {
    const { role, dumpId, ticketId } = context.pluginMetadata;
    if (role === "plan" && typeof dumpId === "string") {
      return {
        tools: [],
        skills: ["kanban"],
        instructions: `This thread plans Kanban tickets from the user's dictation (brain dump ${JSON.stringify(dumpId)}). Every reply that proposes tickets must end with a \`\`\`json kanban-proposal block; do not create cards or start work yourself.`,
      };
    }
    if (typeof ticketId !== "string") return { tools: [], skills: [] };
    const row = stmts.byId.get(ticketId);
    if (row === undefined) return { tools: [], skills: [] };
    const forRole = typeof role === "string" ? ROLE_INSTRUCTIONS.get(role) : undefined;
    return { tools: [], skills: ["kanban"], instructions: forRole === undefined ? cardInstructions(stmts, projectSettings, row) : forRole(row) };
  });
}
