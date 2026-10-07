---
name: kanban
description: Read and move cards on the Kanban plugin board with the `bb kanban` CLI. Use when a thread is a kanban card, when the user asks about the board, PR tickets, or wants a card added, moved, or linked to a thread.
---

# Kanban board

Every card on the board is a ticket, usually backed by a BB thread. Cards are
created automatically by **sources** (GitHub searches or Jira JQL queries; by
default the user's open PRs tagged `#my-prs` and review requests tagged
`#pr-reviews`) and ad hoc
from the board page or this CLI. Cards carry free-form **tags**. The board
page, its Todo list view, and `bb kanban` read and write the same data.

## Commands

| Command | Effect |
| --- | --- |
| `bb kanban columns` | List column ids and names. Agents use the id. |
| `bb kanban list [--column <id>] [--tag <tag>]` | List cards grouped by column, with ids; `--tag` filters (repeatable). |
| `bb kanban show [--ticket <id>]` | Show one card. Inside a thread, defaults to that thread's card. |
| `bb kanban move <column-id> [--ticket <id>]` | Move a card. Inside a thread, defaults to that thread's card. |
| `bb kanban add "<title>" [--tag <tag>] [--description <md>] [--column <id>] [--project <id>] [--start-thread]` | Add a card. Inside a thread it is linked to that thread unless `--no-link`, `--project`, or `--start-thread` is passed. |
| `bb kanban review [--ticket <id>] [--project <id>]` | Start a code-review thread for the card's PR: a fresh worktree checks the PR out detached and runs the `code-review` skill. Inside a thread, defaults to that thread's card. |
| `bb kanban review-record --commit <sha> [--base <branch>] [--head <branch>]` | Run from a review thread after checking the PR out: records which commit the review covers. |
| `bb kanban review-show [--ticket <id>]` | Print the latest persisted review (findings + reviewed commit). |
| `bb kanban apply-review [--ticket <id>] [--yes]` | Start a thread that runs the `apply-review` skill on the persisted findings, commits, and pushes to the PR branch. `--yes` skips the triage confirmation. |
| `bb kanban review-applied --commit <sha> [--pushed]` | Run from an apply thread after committing: records the commit, `--pushed` when it was pushed. |
| `bb kanban comments [--ticket <id>]` | List the PR's synced comments with their selection state. |
| `bb kanban apply-comments [--ticket <id>] [--yes] [--no-push]` | Start a thread that runs the `apply-pr-comments` skill on the selected comments, commits, and (unless `--no-push`) pushes. |
| `bb kanban comments-applied --commit <sha> [--pushed]` | Run from an apply-comments thread after committing: marks the comments addressed. |
| `bb kanban add "<title>" --parent <ticket-id> [--description <md>]` | Add a subtask under a card (not linked to the current thread). Use this when asked to break work down. |
| `bb kanban subtasks [--ticket <id>]` | List a card's subtasks with their columns and threads. |
| `bb kanban set-parent <ticket-id> <parent-id\|none>` | Nest a card under another, or make it top-level. |
| `bb kanban start-subtasks [--ticket <id>] [--sequential]` | Start agents on the open subtasks (one thread each, or one in order). |
| `bb kanban tag <tags...> [--ticket <id>]` / `bb kanban untag <tags...> [--ticket <id>]` | Add or remove tags. Tags are lowercase letters, digits, `.`, `-`, `_`. |
| `bb kanban sources` | List the configured sources and the tags they apply. Edit them on the board page. |
| `bb kanban link <ticket-id> [--thread <id>]` | Link an existing card to a thread. |
| `bb kanban remove <ticket-id>` | Delete a card. The thread is kept. |
| `bb kanban sync` | Pull open GitHub PRs into the board now. |

Add `--json` to any command when the output drives code.

## Procedure for a thread that is a card

1. The thread instructions name the ticket id and current column. When you
   start real work, run `bb kanban move in-progress`.
2. When the work is finished and verified, run `bb kanban move done`. If the
   work is waiting on someone else (a PR review, CI), use `bb kanban move review`.
3. Run `bb kanban columns` first if the default column ids were changed.
4. Report the move in your summary.

## Planning threads

A thread started from a brain dump turns the user's dictation into proposed
tickets. It reads the project first, then ends each proposing reply with a
```` ```json kanban-proposal ```` block (tickets with stable ids, subtasks,
dependencies, estimates; open questions with options). It never creates cards
or starts work; the user reviews the proposal on the board.

## Subtasks

A thread asked to break a card down reads the code first, then creates 3–8
concrete subtasks with `bb kanban add "<title>" --parent <id> --description
"<what done looks like>"`, ordered by dependency, without starting the work.
A thread working through subtasks moves each with `bb kanban move <column>
--ticket <subtask-id>` as it goes and never marks one done that it did not
finish. A thread that is itself a subtask keeps its change scoped to that
subtask.

## Review threads

A thread whose instructions say it is a code review for a card runs the
`code-review` skill in its own worktree against `origin/<base>...HEAD`, or
against `<last-reviewed-sha>..HEAD` for a re-review. Before reviewing, run
`bb kanban review-record --commit "$(git rev-parse HEAD)"`. The final message
is persisted on the card verbatim, so make it the `code-review` skill's
compiled report unchanged, including its `Reviewed commit:` line and the
trailing ```` ```json review-findings ```` block the board renders from. Never move the card or post to GitHub.

## Diff comments

The user can leave comments on a card's diff in the board's changes view and
submit them. Those arrive in an apply-pr-comments thread with ids `local:<id>`
and the note "left on the Kanban diff view"; treat them exactly like reviewer
comments. If the card is a review-tagged PR they may also have been posted to
GitHub as a review; never post anything further yourself.

## Apply threads

A thread whose instructions say it addresses PR comments runs the
`apply-pr-comments` skill on the comments pasted into its prompt, commits,
pushes only if the prompt says to, then runs
`bb kanban comments-applied --commit "$(git rev-parse HEAD)"` (add `--pushed`
after a push). Never post replies on GitHub.

## Apply-review threads

A thread whose instructions say it applies a review runs the `apply-review`
skill on the findings selected on the board (pasted into the prompt; the
unselected ones were deliberately left out, so do not re-add them), commits, pushes to
the PR head branch with `git push origin HEAD:refs/heads/<head>`, then runs
`bb kanban review-applied --commit "$(git rev-parse HEAD)"`. Never force-push.

## Rules

- Move cards only through `bb kanban`. Do not edit the plugin database.
- Never post comments or reviews on GitHub for a PR card unless the user
  explicitly asks; summarize findings in the thread instead.
- A non-zero exit with "No ticket" means the id is stale: run `bb kanban list`.
