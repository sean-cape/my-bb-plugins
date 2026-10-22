# Diff view

A thread's changes beside its chat, and the same view as a library other
plugins embed.

![Split structural diff with the file tree, summary bar and viewed marks](../../docs/screenshots/diff-view.jpg)

## In bb

- **Changes button** at the right end of every thread's top bar, muted and
  disabled while the thread has no changes. It opens the thread's diff in the
  side panel. "Changes" is also in the side panel's new-tab launcher. The
  plugin adds no page to the left sidebar. On a thread with no changes,
  Cmd-Shift-D shows a toast instead of opening an empty panel. Other plugins
  share the button's change counts through `bb-diff-view/app/use-change-totals`.
- The view: every changed file in one scroll with sticky headers, a resizable
  file tree once the container is at least 48rem wide (hidden in a narrow side
  panel), structural (difftastic) diffs, with a text (Pierre) diff for any file
  difftastic cannot diff, split (the default) or unified for every file (`gl`
  or the summary bar's Split / Unified button, remembered across sessions),
  split as two equal halves at any width with long lines wrapped at spaces
  under their own indentation (never a sideways scroll), viewed marks, and
  ⌘-hover and ⌘-click symbol peeks in the thread's checkout. A structural
  hunk header (`@@`) is left out when the hunk is the whole file.
- **Unified structural**: one code column under old and new line numbers,
  wrapped the same way. An unchanged line shows once with both numbers; in
  each change block the deleted lines come before the added ones, so a
  modified line is a deletion then an addition, as on GitHub, with
  difftastic's token highlights kept. `j`/`k` step through that order and
  `h`/`l` pick the old or new number on an unchanged line; comments (a line
  number, a drag, `i`, `V`), findings, folds, moved-block labels and symbol
  peeks work as in split.
- **Large diffs**: a text file that came without a patch (too large) and that
  difftastic cannot diff shows "Load diff (N lines changed)"; the button, or
  Enter on the file's header, makes its patch from the two sides and shows it
  as a text diff. A binary file says so. When bb's diff of the thread is cut
  at its size limit, the view reads the whole diff from the local checkout
  instead; with no local checkout, a banner above the diff says how many files
  came without their changes (each can still be loaded). A loaded patch is
  kept across a refresh only while the diff's head commit and the file's line
  counts are unchanged, so a working tree's file is loaded again after one.
- **File marks**: with a Nerd Font (see the nerd-font plugin), each file in the
  tree and on its header leads with one muted icon: a diff glyph when it was
  added, deleted, renamed or copied, its file type otherwise. Without one, the
  tree shows git's status letter (A, D, R, C) and the header a status badge.
- **Comments**: "+" on a line, or the comment icon that appears on a file
  header under the pointer or the cursor, with replies. Drag the "+"
  or the line numbers (or shift-click a second line number) to comment on a
  range of lines, as on GitHub. "Send N to the thread" sends every unsent
  comment to the thread's agent as one message. Hosts whose comments can go to
  GitHub (kanban's PR cards) get a "→ Local / → GitHub PR" button above the
  diff (`T`) that applies to every new comment and reply.
  Resolved and outdated threads leave the diff (a resolved or outdated one
  with an unsent reply stays); the summary bar says how many there are, and
  `H` hides every thread from the diff (kept across sessions, and said in the
  summary bar).
- **Suggested changes**: a ```` ```suggestion ```` block in any comment
  (local or GitHub, threads and drafts) shows as a small diff: the commented
  new-side lines as they read today, removed, and the suggestion, added. `I`
  on a line or a `V` selection opens a comment holding those lines in a
  suggestion block with the caret inside it; in any comment box the
  "Suggest" button inserts one for its lines. On a thread whose
  suggestion can still apply (not outdated or resolved, its lines in the
  diff), "Apply suggestion" or `A` applies it now, and "Add to batch" or `B`
  puts it in the batch (outlined, "in batch"); "Commit N suggestions" in the
  summary bar, or `gB`, applies the batch. Hosts with a checkout write its
  files (the diff-view plugin; kanban's thread cards); kanban's PR cards
  commit to the PR branch and resolve the applied threads. A suggestion
  whose lines, or the line just above or below them, changed since is
  refused (nothing in the batch is applied), as is one made at a PR head
  the branch has moved past, a file that isn't UTF-8 text, and a symlink. A
  checkout's files are replaced whole (a temp file renamed over each), one
  apply at a time, and put back if a later one fails. An applied one says
  "applied" and the diff refreshes; a suggestion that drops lines from the
  end of its range keeps reading as unapplied until it is applied from here,
  or, on GitHub, until its lines differ from those it was left on. Comments
  with a suggestion reach the agent with a line saying the block is the
  exact replacement for the lines, and an unclosed block keeps its trailing
  whitespace when the comment is saved. Suggestions also read a file whose
  patch came through "Load diff".
- **Comments view**: a third reading mode beside Files (and Narrative), shown
  once there is a thread, or `gc` (again to return where you were). It lists
  every thread grouped by file in diff order (open, resolved, outdated,
  local and GitHub), each over its code: the commented lines of today's diff
  (with the lines they replaced, or a few either side in a run of only added
  lines, such as a new file), or for an outdated GitHub thread the hunk GitHub stored when it was left; a
  thread with neither sits under its file's name. Chips (or `F` there) filter
  open, resolved, outdated or all. The files view's cursor and thread keys
  work on it (`j`/`k`, `c`, Enter, `a`, `r`, `e`, `dd`, `M`, `gx`, `go`), and
  `gf` (or a file name) opens the files view at the thread's line.
- **Review findings** (hosts with reviews, such as kanban) show as one line
  each under their line: severity, title and the apply-round checkbox. A
  finding opens to its description, fix and scores on click, Enter, or while
  the keyboard cursor is on it. A finding with several locations (instances
  of one bug class) shows at each of them, and its scores line names the
  class and the instance count. The findings chip above the diff, or `F`,
  cycles which show: all, important and up (the default), critical only, or
  none; the chip counts the ones hidden. Findings a host marks pre-existing
  (already in the code before the change) stay out of the diff, and those its
  verifier filtered out are folded under "N filtered"; both are listed above
  the diff, each folded under its count, the pre-existing ones with "Make a
  card" when the host can make cards. A finding's scores (importance, scope
  fit, verifier confidence, bug class) are in its id's tooltip once it is
  open. A finding whose fix is an exact edit (the review report's
  `suggestion`, version 6) shows it under the fix as the same suggestion diff,
  labelled with its file and lines: "Apply suggestion" or `A` applies it now
  and "Add to batch" or `B` batches it, as for a comment's, and applying it
  marks the finding applied (the host's `reviews.setApplied`), so it leaves
  the diff. On a host whose comments can go to GitHub, "Post to PR" or `gs`
  posts it as a draft GitHub comment on its lines: the finding's title and
  description, then the suggestion block (`s` submits the review).
- **Viewed marks** remember the file's patch; a mark lapses once the file
  changes again.
- **Whitespace** changes are hidden by default, as `git diff -w` hides them:
  in text diffs (and the narrative's excerpts), lines that differ only in
  whitespace show as unchanged, with every line number kept, and a hunk with
  nothing else changed is left out unless a comment or finding sits on it. A
  file whose only changes are whitespace says "Only whitespace changed" and
  starts collapsed. The "Whitespace hidden / shown" chip in the summary bar,
  or `W`, switches it, remembered across sessions; with whitespace shown, a
  file difftastic finds unchanged is drawn as a text diff, so its whitespace
  changes show. The summary bar's totals are always the raw counts.
- **Commits**: the summary bar's "Commits: All changes" control, or `gr`,
  opens a picker of All changes, the host's review marks ("Since last
  review"), then every commit, oldest first: `j`/`k` move, Enter (or a click)
  picks one, Space or `x` (or a shift-click) on a commit starts a range and
  Enter on another picks every commit between them (Enter back on the first,
  or across every commit, says it shows one commit or all changes), Escape
  closes. The diff
  then shows only that part of the history and the control names it (`abc1234`,
  "3 commits", a mark). A partial range is for reading: comments and viewed
  marks work only when it ends at the head, and only on new-side lines, where
  existing threads and findings still show; otherwise `i` and `v` say to switch
  back to All changes. The "since you last looked" strip and the narrative wait
  for All changes. A thread's commits come from its local checkout (`git log`
  since the merge base, uncommitted changes as a last "Uncommitted" entry);
  without one there are none.
- **Keyboard**: the whole review runs on vim-style keys, sent to the view that
  last had the pointer or focus, never while typing in a text box. "Changes:
  review with the keyboard" (⌘⇧D by default, rebindable in bb's keyboard
  settings) opens the side panel and gives it the keyboard. A cursor moves
  over lines, file headers and folds of hidden lines (Enter opens a fold: a
  short one whole, a long one 20 lines at a time with the cursor left on it);
  it is drawn from the first key and hidden again by a wheel or a click, so a
  reader on the mouse never sees it. It stays in the middle of the screen (a newly opened diff starts it on the
  first line): the diff scrolls under it as it moves (`zt`/`zb` aside, and short of either end of
  the diff), and scrolling by hand carries it along to the middle line. Keys: `j`/`k` lines (with counts, `5j`; a line with several comments or findings
  is stepped through one at a time), `h`/`l` old
  or new side (`h` past the old side, or on a file header, moves into the file
  list), `]c`/`[c` changes, `}`/`{` hunks, `]f`/`[f` files, `c`/`C`
  comment threads and review findings (one at a time when several share a
  line), `]d`/`[d` findings only, `gg`/`G`, Ctrl-D/U/F/B, and `zz`/`zt`/`zb`.
  `/` searches the diff's text: every file's old and new lines as drawn (with
  whitespace hidden, a whitespace-only change never matches), collapsed,
  viewed and not-yet-scrolled-to files included. It is a regex with smartcase
  (a capital matches case), and the matches on screen highlight as you type,
  in structural and line diffs alike; Enter goes to the first match at or
  after the cursor and Escape drops the search. `n`/`N` move the cursor to
  the next / previous match (a count skips several), opening a collapsed file
  or a fold of unchanged lines to reach it and wrapping past either end, as
  in vim. The box, and the summary bar while matches are highlighted, shows
  "k of N"; Escape in the diff (with nothing else to close) or a click on the
  summary bar's search chip clears the highlights, and `n` brings them back.
  `f` finds a file by name and jumps to it.
  `i` comments on the cursor's line, or on the file from its header; `V`
  selects lines for a range comment; `O` comments on the file. Enter on the
  header of a file shown as "Load diff" loads its diff. The comment or
  finding under the cursor is outlined and lists the keys it takes: Enter (or
  `za`) opens or closes it, `a` replies to a thread, `r` resolves or reopens
  a GitHub thread, `e` edits your unsent comment or a finding's wording, `dd` deletes your unsent comment, `x`
  includes or excludes a finding in the apply round, `M` moves a comment
  between local and the GitHub PR, and `gx`/`go` open a thread on GitHub or
  the agent thread that replied. `T` switches where new comments go; `s`
  focuses the send bar (on kanban's PR cards, the Submit review button: Enter
  or `i` opens GitHub's review box, where `j`/`k` pick Comment, Approve or
  Request changes, `i` goes to the comment, ⌘↩ submits and Escape closes it;
  Escape on the button returns to the diff). In a comment box or an edit ⌘↩ saves; Escape returns
  to the diff, keeping a new comment's or reply's draft (an empty one closes)
  and cancelling an edit of a comment or finding (with the vim-mode plugin,
  Escape twice). `v` marks a file viewed and moves on,
  `zo`/`zc`/`zR`/`zM` fold files (`za` too on a line with nothing under it),
  `zr` shows more unchanged lines, `F` cycles which review findings show,
  `gF` folds or unfolds the filtered findings, `gp` moves the keyboard into
  the pre-existing and filtered list above the diff (`j`/`k` move, Enter
  opens one or makes a card, Escape returns),
  `K` asks for an explanation of the hunk, `S` switches to the narrative
  review where the host has one (see below),
  `gd` peeks at a symbol on the line (Escape closes it), `gl` switches every file between
  split and unified, `W` hides or shows whitespace changes, `R` refreshes,
  `gc` opens the comments view (see above), `H` hides or shows the threads in
  the diff, `I` suggests a change to the line or selection, `A` applies the
  suggestion in the thread or review finding under the cursor, `B` adds it to
  the batch (or takes it out) and `gB` applies the batch (see Suggested
  changes), `gs` posts a finding's suggestion to the PR as a draft (see
  Review findings), and
  `?` lists every key (`/` in that list searches it). `gr` picks the commits shown (see Commits above).
  `yp` copies the file's path and `yl` a link to the line or the `V`
  selection: a GitHub permalink at the head (the base for old-side lines)
  where the repository and commit are known, as on a PR, else
  `path:L10-14`. `gO` opens the file at the line in bb's file preview for a
  checkout, else on GitHub. `gb` shows who last changed the line or
  selection, beside that side of the line, one row per commit (short sha,
  author, age, summary): `j`/`k`
  move, Enter opens the commit on GitHub, Escape closes. A thread's blame
  reads its checkout at the commits the diff compares: with commits picked
  (`gr`), the range's end for new lines and its start for old; else the
  working tree for new lines and the merge base for old.
  Each file header's "…" menu does the same by mouse for the whole file
  (Copy path, Copy link, Open file, and Blame of its first hunk).
  `t` shows or hides the file list. In it, `j`/`k` move (a count repeats),
  `h`/`l` close and open folders (`h` on a file goes to its folder), `gg`/`G`
  and Ctrl-D/U jump, Enter, `o` or `l` jumps to the file with the cursor on its
  header, and Escape returns to the diff. `?`, `/` and `t` keep working there;
  the help, search, refresh, layout, whitespace and file-list keys work before a diff has
  loaded.
  `gf` (or the funnel on the file list's header) opens "Filter files", as on
  GitHub: a tick per file extension present (with counts; "No extension" for
  Makefiles and dotfiles), per change type (added, modified, renamed,
  deleted), "Hide viewed files", "Only files with comments" (any thread,
  resolved and outdated too), "Only files with findings" (where the view has
  findings) and "Clear filters"; `j`/`k` move, Space or Enter ticks, Escape
  closes. Filtered files leave the file list, the scroll, the cursor's motions
  (`]f`/`[f`, `j`/`k` past a file, `gg`/`G`), `f` and `/`; the summary bar
  says "Showing 12 of 40 files" (a click clears the filter). Going to a
  filtered file from elsewhere (the delta strip, the narrative, the comments
  view) clears the filter. Each view keeps its filter for the session.

- **Narrative review** (hosts whose source serves a story, such as kanban): a
  **Files | Narrative** switch (with Comments once there is a thread) at the
  left of the summary bar, or `S`, swaps
  the file list for the agent's walk through the change. Each page is one
  step: its explanation over just the lines it covers, as excerpts of the
  diff drawn by the same renderer as the files view, so the cursor, comments
  (`i`, `V`, `O`, `a`, `e`, `dd`, `M`), review findings (`x`, `]d`, `c`),
  viewed marks (`v`), the layout key and the send bar work on them exactly
  as there; `j` and `k` read the step's prose on when there is no code line
  to move onto, and past the step's end turn to the next step (or back to
  the end of the one before). The summary bar shows the step reached. Each
  chapter opens on a summary page with the agent's reading order (click a
  file to open it in the files view), its watch-outs and its steps; the
  outline beside the steps (wide views, `t`) ticks the steps read, and ←
  past the old side moves into it (`j`/`k`, Enter, Escape). Keys of its own:
  `h`/`l` previous / next page (a count repeats; the arrow keys keep the
  old / new side, and ← past the old side goes to the outline), `]]`/`[[`
  chapters, `]f`/`[f`
  excerpts, `gf` opens the files view at the cursor's line (an excerpt's
  header too), `ga` follows a revision step to the step it led to, `gv`
  marks viewed the files every one of whose steps has been read, `/` and
  `n`/`N` search steps, `f` finds a file by name and opens it in the files
  view, `gl` switches the excerpts between split (the
  default) and unified, `U` writes a narrative (or an update once the code
  moved, which the switch flags with a dot), `S` returns to the files with
  the cursor where it was. Steps of an earlier narrative or a revision show
  their lines without comments, since those are not today's lines; comment
  from the current narrative's steps or the files view. Excerpts are line
  diffs, so `gd` and `zr` do nothing there.

Settings: hide vendored files (default on) and the `difft` path. Comments and
viewed marks live in this plugin's database and are deleted with their thread.

## As a library

`lib/` is a separate package, `bb-diff-view`, that another plugin adds as a
dependency:

```json
"dependencies": { "bb-diff-view": "file:../diff-view/lib" },
"pnpm": { "overrides": { "bb-diff-view": "link:../diff-view/lib" } }
```

- `bb-diff-view/app/diff-view`: `DiffView`, plus `DiffRefreshButton` for a
  toolbar outside the view; `toolbar` may be a
  function of the comments waiting to be sent, for a host that puts its send
  controls in its own heading row (kanban does). The host passes a
  `DiffSource` with the core methods (diff, structural diff, symbols, file
  slices, viewed marks, comments) and any optional groups (GitHub comments and
  drafts, review findings, the delta since the last look, a tour, hunk
  explanations); each optional group turns on its part of the UI. A tour
  group with `story()` adds the narrative review and its switch (`S`).
  `loadPatch(path)` adds "Load diff" to files that came without a patch.
  `commits()` adds the commit picker (`gr`); `getDiff`, `getStructural` and
  `loadPatch` then take a `CommitRange { from, to }` (`from` exclusive, `to`
  possibly `WORKTREE`). A new source object starts the view afresh (the commit
  range, loaded patches and suggestion batch were picked over the old one), so
  memoize it.
  `DiffResult.truncatedNote` is the banner's text for a truncated diff, and
  `DiffFile.binary` labels a file as binary. `suggestions.apply(items,
  message)` lights up `A`, `B` and `gB`: each `SuggestionItem` carries the
  lines it expects, the lines just around them (`before`, `after`) and, on a
  PR diff, the `headSha` it was read at, and the host refuses the call when
  any moved; `message` is for a host that commits (null for its default). A finding's
  item has the id `finding:<reviewId>/<findingId>`; after it applies, the view
  calls `reviews.setApplied(reviewId, findingId, true)` when the source has it.
- `bb-diff-view/suggestions`: finding suggestion blocks in a comment body,
  writing one, the new-side lines a patch shows, and applying items to a
  file's text with the expected-line check. `SuggestionDiff`
  (`bb-diff-view/app/suggestions/suggestion-diff`) draws one.
- `bb-diff-view/narrative`: changed-line coverage of a narrative's steps and
  the excerpt patch for a step's lines, shared by servers that check an
  agent's narrative and the view that renders it.
- `bb-diff-view/app/icons`: call `registerDiffViewIcons(app)` in
  `definePluginApp`.
- `bb-diff-view/server`: unified-diff parsing, an environment's diff (read
  from the local checkout when bb's is truncated, with its checkout's GitHub
  repository) and file sides, `patchFromSides` (a file's patch from its two
  sides, for `loadPatch`), difftastic, `git grep` symbol search,
  `git blame`, and `applySuggestionsInCheckout`. A source with `blame` lights up `gb`; a diff's `repo` and shas
  make `yl` links GitHub permalinks, and `blameRev` names the revision either
  side of a diff or range is blamed at. For commit ranges: `environmentCommits`
  (which finds the merge base itself when not given it),
  `environmentRangeDiff` and `environmentRangeFileSides` (local git),
  `checkedRange` (only shas reach git), and `createExpiringCache`, which the
  plugin uses so one view's per-file calls share one diff read for 15 seconds
  (never for a range ending at the working tree).
- `bb-diff-view/types`: the data shapes.
