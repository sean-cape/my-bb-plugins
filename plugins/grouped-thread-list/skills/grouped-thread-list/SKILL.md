---
name: grouped-thread-list
description: "Inspect or change the Project switcher plugin: its double-Shift project and thread picker, its keyboard shortcuts, and the active project preference."
---

# Project switcher

The Project switcher plugin (id `grouped-thread-list`) owns bb's sidebar
thread-list slot and leaves it empty. Projects and threads live in a picker
opened by tapping Shift twice (through the Double Shift plugin, which falls
back to bb's quick palette when this plugin is off) or by the "Switch project"
command, which has no default shortcut and can be bound in bb's keyboard
settings.

The picker's left column lists Open folder…, Unassociated (bb's
built-in personal project), Pinned, and Unread (finished threads you haven't opened
since their latest response, plus Claude sessions with a prompt running, across all projects; automation runs are left out), then the current project under a
"Current" label, then the other standard projects under "Projects" by most
recent activity, each showing how long ago it was last active. The picker opens with Unread selected.
"Current" is where you are: the routed thread's project (by root ancestor),
else the project whose screen is open, else `activeProject`. The current
project row and the routed thread row carry a bar in the project's monogram
color (`aria-current`), and the search bar shows `project › thread title`.
Unassociated gets the bar when the routed thread is a personal one.
The right column has a header (entry name, thread count, a Current tag) and
lists the selected entry's threads, children nested under their parents. Root
threads are grouped into Needs you (pending interaction, failed queued send, or
unread finished response anywhere in the subtree), Running, Today, Yesterday,
Past week, and Older (by `latestAttentionAt`, which is also the age shown);
Unread uses the first two groups and Pinned keeps its pin order. While that column is focused, a preview pane opens beside it with the
highlighted thread's title, project, branch, PR status, and latest messages (read-only, and it doesn't mark the
thread read). `l` from the threads column moves into the preview, where
`j`/`k` and Ctrl+E/Ctrl+Y scroll a little, Ctrl+D/Ctrl+U half a page,
Ctrl+F/Ctrl+B a page, `gg`/`G` jump to the top or bottom, and `h` goes back
(Enter, `p`, and `d` still act on the highlighted thread). Keys: `j`/`k` (or arrows, Ctrl+N/Ctrl+P) move, `h`/`l` (or
arrows, Tab) switch columns, `gg`/`G` jump, `/` filters the project list by
name, hiding Open folder…, Unassociated, Pinned, and Unread while a filter is set, and adds a
"Matching" entry listing threads (any project) whose title or branch contains every typed word (Esc in
normal mode clears it), `Enter` opens a thread or moves into a
project's threads, `p` pins or unpins the highlighted thread (the mouse
highlights the row under it), `r` marks it read, `d` (hinted as "delete") archives
it rather than deleting it, so it stays restorable, `u` clicks Undo on bb's
"Thread Archived" toast (it also works outside the picker, but never while
typing in a text box), `n` starts a thread in the selected project, `Esc` or `q`
closes. The footer hints only the keys that act in the focused column. Typing a path after `/` (absolute or `~/`) offers
to add that folder as a project; a folder that is already a project selects it.

The one preference is `activeProject`: a project id, or `null` to follow the
most recently active project, which is then stored. Opening a thread sets it to
that thread's project (by root ancestor); Unassociated threads leave it alone.
`n` from Pinned, Unread, or a Matching entry starts the thread in `activeProject`.

```sh
bb grouped-thread-list prefs list [--json]
bb grouped-thread-list prefs get activeProject [--json]
bb grouped-thread-list prefs set activeProject proj_abc123 [--json]
bb grouped-thread-list prefs reset activeProject [--json]
```

`set` takes JSON; a bare word is read as a string. An invalid value fails with
`invalid_preference_value` and leaves the stored value alone. Every open window
applies a change immediately.
