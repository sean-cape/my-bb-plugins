---
name: kanban
description: Read and move cards on the Kanban plugin board, and run its PR review and comment rounds, with the `bb kanban` CLI. Use when a thread is a kanban card or was started from one (a code review, apply, brain-dump planning, or subtask thread), when the user asks about the board, PR or Jira cards, a card's review findings or PR comments, or wants a card added, moved, broken into subtasks, or linked to a thread.
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
| `bb kanban show [<ticket-id> \| --ticket <id>]` | Show one card. Inside a thread, defaults to that thread's card. |
| `bb kanban move <column-id> [--ticket <id>]` | Move a card. Inside a thread, defaults to that thread's card. |
| `bb kanban add "<title>" [--tag <tag>] [--description <md>] [--column <id>] [--project <id>] [--start-thread]` | Add a card. Inside a thread it is linked to that thread unless `--no-link`, `--project`, or `--start-thread` is passed. |
| `bb kanban review [--ticket <id>] [--project <id>] [--full] [--depth quick\|standard\|deep]` | Start a code-review thread for the card's PR, or for a card without one, for the commits its thread made beyond its merge base: a fresh worktree checks the PR head (or the thread's HEAD) out detached and runs the `code-review` skill at the depth (Quick, Standard or Deep: how hard its reviewer and verifier agents reason; Standard is the default). Inside a thread, defaults to that thread's card. |
| `bb kanban review-record --commit <sha> [--base <branch>] [--head <branch>]` | Run from a review thread after checking the commit out: records which commit the review covers. |
| `bb kanban monitor on\|off [--ticket <id>] [--gates plan,findings,auto-accept\|none]` | Turn a card's review loop on or off. A monitored card is checked and routed by the board itself; off stops the loop after its current step. Turn it on for a card you create for a larger task. `--gates` picks the gates; by default only a Jira card's plan waits for approval. |
| `bb kanban plan --plan-file <path>` | Run from a monitored card's own thread while its plan gate holds it: proposes your plan (a Markdown file), then stop and wait for the approved plan. |
| `bb kanban ready --commit <sha> --evidence-file <path> [--screenshot <path>] [--check-command "<cmd>"]` | Run from a monitored card's own thread once its work is committed and verified (see below). |
| `bb kanban landed [--ticket <id>]` | Run from a monitored local card's own thread after the user accepted it and you landed it with the project's finishing steps: the board moves the card to Done. |
| `bb kanban checks-record --exit-code <n> --output-file <path>` | Run from a checks thread: records the check command's exit code and the tail of its output. |
| `bb kanban review-show [<ticket-id> \| --ticket <id>]` | Print the latest persisted review (findings + reviewed commit). |
| `bb kanban narrative-check --report-file draft.json` | Run from a narrative thread: checks a draft kanban-narrative report parses and that its steps (and revision steps) cover every changed line; lists what they miss. |
| `bb kanban narrative-context` | Run from a narrative thread: prints the earlier narrative's steps and the delta a revision chapter must explain. |
| `bb kanban apply-review [--ticket <id>] [--no-push]` | Apply the selected findings with the `apply-review` skill, all of them without confirmation. A PR review starts a thread that commits and (unless `--no-push`) pushes to the PR branch; a local review is sent to the card's own thread, which commits without pushing. |
| `bb kanban review-applied [--review <id>] --commit <sha> [--pushed] [--skipped F2,F5]` | Run from the thread applying the findings after committing: records the commit (`--pushed` when it was pushed) and marks every finding it was handed applied, except the `--skipped` ones it could not apply. |
| `bb kanban comments [--ticket <id>]` | List the PR's synced comments with their selection state. |
| `bb kanban apply-comments [--ticket <id>] [--no-push]` | Start a thread that runs the `apply-pr-comments` skill on the selected comments, applying all of them without confirmation, commits, and (unless `--no-push`) pushes. |
| `bb kanban comments-applied --commit <sha> [--pushed]` | Run from an apply-comments thread after committing: marks the comments addressed. |
| `bb kanban comment-reply <comment-id> "<text>"` | Reply in an inline comment's thread on the board (`local:<id>` or `review-comment:<n>`). Stays on the board; never posted to GitHub. |
| `bb kanban add "<title>" --parent <ticket-id> [--description <md>]` | Add a subtask under a card (not linked to the current thread). Use this when asked to break work down. |
| `bb kanban subtasks [--ticket <id>]` | List a card's subtasks with their columns and threads. |
| `bb kanban set-parent <ticket-id> <parent-id\|none>` | Nest a card under another, or make it top-level. |
| `bb kanban start-subtasks [--ticket <id>] [--sequential]` | Start agents on the open subtasks (one thread each, or one in order). |
| `bb kanban tag <tags...> [--ticket <id>]` / `bb kanban untag <tags...> [--ticket <id>]` | Add or remove tags. Tags are lowercase letters, digits, `.`, `-`, `_`. |
| `bb kanban due <YYYY-MM-DD\|none> [--ticket <id>]` | Set or clear a card's due date (a calendar day). `bb kanban add` takes `--due <YYYY-MM-DD>` too. |
| `bb kanban sources` | List the configured sources and the tags they apply. Edit them on the board page. |
| `bb kanban link <ticket-id> [--thread <id>]` | Link an existing card to a thread. |
| `bb kanban remove <ticket-id>` | Delete a card. The thread is kept. |
| `bb kanban sync` | Pull open GitHub PRs into the board now. |

Add `--json` to any command when the output drives code. A `--<name>-stdin` option reads exactly one line; anything longer goes in a file passed with `--<name>-file`.

## Procedure for a thread that is a card

1. The thread instructions name the ticket id and current column. When you
   start real work, run `bb kanban move in-progress` (the board may already
   have moved a Backlog or To Do card there when the thread became active).
2. When the work is finished and verified, run `bb kanban move done`. If the
   work is waiting on someone else (a PR review, CI), use `bb kanban move review`.
3. Run `bb kanban columns` first if the default column ids were changed.
4. Report the move in your summary.

## Procedure for a monitored card's thread

The thread instructions say when the card is monitored. Then the board moves
the card, never you, and the loop starts from your ready report:

0. If the instructions say the plan gate is on, first propose a plan with
   `bb kanban plan --plan-file <path>` and stop; build only once the board sends the
   approved plan, and build to that version.
1. Commit the work (on a PR card, push it to the PR branch; never force-push).
2. Run the project's check command, named in the instructions. When the
   project sets none, choose the command that builds, lints and tests it.
   Fix what fails.
3. Report it, with JSON evidence of how you verified the work in a file
   outside the repository:

   ```
   cat >"$TMPDIR/evidence.json" <<'EOF'
   {"commands":[{"command":"pnpm test","exitCode":0,"outputTail":"42 passed"}],"screenshots":["/abs/path/after.png"]}
   EOF
   bb kanban ready --commit "$(git rev-parse HEAD)" --evidence-file "$TMPDIR/evidence.json"
   ```

   Add `--check-command "<cmd>"` when the project sets no check command. The
   board re-runs it from the repository root of a fresh worktree, so it has to
   work from there, setup included.
4. Stop. The board re-runs the checks at that commit in a fresh worktree. If
   they fail, their output comes back to this thread: fix it, commit, and
   report ready again.

## Checks threads

A checks thread checks the reported commit out detached, prepares the
worktree, runs the check command once and records the result with
`bb kanban checks-record --exit-code <n> --output-file <path>`. It changes nothing
and never tries to fix a failure.

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
`bb kanban review-record --commit "$(git rev-parse HEAD)"`. A re-review also
re-checks the earlier findings its prompt lists, and its report carries every
one still open forward (`carriedFrom` set to its handle), lists the fixed ones
in `resolved`, and sets `carriesForward`, because it replaces the earlier
reviews on the board. The final message is persisted on the card verbatim, so
make it the compiled report in the `code-review` skill's format, including its
`Reviewed commit:` line and the trailing ```` ```json review-findings ````
block the board renders from. Never move the card or post to GitHub.

## Diff comments

The user can leave comments on a card's diff in the board's changes view. Each
one is either local (kept on the board for an agent) or a GitHub draft (posted
to the PR by the user). Local ones arrive in an apply-pr-comments thread with
ids `local:<id>` and the note "left on the Kanban diff view"; treat them exactly
like reviewer comments. A comment marked "(reply to …)" continues a thread, and
its body quotes the earlier messages, GitHub ones included, so answer the
latest message in that context. Never post anything to GitHub yourself.

## Apply threads

A thread whose instructions say it addresses PR comments runs the
`apply-pr-comments` skill on the comments pasted into its prompt, applying
every one as written with no triage step or confirmation, commits,
pushes only if the prompt says to, then runs
`bb kanban comments-applied --commit "$(git rev-parse HEAD)"` (add `--pushed`
after a push). Then answer each inline comment with
`bb kanban comment-reply <id> "<what changed, or why not>"` so the outcome sits
next to the line on the board. Never post replies on GitHub.

## Apply-review threads

A thread whose instructions say it applies a review runs the `apply-review`
skill on the findings selected on the board (pasted into the prompt; the
unselected ones were deliberately left out, so do not re-add them). The
selection is the triage: apply every selected finding as written, without a
triage step, a confirmation, or dropping or reshaping any, and report the ones
you could not apply. Then commit, push to the PR head branch with
`git push origin HEAD:refs/heads/<head>`, and run
`bb kanban review-applied --commit "$(git rev-parse HEAD)"`, adding
`--skipped <ids>` for any finding you could not apply so the board keeps it
open. Never force-push.

## Rules

- Move cards only through `bb kanban`. Do not edit the plugin database.
- Never post comments or reviews on GitHub for a PR card unless the user
  explicitly asks; summarize findings in the thread instead.
- A non-zero exit with "No ticket" means the id is stale: run `bb kanban list`.
