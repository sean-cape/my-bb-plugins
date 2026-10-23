# Composer status bar

Tightens the bar under a thread's composer and adds what bb leaves out of it.

## What you get

One row, ordered by what it describes:

- **Where the work happens**, on the left: the project and environment as plain labels (`my-bb-plugins / Worktree`), then the branch as quiet text that shows its outline on hover (click to copy its name). bb's new-thread button is hidden; new threads start from the sidebar or the project picker.
- **Usage**, on the right: a warning icon with the time to reset when Claude reports a limit as near or reached, then the context chip (`324k` with bb's ring; hover for the window size, click for the breakdown).
- **Whether the branch has landed**, beside bb's changes bar above the prompt box. bb's bar ("Committed · 8 files, +208 -24") counts the commits since the merge base, so work landed by cherry-picking still reads as committed but unmerged. The badge checks by content whether merging the branch into its merge-base branch would change anything: `✓ on main` when everything is there (and, with an upstream, pushed), `on main · not pushed` when local `main` has it but its upstream doesn't, `2 files not on main` while work is still to land, `· conflicts` when merging would conflict. Hover for the detail. It rechecks whenever the bar's numbers change and every 15 seconds; uncommitted changes don't count.
- **The agent**, at the far right: an `Opus 5.5 · High` chip (the composer's current model and effort, visible even while bb's own picker is hidden in the collapsed prompt box) that opens bb's model and reasoning picker, the same one as ⇧⌘M, then the permission-mode chip, right under the send button. While the chip shows, bb's own copy of the picker inside the expanded prompt box is hidden, and ⇧⌘M opens and closes the chip's menu instead (in the focused composer, or the main one).

With a Nerd Font installed (see the nerd-font plugin), the limit warning's icon is an hourglass.

bb's picker lays its reasoning levels out in one row sized for bb's own font; the plugin puts them in a grid so a wider font (Fira Code) fits the menu, wherever the picker opens from.

Every control is an outlined chip; everything else is plain text. Nothing truncates except a long branch name. As the footer narrows, detail drops in this order: the environment, the project's name (its icon stays), the effort, then the model.

With the thread-header-project plugin installed too, the project moves into the thread header and the footer's project and environment labels are hidden.

Split panes each show their own thread's numbers. Disabling the plugin restores bb's normal footer.
