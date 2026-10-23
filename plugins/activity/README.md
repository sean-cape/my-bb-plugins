# Activity log

Records how bb and its plugins get used, so decisions about what to keep, drop, or give a key to rest on what
actually happens rather than on memory. Nothing is instrumented by hand: one content script watches the whole
window and attributes what it sees to the plugin it happened in.

## What is recorded

| Kind | What | Grouped by |
| --- | --- | --- |
| click | A press on a button, link, menu item, list row, tab, or anything else with a pointer cursor | Its name with numbers (in labels of five characters or more, so `7d` stays `7d`), file names and paths blanked, plus the thing it sits in (`Cancel in kanban card`); a test id; a link's page; a row by its kind and its list (`option in Unread threads`), so content never makes a key |
| command | A vim key sequence one of the plugins ran (`gg`, `5j`, `/`), announced by `bb-vim-keys` | The sequence |
| key | Any other key pressed outside a text box: bb's own shortcuts, ⌘ chords, keys nothing bound | The key in vim notation (`<D-k>`, `<Esc>`) |
| route | A page opened, with ids blanked (`/threads/*`, `/plugins/kanban/board`) | The page |

The thing a control sits in comes from the DOM, not from the plugin: the nearest ancestor with an `aria-label`, a
`data-testid`, a `data-*` marker (`data-kanban-card`) or id (`data-thread-id`, read as "thread"), or a structural
role; else a short, digit-free heading. A label is read up to a colon, since what follows names the thing the region
shows (`Browser preview controls: <page title>`). An element with a marker or id of its own (a board card with `data-ticket-id`) is
keyed by that type and its container whatever its role (`ticket in kanban column list`). A row's own text (a thread title, a card name, a meeting) is never stored,
and neither is a label longer than a name or made of several badges. In bb's conversation (the timeline and the
question, approval, and plan banners) a control's text is what the agent or the user wrote, a command bb ran or an
answer offered, and its `title` tooltip often repeats it, so only an `aria-label` names it there, and a message's headings never name a section. Nothing in the log should identify what you
were working on, only what you did with it.

Each event also carries the plugin (from bb's `data-bb-plugin` root around it, or the key library's bundle id;
`bb` when it was bb's own UI), the page it happened on, and for clicks whether the mouse or the keyboard made them.
A click made with Enter or Space counts once, as a keyboard click, not as a key too, and so does Enter or Space on a
`role="button"` element that acts on its own keydown and fires no click (a board card).

Nothing typed into a text box is recorded, and no input values ever are. A window under automation
(`navigator.webdriver`: an agent's headless bb session) records nothing, since no one pressed its keys. Events are batched every five seconds
into the plugin's own SQLite file under bb's data directory; nothing leaves the machine.

## Reading it

The **Activity** page in the sidebar reads the log for the last day, week, month, or all time. From the top:

- A strip of events over time (by hour, six hours, day, or week, whichever gives about a month of columns).
  `h`/`l` walk its columns and Enter pins one, so everything below shows only that stretch; Esc unpins.
- Findings: short sentences the numbers support, each one a row Enter acts on. Controls only ever clicked with the
  mouse (they want a key), things unused for two weeks (candidates to drop, once the log is old enough), the busiest
  stretch, how many clicks came from the keyboard, the most-opened page. Acting on one switches the kind filter and
  sorts the matching rows first, marked with a dot; Esc puts the order back.
- One bar of each plugin's share of the events, which the plugin groups below are the legend for.
- Under each plugin, its pages, clicks, key commands, and other keys as separate sections, busiest first, six rows
  each with a "more" row for the rest. Bars of one kind use the same scale across every plugin, so a long bar means
  the same thing wherever it is. Clicks show mouse against keyboard as two shades with the counts beside them.

`j`/`k` move, `h`/`l` close and open a plugin, `1`–`4` pick the range, `c` cycles clicks, key commands, other keys,
and pages, `/` filters by name, `r` rereads, `?` lists the keys.

From the terminal, or for an agent asked about usage:

```sh
bb activity top --since 30d                 # most-used controls and keys
bb activity top --kind command --plugin kanban
bb activity top --kind click --json         # pointer vs keyboard counts per control
bb activity plugins                         # events per plugin
bb activity recent --limit 20
bb activity prune --before 90d
```

A control with many mouse clicks and no keyboard ones wants a key; a key command with no uses in a month is a
candidate to drop from the keymap.

## How plugins take part

They don't have to. Clicks are attributed through the root bb wraps around every plugin slot, and key commands
through the event `createKeyHandler` in `bb-vim-keys` dispatches after a command runs (`KEY_COMMAND_EVENT`), which
carries the plugin id `bb plugin build` defines into each bundle. Keys pressed inside a text box are never recorded, so vim-mode's editing commands in the
prompt box (`dd`, `ciw`) don't show up; its thread scroll-mode keys do, since they go through the library. A click
bb makes itself (`element.click()`) counts as a keyboard click, and a row opened with Enter or `o` records both the
command and the click it caused. Keys a plugin handles outside the library, such as the bb command shortcuts
history-keys registers, count as its commands when it calls `announceKeyCommand`; otherwise they log as plain keys.
