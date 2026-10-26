# 03 — Pipeline strip, chip words and who-holds-the-ball

**What to build:** The card panel's Review loop section shows the loop as a strip of steps, Plan → Build → Checks → Review → Fix → Needs you → Land, each done, current, upcoming or skipped (Plan is skipped when the plan gate is off), under it a bar saying who holds the ball (agent, board, you), then a detail grid: the current step with its commit, elapsed time since the phase began and a link to the thread running it; a pill per round saying what it did (3 fixed, 1 disputed, reviewing, yours) with the cap visible and manual retries counted; and the last checks result with the command and exit code. A pending directive shows as a banner in the strip with an undo control. Enter on a step opens what it produced: the plan, the checks output, the review's findings, the diff. A shared pure function turns loop state and gates into the steps, detail and pills; the board chip reads from the same function and uses the strip's words (`build`, `checks`, `review 2`, `fix 2`, `plan?`, `needs you`, `stuck`), shows the reason bucket and detail word at Needs you, adds a short suffix when a directive is pending, and shows how long a card has waited for the user once it passes an hour. The Building, Checking and Needs you column headers carry a subtitle (agent, board, you) on boards that have the loop's columns. After a hand-off or a stop the handoff brief's first group says what ran and what did not, the level reads "not assessed" with Accept enabled and no reading plan, and the evidence group shows the agent's evidence alone.

**Blocked by:** 02 — Directives, stop, retry, resume and steer in the loop's core.

**Status:** done

- [x] A shared strip function is tested directly: skipped Plan with the gate off, each phase's current step, round pills for loop and user rounds, a pending directive, the bucket for every reason, and elapsed time from the phase-start stamp.
- [x] The card panel renders the strip, the who-holds-the-ball bar, the detail grid and the directive banner with undo in place of the old status sentence, and the steps are reachable with j/k and Enter.
- [x] The board chip uses the strip's words and buckets, the directive suffix and the waiting time.
- [x] Column headers show the agent/board/you subtitle only on boards with the loop columns.
- [x] The handoff brief after a hand-off or stop reads as described, with Accept enabled; the brief tests cover it.
- [x] The README's chip and card-panel descriptions are updated in a few lines.
