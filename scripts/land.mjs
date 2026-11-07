#!/usr/bin/env node
// Lands a thread branch's commits on main and installs what they touched: cherry-picks the commits main doesn't have
// yet into the main checkout, installs changed dependencies, typechecks and tests every touched plugin (and every
// plugin that builds on a touched shared library), then builds and reloads them through install.mjs.
//
//   node scripts/land.mjs                 # from a thread's worktree: land every commit of HEAD that main lacks
//   node scripts/land.mjs <sha>...        # only these commits, in this order
//   node scripts/land.mjs --dry-run       # list the commits and plugins, change nothing
//   node scripts/land.mjs --registry https://registry.npmjs.org/   # when ~/.npmrc points at a registry you can't reach
//
// Commit first: it lands commits, never the working tree. Run it outside the sandbox, which blocks the GPG signing of
// the cherry-picks and every write to the main checkout. It never pushes.
//
// Other sessions commit to main concurrently, which is why this cherry-picks rather than fast-forwarding. A branch that
// has merged main lands as one squashed commit instead, since its later commits can build on the merge's resolution.
// A conflict aborts either, so main is left as it was. Once commits are on main they stay there: a failed check stops
// before anything is built, and landing a fix from the branch later picks up only the fix, then installs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { libraryConsumers } from "./lib-consumers.mjs";

const MAIN_BRANCH = "main";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const registryIndex = args.indexOf("--registry");
const registry = registryIndex === -1 ? null : args[registryIndex + 1];
if (registryIndex !== -1 && (registry === undefined || registry.startsWith("--"))) stop("--registry needs a URL");
const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--dry-run" && arg !== "--registry");
if (unknownFlags.length > 0) stop(`unknown option ${unknownFlags.join(", ")}`);
const wantedShas = args.filter((arg, index) => !arg.startsWith("--") && (registryIndex === -1 || index !== registryIndex + 1));

function stop(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

const tail = (output, lines = 30) => output.split("\n").slice(-lines).join("\n");

const here = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
if (!here.ok) stop("not inside a git checkout");
const checkout = here.out;
const git = (...gitArgs) => run("git", gitArgs, checkout);
const main = dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir").out);
const gitMain = (...gitArgs) => run("git", gitArgs, main);

const mainHead = gitMain("symbolic-ref", "--short", "HEAD");
if (!mainHead.ok || mainHead.out !== MAIN_BRANCH) stop(`the main checkout ${main} is on ${mainHead.out || "a detached HEAD"}, not ${MAIN_BRANCH}`);
for (const marker of ["CHERRY_PICK_HEAD", "MERGE_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply"]) {
  if (existsSync(resolve(main, gitMain("rev-parse", "--git-path", marker).out))) {
    stop(`the main checkout ${main} is in the middle of another operation (${marker}); finish or abort it first`);
  }
}

const dirty = git("status", "--porcelain", "--untracked-files=no").out;
if (dirty !== "" && !dryRun) stop(`uncommitted changes in ${checkout}; commit them first:\n${dirty}`);
if (dirty !== "") console.log(`warning: uncommitted changes aren't landed:\n${dirty}\n`);
const untracked = git("ls-files", "--others", "--exclude-standard").out;
if (untracked !== "") console.log(`warning: untracked files aren't landed:\n${untracked}\n`);
const mainDirty = gitMain("status", "--porcelain", "--untracked-files=no").out;
if (mainDirty !== "" && !dryRun) stop(`the main checkout ${main} has uncommitted changes; land once they're committed or gone:\n${mainDirty}`);

const lines = (result) => result.out.split("\n").filter(Boolean);
const revList = (...revArgs) => lines(git("rev-list", ...revArgs));

/** Patch ids of the non-merge commits in a range, keyed by commit. */
function patchIds(range) {
  const log = spawnSync("git", ["log", "-p", "--no-merges", "--format=commit %H", range], { cwd: checkout, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const ids = spawnSync("git", ["patch-id", "--stable"], { cwd: checkout, input: log.stdout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return new Map(lines({ out: ids.stdout ?? "" }).map((line) => line.split(" ").reverse()));
}

/**
 * The branch's commits whose change main doesn't have yet, oldest first. A cherry-picked commit has a new id on main,
 * so landed ones are matched by patch id against main's commits since the branch forked. That fork point comes from
 * the branch's oldest commit, because once the branch has merged main, `main...HEAD` no longer reaches the
 * cherry-picks `git cherry` would compare against.
 */
function unlandedCommits() {
  const candidates = revList("--reverse", "--no-merges", `${MAIN_BRANCH}..HEAD`);
  if (candidates.length === 0) return [];
  const forkPoint = git("merge-base", MAIN_BRANCH, candidates[0]).out;
  const onMain = new Set(patchIds(`${forkPoint}..${MAIN_BRANCH}`).values());
  const ofBranch = patchIds(`${MAIN_BRANCH}..HEAD`);
  // A commit with no patch id (an empty one) has nothing to land.
  return candidates.filter((sha) => ofBranch.has(sha) && !onMain.has(ofBranch.get(sha)));
}

const shas = wantedShas.length > 0 ? wantedShas.map((sha) => git("rev-parse", "--verify", `${sha}^{commit}`)) : null;
if (shas?.some((sha) => !sha.ok)) stop(`not a commit: ${wantedShas.filter((_, index) => !shas[index].ok).join(", ")}`);
if (shas === null && checkout === main) stop(`${checkout} is the main checkout; run this from a thread's worktree, or name the commits`);
const commits = shas?.map((sha) => sha.out) ?? unlandedCommits();
if (commits.length === 0) {
  console.log("nothing to land: main already has every commit of HEAD");
  process.exit(0);
}

const isMerge = (sha) => revList("--no-walk", "--min-parents=2", sha).length > 0;
const named = commits.filter(isMerge);
if (named.length > 0) stop(`merge commits can't be landed one by one: ${named.map((sha) => sha.slice(0, 7)).join(", ")}`);
// Commits after a merge of main can build on its resolution, so cherry-picking them alone would conflict or drop it.
const squash = shas === null && revList("--merges", `${MAIN_BRANCH}..HEAD`).length > 0;
// A squashed landing has no patch id to match later, so judge it by content: merging the branch would change nothing.
if (squash && git("merge-tree", "--write-tree", MAIN_BRANCH, "HEAD").out.split("\n")[0] === git("rev-parse", `${MAIN_BRANCH}^{tree}`).out) {
  console.log("nothing to land: main already has the branch's changes");
  process.exit(0);
}

const subject = (sha) => git("log", "-1", "--format=%h %s", sha).out.slice(0, 120);
console.log(`Landing ${commits.length} commit${commits.length === 1 ? "" : "s"} on ${MAIN_BRANCH} in ${main}${squash ? " as one commit, since the branch has merged main" : ""}:`);
for (const sha of commits) console.log(`  ${subject(sha)}`);

/** What the commits touch, by plugin directory under `root`'s plugins/. */
function plan(files, root) {
  const isPlugin = (dir) => existsSync(join(root, "plugins", dir, "package.json"));
  const touched = new Set();
  const libraries = new Set();
  const dependencies = new Set();
  for (const file of files) {
    const [top, dir, sub, leaf] = file.split("/");
    if (top !== "plugins" || dir === undefined || !isPlugin(dir)) continue;
    touched.add(dir);
    if (sub === "lib" && leaf !== undefined) libraries.add(`${dir}/lib`);
    if (["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package-lock.json"].includes(sub) && leaf === undefined) dependencies.add(dir);
  }
  const consumers = libraries.size > 0 ? libraryConsumers(root, [...libraries]) : [];
  const checked = [...new Set([...touched, ...consumers])].sort();
  return { checked, dependencies: [...dependencies], libraries: [...libraries], claude: files.some((file) => file.startsWith("claude/")) };
}

const filesOf = (range) => git("diff", "--name-only", ...range).out.split("\n").filter(Boolean);

if (dryRun) {
  const files = [...new Set(commits.flatMap((sha) => filesOf([`${sha}^`, sha])))];
  const { checked, dependencies, libraries } = plan(files, checkout);
  console.log(`\nWould check and install: ${checked.join(", ") || "no plugins"}`);
  if (libraries.length > 0) console.log(`  (${libraries.join(", ")} changed, so every plugin built on it is included)`);
  if (dependencies.length > 0) console.log(`Would install dependencies first in: ${dependencies.join(", ")}`);
  process.exit(0);
}

const before = gitMain("rev-parse", "HEAD").out;
const conflictsReason = (output) => {
  const conflicted = gitMain("diff", "--name-only", "--diff-filter=U").out;
  return conflicted !== "" ? `conflicts in:\n${conflicted}` : tail(output);
};
if (squash) {
  // The branch's net change since the main it last merged, three-way merged onto main as it is now.
  const merged = gitMain("merge", "--squash", "--no-commit", git("rev-parse", "HEAD").out);
  if (!merged.ok) {
    const reason = conflictsReason(merged.output);
    gitMain("reset", "--merge");
    stop(`merging the branch failed, so ${MAIN_BRANCH} is left as it was; ${reason}\nMerge ${MAIN_BRANCH} into the branch again, resolve there, then land again.`, 1);
  }
  if (gitMain("diff", "--cached", "--quiet").ok) {
    console.log(`nothing to land: ${MAIN_BRANCH} already has the branch's changes`);
    process.exit(0);
  }
  const message = commits.map((sha) => git("log", "-1", "--format=%B", sha).out.trim()).join("\n\n");
  const committed = spawnSync("git", ["commit", "-F", "-"], { cwd: main, input: message, encoding: "utf8" });
  if (committed.status !== 0) {
    gitMain("reset", "--merge");
    stop(`committing on ${MAIN_BRANCH} failed, so it is left as it was:\n${tail(`${committed.stdout}${committed.stderr}`)}`, 1);
  }
} else {
  const picked = gitMain("cherry-pick", "--empty=drop", ...commits);
  if (!picked.ok) {
    const reason = conflictsReason(picked.output);
    if (existsSync(resolve(main, gitMain("rev-parse", "--git-path", "CHERRY_PICK_HEAD").out))) gitMain("cherry-pick", "--abort");
    stop(`cherry-pick failed, so ${MAIN_BRANCH} is left as it was; ${reason}\nRun \`git rebase ${MAIN_BRANCH}\` on the branch, resolve there, then land again.`, 1);
  }
}
const after = gitMain("rev-parse", "HEAD").out;
const landed = gitMain("rev-list", "--count", `${before}..${after}`).out;
console.log(`\n${MAIN_BRANCH}: ${before.slice(0, 7)}..${after.slice(0, 7)} (${landed} new commit${landed === "1" ? "" : "s"})`);

const { checked, dependencies, claude } = plan(gitMain("diff", "--name-only", before, after).out.split("\n").filter(Boolean), main);
const pluginDir = (dir) => join(main, "plugins", dir);

const registryArgs = registry === null ? [] : [`--config.registry=${registry}`];
for (const dir of dependencies) {
  // Without a TTY pnpm can't ask before deleting node_modules, and aborts unless told not to ask.
  const installed = existsSync(join(pluginDir(dir), "pnpm-lock.yaml"))
    ? run("pnpm", ["install", "--frozen-lockfile", "--config.confirm-modules-purge=false", ...registryArgs], pluginDir(dir))
    : run("npm", ["install", "--no-audit", "--no-fund", ...(registry === null ? [] : [`--registry=${registry}`])], pluginDir(dir));
  if (!installed.ok) stop(`${dir}: dependency install failed; the commits are on ${MAIN_BRANCH}, nothing was built\n${tail(installed.output)}`, 1);
  console.log(`${dir}: dependencies installed`);
}

const failures = [];
for (const dir of checked) {
  const scripts = JSON.parse(readFileSync(join(pluginDir(dir), "package.json"), "utf8")).scripts ?? {};
  for (const script of ["typecheck", "test"]) {
    if (scripts[script] === undefined) continue;
    const result = run("pnpm", ["run", "--silent", script], pluginDir(dir));
    console.log(`${result.ok ? "ok    " : "failed"} ${dir} ${script}`);
    if (!result.ok) failures.push(`${dir} ${script}\n${tail(result.output, 40)}`);
  }
}
if (failures.length > 0) {
  stop(`\n${failures.join("\n\n")}\n\nChecks failed, so nothing was built or reloaded. The commits are on ${MAIN_BRANCH}; commit a fix on the branch and land again.`, 1);
}

const manifest = JSON.parse(readFileSync(join(main, ".bb", "plugins.json"), "utf8"));
const nameOf = new Map(manifest.plugins.map(({ name, source }) => [resolve(main, source), name]));
const unlisted = checked.filter((dir) => !nameOf.has(pluginDir(dir)));
if (unlisted.length > 0) console.log(`warning: not in .bb/plugins.json, so not installed: ${unlisted.join(", ")}`);
const names = checked.map((dir) => nameOf.get(pluginDir(dir))).filter(Boolean);

if (names.length === 0) {
  if (claude) {
    const linked = run("node", [join(main, "scripts", "link-claude-config.mjs")], main);
    console.log(linked.ok ? `claude: ${linked.out.split("\n").at(-1)}` : `claude: linking failed\n${tail(linked.output)}`);
    process.exit(linked.ok ? 0 : 1);
  }
  console.log("No plugins to install.");
  process.exit(0);
}

console.log("");
const installArgs = [join(main, "scripts", "install.mjs"), "--no-pull", ...(registry === null ? [] : ["--registry", registry]), ...names];
const installed = spawnSync("node", installArgs, { cwd: main, stdio: "inherit" });
process.exit(installed.status ?? 1);
