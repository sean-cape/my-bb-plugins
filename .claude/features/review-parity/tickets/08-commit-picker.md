# 08 — Commit picker and "since last review"

**What to build:**
- `DiffSource.commits(): Promise<{ commits: DiffCommit[]; marks: Array<{ sha: string; label: string }> }>` with
  `DiffCommit { sha, summary, author, date }` oldest first. `getDiff(refresh, range)`, `getStructural(path, range)`,
  `loadPatch(path, range)` and `blame(…, range)` take a `CommitRange { from: string; to: string } | null` (`from`
  exclusive; null = all changes).
- Summary bar: a "Commits" control naming the current selection (All changes / `abc1234` / 3 commits / Since last
  review). `gr` opens a picker (bb-vim-keys picker/menu pieces): rows All changes, then each mark, then each commit;
  j/k move, Enter picks one row, Space/`x` marks a range start and Enter on another commit picks the contiguous range;
  Escape closes. Mouse: click, shift-click for a range.
- Partial range: the diff shows only that range. Comments (new ones) and viewed marks work only when `to` is the head
  and only on the new side; existing threads and findings show only on new-side lines when `to` is the head;
  otherwise `i` notifies "Switch to All changes to comment" and `v` "Switch to All changes to mark files viewed"; at
  the head, `i` on an old-side line notifies "In a range, comments go on the new side; switch to All changes to
  comment on old lines". The delta strip is hidden.
- Kanban PR: commits from `/pulls/{n}/commits`; range files from `/compare/{from}...{to}`; file sides at from/to;
  marks: "Since last review" (the card's latest stored review's reviewed commit, if it's in the PR) and "Since your
  last GitHub review" (the signed-in user's latest submitted review's `commit_id`). Kanban env cards and the diff-view
  plugin: `git log --reverse <merge-base>..HEAD` in the local checkout (no local checkout: no commits), uncommitted
  changes as a last pseudo-commit (`sha: "WORKTREE"`), range diffs via local `git diff from to`; diff-view plugin has no
  review marks. Caches must key on the range.

Spec: decision 8. Ticket 03 adds `loadPatch`: extend it with the range.

**Blocked by:** 03 — Load large diffs; surface truncation

**Status:** done

- [x] DiffSource/RPC range plumbing in both hosts, with caches keyed by range
- [x] Commit control + `gr` picker with marks, single commit and ranges (keys and mouse)
- [x] Partial-range rules for comments, viewed marks, threads, findings
- [x] Range/marks helpers tested in a new test file
- [x] KEY_HELP and READMEs updated
