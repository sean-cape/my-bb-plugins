# 01 — Run mode at creation

**What to build:** Starting a monitored card is one decision. The new-card dialog replaces "Start a thread now" with a "How it runs" segmented control: Card only, Thread, Review loop. With a project chosen the default is Review loop; without one it is Card only and the other two are disabled with a note. Choosing Review loop shows the three gates inline, prefilled from the card's kind, and the Create button reads "Create and start" whenever a thread will start. One Create makes the card, sets its loop state with the chosen gates and starts the thread, whose first instructions already carry the builder contract (the server already orders creation before the spawn; the create call only needs to accept gates). The card panel's Thread row for a card with no thread offers the same control in place of the bare Start button, and the brain-dump proposals' accept step offers it for the cards it creates. The loop switch on a card whose thread already runs says it joins the loop from here and that the thread gets the contract as a message. The shared default gates turn auto-accept on for every kind (plan approval stays on for Jira cards), so the dialog, `bb kanban add --monitor`, Monitor tags and `bb kanban monitor on` all agree; `bb kanban add` also accepts `--gates` like `bb kanban monitor on` does.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] The new-card dialog has a Card only / Thread / Review loop control with the defaults and disabled states above, inline gates under Review loop, and a "Create and start" label when a thread will start.
- [x] Creating in Review loop mode yields a card that is monitored with the chosen gates and has a thread whose instructions carry the builder contract from the start; no "monitoring" message is sent to it.
- [x] The card panel's Thread row (card without a thread) and the proposals' accept step offer the same control and behave the same way.
- [x] The loop switch on a card with a running thread is relabeled as joining the loop from here.
- [x] Default gates have auto-accept on for every kind and plan approval on for Jira; existing tests that asserted the old defaults are updated, and the README's Monitored cards section says so in a line or two.
- [x] `bb kanban add` accepts `--gates` with the same syntax as `bb kanban monitor on`.
- [x] A server test covers creating a card in Review loop mode with gates and checks the thread's instructions carry the contract; the dialog's control has a keyboard path (the existing segmented tabs or picker pieces).
