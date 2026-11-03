Work in your Obsidian vault without leaving bb.

## What you get

- A **Vault** page in the sidebar, with your folders and notes down its left side.
- An editor with live preview: links, checkboxes, and highlights render
  inline, and `[[` suggests notes as you type.
- A reading view with embeds, callouts, and properties.
- **Outline** and **Backlinks** tabs in the right panel.
- Search across every note.
- Vim-style keys for the notes, file tree, search, outline, and backlinks:
  `j`/`k` to move, `/` to search, `h` or `-` for the file tree, `?` for the full list.
- A **daily note**: ⌘⇧L or "Save to today's daily note" on any chat message
  logs to today's inbox, and every bb thread that finishes a turn is recorded
  for the day.
- A **calendar** of your week's meetings from macOS Calendar. One key starts a
  note for a meeting, filed where your rules say: interviews in one folder,
  one-on-ones in another, the rest under Meetings. Agents read the same
  calendar with `bb obsidian calendar`.
- **Start day** and **Wrap up**, which run your `daily-note` skill in a
  thread inside the vault; the morning pass runs unattended and ends with
  one question.
- A **Vault home** with today's inbox, carried-forward items, active tickets,
  and recently edited notes.
- `@` mentions for any note, or today's daily note, as thread context.

## How it works

The plugin reads and writes the Markdown files in your vault folder directly,
so Obsidian, sync tools, and agents see the same files. Edits save
automatically. Changes made elsewhere show up immediately. If the same note
changes in two places, the plugin asks which version to keep before it
overwrites anything. Renaming a note updates the links that point to it.
Deleted notes go to the vault's `.trash` folder.

Nothing leaves your machine.
