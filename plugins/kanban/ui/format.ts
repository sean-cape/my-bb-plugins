import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { totalTokens, type Tokens } from "../shared/spend";

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function relativeTime(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export { shortSha } from "../shared/format";

/** The first sentence of a text: up to a full stop followed by a capitalised word ("e.g. at" is not an end); the whole text without one. */
export function firstSentence(text: string): string {
  const match = /^[\s\S]*?[.!?](?=\s+[A-Z"(]|$)/u.exec(text.trim());
  return match === null ? text.trim() : match[0];
}

/** Splits "Fix thing #infra #urgent" into a title and tags. */
export function parseQuickAdd(text: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  const title = text
    .replace(/(^|\s)#([a-z0-9][a-z0-9._-]*)/giu, (_match, _space: string, tag: string) => {
      tags.push(tag.toLowerCase());
      return " ";
    })
    .replace(/\s+/gu, " ")
    .trim();
  return { title, tags: [...new Set(tags)] };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** `today` moved by whole days, as `YYYY-MM-DD`. */
export function addDays(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The next given weekday after `today`, never `today` itself: `monday` on a Monday is a week off. */
export function nextWeekday(today: string, weekday: number): string {
  const current = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, ((weekday - current + 6) % 7) + 1);
}

/**
 * A typed day (`today`, `tomorrow`, a weekday or its first three letters, `YYYY-MM-DD`) as `YYYY-MM-DD`; null for
 * anything else. No `tom`: "@tom" in a title is far more often a person.
 */
export function parseDay(word: string, today: string): string | null {
  const lower = word.toLowerCase();
  if (lower === "today") return today;
  if (lower === "tomorrow") return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(lower)) return Number.isNaN(Date.parse(`${lower}T00:00:00Z`)) ? null : lower;
  const weekday = lower.length >= 3 ? WEEKDAYS.findIndex((name) => name.startsWith(lower)) : -1;
  return weekday === -1 ? null : nextWeekday(today, weekday);
}

export interface ParsedTodo {
  title: string;
  tags: string[];
  /** From `!p1`..`!p4` (or `!1`..`!4`). */
  priority: number | null;
  /** From `@today`, `@tomorrow`, `@fri`, `@2026-11-20`. */
  dueDate: string | null;
  /** From `+name`, matched to a project's id or name; a `+word` that names none stays in the title. */
  projectId: string | null;
}

/** Quick-add with the to-do markers on top of `#tag`: `Call the bank !p1 @fri +finance #home`. */
export function parseTodo(text: string, today: string, projects: readonly { id: string; name: string }[] = []): ParsedTodo {
  let priority: number | null = null;
  let dueDate: string | null = null;
  let projectId: string | null = null;
  const projectFor = (word: string) => {
    const wanted = slugify(word, "");
    return projects.find((project) => project.id === word || slugify(project.name, "") === wanted) ?? null;
  };
  const stripped = text
    .replace(/(^|\s)!p?([1-4])(?=\s|$)/giu, (_match, space: string, level: string) => {
      priority = Number(level);
      return space;
    })
    .replace(/(^|\s)@([\w-]+)(?=\s|$)/gu, (match, space: string, word: string) => {
      const day = parseDay(word, today);
      if (day === null) return match;
      dueDate = day;
      return space;
    })
    .replace(/(^|\s)\+([\w.-]+)(?=\s|$)/gu, (match, space: string, word: string) => {
      const project = projectFor(word);
      if (project === null) return match;
      projectId = project.id;
      return space;
    });
  const { title, tags } = parseQuickAdd(stripped);
  return { title, tags, priority, dueDate, projectId };
}

/** Whether a card is snoozed on the viewer's `today`: it comes back on its snooze day. */
export function isSnoozed(ticket: { snoozedUntil: string | null }, today: string): boolean {
  return ticket.snoozedUntil !== null && ticket.snoozedUntil > today;
}

/**
 * Whether a card is the agent kind: a PR, or one with a project, a thread, the loop or a review. Only those show the
 * code review, the review loop and the changes; any other card is a plain to-do.
 */
export function isAgentCard(ticket: { pr: unknown; projectId: string | null; threadId: string | null; loop: unknown; latestReview: unknown }): boolean {
  return ticket.pr !== null || ticket.projectId !== null || ticket.threadId !== null || ticket.loop !== null || ticket.latestReview !== null;
}

export const PRIORITY_LABEL: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };

/** Most urgent first; a card without a priority sorts after p4. */
export function byPriority(a: { priority: number | null }, b: { priority: number | null }): number {
  return (a.priority ?? 5) - (b.priority ?? 5);
}

export function threadStatusText(thread: PluginSidebarThread | null | undefined): string {
  if (thread === undefined) return "thread";
  if (thread === null) return "no thread";
  if (thread.hasPendingInteraction) return "needs you";
  if (thread.isArchived) return "archived";
  switch (thread.runtimeStatus) {
    case "active":
    case "starting":
      return "working";
    case "error":
      return "error";
    case "provisioning":
    case "waiting-for-host":
      return "provisioning";
    default:
      return "idle";
  }
}

/** A lowercase, dash-separated id from a display name, at most 40 characters; `fallback` when nothing is left. */
export function slugify(name: string, fallback: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || fallback
  );
}

/** Tags typed as a list, comma or space separated, with or without the leading `#`. */
export function parseTagList(text: string): string[] {
  return parseQuickAdd(text.split(/[\s,]+/u).filter(Boolean).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")).tags;
}

/** The viewer's local calendar day as `YYYY-MM-DD`, the form due dates are stored in. */
export function localDay(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 86_400_000;
}

export type DueTone = "overdue" | "soon" | "later";

/** How a due date reads against `today`: a short label, how far off it is, a tooltip sentence, and whether it needs attention. */
export function dueStatus(dueDate: string, today: string): { label: string; relative: string; title: string; tone: DueTone } {
  const days = dayNumber(dueDate) - dayNumber(today);
  // Formatting in UTC keeps the stored day from shifting under the viewer's offset.
  const at = new Date(`${dueDate}T00:00:00Z`);
  const sameYear = dueDate.slice(0, 4) === today.slice(0, 4);
  const short = at.toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  const long = at.toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const label = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : short;
  const relative =
    days === 0 ? "today" : days === 1 ? "tomorrow" : days > 0 ? `in ${days} days` : days === -1 ? "1 day overdue" : `${-days} days overdue`;
  return { label, relative, title: `Due ${long} · ${relative}`, tone: days < 0 ? "overdue" : days <= 1 ? "soon" : "later" };
}

/** How long ago, as the shortest readable unit: `now`, `12m`, `5h`, `3d`. */
export function shortAge(epochMs: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - epochMs) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A token count at a glance: `840`, `12k`, `1.4M`. */
export function shortTokens(count: number): string {
  if (count < 1000) return String(count);
  const [value, unit] = count < 1_000_000 ? [count / 1000, "k"] : [count / 1_000_000, "M"];
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/u, "") : Math.round(value)}${unit}`;
}

/** What a card's token count is made of, for its tooltip. */
export function spendTitle(tokens: Tokens): string {
  const n = (count: number) => count.toLocaleString();
  return `${n(totalTokens(tokens))} tokens across the card's threads: ${n(tokens.input)} input, ${n(tokens.output)} output, ${n(tokens.cacheRead)} cache read, ${n(tokens.cacheWrite)} cache write`;
}

/** A card description flattened to plain prose for a two-line preview: Markdown markers, links and code fences dropped. */
export function cardSnippet(description: string): string {
  return description
    .replace(/```[\s\S]*?(```|$)/gu, " ")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+[.)]\s+)/u, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/[*_`~]+/gu, ""),
    )
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}
