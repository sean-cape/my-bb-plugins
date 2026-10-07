---
name: grouped-thread-list
description: "Inspect or change the Grouped thread list's sidebar layout preferences: organization mode, sort, section order, the collapsible Projects group, hidden groups, collapsed groups, and thread row actions."
---

# Grouped thread list preferences

The Grouped thread list plugin replaces bb's sidebar thread list with one that
gathers every project, when organized by project, under a single collapsible
Projects group. It owns the sidebar's layout state. Read it with
`bb grouped-thread-list prefs list --json`; keys are `showProviderIcons`, `threadLifecycles`, `organizationMode`,
`environmentGrouping`, `chronologicalSort`, `sortDirection`, `sectionOrder`,
`manualSectionOrder`, `machineSectionOrder`, `hiddenGroups` (including the
built-in `threads` group), `rowActions`,
`projectsGroupCollapsed`, `collapsedSections`, `collapsedProjects`, `collapsedThreads`,
`collapsedEnvironments`, `collapsedThreadSections`, and `collapsedMachines`.

```sh
bb grouped-thread-list prefs list [--json]
bb grouped-thread-list prefs get <key> [--json]
bb grouped-thread-list prefs set <key> <value> [--json]
bb grouped-thread-list prefs reset <key> [--json]
```

`set` takes JSON; a bare word is read as a string, so
`bb grouped-thread-list prefs set organizationMode machine` and
`bb grouped-thread-list prefs set manualSectionOrder '["pinned","sections","threads"]'`
both work. A value the key's schema rejects fails with
`invalid_preference_value` and leaves the stored value alone. Every open
window applies a change immediately. Sections themselves and a thread's
section are bb core state: use `bb thread section` and `bb thread update`.

`projectsGroupCollapsed` (default `false`) hides every project row behind the
Projects header; `bb grouped-thread-list prefs set projectsGroupCollapsed true`
collapses it. While collapsed, the header shows the combined status of the
projects' threads. Opening a thread in a project expands the group again; a
newly unread project thread does not. Project order lives in `sectionOrder` as
`project:<id>` entries, and the group sits where the first project is. Drag the
Projects header to move the group, and drag project rows to reorder them inside
it. The header's Collapse all / Expand all button toggles every project row.

On first load the plugin copies the bundled `thread-list` plugin's non-default
values, then fills anything still unset from `bb settings ui` `sidebar.*`;
after that each is independent. If the bundled plugin is not running, the copy
is retried on the next load.

The header's Filter menu selects Active, Archived, or both; at least one must
remain selected. `bb grouped-thread-list prefs set threadLifecycles '["archived"]'`
shows archived threads, and `'["active","archived"]'` shows both. The default
is `'["active"]'`. Archived results load in pages; use Show more at the end
of the list. The same preference is available through `setPreference` RPC.

`rowActions` picks up to three quick-action buttons a thread row shows on
hover, left to right before its actions menu. Choose from `split`, `copyLink`, `read`,
`pin`, `move` (opens a section menu), `rename`, and `archive`; the default is `'["archive"]'` and `'[]'`
leaves only the menu. For example,
`bb grouped-thread-list prefs set rowActions '["pin","archive"]'`. In the app, a thread
row's actions menu has Customize row actions, which previews the row's three
action slots; each slot picks an action or Hide, and filled slots drag to reorder.

Organize → Rows → Provider icons toggles the icon before each thread title.
`showProviderIcons` defaults to `false`; use
`bb grouped-thread-list prefs set showProviderIcons true` to show them. Unknown
provider ids have no icon.

New threads inherit the sidebar group where creation was invoked. Pinned
creates pinned threads; custom sections supply their section; project, machine,
and general thread groups start unsectioned and unpinned. Environment rows
reuse their environment and the containing group's placement. In Pinned,
they retain the group's common underlying section for unpinning; mixed-section
groups use no underlying section.
