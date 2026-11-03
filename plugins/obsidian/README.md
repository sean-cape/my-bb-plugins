# bb-plugin-obsidian

Browse and edit an Obsidian vault inside bb. Adds a **Vault** page to the
sidebar with a file tree down its left side, an editor with Obsidian-style live
preview, a reading view, and Outline / Backlinks tabs in the right panel.

## Features

- File tree in a sidebar on the Vault page's left (`t` or its button hides
  it). Folders, drag-and-drop moves, rename (F2 or the inline title),
  new note/folder, delete to the vault's `.trash/`.
- Editor (CodeMirror 6): markup hides off the active line, `[[` autocompletes
  note names, clicking a rendered link (or ⌘-click) follows it, checkboxes
  toggle in place, frontmatter shows as a block.
- Reading view: wikilinks, `![[embeds]]` (notes, headings, blocks, images),
  callouts (including foldable), properties, highlights, tags, tables,
  toggleable tasks.
- Links follow Obsidian's resolution rules (shortest unique path, same folder
  first). An unresolved link creates the note when you click it.
- Renaming or moving a note rewrites the links that point to it. Turn this off
  under *Update links when renaming or moving notes*.
- Full-text search (⌘⇧F or `/`); ⌘E or `m` toggles editing and reading view.
- Autosave. If the file changed on disk while you were editing, a banner
  offers to keep your version or load the disk version.
  Changes made outside bb (Obsidian, sync, agents) appear live.

## Keyboard

Vim-style keys work on the Vault page, its file sidebar, and its Outline and Backlinks tabs
whenever focus is outside a text box; `?` lists them all. The keymap and help
text live in `ui/vault-nav.ts`, the routing between surfaces in
`ui/vault-keys.ts`.

- Note: `j`/`k`, Ctrl-D/U/F/B, `gg`/`G` scroll; `i` edits (from reading view
  too), `m` switches views, `r` renames, `a` makes a new note, `y`/`Y` copy the
  path or a wikilink, `O` opens in Obsidian, `dd` deletes. Escape leaves the
  editor (twice with vim-mode, which handles editing keys inside it). ⌘↵ in the
  editor follows the link under the cursor.
- File sidebar: `h` from a note or the home moves into it, `t` shows or hides
  it. `j`/`k`, `h`/`l`, `gg`/`G` walk the tree, and `k` from its top row climbs
  to the search box (`l`, `i` or Enter types in it, Escape stops), then the
  buttons, which `h`/`l` step across (the home's buttons and log box work the
  same way); `l` shows a file, `o`/Enter
  opens it and moves to it; `a`/`A` new note/folder, `r` rename, `x` then `p`
  moves, `dd` deletes, `zM` collapses all, `i` types in the search box.
- Anywhere: `/` searches the vault (Enter opens the first match), `n`/`N` open
  the next/previous match, `-` jumps to the open note in the file sidebar, `gO`/`gb` to
  Outline/Backlinks, `gh`/`gt` go home/to today, `gc` to the calendar. Escape in the sidebar or a tab
  returns to the note.
- Calendar: `j`/`k` move through the day's meetings, `h`/`l` step days (so the
  file sidebar is `-` or `t` here), `H`/`L` weeks, `T` or `gc` back to today;
  `o`/Enter/`a` open or start the meeting's note, `gx` joins the call, `y`/`Y`
  copy the call link / a wikilink to the note, `R` re-reads the calendar, `gr`
  opens the rules.

## Daily notes

- **Capture**: ⌘⇧L anywhere in bb, the "Log to today" box on the Vault home, "Save to today's daily note" on any chat message, or `bb obsidian log "…"` from agents. Entries are appended with a timestamp to the daily note's Inbox section. The note is created from the template if needed, and the append merges with edits you have open.
- **Activity**: every bb thread that finishes a turn is recorded per day (title, project, last reply): `bb obsidian activity`. Turn it off with *Record bb thread activity*.
- **Routines**: **Start day** / **Wrap up** (Vault home, today's note, command palette, `bb obsidian start|wrap`) start a Claude thread in a bb project rooted at the vault, told to load your `daily-note` skill with the Skill tool in `start` or `wrap` mode (a bare `/daily-note` reached the agent as text and it wrote the note by hand). That project is created on first use. The morning pass is meant to run unattended from a bb automation: it writes yesterday's summary and today's note with a proposed plan, and ends with one question; the planning conversation happens when you open the thread.
- **Calendar**: `bb obsidian calendar [--date D] [--json]` lists a day's meetings from macOS Calendar, so add your Google account under System Settings → Internet Accounts. The plugin builds a small helper app, *bb Calendar Reader*, in its host data folder the first time; macOS asks once for calendar access for it. *Calendars for meetings* limits which calendars are read.
- **Calendar view**: `gc` (or the Calendar button on the Vault home) shows a week strip over one day's meetings. `j`/`k` move through them, `h`/`l` step days, `H`/`L` weeks, `T` returns to today. Enter on a meeting opens its note, creating it first from its template when there is none, and links it from that day's daily note's Meetings section. `gx` joins the video call, `R` reads the calendar again.
- **Meeting note rules**: where a meeting's note lands is decided by a YAML list in a vault note (*Meeting note rules*, default `Templates/Meeting Note Rules.md`; `gr` opens it and writes a worked example the first time). Each rule can match the title, organizer, calendar, location or description with case-insensitive regular expressions, an attendee count (`3+`, `2-5`) and all-day; the first match wins. A rule names the `folder`, the `file` name pattern and its own `template` (the starter gives interviews `Templates/Template - Interview Note.md`, written alongside it; a template that doesn't exist is reported under the list and the built-in one used meanwhile); placeholders such as `{{title}}`, `{{date}}`, `{{time}}`, `{{url}}`, named regex groups and `extract`ed fragments of the title, description, location or organizer fill both. Meetings no rule matches use the *Meeting notes folder* and *Meeting note template* settings. Saving the rules note re-plans the calendar. Two meetings with one title on a day share a note unless the `file` pattern includes `{{time}}`.
- **Vault home**: today's inbox, carried-forward items, active `Tickets/` notes, and recently edited notes.
- **`@` mentions**: attach any vault note, or "Today's daily note", as context in any thread.
- The bundled `obsidian-vault` skill teaches agents the CLI and the vault conventions.

## Develop

```
npm install
npm test            # parsing, resolution, rewrite, search, and daily-note tests
npm run typecheck
bb plugin dev       # rebuild + reload on save
```

The vault path is the `vaultPath` setting (`bb plugin config obsidian set
vaultPath /path/to/vault`), or set it on the Vault page's first screen.
