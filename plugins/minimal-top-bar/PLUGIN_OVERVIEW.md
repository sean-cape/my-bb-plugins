Clears out bb's top bar: a centered thread title that opens the thread menu, and fewer buttons.

## What you get

- Thread titles sit centered in the top bar, and stay centered while you rename them.
- A click on the title opens the thread menu; a double-click still renames. bb's ⋯ button is gone, but the menu opens where it was, at the title's end.
- Fewer top-bar buttons. Those with a keyboard equivalent are hidden:
  - Open in editor or terminal: Cmd+O.
  - Close pane: Cmd+W.
- bb's Commit button and the sidebar toggle are hidden too, and the sidebar stays collapsed to the icon rail, since the Project switcher's picker replaces its thread list; if bb opens it, it closes again once nothing in it has focus (bb's `/` on a settings page opens it to focus the settings search, which keeps working). The Settings, Plugins, and Skills lists still show beside the rail on those pages.
- The footer's icons (Provider usage, More footer actions, update badges) stack in the rail above Settings instead of hiding with the collapsed sidebar. Clicking Provider usage, or More footer actions → Customize footer, opens its panel as a card beside the rail.
- On macOS there's no separate title bar row: the page header, with the thread title and its buttons (such as Changes), is the top bar, centered on the window buttons and indented past them, and a side panel reaches the top of the window. The icon rail is as wide as the top bar is tall. The right panel toggle (Cmd+J) floats at the top bar's right end. Back and forward are hidden; use History keys' Ctrl+O and Ctrl+I.
- The top bar keeps its size when you zoom bb (Cmd+- / Cmd+=), so it stays centered on the window buttons; only the page content zooms.

## How it works

A content script adds a stylesheet that hides the top-bar buttons and centers the title, finds bb's Commit button by its text and hides it, presses bb's hidden sidebar toggle whenever the sidebar is expanded and nothing in it has focus, removes the `inert` bb puts on the collapsed sidebar's list and footer (the parts left hidden stay unreachable), and turns a single click on the title into a press of bb's hidden ⋯ trigger, after a short wait so a double-click can still reach rename. On macOS a second content script collapses bb's title bar row, measures where the window buttons and the right panel toggle sit so the top bar's content clears them, and reads bb's zoom level from how much wider the window is than the page to zoom the top bar back to full size. bb's top bar markup isn't a plugin contract, so a bb update may need this restyle adjusted; disabling the plugin restores bb's normal top bar. It applies at every window width; in compact windows the title opens bb's thread menu sheet instead of the dropdown.
