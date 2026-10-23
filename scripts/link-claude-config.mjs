#!/usr/bin/env node
// Links the Claude Code skills and subagents in claude/ into ~/.claude, so the kanban board's review
// threads (and Claude Code anywhere else on the machine) use the ones in this repository.
//
//   node scripts/link-claude-config.mjs            # link everything, backing up what it replaces
//   node scripts/link-claude-config.mjs --check    # list what isn't linked yet, change nothing
//
// The code-review skill's agents read reviewer.md and verifier.md beside it and it reads triage-criteria.md,
// so the skills are linked together. Without the skill, Claude Code's own plugin skill of the same name
// answers instead, and its report is one the board can't read. A link whose source left this repository
// (a removed skill or subagent) is pruned, so Claude Code doesn't load a dangling entry.
//
// Run it from the main checkout: a link into a worktree breaks once the worktree is cleaned up.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes("--check");
const claudeDir = join(homedir(), ".claude");

function gitPath(flag) {
  const result = spawnSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", flag], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
const gitDir = gitPath("--git-dir");
if (gitDir !== null && gitDir !== gitPath("--git-common-dir")) {
  console.error(`${repo} is a git worktree; run this from the main checkout so the links outlive it.`);
  process.exit(2);
}

/** Each entry to link: the skills' directories and loose files, and the subagent files. */
const kinds = ["skills", "agents"];
const links = kinds.flatMap((kind) =>
  (existsSync(join(repo, "claude", kind)) ? readdirSync(join(repo, "claude", kind)) : [])
    .filter((name) => !name.startsWith("."))
    .map((name) => ({ source: join(repo, "claude", kind, name), target: join(claudeDir, kind, name), label: `${kind}/${name}` })),
);

const linkTarget = (path) => {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : null;
  } catch {
    return null;
  }
};

// Backups go outside skills/ and agents/: a copied skill directory left there would load as a second skill of the same name.
const backupDir = join(claudeDir, "backups", `link-claude-config-${new Date().toISOString().replace(/[:.]/g, "-")}`);
let pending = 0;
for (const { source, target, label } of links) {
  if (linkTarget(target) === source) continue;
  pending += 1;
  const exists = existsSync(target) || linkTarget(target) !== null;
  if (check) {
    console.log(`${label}: ${exists ? "not linked to this repository" : "missing"}`);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  if (exists) {
    if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
    else {
      const backup = join(backupDir, label);
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(target, backup);
      console.log(`${label}: moved the existing copy to ${backup}`);
    }
  }
  symlinkSync(source, target);
  console.log(`${label}: linked`);
}
// Links into this repository whose source is gone: a skill or subagent a commit removed.
const stale = kinds.flatMap((kind) => {
  const dir = join(claudeDir, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ target: join(dir, name), label: `${kind}/${name}` }))
    .filter(({ target }) => {
      const source = linkTarget(target);
      return source !== null && source.startsWith(join(repo, "claude") + "/") && !existsSync(source);
    });
});
for (const { target, label } of stale) {
  pending += 1;
  if (check) {
    console.log(`${label}: links to a file this repository no longer has`);
    continue;
  }
  unlinkSync(target);
  console.log(`${label}: removed the dangling link`);
}
if (pending === 0) console.log(`Everything in ${join(repo, "claude")} is linked into ${claudeDir}.`);
else if (check) process.exit(1);
