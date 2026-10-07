# bb-plugin-kanban

A kanban board for BB where every card is a thread.

- **Kanban** page in the sidebar: columns, drag-and-drop cards. Each card shows
  its title, its PR or Jira identity and your own tags (tags applied by a
  source are hidden on cards), and one quiet status row: a thread dot (words
  only when it is working, errored, or needs you) plus compact counters for
  subtasks, review findings, open PR comments, and pending diff comments. Clicking a card opens it in the page's right-side
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
  opens a full-page diff at `/plugins/kanban/board/diff/<id>`: every file in
  one continuous scroll with sticky, collapsible headers (as on GitHub), and a
  file list with per-file stats that jumps to a file and tracks the one in
  view. PR cards diff the pull request from GitHub; thread-backed cards diff
  their environment against its merge base. Every thread header also has a
  "Changes" button that opens the same view for that thread
  (`diff/thread:<threadId>`), as its card when it has one; submitting
  comments from a bare thread creates a card for it first.
- **Structural diff** (default; a Text / Structural toggle in the title bar
  switches): runs [difftastic](https://github.com/Wilfred/difftastic)
  (`brew install difftastic`; path configurable in settings) on both sides of
  each file and lays the result out like GitHub's split view: three lines of
  context around each change, collapsed gaps with ↑/↓ expanders and the
  enclosing function after `@@`, Shiki syntax colouring from bb's code theme,
  difftastic's changed spans tinted on top, and moved blocks in violet with a
  "moved to/from line N" jump. Whole-file adds and deletes show a preview with
  a "show more" bar. Line numbers still take comments. Hold ⌘ (Ctrl) and hover
  any identifier for a card showing where it is defined and its first lines;
  ⌘-click opens an inline peek under that line, like an editor's peek
  definition: definitions and whole-word usages (`git grep` in the card's
  local checkout, grouped by file) on the left, the selected one's source on
  the right with syntax colouring, "20 more lines" to widen, ⌘-click inside
  the peek to drill into another symbol with a back trail, and "Open file"
  for bb's file preview. Without a checkout it falls back to GitHub code
  search.
- **Projects for every repository**: a PR card whose repository matches no
  project's git remote gets one created for it: the repo is cloned (blobless,
  SSH when your other projects use SSH) under the clone directory setting
  (default `<bb data dir>/plugins/kanban/repos/<owner>/<repo>`) and
  registered as a project, and every card for that repo adopts it. Turn this
  off with the "Create a project for each new repository" setting to fall
  back to the fallback project instead.
- **Tour**: "Generate tour" at the top of the changes view spawns one agent
  thread that reads the diff and ends with a ```json kanban-narrative block:
  a summary, every file in reading order tagged key / supporting /
  mechanical with a note and the lines to look at, and a watch-out list. The
  panel renders it, file names jump to the file, and it is marked stale when
  the PR head moves. Stored per card in `narratives`.
- **Hunk headers**: every hunk in the structural view starts with a GitHub-style
  `@@` row naming the line span and enclosing function. Its "Explain" button
  spawns one short agent thread (reusing the review, tour or card thread's
  checkout) that explains what the hunk does and why; the answer renders as a
  collapsible strip under the header and is kept per head in
  `hunk_explanations`. The same row shows the tour's semantic labels (rename,
  move, signature, reorder, reformat, extract, inline), and lines inside those
  blocks are tinted violet instead of red/green.
- **Since you last looked**: when the PR head moves after you ticked files as
  viewed, a strip lists the files that changed (GitHub compare between the two
  heads), how many findings are new or had their lines touched, and offers
  "Re-review the delta", which runs the code-review skill incrementally from
  the last reviewed commit. Viewed marks carry over for files the push did
  not touch; changed lines get a blue edge in the gutter and changed files a
  "changed" chip in the tree. Findings from the latest full review plus every
  incremental review after it are shown together, tagged "new" or "touched".
- **Risk heat**: the tour scores each file 1–5 for review attention; the file
  tree tints rows from green to red accordingly (viewed files lose the tint),
  falling back to the worst finding severity in the file when there is no tour.
- **Findings in the diff**: the latest completed review's findings render
  inline under the lines their `locations` point at (new side), in both
  structural and text modes, with severity, scores, and the same apply-round
  checkbox as the card panel. File-level findings sit under the file header,
  the file tree shows a red count per file, and findings appear as amber
  markers on the scroll track.
- **Review aids**: a per-file "Viewed" checkbox collapses the file and counts
  toward "n of m viewed" at the top (scoped to the PR head, so a push resets
  it); lockfiles, vendored and generated files collapse by default; the file
  tree groups by directory with per-directory stats; a Wrap toggle switches
  long lines between wrapping and horizontal scroll; comment markers sit on a
  track beside the scrollbar; and the keyboard moves through the review:
  `j`/`k` changes, `n`/`p` files, `c`/`C` comments, `v` toggle viewed.
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
