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
  so) the item leaves its search. A GitHub source can code review each new
  PR it brings in at a depth you pick, and re-review it when your review is
  requested again; it can likewise write a narrative review of each one.
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
- **Review pipeline**: run your `code-review` skill on a PR card or on any
  card's committed work at a depth (Quick, Standard or Deep, which sets how
  hard its agents reason), pick the findings worth fixing and apply them with
  `apply-review` (a local card's own thread applies them). Every finding is
  verified first: doubtful ones fold under "N filtered", and ones already in
  the code before the change are listed apart, each a click from a Backlog
  card of its own. Findings name their bug class with every instance, and each
  review lists what its checks don't cover. The review holds the change to the
  card's intent (scope findings name the extra hunks) and triages each finding
  apply, defer or drop; the apply round gets the ones triaged apply unless you
  pick otherwise, and deferred ones are a click from a card. Synced PR comments
  (and your local ones) go to an `apply-pr-comments` thread. Findings and PR
  comment threads render inline in the diff. A review interrupted mid-turn (the
  machine slept, bb was quit) resumes where it stopped instead of failing.
- **Monitored cards**: flag a card and the board runs the loop for it. Its
  thread commits and reports ready with evidence; a hidden thread re-runs the
  project's check command at that commit in a fresh worktree; failing checks go
  back to the card's thread with the output, and a second failure in a row
  stops at Needs you. The card moves through Building, Checking and Needs you
  on its own and shows the loop's phase.
- An agent-written **narrative review** of the change: reading order, risk
  and watch-outs, plus a step-by-step walk that covers every changed line,
  with mermaid diagrams. When the code moves, the narrative is updated with a
  chapter that explains the delta and why it was made. Also on-demand
  **explanations** of single hunks.
- PR repositories with no matching project are cloned and registered as
  projects automatically.
- Each card shows its thread's live status; cards in Backlog or To Do move to
  Building (In Progress on boards made before the loop) when their thread starts working, and agents move them on with
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
Progress when it starts work and to Done when the work is verified; a
monitored card's thread is instead told to commit, run the checks, report
with `bb kanban ready`, and never move the card. Review, apply, checks,
planning and subtask threads get their own instructions.
