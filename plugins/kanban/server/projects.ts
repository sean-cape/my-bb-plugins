import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Ticket } from "../shared/board";
import type { CardThreads } from "./card-threads";
import type { KanbanContext } from "./context";
import type { TicketRow } from "./db/rows";
import { githubRepoFromRemote } from "./github";
import { execFileAsync } from "./util";

/** Which project a card's threads run in, cloning and creating one for a repository no project matches. */
export function createProjects(ctx: KanbanContext, { threads }: { threads: CardThreads }) {
  const { bb, settings, stmts, publish } = ctx;
  const { spawnThreadForTicket } = threads;

  /**
   * The project a card's threads run in. A PR card's must check out the PR's repository: a project whose git remote is
   * another GitHub repository can't fetch the PR's head, so a stored or parent project like that is passed over for
   * the one matching the repository, and a pick like that is refused.
   */
  async function projectForTicket(ticket: Ticket, explicit: string | null): Promise<string> {
    const parentProject = ticket.parentId === null ? null : (stmts.byId.get(ticket.parentId)?.project_id ?? null);
    if (ticket.pr === null) {
      const chosen = explicit ?? ticket.projectId ?? parentProject;
      if (chosen === null) throw new Error("This card has no project. Pick one.");
      return chosen;
    }
    const { repo } = ticket.pr;
    const projects = await bb.sdk.projects.list();
    if (explicit !== null) {
      const project = projects.find((candidate) => candidate.id === explicit);
      if (project === undefined) throw new Error(`No project with id ${explicit}`);
      const remote = githubRepoFromRemote(project.gitRemoteUrl);
      if (remote !== null && remote !== repo.toLowerCase()) {
        throw new Error(`${project.name} is a checkout of ${remote}, so it can't check out ${repo}#${ticket.pr.number}. Pick a project whose git remote is ${repo}.`);
      }
      return explicit;
    }
    const usable = [ticket.projectId, parentProject].find((id) => id !== null && servesRepo(projects, id, repo));
    if (usable !== undefined && usable !== null) return usable;
    const resolved = await ensureProjectForRepo(repo);
    if (resolved === null) {
      throw new Error(`No project's git remote is ${repo}. Add a project for a clone of it, or turn on project auto-creation in the plugin settings.`);
    }
    stmts.setProject.run(resolved, Date.now(), ticket.id);
    return resolved;
  }

  /** Whether a PR in `repo` can run in the project: not when the project is gone or its remote is another GitHub repository. */
  function servesRepo(projects: Array<{ id: string; gitRemoteUrl: string | null }>, projectId: string, repo: string): boolean {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) return false;
    const remote = githubRepoFromRemote(project.gitRemoteUrl);
    return remote === null || remote === repo.toLowerCase();
  }

  /** The configured fallback for ad hoc and Jira cards; PR cards never use it, since it checks out another repository. */
  async function fallbackProject(sourceProjectId: string | null): Promise<string | null> {
    if (sourceProjectId !== null) return sourceProjectId;
    const { defaultProject } = await settings.get();
    return typeof defaultProject === "string" && defaultProject !== "" ? defaultProject : null;
  }

  async function projectMatchingRepo(repo: string): Promise<string | null> {
    const projects = await bb.sdk.projects.list();
    return projects.find((project) => githubRepoFromRemote(project.gitRemoteUrl) === repo.toLowerCase())?.id ?? null;
  }

  /**
   * Cards filed under a project that checks out another repository, or one since deleted, are
   * moved to the project matching their repository, or left without one for the next sync to resolve. A card whose
   * thread already runs there keeps it.
   */
  async function refileMisfiledPrs(rows: TicketRow[]): Promise<void> {
    const projects = await bb.sdk.projects.list();
    const now = Date.now();
    let changed = false;
    for (const row of rows) {
      if (row.pr_repo === null || row.project_id === null || row.thread_id !== null) continue;
      if (servesRepo(projects, row.project_id, row.pr_repo)) continue;
      const match = projects.find((project) => githubRepoFromRemote(project.gitRemoteUrl) === row.pr_repo!.toLowerCase())?.id ?? null;
      stmts.setProject.run(match, now, row.id);
      changed = true;
    }
    if (changed) publish();
  }

  /**
   * Sync-time resolution: a matching project, else (with auto-creation on) null for now while the clone runs in the
   * background and fills the card in, else the source's project when it isn't a checkout of another repository.
   */
  async function resolveProjectForRepo(repo: string, sourceProjectId: string | null = null): Promise<string | null> {
    const match = await projectMatchingRepo(repo);
    if (match !== null) return match;
    const { autoCreateProjects } = await settings.get();
    if (autoCreateProjects === true) {
      void ensureProjectForRepo(repo).then(
        (projectId) => {
          if (projectId !== null) void adoptProjectForRepo(repo, projectId).catch((error: unknown) => bb.log.warn(`could not adopt project ${projectId} for ${repo}: ${String(error)}`));
        },
        (error) => bb.log.warn(`could not create a project for ${repo}: ${String(error)}`),
      );
      return null;
    }
    if (sourceProjectId === null) return null;
    return servesRepo(await bb.sdk.projects.list(), sourceProjectId, repo) ? sourceProjectId : null;
  }

  /** Give every project-less card for `repo` the project, and start their threads if sync would have. */
  async function adoptProjectForRepo(repo: string, projectId: string): Promise<void> {
    const rows = stmts.unprojectedPrsForRepo.all(repo);
    if (rows.length === 0) return;
    const now = Date.now();
    for (const row of rows) stmts.setProjectIfUnset.run(projectId, now, row.id);
    publish();
    const { autoStartThreads } = await settings.get();
    if (autoStartThreads !== true) return;
    for (const row of rows) {
      try {
        await spawnThreadForTicket(row.id, projectId);
      } catch (error) {
        bb.log.warn(`could not start a thread for ticket ${row.id}: ${String(error)}`);
      }
    }
  }

  const projectCreations = new Map<string, Promise<string | null>>();

  /** A project whose remote is `repo`: the existing one, or one created from a fresh clone when auto-creation is on. */
  async function ensureProjectForRepo(repo: string): Promise<string | null> {
    const match = await projectMatchingRepo(repo);
    if (match !== null) return match;
    const { autoCreateProjects } = await settings.get();
    if (autoCreateProjects !== true) return null;
    let pending = projectCreations.get(repo);
    if (pending === undefined) {
      pending = createProjectForRepo(repo).finally(() => projectCreations.delete(repo));
      projectCreations.set(repo, pending);
    }
    return pending;
  }

  async function createProjectForRepo(repo: string): Promise<string | null> {
    const [owner, name] = repo.split("/");
    if (owner === undefined || name === undefined || name === "") throw new Error(`Not a GitHub repository: ${repo}`);
    const config = await bb.sdk.system.config();
    if (config.primaryHostId === null) throw new Error("bb has no primary host to clone on");
    const { cloneDir } = await settings.get();
    const base = typeof cloneDir === "string" && cloneDir.trim() !== "" ? cloneDir.trim() : join(config.dataDir, "plugins", bb.pluginId, "repos");
    const dir = join(base, owner, name);
    // Match the transport the user's other projects use so the same credentials work.
    const projects = await bb.sdk.projects.list();
    const useSsh = projects.some((project) => project.gitRemoteUrl?.startsWith("git@github.com:") === true);
    const url = useSsh ? `git@github.com:${repo}.git` : `https://github.com/${repo}.git`;
    if (!existsSync(join(dir, ".git"))) {
      await mkdir(dirname(dir), { recursive: true });
      bb.log.info(`cloning ${url} to ${dir} for a new project`);
      // Blobless clone: fast and small; worktrees fetch file contents on checkout.
      await execFileAsync("git", ["clone", "--filter=blob:none", "--", url, dir], { timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    }
    const created = await bb.sdk.projects.create({ name, source: { hostId: config.primaryHostId, path: dir, type: "local_path" } });
    bb.log.info(`created project ${created.name} (${created.id}) for ${repo}`);
    return created.id;
  }

  return { projectForTicket, fallbackProject, projectMatchingRepo, resolveProjectForRepo, adoptProjectForRepo, refileMisfiledPrs };
}

export type Projects = ReturnType<typeof createProjects>;
