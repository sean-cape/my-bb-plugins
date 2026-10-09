# Diff view

A thread's changes beside its chat, and the same view as a library other
plugins embed.

## In bb

- **Changes button** at the right end of every thread's top bar, muted and
  disabled while the thread has no changes. It opens the thread's diff in the
  side panel. "Changes" is also in the side panel's new-tab launcher. The
  plugin adds no page to the left sidebar.
- The view: every changed file in one scroll with sticky headers, a resizable
  file tree once the container is at least 48rem wide (hidden in a narrow side
  panel), structural (difftastic) diffs, with a text (Pierre) diff for any file
  difftastic cannot diff (`gl` switches those between split, the default, and
  unified), long lines always wrapped, viewed marks, and ⌘-hover and ⌘-click symbol peeks in the
  thread's checkout.
- **Comments**: "+" on a line, or the comment icon that appears on a file
  header under the pointer or the cursor, with replies. Drag the "+"
  or the line numbers (or shift-click a second line number) to comment on a
  range of lines, as on GitHub. "Send N to the thread" sends every unsent
  comment to the thread's agent as one message. Hosts whose comments can go to
  GitHub (kanban's PR cards) get a "Comments go to Local / GitHub PR" switch
  above the diff that applies to every new comment and reply.
- **Review findings** (hosts with reviews, such as kanban) show as one line
  each under their line: severity, title and the apply-round checkbox. A
  finding opens to its description, fix and scores on click, Enter, or while
  the keyboard cursor is on it. The findings chip above the diff, or `F`,
  cycles which show: all, important and up (the default), critical only, or
  none; the chip counts the ones hidden.
- **Viewed marks** remember the file's patch; a mark lapses once the file
  changes again.
- **Keyboard**: the whole review runs on vim-style keys, sent to the view that
  last had the pointer or focus, never while typing in a text box. "Changes:
  review with the keyboard" (⌘⇧D by default, rebindable in bb's keyboard
  settings) opens the side panel and gives it the keyboard. A cursor moves
  over lines, file headers and folds of hidden lines (Enter opens a fold: a
  short one whole, a long one 20 lines at a time with the cursor left on it)
  and stays in the middle of the screen (a newly opened diff starts it on the
  first line): the diff scrolls under it as it moves (`zt`/`zb` aside, and short of either end of
  the diff), and scrolling by hand carries it along to the middle line. Keys: `j`/`k` lines (with counts, `5j`; a line with several comments or findings
  is stepped through one at a time), `h`/`l` old
  or new side (`h` past the old side, or on a file header, moves into the file
  list), `]c`/`[c` changes, `}`/`{` hunks, `]f`/`[f` files, `c`/`C`
  comment threads and review findings (one at a time when several share a
  line), `]d`/`[d` findings only, `gg`/`G`, Ctrl-D/U/F/B, and `zz`/`zt`/`zb`.
  `/` searches file names and `n`/`N` step through the files it matched.
  `i` comments on the cursor's line, or on the file from its header; `V`
  selects lines for a range comment; `O` comments on the file. The comment or
  finding under the cursor is outlined and lists the keys it takes: Enter (or
  `za`) opens or closes it, `a` replies to a thread, `e` edits your unsent
  comment or a finding's wording, `dd` deletes your unsent comment, `x`
  includes or excludes a finding in the apply round, `M` moves a comment
  between local and the GitHub PR, and `gx`/`go` open a thread on GitHub or
  the agent thread that replied. `T` switches where new comments go; `s`
  focuses the send bar (on kanban's GitHub drafts, the review-type picker:
  `h`/`l` pick Comment, Approve or Request changes, Enter posts, Escape
  returns to the diff). In a comment box or an edit ⌘↩ saves; Escape returns
  to the diff, keeping a new comment's or reply's draft (an empty one closes)
  and cancelling an edit of a comment or finding (with the vim-mode plugin,
  Escape twice). `v` marks a file viewed and moves on,
  `zo`/`zc`/`zR`/`zM` fold files (`za` too on a line with nothing under it),
  `zr` shows more unchanged lines, `F` cycles which review findings show,
  `K` asks for an explanation of the hunk,
  `gd` peeks at a symbol on the line, `gl` switches line-diff files between
  split and unified, `R` refreshes, and
  `?` lists every key.
  `t` shows or hides the file list. In it, `j`/`k` move, `h`/`l` close and
  open folders (`h` on a file goes to its folder), `gg`/`G` and Ctrl-D/U jump,
  Enter or `l` jumps to the file with the cursor on its header, and Escape
  returns to the diff.

Settings: hide vendored files (default on) and the `difft` path. Comments and
viewed marks live in this plugin's database and are deleted with their thread.

## As a library

`lib/` is a separate package, `bb-diff-view`, that another plugin adds as a
dependency:

```json
"dependencies": { "bb-diff-view": "file:../diff-view/lib" },
"pnpm": { "overrides": { "bb-diff-view": "link:../diff-view/lib" } }
```

- `bb-diff-view/app/diff-view`: `DiffView`, plus `DiffDisplayControls` and
  `DiffRefreshButton` for a toolbar outside the view. The host passes a
  `DiffSource` with the core methods (diff, structural diff, symbols, file
  slices, viewed marks, comments) and any optional groups (GitHub comments and
  drafts, review findings, the delta since the last look, a tour, hunk
  explanations); each optional group turns on its part of the UI.
- `bb-diff-view/app/icons`: call `registerDiffViewIcons(app)` in
  `definePluginApp`.
- `bb-diff-view/server`: unified-diff parsing, an environment's diff and file
  sides, difftastic, and `git grep` symbol search.
- `bb-diff-view/types`: the data shapes.
