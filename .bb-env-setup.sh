#!/usr/bin/env bash
# bb runs this in each new worktree of this repository. A worktree starts without node_modules, and installing them
# in every checks, review and fix thread costs minutes (and the sandbox blocks pnpm's store), so each plugin gets a
# real node_modules directory of links to the main checkout's entries instead. Links that are relative in the main
# checkout (the shared bb-* libraries, `../../<plugin>/lib`) stay relative, so they resolve to this worktree's copies.
#
# Run `bash .bb-env-setup.sh` in an older worktree to do the same; plugins that already have node_modules are left alone.
set -euo pipefail

main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
[ "$main" = "$(pwd -P)" ] && exit 0

for source in "$main"/plugins/*/node_modules; do
  [ -d "$source" ] || continue
  plugin=plugins/$(basename "$(dirname "$source")")
  [ -d "$plugin" ] && [ ! -e "$plugin/node_modules" ] || continue
  mkdir "$plugin/node_modules"
  for entry in $(command ls -A "$source"); do
    # Vite's caches are per checkout, and the main checkout's read-only .vite-temp breaks vitest's config load.
    case $entry in .vite | .vitest | .vite-temp) continue ;; esac
    target=$(readlink "$source/$entry" || true)
    case $target in
      ../../*) ln -s "$target" "$plugin/node_modules/$entry" ;;
      *) ln -s "$source/$entry" "$plugin/node_modules/$entry" ;;
    esac
  done
done
