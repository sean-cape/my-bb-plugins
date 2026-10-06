# bb-plugin-kanban

A kanban board for BB where every card is a thread.

- **Kanban** page in the sidebar: columns, drag-and-drop cards, a live thread
  status dot on each card. Clicking a card opens it in the page's right-side
  Card panel (a dialog on compact viewports) to edit, tag, move, review, start
  or open the thread, or delete. GitHub links open in your system browser.
- **Sources**: cards are created automatically from searches you configure
  (Settings → Sources on the board). Pick a source type when adding one:
  - **GitHub search**: a GitHub search query; PRs or issues become cards.
    Two ship by default: your open PRs (`#my-prs`) and open, non-draft PRs
    where your review is requested (`#pr-reviews`, "done when it leaves this
    search"). Merged or closed PRs move to Done.
  - **Jira (JQL)**: a JQL query on your Jira Cloud site. Needs the Jira site
    URL, account email, and API token plugin settings. Cards land in To Do or
    In Progress from the issue's status category, carry key, status, priority
    and assignee, and move to Done when the issue is done in Jira. The card
    thread's first prompt includes the issue description.
  Each source has tags, an optional project for its card threads (GitHub
  sources match the repo's git remote first), and a "done when it leaves this
  search" flag.
- The page's controls live in bb's title bar next to the Kanban name: the
  Board/Todo toggle, the **Settings** cog (Columns, Sources, "Sync sources
  now" with the last-sync status) and New card; on a card's changes page the
  bar holds Back, the card name, the Unified/Split toggle, and Refresh.
- Card details follow one hierarchy: the title with a quiet meta line (kind,
  id, column, PR or issue), a compact action strip (Open thread, Open on
  GitHub/Jira), a property list (Column, Tags, Thread, Author or Jira fields),
  then collapsible groups for Code review, PR comments, and Description or
  Notes. Title and description save when the field loses focus.
- **Brain dump**: New card → Brain dump. Type or dictate (mic button, transcribed
  by bb's voice service) a ramble of everything that needs doing and pick a
  project. A background planning thread reads the project and replies with a
  proposal: tickets (title, description, tags, subtasks, dependencies,
  estimate) plus open questions. The Proposals page (badge beside New card)
  lists dumps; open one to answer questions and ask for a refined plan, edit or
  deselect tickets, choose a column, and create the cards (optionally starting
  a thread per card). Planning threads are archived when a dump is finalized
  or discarded.
- **Subtasks**: any card can hold subtasks (nested as deep as you like). The
  card panel's Subtasks group lists them with done checkboxes, column, and
  thread status; add one inline, or **Break down with AI** to have the card's
  agent split it (it creates subtasks with `bb kanban add --parent`).
  **Start N subtasks** launches one thread per open subtask (nested under the
  parent's thread) or one thread that works through them in order. A Parent
  selector nests or detaches any card; deleting a parent promotes its subtasks.
  Cards show `done/total` progress; subtasks stay off the board unless
  Settings → "Show subtasks on the board" is on, and appear indented under
  their parent in the Todo view.
- **Tags** on every card, editable in the card dialog or with `#tag` in a
  title; `bb kanban tag` / `untag` for agents.
- **Todo view** (toggle at the top of the board, or `/plugins/kanban/board/todo`):
  a flat checklist grouped by column with tag filters, quick-add
  (`Fix thing #infra`), and a checkbox that moves a card to Done.
- **Ad hoc cards** from the page, from `bb kanban add`, or from an agent inside
  a thread (the card is linked to that thread).
- **Review PR** button on every PR card: spawns a review thread in a fresh
  worktree of the matching project, checks the PR head out detached, and runs
  your `code-review` skill (`~/.claude/skills/code-review`) against
  `origin/<base>...HEAD`. Findings land in that thread; nothing is posted to
  GitHub. The card shows the review thread's status and opens it on click.
- **Persisted reviews**: when the review thread finishes, its compiled findings
  and the reviewed commit are stored on the card. "Review since <sha>" reviews
  only the commits pushed after the last review; "Full review" starts over.
  "Show findings" renders every stored review. The `code-review` skill ends its
  report with a ```` ```json review-findings ```` block; the board parses it
  into findings grouped by severity (id, title, file:line, fix, reviewers) and
  shows severity counts on the card. Free-form reviews fall back to markdown.
  Each finding carries two 1–5 scores from the skill: **importance** (how much
  it matters before merge) and **scope** (how well the fix stays inside the
  PR; 1 means a separate piece of work). Findings have a checkbox deciding
  whether they go to the apply round; the suggested selection is every
  critical finding plus anything with importance ≥ 3 and scope ≥ 3. Your
  changes persist per review, and "Reset to suggested" restores the heuristic.
- **Changes view**: "View changes" on a card (or the diff icon on hover)
  opens a full-page diff at `/plugins/kanban/board/diff/<id>`: a file list with
  per-file stats, bb's diff renderer (unified or split), and previous/next
  file navigation. PR cards diff the pull request from GitHub; thread-backed
  cards diff their environment against its merge base.
- **Diff comments**: hover a line in the changes view and press the "+" gutter
  button (or click the line number) to comment on that exact line, on either
  side of the diff; "Comment on file" leaves a file-level note. Comments
  render inline under their line. "Submit N comments" hands them to a thread running
  `apply-pr-comments` (with the same and-push and skip-triage options), and,
  for PR cards carrying the review tag (`#pr-reviews` by default, configurable
  in settings), can also post them to the GitHub PR as one review: inline
  where a line is given, in the review body otherwise.
- **PR comments**: every sync pulls the PR's conversation comments, inline
  review comments (with replies threaded), and review summaries into the card.
  Each comment has a checkbox for the apply round (suggested: everything others
  wrote that is not yet addressed; approvals, drafts, and your own comments are
  left out) and an "addressed" mark. The card shows how many are still open.
- **Apply N comments**: runs the `apply-pr-comments` skill
  (`~/.claude/skills/apply-pr-comments`) in a fresh worktree on the selected
  comments, commits, and marks them addressed when the thread reports back.
- **Apply N findings**: spawns a thread (reusing the review's worktree)
  that runs your `apply-review` skill on the selected findings only (deselected
  ones are omitted from the prompt entirely), commits, and pushes
  to the PR head branch. By default it stops for the skill's triage
  confirmation in the thread; tick the checkbox to apply everything unasked.
  The **and push** checkbox beside both apply buttons decides whether the
  thread pushes to the PR branch or only commits in its worktree and reports
  the push command; the choice is remembered per browser.
- **Agents move cards**: `bb kanban move <column-id>` finds the card for the
  current thread. Threads spawned from cards get instructions and the `kanban`
  skill telling them to do so.

## Setup

```
npm install --include=dev
bb plugin install .
```

GitHub access uses the **GitHub token** plugin setting, or falls back to
`gh auth token` on the machine running the BB server. Sign in with
`gh auth login` or paste a token under Settings → Installed plugins → Kanban.

Optional settings: sync interval, whether to spawn a thread for every new PR
card, a fallback project for PRs whose repository matches no project's git
remote, and whether a card moves to In Progress when its thread starts working.

## Columns

Default columns: `backlog`, `todo`, `in-progress`, `review`, `done`. Edit them
under Settings → Columns on the page; agents refer to columns by id. New PR cards land in `todo`,
whether you authored them or were asked to review. Sync never moves an open PR
card you placed by hand.

## CLI

```
bb kanban list [--column <id>] [--tag <tag>] [--parent <id|none>] [--json]
bb kanban tag <tags...> [--ticket <id>]
bb kanban untag <tags...> [--ticket <id>]
bb kanban sources
bb kanban columns
bb kanban show [--ticket <id>]
bb kanban add "<title>" [--tag <tag>] [--description <md>] [--column <id>] [--project <id>] [--start-thread] [--parent <id>]
bb kanban subtasks [--ticket <id>]
bb kanban set-parent <ticket-id> <parent-id|none>
bb kanban start-subtasks [--ticket <id>] [--sequential]
bb kanban move <column-id> [--ticket <id>]
bb kanban review [--ticket <id>] [--project <id>] [--full]
bb kanban review-show [--ticket <id>]
bb kanban apply-review [--ticket <id>] [--yes] [--no-push]
bb kanban comments [--ticket <id>]
bb kanban apply-comments [--ticket <id>] [--yes] [--no-push]
bb kanban link <ticket-id> [--thread <id>]
bb kanban remove <ticket-id>
bb kanban sync
```

## Development

```
npm run typecheck
npm test            # vitest; needs the better-sqlite3 native binding built
bb plugin dev       # rebuild and reload on save
```
