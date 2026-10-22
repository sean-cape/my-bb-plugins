# bb-vim-keys

Vim-style keys for bb plugin surfaces. Every plugin in this repo that answers `j`, `gg`, `/` or `?` builds on it, so
keys mean the same thing everywhere and nobody writes another text-box check or `gg` timer.

It is layers, not a framework. Use the highest layer that fits and drop a level when it doesn't:

| Layer | What | Use it for |
| --- | --- | --- |
| Keys | `keyToken`, `createKeyReader`, `Keymap` | Turning keydowns into commands in vim notation (`j`, `gg`, `<C-d>`, `5j`) |
| Handler | `createKeyHandler`, `bindKeys`, `useKeyHandler` | Any listener: the window, an element, a React `onKeyDown` |
| Scope | `bindKeyScope`, `useKeyScope` | A plugin page or panel with its own root |
| Cursors | `runListMotion` (focus over `[data-nav-row]`), `stepIndex` (a highlighted index), `spatialStep` (2-D), `scrollPane` (no cursor) | Moving |
| Widgets | `createPickerKeys` / `usePickerKeys`, `createMenuKeys`, `createSearchBoxKeys`, `useTextSearch` | Selects, comboboxes, switchers, menus, `/` search |
| Help | `KeyHelp` (React), `renderKeyHelp` (DOM), `filterKeyHelp`, `keymapConflicts`, `unboundHelpKeys` | The `?` list and its `/` search, and tests that keep it honest |

## Quickstart

1. Depend on it (the `link:` override keeps pnpm from copying it, which would go stale):

   ```jsonc
   // package.json
   "dependencies": { "bb-vim-keys": "file:../vim-mode/lib" },
   "pnpm": { "overrides": { "bb-vim-keys": "link:../vim-mode/lib" } }
   ```

   and `"allowImportingTsExtensions": true` in tsconfig, since the library's imports end in `.ts` (that lets node's own
   test runner load it). A library that other plugins bundle (diff-view's) imports it by relative path instead.

2. Write one keymap and one shortcuts list, as module constants:

   ```ts
   import { type KeyHelpSection, type Keymap, type ListMotion, mapKeymap, ROW_KEYS } from "bb-vim-keys";

   type Command = { kind: "list"; motion: ListMotion } | { kind: "scroll"; step: 1 | -1 } | { kind: "search" } | { kind: "help" };

   export const KEYMAP: Keymap<Command> = {
     ...mapKeymap(ROW_KEYS, (motion): Command => ({ kind: "list", motion })),
     "<C-d>": { kind: "scroll", step: 1 },
     "<C-u>": { kind: "scroll", step: -1 },
     "/": { kind: "search" },
     "?": { kind: "help" },
   };

   export const KEY_HELP: KeyHelpSection[] = [
     { title: "Move", keys: [{ keys: ["j", "k"], action: "Down or up" }, { keys: ["gg", "G"], action: "Top or bottom" }, { keys: ["Ctrl-d", "Ctrl-u"], action: "Half a page" }] },
     { title: "Act", keys: [{ keys: ["o", "Enter"], action: "Open" }, { keys: ["/"], action: "Search" }, { keys: ["?"], action: "These keys" }] },
   ];
   ```

3. Bind it to the surface's root, and mark the rows the cursor moves over:

   ```tsx
   const root = useRef<HTMLDivElement>(null);
   useKeyScope(root, true, {
     keymap: KEYMAP,
     takeFocus: true,
     counts: true,
     onTextEscape: (field) => returnToRow(field, root.current),
     onCommand: (command, { count }) => {
       const list = root.current!;
       if (command.kind === "list") return runListMotion(list, command.motion, { count });
       if (command.kind === "scroll") return runListScroll(list, command.step, 0.5);
       // …return false for a key the surface doesn't want right now, and it goes on to the page.
     },
   });
   return <div ref={root} tabIndex={-1}>{rows.map((row) => <button key={row.id} data-nav-row="item" tabIndex={-1}>{row.name}</button>)}</div>;
   ```

4. Test the keymap and the list against each other:

   ```ts
   expect(keymapConflicts(KEYMAP)).toEqual([]);
   expect(unboundHelpKeys(KEY_HELP, KEYMAP, ["⌘↵"])).toEqual([]); // the third argument: keys bb or a control handles
   ```

   Write help keys as `displaySequence` writes them (`gg`, `Ctrl-d`, `Enter`, `Esc`) or the check can't match them.

5. After changing anything in `lib/`, check every plugin that builds on it:

   ```sh
   node scripts/check-lib-consumers.mjs vim-mode/lib
   ```

## Keys

- `keyToken(event)` names a keydown: `j`, `G`, `<C-d>`, `<Esc>`, `<CR>`, `<Space>`, `<S-Tab>`. It returns null for ⌘ and
  ⌥ chords (bb's and the system's), bare modifiers (so Shift between `g` and `O` doesn't break `gO`), and composition.
  Plugins don't take ⌘ chords; register those as bb commands (`app.commands.register` with `defaultShortcut`).
- `createKeyReader(keymap, { counts?, timeoutMs? })` reads sequences, waiting on the start of one for up to
  `SEQUENCE_TIMEOUT_MS` (1000, vim's `timeoutlen`). A key that can't continue the sequence starts over on its own.
- `keymapConflicts(keymap)` lists sequences that also start a longer one (`g` beside `gg`); keep it empty.
- `mapKeymap(keymap, wrap)` turns one keymap's commands into another's, so shared fragments compose: `MOTION_KEYS`
  (j/k/arrows/gg/G/Ctrl-d/u/f/b) and `TEXT_BOX_MOTION_KEYS` (arrows and Ctrl-n/p, for keys taken inside a text box).

## Handler

`createKeyHandler(options)` is the engine. It holds no listener: hand it keydowns and it returns whether it took one
(calling `preventDefault`). Every other layer is built on it.

- `keymap` is a map or a function returning one, for keys that depend on state (a pane, a picker column, a mode).
- `active()`, `accepts(target, event)` and `blocked()` decide whether a key is the handler's at all. `target` is null
  when focus is on the page body.
- Text boxes keep their keys (`isText`, default `isTextEntry`), except Escape when `onTextEscape` is set. A search
  box's own handler passes `isText: () => false`.
- Enter and Space stay with a focused button or link unless `leaveToPressables: false`.
- `keymap` as a function gets the key's target and event, so a select can keep its arrows while j/k leave it.
- Taps: `observe` sees every keydown before any check, even one vim-mode or bb already took (to note when Escape was
  pressed); `intercept` sees keys first and may take them; `onKey` sees each key the handler accepted, before it is read
  (to cancel work any key interrupts); `onUnbound` sees keys nothing bound; `onPending` the half-typed sequence for a
  mode label. `counts` enables `5j`.
- After a bound command runs, the handler dispatches a bubbling `KEY_COMMAND_EVENT` (`bb-vim-keys:command`) on its
  root or the key's target with `{ keys, count, event, plugin }` (`KeyCommandDetail`; `plugin` is the id `bb plugin build`
  defines into the bundle). The activity plugin listens for it on the window to log which commands get used; a plugin
  needn't do anything for its keys to count.
- `bindKeys(target, options)` puts a handler on the window, a document or an element, with `capture` to run before bb
  and vim-mode and keep taken keys from them. It is for content scripts over bb's own DOM, which have no root of their
  own: resolve the surface at key time in `accepts`.
- `useKeyHandler(options)` returns a React `onKeyDown` that stops the keys it takes. React runs it before any window
  scope, which is how a nested surface (a card in a board, a picker in a card) takes its keys first.

Where a handler listens decides who goes first: window capture (vim-mode, bb's shortcuts) → the element's own
listeners → React handlers → window bubble (`bindKeyScope`). A handler skips a key an earlier one prevented.

## Scope

`bindKeyScope(root, options)` / `useKeyScope(root, enabled, options)` are a handler for one surface with a root. A key
counts when it comes from inside the root (or `alsoWithin`), outside any menu or listbox in it, with no `blockedBy`
overlay (default: open dialogs) over the root.

- `group` and `primary`: scopes in one group share keys from the page body; the one last clicked or focused takes them,
  else the primary one. Groups only work within one plugin, since each plugin bundles its own copy of the library.
- `takeFocus` moves focus onto the root as the scope starts if it is on the body or something unrelated.
- `listenOn: "root"` listens on the root instead of the window, so a nested list (a file tree in a diff) hears its keys
  before the surface around it, and what it doesn't bind goes on to the surface.
- `useKeyScope` rebinds when an option other than a callback changes, so keep keymaps and selectors module constants. A
  ref root that mounts after the component is picked up.

## Cursors

- **Rows with focus**: `ROW_KEYS` is the keymap fragment. Mark rows `data-nav-row="item" | "group" | "toolbar" | "field"`, groups' wrappers
  `data-nav-group`, and call `runListMotion(container, motion, { count, start, onActivate })` and `runListScroll`. h and
  l walk trees, a toolbar row steps across its buttons, a field row starts typing on l, o or Enter. `listAction` is the
  pure version, `returnToRow(field, fallback)` the Escape out of a field (`returnToRowAfterFrame` when the box blurs
  itself a frame later), and `pageCursor`/`scrollKeepingCursor` the Ctrl-d/u pieces. Rows may nest (a message holding
  its fields); the cursor is the innermost row around focus.
- **A highlighted index** (focus stays put, as with `aria-activedescendant`): `stepIndex(length, current, motion,
  { count, pageSize, wrap })`, with `visibleRowCount(list)` for the page size. `stepWrapping` is n/N.
- **Things laid out in two dimensions**: `spatialStep(boxes, index, direction)`.
- **A pane with no cursor**: `scrollPane(pane, motion, { line, count, extent, scrollBy })`; `extent` is the height
  pages are measured against when something covers part of the pane.
- **Focus that waits for a mount**: `focusWhenShown(find, { timeoutMs })`.

## Widgets

- `createPickerKeys` / `usePickerKeys` for a select, combobox or switcher: a highlighted list and maybe a filter box.
  `list` takes j/k/gg/G/Ctrl-d/u, counts, Enter, `/` and `i` (with `openFilter`), Escape (`onListEscape`), plus the
  surface's own `keymap`. `filter` takes arrows and Ctrl-n/p, Enter, and Escape (`onFilterEscape`: clear the query, or
  go back to the list with it applied); everything else is typing. Put `data-vim-ignore` on the filter box so vim-mode
  leaves it alone. `keys.keymaps` is there for the tests. A Radix popover listens for Escape on the document in capture,
  before any React handler, so inside one its `onEscapeKeyDown` decides whether Escape closes it. For a picker with
  several cursors (columns, a preview), use `useKeyHandler` with a keymap function and `stepIndex` instead.
- `createMenuKeys()` (React: `useMenuKeys()`) on a Radix menu's content takes j/k/gg/G before Radix's typeahead; `stepMenu(menu, step)` is the
  same for a menu opened with focus left elsewhere.
- `createSearchBoxKeys({ commit, cancel, step, cancelOnEmptyBackspace })` (React: `useSearchBoxKeys`) for the box `/`
  opens.
- `compileSearch` (smartcase, `\<` `\>`, regex with a literal fallback), `matchOffsets`, `textRanges` (matches across
  element boundaries), `createSearchHighlights` (CSS highlights named per instance; `show` takes the current match as
  an index or a Range, and `css` is its rules for roots the head's sheet doesn't reach, with `{ sheet: false }` to add
  none) and `revealRange` are the pieces;
  `useTextSearch(scroller, content)` puts them together for a pane.

## Help

- `KeyHelp sections` (React) is the `?` dialog's grid (`className` replaces its two-column layout for a narrow
  container); put it in the plugin's own `Dialog`, with `useFocusReturn(open)` for `onAfterCloseAutoFocus`, since a
  dialog a key opened has no trigger to give focus back to. `Kbd` is one key cap, `size="small"` inside hint text, and
  `KeyHelp size="small"` is the grid at that size.
- `KeyHelp search` puts a search box over the list: `/` anywhere in the dialog holding it focuses the box, typing filters
  the list (`filterKeyHelp`: an entry's action or keys, or a section's title; smartcase, literal), Enter goes back to the
  keys keeping the filter, and Escape drops it without closing the dialog. Leave it off for a list shown inline on a page
  whose own `/` is in reach.
- `keysFor(keymap, match)` is the key bound to a command, for a hint strip that can't drift from the keymap.
- `renderKeyHelp(document, sections)` is the same list as plain DOM for content scripts.
- `unboundHelpKeys(sections, keymaps, elsewhere)` takes one keymap or several (a board and the card inside it).

## Living alongside vim-mode and bb

- vim-mode attaches to text boxes and listens in window capture. A box whose Escape or arrows must reach the plugin (a
  filter box, a search box) opts out with `data-vim-ignore`. In a box vim-mode does attach to, the first Escape leaves
  vim's insert mode and `onTextEscape` sees the second.
- Plugins coordinate through the DOM only: `defaultPrevented`, `data-vim-ignore`, and capture order. Two capture
  listeners on the same key run in mount order, so a content script taking body keys should step aside where vim-mode's
  scroll mode is active (a thread page) unless its own surface holds focus.
- Don't take keys bb or vim-mode already use: ⌘ chords, Ctrl-o/Ctrl-i (bb's back and forward), and Escape in bb's
  composer.

## Testing

- jsdom lays nothing out, so every row looks hidden: stub `Element.prototype.getClientRects` to return one rect, and
  `scrollIntoView` to do nothing. It has no `Element.scrollBy` either; `scrollPane` falls back to `scrollTop`.
- Test keymaps in node without React: keep them in a module that imports only `bb-vim-keys` (not `/react`), and assert
  `keymapConflicts` and `unboundHelpKeys` there. A picker's keymaps are on `createPickerKeys(...).keys.keymaps`.
- The library's own tests are `plugins/vim-mode/test/keys-lib*.test.ts`.
