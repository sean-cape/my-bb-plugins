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

## Background threads

A thread should reach the user's unread list, and send a push, only when it needs something from them. Board workers and similar threads the user never opens are spawned `visibility: "hidden"`, which keeps them out of both. A visible thread that also does passive work (a kanban card's thread handing a commit to the board, an automation run) is marked read with `bb.sdk.threads.markRead` by the plugin that owns it, in its `thread.idle` handler, as soon as a turn that needs nothing ends. The push plugin waits two seconds before sending and skips a thread read since, so don't await anything slow first. When the work later needs the user, mark the thread unread with `markUnread`. Don't filter such threads out of an unread list or change their notification level instead; a list may still leave out work that is running unattended, as the picker's Running section does with automation runs.

## Finishing work

The thread's "when done" setting decides what happens to a finished change: call the `finish_action` tool before ending a turn that changed files, and do what it says. This project's default is Merge to main, so a thread that hasn't picked otherwise lands its work without waiting to be asked. (A thread without the tool, which started before the When done plugin was installed, lands too.)

To land, commit on the thread's branch, then run `node scripts/land.mjs` from the worktree's root, outside the sandbox. It:

1. Cherry-picks the branch's commits that `main` doesn't have yet into the main checkout (`/Users/sean/dev/my-bb-plugins`). Other sessions commit to `main` concurrently, so it cherry-picks rather than fast-forwarding or rebasing `main`; a conflict aborts the cherry-pick and leaves `main` as it was.
2. Installs dependencies in each touched plugin whose `package.json` or lockfile changed, then runs the typecheck and tests of every touched plugin and of every plugin built on a touched shared library (`plugins/*/lib`).
3. Builds and installs or reloads those plugins through `scripts/install.mjs`, which also checks each reports `running` and links the Claude config.

When a check fails, the commits are already on `main` and nothing was built: commit a fix on the branch and run it again, and it lands only the fix. `--dry-run` lists what it would land and install. It never pushes; don't push `main` unless asked. A new plugin has to be listed in `.bb/plugins.json` in the same commits, or it isn't installed.

`node scripts/install.mjs --no-pull <name>...` in the main checkout builds and loads named plugins without landing anything, and skips the typecheck and tests.

New worktrees get their `node_modules` from `.bb-env-setup.sh`, which bb runs on creation: each plugin's entries link to the main checkout's, so don't run `pnpm install` in a worktree. In an older worktree, run `bash .bb-env-setup.sh` from its root.

A change to the skills or subagents under `claude/` is live once it is on `main`: `~/.claude` links to the main checkout's copies. A new skill or subagent needs `node scripts/link-claude-config.mjs` run there (outside the sandbox, which blocks `~/.claude/skills` and `~/.claude/agents`).

Install from the main checkout, never a worktree path: a worktree install breaks once the worktree is cleaned up.

Commits are GPG-signed and the sandbox blocks `~/.gnupg`, so `git commit` and `cherry-pick` run outside it. So do the install, build, and reload in the main checkout, which the sandbox can't write to.

## Usage data

Before dropping a feature, changing a key, or deciding what a surface should do first, read how it is used:
`bb activity plugins --since 30d`, then `bb activity top --since 30d --plugin <name>` (`--kind command` for keys,
`--kind click` for controls with their mouse-vs-keyboard split). The `activity` plugin records this from every
plugin without instrumentation, so a new surface's buttons and keys count as soon as it ships.
