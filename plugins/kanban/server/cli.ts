import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { locationLabel } from "bb-diff-view/line-range";
import { dueDateSchema, tagSchema, type Column, type Ticket } from "../shared/board";
import { PLAN_MAX_LENGTH, evidenceSchema, findingAnswerSchema, phaseChip, type Evidence, type LoopGates } from "../shared/loop";
import { DEFAULT_REVIEW_DEPTH, REVIEW_DEPTH_LABEL, reviewDepthSchema, type ReviewDepth } from "../shared/review";
import { initialColumn } from "./board";
import type { KanbanContext } from "./context";
import { rowToComment, rowToDiffComment, rowToReview } from "./db/rows";
import { FindingAnswerError, LoopTurnError, NoCheckCommandError } from "./loop/loop";
import { countSeverities } from "./reviews/findings";
import type { Services } from "./services";
import { normalizeTags, shortId } from "./util";

/** `bb kanban …`: the commands agents and users run against the board. */
export function registerCli(ctx: KanbanContext, services: Services): void {
  const { bb, stmts, sync, publish } = ctx;
  const { getTicket, hydrate, getColumns, getSources, createTicket, moveTicket, setParent, setTags, setDueDate } = services.board;
  const { spawnThreadForTicket, linkThread } = services.threads;
  const { projectForTicket, fallbackProject } = services.projects;
  const { reviewUnavailableReason, startReview, spawnApplyForReview, completeApply: completeReviewApply } = services.reviews;
  const { spawnApplyForComments, completeApply } = services.prComments;
  const { diffThreadRoot } = services.diffComments;
  const { startChildren } = services.subtasks;
  const { runSync } = services.sourceSync;
  const { setMonitored, proposePlan, answerFindings, reportReady, recordChecks, reportLanded } = services.loop;

  const COMMIT_SHA = /^[0-9a-f]{7,40}$/iu;

  function formatTicket(ticket: Ticket, columns: Column[]): string {
    const column = columns.find((candidate) => candidate.id === ticket.columnId)?.name ?? ticket.columnId;
    const pr =
      ticket.pr !== null
        ? `  ${ticket.pr.repo}#${ticket.pr.number} (${ticket.pr.state})`
        : ticket.jira !== null
          ? `  ${ticket.jira.key} (${ticket.jira.status})`
          : "";
    const tags = ticket.tags.length === 0 ? "" : `  ${ticket.tags.map((tag) => `#${tag}`).join(" ")}`;
    const due = ticket.dueDate === null ? "" : `  due ${ticket.dueDate}`;
    const thread = ticket.threadId === null ? "" : `  @thread:${ticket.threadId}`;
    const review = ticket.reviewThreadId === null ? "" : `  review:@thread:${ticket.reviewThreadId}`;
    const nesting = ticket.parentId !== null ? `  ↳ ${ticket.parentId}` : ticket.children.total > 0 ? `  (${ticket.children.done}/${ticket.children.total} subtasks)` : "";
    const chip = ticket.loop === null ? null : phaseChip(ticket.loop);
    const loop = chip === null ? "" : `  monitored: ${chip.label}`;
    return `${ticket.id}  [${column}]  ${ticket.title}${tags}${due}${pr}${thread}${review}${nesting}${loop}`;
  }

  function ticketForContext(ticketOption: string | undefined, threadId: string | undefined): Ticket {
    if (ticketOption !== undefined) return getTicket(ticketOption);
    if (threadId !== undefined) {
      const row = stmts.byThread.get(threadId);
      if (row !== undefined) return hydrate(row);
      throw new PluginCliError("This thread has no kanban card.", {
        code: "no_ticket_for_thread",
        hint: 'Create one with `bb kanban add "<title>"` or pass --ticket <id>.',
      });
    }
    throw new PluginCliError("No ticket given.", {
      code: "ticket_required",
      hint: "Pass --ticket <id>; run `bb kanban list` to see ids.",
    });
  }

  function ticketForArguments(positional: string | undefined, ticketOption: string | undefined, threadId: string | undefined): Ticket {
    if (positional !== undefined && ticketOption !== undefined) {
      throw new PluginCliError("Pass the ticket id as an argument or with --ticket, not both.", { code: "conflicting_options" });
    }
    return ticketForContext(positional ?? ticketOption, threadId);
  }

  function parseDueDate(raw: string): string {
    const parsed = dueDateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PluginCliError(`Invalid due date "${raw}": ${parsed.error.issues[0]?.message ?? "expected YYYY-MM-DD"}`, {
        code: "invalid_due_date",
        hint: "Pass a date as YYYY-MM-DD, e.g. 2026-10-31.",
      });
    }
    return parsed.data;
  }

  function parseDepth(raw: string | undefined): ReviewDepth {
    if (raw === undefined) return DEFAULT_REVIEW_DEPTH;
    const parsed = reviewDepthSchema.safeParse(raw.toLowerCase());
    if (!parsed.success) throw new PluginCliError(`Unknown review depth "${raw}"; expected quick, standard or deep.`, { code: "invalid_depth" });
    return parsed.data;
  }

  const GATE_NAMES: Record<string, keyof LoopGates> = { plan: "plan", findings: "findings", "auto-accept": "autoAccept" };

  function parseGates(raw: string): LoopGates {
    const gates: LoopGates = { plan: false, findings: false, autoAccept: false };
    const names = raw.split(",").map((name) => name.trim().toLowerCase()).filter((name) => name !== "" && name !== "none");
    for (const name of names) {
      const gate = GATE_NAMES[name];
      if (gate === undefined) throw new PluginCliError(`Unknown gate "${name}"`, { code: "invalid_gate", hint: "Gates are plan, findings and auto-accept, or none." });
      gates[gate] = true;
    }
    return gates;
  }

  /**
   * bb's `--<name>-stdin` takes exactly one line, so a multi-line value (a plan, a checks log, pretty-printed JSON)
   * comes from `--<name>-file` instead, a path relative to the caller's directory.
   */
  async function valueOrFile(name: string, inline: string | undefined, file: string | undefined, cwd: string | undefined): Promise<string | undefined> {
    if (file === undefined) return inline;
    if (inline !== undefined) throw new PluginCliError(`Pass --${name} or --${name}-file, not both.`, { code: "conflicting_options" });
    try {
      return await readFile(resolve(cwd ?? process.cwd(), file), "utf8");
    } catch (error) {
      throw new PluginCliError(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`, { code: "unreadable_file" });
    }
  }

  const fileOption = (name: string, what: string) => ({ type: "string", description: `A file holding ${what}, relative to the current directory; use it for anything longer than one line` }) as const;

  function parseEvidence(raw: string | undefined, screenshots: readonly string[]): Evidence {
    let json: unknown = {};
    if (raw !== undefined && raw.trim() !== "") {
      try {
        json = JSON.parse(raw);
      } catch {
        throw new PluginCliError("The evidence is not JSON.", { code: "invalid_evidence", hint: 'Pass {"commands":[{"command":"…","exitCode":0,"outputTail":"…"}],"screenshots":[]}.' });
      }
    }
    const parsed = evidenceSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new PluginCliError(`Invalid evidence${issue === undefined ? "" : ` at ${issue.path.join(".") || "the top level"}: ${issue.message}`}`, { code: "invalid_evidence" });
    }
    return { ...parsed.data, screenshots: [...parsed.data.screenshots, ...screenshots] };
  }

  const ticketOption = {
    ticket: {
      type: "string",
      description: "Ticket id. Defaults to the card linked to the current thread.",
      aliases: ["id", "card"],
    },
  } as const;

  const ticketPositional = { name: "ticket", description: "Ticket id. Defaults to the card linked to the current thread.", required: false } as const;

  bb.cli.register(
    defineCli({
      name: "kanban",
      summary: "Kanban board where each card is a thread",
      commands: {
        list: cliCommand({
          summary: "List cards, grouped by column",
          options: {
            column: { type: "string", description: "Only this column id" },
            tag: { type: "string", repeatable: true, split: ",", description: "Only cards with this tag (repeatable)" },
            parent: { type: "string", description: "Only subtasks of this ticket id; `none` for top-level cards only" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }) {
            const columns = await getColumns();
            const wanted = normalizeTags(options.tag);
            const tickets = stmts.all
              .all()
              .map(hydrate)
              .filter((ticket) => options.parent === undefined || (options.parent === "none" ? ticket.parentId === null : ticket.parentId === options.parent))
              .filter((ticket) => options.column === undefined || ticket.columnId === options.column)
              .filter((ticket) => wanted.every((tag) => ticket.tags.includes(tag)));
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(tickets) };
            const lines: string[] = [];
            for (const column of columns) {
              if (options.column !== undefined && column.id !== options.column) continue;
              const inColumn = tickets.filter((ticket) => ticket.columnId === column.id);
              lines.push(`${column.name} (${column.id}) — ${inColumn.length}`);
              for (const ticket of inColumn) lines.push(`  ${formatTicket(ticket, columns)}`);
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        columns: cliCommand({
          summary: "List column ids and names",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }) {
            const columns = await getColumns();
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(columns)
                : columns.map((column) => `${column.id}  ${column.name}`).join("\n"),
            };
          },
        }),
        show: cliCommand({
          summary: "Show one card",
          positionals: [ticketPositional],
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }, ctx) {
            const ticket = ticketForArguments(positionals.ticket, options.ticket, ctx.threadId);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(ticket) };
            const columns = await getColumns();
            const lines = [formatTicket(ticket, columns)];
            if (ticket.description !== "") lines.push("", ticket.description);
            if (ticket.pr !== null) lines.push("", ticket.pr.url);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        add: cliCommand({
          summary: "Add an ad hoc card; inside a thread, the card is linked to that thread",
          positionals: [{ name: "title", description: "Card title", required: true }],
          options: {
            description: { type: "string", description: "Longer description (markdown)", aliases: ["body"] },
            column: { type: "string", description: "Column id; defaults to backlog" },
            tag: { type: "string", repeatable: true, split: ",", description: "Tag to add (repeatable)" },
            due: { type: "string", description: "Due date, YYYY-MM-DD" },
            parent: { type: "string", description: "Create the card as a subtask of this ticket id (implies --no-link)" },
            project: { type: "string", description: "Project id for a new thread; implies --start-thread" },
            "start-thread": {
              type: "boolean",
              description: "Spawn a thread for the card (needs --project or a fallback project setting)",
            },
            "no-link": { type: "boolean", description: "Do not link the card to the current thread" },
            monitor: { type: "boolean", description: "Monitor the card with the default gates, whatever its tags' default" },
            "no-monitor": { type: "boolean", description: "Leave the card unmonitored, even when one of its tags monitors new cards" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ positionals, options }, ctx) {
            const columns = await getColumns();
            const columnId =
              options.column !== undefined && columns.some((column) => column.id === options.column)
                ? options.column
                : initialColumn(columns, null);
            if (options.column !== undefined && columnId !== options.column) {
              throw new PluginCliError(`No column with id ${options.column}`, {
                code: "unknown_column",
                hint: "Run `bb kanban columns`.",
              });
            }
            const dueDate = options.due === undefined ? null : parseDueDate(options.due);
            const parentRow = options.parent === undefined ? undefined : stmts.byId.get(options.parent);
            if (options.parent !== undefined && parentRow === undefined) {
              throw new PluginCliError(`No ticket with id ${options.parent}`, { code: "unknown_parent", hint: "Run `bb kanban list`." });
            }
            let ticket = createTicket({
              title: positionals.title,
              description: options.description ?? "",
              columnId,
              kind: "adhoc",
              tags: options.tag,
              threadId: null,
              projectId: options.project ?? parentRow?.project_id ?? null,
              pr: null,
              parentId: options.parent ?? null,
              dueDate,
              ...(options.monitor ? { monitored: true } : options["no-monitor"] ? { monitored: false } : {}),
            });
            publish();
            if (ctx.threadId !== undefined && options.parent === undefined && !options["no-link"] && !options["start-thread"] && options.project === undefined) {
              ticket = await linkThread(ticket.id, ctx.threadId);
            } else if (options.project !== undefined || options["start-thread"]) {
              const projectId = options.project ?? (await fallbackProject(null));
              if (projectId === null) {
                throw new PluginCliError("No project to start the thread in.", {
                  code: "project_required",
                  hint: "Pass --project <id> or set the fallback project in the plugin settings.",
                });
              }
              ticket = await spawnThreadForTicket(ticket.id, projectId);
            }
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(ticket) : `Added ${formatTicket(ticket, columns)}`,
            };
          },
        }),
        move: cliCommand({
          summary: "Move a card to a column (defaults to the current thread's card)",
          positionals: [{ name: "column", description: "Target column id", required: true }],
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }, ctx) {
            const columns = await getColumns();
            const target = columns.find(
              (column) =>
                column.id === positionals.column ||
                column.name.toLowerCase() === positionals.column.toLowerCase(),
            );
            if (target === undefined) {
              throw new PluginCliError(`No column "${positionals.column}"`, {
                code: "unknown_column",
                hint: `Columns: ${columns.map((column) => column.id).join(", ")}`,
              });
            }
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const moved = moveTicket(ticket.id, target.id, null);
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(moved) : formatTicket(moved, columns),
            };
          },
        }),
        review: cliCommand({
          summary: "Start a code-review thread for a card's pull request, or for the commits its thread made beyond its merge base (defaults to the current thread's card)",
          options: {
            ...ticketOption,
            project: { type: "string", description: "Project id to run a PR review in; defaults to the card's project. A local review runs in its thread's project" },
            full: { type: "boolean", description: "Review the whole change even if an earlier review exists (default: the commits since the last review, re-checking its open findings)" },
            depth: { type: "string", description: "Which finders run: quick (correctness, CLAUDE.md compliance, scope, style), standard (adds testing and git history; the default) or deep (adds security)" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }, ctx) {
            const depth = parseDepth(options.depth);
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const reason = await reviewUnavailableReason(ticket.id);
            if (reason !== null) throw new PluginCliError(`Ticket ${ticket.id} can't be reviewed: ${reason}.`, { code: "not_reviewable" });
            const reviewed = await startReview(ticket.id, options.project ?? null, options.full ? "full" : "incremental", depth);
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(reviewed) : `${REVIEW_DEPTH_LABEL[depth]} review started in @thread:${reviewed.reviewThreadId}`,
            };
          },
        }),
        subtasks: cliCommand({
          summary: "List a card's subtasks (defaults to the current thread's card)",
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const columns = await getColumns();
            const children = stmts.childrenOf.all(ticket.id).map(hydrate);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(children) };
            if (children.length === 0) return { exitCode: 0, stdout: `${ticket.id} has no subtasks.` };
            return { exitCode: 0, stdout: children.map((child) => formatTicket(child, columns)).join("\n") };
          },
        }),
        "set-parent": cliCommand({
          summary: "Nest a card under another card, or `none` to make it top-level",
          positionals: [
            { name: "ticket", description: "Ticket id to move", required: true },
            { name: "parent", description: "Parent ticket id, or `none`", required: true },
          ],
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }) {
            const updated = setParent(positionals.ticket, positionals.parent === "none" ? null : positionals.parent);
            return { exitCode: 0, stdout: options.json ? JSON.stringify(updated) : formatTicket(updated, await getColumns()) };
          },
        }),
        "start-subtasks": cliCommand({
          summary: "Start agents on a card's open subtasks: one thread each, or one thread in order",
          options: {
            ...ticketOption,
            sequential: { type: "boolean", description: "One thread that works through the subtasks in order (default: one thread per subtask)" },
            project: { type: "string", description: "Project id for new threads; defaults to the card's project" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const result = await startChildren(ticket.id, options.sequential ? "sequential" : "parallel", options.project ?? null);
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(result) : `Started ${result.started} subtask thread(s)${result.skipped > 0 ? `, skipped ${result.skipped}` : ""}`,
            };
          },
        }),
        "review-record": cliCommand({
          summary: "Record the commit a running review covers (run by the review thread itself)",
          options: {
            commit: { type: "string", required: true, description: "Full sha of the reviewed commit (the PR head, or the card thread's HEAD)" },
            base: { type: "string", description: "Branch the review diffs against: the PR base, or the merge-base branch of local work" },
            head: { type: "string", description: "PR head branch name" },
            review: { type: "string", description: "Review id; defaults to the review owned by the current thread" },
          },
          async run({ options }, ctx) {
            const row =
              options.review !== undefined
                ? stmts.reviewById.get(options.review)
                : ctx.threadId === undefined
                  ? undefined
                  : stmts.reviewByThread.get(ctx.threadId);
            if (row === undefined) {
              throw new PluginCliError("No review found for this thread.", {
                code: "no_review_for_thread",
                hint: "Run this from the review thread, or pass --review <id>.",
              });
            }
            if (!COMMIT_SHA.test(options.commit)) {
              throw new PluginCliError(`"${options.commit}" is not a commit sha.`, { code: "invalid_commit" });
            }
            stmts.recordReviewCommit.run(options.commit, options.base ?? null, options.head ?? null, row.id);
            publish();
            return { exitCode: 0, stdout: `Review ${row.id} covers ${options.commit}` };
          },
        }),
        monitor: cliCommand({
          summary: "Turn the review loop on or off for a card (defaults to the current thread's card): the board checks, reviews and routes its work itself",
          positionals: [{ name: "state", description: "`on` or `off`", required: true }],
          options: {
            ...ticketOption,
            gates: {
              type: "string",
              description: "With `on`: the comma-separated gates to turn on (plan, findings, auto-accept), or `none`; defaults to plan approval on Jira cards only",
            },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ positionals, options }, ctx) {
            const state = positionals.state.toLowerCase();
            if (state !== "on" && state !== "off") throw new PluginCliError(`Expected \`on\` or \`off\`, got "${positionals.state}"`, { code: "invalid_state" });
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const updated = await setMonitored(ticket.id, state === "on", options.gates === undefined ? null : parseGates(options.gates));
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(updated) : state === "on" ? `Monitoring ${formatTicket(updated, await getColumns())}` : `Stopped monitoring ${ticket.id}; the loop stops after its current step`,
            };
          },
        }),
        plan: cliCommand({
          summary: "Propose a monitored card's plan while its plan gate holds it (run by the card's own thread): the user approves or edits it before you build",
          options: {
            ...ticketOption,
            plan: { type: "string", stdin: true, description: "The plan as Markdown on one line; --plan-stdin reads that line from stdin" },
            "plan-file": fileOption("plan", "the plan as Markdown"),
          },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const plan = ((await valueOrFile("plan", options.plan, options["plan-file"], ctx.cwd)) ?? "").trim();
            if (plan === "" || plan.length > PLAN_MAX_LENGTH) throw new PluginCliError(`The plan must be 1 to ${PLAN_MAX_LENGTH} characters`, { code: "invalid_plan" });
            try {
              await proposePlan(ticket.id, plan);
            } catch (error) {
              if (!(error instanceof LoopTurnError)) throw error;
              throw new PluginCliError(error.message, { code: "not_planning" });
            }
            return { exitCode: 0, stdout: "Plan proposed. Stop here and wait: the board sends you the approved plan, possibly edited, when the user approves it." };
          },
        }),
        ready: cliCommand({
          summary: "Report a monitored card's work committed and verified (run by the card's own thread): the board re-runs the checks at the commit",
          options: {
            ...ticketOption,
            commit: { type: "string", required: true, description: "Full sha of the commit holding the work" },
            evidence: {
              type: "string",
              stdin: true,
              description: 'JSON evidence of how the work was verified: {"commands":[{"command","exitCode","outputTail"}],"screenshots":["/path.png"]}; --evidence-stdin reads one line of it from stdin',
            },
            "evidence-file": fileOption("evidence", "the JSON evidence"),
            screenshot: { type: "string", repeatable: true, description: "Path of a screenshot showing a UI change (repeatable)" },
            "check-command": { type: "string", description: "The check command you ran; needed only when the project sets none" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            if (!COMMIT_SHA.test(options.commit)) throw new PluginCliError(`"${options.commit}" is not a commit sha.`, { code: "invalid_commit" });
            const evidence = parseEvidence(await valueOrFile("evidence", options.evidence, options["evidence-file"], ctx.cwd), options.screenshot);
            let result: Awaited<ReturnType<typeof reportReady>>;
            try {
              result = await reportReady(ticket.id, { commit: options.commit, evidence, checkCommand: options["check-command"] ?? null });
            } catch (error) {
              if (error instanceof FindingAnswerError) {
                throw new PluginCliError(error.message, { code: "unanswered_findings", hint: 'Run `bb kanban answer <ids> fixed`, or `bb kanban answer <id> disputed --reason "<why>"`, for each.' });
              }
              if (error instanceof LoopTurnError) throw new PluginCliError(error.message, { code: "not_your_turn" });
              if (!(error instanceof NoCheckCommandError)) throw error;
              throw new PluginCliError(error.message, { code: "check_command_required", hint: 'Pass --check-command "<the command you ran>".' });
            }
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(result) };
            if (result.checkCommand === null) {
              return { exitCode: 0, stdout: `Ticket ${ticket.id} isn't monitored, so the board runs no checks; \`bb kanban monitor on\` turns its review loop on.` };
            }
            const chosen = result.checkCommand.source === "agent" ? " (your choice; the project sets none)" : "";
            return {
              exitCode: 0,
              stdout: `Ready at ${options.commit}. The board is re-running \`${result.checkCommand.command}\`${chosen} in a fresh worktree; stop here, and anything that fails comes back to this thread.`,
            };
          },
        }),
        answer: cliCommand({
          summary: "Answer findings of a monitored card's fix round (run by the card's own thread): fixed, or disputed with a reason",
          positionals: [
            { name: "findings", description: "Comma-separated finding ids from the fix prompt, e.g. F1,F3", required: true },
            { name: "answer", description: "`fixed` or `disputed`", required: true },
          ],
          options: { ...ticketOption, reason: { type: "string", description: "Why the finding is wrong or not this change's to fix; required with `disputed`" } },
          async run({ positionals, options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const findingIds = positionals.findings.split(",").map((id) => id.trim()).filter((id) => id !== "");
            const parsed = findingAnswerSchema.safeParse({ answer: positionals.answer.toLowerCase(), reason: options.reason });
            if (!parsed.success) {
              throw new PluginCliError(`Expected \`fixed\`, or \`disputed\` with --reason, got "${positionals.answer}"${options.reason === undefined ? "" : " with that reason"}`, {
                code: "invalid_answer",
              });
            }
            let unanswered: string[];
            try {
              unanswered = await answerFindings(ticket.id, findingIds, parsed.data);
            } catch (error) {
              if (!(error instanceof FindingAnswerError)) throw error;
              throw new PluginCliError(error.message, { code: "invalid_finding" });
            }
            const rest = unanswered.length === 0 ? "every finding is answered; report with `bb kanban ready`" : `still to answer: ${unanswered.join(", ")}`;
            return { exitCode: 0, stdout: `Answered ${findingIds.join(", ")} as ${parsed.data.answer}; ${rest}` };
          },
        }),
        landed: cliCommand({
          summary: "Report an accepted local card's change landed by the project's finishing steps (run by the card's own thread): the board moves it to Done",
          options: { ...ticketOption },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            try {
              await reportLanded(ticket.id);
            } catch (error) {
              if (!(error instanceof LoopTurnError)) throw error;
              throw new PluginCliError(error.message, { code: "not_accepted" });
            }
            return { exitCode: 0, stdout: `Landed; ticket ${ticket.id} moved to Done` };
          },
        }),
        "checks-record": cliCommand({
          summary: "Record the result of re-running a monitored card's checks (run by the checks thread itself)",
          options: {
            "exit-code": { type: "integer", min: 0, max: 255, required: true, description: "The check command's exit code" },
            output: { type: "string", stdin: true, description: "The tail of the command's output on one line; --output-stdin reads that line from stdin" },
            "output-file": fileOption("output", "the tail of the command's output"),
            run: { type: "string", description: "Checks run id; defaults to the run owned by the current thread" },
          },
          async run({ options }, ctx) {
            const row =
              options.run !== undefined ? stmts.checksRunById.get(options.run) : ctx.threadId === undefined ? undefined : stmts.checksRunByThread.get(ctx.threadId);
            if (row === undefined) {
              throw new PluginCliError("No checks run found for this thread.", { code: "no_checks_for_thread", hint: "Run this from the checks thread, or pass --run <id>." });
            }
            await recordChecks(row, options["exit-code"], (await valueOrFile("output", options.output, options["output-file"], ctx.cwd)) ?? "");
            return { exitCode: 0, stdout: `Recorded exit code ${options["exit-code"]} for the checks of ${row.commit_sha.slice(0, 7)}` };
          },
        }),
        "review-show": cliCommand({
          summary: "Print the latest persisted review of a card",
          positionals: [ticketPositional],
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }, ctx) {
            const ticket = ticketForArguments(positionals.ticket, options.ticket, ctx.threadId);
            const row = stmts.latestCompletedReview.get(ticket.id);
            if (row === undefined) {
              throw new PluginCliError(`Ticket ${ticket.id} has no completed review.`, {
                code: "no_review",
                hint: "Start one with `bb kanban review`.",
              });
            }
            const review = rowToReview(row);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(review) };
            const counts = countSeverities(review.report);
            return {
              exitCode: 0,
              stdout: [
                `Review ${review.id} of ${ticket.id} at commit ${review.commitSha ?? "unknown"} (${new Date(review.completedAt ?? review.createdAt).toISOString()})${counts === null ? "" : `  critical ${counts.critical} · important ${counts.important} · minor ${counts.minor}`}`,
                "",
                review.body ?? "(empty)",
              ].join("\n"),
            };
          },
        }),
        "narrative-context": cliCommand({
          summary: "Print the earlier narrative and the delta a narrative revision must explain (run by the narrative thread itself)",
          options: { narrative: { type: "string", description: "Narrative id; defaults to the one the current thread is writing" } },
          async run({ options }, ctx) {
            try {
              return { exitCode: 0, stdout: services.tour.narrativeContext(options.narrative, ctx.threadId) };
            } catch (error) {
              throw new PluginCliError(String(error instanceof Error ? error.message : error), { code: "no_narrative", hint: "Run this from the narrative thread, or pass --narrative <id>." });
            }
          },
        }),
        "narrative-check": cliCommand({
          summary: "Check a draft kanban-narrative report: it parses, and its steps cover every changed line (run by the narrative thread itself)",
          options: {
            report: { type: "string", stdin: true, description: "The report JSON (the body of the kanban-narrative block) on one line; --report-stdin reads that line from stdin" },
            "report-file": fileOption("report", "the report JSON"),
            narrative: { type: "string", description: "Narrative id; defaults to the one the current thread is writing" },
          },
          async run({ options }, ctx) {
            let result: { ok: boolean; text: string };
            try {
              result = services.tour.checkNarrative(options.narrative, ctx.threadId, (await valueOrFile("report", options.report, options["report-file"], ctx.cwd)) ?? "");
            } catch (error) {
              throw new PluginCliError(String(error instanceof Error ? error.message : error), { code: "no_narrative", hint: "Run this from the narrative thread, or pass --narrative <id>." });
            }
            return { exitCode: result.ok ? 0 : 1, stdout: result.text };
          },
        }),
        "apply-review": cliCommand({
          summary: "Apply the latest persisted review: a PR review in a new thread that pushes to the PR branch, a local review in the card's own thread",
          options: {
            ...ticketOption,
            review: { type: "string", description: "Review id; defaults to the latest completed review" },
            "no-push": { type: "boolean", description: "PR reviews: commit in the worktree but do not push to the PR branch" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const applied = await spawnApplyForReview(ticket.id, options.review ?? null, !options["no-push"]);
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(applied)
                : `Apply started in @thread:${applied.latestReview?.apply?.threadId ?? "unknown"}`,
            };
          },
        }),
        comments: cliCommand({
          summary: "List the synced GitHub comments on a PR card (defaults to the current thread's card)",
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const comments = stmts.commentsForTicket.all(ticket.id).map(rowToComment);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(comments) };
            if (comments.length === 0) return { exitCode: 0, stdout: "No comments synced for this card." };
            return {
              exitCode: 0,
              stdout: comments
                .map(
                  (comment) =>
                    `${comment.selected ? "[x]" : "[ ]"} ${comment.id}  ${comment.author}${comment.path === null ? "" : `  ${comment.path}${comment.line === null ? "" : `:${comment.line}`}`}${comment.reviewState === null ? "" : `  ${comment.reviewState}`}${comment.addressedAt === null ? "" : "  (addressed)"}\n    ${comment.body.trim().split("\n")[0]?.slice(0, 160) ?? ""}`,
                )
                .join("\n"),
            };
          },
        }),
        "apply-comments": cliCommand({
          summary: "Start a thread that applies the selected PR comments with the apply-pr-comments skill and pushes",
          options: {
            ...ticketOption,
            "no-push": { type: "boolean", description: "Commit in the worktree but do not push to the PR branch" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const result = await spawnApplyForComments(ticket.id, !options["no-push"]);
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(result) : `Apply started in @thread:${result.apply.threadId}`,
            };
          },
        }),
        "comments-applied": cliCommand({
          summary: "Mark the selected comments addressed after pushing (run by the apply thread itself)",
          options: {
            commit: { type: "string", description: "Sha of the resulting commit" },
            pushed: { type: "boolean", description: "The commit was pushed to the PR branch" },
            apply: { type: "string", description: "Apply run id; defaults to the run owned by the current thread" },
          },
          async run({ options }, ctx) {
            const row =
              options.apply !== undefined
                ? stmts.commentApplyById.get(options.apply)
                : ctx.threadId === undefined
                  ? undefined
                  : stmts.commentApplyByThread.get(ctx.threadId);
            if (row === undefined) {
              throw new PluginCliError("No comment apply run found for this thread.", {
                code: "no_apply_for_thread",
                hint: "Run this from the apply thread, or pass --apply <id>.",
              });
            }
            const marked = completeApply(row, options.commit ?? null, options.pushed);
            return { exitCode: 0, stdout: `Marked ${marked} comment(s) addressed${options.commit === undefined ? "" : ` at ${options.commit}`}` };
          },
        }),
        "comment-reply": cliCommand({
          summary: "Reply in an inline comment's thread on the board (run by apply threads; never posted to GitHub)",
          positionals: [
            { name: "comment", description: "Comment id: `local:<id>` or `review-comment:<n>`", required: true },
            { name: "body", description: "Reply text", required: true, variadic: true },
          ],
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }, ctx) {
            const id = positionals.comment.replace(/^local:/u, "");
            const ticketId = id.startsWith("review-comment:")
              ? (stmts.commentById.get(id)?.ticket_id ?? stmts.diffCommentByAnyGithubId.get(id)?.ticket_id)
              : stmts.diffCommentById.get(id)?.ticket_id;
            if (ticketId === undefined) {
              throw new PluginCliError(`No inline comment ${positionals.comment}`, {
                code: "unknown_comment",
                hint: "Use an id from the apply prompt: `local:<id>` for board comments or `review-comment:<n>` for GitHub inline comments.",
              });
            }
            const body = positionals.body.join(" ").trim();
            if (body === "") throw new PluginCliError("The reply is empty", { code: "empty_reply" });
            const root = diffThreadRoot(ticketId, id);
            const now = Date.now();
            const replyId = shortId();
            stmts.insertDiffComment.run({
              id: replyId, ticket_id: ticketId, path: root.path, line: root.line, side: root.side, start_line: root.startLine, start_side: root.startSide, body: body.slice(0, 10_000),
              target: "local", in_reply_to: root.id, author: "agent", author_thread_id: ctx.threadId ?? null, created_at: now, updated_at: now,
            });
            publish();
            const reply = rowToDiffComment(stmts.diffCommentById.get(replyId)!);
            return { exitCode: 0, stdout: options.json ? JSON.stringify(reply) : `Replied in the thread on ${locationLabel(root.path, root)}` };
          },
        }),
        "review-applied": cliCommand({
          summary: "Mark the review's fixes as committed (and pushed) — run by the thread applying them",
          options: {
            commit: { type: "string", description: "Sha of the resulting commit" },
            pushed: { type: "boolean", description: "The commit was pushed to the PR branch" },
            skipped: { type: "string", description: "Comma-separated ids of handed findings that could not be applied; they stay open" },
            review: { type: "string", description: "Review id; defaults to the review being applied by the current thread" },
          },
          async run({ options }, ctx) {
            const row =
              options.review !== undefined
                ? stmts.reviewById.get(options.review)
                : ctx.threadId === undefined
                  ? undefined
                  : stmts.reviewByApplyThread.get(ctx.threadId);
            if (row === undefined) {
              throw new PluginCliError("No apply run found for this thread.", {
                code: "no_apply_for_thread",
                hint: "Run this from the apply thread, or pass --review <id>.",
              });
            }
            const skipped = (options.skipped ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
            const fixed = completeReviewApply(row, options.commit ?? null, options.pushed, skipped);
            return {
              exitCode: 0,
              stdout: `Review ${row.id} applied${options.commit === undefined ? "" : ` at ${options.commit}`}${options.pushed ? " (pushed)" : ""}; ${fixed} finding(s) marked applied${skipped.length === 0 ? "" : `, ${skipped.length} left open`}`,
            };
          },
        }),
        tag: cliCommand({
          summary: "Add tags to a card (defaults to the current thread's card)",
          positionals: [{ name: "tags", description: "Tags to add", required: true, variadic: true }],
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const parsed = z.array(tagSchema).safeParse(positionals.tags.map((tag) => tag.toLowerCase()));
            if (!parsed.success) {
              throw new PluginCliError(parsed.error.issues[0]?.message ?? "Invalid tag", { code: "invalid_tag" });
            }
            const updated = setTags(ticket.id, [...ticket.tags, ...parsed.data]);
            return { exitCode: 0, stdout: options.json ? JSON.stringify(updated) : formatTicket(updated, await getColumns()) };
          },
        }),
        untag: cliCommand({
          summary: "Remove tags from a card (defaults to the current thread's card)",
          positionals: [{ name: "tags", description: "Tags to remove", required: true, variadic: true }],
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const remove = new Set(normalizeTags(positionals.tags));
            const updated = setTags(ticket.id, ticket.tags.filter((tag) => !remove.has(tag)));
            return { exitCode: 0, stdout: options.json ? JSON.stringify(updated) : formatTicket(updated, await getColumns()) };
          },
        }),
        due: cliCommand({
          summary: "Set or clear a card's due date (defaults to the current thread's card)",
          positionals: [{ name: "date", description: "Due date as YYYY-MM-DD, or `none` to clear", required: true }],
          options: { ...ticketOption, json: { type: "boolean", description: "Emit JSON" } },
          async run({ positionals, options }, ctx) {
            const ticket = ticketForContext(options.ticket, ctx.threadId);
            const dueDate = positionals.date.toLowerCase() === "none" ? null : parseDueDate(positionals.date);
            const updated = setDueDate(ticket.id, dueDate);
            return { exitCode: 0, stdout: options.json ? JSON.stringify(updated) : formatTicket(updated, await getColumns()) };
          },
        }),
        sources: cliCommand({
          summary: "List ticket sources and the tags they apply",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }) {
            const sources = await getSources();
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(sources) };
            return {
              exitCode: 0,
              stdout: sources
                .map(
                  (source) =>
                    `${source.id}${source.enabled ? "" : " (disabled)"}  ${source.name}  [${source.kind}] ${source.kind === "github-search" ? source.query : source.jql}  → ${source.tags.map((tag) => `#${tag}`).join(" ")}${source.doneWhenGone ? "  (done when gone)" : ""}${source.kind === "github-search" && source.reviewNewPrs !== null ? `  (${REVIEW_DEPTH_LABEL[source.reviewNewPrs]} review of new PRs)` : ""}${source.kind === "github-search" && source.narrateNewPrs ? "  (narrative of new PRs)" : ""}`,
                )
                .join("\n"),
            };
          },
        }),
        link: cliCommand({
          summary: "Link an existing card to a thread (defaults to the current thread)",
          positionals: [{ name: "ticket", description: "Ticket id", required: true }],
          options: {
            thread: { type: "string", description: "Thread id; defaults to the current thread" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ positionals, options }, ctx) {
            const threadId = options.thread ?? ctx.threadId;
            if (threadId === undefined) {
              throw new PluginCliError("No thread to link.", {
                code: "thread_required",
                hint: "Pass --thread <id> or run this inside a thread.",
              });
            }
            const ticket = await linkThread(positionals.ticket, threadId);
            const columns = await getColumns();
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(ticket) : formatTicket(ticket, columns),
            };
          },
        }),
        remove: cliCommand({
          summary: "Delete a card (the thread is kept)",
          positionals: [{ name: "ticket", description: "Ticket id", required: true }],
          async run({ positionals }) {
            getTicket(positionals.ticket);
            stmts.remove.run(positionals.ticket);
            publish();
            return { exitCode: 0, stdout: `Removed ${positionals.ticket}` };
          },
        }),
        sync: cliCommand({
          summary: "Pull open GitHub PRs into the board now",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }) {
            await runSync();
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(sync) };
            if (sync.lastError !== null) return { exitCode: 1, stderr: sync.lastError };
            return {
              exitCode: 0,
              stdout: `Synced as ${sync.login ?? "unknown"} (${sync.tokenSource}) at ${new Date(sync.lastSyncAt ?? 0).toISOString()}`,
            };
          },
        }),
      },
    }),
  );
}
