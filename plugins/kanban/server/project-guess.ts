import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ProjectGuess, Ticket } from "../shared/board";
import type { BoardStore } from "./board";
import type { KanbanContext } from "./context";
import type { TicketRow } from "./db/rows";
import { githubRepoFromRemote } from "./github";
import { errorMessage, execFileAsync } from "./util";

const GUESSES_KEY = "projectGuesses";
const EXAMPLES_PER_PROJECT = 5;
const DESCRIPTION_MAX_LENGTH = 4_000;
const MAX_RUNNING = 2;
const CLAUDE_TIMEOUT_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;

const SYSTEM_PROMPT =
  "You pick which software project a task on a kanban board belongs to. Weigh the cards already filed under each project most, then names, repositories and paths. Answer null when no project is a reasonable fit. Answer only with the JSON the schema asks for.";

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    projectId: { type: ["string", "null"], description: "The id of the chosen project, exactly as listed, or null." },
    reason: { type: "string", description: "Why, in under twelve words, for a tooltip." },
  },
  required: ["projectId", "reason"],
  additionalProperties: false,
};

const answerSchema = z.object({ projectId: z.string().nullable(), reason: z.string().default("") });
const resultSchema = z.object({ is_error: z.boolean().optional(), result: z.string().optional(), structured_output: z.unknown().optional() });
const storedSchema = z.record(z.string(), z.object({ key: z.string(), guess: z.object({ projectId: z.string(), reason: z.string() }).nullable() }));

interface Candidate {
  id: string;
  name: string;
  repo: string | null;
  path: string | null;
  examples: string[];
}

/**
 * The project a card with none most likely belongs to, picked by a small model from the card's text and the cards
 * already filed under each project. The card panel offers it as the default; it never sets the card's project.
 */
export function createProjectGuess(ctx: KanbanContext, { board }: { board: BoardStore }) {
  const { bb, settings, stmts } = ctx;
  const stored = new Map<string, { key: string; guess: ProjectGuess | null }>();
  const inFlight = new Map<string, { key: string; promise: Promise<ProjectGuess | null> }>();
  const waiting: Array<() => void> = [];
  let running = 0;
  // Without a working `claude`, every card opened would otherwise start another failing process.
  let failedAt = Number.NEGATIVE_INFINITY;

  async function loadGuesses(): Promise<void> {
    const parsed = storedSchema.safeParse(await bb.storage.kv.get(GUESSES_KEY));
    for (const [id, entry] of Object.entries(parsed.success ? parsed.data : {})) stored.set(id, entry);
  }

  /** Kept only for cards still waiting on a project, so the record doesn't grow with the board. */
  async function saveGuesses(): Promise<void> {
    for (const id of stored.keys()) {
      const row = stmts.byId.get(id);
      if (row === undefined || !needsGuess(row)) stored.delete(id);
    }
    await bb.storage.kv.set(GUESSES_KEY, Object.fromEntries(stored));
  }

  function needsGuess(row: Pick<TicketRow, "project_id" | "thread_id" | "kind">): boolean {
    return row.project_id === null && row.thread_id === null && row.kind !== "pr";
  }

  async function candidates(): Promise<Candidate[]> {
    const projects = await bb.sdk.projects.list();
    const examples = new Map<string, string[]>();
    const filed = stmts.all.all().filter((row) => row.project_id !== null).sort((a, b) => b.updated_at - a.updated_at);
    for (const row of filed) {
      const list = examples.get(row.project_id!) ?? [];
      if (list.length < EXAMPLES_PER_PROJECT) examples.set(row.project_id!, [...list, row.title]);
    }
    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      repo: githubRepoFromRemote(project.gitRemoteUrl) ?? project.gitRemoteUrl ?? null,
      path: project.sources.find((source) => source.isDefault)?.path ?? project.sources[0]?.path ?? null,
      examples: examples.get(project.id) ?? [],
    }));
  }

  function guessKey(ticket: Ticket, projects: readonly Candidate[]): string {
    const subject = [ticket.title, ticket.description, ticket.tags.join(","), ticket.jira?.key ?? "", projects.map((project) => project.id).sort().join(",")];
    return createHash("sha256").update(JSON.stringify(subject)).digest("hex").slice(0, 16);
  }

  function prompt(ticket: Ticket, projects: readonly Candidate[]): string {
    const lines = ["Projects:"];
    for (const project of projects) {
      const where = [project.repo, project.path].filter((part) => part !== null).join(", ");
      lines.push(`- id ${project.id}: ${project.name}${where === "" ? "" : ` (${where})`}`);
      for (const example of project.examples) lines.push(`  - card: ${example}`);
    }
    lines.push("", "Card:", `Title: ${ticket.title}`);
    if (ticket.jira !== null) lines.push(`Jira: ${ticket.jira.key} (${ticket.jira.issueType})`);
    if (ticket.tags.length > 0) lines.push(`Tags: ${ticket.tags.join(", ")}`);
    if (ticket.description.trim() !== "") lines.push("Description:", ticket.description.trim().slice(0, DESCRIPTION_MAX_LENGTH));
    return lines.join("\n");
  }

  /** A finishing run hands its slot straight to the next waiter, so a newcomer can't slip in between. */
  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= MAX_RUNNING) await new Promise<void>((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next === undefined) running -= 1;
      else next();
    }
  }

  async function runClaude(input: string): Promise<unknown> {
    const configured = (await settings.get()).claudePath.trim() || "claude";
    const args = [
      "-p",
      "--model",
      "haiku",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(ANSWER_SCHEMA),
      "--system-prompt",
      SYSTEM_PROMPT,
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      input,
    ];
    // Away from any project, so no CLAUDE.md or project settings reach the call.
    const options = { cwd: tmpdir(), timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 };
    try {
      return JSON.parse((await execFileAsync(configured, args, options)).stdout);
    } catch (error) {
      // bb launched from the Dock doesn't see the shell's PATH; this is where Claude Code's installer puts it.
      if (configured !== "claude" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return JSON.parse((await execFileAsync(join(homedir(), ".local", "bin", "claude"), args, options)).stdout);
    }
  }

  async function ask(ticket: Ticket, projects: readonly Candidate[]): Promise<ProjectGuess | null> {
    const result = resultSchema.parse(await slot(() => runClaude(prompt(ticket, projects))));
    if (result.is_error === true) throw new Error(result.result ?? "claude reported an error");
    const answer = answerSchema.parse(result.structured_output ?? JSON.parse(result.result ?? "null"));
    // The model's answer is only ever one of the listed ids.
    if (answer.projectId === null || !projects.some((project) => project.id === answer.projectId)) return null;
    return { projectId: answer.projectId, reason: answer.reason.trim() };
  }

  /** Null when the guess is off, the card needs none, or there's nothing to choose between. */
  async function guessProject(id: string): Promise<ProjectGuess | null> {
    const row = stmts.byId.get(id);
    if (row === undefined) throw new Error(`No ticket with id ${id}`);
    if (!needsGuess(row) || (await settings.get()).guessProjects !== true) return null;
    const projects = await candidates();
    if (projects.length < 2) return null;
    const ticket = board.hydrate(row);
    const key = guessKey(ticket, projects);
    const cached = stored.get(id);
    if (cached?.key === key) return cached.guess;
    const pending = inFlight.get(id);
    if (pending?.key === key) return pending.promise;
    if (Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return null;
    const promise = ask(ticket, projects).then(
      async (guess) => {
        stored.set(id, { key, guess });
        await saveGuesses();
        return guess;
      },
      (error: unknown) => {
        failedAt = Date.now();
        bb.log.warn(`could not guess a project for ticket ${id}: ${errorMessage(error)}`);
        return null;
      },
    );
    inFlight.set(id, { key, promise });
    void promise.finally(() => {
      if (inFlight.get(id)?.promise === promise) inFlight.delete(id);
    });
    return promise;
  }

  /** Starts the guess as a card is made, so it's usually ready by the time the card is opened. */
  function prefetch(id: string): void {
    void guessProject(id).catch((error: unknown) => bb.log.warn(`could not guess a project for ticket ${id}: ${errorMessage(error)}`));
  }

  return { loadGuesses, guessProject, prefetch };
}

export type ProjectGuesser = ReturnType<typeof createProjectGuess>;
