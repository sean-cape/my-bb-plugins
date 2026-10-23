# Read this before working on any ticket

Low-stakes personal plugin work: speed over ceremony.

- **No review cycles.** Don't run code-review, don't spawn reviewer agents. One review happens at the end.
- **Tests: the essentials only**, in a NEW test file for your ticket (e.g. `plugins/diff-view/search.test.ts`), not in
  `plugins/diff-view/lib.test.ts`, so parallel tickets merge cleanly. The existing keymap tests (`keymapConflicts`,
  `unboundHelpKeys` in lib.test.ts) must still pass: every key you add goes in both `REVIEW_KEYMAP` and `KEY_HELP`.
- **Docs:** update the lines of `plugins/diff-view/README.md` (and `plugins/kanban/README.md` for kanban behaviour)
  your change makes wrong, plus a line for what's new. No rewrites.
- **Keys** are fixed in spec.md's table. Don't take other keys without saying so in your report.
- **Stay in your ticket.** Other tickets are being built in parallel in the same files (keymap.ts, review-commands.ts,
  diff-view.tsx, source.ts, types.ts): add to them, don't reorganise them.
- **Append, don't insert:** new `ReviewCommand` variants, `REVIEW_KEYMAP` entries, `KEY_HELP` rows and `switch`
  cases in `review-commands.ts` go at the END of their block or section, never mid-list.
- **Don't modify `plugins/vim-mode/lib`.** Compose its pieces as they are; if something is truly missing, say so in
  your report instead.
- **Code style:** match the surrounding code. Comments only for surprising, non-obvious behaviour (why, not what).
- **Aim for about 45 minutes.** If something outside the ticket blocks you, note it in your report and move on.

## Making the worktree runnable

bb runs the repository's `.bb-env-setup.sh` in each new worktree, which does this; in a worktree made before it, run
`bash .bb-env-setup.sh` from the root. By hand: a fresh worktree has no node_modules. Give each plugin a real `node_modules/` dir of symlinks to the main checkout's,
keeping main's relative links (`../../diff-view/lib` and the like) relative so the shared libs (`bb-diff-view`,
`bb-motion`, `bb-nerd-font`, `bb-vim-keys`) resolve to your worktree, and skipping `.vite`, `.vitest` and `.vite-temp`
(from the worktree root; add the plugins you need):

```sh
M=/Users/sean/dev/my-bb-plugins/plugins
for p in motion nerd-font vim-mode diff-view kanban; do mkdir -p plugins/$p/node_modules
  for e in $(command ls -A $M/$p/node_modules); do case $e in .vite|.vitest|.vite-temp) continue;; esac
    t=$(readlink "$M/$p/node_modules/$e"); case "$t" in ../../*) ln -sfn "$t" plugins/$p/node_modules/$e;; *) ln -sfn $M/$p/node_modules/$e plugins/$p/node_modules/$e;; esac
  done; done
```

Don't run `pnpm install`. Then, sandboxed:

- diff-view: `npx tsc -p tsconfig.json --noEmit` and `npx vitest run --configLoader runner` in `plugins/diff-view`
- kanban (if you touch it or the lib's types/source): the same in `plugins/kanban`

The node_modules dirs are real dirs and ignored by `.gitignore`; still check `git status` lists no `node_modules`
entry before committing.

## Committing

Commits are GPG-signed and the sandbox blocks `~/.gnupg`: run `git commit` with `dangerouslyDisableSandbox: true`. That is
expected and authorized. One git command per shell call, as `git -C <worktree path> …`. Commit message style: see
`git log` (a `diff-view:` or `kanban:` prefix and a sentence or two on behaviour).

If `git merge --ff-only <session branch>` fails at the start, use `git merge --no-edit <session branch>` instead.

Never push, merge, cherry-pick, build, install or reload plugins.
