# bb plugins

Personal [bb](https://getbb.app) plugins, one directory each under `plugins/`.

| Plugin | What it is |
| --- | --- |
| `kanban` | Kanban board where every card is a thread, with GitHub/Jira sources, PR reviews, diffs, and comments |
| `obsidian` | Browse, edit, and log to an Obsidian vault from bb |
| `grouped-thread-list` | Project switcher: a keyboard-first project and thread picker on double Shift that replaces the sidebar's thread list with counts of threads that need you, are running, or are pinned |
| `vim-mode` | Vim keybindings for bb's prompt box and other text fields |
| `browser-automation-pinned` | bb 0.45.0's built-in browser-automation plugin, frozen under its own id |
| `grpc-client` | gRPC client (method browser, generated request forms, `bb grpc` CLI) on top of grpcurl, with option-driven auth profiles |
| `diff-view` | A thread's changes in its side panel (structural or text diff, viewed marks, symbol peeks, comments sent to the thread), plus the `bb-diff-view` library kanban embeds |
| `composer-status-bar` | Tighter composer footer with model, effort, context-token, and usage-limit segments |
| `thread-header-project` | The thread's project name in front of its title in the thread header |
| `history-keys` | Ctrl+O / Ctrl+I go back and forward, Cmd+1–9 open the sidebar rail's items, Cmd+0 returns to the last thread |
| `minimal-top-bar` | Hides top-bar buttons that have keyboard equivalents and the Commit button; centers the thread title, which opens the thread menu on click |
| `double-shift-palette` | Double Shift opens the Project switcher (or bb's command palette) |
| `settings-search` | Vim keys for settings: j/k walk the sidebar's pages and the open page's settings, and bb's own settings search gets Ctrl-n/p and hands the cursor to the setting it opens |
| `nerd-font` | Decides whether the plugins here draw Nerd Font icons or their plain fallbacks (Automatic, Always, Never), plus `bb-nerd-font`, the glyph library they share |
| `motion` | Eased, subtle micro-interactions across bb's own UI, plus `bb-motion`, the motion system (tokens, keyframes, React helpers) the other plugins share |
| `prompt-keys` | Vim keys for the questions, tool approvals, and plan reviews bb asks you to answer |
| `local-voice` | Voice input transcribed by a local speech model: whisper.cpp kept warm by the plugin, or any OpenAI-compatible transcription server |
| `no-selection-menu` | Hides the Add to chat / Reply in side chat toolbar bb pops up over highlighted text |
| `activity` | Logs every click, vim key command, and page across bb and the plugins, attributed to the plugin it happened in, with an Activity page and `bb activity` CLI that rank them so unused features can be pruned |

## Screenshots

`kanban`: every card is a thread, with its PR, checks, review findings, and unaddressed comments.

![Kanban board](docs/screenshots/kanban-board.jpg)

`diff-view`: a thread's changes as a split structural diff, here opened full-page from kanban.

![Diff view](docs/screenshots/diff-view.jpg)

## Usage data

The `activity` plugin logs how bb and these plugins get used: every click, vim key command, other key, and page,
per plugin, with mouse-vs-keyboard counts for clicks. Check it before pruning a feature or giving something a key:

```sh
bb activity plugins --since 30d                   # which plugins see use at all
bb activity top --since 30d --kind command --plugin <name>   # which of a plugin's keys get used
bb activity top --since 30d --kind click          # which controls are clicked, and how
bb activity top --since all --json                # the same for a script
```

The Activity page in the sidebar shows the same ranking. Details, limits, and the event shape are in
[plugins/activity/README.md](plugins/activity/README.md).

## Install

Everything at once, from a clone (needs `bb`, `node`, `pnpm` 10.6 or newer and `npm` on PATH). It pulls, installs
each plugin's dependencies, builds every plugin, installs it into bb or reloads it when bb already runs it from this
checkout, links the Claude Code skills and subagents into `~/.claude`, and checks every plugin reports `running`. Run
it again to upgrade:

```sh
node scripts/install.mjs                  # pull, then install or upgrade every plugin
node scripts/install.mjs kanban diff-view # only these plugins
node scripts/install.mjs --no-pull        # use the checkout as it is
node scripts/install.mjs --registry https://registry.npmjs.org/   # if ~/.npmrc points at a registry you can't reach
```

One plugin from a local checkout (rebuild after changes with `bb plugin build plugins/<name>`):

```sh
bb plugin build plugins/<name>
bb plugin install path:$PWD --plugin <name>
```

From GitHub:

```sh
bb plugin install git:github.com/sean-cape/my-bb-plugins@main --plugin <name>
```

## Claude Code skills

`claude/` holds the Claude Code skills and subagents the kanban board's review loop runs: `code-review` with the
`change-reviewer-*` subagents it spawns and the `triage-criteria.md` it reads, `apply-review`, `apply-pr-comments`,
and the `grill-me` → `to-spec` → `to-tickets` → `implement` flow that writes the specs the reviews hold changes to.
`scripts/install.mjs` links them; to link them alone, run this from the main checkout (existing copies are moved to
`~/.claude/backups`):

```sh
node scripts/link-claude-config.mjs           # link
node scripts/link-claude-config.mjs --check   # list what isn't linked
```

## browser-automation-pinned

A frozen copy of bb 0.45.0's built-in browser-automation plugin. It ships only a prebuilt `dist/`, so that directory is committed.
