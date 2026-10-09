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
  wrap toggle, viewed marks, ⌘-hover and ⌘-click symbol peeks in the thread's
  checkout, and `j`/`k`, `n`/`p`, `c`/`C`, `v` keys.
- **Comments**: "+" on a line or "Comment on file", with replies. Drag the "+"
  or the line numbers (or shift-click a second line number) to comment on a
  range of lines, as on GitHub. "Send N to the thread" sends every unsent
  comment to the thread's agent as one message. Hosts whose comments can go to
  GitHub (kanban's PR cards) get a "Comments go to Local / GitHub PR" switch
  above the diff that applies to every new comment and reply.
- **Viewed marks** remember the file's patch; a mark lapses once the file
  changes again.

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
