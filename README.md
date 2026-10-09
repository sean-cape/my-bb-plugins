# bb plugins

Personal [bb](https://getbb.app) plugins, one directory each under `plugins/`.

| Plugin | What it is |
| --- | --- |
| `kanban` | Kanban board where every card is a thread, with GitHub/Jira sources, PR reviews, diffs, and comments |
| `obsidian` | Browse, edit, and log to an Obsidian vault from bb |
| `grouped-thread-list` | Project switcher: a keyboard-first project and thread picker on double Shift that replaces the sidebar's thread list |
| `vim-mode` | Vim keybindings for bb's prompt box and other text fields |
| `browser-automation-pinned` | bb 0.45.0's built-in browser-automation plugin, frozen under its own id |
| `grpc-client` | gRPC client (method browser, generated request forms, `bb grpc` CLI) on top of grpcurl, with option-driven auth profiles |
| `diff-view` | A thread's changes in its side panel (structural or text diff, viewed marks, symbol peeks, comments sent to the thread), plus the `bb-diff-view` library kanban embeds |
| `composer-status-bar` | Tighter composer footer with model, effort, context-token, and usage-limit segments |
| `thread-header-project` | The thread's project name in front of its title in the thread header |
| `slim-sidebar` | bb's sidebar as a thin icon rail under a full-width, seamless top bar |
| `history-keys` | Ctrl+O / Ctrl+I go back and forward |
| `minimal-top-bar` | Hides top-bar buttons that have keyboard equivalents and the Commit button; centers the thread title, which opens the thread menu on click |
| `double-shift-palette` | Double Shift opens the Project switcher (or bb's command palette) |
| `settings-search` | A search bar in the settings sidebar that finds any setting on any settings page, plugin pages included, plus vim keys to move around settings |
| `motion` | Eased, subtle micro-interactions across bb's own UI, plus `bb-motion`, the motion system (tokens, keyframes, React helpers) the other plugins share |

## Install

From a local checkout (rebuild after changes with `bb plugin build plugins/<name>`):

```sh
bb plugin build plugins/<name>
bb plugin install path:$PWD --plugin <name>
```

From GitHub:

```sh
bb plugin install git:github.com/sean-cape/my-bb-plugins@main --plugin <name>
```

## browser-automation-pinned

A frozen copy of bb 0.45.0's built-in browser-automation plugin. It ships only a prebuilt `dist/`, so that directory is committed.
