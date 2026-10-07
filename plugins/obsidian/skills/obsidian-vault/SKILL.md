---
name: obsidian-vault
description: Read, search, and log to the user's Obsidian vault (daily notes, ticket notes, wiki) with the `bb obsidian` CLI. Use when the user asks to log, note, jot down, or save something for later or to their daily note, to look something up in their notes or wiki, or when finishing work they asked to have recorded.
---

# Obsidian vault

The Obsidian Vault plugin connects bb to one Obsidian vault. Run `bb obsidian path` for its folder.

## Commands

| Command | Effect |
| --- | --- |
| `bb obsidian log "<text>"` | Append a timestamped entry to the **Inbox** section of today's daily note. Creates the note from the template when needed. Tags the entry with this thread's title. |
| `bb obsidian today` | Print the absolute path of today's daily note, creating it first. Add `--content` to print the note instead. |
| `bb obsidian search <query>` | Full-text search across the vault. Add `--json` for structured output. |
| `bb obsidian activity [--date YYYY-MM-DD\|today\|yesterday]` | bb threads worked on that day: project, title, time span, turns, last reply. |
| `bb obsidian start` / `bb obsidian wrap` | Start a Claude thread running `/daily-note start` or `/daily-note wrap` in the vault. |

## Logging

- Log when the user asks you to note, log, or remember something for the daily note, and when they asked to have finished work recorded.
- Write one self-contained entry the user could act on tomorrow: what happened, the outcome, and identifiers such as `PROJ-123`, PR numbers, hosts, and commands.
- Keep entries short, a few lines at most. Put long material in a wiki note and log a `[[link]]` to it.
- Don't log routine turns. The plugin already records which threads ran each day.
- Use `bb obsidian log`, not direct file edits, while the user may have the note open. It merges safely with their edits.

## Vault conventions

- `DailyNotes/YYYY-MM-DD.md`: one note per day. Sections: Inbox (raw captures), Plan, Meetings, Work Log, Carry to tomorrow. `/daily-note log` and `/daily-note wrap` file the Inbox into the other sections.
- `Tickets/PROJ-123.md`: one note per Jira ticket, with `jira`, `status`, `summary`, and `url` in its frontmatter. Daily notes link tickets as `[[PROJ-123]]`.
- `Wiki/`: durable reference material such as setup guides and runbooks.
- `Meetings/YYYY-MM-DD Title.md`: meeting notes, linked from that day's daily note.
- Use `[[wikilinks]]` for links between notes, and valid Obsidian markdown.

## Reading

Prefer `bb obsidian search` to find notes, then read them directly with the file path under `bb obsidian path`. When editing notes directly, keep the frontmatter and section headings intact.
