#!/usr/bin/env node
// Typechecks and tests every plugin that builds on a shared library, since a library change
// reaches all of them through a live link and each plugin's own checks only cover itself.
//
//   node scripts/check-lib-consumers.mjs vim-mode/lib        # bb-vim-keys
//   node scripts/check-lib-consumers.mjs motion/lib diff-view/lib
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { libraryConsumers, libraryName } from "./lib-consumers.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginsDir = join(repo, "plugins");
const libraries = process.argv.slice(2).map(libraryName);
if (libraries.length === 0) {
  console.error("usage: check-lib-consumers.mjs <plugin>/lib [...]");
  process.exit(2);
}

const consumers = libraryConsumers(repo, libraries);

function run(plugin, script) {
  const scripts = JSON.parse(readFileSync(join(pluginsDir, plugin, "package.json"), "utf8")).scripts ?? {};
  if (scripts[script] === undefined) return { status: "none" };
  const result = spawnSync("pnpm", ["run", "--silent", script], { cwd: join(pluginsDir, plugin), encoding: "utf8" });
  return { status: result.status === 0 ? "ok" : "failed", output: `${result.stdout}${result.stderr}` };
}

let failed = false;
for (const plugin of consumers) {
  for (const script of ["typecheck", "test"]) {
    const result = run(plugin, script);
    console.log(`${result.status.padEnd(6)} ${plugin} ${script}`);
    if (result.status === "failed") {
      failed = true;
      console.log(result.output.trim().split("\n").slice(-40).join("\n"));
    }
  }
}
console.log(`\n${consumers.length} plugins build on ${libraries.join(", ")}: ${consumers.join(", ")}`);
process.exit(failed ? 1 : 0);
