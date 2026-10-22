# Review parity with GitHub's Files changed tab

## Problem

The diff view (`plugins/diff-view/lib`, the `bb-diff-view` library) is the user's code review surface in two hosts:
the diff-view plugin (a bb thread's environment, side panel) and kanban (PR cards from the GitHub API; other cards
from the card thread's environment). It already goes past GitHub in places (structural diffs, symbol peeks, AI
findings, the narrative review), but a full review still sends the user to github.com for: searching the diff's
text, suggested changes, seeing outdated and resolved threads, large files, whitespace-only noise, reviewing
commit by commit, filtering files, copying links, blame, and a unified layout for structural diffs.

Goal: GitHub's review feature set, with this view's own keys and workflows. Skipped for now: comment-box tooling
(Markdown preview, @mentions, saved replies) and rich diffs (images, rendered Markdown).

## Hosts and seams

- Every new capability is an **optional** member of `DiffSource` (`lib/app/source.ts`); the UI hides what a source
  lacks. Both hosts implement what they can:
  - diff-view plugin: `plugins/diff-view/server.ts` (RPC contract + handlers), `plugins/diff-view/app.tsx` (source).
  - kanban: `plugins/kanban/contract.ts`, `plugins/kanban/server/diff/changes.ts` (and `server/comments/*`,
    `server/github.ts`), `plugins/kanban/ui/diff-page.tsx` (source).
- Shared server helpers go in `plugins/diff-view/lib/server.ts` (`bb-diff-view/server`), data shapes in
  `lib/types.ts`. The lib imports only host-shimmed modules (see `bb-diff-view-library` notes in the README).
- Server work that needs git runs against a **local checkout** when there is one (`localEnvironmentPath`); PR
  cards use the GitHub API, or the card's local workspace when it has one.
- Keys follow `AGENTS.md` (bb-vim-keys, `keymapConflicts`/`unboundHelpKeys` tests, every mouse action has a key).
  Every new key goes in `REVIEW_KEYMAP` and `KEY_HELP` (`lib/app/keys/keymap.ts`) and the README's keyboard list.

## Keys (fixed up front so parallel tickets don't collide)

| Key | Does | Ticket |
|---|---|---|
| `/` | Search the diff's text (was: file names); `n`/`N` step through matches | 01 |
| `f` | Find a file by name (the old `/` overlay) | 01 |
| `W` | Hide / show whitespace changes (default: hidden) | 02 |
| Enter on a large file's placeholder | Load its diff | 03 |
| `gl` | Split / unified, now for structural files too | 04 |
| `gc` | Comments view (every thread, resolved and outdated included); `gc` again returns | 05 |
| `H` | Hide / show comment threads inline | 05 |
| `gf` | File filter menu (files view; the narrative keeps its own `gf`) | 06 |
| `yp`, `yl` | Copy the file's path / a link to the line (or selection) | 07 |
| `gO` | Open the file at the cursor's line (bb file preview, else GitHub) | 07 |
| `gb` | Blame for the cursor's line (or selection) | 07 |
| `gr` | Commit picker: all changes, since last review, one commit or a range | 08 |
| `I` | Suggest a change on the line or selection | 09 |
| `A` | Apply the suggestion under the cursor now (comment or finding) | 09, 10 |
| `B` | Add / remove the suggestion under the cursor to the batch; `gB` commits the batch | 09, 10 |
| `gs` | Post a finding's suggestion to the PR as a draft suggestion comment | 10 |

## Decisions

1. **Search** runs over data, not the DOM: every file's patch lines (old and new side), so collapsed, viewed and
   unmounted files are searched too. `n`/`N` move the review cursor to the match (expanding the file, opening a
   structural fold) and wrap like vim. Matches on screen are highlighted. Smartcase and regex via bb-vim-keys'
   `compileSearch`. The match count shows while searching.
2. **Whitespace** is hidden by default and persisted (`diff-view:hideWhitespace`). Text diffs are transformed
   client-side (`git diff -w` semantics: within each change block, lines equal after removing all whitespace become
   context), so it works for every source and keeps line numbers. difftastic already ignores formatting; with
   whitespace shown, a file difftastic calls unchanged but whose patch has changes is shown as a text diff. A file
   whose only changes are whitespace says so and starts collapsed while whitespace is hidden.
3. **Large diffs**: a text file without a patch gets a "Load diff" placeholder; `DiffSource.loadPatch(path)` makes the
   patch from the two sides (`git diff --no-index` on temp files). Binary files say they are binary. PR file lists
   page to GitHub's 3,000-file maximum, and any truncation is a visible banner above the diff, saying what is missing.
4. **Unified structural** is the same `layout` preference the text diffs use, now persisted, applied to structural
   files: one code column, old and new line numbers, deleted rows before added rows in each change block, token
   highlights kept. Cursor, comments, findings, folds and search work in it.
5. **Comments view** is a third mode beside Files and Narrative. It lists every thread grouped by file: open, resolved,
   outdated, local and GitHub, with filter chips (open / resolved / outdated / all), each over its code (current lines
   from the diff, or GitHub's stored `diff_hunk` for an outdated thread). Inline, the files and narrative views stop
   showing resolved and outdated threads; the summary bar says how many are in the Comments view. `H` hides all
   threads inline.
6. **File filter**: extensions, change type, hide viewed, only files with comments, only files with findings.
   Filtered files leave the tree, the scroll, navigation and search; a summary-bar chip shows and clears it. Kept per
   view instance for the session.
7. **Copy / open / blame**: `DiffResult.repo` (GitHub `owner/name`, null when unknown) lets the lib build blob URLs
   at `headSha`. Env sources without a GitHub repo copy `path:Lstart-end`. Blame is
   `DiffSource.blame(path, side, startLine, endLine, range)` and reads the commits the diff compares: with commits
   picked, the range's end (new side) and its old side (a PR range's comparison merge base, an environment range's
   start); else the head (an environment's working tree) and the merge base (a PR's with its base branch). Local
   `git blame --porcelain` where the checkout has the commit, else GitHub's GraphQL blame for PRs.
8. **Commit picker**: `DiffSource.commits()` returns the diff's commits (oldest first) and named marks
   (`Since last review` from kanban's latest stored review's commit, `Since your last GitHub review` from the user's
   latest submitted PR review). `getDiff`, `getStructural`, `loadPatch` and `blame` take a `CommitRange { from, to }`
   (from exclusive), null for all the changes. A partial range is for reading: comments and viewed marks work only
   when the range ends at the head and only on the new side; everything else says to switch back to All changes. Env sources
   list commits from the local checkout, with uncommitted changes as a last pseudo-commit.
9. **Suggestions**: a ```` ```suggestion ```` block in any comment body renders as a small diff of the commented
   lines. `I` opens a comment prefilled with the lines' text in a suggestion block. `DiffSource.suggestions.apply(items,
   message)` applies one or a batch; each item carries the lines it expects, and the server refuses items whose lines
   moved. Env hosts write the local checkout's files (no commit). PR hosts make one commit on the PR head branch
   through GitHub's git data API (blobs, tree, commit, ref), then resolve the applied GitHub threads.
10. **AI suggestions**: the code-review skill's findings JSON gains `"suggestion": { "file", "startLine", "endLine",
    "replacement" } | null` (version 6) for fixes that are a contiguous edit of new-side lines. Kanban parses and
    stores it; the finding annotation shows it as the same suggestion diff, and `A`/`B` apply it through
    `suggestions.apply`, `gs` posts it to the PR as a draft suggestion comment. The skill file itself
    (`~/.claude/skills/code-review/SKILL.md`) is edited by the integrating session, not a ticket agent.

## Testing

Unit tests on the pure parts (search matching over patches, the whitespace transform, unified structural rows, file
filter predicates, commit-range plumbing, suggestion parsing and expected-line checks, findings parsing) in **new
test files** next to the existing ones (`plugins/diff-view/<area>.test.ts`, `plugins/kanban/server/...test.ts`), not
in the shared `lib.test.ts`, so parallel tickets merge cleanly. The existing keymap tests (`keymapConflicts`,
`unboundHelpKeys`) must keep passing. End-to-end checks run in the integrating session against live bb.
