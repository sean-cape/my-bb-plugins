import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

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

export function shortSha(sha: string | null): string {
  return sha === null ? "?" : sha.slice(0, 7);
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
