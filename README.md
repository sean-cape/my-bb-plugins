# bb plugins

Personal [bb](https://getbb.app) plugins, one directory each under `plugins/`.

| Plugin | What it is |
| --- | --- |
| `kanban` | Kanban board where every card is a thread, with GitHub/Jira sources, PR reviews, diffs, and comments |
| `obsidian` | Browse, edit, and log to an Obsidian vault from bb |
| `grouped-thread-list` | Fork of bb's thread-list plugin (desktop-v0.45.0) with a collapsible Projects group |
| `vim-mode` | Vim keybindings for bb's prompt box and other text fields |
| `browser-automation-pinned` | bb 0.45.0's built-in browser-automation plugin, frozen under its own id |
| `grpc-client` | gRPC client (method browser, generated request forms, `bb grpc` CLI) on top of grpcurl, with option-driven auth profiles |

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

`browser-automation-pinned` has no sources, only the prebuilt `dist/` copied
from the bb 0.45.0 app bundle, so its `dist/` is committed. To move it to a newer
bb, re-copy `builtin-plugins/browser-automation` from the app bundle and rename
the plugin id in `package.json`, `dist/*.meta.json`, and the `data-bb-plugin`
attribute in `dist/app.js`.
