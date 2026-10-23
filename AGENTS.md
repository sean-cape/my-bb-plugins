# Agent notes

## Public repo

This repo is public on GitHub, and a pushed commit can't be taken back. Never commit real personal or work data: not in code, tests, fixtures, docs, screenshots, or commit messages. That covers people's names, emails, and GitHub handles; calendar events, meeting titles, and call links or dial-in numbers; interview or hiring details; company, customer, and internal project names; work repos, Jira keys, hostnames, and IPs; and vault note contents.

When a real calendar event, PR, ticket, or note prompts a test, rewrite it with placeholders before committing: `acme-co/widgets`, `ACME-1`, `@acme.example` addresses, `meet.google.com/abc-defg-hij`, `555-01xx` phone numbers, invented names such as Jordan Rivera or Alex and Sam, and generic titles. Screenshots for docs use placeholder boards, threads, and titles. Before pushing, search the diff for anything copied from a real source.

## Keyboard first

Build every plugin to be driven from the keyboard, with vim-style keys wherever they fit:

- Lists, boards, and trees move with `j`/`k` (and `h`/`l` across columns or levels), jump with `gg`/`G`, and scroll with Ctrl-D/Ctrl-U.
- `/` searches, `n`/`N` step through matches, `i` focuses the main text input, and `?` lists the plugin's keys.
- Escape leaves a text box and returns to the keys. Text boxes whose Escape or arrows must reach the plugin (a list's search box) opt out of vim-mode with `data-vim-ignore`.
- Ignore keys when focus is in a text box or a Cmd/Alt modifier is held, and don't take keys bb or the vim-mode plugin already use.
- Every mouse action needs a keyboard path.

Build key handling on `bb-vim-keys` (`plugins/vim-mode/lib`; start with its [README](plugins/vim-mode/lib/README.md)): one keymap in vim notation, `useKeyScope`/`bindKeyScope` for a surface with a root, `bindKeys` or `useKeyHandler` for anything else (content scripts over bb's DOM, nested lists), and its row and index cursors, pickers, menu keys and search pieces, rather than another copy of the text-box checks and `gg` timers. Each plugin's tests assert `keymapConflicts` and `unboundHelpKeys` on its keymaps. If the library lacks something a plugin needs, add it to the library rather than working around it in the plugin.

## Finishing work

When a plugin change is done, land it and install it locally without waiting to be asked:

1. Commit on the thread's branch, then apply it to `main` in the main checkout (`/Users/sean/dev/my-bb-plugins`) with `git -C /Users/sean/dev/my-bb-plugins cherry-pick <sha>...`. Other sessions commit to `main` concurrently, so cherry-pick rather than fast-forward or rebase.
2. In the main checkout's plugin directory, run `pnpm install --frozen-lockfile` if its dependencies changed, then the typecheck and tests, then `bb plugin build .`. A change to a shared library (`plugins/*/lib`) reaches every plugin that links it, so also run `node scripts/check-lib-consumers.mjs <plugin>/lib`, then build and reload each consumer.
3. Load it with `bb plugin reload <name>`. A new plugin is first listed in `.bb/plugins.json`, then installed with `bb plugin install path:/Users/sean/dev/my-bb-plugins --plugin <name> --yes`.
4. Check that `bb plugin reload` reports it `running`. Don't push `main` unless asked.

New worktrees get their `node_modules` from `.bb-env-setup.sh`, which bb runs on creation: each plugin's entries link to the main checkout's, so don't run `pnpm install` in a worktree. In an older worktree, run `bash .bb-env-setup.sh` from its root.

A change to the skills or subagents under `claude/` is live once it is on `main`: `~/.claude` links to the main checkout's copies. A new skill or subagent needs `node scripts/link-claude-config.mjs` run there (outside the sandbox, which blocks `~/.claude/skills` and `~/.claude/agents`).

Install from the main checkout, never a worktree path: a worktree install breaks once the worktree is cleaned up.

Commits are GPG-signed and the sandbox blocks `~/.gnupg`, so `git commit` and `cherry-pick` run outside it. So do the install, build, and reload in the main checkout, which the sandbox can't write to.

## Usage data

Before dropping a feature, changing a key, or deciding what a surface should do first, read how it is used:
`bb activity plugins --since 30d`, then `bb activity top --since 30d --plugin <name>` (`--kind command` for keys,
`--kind click` for controls with their mouse-vs-keyboard split). The `activity` plugin records this from every
plugin without instrumentation, so a new surface's buttons and keys count as soon as it ships.
