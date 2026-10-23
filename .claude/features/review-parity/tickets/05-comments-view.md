# 05 — Comments view; declutter inline threads

> Superseded on 2026-10-23: the Comments view below read as the files view again. It is now a **Conversation** view
> shaped like GitHub's Conversation tab (spec decision 5): description, commits, comments and reviews in time order,
> each GitHub thread under its review over its stored hunk. Kanban stores each inline comment's review
> (`pull_request_review_id`) and serves the PR's description, reviews and events through `pr_conversation`.

**What to build:**
- A third reading mode, **Comments**, in the summary bar's mode switch (Files | Narrative | Comments; Comments shows
  whenever the source has any thread). `gc` toggles it from Files or Narrative and returns to where you were.
- It lists every thread grouped by file in diff order: open, resolved, outdated, local (sent and unsent) and GitHub,
  each over its code: the commented lines from the current diff, drawn with the same renderer as the narrative's
  excerpts (`narrative/step-excerpts.tsx`, `lib/narrative.ts` `excerptPatch`), or for an outdated GitHub thread the
  `diff_hunk` GitHub stored, as a small read-only patch. Filter chips Open / Resolved / Outdated / All (a key of your
  choice inside the view, e.g. `F` there, listed in its help). j/k move over the threads' lines and stop at each
  thread as in the files view; Enter/za fold, `a`, `r`, `e`, `dd`, `M`, `gx`, `go` act as in the files view; `gf`
  opens the files view at the thread's line.
- Inline (files and narrative views): resolved and outdated threads no longer render; file headers count open threads
  only; the summary bar shows "N resolved · M outdated" (click or `gc` opens the Comments view). `H` hides/shows all
  threads inline (persisted preference), with the summary bar saying they are hidden.
- Kanban: `GithubComment` gains `diffHunk: string | null`, `originalLine: number | null`,
  `originalStartLine: number | null` (GitHub API `diff_hunk`, `original_line`, `original_start_line`), stored at sync
  (a kanban migration) and returned by `comments_list`. The diff-view plugin has no GitHub threads. Existing rows have no hunk until the next sync: sync must
  refresh `diff_hunk`/original lines on existing rows too, and the Comments view must still list a thread that has no
  code context (just without the excerpt).

Spec: decision 5.

**Blocked by:** None — can start immediately

**Status:** done

- [x] Comments mode with grouping, code context (current lines or diff_hunk), filter chips, keys
- [x] Resolved/outdated threads gone from inline; counts and summary-bar hint; `H` toggle
- [x] Kanban stores and returns diff_hunk/original lines (migration + sync + contract)
- [x] Pure thread grouping/filtering tested in a new test file
- [x] KEY_HELP (and the comments view's own help) and READMEs updated
