// Which plugins build on a shared library (`plugins/<plugin>/lib`), for check-lib-consumers.mjs and land.mjs.
//
// A consumer is a plugin whose package.json links the library, or whose source imports it by relative path
// (diff-view's library does, because other plugins bundle it). The plugin that holds the library counts too.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

const SOURCE = /\.(ts|tsx|mts)$/;
const SKIP = new Set(["node_modules", "dist", ".bb", ".git"]);

function* sources(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (SOURCE.test(entry)) yield path;
  }
}

function consumes(pluginsDir, plugin, library) {
  if (library.split("/")[0] === plugin) return true;
  const manifest = readFileSync(join(pluginsDir, plugin, "package.json"), "utf8");
  if (manifest.includes(`../${library}"`)) return true;
  const target = join(pluginsDir, library) + sep;
  for (const file of sources(join(pluginsDir, plugin))) {
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      if (join(dirname(file), specifier).startsWith(target)) return true;
    }
  }
  return false;
}

/** Accepts `vim-mode/lib`, `plugins/vim-mode/lib` or `plugins/vim-mode/lib/`. */
export const libraryName = (arg) => arg.replace(/^plugins\//, "").replace(/\/$/, "");

/** Plugin directory names under `<repo>/plugins` that build on any of `libraries` (each `<plugin>/lib`). */
export function libraryConsumers(repo, libraries) {
  const pluginsDir = join(repo, "plugins");
  const plugins = readdirSync(pluginsDir).filter((name) => existsSync(join(pluginsDir, name, "package.json")));
  return plugins.filter((plugin) => libraries.some((library) => consumes(pluginsDir, plugin, library)));
}
