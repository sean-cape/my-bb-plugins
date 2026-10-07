import nodePath from "node:path";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  backlinksSchema,
  hostContract,
  hostSignals,
  moveResultSchema,
  noteSchema,
  searchSchema,
  treeSchema,
  VAULT_CHANGED,
  writeResultSchema,
  type VaultChangedPayload,
} from "./contract.js";
import { createDaily, formatActivity, parseDateArg, type DailySettings, type VaultAccess } from "./server-daily.js";

const relativePath = z.string().min(1).max(1024);

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      vaultPath: z.string().nullable(),
      vaultName: z.string().nullable(),
      dailyFolder: z.string(),
      todayKey: z.string(),
    }),
  },
  configure: {
    input: z.object({ vaultPath: z.string().trim().min(1).max(1024) }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },
  tree: { input: z.null(), output: treeSchema },
  read: { input: z.object({ path: relativePath }).strict(), output: noteSchema },
  write: {
    input: z
      .object({
        path: relativePath,
        content: z.string(),
        expectedSha256: z.string().nullable().optional(),
      })
      .strict(),
    output: writeResultSchema,
  },
  mkdir: {
    input: z.object({ path: relativePath }).strict(),
    output: z.object({ path: z.string() }),
  },
  move: {
    input: z.object({ from: relativePath, to: relativePath, updateLinks: z.boolean() }).strict(),
    output: moveResultSchema,
  },
  trash: {
    input: z.object({ path: relativePath }).strict(),
    output: z.object({ trashedTo: z.string() }),
  },
  backlinks: { input: z.object({ path: relativePath }).strict(), output: backlinksSchema },
  search: {
    input: z.object({ query: z.string().trim().min(1).max(500) }).strict(),
    output: searchSchema,
  },
  previewBase: {
    input: z.null(),
    output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }),
  },
  capture: {
    input: z.object({ text: z.string().min(1).max(50_000), threadId: z.string().optional() }).strict(),
    output: z.object({ path: z.string() }),
  },
  openToday: {
    input: z.null(),
    output: z.object({ path: z.string() }),
  },
  startRoutine: {
    input: z.object({ mode: z.enum(["start", "log", "wrap"]) }).strict(),
    output: z.object({ threadId: z.string() }),
  },
  dashboard: {
    input: z.null(),
    output: z.object({
      dateKey: z.string(),
      today: z.object({ path: z.string(), exists: z.boolean(), inbox: z.array(z.string()) }),
      carryForward: z.object({ path: z.string().nullable(), items: z.array(z.string()) }),
      tickets: z.array(
        z.object({
          path: z.string(),
          key: z.string(),
          summary: z.string(),
          status: z.string(),
          url: z.string().nullable(),
          done: z.boolean(),
        }),
      ),
      activity: z.array(
        z.object({
          threadId: z.string(),
          title: z.string(),
          projectId: z.string(),
          projectName: z.string(),
          firstAt: z.number(),
          lastAt: z.number(),
          turns: z.number(),
          lastText: z.string(),
        }),
      ),
    }),
  },
});

const WATCH_RECONCILE_MS = 60_000;
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const SEARCH_LIMIT = 100;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    vaultPath: {
      type: "string",
      label: "Vault folder",
      description: "Absolute path to the Obsidian vault on the bb server machine.",
      default: "",
    },
    updateLinksOnRename: {
      type: "boolean",
      label: "Update links when renaming or moving notes",
      default: true,
    },
    dailyFolder: {
      type: "string",
      label: "Daily notes folder",
      description: "Vault folder holding YYYY-MM-DD.md daily notes.",
      default: "DailyNotes",
    },
    dailyTemplate: {
      type: "string",
      label: "Daily note template",
      description: "Vault note used for new daily notes. {{date}}, {{weekday}} and {{time}} are filled in.",
      default: "Templates/Daily Note.md",
    },
    inboxHeading: {
      type: "string",
      label: "Inbox heading",
      description: "Section of the daily note that quick captures are appended to.",
      default: "Inbox",
    },
    ticketsFolder: {
      type: "string",
      label: "Ticket notes folder",
      default: "Tickets",
    },
    routineProvider: {
      type: "string",
      label: "Agent for daily routines",
      description: "Provider that runs Start day / Wrap up. It must have the daily-note skill.",
      default: "claude-code",
    },
    captureActivity: {
      type: "boolean",
      label: "Record bb thread activity for daily notes",
      description: "Keeps a per-day list of threads you worked on (title, project, last reply) for the wrap-up.",
      default: true,
    },
  });

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  async function hostId(): Promise<string> {
    const { primaryHostId } = await bb.sdk.system.config();
    if (primaryHostId === null) throw new Error("The bb server machine is not connected yet.");
    return primaryHostId;
  }

  async function vaultPath(): Promise<string> {
    const { vaultPath } = await settings.get();
    if (vaultPath.trim() === "") throw new Error("Choose a vault folder first.");
    return vaultPath;
  }

  async function ensureWatch(): Promise<void> {
    const { vaultPath } = await settings.get();
    if (vaultPath.trim() === "") return;
    const { started } = await host.call("watch", { vaultPath }, { hostId: await hostId() });
    // A new watch (first start, worker restart, recovered watcher) may follow missed changes.
    if (started) publish({ paths: [], structural: true });
  }

  function reportWatchFailure(error: unknown) {
    bb.log.warn(`Vault watch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  function publish(payload: VaultChangedPayload) {
    bb.realtime.publish(VAULT_CHANGED, payload);
  }

  host.experimental_onSignal("changed", async ({ payload }) => {
    const { vaultPath } = await settings.get();
    if (payload.vaultPath !== vaultPath) return;
    publish({ paths: payload.paths, structural: payload.structural });
  });
  host.experimental_onWorkerExit(() => {
    ensureWatch().catch(reportWatchFailure);
  });
  settings.onChange((next, previous) => {
    if (next.vaultPath === previous.vaultPath) return;
    ensureWatch().catch(reportWatchFailure);
    publish({ paths: [], structural: true });
  });

  bb.background.service("vault-watch", {
    async start(signal) {
      while (!signal.aborted) {
        await ensureWatch().catch(reportWatchFailure);
        await sleep(WATCH_RECONCILE_MS, signal);
      }
    },
  });

  const vault: VaultAccess = {
    vaultPath,
    hostId,
    async read(path) {
      try {
        return await host.call("read", { vaultPath: await vaultPath(), path }, { hostId: await hostId() });
      } catch (error) {
        if (/ENOENT|no such file/i.test(error instanceof Error ? error.message : String(error))) return null;
        throw error;
      }
    },
    async write(path, content, expectedSha256) {
      return host.call("write", { vaultPath: await vaultPath(), path, content, expectedSha256 }, { hostId: await hostId() });
    },
    async tree() {
      return host.call("tree", { vaultPath: await vaultPath() }, { hostId: await hostId() });
    },
  };
  const daily = createDaily(bb, vault, async (): Promise<DailySettings> => {
    const values = await settings.get();
    return {
      dailyFolder: values.dailyFolder.trim() || "DailyNotes",
      dailyTemplate: values.dailyTemplate.trim(),
      inboxHeading: values.inboxHeading.trim() || "Inbox",
      ticketsFolder: values.ticketsFolder.trim() || "Tickets",
      routineProvider: values.routineProvider.trim() || "claude-code",
      captureActivity: values.captureActivity,
    };
  });

  bb.rpc.register(rpcContract, {
    async status() {
      const { vaultPath, dailyFolder } = await settings.get();
      const trimmed = vaultPath.trim();
      return {
        vaultPath: trimmed === "" ? null : trimmed,
        vaultName: trimmed === "" ? null : nodePath.basename(trimmed),
        dailyFolder: dailyFolder.trim() || "DailyNotes",
        todayKey: parseDateArg("today"),
      };
    },
    async capture({ text, threadId }) {
      return daily.capture(text, await daily.threadSource(threadId));
    },
    async openToday() {
      const { path } = await daily.ensureDailyNote(parseDateArg("today"));
      return { path };
    },
    async startRoutine({ mode }) {
      const { threadId } = await daily.startRoutine(mode);
      return { threadId };
    },
    async dashboard() {
      return daily.dashboard();
    },
    async configure({ vaultPath }) {
      const result = await host.call("checkVault", { vaultPath }, { hostId: await hostId() });
      if (result.ok) await settings.experimental_set({ vaultPath: nodePath.resolve(vaultPath) });
      return result;
    },
    async tree() {
      return host.call("tree", { vaultPath: await vaultPath() }, { hostId: await hostId() });
    },
    async read({ path }) {
      return host.call("read", { vaultPath: await vaultPath(), path }, { hostId: await hostId() });
    },
    async write({ path, content, expectedSha256 }) {
      return host.call(
        "write",
        { vaultPath: await vaultPath(), path, content, expectedSha256 },
        { hostId: await hostId() },
      );
    },
    async mkdir({ path }) {
      return host.call("mkdir", { vaultPath: await vaultPath(), path }, { hostId: await hostId() });
    },
    async move({ from, to, updateLinks }) {
      const { updateLinksOnRename } = await settings.get();
      return host.call(
        "move",
        { vaultPath: await vaultPath(), from, to, updateLinks: updateLinks && updateLinksOnRename },
        { hostId: await hostId(), timeoutMs: 120_000 },
      );
    },
    async trash({ path }) {
      return host.call("trash", { vaultPath: await vaultPath(), path }, { hostId: await hostId() });
    },
    async backlinks({ path }) {
      return host.call("backlinks", { vaultPath: await vaultPath(), path }, { hostId: await hostId() });
    },
    async search({ query }) {
      return host.call(
        "search",
        { vaultPath: await vaultPath(), query, limit: SEARCH_LIMIT },
        { hostId: await hostId() },
      );
    },
    async previewBase() {
      return bb.sdk.files.createPreview({
        hostId: await hostId(),
        rootPath: await vaultPath(),
        ttlMs: PREVIEW_TTL_MS,
      });
    },
  });

  const usage = [
    "Usage:",
    "  bb obsidian log <text…>            Append a timestamped entry to today's daily-note inbox",
    "  bb obsidian today [--content]      Print today's daily-note path (creating it), or its content",
    "  bb obsidian activity [--date D]    bb threads worked on that day (default today) [--json]",
    "  bb obsidian search <query…>        Full-text search the vault [--json]",
    "  bb obsidian path                   Print the vault's absolute path",
    "  bb obsidian start|wrap             Start a Claude thread running /daily-note start or wrap",
  ].join("\n");
  const bounded = (text: string) => {
    const limit = PLUGIN_CLI_OUTPUT_MAX_BYTES - 1024;
    return Buffer.byteLength(text) <= limit ? text : `${Buffer.from(text).subarray(0, limit).toString("utf8")}\n… (truncated)`;
  };
  bb.cli.register({
    name: "obsidian",
    summary: "Log to and query the Obsidian vault (daily notes, activity, search)",
    commands: [
      { name: "log", summary: "Append a timestamped entry to today's daily-note inbox", usage: "bb obsidian log <text…>" },
      { name: "today", summary: "Print today's daily-note path (creating it) or its content", usage: "bb obsidian today [--content]" },
      { name: "activity", summary: "List bb threads worked on for a day", usage: "bb obsidian activity [--date YYYY-MM-DD|today|yesterday] [--json]" },
      { name: "search", summary: "Full-text search the vault", usage: "bb obsidian search <query…> [--json]" },
      { name: "path", summary: "Print the vault's absolute path", usage: "bb obsidian path" },
      { name: "start", summary: "Start a thread running /daily-note start", usage: "bb obsidian start" },
      { name: "wrap", summary: "Start a thread running /daily-note wrap", usage: "bb obsidian wrap" },
    ],
    async run(argv, context) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
          case "-h":
            return { exitCode: 0, stdout: usage };
          case "log": {
            const text = rest.join(" ").trim();
            if (text === "") return fail("Usage: bb obsidian log <text…>");
            const { path } = await daily.capture(text, await daily.threadSource(context.threadId));
            return { exitCode: 0, stdout: json ? JSON.stringify({ path }) : `Logged to ${path}` };
          }
          case "today": {
            const { path, note } = await daily.ensureDailyNote(parseDateArg("today"));
            if (rest.includes("--content")) return { exitCode: 0, stdout: bounded(note.content) };
            const absolute = nodePath.join(await vaultPath(), path);
            return { exitCode: 0, stdout: json ? JSON.stringify({ path, absolute }) : absolute };
          }
          case "activity": {
            const dateIndex = rest.indexOf("--date");
            const dateKey = parseDateArg(dateIndex === -1 ? undefined : rest[dateIndex + 1]);
            const items = daily.activityFor(dateKey);
            return { exitCode: 0, stdout: bounded(json ? JSON.stringify(items) : formatActivity(items)) };
          }
          case "search": {
            const query = rest.join(" ").trim();
            if (query === "") return fail("Usage: bb obsidian search <query…>");
            const result = await host.call("search", { vaultPath: await vaultPath(), query, limit: 30 }, { hostId: await hostId() });
            if (json) return { exitCode: 0, stdout: bounded(JSON.stringify(result)) };
            const lines = result.results.map((hit) => [hit.path, ...hit.matches.map((match) => `  ${match.line + 1}: ${match.text}`)].join("\n"));
            return { exitCode: 0, stdout: bounded(lines.length === 0 ? "No matches." : lines.join("\n")) };
          }
          case "path":
            return { exitCode: 0, stdout: await vaultPath() };
          case "start":
          case "wrap": {
            const { threadId } = await daily.startRoutine(command);
            return { exitCode: 0, stdout: json ? JSON.stringify({ threadId }) : `Started ${threadId}` };
          }
        }
        return fail(usage);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
