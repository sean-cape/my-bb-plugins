# When done

A per-thread switch for what the agent does with a finished change: **Merge to main**, **Commit to branch**, or
**Leave uncommitted**. Threads without their own pick follow their project's default, else leave changes uncommitted.

- The chip before the send button shows it; click it or press `⌥D` (`⌥⇧D` backwards) to change it.
- The thread actions menu has **When done**, with **Project default** to clear the thread's pick.
- The palette has a command per option and one that makes the thread's choice its project's default.
- `bb finish-action show|set|default` does the same from the CLI.

The agent reads the setting through the `finish_action` tool each time it finishes a change, so a switch mid-thread
applies to the next one. "Merge to main" runs `node scripts/land.mjs` in repositories that have it (this one does);
elsewhere the agent follows the repository's own instructions, or merges into the base in the main checkout.

Plugin-started threads (kanban, automations, side chats) and Personal threads have no setting.
