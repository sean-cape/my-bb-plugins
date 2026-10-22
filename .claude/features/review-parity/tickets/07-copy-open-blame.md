# 07 — Copy path / link, open file, blame

**What to build:**
- `DiffResult.repo: string | null` (GitHub `owner/name`): kanban PR diffs set it from the PR; environment diffs set it
  from the checkout's `origin` remote when it is GitHub (there is a `githubRepoFromRemote` in kanban's github.ts;
  put a generic one in `bb-diff-view/server`), else null.
- `yp` copies the cursor's file path; `yl` copies a link to the cursor's line or the `V` selection: a GitHub blob
  permalink at `headSha` (`#L10-L14`; for old-side lines use `baseSha`) when `repo` and the sha are known, else
  `path:L10-14`. Toast confirms. A small "…" menu on each file header offers Copy path, Copy link, Open file, Blame first
  hunk (mouse path).
- `gO` opens the file at the line: environment sources in bb's file preview (the same mechanism symbol peeks use to
  open a result; see `symbols/symbol-peek.tsx` and `SymbolOpenTarget`), PR sources on GitHub at the head sha.
- `gb` shows blame for the cursor line (or selection) in a popover: per distinct commit, short sha, author, relative
  date, summary; j/k move, Enter opens the commit on GitHub when `repo` is known, Escape closes.
  `DiffSource.blame(path, side, startLine, endLine, range): Promise<BlameLine[]>`. Server: `bb-diff-view/server` gets
  `gitBlame(dir, rev, path, start, end)` (`git blame --porcelain -L`) and `blameRev`, the revision each side is
  blamed at: the commits the diff compares, so a picked range's end (new side) and old side (a PR range's comparison
  merge base, an environment range's start), else the working tree or PR head (new side) and the merge base (old
  side). Diff-view plugin RPC on the local checkout; kanban: the local workspace when it has the commit, else GitHub
  GraphQL `blame` at that commit.

Spec: decision 7.

**Blocked by:** None — can start immediately

**Status:** done

- [x] `repo` on DiffResult from both hosts
- [x] `yp`, `yl` (selection-aware), `gO`, and the header menu
- [x] `gb` popover with keys; `gitBlame` porcelain parser tested in a new test file; both hosts implement `blame`
- [x] KEY_HELP and READMEs updated
