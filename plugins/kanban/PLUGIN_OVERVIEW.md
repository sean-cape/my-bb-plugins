A kanban board where every card is a BB thread.

## What you get

- A **Kanban** page in the left sidebar with drag-and-drop columns and a Todo
  list view.
- Vim-style **keyboard navigation** on the board: `hjkl` to move between
  cards, `HJKL` to move a card, `j`/`k` through an open card's fields and
  buttons, `T` to switch to the Todo list (which has its own vim keys), `k`
  past the top card to reach the column's + and the title bar, `?` for the
  full list.
- Cards from **sources** you configure: GitHub searches (by default your open
  PRs and PRs waiting on your review) and Jira JQL queries. Cards move to Done
  when the PR merges or closes, the Jira issue is done, or (if the source says
  so) the item leaves its search.
- Ad hoc cards from the page or from `bb kanban add`, with an optional thread
  started in the project you pick, or in a new one made from a folder you
  choose.
- **Brain dump**: type or dictate everything that needs doing; a planning
  thread proposes cards (with subtasks, dependencies and open questions) that
  you edit and accept on the board.
- **Due dates** on any card, shown on the board and flagged when overdue.
- **Subtasks** on any card, written by you (also while creating the card) or
  by the card's agent, with agents started on them one thread each or one
  thread working through them in order.
- A **changes page** per card: structural diff (a line diff where difftastic cannot diff a file), viewed marks, and line
  comments that stay local for an agent or post to the PR as GitHub drafts.
- **PR review pipeline**: run your `code-review` skill on a PR card, pick the
  findings worth fixing and apply them with `apply-review`; synced PR comments
  (and your local ones) go to an `apply-pr-comments` thread. Findings and PR
  comment threads render inline in the diff.
- An agent-written **tour** of the change (reading order, risk, watch-outs)
  and on-demand **explanations** of single hunks.
- PR repositories with no matching project are cloned and registered as
  projects automatically.
- Each card shows its thread's live status; cards in Backlog or To Do move to
  In Progress when their thread starts working, and agents move them on with
  `bb kanban move <column>`.

## How it works

Cards live in this plugin's own storage on the BB server. GitHub is read with
the token you paste into the plugin settings, or with the token from `gh auth
token` on the server machine; Jira uses the site URL, email and API token
settings. PR cards are matched to projects by git remote, and a thread is
started in that project so the agent can brief itself on the PR and wait for
instructions. The thread top-bar Changes button and side panel come from the
separate Diff view plugin, whose diff library this plugin embeds.

## For agents

The bundled skill explains the `bb kanban` commands. A thread started from a
card is told its ticket id and column, and asked to move the card to In
Progress when it starts work and to Done when the work is verified. Review,
apply, planning and subtask threads get their own instructions.
