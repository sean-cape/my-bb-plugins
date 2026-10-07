bb's sidebar thread list, with every project gathered under one collapsible **Projects** group.

## What you get

- A **Projects** group that holds every project when organized by project. Collapse it to keep projects out of the way; while collapsed, its header still shows when a project thread is working or needs attention.
- Project rows drawn as rows rather than section headings, each with a colored monogram, a thread count while collapsed, and click-to-collapse.
- Collapse all / Expand all for project rows from the Projects header.
- Nested sticky headers: the Projects label, the current project, and its parent threads stay pinned as you scroll.
- Everything bb's built-in list does: **Pinned** and **Threads** sections, custom sections, organize by project, machine, or chronologically, nested child threads, worktree grouping, drag to reorder, pin, nest, move, inline rename, and keyboard jump shortcuts.

## How it works

This is a fork of bb's bundled `thread-list` plugin at desktop-v0.45.0. On first load it copies that plugin's layout preferences, so switching lists keeps your order and collapsed groups. Afterwards it stores its own preferences, synced to every open window; `bb grouped-thread-list prefs` reads and changes them.

Pick it under Settings → Appearance → Sidebar, or disable the bundled Thread list plugin.
