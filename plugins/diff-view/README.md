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
  panel), structural (difftastic) or text (Pierre) diffs, unified or split,
  wrap toggle, viewed marks, and ⌘-hover and ⌘-click symbol peeks in the
  thread's checkout.
- **Comments**: "+" on a line or "Comment on file", with replies. Drag the "+"
  or the line numbers (or shift-click a second line number) to comment on a
  range of lines, as on GitHub. "Send N to the thread" sends every unsent
  comment to the thread's agent as one message. Hosts whose comments can go to
  GitHub (kanban's PR cards) get a "Comments go to Local / GitHub PR" switch
  above the diff that applies to every new comment and reply.
- **Viewed marks** remember the file's patch; a mark lapses once the file
  changes again.
- **Keyboard**: the whole review runs on vim-style keys, sent to the view that
  last had the pointer or focus, never while typing in a text box. "Changes:
  review with the keyboard" (⌘⇧D by default, rebindable in bb's keyboard
  settings) opens the side panel and gives it the keyboard. A cursor moves
  over lines and file headers: `j`/`k` lines (with counts, `5j`), `h`/`l` old
  or new side, `]c`/`[c` changes, `}`/`{` hunks, `]f`/`[f` files, `c`/`C`
  comment threads, `]d`/`[d` review findings, `gg`/`G`, Ctrl-D/U/F/B, and
  `zz`/`zt`/`zb`. `/` searches file names and `n`/`N` step through the files
  it matched. `i` (or Enter) comments on the cursor's line, or on the file from
  its header; `V` selects lines for a range comment; `O` comments on the file;
  `r`, `e` and `dd` reply to, edit or delete your unsent comment in the thread
  on the line; `t` switches where new comments go; `s` focuses the send bar.
  In a comment box ⌘↩ adds it and Escape returns to the diff (closing the box
  if it is empty; with the vim-mode plugin, Escape twice). `v` marks a file
  viewed and moves on, `za`/`zo`/`zc`/`zR`/`zM` fold threads and files, `zr`
  shows more unchanged lines, `x` selects a review finding, `K` asks for an
  explanation of the hunk, `gd` peeks at a symbol on the line, `gm`/`gl`/`gw`
  switch text or structural, unified or split, and wrap, `R` refreshes, and
  `?` lists every key.

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
