Vim-style keys for getting around bb: Ctrl+O and Ctrl+I step back and forward through its pages, Cmd+1 through Cmd+9 open the sidebar rail's items, and Cmd+0 returns to the last thread.

## What you get

- Ctrl+O goes back and Ctrl+I goes forward, the same as bb's back and forward buttons.
- Cmd+1 through Cmd+9 (Ctrl elsewhere) open the rail's first nine items in order, Home first. Hold Cmd and each one shows its number in a pill. Items hidden under More get no number.
- Cmd+0 returns to the last thread you had open, or from a thread to the one before it.
- bb keeps a plugin's default off any key one of its own shortcuts holds, even one that only acts in a split, so clear its jump-to-thread and focus-pane-by-number shortcuts once: `for n in 1 2 3 4 5 6 7 8 9; do bb settings keyboard set thread.jump.$n disabled; done; for n in 1 2 3 4 5 6 7 8; do bb settings keyboard set pane.focus.$n disabled; done`.
- Every key is rebindable under Settings → Keyboard: "Go back", "Go forward", "Open sidebar item N", and "Return to the last thread" (the pills keep showing the defaults).

## How it works

The history commands click bb's own back and forward buttons, so bb's history rules still apply and a key does nothing when its button is disabled. If bb's buttons aren't on the page, they step the window's history instead. The rail commands press the rail's buttons in the order they appear, skipping More and buttons other plugins add there. An app overlay records the threads you visit (the last two, kept across reloads) for Cmd+0. bb's rail markup isn't a plugin contract, so a bb update that renames it leaves the rail keys with nothing to press. Each command a key ran is announced the way bb-vim-keys announces its commands, so the activity log counts the keys as this plugin's.
