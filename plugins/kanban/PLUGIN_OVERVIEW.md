A kanban board where every card is a BB thread.

## What you get

- A **Kanban** page in the left sidebar with drag-and-drop columns.
- Cards created automatically from your open GitHub pull requests: the ones
  you authored and the ones waiting on your review. Merged, closed, and
  reviewed PRs move to Done on the next sync.
- Ad hoc cards from the page or from `bb kanban add`, with an optional thread
  started in the project you pick.
- Each card shows its thread's live status; open the thread with one click.
- Agents move their own card with `bb kanban move <column>` as work progresses.

## How it works

Cards live in this plugin's own storage on the BB server. GitHub is read with
the token you paste into the plugin settings, or with the token from `gh auth
token` on the server machine. PR cards are matched to projects by git remote,
and a thread is started in that project so the agent can brief itself on the
PR and wait for instructions.

## For agents

The bundled skill explains the `bb kanban` commands. A thread started from a
card is told its ticket id and column, and asked to move the card to In
Progress when it starts work and to Done when the work is verified.
