// Daily-note conventions shared by the server (capture, routines) and the UI.
import { joinPath, parseFrontmatter } from "./obsidian.ts";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** YYYY-MM-DD in the machine's local time zone, matching Obsidian's daily-note names. */
export function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

export function weekdayOf(dateKey: string): string {
  return WEEKDAYS[new Date(`${dateKey}T12:00:00`).getDay()] ?? "";
}

export function dailyNotePath(folder: string, dateKey: string): string {
  return joinPath(folder.replace(/^\/+|\/+$/g, ""), `${dateKey}.md`);
}

/** The date a daily-note path is for, or null when the path isn't a daily note. */
export function dateKeyOfDailyPath(folder: string, path: string): string | null {
  const prefix = folder.replace(/^\/+|\/+$/g, "");
  const match = /^(.*\/)?(\d{4}-\d{2}-\d{2})\.md$/.exec(path);
  if (match === null) return null;
  const dir = (match[1] ?? "").replace(/\/$/, "");
  return dir === prefix && isDateKey(match[2]!) ? match[2]! : null;
}

export const DEFAULT_DAILY_TEMPLATE = `---
date: {{date}}
tags: [daily]
tickets: []
prs: []
meetings: []
---
# {{date}} — {{weekday}}

## Inbox

## Plan

## Meetings

## Work Log

## Carry to tomorrow
`;

/** Fills Obsidian core-template style placeholders: {{date}}, {{title}}, {{weekday}}, {{time}}. */
export function renderDailyTemplate(template: string, dateKey: string, now: Date): string {
  return template
    .replace(/\{\{\s*date(?::[^}]*)?\s*\}\}/g, dateKey)
    .replace(/\{\{\s*title\s*\}\}/g, dateKey)
    .replace(/\{\{\s*weekday\s*\}\}/g, weekdayOf(dateKey))
    .replace(/\{\{\s*time(?::[^}]*)?\s*\}\}/g, localTime(now));
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;

interface Section {
  /** Line index of the heading. */
  heading: number;
  level: number;
  /** Line index just past the section's last line. */
  end: number;
}

function findSection(lines: string[], title: string, startLine: number): Section | null {
  const wanted = title.trim().toLowerCase();
  let fence = false;
  for (let index = startLine; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const match = HEADING.exec(line);
    if (match === null || match[2]!.trim().toLowerCase() !== wanted) continue;
    const level = match[1]!.length;
    let end = lines.length;
    let innerFence = false;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^\s*(```|~~~)/.test(lines[next]!)) innerFence = !innerFence;
      if (innerFence) continue;
      const other = HEADING.exec(lines[next]!);
      if (other !== null && other[1]!.length <= level) {
        end = next;
        break;
      }
    }
    return { heading: index, level, end };
  }
  return null;
}

function bodyStart(content: string): number {
  const frontmatter = parseFrontmatter(content);
  return frontmatter === null ? 0 : content.slice(0, frontmatter.end).split("\n").length - 1;
}

/**
 * Appends `entry` (one or more lines) to the end of the section titled
 * `heading`, creating the section at the end of the note when it's missing.
 */
export function appendToSection(content: string, heading: string, entry: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const entryLines = entry.replace(/\r\n/g, "\n").split("\n");
  const section = findSection(lines, heading, bodyStart(content));
  if (section === null) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push("", `## ${heading}`, ...entryLines, "");
    return lines.join(newline);
  }
  let insertAt = section.end;
  while (insertAt > section.heading + 1 && lines[insertAt - 1]!.trim() === "") insertAt -= 1;
  const needsGapAfter = section.end < lines.length && insertAt === section.end;
  // Keep a blank line between the new entry and the next heading.
  lines.splice(insertAt, 0, ...entryLines, ...(needsGapAfter ? [""] : []));
  return lines.join(newline);
}

/** The non-blank lines inside a section, or [] when it doesn't exist. */
export function sectionLines(content: string, heading: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const section = findSection(lines, heading, bodyStart(content));
  if (section === null) return [];
  return lines.slice(section.heading + 1, section.end).filter((line) => line.trim() !== "");
}

/** Unchecked `- [ ]` items in a section, with the checkbox stripped. */
export function openTasks(content: string, heading: string): string[] {
  return sectionLines(content, heading)
    .map((line) => /^\s*[-*+]\s+\[ \]\s+(.*)$/.exec(line)?.[1]?.trim())
    .filter((item): item is string => item !== undefined && item !== "");
}

/** A timestamped inbox bullet; continuation lines are indented under it. */
export function formatInboxEntry(text: string, time: string, source?: string): string {
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  const suffix = source === undefined || source === "" ? "" : ` — _via ${source}_`;
  const [first = "", ...rest] = lines;
  return [`- ${time} ${first}${rest.length === 0 ? suffix : ""}`, ...rest.map((line, index) => `  ${line}${index === rest.length - 1 ? suffix : ""}`)].join("\n");
}

/** Top-level list items in a section, with indented continuation lines folded in. */
export function sectionItems(content: string, heading: string): string[] {
  const items: string[] = [];
  for (const line of sectionLines(content, heading)) {
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) items.push(bullet[1]!);
    else if (items.length > 0 && /^\s/.test(line)) items[items.length - 1] += `\n${line.trim()}`;
    else items.push(line.trim());
  }
  return items;
}
