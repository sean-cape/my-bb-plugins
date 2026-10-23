#!/usr/bin/env node
// Installs or upgrades everything in this repository on this machine: pulls the checkout, installs each plugin's
// dependencies, builds it, installs it into bb (or reloads it when bb already runs it from here), and links the
// Claude Code skills and subagents into ~/.claude.
//
//   node scripts/install.mjs                     # pull, then install or upgrade every plugin
//   node scripts/install.mjs kanban diff-view    # only these plugins (the Claude config is still linked)
//   node scripts/install.mjs --no-pull           # use the checkout as it is
//   node scripts/install.mjs --registry https://registry.npmjs.org/   # when ~/.npmrc points at a registry you can't reach
//
// Run it from the main checkout: bb runs path-installed plugins from where they were installed, so an install from a
// worktree breaks once the worktree is cleaned up. It keeps going past a plugin that fails and lists the failures at
// the end, exiting 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const registryIndex = args.indexOf("--registry");
const registry = registryIndex === -1 ? null : args[registryIndex + 1];
if (registryIndex !== -1 && (registry === undefined || registry.startsWith("--"))) {
  console.error("--registry needs a URL");
  process.exit(2);
}
const wanted = args.filter((arg, index) => !arg.startsWith("--") && (registryIndex === -1 || index !== registryIndex + 1));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: repo, encoding: "utf8", ...options });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(), error: result.error };
}

/** The last lines of a failed step's output, enough to see why without the whole log. */
const tail = (output) => output.split("\n").slice(-8).join("\n");

function gitPath(gitFlag) {
  const result = run("git", ["rev-parse", "--path-format=absolute", gitFlag]);
  return result.ok ? result.output : null;
}
const gitDir = gitPath("--git-dir");
if (gitDir !== null && gitDir !== gitPath("--git-common-dir")) {
  console.error(`${repo} is a git worktree; run this from the main checkout so bb's installs outlive it.`);
  process.exit(2);
}

for (const tool of ["bb", "pnpm", "npm"]) {
  const found = run(tool, ["--version"]);
  if (found.error !== undefined) {
    console.error(`${tool} isn't on PATH; install it first.`);
    process.exit(2);
  }
}

if (!flag("--no-pull")) {
  if (!run("git", ["rev-parse", "--abbrev-ref", "@{u}"]).ok) console.log("pull: skipped, the current branch has no upstream");
  else {
    // A fast-forward merge rather than `git pull`: with pull.rebase set, pull refuses to run beside any local change.
    const fetched = run("git", ["fetch"]);
    const pulled = fetched.ok ? run("git", ["merge", "--ff-only", "@{u}"]) : fetched;
    if (!pulled.ok) {
      console.error(`pull failed; fix the checkout or run with --no-pull:\n${tail(pulled.output)}`);
      process.exit(1);
    }
    console.log(`pull: ${pulled.output.split("\n").at(-1) || "up to date"}`);
  }
}

const manifest = JSON.parse(readFileSync(join(repo, ".bb", "plugins.json"), "utf8"));
const allPlugins = manifest.plugins.map(({ name, source }) => ({ name, dir: resolve(repo, source) }));
const plugins = allPlugins.filter(({ name }) => wanted.length === 0 || wanted.includes(name));
const unknown = wanted.filter((name) => !plugins.some((plugin) => plugin.name === name));
if (unknown.length > 0) {
  console.error(`not in .bb/plugins.json: ${unknown.join(", ")}`);
  process.exit(2);
}

const failures = [];
const fail = (plugin, step, output) => {
  failures.push(plugin.name);
  console.log(`${plugin.name}: ${step} failed\n${tail(output)}`);
};
const failed = (plugin) => failures.includes(plugin.name);

/** A plugin whose dist/ is committed ships prebuilt, so it has nothing to install or build. */
const prebuilt = (plugin) => run("git", ["ls-files", "--error-unmatch", join(plugin.dir, "dist")]).ok;

/** `npm ci` deletes node_modules before it fetches anything, so a registry failure would leave none; it only sets up a fresh one. */
const npmArgs = (dir) => (existsSync(join(dir, "node_modules")) ? ["install"] : ["ci"]);

// Every plugin's dependencies go in before any build, those of plugins not asked for too: the shared libraries
// (`plugins/*/lib`) resolve their own imports through the node_modules of the plugin that holds them.
for (const plugin of allPlugins) {
  if (prebuilt(plugin)) continue;
  let installed;
  if (existsSync(join(plugin.dir, "pnpm-lock.yaml"))) {
    installed = run("pnpm", ["install", "--frozen-lockfile", ...(registry === null ? [] : [`--config.registry=${registry}`])], { cwd: plugin.dir });
  } else if (existsSync(join(plugin.dir, "package-lock.json"))) {
    installed = run("npm", [...npmArgs(plugin.dir), "--no-audit", "--no-fund", ...(registry === null ? [] : [`--registry=${registry}`])], { cwd: plugin.dir });
  } else {
    installed = { ok: false, output: "no pnpm-lock.yaml or package-lock.json to install from" };
  }
  if (!installed.ok) fail(plugin, "dependency install", installed.output);
}

/** bb's installed plugins by id. */
function installedPlugins() {
  const listed = run("bb", ["plugin", "list", "--json"]);
  return new Map((listed.ok ? JSON.parse(listed.output).plugins : []).map((entry) => [entry.id, entry]));
}

const installedSources = new Map([...installedPlugins()].map(([id, entry]) => [id, entry.source]));
for (const plugin of plugins) {
  if (failed(plugin)) continue;
  if (!prebuilt(plugin)) {
    const built = run("bb", ["plugin", "build", plugin.dir]);
    if (!built.ok) {
      fail(plugin, "build", built.output);
      continue;
    }
  }
  const fromHere = installedSources.get(plugin.name) === `path:${plugin.dir}`;
  const loaded = fromHere ? run("bb", ["plugin", "reload", plugin.name]) : run("bb", ["plugin", "install", `path:${repo}`, "--plugin", plugin.name, "--yes"]);
  if (!loaded.ok) fail(plugin, fromHere ? "reload" : "install", loaded.output);
  else console.log(`${plugin.name}: ${fromHere ? (prebuilt(plugin) ? "reloaded" : "rebuilt and reloaded") : "installed"}`);
}

const linked = run("node", [join(repo, "scripts", "link-claude-config.mjs")]);
console.log(linked.ok ? `claude: ${linked.output.split("\n").at(-1)}` : `claude: linking failed\n${tail(linked.output)}`);
if (!linked.ok) failures.push("claude config");

const statuses = new Map([...installedPlugins()].map(([id, entry]) => [id, entry.status]));
const notRunning = plugins.filter((plugin) => !failed(plugin) && statuses.get(plugin.name) !== "running");
for (const plugin of notRunning) {
  failures.push(plugin.name);
  console.log(`${plugin.name}: ${statuses.get(plugin.name) ?? "not installed"} after loading; \`bb plugin list\` has the detail`);
}

if (failures.length > 0) {
  console.error(`\nFailed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${plugins.length} plugins are running from ${repo}.`);
