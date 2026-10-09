Search and vim keys for bb's settings: a search bar at the top of the settings sidebar that finds any setting on any settings page, and a cursor that walks a page's settings from the keyboard.

## What you get

- A "Search settings" box under Back to app. While it holds a query, the sidebar's page list gives way to matching settings from every settings page, plugin pages included, each with its page, section, and description.
- Results match every word you type, best first: setting names that start with a word, then names that contain it, then page and section names, then descriptions.
- Opening a result goes to its page, scrolls the setting into the middle of the screen, rings it briefly, and focuses its control, so Space flips a switch straight away.
- j/k walk a cursor over the open page's settings. A list row with several buttons, like a project, is one stop. Enter uses the setting under the cursor (flips a switch, opens a menu or link, or puts you in a text field), and Esc comes back out to the keys.

## Keys

| Key | Does |
| --- | --- |
| `j` / `k` | Next or previous setting on the page |
| `gg` / `G` | First or last setting |
| Ctrl-D / Ctrl-U | Half a page down or up |
| `h` / `l` | Previous or next settings page |
| Enter | Use the setting under the cursor |
| `i` | Focus the setting's control, so Space flips a switch |
| Esc | Leave a control or text box for the keys; then hide the cursor |
| `/` | Focus the search box |
| ↑ ↓, Ctrl-N Ctrl-P | Move through results |
| Enter (in the search box) | Open the selected setting and focus it |
| `n` / `N` | Open the next or previous result, from anywhere on the settings page |
| Esc (in the search box) | Clear the search, then leave the box |
| `?` | Show these keys |

## How it works

The keys stay out of the way while a menu or dialog is open, while you type in a text box, and while Keyboard settings is recording a shortcut.

A content script adds the box whenever bb's settings sidebar is on screen. The open page is indexed at once. The other pages are indexed each time settings open, in a hidden iframe that runs bb itself and steps through the sidebar's links, since no plugin API describes what another settings page contains. Until it finishes, results cover the pages indexed so far, and the list says how far along it is. The Archived threads page isn't indexed. bb's settings markup isn't a plugin contract, so a bb update may need the selectors adjusted; disabling the plugin restores bb's normal sidebar.
