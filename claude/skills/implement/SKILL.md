---
name: implement
description: "Implement a piece of work based on a spec or set of tickets: frontier tickets run in parallel as worktree subagents, each wave is merged back into this session's branch, and the whole feature is tested end to end before one review and landing."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

## Where the work is described

Specs and tickets live under `.claude/features/<feature-name>/`:

- `spec.md` — the feature's spec (written by the `to-spec` skill).
- `tickets/<NN>-<slug>.md` — one file per ticket in dependency order (written by the `to-tickets` skill). Each ticket names the tickets that **block** it under "Blocked by", and lists its acceptance criteria as checkboxes.
- `AGENT-NOTES.md` — optional notes the user left for the agents working this feature (time budget, how much review and testing they want). When it exists, read it first and hand it to every subagent.

If the user names a feature, read its `spec.md` for context and work its tickets. If they point at a single ticket, work that one. Read the spec even when working from tickets — it holds the problem, decisions, and testing approach the tickets assume.

## The shape of the work

This session is the **integration branch**. Tickets are implemented in parallel by subagents, each in its own git worktree, and merged back here wave by wave; nothing lands anywhere until the whole feature has been merged, tested end to end, and reviewed once.

1. **Build the frontier.** From the tickets' "Blocked by" lines, the frontier is every ticket whose blockers are all `done` (a ticket with "None" is on the first frontier). Skip tickets already marked `done`.
2. **Run the frontier in parallel.** Spawn one subagent per frontier ticket in the same message, each with `isolation: "worktree"` and `run_in_background: true`, using the brief below. More than four at once gets noisy and slow; batch beyond that. If only one ticket is in play (a single ticket, or a purely linear chain), skip the subagents and work it in this session.
3. **Merge the wave back.** As each subagent reports, merge its branch here and check the result (see "Merging a ticket back"). Then recompute the frontier and spawn the next wave; a later ticket starts only once everything it is blocked by is merged here.
4. **Test the feature end to end.** Once every ticket is merged: run typechecking and the full test suite, then exercise the feature as a user would, against every user story in the spec and every acceptance criterion in the tickets. For an app or plugin, actually run it (the project's run or install instructions, or the `run` skill) rather than inferring from tests. Fix integration bugs here, in their own commits: a ticket's rename another ticket missed, two tickets' UI competing for the same space, a test that passed per ticket and fails together.
5. **Review once, then land.** Run `/code-review` over the whole change once (not per ticket), apply what it finds, then land the way the project's AGENTS.md or CLAUDE.md says to.

## The subagent brief

Each subagent sees only its prompt, so the brief carries everything. Include:

- The absolute paths of the ticket file, `spec.md`, and `AGENT-NOTES.md` when it exists, and the instruction to read them in that order before anything else.
- This session's branch name, and the first step: `git merge --ff-only <session-branch>` so the worktree holds every ticket merged so far (a subagent's worktree is not necessarily based on this session's HEAD; it is usually behind it, so this is a fast-forward). Git commands in an isolated worktree must be run one per shell call (a compound git line is refused), and since the shell's directory resets between calls, as `git -C <worktree path> …`.
- How to make the worktree runnable: a fresh worktree has no dependencies installed, so name the project's install or link steps (from its AGENTS.md, CLAUDE.md or `AGENT-NOTES.md`) rather than leaving the subagent to discover that typechecking fails.
- Where the project signs commits, a `git commit` that fails on signing inside the sandbox is run with the sandbox disabled; that is expected and authorized, so the subagent should do it rather than stop to ask.
- What to build: the ticket's end-to-end behaviour and acceptance criteria, plus the spec's testing decisions and the pre-agreed seams. Use `/tdd` where it fits. Run typechecking and the single test files it touches; the full suite runs here, after the merge.
- Scope: this ticket only. No refactors beyond it, no touching other tickets' areas, no changes to the spec. Anything outside the ticket that blocks it goes in the report, not the code.
- How to finish: check off the ticket's acceptance criteria and set its `**Status:**` to `done` in the ticket file; commit everything on the worktree's own branch (`git add` then `git commit`, as separate calls). Never push, never merge or cherry-pick to any other branch, never build or install or reload anything, never run the project's landing steps, and never touch another worktree.
- The report: the branch name (`git rev-parse --abbrev-ref HEAD`), the commits made, the files changed, what was run and its result, and anything left undone or found along the way.

## Merging a ticket back

For each finished subagent, from this session's worktree:

1. `git merge --no-ff --no-edit <its branch>`. The branch is `worktree-agent-<agent id>` unless the report says otherwise. Resolve conflicts here; they are usually two tickets touching one shared file, and the right result follows from both tickets' intent.
2. Run typechecking and the tests the ticket touched. A failure that is the ticket's own goes back to that subagent (`SendMessage` to its id, with the failure) rather than being patched here; a failure from the merge itself is fixed here.
3. Remove the subagent's worktree once merged (`git worktree remove <path>`, then `git branch -d <branch>`), so it doesn't accumulate; the path is under `.claude/worktrees/` in the main checkout, which the sandbox can't write to, so the removal runs with the sandbox disabled.
4. Confirm the ticket file now reads `**Status:** done` in this worktree. If the subagent left it unchanged, set it.

A subagent that reports without committing, or whose branch has no commits beyond its base, hasn't finished: send it back with what is missing.

## Implementing in this session

When working a ticket here rather than in a subagent: use `/tdd` where possible, at pre-agreed seams; run typechecking regularly, single test files regularly, and the full test suite once at the end; keep the ticket file current as criteria land.

Commit your work to the current branch.
