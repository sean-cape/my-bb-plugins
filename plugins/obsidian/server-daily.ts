// Daily-note capture, bb activity history, and the agent routines (start/log/wrap)
// that file captures into the vault.
import nodePath from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parse as parseYaml } from "yaml";
import type { NoteContent, VaultTree, WriteResult } from "./contract.js";
import {
  DEFAULT_DAILY_TEMPLATE,
  appendToSection,
  dailyNotePath,
  dateKeyOfDailyPath,
  formatInboxEntry,
  isDateKey,
  localDateKey,
  localTime,
  openTasks,
  renderDailyTemplate,
  sectionItems,
} from "./shared/daily.ts";
import { isNotePath, noteTitle, parseFrontmatter } from "./shared/obsidian.ts";

export interface VaultAccess {
  vaultPath(): Promise<string>;
  hostId(): Promise<string>;
  /** Null when the file doesn't exist. */
  read(path: string): Promise<NoteContent | null>;
  write(path: string, content: string, expectedSha256: string | null): Promise<WriteResult>;
  tree(): Promise<VaultTree>;
}

export interface DailySettings {
  dailyFolder: string;
  dailyTemplate: string;
  inboxHeading: string;
  ticketsFolder: string;
  routineProvider: string;
  captureActivity: boolean;
}

export type RoutineMode = "start" | "log" | "wrap";

export interface ActivityItem {
  threadId: string;
  title: string;
  projectId: string;
  projectName: string;
  firstAt: number;
  lastAt: number;
  turns: number;
  lastText: string;
}

const MAX_APPEND_ATTEMPTS = 5;
const ACTIVITY_TEXT_LIMIT = 600;
const ACTIVITY_RETENTION_DAYS = 90;
const MENTION_RESULTS = 8;
const MENTION_CONTEXT_LIMIT = 60_000;
const CAPTURE_LIMIT = 20_000;
const VAULT_PROJECT_KEY = "vault-project";

function excerpt(text: string, limit: number): string {
  const trimmed = text.trim().replace(/\n{3,}/g, "\n\n");
  return trimmed.length > limit ? `${trimmed.slice(0, limit).trimEnd()}…` : trimmed;
}

export function createDaily(bb: BbPluginApi, vault: VaultAccess, getSettings: () => Promise<DailySettings>) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS activity (
      day TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      turns INTEGER NOT NULL,
      last_text TEXT NOT NULL,
      PRIMARY KEY (day, thread_id)
    )`,
  ]);
  const upsertActivity = db.prepare(`
    INSERT INTO activity (day, thread_id, title, project_id, project_name, first_at, last_at, turns, last_text)
    VALUES (@day, @threadId, @title, @projectId, @projectName, @at, @at, 1, @lastText)
    ON CONFLICT (day, thread_id) DO UPDATE SET
      title = excluded.title,
      project_name = excluded.project_name,
      last_at = excluded.last_at,
      turns = activity.turns + 1,
      last_text = CASE WHEN excluded.last_text = '' THEN activity.last_text ELSE excluded.last_text END
  `);
  const selectActivity = db.prepare(`
    SELECT thread_id AS threadId, title, project_id AS projectId, project_name AS projectName,
      first_at AS firstAt, last_at AS lastAt, turns, last_text AS lastText
    FROM activity WHERE day = ? ORDER BY first_at
  `);
  const pruneActivity = db.prepare(`DELETE FROM activity WHERE day < ?`);
  const forgetThreadActivity = db.prepare(`DELETE FROM activity WHERE thread_id = ?`);

  const projectNames = new Map<string, string>();
  async function projectName(projectId: string): Promise<string> {
    const cached = projectNames.get(projectId);
    if (cached !== undefined) return cached;
    const name = await bb.sdk.projects.get({ projectId }).then(
      (project) => project.name,
      () => projectId,
    );
    projectNames.set(projectId, name);
    return name;
  }

  function dailyPath(settings: DailySettings, dateKey: string): string {
    return dailyNotePath(settings.dailyFolder, dateKey);
  }

  async function ensureDailyNote(dateKey: string, now = new Date()): Promise<{ path: string; note: NoteContent }> {
    const settings = await getSettings();
    const path = dailyPath(settings, dateKey);
    const existing = await vault.read(path);
    if (existing !== null) return { path, note: existing };
    const templateNote = settings.dailyTemplate.trim() === "" ? null : await vault.read(withMd(settings.dailyTemplate));
    const content = renderDailyTemplate(templateNote?.content ?? DEFAULT_DAILY_TEMPLATE, dateKey, now);
    // Create-only: if something else created it first, use that one.
    await vault.write(path, content, null);
    const created = await vault.read(path);
    if (created === null) throw new Error(`Couldn't create ${path}`);
    return { path, note: created };
  }

  /** Appends a capture to today's inbox, retrying when the note changes underneath. */
  async function capture(text: string, source?: string, now = new Date()): Promise<{ path: string }> {
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("Nothing to log.");
    const settings = await getSettings();
    const entry = formatInboxEntry(excerpt(trimmed, CAPTURE_LIMIT), localTime(now), source);
    let { path, note } = await ensureDailyNote(localDateKey(now), now);
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const next = appendToSection(note.content, settings.inboxHeading, entry);
      const result = await vault.write(path, next, note.sha256);
      if (result.outcome === "written") return { path };
      const current = await vault.read(path);
      if (current === null) ({ path, note } = await ensureDailyNote(localDateKey(now), now));
      else note = current;
    }
    throw new Error("Today's note kept changing; try logging again.");
  }

  async function threadSource(threadId: string | undefined): Promise<string | undefined> {
    if (threadId === undefined) return undefined;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const title = excerpt(thread.title ?? thread.titleFallback ?? threadId, 60);
      return `bb: ${title} (${await projectName(thread.projectId)})`;
    } catch {
      return `bb thread ${threadId}`;
    }
  }

  function activityFor(dateKey: string): ActivityItem[] {
    return selectActivity.all(dateKey) as ActivityItem[];
  }

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const settings = await getSettings();
    if (!settings.captureActivity || thread.originPluginId === bb.pluginId) return;
    // Threads in the vault's own project are the routines filing this activity.
    const vaultProject = await bb.storage.kv.get<{ projectId: string }>(VAULT_PROJECT_KEY);
    if (vaultProject?.projectId === thread.projectId) return;
    const now = Date.now();
    upsertActivity.run({
      day: localDateKey(new Date(now)),
      threadId: thread.id,
      title: thread.title ?? thread.titleFallback ?? thread.id,
      projectId: thread.projectId,
      projectName: await projectName(thread.projectId),
      at: now,
      lastText: excerpt(lastAssistantText ?? "", ACTIVITY_TEXT_LIMIT),
    });
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    forgetThreadActivity.run(thread.id);
  });

  bb.background.schedule("prune-activity", "17 3 * * *", () => {
    const cutoff = new Date(Date.now() - ACTIVITY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    pruneActivity.run(localDateKey(cutoff));
  });

  /** The bb project rooted at the vault, created on first use so routines can run inside it. */
  async function vaultProjectId(): Promise<string> {
    const root = nodePath.resolve(await vault.vaultPath());
    const hostId = await vault.hostId();
    const remembered = await bb.storage.kv.get<{ projectId: string; root: string }>(VAULT_PROJECT_KEY);
    const projects = (await bb.sdk.projects.list()) as { id: string; sources?: { type: string; path: string; hostId: string }[] }[];
    const matches = (project: (typeof projects)[number]) =>
      project.sources?.some((source) => source.type === "local_path" && source.hostId === hostId && nodePath.resolve(source.path) === root) ?? false;
    const existing =
      projects.find((project) => project.id === remembered?.projectId && remembered.root === root && matches(project)) ?? projects.find(matches);
    if (existing !== undefined) {
      await bb.storage.kv.set(VAULT_PROJECT_KEY, { projectId: existing.id, root });
      return existing.id;
    }
    const created = await bb.sdk.projects.create({ name: nodePath.basename(root), source: { type: "local_path", hostId, path: root } });
    await bb.storage.kv.set(VAULT_PROJECT_KEY, { projectId: created.id, root });
    bb.log.info(`Created bb project ${created.id} for the vault at ${root}`);
    return created.id;
  }

  async function startRoutine(mode: RoutineMode, note?: string): Promise<{ threadId: string; projectId: string }> {
    const settings = await getSettings();
    const root = await vault.vaultPath();
    const projectId = await vaultProjectId();
    const dateKey = localDateKey(new Date());
    const extra = note === undefined || note.trim() === "" ? "" : ` ${note.trim()}`;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      providerId: settings.routineProvider,
      environment: { type: "host", hostId: await vault.hostId(), workspace: { type: "unmanaged", path: root } },
      title: `Daily ${mode} — ${dateKey}`,
      prompt: `/daily-note ${mode}${extra}`,
    });
    return { threadId: thread.id, projectId };
  }

  async function latestDailyBefore(settings: DailySettings, dateKey: string): Promise<string | null> {
    const tree = await vault.tree();
    let best: string | null = null;
    for (const file of tree.files) {
      const key = dateKeyOfDailyPath(settings.dailyFolder, file.path);
      if (key !== null && key < dateKey && (best === null || key > (dateKeyOfDailyPath(settings.dailyFolder, best) ?? ""))) best = file.path;
    }
    return best;
  }

  async function dashboard() {
    const settings = await getSettings();
    const dateKey = localDateKey(new Date());
    const todayPath = dailyPath(settings, dateKey);
    const today = await vault.read(todayPath);
    const previousPath = await latestDailyBefore(settings, dateKey);
    const previous = previousPath === null ? null : await vault.read(previousPath);
    const carrySource = today !== null && openTasks(today.content, "Carry to tomorrow").length > 0 ? null : previous;
    const tree = await vault.tree();
    const ticketPrefix = settings.ticketsFolder.replace(/\/+$/, "") + "/";
    const tickets = [];
    for (const file of tree.files) {
      if (!file.path.startsWith(ticketPrefix) || !isNotePath(file.path)) continue;
      const note = await vault.read(file.path);
      const frontmatter = note === null ? null : parseFrontmatter(note.content);
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = frontmatter === null ? null : parseYaml(frontmatter.raw);
        if (parsed !== null && typeof parsed === "object") data = parsed as Record<string, unknown>;
      } catch {
        // A broken frontmatter block just means no metadata for this ticket.
      }
      const status = typeof data.status === "string" ? data.status : "";
      tickets.push({
        path: file.path,
        key: typeof data.jira === "string" ? data.jira : noteTitle(file.path),
        summary: typeof data.summary === "string" ? data.summary : "",
        status,
        url: typeof data.url === "string" ? data.url : null,
        done: /^(done|closed|resolved|won't do)$/i.test(status),
      });
    }
    return {
      dateKey,
      today: {
        path: todayPath,
        exists: today !== null,
        inbox: today === null ? [] : sectionItems(today.content, settings.inboxHeading),
      },
      carryForward: {
        path: today !== null && carrySource === null ? todayPath : previousPath,
        items: openTasks((carrySource ?? today)?.content ?? "", "Carry to tomorrow"),
      },
      tickets: tickets.sort((a, b) => Number(a.done) - Number(b.done) || a.key.localeCompare(b.key, undefined, { numeric: true })),
      activity: activityFor(dateKey),
    };
  }

  bb.ui.registerMentionProvider({
    id: "vault",
    label: "Vault notes",
    async search({ query }) {
      const settings = await getSettings();
      const dateKey = localDateKey(new Date());
      const needle = query.trim().toLowerCase();
      const items: { id: string; title: string; subtitle?: string; icon?: string }[] = [];
      if (needle === "" || "today".startsWith(needle) || "daily".startsWith(needle)) {
        items.push({ id: "today", title: `Today's daily note`, subtitle: dailyPath(settings, dateKey), icon: "obsidian/vault" });
      }
      const tree = await vault.tree().catch(() => null);
      if (tree === null) return items;
      const notes = tree.files.filter((file) => isNotePath(file.path));
      const ranked = notes
        .map((file) => {
          const title = noteTitle(file.path).toLowerCase();
          const path = file.path.toLowerCase();
          const score = needle === "" ? file.mtimeMs : title.startsWith(needle) ? 3 : title.includes(needle) ? 2 : path.includes(needle) ? 1 : 0;
          return { file, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || b.file.mtimeMs - a.file.mtimeMs)
        .slice(0, MENTION_RESULTS);
      for (const { file } of ranked) items.push({ id: file.path, title: noteTitle(file.path), subtitle: file.path, icon: "obsidian/vault" });
      return items;
    },
    async resolve(itemId) {
      const settings = await getSettings();
      const path = itemId === "today" ? dailyPath(settings, localDateKey(new Date())) : itemId;
      const note = await vault.read(path);
      const absolute = nodePath.join(await vault.vaultPath(), path);
      if (note === null) return { context: `The Obsidian note ${path} does not exist yet (vault file ${absolute}).` };
      return { context: `Obsidian note "${path}" (file: ${absolute}):\n\n${excerpt(note.content, MENTION_CONTEXT_LIMIT)}` };
    },
  });

  return { capture, threadSource, activityFor, startRoutine, dashboard, ensureDailyNote, dailyPath: async (dateKey: string) => dailyPath(await getSettings(), dateKey) };
}

export function withMd(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

export function parseDateArg(value: string | undefined): string {
  if (value === undefined || value === "today") return localDateKey(new Date());
  if (value === "yesterday") return localDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  if (!isDateKey(value)) throw new Error(`Expected a date like 2026-10-06, "today" or "yesterday"; got ${value}`);
  return value;
}

export function formatActivity(items: readonly ActivityItem[]): string {
  if (items.length === 0) return "No bb thread activity recorded for that day.";
  return items
    .map((item) => {
      const span = `${localTime(new Date(item.firstAt))}–${localTime(new Date(item.lastAt))}`;
      const summary = item.lastText === "" ? "" : `\n  ${item.lastText.replace(/\n+/g, " ").slice(0, 300)}`;
      return `- ${span} [${item.projectName}] ${item.title} (${item.turns} turn${item.turns === 1 ? "" : "s"}, thread ${item.threadId})${summary}`;
    })
    .join("\n");
}
