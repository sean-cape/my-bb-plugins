---
name: finish-action
description: How the When done plugin's per-thread setting tells the agent what to do with a finished change (merge it to main, commit it to the branch, or leave it uncommitted), the `finish_action` tool, and the `bb finish-action` commands. Use when the user asks about the Merge/Commit/Leave chip by the send button, the When done menu entry, project defaults, or why an agent did or didn't commit or land its work.
---

Each thread the user started in a repository project has a "when done" action:

- **Merge to main** (`land`): commit on the thread's branch, then land it on the merge base. When the checkout has `scripts/land.mjs`, the agent runs that (outside the sandbox); otherwise it follows the repository's own finishing instructions, or merges into the base in the main checkout. It never pushes.
- **Commit to branch** (`commit`): commit on the thread's branch only.
- **Leave uncommitted** (`none`): leave the change in the working tree.

A thread without its own pick follows its project's default, and without one, leaves changes uncommitted. Threads a plugin started (kanban cards and their reviews, automations, side chats) and Personal threads have no setting: their owner's instructions decide.

## How the agent reads it

The `finish_action` tool returns the current action and the steps for it. Its instructions tell the agent to call it before ending any turn that changed files, and that it replaces the repository's own rules about committing and landing. The value travels through the tool rather than the session instructions because a running session keeps the instructions it started with, while the user can flip the setting mid-thread; the next finished change uses the new value. A message from the user that asks for something else still wins.

The tool is selected when a session starts, so threads already running when the plugin was installed get it on their next session (a bb or daemon restart). Until then those agents follow the repository's instructions.

The setting lives in the thread's `finish-action` plugin metadata (`{ "action": "land" }`), which anything, the thread's own agent included, can write. It only steers the agent; it grants nothing.

## Changing it

- The chip before the send button shows the current action (Merge, Commit, Leave); click it or press `⌥D` to step to the next option, `⌥⇧D` for the previous one.
- The thread's actions menu (header or sidebar row) has **When done** with the three options and **Project default**, which clears the thread's pick.
- The command palette (`⌘⇧P`) has "When done: Merge to main / Commit to branch / Leave uncommitted" and "When done: make this thread's choice the project default".

From the CLI (run inside a thread, or pass `--thread` / `--project`):

```sh
bb finish-action show [--thread <id>] [--json]     # the action and whether it's the thread's pick or a default
bb finish-action set land|commit|none|default [--thread <id>]
bb finish-action default [land|commit|none|clear] [--project <id>]   # omit the action to print it
```
