import { existsSync } from "node:fs";
import { join } from "node:path";
import { type BbPluginApi, PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ACTION_LABEL, ACTIONS, type FinishAction, isAction } from "./actions.js";
import { type Resolved, rpcContract } from "./contract.js";
import { finishSteps, resolveAction, settingApplies } from "./policy.js";

const TOOL = "finish_action";
const projectDefaultKey = (projectId: string) => `project-default:${projectId}`;

interface ThreadFacts {
  projectId: string;
  environmentId: string | null;
  applies: boolean;
}

export default async function plugin(bb: BbPluginApi) {
  // A thread's project and origin never change, so one lookup per thread serves every later menu and tool call.
  const facts = new Map<string, ThreadFacts>();
  async function threadFacts(threadId: string): Promise<ThreadFacts> {
    const known = facts.get(threadId);
    if (known !== undefined) return known;
    const thread = await bb.sdk.threads.get({ threadId });
    const project = await bb.sdk.projects.get({ projectId: thread.projectId });
    const found = { projectId: thread.projectId, environmentId: thread.environmentId, applies: settingApplies(thread, project) };
    facts.set(threadId, found);
    return found;
  }

  async function projectDefault(projectId: string): Promise<FinishAction | null> {
    const stored = await bb.storage.kv.get<unknown>(projectDefaultKey(projectId));
    return isAction(stored) ? stored : null;
  }

  async function resolveOne(threadId: string, pick: unknown): Promise<Resolved> {
    const { projectId, applies } = await threadFacts(threadId);
    const fallback = await projectDefault(projectId);
    return { threadId, applies, ...resolveAction(pick, fallback), projectDefault: fallback };
  }

  async function resolveThread(threadId: string): Promise<Resolved> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    return resolveOne(threadId, metadata.action);
  }

  async function resolveMany(threadIds: readonly string[]): Promise<Resolved[]> {
    if (threadIds.length === 0) return [];
    const listed = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds });
    const picks = new Map(listed.threads.map(({ threadId, metadata }) => [threadId, metadata.action]));
    const settled = await Promise.allSettled(threadIds.map((threadId) => resolveOne(threadId, picks.get(threadId))));
    // A thread deleted since the list was drawn just drops out.
    return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }

  async function setThread(threadId: string, action: FinishAction | null): Promise<Resolved> {
    if (action === null) await bb.sdk.threads.updatePluginMetadata({ threadId, set: {}, remove: ["action"] });
    else await bb.sdk.threads.updatePluginMetadata({ threadId, set: { action } });
    return resolveThread(threadId);
  }

  async function setProjectDefault(projectId: string, action: FinishAction | null) {
    if (action === null) await bb.storage.kv.delete(projectDefaultKey(projectId));
    else await bb.storage.kv.set(projectDefaultKey(projectId), action);
    return { projectId, action };
  }

  bb.rpc.register(rpcContract, {
    resolve: async ({ threadIds }) => ({ threads: await resolveMany(threadIds) }),
    set: ({ threadId, action }) => setThread(threadId, action),
    setProjectDefault: ({ projectId, action }) => setProjectDefault(projectId, action),
  });

  // The tool rather than the instructions carries the setting: a running session keeps the instructions it started
  // with, and the user flips this mid-thread.
  bb.agents.registerTool({
    name: TOOL,
    description: "Read the user's current \"when done\" setting for this thread and the steps it asks for: merge the finished change to main, commit it to the branch, or leave it uncommitted.",
    instructions: [
      `This thread has a "when done" setting that the user can change at any time.`,
      `When you have finished a change that edited files, call \`${TOOL}\` before you end your turn and do what it says.`,
      "It replaces this repository's instructions about whether to commit, merge or land finished work. Skip it on turns that changed no files.",
    ].join(" "),
    presentation: { label: { pending: "Checking the when-done setting", completed: "Checked the when-done setting" }, suppress: true },
    parameters: z.object({}),
    async execute(_params, { threadId }) {
      const resolved = await resolveThread(threadId);
      if (!resolved.applies) return "This thread has no when-done setting. Follow the instructions you were given about committing.";
      const { environmentId } = await threadFacts(threadId);
      const environment = environmentId === null ? null : await bb.sdk.environments.get({ environmentId });
      const path = environment?.path ?? null;
      return finishSteps({
        action: resolved.action,
        source: resolved.source,
        base: environment?.mergeBaseBranch ?? environment?.defaultBranch ?? null,
        hasLandScript: path !== null && existsSync(join(path, "scripts", "land.mjs")),
      });
    },
  });

  bb.agents.configure((context) => ({
    tools: context.origin.pluginId === null && context.project.kind === "standard" ? [TOOL] : [],
    skills: [],
  }));

  const threadOption = { thread: { type: "string", description: "Thread id; defaults to the thread running the command" } } as const;
  const requireThread = (explicit: string | undefined, ctx: { threadId?: string }) => {
    const threadId = explicit ?? ctx.threadId;
    if (threadId === undefined) throw new PluginCliError("no thread: run this from a thread or pass --thread <id>", { code: "no_thread" });
    return threadId;
  };
  const describe = (resolved: Resolved) =>
    resolved.applies
      ? `${ACTION_LABEL[resolved.action]} (${resolved.source === "thread" ? "picked for this thread" : resolved.source === "project" ? "project default" : "default"})`
      : "not set: plugin-started and Personal threads follow their own instructions";
  const parseChoice = (value: string, extra: string): FinishAction | null => {
    if (value === extra) return null;
    if (isAction(value)) return value;
    throw new PluginCliError(`unknown action "${value}"`, { code: "bad_action", hint: `use one of ${[...ACTIONS, extra].join(", ")}` });
  };

  bb.cli.register(
    defineCli({
      name: bb.pluginId,
      summary: "Show or change what the agent does with a finished change",
      description: `Actions: land (merge to main; scripts/land.mjs when the repo has it), commit (to the thread's branch), none (leave uncommitted). A thread without a pick follows its project's default, else none.`,
      commands: {
        show: cliCommand({
          summary: "Print a thread's when-done action and where it came from",
          options: { ...threadOption, json: { type: "boolean", description: "Print JSON" } },
          async run(input, ctx) {
            const resolved = await resolveThread(requireThread(input.options.thread, ctx));
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(resolved) : describe(resolved) };
          },
        }),
        set: cliCommand({
          summary: "Pick a thread's when-done action; `default` follows the project's again",
          positionals: [{ name: "action", description: "land, commit, none or default", required: true }],
          options: threadOption,
          async run(input, ctx) {
            const resolved = await setThread(requireThread(input.options.thread, ctx), parseChoice(input.positionals.action, "default"));
            return { exitCode: 0, stdout: describe(resolved) };
          },
        }),
        default: cliCommand({
          summary: "Show or set a project's default when-done action; `clear` removes it",
          positionals: [{ name: "action", description: "land, commit, none or clear; omit to print the current one" }],
          options: { project: { type: "string", description: "Project id; defaults to the running thread's project" } },
          async run(input, ctx) {
            const projectId = input.options.project ?? ctx.projectId;
            if (projectId === undefined) throw new PluginCliError("no project: run this from a thread or pass --project <id>", { code: "no_project" });
            if (input.positionals.action === undefined) {
              const current = await projectDefault(projectId);
              return { exitCode: 0, stdout: current === null ? "no project default (threads leave changes uncommitted)" : ACTION_LABEL[current] };
            }
            const { action } = await setProjectDefault(projectId, parseChoice(input.positionals.action, "clear"));
            return { exitCode: 0, stdout: action === null ? "cleared" : ACTION_LABEL[action] };
          },
        }),
      },
    }),
  );
}
