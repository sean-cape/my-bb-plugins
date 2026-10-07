Edit bb's prompt box and other text boxes with vim keybindings.

## What you get

- Normal, insert, visual, visual line, and visual block modes.
- Motions, operators, text objects, counts, registers, marks, macros, `.`
  repeat, `/` search, and `:` ex commands such as `:s`.
- A block cursor and a quiet mode label in the corner of the focused text box.

## How it works

The plugin runs the open-source vim engine behind CodeMirror's vim mode. It
attaches to a text box when the box gains focus. Text boxes start in insert
mode, so typing behaves as usual until you press Escape. Nothing leaves the
machine.
