# Workflows: how the plugins are used end to end, and the re-orientation

This is the plan for the four flows these plugins exist for: the daily review,
tasks on the kanban board, being asked to review a pull request on GitHub, and
the pull requests you author. Each section says what happens today, with the
evidence, then what the flow should be, what it drops, and the keys. The
removals are listed first so they can be vetoed in one place.

## Removals and defaults that change

| What | Today | Change | Evidence |
| --- | --- | --- | --- |
| Daily digest automation and its collector script | Two automations at 06:30 and 06:45 write yesterday's summary; the collector has timed out on every run since Oct 25 and is paused | Left paused; the morning routine writes yesterday's summary itself. Delete them with `bb automation delete` once a morning run has written a Day summary | 5 of 5 recent collector runs timed out; the digest thread then spent over an hour improvising |
| "Daily note — wrap" automation at 21:00 | Paused after three failures; last success Oct 13 | Left paused; Wrap up stays on demand (Vault home, palette, `bb obsidian wrap`) | 8 runs ever, 0 in the last three weeks |
| Interactive morning routine | `start` asks the user to plan the day, but runs unattended at 07:00 | The scheduled run is unattended and ends with one question; the conversation happens when you open it | Every automated run ended with a summary nobody answered |
| A thread for every new PR card (`autoStartThreads` default on) | Each new PR card spawns a thread that runs a status check and waits | Off by default. Review requests get a thread whose first message is the review brief; authored PRs link to the thread that made the branch, else `t` starts one on demand | 9 of 13 authored-PR threads have exactly one user turn (the prompt); 2 of 5 review-request threads too |
| The ad hoc "review it yourself" prompt on review-request threads | The card thread is told to run its own review of the PR, while the source also runs the code-review skill and the narrative | The thread waits for the board's review and summarizes it instead of reviewing again | Three agents read each new review request today |
| `review` column meaning both "In Review" and the loop's "Needs you" | A PR card's thread moved a PR awaiting other people's review into the loop's Needs you column | Authored PRs awaiting review go to `waiting`; `review` is Needs you only | The live board has one PR awaiting reviewers and one agent hand-off side by side in `review` |
| Review loop controls in every agent card | Gates, strip, menu and brief render for every agent card | Folded behind the loop switch until the loop is on | The loop is on for 1 of 29 live cards |
| Jira source | Settings, sync code, Jira card fields | Kept, not shown in the New source type picker unless the Jira settings are filled | No Jira source configured; the daily routine reads Jira through the connector instead |

Not removed on this evidence: anything in the diff view. Its features landed
Oct 21 to 23 and the activity log is thirteen days old, so low counts mean
young, not unused. Its keys are used through the kanban changes page, where
they count as kanban's (`S` 23, `F` 22, `c` 14, `i` 14, `/` 17 presses).

## Evidence

- The activity log (`bb activity`) started on Oct 21, so "30d" is thirteen
  days, three of them out of office. Counts are directions, not verdicts.
- The live board: 29 cards. 19 PR cards from the two GitHub sources (your open
  PRs and review requests), 6 plain to-dos, 3 ad hoc agent cards, 1 card with
  the review loop ever on. 8 cards have a stored code review.
- Threads: 234 in the list. The vault project holds a "Daily note — start" and
  a "Daily digest" thread per weekday; the rest are card threads and feature
  work.
- Routes in the window: thread pages 260, the board 157, the board's sub-pages
  (card changes, todo) 111, home 97, activity 53, vault 59.
- Keys on the board: `j` 545, `k` 243, `l` 157, Ctrl-D 128, `h` 61, Enter 27,
  `?` 18, `/` 17. Cards are opened half by mouse, half by key (37/36).
- Controls only ever clicked, never keyed: findings severity headers in the
  card panel (Important 39, Minor 9), the narrative's "How to read the change"
  (12), the review loop switch (7), "Changes since the last review" (7),
  "Findings outside the diff" (6), "Nest under…" (6), the Board/Todo view
  toggle (5 each), the Sources dialog (4), "Enter or za" fold button in the
  diff (6).
- The thread picker (double Shift) is the most used surface after the board:
  `j` 489, `k` 299, `l` 167, Enter 129, `n` 45, `d` 43, `r` 35. The rail's
  "N threads need you" indicator is clicked 30 times, always by mouse.

## Flow 1: the daily review

### Today

Four automations in the vault project, all paused: a collector script at
06:30 writing a JSON of yesterday's activity (times out every run), a digest
agent at 06:45 that reads it and writes "Day summary" into yesterday's note
and "Yesterday" into today's, the `/daily-note start` agent at 07:00 on
weekdays, and `/daily-note wrap` at 21:00. The Vault home has Start day and
Wrap up buttons (never pressed in the window) and the same commands in the
palette.

The `daily-note` skill never loads in these threads. Every automated run says
so in its own words ("there's no daily-note skill installed, so I built the
note by hand") and improvises from the template. The skill's frontmatter
carries `disable-model-invocation: true`, which hides it from the agent, and
bb sends `/daily-note start` as prompt text, not as a slash command. The skill
itself is written for a conversation: `start` asks what you plan to work on and
agrees subtask cards with you, which an unattended 07:00 run cannot do.

Two threads a day write "Yesterday" (the digest and the start), the collector
duplicates `bb obsidian activity`, `bb obsidian calendar` and `bb kanban list`,
and the 10/30 failures were a Claude Code sign-in error, not the plugins.

### Target

One routine thread a day, `Daily start`, at 07:00 on weekdays, fully
unattended, that:

1. Writes yesterday's `## Day summary` (what the digest wrote), from bb thread
   activity, local commits, GitHub, the calendar and the board, with ticket
   note log lines, and a short `## Yesterday` into today's note.
2. Prepares today's note: meetings from the calendar (linking notes that
   exist), carry-forward from the last note re-checked against the board and
   GitHub, open PRs and review requests, and a **proposed** Plan as unchecked
   items, each pointing at its card (`[kb:: id]`) or saying it has none.
3. Ends with one message: the brief (what carried over, what is waiting on
   you, the proposed plan) and one question: adjust the plan, or accept it.
   This is the turn that needs you, so the thread is left unread.

When you open the thread, the conversation is the planning the skill already
describes: accept, reorder, split into subtask cards, start cards. Nothing is
created on the board until you say so. The `log` and `wrap` modes stay as they
are and run only when you ask (Vault home buttons, palette, `bb obsidian`).
The digest, collector and wrap automations stay paused until a morning run has
written a Day summary, then go.

The skill is made loadable: `disable-model-invocation` goes, and the routine
prompt names the skill rather than relying on a slash command. The skill
splits its `start` mode into the unattended pass and the conversation that
follows. The Start day button runs the same pass on a day the schedule missed.

Landed Nov 3: the plugin's routine prompt (`plugins/obsidian/server/routines.ts`)
and the skill, edited in place where it lives outside this repository (it
holds work-specific names). The morning automation's prompt and its resume are
the user's to run (the commands are in the thread's final report); the next
scheduled run, or Start day, is the first live test.

### Keys

The Vault home already walks its buttons and lists with `j`/`k`; the morning
thread is a bb thread, so bb's own composer keys apply. `gt` (today's note)
and `gc` (calendar) stay. No new keys.

## Flow 2: tasks on the board

### Today

The board is the to-do list (Todoist was dropped for it). A card is one of:
a plain to-do (no project, no thread), an agent card (a thread works it), a
monitored card (the review loop drives it), a PR card from a source, or a
subtask. The card panel shows, in order: a header with the title, meta line
and icon buttons for the thread and the changes; the loop's handoff brief and
plan approval when the loop has stopped; for a PR card the code review, PR
comments and PR description; the properties (Column, Priority, Tags, Due,
Snooze, Parent, Thread row with project and How it runs); the Review loop
section with three gates; Subtasks; Description. The Todo view lists cards by
date or column with quick-add markers.

What works: board motion (`j`/`k`/`h`/`l`, Ctrl-D/U, `gg`/`G`), opening a
card and walking it with `j`/`k`, `T` to the Todo view, `?`. What is awkward:

- Starting agent work on a card is a row with a project picker, a three-way
  control and a Start button; from the keys it is five stops.
- The loop section and its gates sit in every agent card though one card has
  used them. The brief panel and loop menu only matter at Needs you.
- The review panel's severity headers are collapsible by mouse only; the
  `j`/`k` cursor skips them.
- `review` is both "In Review" (where PR threads move authored PRs) and the
  loop's Needs you.
- "Nest under…" and the Board/Todo toggle are mouse-only.
- Sources, columns and keyboard shortcuts are in one Settings cog; the Todo
  view's date grouping and the board's columns both say where a card is.

### Target

A card answers one question at a time: who has it (you, an agent, the board,
someone else), and what is the next thing to press.

Columns, in this order, by who holds the ball: **To Do** (you), **Doing** (an
agent or you), **Checking** (the board; shown only while a monitored card is
in it or the loop is on anywhere), **Needs you** (`review`: a hand-off from an
agent or the loop, or a review someone asked of you), **Waiting** (someone
else: a PR awaiting reviewers, a blocked card), **Done**. The live board gets
`waiting` added after `review`. Sync places PR cards by state (see Flows 3
and 4); you can still drag.

The card panel, in this order: header (title, meta, thread and changes
buttons); **what needs you** (the loop brief, or the review's open findings,
or new PR comments, whichever applies, and nothing when nothing does); the
**Run** row: one line that says how the card runs ("Plain to-do", "Thread in
project X", "Review loop: checks, review, auto-accept") with one button, Run,
Open thread or Loop…; properties; description; subtasks; the review and PR
comments for PR cards. The loop section renders only when the loop is on or
Loop… is opened; its gates live in that dialog.

Keys on an open card: `j`/`k` walk every stop including section headers
(Enter folds or unfolds them), `t` opens the thread or, on a card with none,
starts one in the card's project (the project guess is already there) and
opens it; `D` the changes; `m` the loop menu; `x` done (as in the Todo view);
`p1`..`p4`, `zs`/`zw` as on the board; `N` nest under a parent (a picker,
`j`/`k`/Enter); `i` the description. On the board `T` stays for the Todo
view and `gT` toggles the grouping there.

Landed Nov 3: `t` on a card without a thread starts one in the picked or
guessed project and opens it. Checked and left as they are: the loop section
already starts folded while the loop is off, the review panel's finding rows
are buttons the card's `j`/`k` reach, and "How to read the change" is the
diff's Files / Narrative / Conversation switch, which `S` cycles. Still to do:
the what-needs-you lead section, the one-line Run row, `x` and `N` on an open
card, `gs` and `gT` on the board.

## Flow 3: a review requested of you on GitHub

### Today

The `#pr-reviews` source runs every five minutes. A new review request makes a
card in To Do, sets a Standard code review and a narrative on it, and spawns a
thread in the repository's project whose prompt is to read the PR and "review
it for correctness, edge cases, and anything risky", then stop. So three
agents read the PR at once: the thread's own ad hoc review, the code-review
skill (one reviewer, one verifier), and the narrative writer. Each of those
worker threads ends with a message; until Oct 23 they were children of the
card thread, so their reports landed in it as user messages and the card
thread answered each one (one review-request thread holds eleven such
messages and a verifier's "V22 confirmed at 90, waiting on V18" interim
reports). The narrative ran twice on one PR, once from the source and once
from "Write narrative".

What the review-request threads show you actually do: ask the card thread
questions about the PR (eight to fifteen turns on three of five), such as
whether a lock ordering is necessary or a cancellation pattern is right, and
validate it against a document. The card's changes page is where the review
itself happens: findings inline, comments as GitHub drafts (default for the
review tag), `s` to submit with a verdict; approving moves the card to Done.

### Target

1. **Arrival.** The card lands in **Needs you** with the review tag; the board
   runs one code review at the source's depth and, if the source says so, one
   narrative. No ad hoc review. No thread yet.
2. **Brief.** When the review (and narrative, when asked for) completes, the
   board spawns the card's thread with a prompt that hands it the review's
   findings by severity, the narrative's reading order and watch-outs, the
   PR's description and the comments so far, and asks for one message: a brief
   of what to look at and in what order, then wait. That message is what lands
   in Unread, one item per review request, and the thread is the one you ask
   questions in. Worker threads stay owned, not children (already so), so
   nothing else is posted into it.
3. **Reading.** Enter or `D` on the card opens the changes page at the
   reading plan when there is a narrative, else at the files, with findings
   inline and new-since-your-last-review marked. The card panel's lead section
   is the open findings count and a Review changes button; the severity
   headers take Enter.
4. **Writing.** `i` comments (GitHub drafts), `s` submits with Comment,
   Approve or Request changes. Approve or Request changes moves the card to
   Done (approve) or Waiting (changes requested, until the PR comes back to
   the search, which returns it to Needs you).
5. **Follow-up.** A re-requested review brings the card back to Needs you,
   runs the re-review of what is new, and the thread gets one new brief
   message.

The source's "Narrate new PRs" stays a source option; the narrative runs once
per head, and "Write narrative" on a card with one running says so.

A review-request source with no review depth set produces no thread and so
nothing in Unread: the card in Needs you and the morning brief are the
signal. Set a depth on the source to get the brief thread.

Landed Nov 3: steps 1 to 5 (no thread at arrival by default, the brief
thread after the review and narrative, re-reviews as updates into it, the
card's instructions and footer both say never to move it, its activity no
longer calls it in progress, arrival in Needs you, a change request moves it
to Waiting, approval to Done) and Flow 4 in full (a PR from a bb thread's
branch links that thread; open PRs in Waiting, drafts in Doing, failing checks
or others' comments in Needs you while the card sits where sync put it; a
Waiting column added to boards that lack it). A review that fails still gives
the card a thread, which says so and reads the PR itself.

## Flow 4: the pull requests you author

### Today

The `#my-prs` source makes a card per open PR and spawns a thread that runs
`gh pr view`, reports CI and review state, and waits. The card already carries
the PR state, CI checks and comment counts from sync, so nine of thirteen such
threads never got a second message. The threads that did get used applied
review findings and pushed, or chased a bug the review found. A PR made from a
bb thread's branch joins that thread's card only when the thread already had a
card; otherwise a second thread appears beside the one that wrote the code.

### Target

1. **Arrival.** A PR whose head branch ends in a thread id joins that thread:
   if the thread has a card, the PR attaches to it (as now); if not, the PR
   card links that thread, so the thread that wrote the code is the card's
   thread. Other PRs get no thread; `t` starts one on demand with the current
   PR status prompt.
2. **Placement.** Sync places an authored PR card by state unless you moved
   it by hand since the last state change: open and awaiting review →
   **Waiting**; changes requested, failing checks or new comments from others
   → **Needs you**; draft → **Doing**; merged or closed → Done.
3. **Comments.** The card's lead section lists open comments from others with
   the Apply N comments button; `D` shows them inline; a reply or an apply
   round is the usual path.
4. **Review of your own change.** Review the commits (local) or Review PR
   stays on the card panel for when you want the skill's pass before asking
   others.

## Cross-cutting

- **Notifications.** A thread reaches Unread only when it needs you: the
  morning brief, a review-request brief, a loop stop, a card thread's
  question. Worker threads stay hidden; their reports never post into card
  threads (already the case for owned workers).
- **Keys for mouse-only controls.** Severity headers and the brief's groups:
  Enter on the header. Board/Todo: `T` (exists). Review loop switch: `m`
  (exists) plus the Loop… dialog. "Nest under…": `N`. Sources: `gs` from the
  board opens Settings → Sources. "How to read the change": the narrative's
  summary page rows take `j`/`k`/Enter (they are rows already; the cursor
  needs to reach them). "Changes since the last review" and "Findings outside
  the diff": `gp` reaches that list (exists); the strip's toggle takes Enter.
- **Tests** assert `keymapConflicts` and `unboundHelpKeys` on every keymap
  touched, as the repo requires.

## Order of work

1. Daily review: make the skill load, make `start` unattended with one
   question, fold the digest in, delete the three automations, re-enable the
   morning one. (Flow 1)
2. Review requests: drop the ad hoc review prompt, no thread at arrival, brief
   thread after the review, Needs you placement, narrative once per head.
   (Flow 3)
3. Authored PRs: link to the authoring thread, `autoStartThreads` off by
   default, state-driven placement, `waiting` column on existing boards.
   (Flow 4)
4. Card panel: what-needs-you section, Run row, loop folded, keys for the
   headers, `t` starts a thread, `N` nests. (Flow 2)
5. Board: column order and names, `gs`, `gT`. (Flow 2)

## Open questions

- Should changes requested on your PR move it to Needs you, or stay in
  Waiting with a badge? The plan says Needs you: a request for changes is
  work for you.
- The morning run writes yesterday's Day summary too. If you want yesterday's
  summary earlier than 07:00, say so; the plan removes the separate digest.
- The Jira source stays in the code but leaves the picker when unconfigured.
  Say if it should go entirely.
