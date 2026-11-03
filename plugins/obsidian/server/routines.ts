// The /daily-note agent routines, run as bb threads inside a bb project rooted at the vault.
import nodePath from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RoutineMode } from "../rpc-contract.ts";
import { localDateKey } from "../shared/daily.ts";
import type { VaultAccess } from "./daily.ts";

const VAULT_PROJECT_KEY = "vault-project";

interface RememberedProject {
  projectId: string;
  root: string;
}

interface ProjectSummary {
  id: string;
  sources?: { type: string; path: string; hostId: string }[];
}

export function createRoutines(bb: BbPluginApi, vault: VaultAccess, routineProvider: () => Promise<string>) {
  /** The bb project rooted at the vault, created on first use so routines can run inside it. */
  async function vaultProjectId(): Promise<string> {
    const root = nodePath.resolve(await vault.vaultPath());
    const hostId = await vault.hostId();
    const remembered = await bb.storage.kv.get<RememberedProject>(VAULT_PROJECT_KEY);
    const projects = (await bb.sdk.projects.list()) as ProjectSummary[];
    const matches = (project: ProjectSummary) =>
      project.sources?.some((source) => source.type === "local_path" && source.hostId === hostId && nodePath.resolve(source.path) === root) ?? false;
    const existing =
      projects.find((project) => project.id === remembered?.projectId && remembered.root === root && matches(project)) ?? projects.find(matches);
    if (existing !== undefined) {
      await bb.storage.kv.set(VAULT_PROJECT_KEY, { projectId: existing.id, root } satisfies RememberedProject);
      return existing.id;
    }
    const created = await bb.sdk.projects.create({ name: nodePath.basename(root), source: { type: "local_path", hostId, path: root } });
    await bb.storage.kv.set(VAULT_PROJECT_KEY, { projectId: created.id, root } satisfies RememberedProject);
    bb.log.info(`Created bb project ${created.id} for the vault at ${root}`);
    return created.id;
  }

  /** Threads in the vault's own project are the routines filing activity, not activity themselves. */
  async function isVaultProject(projectId: string): Promise<boolean> {
    const remembered = await bb.storage.kv.get<RememberedProject>(VAULT_PROJECT_KEY);
    return remembered?.projectId === projectId;
  }

  async function start(mode: RoutineMode): Promise<{ threadId: string }> {
    const providerId = await routineProvider();
    const root = await vault.vaultPath();
    const projectId = await vaultProjectId();
    const dateKey = localDateKey(new Date());
    const thread = await bb.sdk.threads.spawn({
      projectId,
      providerId,
      environment: { type: "host", hostId: await vault.hostId(), workspace: { type: "unmanaged", path: root } },
      title: `Daily ${mode} — ${dateKey}`,
      prompt: routinePrompt(mode),
    });
    return { threadId: thread.id };
  }

  return { start, isVaultProject };
}

/**
 * The prompt a routine thread starts with. A bare `/daily-note start` reached the agent as text: the provider doesn't
 * expand slash commands in a spawned prompt, and the agent, seeing no skill by that name, built the note by hand. So the
 * prompt names the skill and the tool that loads it.
 */
export function routinePrompt(mode: RoutineMode): string {
  return [
    `Run the \`daily-note\` skill in \`${mode}\` mode: load it with the Skill tool (skill \`daily-note\`, args \`${mode}\`) and follow it.`,
    "If no skill by that name is available, stop and say so instead of writing the note by hand.",
  ].join("\n");
}
