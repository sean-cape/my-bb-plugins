# 04 — Loop menu, keys and the steering composer

**What to build:** Every intervention is reachable from the card panel and the keyboard. `m` opens a loop menu (on the open card, and on the board for the focused card, replacing the bare toggle) built on the bb-vim-keys menu pieces, listing steer, hand to me, skip review once, stop now, retry, resume with a message, gates, and loop off, each with its key where it has one; items that don't apply in the current phase are greyed with the reason. Plain keys on the open card: `s` focuses the steering composer, `f` hands to me (at the next ready while the agent builds or fixes, after this step while the board checks, classifies or reviews) and `x` stops now. A one-line composer in the loop section sends a steering message to the card's thread (Enter sends, Shift-Enter newlines, Escape leaves); it is the card's main input while the loop runs so `i` reaches it; at Needs you the same composer sends Resume with a message. While the board runs a step the menu notes that a ready from the steered thread supersedes the step. While the thread is paused on a question, verify whether a sent message answers bb's pending question; if not, the composer says to answer in the thread and offers to open it. Retry appears in the brief at a loop error with the manual retry count. The plan gate's row says "takes effect at the next Rethink" when it is turned on while the loop is past planning. The shortcuts dialog lists the new keys and the keymap tests cover the menu's keymap.

**Blocked by:** 02 — Directives, stop, retry, resume and steer in the loop's core; 03 — Pipeline strip, chip words and who-holds-the-ball.

**Status:** done

- [x] `m` opens the loop menu on the open card and on the board's focused card; Enter picks; disabled items show their reason; loop off lives there and not on a plain key.
- [x] `s`, `f` and `x` work on the open card as described, with `f` phase-dependent; the keymap tests pass with the new keys and the menu keymap, and `?` lists them.
- [x] The composer steers while the loop runs and resumes at Needs you, is the card's main input while the loop runs, and leaves on Escape.
- [x] The paused-on-a-question behaviour is verified and the composer's wording matches what bb does.
- [x] Retry shows in the brief at a loop error with the count; the plan gate hint changes when turned on mid-loop.
- [x] The README's keys and Monitored cards sections are updated in a few lines.

Notes: bb's plugin SDK answers a pending question through `bb.sdk.threads.interactions.respond({ threadId, interactionId, value })` (and `resolve`), and `threads.send` has no interaction field, so a plain send doesn't target the question. Per the ticket that path isn't built here: while the loop is paused the composer says "The thread is waiting on a question; answer it in the thread" with an Open thread button. With the loop off, `m` turns it on directly (an off card renders no menu to open); Loop off itself is only in the menu.
