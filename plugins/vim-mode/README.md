# bb-plugin-vim-mode

Vim keybindings for bb's prompt box and text boxes, powered by
[`@replit/codemirror-vim-core`](https://www.npmjs.com/package/@replit/codemirror-vim-core).

## Install

```sh
npm install
bb plugin install .
```

## Develop

```sh
npm test          # vim-core's shared 700+ test suite against each backend
npm run typecheck
bb plugin dev     # rebuild and reload on save
```

## Layout

- `src/vim/adapter.ts` implements the CodeMirror 5 editor interface the vim
  engine expects, on top of a plain-text `TextHost`.
- `src/vim/text-field-host.ts` backs `<textarea>` and `<input>`.
- `src/vim/codemirror-host.ts` backs CodeMirror 6 editors from other bundles
  through plain transaction specs.
- `src/vim/prosemirror-host.ts` backs TipTap/ProseMirror editors, such as the
  prompt box. Every line break maps to `\n` and each inline atom maps to one
  character.
- `src/vim/controller.ts` attaches to focused text boxes and routes keys.
- `src/vim/ui.ts` draws the block cursor and the status bar.
