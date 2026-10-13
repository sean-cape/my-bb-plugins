# bb-plugin-kanban

A kanban board for BB where every card is a thread. Cards come from GitHub
and Jira searches, brain dumps, or by hand; each card's changes page is where
its PR is reviewed and its review findings and comments are handed to agents.

- **Kanban** page in the sidebar: columns, drag-and-drop cards. Each card shows
  its title, up to three of your own tags (tags applied by a source are hidden
  on cards), and one quiet footer: a thread dot (words only when it is working,
  errored, or needs you), the PR or Jira id as text, the due date (red when
  overdue, amber when due today or tomorrow, never coloured in Done), and icon counters for
  subtasks, review findings, open PR comments, and unsent diff comments,
  coloured only when they need attention. PR cards also show the PR's state and
  its head commit's CI checks (the card panel adds its branch); Jira cards their
  status. With a Nerd Font the row leads with one muted glyph for the PR state
  or Jira status, and only a passing or failing check is coloured; otherwise
  they are words or outline icons. Hover actions overlay the counters. Clicking a card opens it in the page's right-side
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
  Board/Todo toggle, the **Settings** cog (Columns, Sources, Keyboard shortcuts, "Sync sources
  now" with the last-sync status) and New card; on a card's changes page the
  bar holds Back, the card name, the Unified/Split toggle, and Refresh.
- **Keyboard**: the board moves vim-style outside text boxes. `h`/`l` step
  between columns (skipping empty ones), `j`/`k` between cards, `gg`/`G` jump
  to a column's first or last card, `0`/`$` to the first or last column.
  `H`/`L` move the card to the neighbouring column and `J`/`K` reorder it.
  `o` (or Enter) opens the card, `t` its thread, `d` its changes, `a` adds a
  card to the current column, `za` shows or hides the column's old cards
  (see Columns), Ctrl-d/Ctrl-u scroll the column, `T` switches to the Todo
  view, and `?` (or Settings → Keyboard shortcuts) lists them all. Arrow keys
  work as `h`/`j`/`k`/`l`. `k` past a column's top card lands on its + button
  and then on the title bar's controls, where `h`/`l` and `0`/`$` step along,
  `j` comes back down, and `o`, Enter or Space press; `j`/`k` also step through
  the Settings menu.
  Opening a card from the keyboard puts the keys in the card, with the cursor
  on its View changes button when it has one; the keys move the way the card
  is laid out: `j`/`k` go to the field or button below or above,
  `h`/`l` along a row (such as the buttons beside the title), `gg`/`G` to the
  first or last, and Ctrl-d/Ctrl-u scroll half a page. Enter or Space presses a button; on a text box, Enter or `i` starts
  typing (`i` elsewhere goes to the description). Escape returns to the keys;
  with vim-mode it takes two (the first enters vim's normal mode). Escape again
  closes the card and puts the cursor back on the board, and `h` past a row's
  left edge goes back to the board leaving the card open. `t` and `d` open the card's thread and
  changes.
- Card details follow one hierarchy: the title with a quiet meta line (kind,
  id, column, PR or issue; the PR number or Jira key links to it, plus icon buttons for the thread, with its status dot, and the changes, with
  the count of unsent comments), a property list (Column, Tags, Due, Thread, Author or Jira fields),
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
- **Subtasks**: any card can hold subtasks (nested as deep as you like). List
  them while creating the card in the New card dialog (Enter adds the next
  one; `#tag` works); they land in the card's column and project before its
  thread starts, so that thread already knows about them. The card panel's Subtasks group lists them with done checkboxes, column, and
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
- **Due dates** on every card: a calendar day set in the New card dialog or the
  card panel's Due property, or with `bb kanban due` / `add --due`. Sync never
  changes them. A card's thread is told its due date.
- **Todo view** (toggle at the top of the board, or `/plugins/kanban/board/todo`):
  a flat checklist grouped by column with tag filters, quick-add
  (`Fix thing #infra`), and a checkbox that moves a card to Done. Its keys:
  `j`/`k` and `gg`/`G` move through the todos (`k` past the top reaches the
  tag filters and the title bar), `x` marks done or reopens, `o`/Enter opens
  the card, `t` its thread, `i` or `a` types a new todo (Escape, twice with
  vim-mode, returns to the list), Ctrl-d/Ctrl-u scroll, and `T` goes back to
  the board.
- **Aura wallpaper**: with the Aura plugin's fork in this repo
  (`plugins/aura`), the board and Todo view show the same background as
  threads; columns and the todo list sit on translucent, blurred panels.
- **Ad hoc cards** from the page, from `bb kanban add`, or from an agent inside
  a thread (the card is linked to that thread).
- **Review PR** button on every PR card: spawns a review thread in a fresh
  worktree of the matching project, checks the PR head out detached, and runs
  your `code-review` skill (`~/.claude/skills/code-review`) against
  `origin/<base>...HEAD`. Findings land in that thread; nothing is posted to
  GitHub. The card shows the review thread's status and opens it on click.
  Every thread a code review button starts (reviews from the button, `bb kanban
  review` or an automation, applying findings or comments, tours, and hunk
  explanations) runs hidden, so it stays out of the sidebar and the project's
  thread list. The changes view's title bar has a Review button showing the
  latest review's status and finding count that opens its thread (or starts a
  review when there is none), plus a Fixes button for its apply thread. Older
  threads are in the "Threads" menu beside them, and tours and explanations
  have a "thread" link.
  Turn off "Keep code review threads out of the sidebar" to show them (existing
  ones follow the setting).
- **Persisted reviews**: when the review thread finishes, its compiled findings
  and the reviewed commit are stored on the card. "Review since <sha>" reviews
  the commits pushed after the last review and re-checks every earlier finding
  at the new head: the ones still open carry forward into the new review
  (tagged "carried", keeping your include/exclude choice), and the ones fixed
  are listed under "Resolved since the last review". The latest review then
  stands for the whole PR, so applying it never drops an unaddressed finding.
  "Full review" starts over, without carry-over.
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
  their environment against its merge base. `diff/thread/<threadId>` opens a
  thread's changes the same way, as its card when it has one; submitting
  comments from a thread without a card creates one first. A thread's own
  Changes button and side-panel tab come from the `diff-view` plugin.
- **Structural diff**: runs [difftastic](https://github.com/Wilfred/difftastic)
  (`brew install difftastic`; path configurable in settings) on both sides of
  each file (a file it cannot diff, or every file when it is missing, shows
  the line diff instead, with a note saying so) and lays the result out like GitHub's split view: three lines of
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
- **New project from a folder**: every project dropdown ends with "New
  project from folder…", which opens the native folder picker on bb's
  primary host and makes the chosen directory a project (named after the
  folder, as bb's own "Add project" does), then selects it.
- **Tour**: "Generate tour" at the top of the changes view spawns one agent
  thread that reads the diff and ends with a ```json kanban-narrative block:
  a summary, every file in reading order tagged key / supporting /
  mechanical with a note and the lines to look at, and a watch-out list. The
  panel renders it, file names jump to the file, and it is marked stale when
  the PR head moves.
- **Hunk headers**: every hunk in the structural view starts with a GitHub-style
  `@@` row naming the line span and enclosing function. Its "Explain" button
  spawns one short agent thread (reusing the review, tour or card thread's
  checkout) that explains what the hunk does and why; the answer renders as a
  collapsible strip under the header and is kept until the PR head moves. The same row shows the tour's semantic labels (rename,
  move, signature, reorder, reformat, extract, inline), and lines inside those
  blocks are tinted violet instead of red/green.
- **Since you last looked**: when the PR head moves after you ticked files as
  viewed, a strip lists the files that changed (GitHub compare between the two
  heads), how many findings are new or had their lines touched, and offers
  "Re-review the delta", which runs the code-review skill incrementally from
  the last reviewed commit. Viewed marks carry over for files the push did
  not touch; changed lines get a blue edge in the gutter and changed files a
  "changed" chip in the tree. Findings from the latest review are shown,
  tagged "new", "carried" or "touched" (re-reviews made before carry-over
  stack on the latest full review instead).
- **Risk heat**: the tour scores each file 1–5 for review attention; the file
  tree tints rows from green to red accordingly (viewed files lose the tint),
  falling back to the worst finding severity in the file when there is no tour.
- **Findings in the diff**: the latest completed review's findings render
  inline under the lines their `locations` point at (new side), in both
  structural and text modes, as one line each (severity, title, the same
  apply-round checkbox as the card panel) that opens to the description, fix
  and scores on click, Enter, or when the keyboard cursor reaches it. The
  findings chip above the diff (or `F`) cycles which show: all, important and
  up (the default), critical only, or none. File-level findings sit under the file header,
  the file tree shows a red count per file, and findings appear as amber
  markers on the scroll track.
- **Review aids**: a per-file "Viewed" checkbox collapses the file and counts
  toward "n of m viewed" at the top (scoped to the PR head, so a push resets
  it); lockfiles, vendored and generated files collapse by default; the file
  tree groups by directory with per-directory stats; long lines always wrap,
  and the diff opens split; comment markers sit on a
  track beside the scrollbar; and the whole review runs from the keyboard with
  vim-style keys (see the Diff view plugin's README, or press `?` in the
  view).
- **Vendored files**: files under `vendor/`, `node_modules/`, `third_party/`,
  `bower_components/`, `.yarn/`, `Pods/` and `Carthage/Checkouts/` are left
  out of the changes view (the stats line's tooltip says how many were hidden). Turn off
  "Hide vendored files in the changes view" in the plugin settings to show them;
  even then they stay collapsed and use the text diff, never difftastic.
- **Diff comments**: hover a line in the changes view and press the "+" gutter
  button (or click the line number) to comment on that exact line, on either
  side of the diff. Drag the "+" or the line numbers, or shift-click a second
  line number, to comment on a range instead; it posts to GitHub as a
  multi-line comment, and the text view keeps a range inside one hunk, as
  GitHub requires. The comment icon on a file header (shown under the pointer
  or the cursor), or `O`, leaves a file-level note. On PR cards a
  **Comments go to Local / GitHub PR** switch in the strip above the diff sets
  where every new comment and reply goes: local comments stay on the board for
  an agent, GitHub ones are drafts until you post them. It starts on GitHub for
  PRs carrying the review tag (`#pr-reviews` by default, configurable in
  settings) and on local everywhere else, and holds while the page is open.
  Replies in threads that are not on GitHub stay local either way. "Make local"
  / "Move to GitHub" switches a comment that has not been sent yet. The bar at the top has two actions:
  **Send N to agent** hands the local comments to a thread running
  `apply-pr-comments` (with the same and-push and skip-triage options), and
  **Post N to GitHub** posts the drafts: new threads as one review (inline
  where a line is given, in the review body otherwise) and replies into their
  GitHub threads. On someone else's PR a **Comment / Approve / Request
  changes** picker beside it sets how that review concludes, as GitHub's
  "Finish your review" does. From the diff, `s` lands on the picker: `h`/`l`
  (or the arrows) choose, Enter posts, Tab reaches the button, Escape returns.
- **Comment threads**: the changes view shows the PR's inline GitHub review
  comments under their lines, threaded with their replies, alongside the
  board's own comments. Resolved threads start collapsed; comments whose line
  the latest push changed show as outdated at the top of the file. Reply in
  any thread, locally or on GitHub (GitHub replies need a thread that is an
  inline GitHub comment, or a GitHub draft that becomes one). Local replies in
  a GitHub thread reach the agent with the whole thread quoted, so "do what
  Bob says, but keep the alias" works. After addressing comments the agent
  answers in each thread with `bb kanban comment-reply`, so its replies (what
  it changed, or why not) sit next to the line. A posted draft shows once, as
  its synced GitHub copy.
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
  skill telling them to do so. A card in Backlog or To Do also moves to In
  Progress on its own when its thread starts working (the "Move cards to In
  Progress when their thread starts working" setting).

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

Each column has options behind its cog in Settings → Columns. "Hide cards
that have been in this column for more than N days" keeps old cards off the
board (Done is the usual one); leave it empty to keep them all. A column
holding cards back ends with "Show N older cards" (or press `za` on the board)
to bring them back for the visit. Days count from when the card entered the
column; cards already there when the setting arrived count from their last
change.

## CLI

```
bb kanban list [--column <id>] [--tag <tag>] [--parent <id|none>] [--json]
bb kanban tag <tags...> [--ticket <id>]
bb kanban untag <tags...> [--ticket <id>]
bb kanban due <YYYY-MM-DD|none> [--ticket <id>]
bb kanban sources
bb kanban columns
bb kanban show [--ticket <id>]
bb kanban add "<title>" [--tag <tag>] [--due <YYYY-MM-DD>] [--description <md>] [--column <id>] [--project <id>] [--start-thread] [--parent <id>]
bb kanban subtasks [--ticket <id>]
bb kanban set-parent <ticket-id> <parent-id|none>
bb kanban start-subtasks [--ticket <id>] [--sequential]
bb kanban move <column-id> [--ticket <id>]
bb kanban review [--ticket <id>] [--project <id>] [--full]
bb kanban review-show [--ticket <id>]
bb kanban apply-review [--ticket <id>] [--yes] [--no-push]
bb kanban comments [--ticket <id>]
bb kanban apply-comments [--ticket <id>] [--yes] [--no-push]
bb kanban comment-reply <comment-id> "<text>"
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
