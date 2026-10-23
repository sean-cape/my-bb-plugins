---
name: composer-status-bar
description: How the Composer status bar plugin restyles the bar under a thread's composer and where its model, effort, context-token, and usage-limit segments come from. Use when the user asks about that bar, its numbers, or why it looks different from stock bb.
---

The plugin has no commands or settings. It changes the bar under each thread's composer:

- Model and effort come from the composer's current picker selection and show as a chip rendering bb's `experimental_ProviderModelPicker` (the ⇧⌘M picker), routed through the thread's environment; choosing applies with `composer.setSelection`. While it shows, bb's in-box picker is made invisible and zero-width; below a 421px composer the footer drops its chip and bb's comes back. A capture-phase keydown listener takes bb's default `modelPicker.toggle` shortcut (⇧⌘M, Ctrl+Shift+M off macOS) and toggles the footer chip of the focused composer (else the primary one), skipping terminals, browser tabs, and modal dialogs like bb does. Without a visible footer chip the key reaches bb. A rebound shortcut isn't followed, so it opens bb's own picker, anchored to its hidden button in the prompt box. Until the composer has a full selection, the plain text shows instead, with model names resolved through `providers.models` and effort labels through the provider's `reasoningLevels`.
- The landed badge after bb's changes bar (`#thread-prompt-banner-git-toggle`, "Committed · N files") comes from the plugin's `landed` RPC: in the thread's environment it runs `git merge-tree --write-tree <merge base branch> HEAD` and compares the tree with the base's, so cherry-picked work counts as landed; the same check against the base's upstream says whether it's pushed. States: `✓ on main`, `on main · not pushed`, `N files not on main`, `conflicts`; nothing shows when the branch has no commits beyond the base, the environment is on another machine, or git can't find the base. Uncommitted changes aren't part of it. bb's own bar still means "commits since the merge base", whether or not their changes reached it.
- Context tokens used (the window size is in the hover title) come from the thread's latest `thread/contextWindowUsage/updated` event.
- A usage-limit warning appears only when the latest `provider/rateLimits/updated` event has a window in `warning` or `blocked` status.
- bb's new-thread button is hidden; new threads start from the sidebar or the project picker. The footer has the project / environment labels and the branch on the left, then on the right the limit warning, context, the model · effort chip, and permission mode last. When the thread-header-project plugin is also installed, it moves the project into the thread header and hides the footer's project and environment labels.
- The branch is quiet text that outlines on hover (click copies its name). The outlined chips are the controls: model · effort (opens bb's picker), permission mode, and context (opens the token breakdown).
- A limit warning shows only an icon and the time to reset; hover it for the window name.
- When Nerd Font glyphs render (the nerd-font plugin's check, or its "Nerd Font icons" setting forced to Always), the limit icon is an hourglass.
- bb's picker shows its reasoning levels in a grid rather than one row, so they fit the menu in wide fonts; this applies to the picker wherever it opens.
- Narrow footers drop the environment, the project's name (its icon stays), the effort, then the model, so the row never overflows.

There is no dollar cost segment. Claude Code only reports cost in memory (the SDK `result` message and the status line's stdin), and bb doesn't record it.

To restore bb's stock footer, disable the plugin: `bb plugin disable composer-status-bar`.
