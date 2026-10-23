# bb-plugin-kanban

A kanban board for BB where every card is a thread. Cards come from GitHub
and Jira searches, brain dumps, or by hand; each card's changes page is where
its PR is reviewed and its review findings and comments are handed to agents.

![Kanban board with To Do, In Progress, In Review and Done columns](../../docs/screenshots/kanban-board.jpg)

- **Kanban** page in the sidebar: columns, drag-and-drop cards. Each card shows
  its title, up to three of your own tags (tags applied by a source are hidden
  on cards), and one quiet footer: a thread dot (words only when it is working,
  errored, or needs you), the PR or Jira id as text, the due date (red when
  overdue, amber when due today or tomorrow, never coloured in Done), and icon counters for
  subtasks, open PR comments, and unsent diff comments, coloured only when
  they need attention; the review badge is one count of open findings, with
  the severity split, the applied count and the apply selection in its
  tooltip. Token spend and the time in the column are in the card panel, not
  on the card. PR cards also show the PR's state and
  its head commit's CI checks, a link to the failing (else pending, else first)
  check's run on GitHub (the card panel adds its branch); Jira cards their
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
    search"). Merged or closed PRs move to Done. An open PR card in Done
    that left its source and comes back (your review is requested again, or
    a closed PR is reopened) returns to Todo. A PR whose branch ends in an
    ad hoc card's thread id joins that card instead.
  - **Jira (JQL)**: a JQL query on your Jira Cloud site. Needs the Jira site
    URL, account email, and API token plugin settings. Cards land in To Do or
    In Progress from the issue's status category, carry key, status, priority
    and assignee, and move to Done when the issue is done in Jira. The card
    thread's first prompt includes the issue description.
  Each source has tags, an optional project for its card threads (GitHub
  sources match the repo's git remote first), and a "done when it leaves this
  search" flag.
  A GitHub source can also review its PRs: pick Quick, Standard or Deep under
  "Review new PRs" and every PR card it creates gets a code review at that
  depth, as if Review PR had been pressed, and a re-review of the commits since
  whenever the PR comes back to the search (your review is requested again).
  Turn it on for `#pr-reviews` to have everything you're asked to review
  reviewed by the time you open it. Cards already on the board are left alone.
  A review waits while the PR is a draft, while its project is still being
  cloned, or while another review of it runs; a monitored card's loop runs its
  own reviews instead. Several sources on one PR take the deepest depth.
  "Narrate new PRs" does the same for the narrative review: every PR card the
  source creates gets a narrative, as if Write narrative had been pressed, and
  a PR that comes back to the search gets an update chapter if its code has
  moved since. It waits on drafts, clones and a running narrative the same
  way, and leaves monitored cards to the loop, which writes its own.
- The page's controls live in bb's title bar next to the Kanban name: the
  Board/Todo toggle, the **Settings** cog (Columns, Sources, Keyboard shortcuts, "Sync sources
  now" with the last-sync status) and New card; on a card's changes page the
  bar holds Back, the card name, the Unified/Split toggle, and Refresh.
- **Keyboard**: the board moves vim-style outside text boxes. `h`/`l` step
  between columns (skipping empty ones), `j`/`k` between cards, `gg`/`G` jump
  to a column's first or last card, `0`/`$` to the first or last column.
  `H`/`L` move the card to the neighbouring column and `J`/`K` reorder it.
  `o` (or Enter) opens the card, `t` its thread, `D` its changes, `m` turns its
  review loop on or off (see Monitored cards), `d` deletes
  it (no confirmation; `u` or the toast's Undo brings it back with its
  reviews, comments and subtasks, for up to a week), `a` adds a
  card to the current column, `za` shows or hides the column's old cards
  (see Columns), Ctrl-d/Ctrl-u scroll the column, `T` switches to the Todo
  view, and `?` (or Settings → Keyboard shortcuts) lists them all, with `/` to search the list. Arrow keys
  work as `h`/`j`/`k`/`l`. `k` past a column's top card lands on its + button
  and then on the title bar's controls, where `h`/`l` and `0`/`$` step along,
  `j` comes back down, and `o`, Enter or Space press; `j`/`k` and `gg`/`G` also
  step through the plugin's menus (Settings, and the card's subtask and review menus).
  Opening a card from the keyboard, or by clicking one while a card is
  already open, puts the keys in the card, with the cursor
  on its View changes button, greyed out when there are no changes; the keys move the way the card
  is laid out: `j`/`k` go to the field or button below or above (`k` from
  the buttons beside the title reaches the title),
  `h`/`l` along a row (such as the buttons beside the title), `gg`/`G` to the
  first or last, and Ctrl-d/Ctrl-u scroll half a page. Enter or Space presses a button; on a text box, Enter or `i` starts
  typing (`i` elsewhere goes to the description), and Enter in the title saves
  it and returns to the keys. Escape returns to the keys;
  with vim-mode it takes two (the first enters vim's normal mode). Escape again
  closes the card and puts the cursor back on the board, and `h` past a row's
  left edge goes back to the board leaving the card open. `t` and `D` open the card's thread and
  changes, and `m` turns its review loop on or off.
- Card details follow one hierarchy: the title with a quiet meta line (kind,
  id, column, PR or issue; the PR number or Jira key links to it, the checks
  tick to the CI run, plus icon buttons for the thread, with its status dot,
  and the changes, with the count of unsent comments). A PR card is read for
  its review, so Code review, PR comments and the PR's description (as
  written on GitHub, synced with the card) come next, then the property list
  (Column, Tags, Due, a Start row while the card has no thread, Jira fields);
  other cards show the properties first. Then the Review loop (folded while
  off, and absent on someone else's PR), Subtasks (folded while there are
  none) and Description or Notes. Title and description save when the field
  loses focus. A PR or Jira card's title is editable too; once edited, sync
  keeps your title instead of taking the PR's or issue's again.
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
- **Monitored cards**: turn on the switch in the card panel's Review loop
  section (or press `m`, or run `bb kanban monitor on`) and the board drives
  the card itself. Its
  thread is told (in its instructions, and with a message when the thread
  already exists) to commit its work, run the project's check command, and
  finish with `bb kanban ready` and the evidence of what it ran, never moving
  the card itself. The card then moves to Checking while a hidden thread
  checks the commit out detached in a fresh worktree of the project (for a PR
  card, fetched from the PR first) and re-runs the check command; it records
  the exit code and the output's tail with `bb kanban checks-record`. The
  first passing checks start a short hidden classify thread that scores each
  changed file's risk (1–5) and role; with the project's path rules, it sets
  the attention level (Glance, Read or Scrutinize, with its reasons), which
  picks the review's depth: Quick, Standard or Deep. Ordinary logic (risk 3)
  under 100 changed lines counts as Glance, so a small change gets a Quick
  review, and a failing check counts toward the level only while the thread
  keeps the same check command (a failure it fixed by changing the command
  was the command's, not the code's). A classify thread that
  fails twice leaves the review at Standard. Failing checks go back to the
  card's thread with the output and no review is run, and a second failure in
  a row stops the loop at Needs you. Every finding the review triaged apply,
  whatever its severity, goes back to the card's thread in one fix prompt
  (deferred, dropped and pre-existing ones never do). The thread answers each
  with `bb kanban answer <ids> fixed` or `bb kanban answer <id> disputed
  --reason "<why>"`, and the board refuses its ready report until every one
  is answered. The fix commit is checked and re-reviewed incrementally, with
  a severity floor once the first round is done: the re-review only looks for
  new critical and important findings and leaves the style finder out. It
  also judges each dispute: an accepted one closes the finding, a
  rejected one stops the loop with reason "dispute" (or, on a minor finding,
  stays open as a minor), and a critical or important finding answered fixed
  that is still there stops it with reason "not converging" (a minor one
  stays listed as open instead). A clean review moves the card to
  Needs you. Minor findings start the first round like any other, but after
  it only a critical or important finding starts another (the open minors go
  with it); a re-review left with only minors ends clean with them listed. A
  round of only minor findings is a polish round: its fix is checked but not
  reviewed again, and the loop ends clean once the checks pass, listing the
  minors the thread disputed as left open.
  After three fix rounds the loop stops: at Needs you with reason "cap" while
  a critical or important finding is open, or as clean with the open minors
  listed. A checks or review thread that fails (after a review's resumes), is
  deleted, or ends without leaving any message is started again once; a
  second failure stops the loop as a loop error, with a link to the thread in
  the card panel. A thread that finished with a message the board can't read
  (no review-findings report, no classify scores) stops it at once, since a
  retry would write the same message; a review thread without the
  `code-review` skill says so, and the card names the fix. A review thread
  can idle on an interim message while its verifiers still run; the loop
  keeps reviewing until the report replaces it, and only counts the review
  failed once the thread has stayed idle ten minutes without one (or at once
  when its message starts `Review failed:`). A ready at a new
  commit while the loop is checking, classifying or reviewing an older one
  stops those threads and starts over at the new commit; a repeated ready of
  the same commit is ignored. The checks, classify, review and narrative
  threads are owned by the card's thread (archived and deleted with it) and
  run its provider and model, but aren't its children: bb would post each
  one's final message into the card's thread, which took them as work to do.
  Checks and classify run at low reasoning. While
  the card's thread waits on you (a question or an approval) the loop pauses
  as `stuck · question` without moving the card, and resumes at its next
  ready. The level is recomputed when the loop stops, from the file scores,
  the rounds, disputes and check failures, and the last review's untested
  paths (its `Untested:` not-covered entries; `UI only:` and `Unverified:`
  ones are listed but don't raise it), open scope findings and deferred
  critical findings. The check command
  and the path rules (`src/auth/** scrutinize, .github/** read`) are set per
  project in the card panel's Checks and Path rules fields; a project without one lets the agent pick, and the board marks
  it as the agent's choice. Monitored cards carry a chip naming the loop's
  phase (`building`, `checks`, `classifying`, `review rN`, `fixing rN`, `ready · <level>`, or
  `stuck · <reason>`) and a pip per fix round used. Turning
  monitoring off stops the loop after its current step: a running check or
  review finishes, and its result is kept but drives nothing; a fix round in
  progress ends with its findings left open, so the review's Apply is back.
  Three gates sit under the switch, each with a one-line hint and a tooltip
  that also opens when `j`/`k` reach it (Space ticks): two that wait for you
  and one that finishes on its own. They are chosen as monitoring turns on (`bb kanban monitor on --gates
  plan,findings,auto-accept|none`): plan approval (on by default for Jira
  cards) holds the card in `planning` until its thread proposes a plan with
  `bb kanban plan --plan-file <path>` and you approve it, edited or not, with `Y`; the
  approved plan goes to the thread and into every review's card intent.
  Findings approval stops each round at Needs you (`approve rN`) until you
  untick findings and approve the rest with `Y`; the unticked stay open.
  Auto-accept accepts a clean change at Glance, with no serious finding or
  dispute open, without stopping; never at Read or Scrutinize. Open minors
  are listed on the accepted card with Make a card. The Monitor tags setting
  monitors new cards carrying its tags by default; `bb kanban add
  --monitor|--no-monitor` and the card's switch always win.
  A card stopped at Needs you (or paused by a question) opens with a handoff
  brief at the top of its panel, one collapsible group per section the card's
  `j`/`k` reach: the level and its reasons, led by why the loop stopped when
  it isn't clean; what the checks don't cover; evidence, the board's re-runs
  apart from what the agent claims; each round's history with accepted
  disputes and the nits and smells fixed; deferred, dropped, pre-existing and
  left-open findings; and rejected disputes with both sides' reasoning. The
  changes page shows the level, reasons and not-covered list as a strip
  above the diff, which collapses. The brief's actions, each with a key:
  Accept (`A`) has a local card's thread land the change with the project's
  own finishing steps and moves the card to Done when it reports `bb kanban
  landed` (a PR card is only marked accepted); Send back (`S`) sends your
  unsent diff comments to the card's thread; Rethink (`R`) stops the loop and
  asks the thread for a new approach, counting rounds again from its next
  ready; Pull in (`p`) sends a deferred or dropped finding to fix; Uphold
  (`u`) or Close (`c`) settles a rejected dispute, and once no serious one is
  left the upheld ones go to fix. Rounds you start never count toward the cap.
  The brief ends with a reading plan: none at Glance (the evidence and
  not-covered list are the plan), key files at Read, key and supporting files
  at Scrutinize, mechanical files collapsed. Reaching Needs you at Read or
  Scrutinize requests a narrative, unless it stopped for failing checks or a
  loop error; Reading plan (`P`) opens its stepper cut
  down to the plan's files, or the changes view when there is none yet. At
  Scrutinize Accept stays disabled, counting the plan files not yet marked
  Viewed. Change level (`L`) sets the level with a reason; it holds until
  the card's next ready at a new commit, and the reason is kept.
  Needs you is sorted by level, Scrutinize first, then by how long each card
  has waited there. The card's thread stays out of the unread list while the
  board has the work: a turn that reports ready (or lands the change) is
  marked read as it ends, before the push plugin's two-second wait, so it
  sends nothing either. When the loop stops at Needs you, the thread is
  marked unread again and open bb windows show a desktop notification (with
  the permission the push plugin asked for) that opens it. The handoff brief shows the tokens the card's
  threads have used (its own, checks, classify, review, apply and narrative
  threads), read from Claude Code's transcripts every 30 seconds.
- **Review PR** button on every PR card: spawns a review thread in a fresh
  worktree of the matching project, checks the PR head out detached, and runs
  your `code-review` skill (`~/.claude/skills/code-review`, kept in this
  repository's `claude/` and linked by `node scripts/link-claude-config.mjs`
  with the reviewer subagents it spawns) against
  `origin/<base>...HEAD`. Findings land in that thread; nothing is posted to
  GitHub. The card shows the review thread's status and opens it on click.
- **Review the commits** on any other card (ad hoc, Jira, subtask) whose
  thread has committed work: the review thread gets a fresh worktree of the
  project, checks the card thread's HEAD out detached, and reviews it against
  its merge base with the branch the changes view diffs against (the
  environment's merge-base branch, else the project's default branch). The
  button and `bb kanban review` are disabled with the reason when the card
  has no thread, no commits beyond that branch, or its thread runs on another
  machine than the project's checkout. Re-reviews only continue from a review
  of the same kind, so a card reviewed locally and as a PR keeps two chains.
  A review whose thread dies mid-turn (the machine slept, the connection
  dropped, bb was quit) is resumed where it stopped, up to twice, rather than
  failing and starting over; one that died while bb or the plugin was down is
  resumed when it loads. Rate limits and overloads are left to bb's
  provider-retry, and the review keeps running while its retry is queued.
  Every thread a code review button starts (reviews from the button, `bb kanban
  review` or an automation, applying findings or comments, tours, and hunk
  explanations) runs hidden, so it stays out of the sidebar and the project's
  thread list. The changes view's heading row has a Review button until the
  card has a review, then one "Threads" menu that lists every code review
  thread (review, apply, narrative, explanation) with its status; the
  findings chip in the summary bar carries the count. Tours and explanations
  also have a "thread" link.
  Turn off "Keep code review threads out of the sidebar" to show them (existing
  ones follow the setting).
- **Review depth**: a review runs at Quick (correctness, CLAUDE.md
  compliance, scope and style), Standard (adds testing and git history; the
  default) or Deep (adds security, through the security reviewer and
  `/security-review`). The storage reviewer still runs only when storage
  files change, the spec reviewer whenever there is a spec, and every depth
  verifies and triages its findings. The card panel's Code review has a depth
  picker beside its Review and Retry buttons (from the keys, h/l choose and
  Enter starts the review), and its menu chooses the depth of the next
  review; `bb kanban review --depth quick|standard|deep` does the same. The
  changes view's Review button and "Re-review what's new", and the board's
  review icon, run Standard. The card panel shows the depth a review ran at
  (from its report), and the board card's review badge names it on hover.
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
  PR; 1 means a separate piece of work). The card panel lists each finding as
  one row (checkbox, severity, title, where) that opens to its details on a
  click or Enter; the scores, confidence and bug class are in the id's
  tooltip once open, and the review's summary shows its first sentence with
  "More". Findings have a checkbox deciding
  whether they go to the apply round; the suggested selection is the findings
  the review's triage applies (below), and for reviews from before triage,
  every critical finding plus anything with importance ≥ 3 and scope ≥ 3. Your
  changes persist per review, and "Reset to suggested" restores the suggestion.
- **Scope and triage**: the review prompt carries the card's intent (title,
  description, approved plan once the loop's plan gate keeps one, and the
  spec under `.claude/features/` when there is one), and the skill's scope
  finder reports parts of the change beyond it under a `scope` category, with
  the fix to remove or split them out; on a re-review it also checks each fix
  commit stays within the findings it answers. After verifying, the skill
  triages every verified finding of the change's own: **apply**, **defer**
  (real, but the proper fix is separate work, even for a critical finding) or
  **drop** (churn far beyond the benefit, or against the project's
  conventions; never just for being minor), each with a reason. The criteria
  live in `~/.claude/skills/triage-criteria.md`, which `apply-review`'s own
  triage reads too. The card lists deferred findings apart, with "Make a
  card" (the card says why it was deferred), and folds dropped ones under "N
  dropped" with their reasons; tick either to pull it into the apply round.
- **Verified findings**: the skill has a verifier check every finding and
  score it 0–100 for being real (never for how much it matters, so a real
  nit scores like a real bug). Findings under 80 fold into "N filtered"
  below the rest, with the verifier's reason; the button (or Enter on it from
  the keys) unfolds them. They are never selected or applied. Findings in code
  the change didn't touch, and didn't cause, are tagged **pre-existing** and
  listed apart: never pre-selected, left out of the card's counts, and each
  has "Make a card", which adds a Backlog card in the same project carrying
  the finding's title, description, fix and locations, then turns into "Open
  card" (pressing it again, or on the same finding carried into a re-review,
  finds that card instead of making another). Each finding shows its
  "confidence N", or "unverified" when the verifier gave no verdict. Reviews
  from before verification show as they did.
- **Bug classes and what isn't covered**: each finding names its bug class
  (the kind of mistake) and lists every instance as a location, so one fix
  covers them all; the card shows the class and "N instances", the changes
  view puts the finding at each instance, and the apply round is told to fix
  every one. Style and code-smell findings are kept, as minor. Each review
  ends with a "Not covered" list: changed paths no test exercises, behaviour
  only visible in the UI, and anything the reviewers couldn't verify; an
  empty list says the review found nothing the checks miss. A re-review keeps
  the earlier entries that still hold.
- **Changes view**: "View changes" on a card (or the diff icon on hover)
  opens a full-page diff at `/plugins/kanban/board/diff/<id>`, closing the
  right panel so the diff has the width (the card's findings are inline in
  it): every file in
  one continuous scroll with sticky, collapsible headers (as on GitHub), and a
  file list with per-file stats that jumps to a file and tracks the one in
  view. PR cards diff the pull request from GitHub (up to GitHub's 3,000-file
  maximum; past it, a banner above the diff says how many files are missing),
  whose old side is the PR's merge base with its base branch, as on GitHub;
  thread-backed cards diff their environment against its merge base. A file
  GitHub sent without a patch (too large) shows "Load diff", which builds it
  from the file's two sides. The button, hover icon and `D` are
  greyed out and do nothing on a card with no PR whose thread has no changed
  files yet (or that has no thread). `diff/thread/<threadId>` opens a
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
  "moved to/from line N" jump. Line numbers still take comments. Hold ⌘ (Ctrl) and hover
  any identifier for a card showing where it is defined and its first lines;
  ⌘-click opens an inline peek under that line, like an editor's peek
  definition: definitions and whole-word usages (`git grep` in the card's
  local checkout, grouped by file) on the left, the selected one's source on
  the right with syntax colouring, "20 more lines" to widen, ⌘-click inside
  the peek to drill into another symbol with a back trail, and "Open file"
  for bb's file preview. Without a checkout it falls back to GitHub code
  search.
- **Links and blame**: `yl` copies GitHub permalinks at the PR's head (its
  merge base for old lines); `gO` opens a PR card's file on GitHub and a thread
  card's in bb's file preview. `gb` blames the same two commits (a range's
  merge base and end when commits are picked) from the card's local checkout
  when it has them (or a thread card's working tree and merge base), else
  from GitHub's GraphQL blame.
- **Suggested changes**: a ```` ```suggestion ```` block in any comment (a
  synced GitHub one or the board's own) shows as a small diff of the commented
  lines; `I` starts one. `A` applies the one under the cursor, `B` batches it,
  and "Commit N suggestions" (or `gB`) applies the batch. On a PR card that is
  one commit on the PR's head branch (the fork's, for a PR from one), "Apply
  suggestions from code review", made through GitHub's git data API from the
  branch's tip and never forced, after which each applied GitHub thread is
  resolved; on a thread card it writes the thread's checkout, uncommitted.
  Either way, if any suggestion's lines (or the line just above or below
  them) changed since it was made, nothing is applied and the error names
  them; a PR card also refuses once its branch has moved past the head the
  diff was read at. Files that aren't UTF-8 text and symlinks are refused.
  Comments with a suggestion reach the agent with a line saying the block is
  the exact replacement.
- **Commits** (`gr`, or the summary bar's Commits control): a PR card lists
  the pull request's commits (GitHub's `/pulls/{n}/commits`, up to 250) and
  reads a range through GitHub's compare (up to 300 files, with a banner past
  that); file sides come from the range's merge base and end. Its marks are
  "Since last review" (the card's latest completed review's commit) and "Since
  your last GitHub review" (your latest submitted review's commit), each when
  that commit is in the PR and is not its head. Thread cards list their local checkout's commits,
  uncommitted changes last, and read ranges with local git. Diffs are cached
  per card and range.
- **Projects for every repository**: a PR card whose repository matches no
  project's git remote gets one created for it: the repo is cloned (blobless,
  SSH when your other projects use SSH) under the clone directory setting
  (default `<bb data dir>/plugins/kanban/repos/<owner>/<repo>`) and
  registered as a project, and every card for that repo adopts it. Turn this
  off with the "Create a project for each new repository" setting to fall
  back to the fallback project instead.
- **New project from a folder**: every project dropdown starts with "New
  project from folder…", which opens the native folder picker on bb's
  primary host and makes the chosen directory a project (named after the
  folder, as bb's own "Add project" does), then selects it. The open list
  takes vim keys: j/k move, gg/G jump to the ends, Ctrl-D/Ctrl-U move half a
  list, Enter picks, / or i filters (Escape leaves the filter box), and
  Escape closes it.
- **Narrative review**: "Write narrative" in the changes view's Narrative
  mode (or `U` there) spawns one agent thread. It follows the bundled `narrative-review` skill and
  ends with a ```json kanban-narrative block. The block holds:
  - a summary;
  - every file in reading order, tagged key / supporting / mechanical, with a
    note and the lines to look at;
  - a watch-out list;
  - the **steps**: an ordered walk through the change, each step a Markdown
    explanation (with mermaid diagrams where they help) of the lines it
    references. Every changed line is in at least one step, and lines can
    appear in several.

  Before finishing, the agent runs `bb kanban narrative-check` on its draft,
  which lists any line its steps skip. The **Files | Narrative** switch in
  the changes view's summary bar (or `S`) opens the narrative view:
  - one step at a time, the explanation over just its lines, drawn by the
    same diff renderer as the files view, so the cursor, comments, findings
    and viewed marks take the same keys there; `j` reads on through a step
    and past its end into the next;
  - each chapter opens on its summary, reading order and watch-outs;
  - an outline beside it in wide views (`t`; ← past the old side moves into it);
  - `h`/`l` to step and `]]`/`[[` for chapters (the arrows keep the sides);
  - `gf` to open the cursor's line in the files view;
  - `gv` to mark files viewed once every step that touches them has been read.

  Lines no step covers show up in a final "Not narrated" step, so stepping
  through always shows every line. The board keeps the diff each narrative was
  written against, so older narratives still render after the code moves.
  When the code has changed since the last narrative, "Write update" asks for
  a revision. Its chapter covers every line of the delta between the two heads:
  for PRs a GitHub compare, for local cards a git diff from the earlier
  narrative's HEAD that includes uncommitted and untracked files. It explains
  why each line changed, using the commits in between and the findings and
  comments the board recorded as addressed, and links each step to the new
  narrative's steps. The reader steps from the earlier narrative, through
  "What changed", into the current one.
- **Hunk headers**: every hunk in the structural view (short of one that is
  the whole file) starts with a GitHub-style
  `@@` row naming the line span and enclosing function. Its "Explain" button
  (shown under the pointer; `K` from the keys) spawns one short agent thread (reusing the review, tour or card thread's
  checkout) that explains what the hunk does and why; the answer renders as a
  collapsible strip under the header and is kept until the PR head moves. The same row shows the tour's semantic labels (rename,
  move, signature, reorder, reformat, extract, inline), and lines inside those
  blocks are tinted violet instead of red/green.
- **Findings like GitHub threads**: review findings stay inline at their
  lines while those lines stand, move with code added or removed above them,
  and turn outdated (listed above the diff) when the code under them changes,
  until a re-review relocates them or finds them fixed. Resolve one with `r`,
  its Resolve button, or the card panel's check button: it leaves the diff,
  the open counts and the apply round, and re-reviews no longer re-check it
  (`review_set_resolved`); Reopen brings it back. "Re-review what's new" runs
  the code-review skill incrementally from the last reviewed commit, on PR
  and local cards alike: it reviews the new commits, re-checks every open
  finding at the new head (including the ones an apply round fixed), carries
  the open ones forward at their new lines and lists the fixed ones as
  resolved.
- **New since the last review**: the changes view counts new code from the
  card's last completed review (of the diff's own kind: a PR card's PR
  reviews, a local card's local ones), else your last submitted GitHub review
  of the PR, else the head you last marked files viewed on. A line above the
  diff says which commit the review read, what came after ("3 commits since,
  not reviewed yet"; on a local card, through its uncommitted changes) and how
  many findings are open. Lines changed since are marked blue in the gutter;
  `]n`/`[n` step through them and "Only new" (`gn`) folds everything else
  away. The card panel's Code review shows the commits it read (`at abc1234`,
  or `def5678..abc1234` for a re-review). Viewed marks carry over a push for
  the files it did not touch. See the Diff view plugin's README for details.
- **Risk heat**: the narrative scores each file 1–5 for review attention; the file
  tree marks each row with a dot from green to red accordingly (viewed files lose it),
  falling back to the worst finding severity in the file when there is no tour.
- **Findings in the diff**: the latest completed review's open findings (not the applied ones) render
  inline under the lines their `locations` point at (new side), in both
  structural and text modes, as one line each (severity, title, the same
  apply-round checkbox as the card panel) that opens to the description, fix
  and scores on click, Enter, or when the keyboard cursor reaches it. The
  findings chip above the diff (or `F`) cycles which show: all, important and
  up (the default), critical only, or none. File-level findings sit under the file header,
  the file tree shows a red count per file, and findings appear as amber
  markers on the scroll track. Pre-existing and filtered findings are listed
  above the diff instead, with "Make a card" on the pre-existing ones and the
  filtered ones folded; `gp` moves the keyboard there (`j`/`k`, Enter, Escape
  back) and `gF` unfolds the filtered ones.
- **Findings' suggestions**: a review report from version 6 on may give a
  finding a `suggestion` (`{ file, startLine, endLine, replacement }`, new-side
  lines of one of its files), which the board stores with it, keeps through
  rewording and carries into a re-review (renumbered, or dropped when its lines
  changed); a malformed one is dropped, not the report. The finding's line in
  the diff shows it as a suggestion diff: `A` applies it now and `B` batches it,
  the same way as a comment's suggestion (a PR card's commit, a thread card's
  checkout), and applying it adds the finding to the review's applied findings
  (`review_set_applied`), so it leaves the diff. On a PR card, `gs` posts it to
  the PR as a draft GitHub comment on its lines: the finding's title and
  description, then the suggestion block.
- **Review aids**: a per-file "Viewed" checkbox collapses the file and counts
  toward "n of m viewed" at the top (scoped to the PR head, so a push resets
  it); lockfiles, vendored and generated files, and files with over 1,000
  changed lines, collapse by default (the file header says why); the file
  tree groups by directory with per-directory stats; the two sides stay
  equal at any width and long lines wrap at spaces under their own
  indentation (never a sideways scroll), and the diff opens split; comment markers sit on a
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
  **→ Local / → GitHub PR** button in the strip above the diff (`T`) sets
  where every new comment and reply goes: local comments stay on the board for
  an agent, GitHub ones are drafts until you post them. It starts on GitHub for
  PRs carrying the review tag (`#pr-reviews` by default, configurable in
  settings) and on local everywhere else, and holds while the page is open.
  Replies in threads that are not on GitHub stay local either way. "Make local"
  / "Move to GitHub" switches a comment that has not been sent yet. The heading row has two actions for them, beside Threads:
  **Send N to agent** hands the local comments to a thread running
  `apply-pr-comments` (with the same and-push option), and **Submit review**
  (with the GitHub draft count on it) opens GitHub's "Finish your review"
  box: a "Leave a comment" field, then **Comment / Approve / Request
  changes** (only Comment on your own PR, as on GitHub), then Submit. The
  review needs no drafts: a comment or a verdict alone goes up as a review of
  its own. With drafts, new threads post as one review (inline where a line is
  given, in the review body otherwise, under your comment) and replies post
  into their GitHub threads. An approval also moves the card to Done, since
  your review of it is finished.
- **One pending review, in both places**: with "Stage GitHub drafts in your
  pending review on GitHub" on (the default), a GitHub draft saved here goes
  into your pending review on the PR the moment it is saved (creating the
  review if you have none), edits and deletions follow, "Make local" takes it
  back out, and the review box's comment is the review's summary there. Each
  sync, and whenever the changes page is open, comments pending in that review
  on GitHub come onto the board as drafts labelled "pending on GitHub" (its
  summary fills the review box unless you have edited it here since), so a
  review can be half written in each place. Submit from either: Submit review
  here finishes the pending review on GitHub with any draft GitHub refused
  inline carried in its body; finishing it on GitHub shows the drafts here as
  posted at the next sync. Discarding it on GitHub leaves the words here as
  plain drafts. GitHub owns a mirrored comment, so a text changed in both
  places ends up as GitHub has it. From the diff, `s` lands on the button and
  Enter or `i` opens the box on the comment; in it `j`/`k` (or the arrows)
  pick how the review concludes, `i` returns to the comment, ⌘↩ submits, and
  Escape closes it keeping what you typed (Escape on the button returns to the
  diff). Clicking outside closes it too.
- **Comment threads**: the changes view shows the PR's inline GitHub review
  comments under their lines, threaded with their replies, alongside the
  board's own comments. An open GitHub thread has Resolve (`r`) beside Reply.
  Resolved threads, and threads whose line the latest push changed
  (outdated), leave the diff unless you have an unsent reply in one; the
  summary bar counts them and the Conversation view (`gc`) lists every thread
  under the review it was submitted in, between the PR's summary,
  description, commits, comments, reviews, events and merge status as on
  GitHub's Conversation tab (read with one GraphQL query as the view opens;
  comments posted, edited, deleted or reacted to there go to GitHub at once), each
  over the hunk GitHub stored for it (synced with each comment's original
  lines and review), with Unresolve (`r`) to reopen a resolved one;
  the card panel's PR comments still list them too. Reply in
  any thread, locally or on GitHub (GitHub replies need a thread that is an
  inline GitHub comment, or a GitHub draft that becomes one). Local replies in
  a GitHub thread reach the agent with the whole thread quoted, so "do what
  Bob says, but keep the alias" works. After addressing comments the agent
  answers in each thread with `bb kanban comment-reply`, so its replies (what
  it changed, or why not) sit next to the line. A posted draft shows once, as
  its synced GitHub copy.
- **PR comments**: every sync pulls the PR's conversation comments, inline
  review comments (with replies threaded), and review summaries into the card.
  The sync revisits open PRs; a closed or merged card whose comments were never
  synced (or must be again after an upgrade) syncs once when its comments are
  next listed. A card's syncs run one at a time.
  Each comment has a checkbox for the apply round (suggested: everything others
  wrote that is not yet addressed; approvals, drafts, and your own comments are
  left out) and an "addressed" mark. The card shows how many are still open.
- **Apply N comments**: runs the `apply-pr-comments` skill
  (`~/.claude/skills/apply-pr-comments`) in a fresh worktree on the selected
  comments as given (no triage or confirmation), commits, and marks them
  addressed when the thread reports back.
- **Apply N findings**: spawns a thread (reusing the review's worktree)
  that runs your `apply-review` skill on the selected findings only (deselected
  ones are omitted from the prompt entirely), commits, and pushes
  to the PR head branch. A local review is applied by the card's own thread
  instead: the findings arrive there as a prompt, it commits the fixes on its
  branch without pushing, and the round is recorded the same way. Your
  selection is the triage: the thread applies every selected finding as
  written, without asking or dropping any, and reports the ones it could not
  apply.
  When the round is recorded, every finding it fixed is marked applied: the
  card panel folds it to its struck-through title with an "applied" chip, the
  changes view stops showing it, and later rounds never get it again (a
  finding the thread reports as not applied stays open). The board card's
  badge counts what is still open ("2 findings", with the applied count in
  its tooltip, then "all applied"). The check button on each finding resolves it by hand ("resolved"
  chip; re-reviews leave it be) or reopens it, however it was closed.
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
bb started from the Dock or Finder gets a minimal PATH without Homebrew, so
set the **GitHub CLI binary** setting to the full path (e.g.
`/opt/homebrew/bin/gh`) if the board reports no token.

Optional settings: sync interval, whether to spawn a thread for every new PR
card, a fallback project for PRs whose repository matches no project's git
remote, and whether a card moves to In Progress when its thread starts working.

## Columns

Default columns: `backlog` (Backlog), `todo` (To Do), `in-progress`
(Building), `checking` (Checking), `review` (Needs you), `done` (Done). The
names are for new boards; a board already in use keeps its own, and the first
monitored card adds Checking just before `review` (and puts back an
`in-progress` or `review` column that was removed). Edit them
under Settings → Columns on the page; agents refer to columns by id. New PR cards land in `todo`,
whether you authored them or were asked to review. Sync never moves an open PR
card you placed by hand, except one in Done that comes back to its source after
leaving it.

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
bb kanban show [<ticket-id> | --ticket <id>]
bb kanban add "<title>" [--tag <tag>] [--due <YYYY-MM-DD>] [--description <md>] [--column <id>] [--project <id>] [--start-thread] [--parent <id>] [--monitor|--no-monitor]
bb kanban subtasks [--ticket <id>]
bb kanban set-parent <ticket-id> <parent-id|none>
bb kanban start-subtasks [--ticket <id>] [--sequential]
bb kanban move <column-id> [--ticket <id>]
bb kanban monitor on|off [--ticket <id>] [--gates plan,findings,auto-accept|none]
bb kanban plan --plan-file <path>
bb kanban ready --commit <sha> [--evidence-file <path>] [--screenshot <path>] [--check-command "<cmd>"]
bb kanban checks-record --exit-code <n> [--output-file <path>]
bb kanban review [--ticket <id>] [--project <id>] [--full]
bb kanban review-show [<ticket-id> | --ticket <id>]
bb kanban apply-review [--ticket <id>] [--no-push]
bb kanban comments [--ticket <id>]
bb kanban apply-comments [--ticket <id>] [--no-push]
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
