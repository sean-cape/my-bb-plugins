# Agent notes

## Keyboard first

Build every plugin to be driven from the keyboard, with vim-style keys wherever they fit:

- Lists, boards, and trees move with `j`/`k` (and `h`/`l` across columns or levels), jump with `gg`/`G`, and scroll with Ctrl-D/Ctrl-U.
- `/` searches, `n`/`N` step through matches, `i` focuses the main text input, and `?` lists the plugin's keys.
- Escape leaves a text box and returns to the keys. Text boxes whose Escape or arrows must reach the plugin (a list's search box) opt out of vim-mode with `data-vim-ignore`.
- Ignore keys when focus is in a text box or a Cmd/Alt modifier is held, and don't take keys bb or the vim-mode plugin already use.
- Every mouse action needs a keyboard path.

kanban's board, grpc-client, and vim-mode's scroll mode are working examples.
