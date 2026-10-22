// Server-side diff pieces shared by every plugin that shows the diff view: parsing unified diffs, reading an
// environment's changes (all of them, or a range of its commits) and a file's sides, running difftastic, searching a
// checkout for symbols, blame, applying suggested changes to a checkout, and a short-lived cache for diff reads.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { SuggestionConflictError, applySuggestionsToText, suggestionFileText, suggestionsByPath } from "./suggestions";
import {
  COMMIT_SHA_PATTERN,
  WORKTREE_SHA,
  type BlameLine,
  type CommitRange,
  type DiffCommit,
  type DiffCommits,
  type DiffFile,
  type DiffResult,
  type DiffSide,
  type FileSlice,
  type FileSides,
  type StructuralDiff,
  type SuggestionItem,
  type SuggestionsApplied,
  type SymbolDefinition,
  type SymbolUsages,
} from "./types";

const execFileAsync = promisify(execFile);

type Sdk = BbPluginApi["sdk"];

const VENDORED_PATH = /(^|\/)(vendor|node_modules|third_party|third-party|bower_components|\.yarn|Pods|Carthage\/Checkouts)\//u;

export function isVendoredPath(path: string): boolean {
  return VENDORED_PATH.test(path);
}

export function splitUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = diff.split(/^(?=diff --git )/mu).filter((chunk) => chunk.trim() !== "");
  for (const chunk of chunks) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/mu.exec(chunk);
    const plus = /^\+\+\+ (?:b\/)?(.+)$/mu.exec(chunk)?.[1] ?? null;
    const minus = /^--- (?:a\/)?(.+)$/mu.exec(chunk)?.[1] ?? null;
    const path = plus !== null && plus !== "/dev/null" ? plus : (header?.[2] ?? minus ?? "unknown");
    const previousPath = header !== null && header[1] !== header[2] ? header[1] : null;
    const status =
      minus === "/dev/null" || /^new file mode/mu.test(chunk)
        ? "added"
        : plus === "/dev/null" || /^deleted file mode/mu.test(chunk)
          ? "removed"
          : previousPath !== null
            ? "renamed"
            : "modified";
    let additions = 0;
    let deletions = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    // `git diff --binary` (which bb's SDK runs) writes a "GIT binary patch" instead of the "Binary files" line.
    const binary = /^(Binary files |GIT binary patch)/mu.test(chunk);
    const noText = binary || !/^@@/mu.test(chunk);
    files.push({ path, previousPath, status, additions, deletions, patch: noText ? null : chunk, vendored: isVendoredPath(path), binary });
  }
  return files;
}

/** Drops vendored files from a diff, counting what was left out. */
export function hideVendoredFiles(diff: DiffResult): DiffResult {
  const vendored = diff.files.filter((file) => file.vendored);
  if (vendored.length === 0) return diff;
  return {
    ...diff,
    files: diff.files.filter((file) => !file.vendored),
    hiddenVendored: {
      files: vendored.length,
      additions: vendored.reduce((sum, file) => sum + file.additions, 0),
      deletions: vendored.reduce((sum, file) => sum + file.deletions, 0),
    },
  };
}

export function emptyDiff(source: DiffResult["source"], message: string): DiffResult {
  return { source, files: [], baseRef: null, baseSha: null, headSha: null, truncated: false, message, fetchedAt: Date.now(), hiddenVendored: null, repo: null, environmentId: null };
}

/** Everything on the environment's branch since it diverged when the merge base is known, else just the working tree. */
export async function environmentDiff(sdk: Sdk, environmentId: string): Promise<DiffResult> {
  const environment = await sdk.environments.get({ environmentId });
  const result = await sdk.environments.diff(
    environment.mergeBaseBranch !== null
      ? { environmentId, target: "all", mergeBaseBranch: environment.mergeBaseBranch }
      : { environmentId, target: "uncommitted" },
  );
  if (result.outcome !== "available") {
    return emptyDiff("environment", result.outcome === "not_applicable" ? result.message : result.failure.message);
  }
  const diff: DiffResult = {
    source: "environment",
    files: splitUnifiedDiff(result.diff.diff),
    baseRef: result.diff.mergeBaseRef,
    baseSha: null,
    headSha: null,
    truncated: result.diff.truncated,
    message: null,
    fetchedAt: Date.now(),
    hiddenVendored: null,
    repo: await environmentRepo(sdk, environmentId),
    environmentId,
  };
  if (!diff.truncated) return diff;
  const local = await localEnvironmentDiff(sdk, environmentId, result.diff.mergeBaseRef).catch(() => null);
  if (local !== null) return { ...diff, files: local, truncated: false };
  return withUnlistedFiles(diff, result.diff.files);
}

const LOCAL_DIFF_MAX_BUFFER = 256 * 1024 * 1024;
const LOCAL_DIFF_TIMEOUT_MS = 120_000;
/** For git commands that answer at once: a remote's URL, a merge base, a rev-parse. */
const GIT_QUICK_TIMEOUT_MS = 10_000;
// quotepath off, so a non-ASCII path comes out as itself rather than quoted octal bytes.
const GIT_DIFF = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff"];
const UNTRACKED_DIFF_CONCURRENCY = 8;

function localGitOptions(cwd: string) {
  return { cwd, maxBuffer: LOCAL_DIFF_MAX_BUFFER, timeout: LOCAL_DIFF_TIMEOUT_MS };
}

/** A diff with no commits to pick from. */
export function noCommits(): DiffCommits {
  return { commits: [], marks: [], base: null };
}

/**
 * The same diff as bb's SDK gives (against the merge base, or HEAD for uncommitted changes, untracked files included)
 * read straight from a checkout on this machine, without the SDK's size cap; null when the checkout is elsewhere.
 */
export async function localEnvironmentDiff(sdk: Sdk, environmentId: string, mergeBaseRef: string | null): Promise<DiffFile[] | null> {
  const dir = await localEnvironmentPath(sdk, environmentId);
  if (dir === null) return null;
  return checkoutDiff(dir, mergeBaseRef ?? "HEAD", null);
}

/** `git diff from to` in a checkout; a null `to` is the working tree, untracked files included. */
async function checkoutDiff(dir: string, from: string, to: string | null): Promise<DiffFile[]> {
  const options = localGitOptions(dir);
  if (to !== null) return splitUnifiedDiff((await execFileAsync("git", [...GIT_DIFF, "-M", from, to, "--"], options)).stdout);
  const [{ stdout: tracked }, { stdout: untrackedList }] = await Promise.all([
    execFileAsync("git", [...GIT_DIFF, "-M", from, "--"], options),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], options),
  ]);
  const untracked = untrackedList.split("\0").filter((path) => path !== "");
  const patches: string[] = [];
  for (let start = 0; start < untracked.length; start += UNTRACKED_DIFF_CONCURRENCY) {
    const batch = untracked.slice(start, start + UNTRACKED_DIFF_CONCURRENCY);
    patches.push(...(await Promise.all(batch.map((path) => gitDiffNoIndex(["/dev/null", path], dir).catch(() => "")))));
  }
  return splitUnifiedDiff([tracked, ...patches].join("\n"));
}

/**
 * A truncated SDK diff with the files its `--name-status` list names but its cut-off text left out, each without a
 * patch so the view offers to load it, and a note saying what is missing.
 */
export function withUnlistedFiles(diff: DiffResult, nameStatus: string): DiffResult {
  const listed = parseNameStatus(nameStatus);
  const present = new Set(diff.files.map((file) => file.path));
  const unlisted = listed.filter((file) => !present.has(file.path));
  if (unlisted.length === 0) {
    return { ...diff, truncatedNote: "bb cut this diff at its size limit, and there is no local checkout to read the whole diff from; some changes may be missing." };
  }
  // The text stops partway through its last file.
  const files = diff.files.map((file, index) => (index === diff.files.length - 1 ? { ...file, patch: null } : file));
  const missing = unlisted.length + (diff.files.length > 0 ? 1 : 0);
  return {
    ...diff,
    files: [...files, ...unlisted],
    truncatedNote: `bb cut this diff at its size limit, and there is no local checkout to read the whole diff from: ${missing} of ${files.length + unlisted.length} files came without their changes. Load each one's diff from its section.`,
  };
}

const NAME_STATUS: Record<string, string> = { A: "added", D: "removed", R: "renamed", C: "copied" };

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A path as git prints it: as is, or in double quotes with C escapes and each byte of a non-ASCII character in octal. */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  const body = path.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; ) {
    if (body[index] === "\\") {
      const octal = /^[0-7]{3}/u.exec(body.slice(index + 1, index + 4));
      if (octal !== null) {
        bytes.push(Number.parseInt(octal[0], 8));
        index += 4;
        continue;
      }
      const escaped = C_ESCAPES[body[index + 1] ?? ""];
      if (escaped !== undefined) {
        bytes.push(escaped);
        index += 2;
        continue;
      }
    }
    const char = String.fromCodePoint(body.codePointAt(index)!);
    bytes.push(...Buffer.from(char, "utf8"));
    index += char.length;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `git diff --name-status` output (not `-z`) as patchless files. */
function parseNameStatus(text: string): DiffFile[] {
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((fields) => fields.length >= 2 && /^[A-Z]/u.test(fields[0]!))
    .map((fields) => {
      const renamed = fields.length >= 3;
      const path = unquoteGitPath(renamed ? fields[2]! : fields[1]!);
      return { path, previousPath: renamed ? unquoteGitPath(fields[1]!) : null, status: NAME_STATUS[fields[0]![0]!] ?? "modified", additions: 0, deletions: 0, patch: null, vendored: isVendoredPath(path) };
    });
}

/** `git diff --no-index` output, which exits 1 when the files differ. */
async function gitDiffNoIndex(paths: [string, string], cwd: string): Promise<string> {
  try {
    return (await execFileAsync("git", [...GIT_DIFF, "--no-index", "--", ...paths], localGitOptions(cwd))).stdout;
  } catch (error) {
    const failed = error as { code?: number; stdout?: unknown };
    if (failed.code === 1 && typeof failed.stdout === "string") return failed.stdout;
    throw error;
  }
}

/**
 * One file's unified patch made from its two sides (null: the file does not exist on that side), headed with its real
 * paths as `git diff` would write them; null when the sides are the same or git finds them binary.
 */
export async function patchFromSides(path: string, previousPath: string | null, oldText: string | null, newText: string | null): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "diff-view-patch-"));
  try {
    await writeFile(join(dir, "old"), oldText ?? "");
    await writeFile(join(dir, "new"), newText ?? "");
    const output = await gitDiffNoIndex(["old", "new"], dir);
    const hunks = output.search(/^@@/mu);
    if (hunks === -1) return null;
    const from = previousPath ?? path;
    const header = [`diff --git a/${from} b/${path}`];
    if (oldText === null) header.push("new file mode 100644");
    else if (newText === null) header.push("deleted file mode 100644");
    else if (from !== path) header.push(`rename from ${from}`, `rename to ${path}`);
    header.push(oldText === null ? "--- /dev/null" : `--- a/${from}`, newText === null ? "+++ /dev/null" : `+++ b/${path}`);
    return `${header.join("\n")}\n${output.slice(hunks)}`;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `git@github.com:owner/repo.git`, `https://github.com/owner/repo` and friends → `owner/repo` (lowercased), or null. */
export function githubRepoFromRemote(remote: string | null): string | null {
  if (remote === null) return null;
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(remote.trim());
  return match === null ? null : `${match[1]}/${match[2]}`.toLowerCase();
}

/** The GitHub repository a checkout's `origin` remote points at, or null. */
export async function checkoutGithubRepo(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: dir, timeout: GIT_QUICK_TIMEOUT_MS });
    return githubRepoFromRemote(stdout);
  } catch {
    return null;
  }
}

/** The GitHub repository of an environment whose checkout is on this machine; null for any other. */
async function environmentRepo(sdk: Sdk, environmentId: string): Promise<string | null> {
  try {
    const dir = await localEnvironmentPath(sdk, environmentId);
    return dir === null ? null : await checkoutGithubRepo(dir);
  } catch {
    return null;
  }
}

/**
 * Both sides of one file of an environment diff, as text; null for a side that does not exist or is binary.
 * `mergeBaseRef` is the diff's resolved merge-base sha (`DiffResult.baseRef`), not a branch name.
 */
export async function environmentFileSides(sdk: Sdk, environmentId: string, file: DiffFile, mergeBaseRef: string | null): Promise<FileSides> {
  const read = async (side: "old" | "new"): Promise<string | null> => {
    if (side === "old" && file.status === "added") return null;
    if (side === "new" && file.status === "removed") return null;
    const path = side === "old" ? (file.previousPath ?? file.path) : file.path;
    try {
      const result = await sdk.environments.diffFile(
        mergeBaseRef !== null ? { environmentId, path, side, target: "all", mergeBaseRef } : { environmentId, path, side, target: "uncommitted" },
      );
      return result.contentEncoding === "base64" ? Buffer.from(result.content, "base64").toString("utf8") : result.content;
    } catch {
      return null;
    }
  };
  return { old: await read("old"), new: await read("new") };
}

/** A checkout's directory on this server machine, or null when the environment lives on another host. */
export async function localEnvironmentPath(sdk: Sdk, environmentId: string): Promise<string | null> {
  const [config, environment] = await Promise.all([sdk.system.config(), sdk.environments.get({ environmentId })]);
  // Loose on purpose: `workspacePath` is not in the SDK's types but is read first, and test fakes omit `path` and `hostId`.
  const loose = environment as { workspacePath?: string | null; path?: string | null; hostId?: string | null };
  const path = loose.workspacePath ?? loose.path ?? null;
  const hostId = loose.hostId ?? null;
  return path === null || (hostId !== null && hostId !== config.primaryHostId) ? null : path;
}

interface DifftLine {
  line_number: number;
  changes: Array<{ start: number; end: number; content: string; highlight: string }>;
}
interface DifftOutput {
  language?: string;
  status?: string;
  chunks?: Array<Array<{ lhs?: DifftLine | null; rhs?: DifftLine | null }>>;
  aligned_lines?: Array<[number | null, number | null]>;
}

export function structuralUnavailable(reason: string): StructuralDiff {
  return { available: false, reason, language: null, status: null, oldText: "", newText: "", aligned: [], oldChanges: [], newChanges: [] };
}

/** difftastic's syntax-aware diff of two versions of `path`; a null side is a file that does not exist there. */
export async function runDifftastic(difftPath: string, path: string, sides: FileSides): Promise<StructuralDiff> {
  if (isVendoredPath(path)) return structuralUnavailable("Vendored file; the structural diff skips these.");
  const base: StructuralDiff = { ...structuralUnavailable(""), reason: null, oldText: sides.old ?? "", newText: sides.new ?? "" };
  if (sides.old === null && sides.new === null) return { ...base, reason: "This file has no text content on either side (binary or oversized)." };
  const dir = await mkdtemp(join(tmpdir(), "diff-view-difft-"));
  try {
    const name = basename(path) || "file";
    const oldFile = join(dir, `old-${name}`);
    const newFile = join(dir, `new-${name}`);
    await writeFile(oldFile, sides.old ?? "");
    await writeFile(newFile, sides.new ?? "");
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(difftPath, ["--display", "json", "--context", "3", "--color", "never", oldFile, newFile], {
        // The default parse-error limit of 0 drops to a text diff whenever the grammar lags the language
        // (e.g. Go 1.26 `new(expr)`); tree-sitter recovers from errors well enough to keep the structural view.
        env: { ...process.env, DFT_UNSTABLE: "yes", DFT_PARSE_ERROR_LIMIT: "10000" },
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (error) {
      const code = (error as { code?: string }).code;
      const reason =
        code === "ENOENT"
          ? `difftastic was not found at \`${difftPath}\`. Install it with \`brew install difftastic\` (or set the difftastic binary setting).`
          : `difftastic failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
      return { ...base, reason };
    }
    let parsed: DifftOutput;
    try {
      parsed = JSON.parse(stdout) as DifftOutput;
    } catch {
      return { ...base, reason: "difftastic returned output that was not JSON; is it an older version without `--display json`?" };
    }
    const oldLines = (sides.old ?? "").split("\n").length;
    const newLines = (sides.new ?? "").split("\n").length;
    const pairs = (parsed.chunks ?? []).flat();
    // difftastic's JSON uses 0-based line numbers; guard against a build that already emits 1-based ones.
    const numbers = [...pairs.flatMap((pair) => [pair.lhs?.line_number, pair.rhs?.line_number]), ...(parsed.aligned_lines ?? []).flat()].filter((n): n is number => typeof n === "number");
    const zeroBased = numbers.length === 0 || numbers.some((n) => n === 0) || Math.max(...numbers) < Math.max(oldLines, newLines);
    const shift = (n: number | null | undefined): number | null => (typeof n === "number" ? n + (zeroBased ? 1 : 0) : null);
    const collect = (side: "lhs" | "rhs"): StructuralDiff["oldChanges"] => {
      const byLine = new Map<number, StructuralDiff["oldChanges"][number]>();
      for (const pair of pairs) {
        const line = pair[side];
        if (line === null || line === undefined) continue;
        const number = shift(line.line_number)!;
        const entry = byLine.get(number) ?? { line: number, changes: [] };
        entry.changes.push(...line.changes.map((change) => ({ start: change.start, end: change.end, highlight: change.highlight })));
        byLine.set(number, entry);
      }
      return [...byLine.values()].sort((a, b) => a.line - b.line);
    };
    // difftastic emits no alignment and no chunks for a created or deleted file: every line is the change.
    const wholeFile: StructuralDiff["aligned"] | null =
      sides.old === null || sides.old === "" ? Array.from({ length: newLines }, (_, i) => [null, i + 1] as [number | null, number | null])
      : sides.new === null || sides.new === "" ? Array.from({ length: oldLines }, (_, i) => [i + 1, null] as [number | null, number | null])
      : null;
    // Older difftastic builds lack aligned_lines; fall back to the changed pairs alone, which loses context but still renders.
    const aligned: StructuralDiff["aligned"] =
      wholeFile ??
      (parsed.aligned_lines ?? pairs.map((pair) => [pair.lhs?.line_number ?? null, pair.rhs?.line_number ?? null] as [number | null, number | null]))
        .map(([lhs, rhs]) => [shift(lhs), shift(rhs)] as [number | null, number | null])
        .filter(([lhs, rhs]) => (lhs === null || lhs <= oldLines) && (rhs === null || rhs <= newLines) && !(lhs === null && rhs === null));
    const status = parsed.status === "unchanged" || parsed.status === "changed" || parsed.status === "created" || parsed.status === "deleted" ? parsed.status : "changed";
    return { ...base, available: true, language: parsed.language ?? null, status, aligned, oldChanges: collect("lhs"), newChanges: collect("rhs") };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Lines of context returned around each definition, for the inline peek. */
const PEEK_BEFORE = 2;
const PEEK_AFTER = 18;
const DEFINITION_LIMIT = 40;
const USAGE_LIMIT = 300;
const GIT_GREP_TIMEOUT_MS = 15_000;
const GIT_BLAME_TIMEOUT_MS = 15_000;

interface GrepHit {
  path: string;
  line: number;
  snippet: string;
}

/** Lines `[from, to]` (1-based, clamped) of a file in a checkout, or null when unreadable. */
export async function fileSlice(dir: string, path: string, from: number, to: number): Promise<FileSlice | null> {
  try {
    const text = await readFile(join(dir, path), "utf8");
    const all = text.split("\n");
    const start = Math.max(1, from);
    const end = Math.min(all.length, Math.max(start, to));
    return { startLine: start, lines: all.slice(start - 1, end), totalLines: all.length };
  } catch {
    return null;
  }
}

/** Where a symbol is defined in a checkout, by `git grep` for common definition shapes; null when git grep failed. */
export async function grepDefinitions(dir: string, symbol: string): Promise<SymbolDefinition[] | null> {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // POSIX ERE only: macOS git grep uses the BSD regex engine, where `\s` and `\b` silently never match.
  const ws = "[[:space:]]";
  const end = `([^[:alnum:]_]|$)`;
  // Definition shapes across common languages; intentionally generous, ranked by the UI.
  const pattern = [
    `^${ws}*(export${ws}+)?(default${ws}+)?(async${ws}+)?(function|class|interface|type|enum|const|let|var)${ws}+${escaped}${end}`,
    `^${ws}*func${ws}+(\\([^)]*\\)${ws}*)?${escaped}${ws}*[(\\[]`,
    `^${ws}*(type|var|const)${ws}+${escaped}${end}`,
    `^${ws}*${escaped}${ws}+(struct|interface)${end}`,
    `^${ws}*(def|class)${ws}+${escaped}${end}`,
    `^${ws}*(pub${ws}+)?(fn|struct|enum|trait|type|const|static)${ws}+${escaped}${end}`,
    `^${ws}*((public|private|protected|static|final|abstract)${ws}+)*(class|interface|enum|record)${ws}+${escaped}${end}`,
  ].join("|");
  try {
    const { stdout } = await execFileAsync("git", ["grep", "-n", "-I", "-E", "--", pattern], { cwd: dir, timeout: GIT_GREP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    const found = stdout
      .split("\n")
      .filter((line) => line !== "")
      .slice(0, DEFINITION_LIMIT)
      .map(parseGrepLine)
      .filter((entry): entry is GrepHit => entry !== null);
    return Promise.all(found.map(async (entry) => ({ ...entry, context: await fileSlice(dir, entry.path, entry.line - PEEK_BEFORE, entry.line + PEEK_AFTER) })));
  } catch (error) {
    // git grep exits 1 when nothing matched.
    if ((error as { code?: number }).code === 1) return [];
    return null;
  }
}

/** Every whole-word occurrence of a symbol in a checkout. */
export async function grepUsages(dir: string, symbol: string): Promise<Pick<SymbolUsages, "usages" | "truncated">> {
  try {
    const { stdout } = await execFileAsync("git", ["grep", "-n", "-w", "-I", "-F", "--", symbol], { cwd: dir, timeout: GIT_GREP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    const lines = stdout.split("\n").filter((line) => line !== "");
    const usages = lines
      .slice(0, USAGE_LIMIT)
      .map(parseGrepLine)
      .filter((entry): entry is GrepHit => entry !== null);
    return { usages, truncated: lines.length > USAGE_LIMIT };
  } catch (error) {
    if ((error as { code?: number }).code === 1) return { usages: [], truncated: false };
    throw error;
  }
}

/** One `path:line:text` line of `git grep -n` output. */
function parseGrepLine(line: string): GrepHit | null {
  const match = /^(.+?):(\d+):(.*)$/u.exec(line);
  return match === null ? null : { path: match[1]!, line: Number.parseInt(match[2]!, 10), snippet: match[3]!.trim().slice(0, 200) };
}

/** `git blame --porcelain` (or `--line-porcelain`) output as one entry per line; a commit's details come with its first line only. */
export function parseBlamePorcelain(output: string): BlameLine[] {
  const commits = new Map<string, { author: string; time: number; summary: string }>();
  const lines: BlameLine[] = [];
  let current: { sha: string; line: number } | null = null;
  for (const text of output.split("\n")) {
    if (current === null) {
      const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/u.exec(text);
      if (header === null) continue;
      current = { sha: header[1]!, line: Number.parseInt(header[2]!, 10) };
      if (!commits.has(current.sha)) commits.set(current.sha, { author: "", time: 0, summary: "" });
      continue;
    }
    if (text.startsWith("\t")) {
      const commit = commits.get(current.sha)!;
      lines.push({ line: current.line, sha: current.sha, author: commit.author, time: commit.time, summary: commit.summary });
      current = null;
      continue;
    }
    const space = text.indexOf(" ");
    const key = space === -1 ? text : text.slice(0, space);
    const value = space === -1 ? "" : text.slice(space + 1);
    const commit = commits.get(current.sha)!;
    if (key === "author") commit.author = value;
    else if (key === "author-time") commit.time = Number.parseInt(value, 10) * 1000;
    else if (key === "summary") commit.summary = value;
  }
  return lines;
}

/**
 * The revision one side of a diff is blamed at; null is the working tree. `base` and `head` are the old and new sides
 * of the diff read for it: a range's compared commits, a PR's merge base and head, an environment's merge base and
 * working tree.
 */
export function blameRev(side: DiffSide, range: CommitRange | null, base: string | null, head: string | null): string | null {
  if (side === "RIGHT") return range === null ? head : range.to === WORKTREE_SHA ? null : range.to;
  // A diff of uncommitted changes alone has no merge base; its old side is HEAD.
  return base ?? range?.from ?? "HEAD";
}

/** `path` when it is relative and has no `..` to climb out of the checkout it is read in; throws otherwise. */
export function checkedRelativePath(path: string): string {
  if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`Invalid path ${path}`);
  return path;
}

/**
 * Who last changed lines `start`–`end` of `path` in a checkout: at `rev`, or in the working tree (uncommitted lines
 * included) when `rev` is null.
 */
export async function gitBlame(dir: string, rev: string | null, path: string, start: number, end: number): Promise<BlameLine[]> {
  checkedRelativePath(path);
  const from = Math.max(1, Math.min(start, end));
  const to = Math.max(from, start, end);
  const args = ["blame", "--porcelain", "-L", `${from},${to}`, ...(rev === null ? [] : [rev]), "--", path];
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: dir, timeout: GIT_BLAME_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return parseBlamePorcelain(stdout);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git blame failed: ${stderr !== undefined && stderr !== "" ? stderr.split("\n")[0] : error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A file of a checkout by its relative path, as a real path inside the checkout's real root; throws for a path that
 * leaves it, a symlink, or anything but a regular file, since a link could point a write anywhere.
 */
async function checkoutFile(root: string, path: string): Promise<string> {
  const file = resolve(root, checkedRelativePath(path));
  let stats;
  try {
    stats = await lstat(file);
  } catch {
    throw new Error(`Not applied: ${path} is not in the checkout`);
  }
  if (stats.isSymbolicLink()) throw new Error(`Not applied: ${path} is a symlink`);
  if (!stats.isFile()) throw new Error(`Not applied: ${path} is not a file`);
  const real = await realpath(file);
  if (!real.startsWith(root + sep)) throw new Error(`Not applied: ${path} is outside the checkout`);
  return real;
}

/** Replaces a file's contents in one step: a temp file beside it, given its mode, renamed over it. */
async function replaceFile(file: string, bytes: Uint8Array, mode: number): Promise<void> {
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.suggestion`);
  try {
    await writeFile(temp, bytes, { mode, flag: "wx" });
    await chmod(temp, mode);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

const checkoutQueues = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier one for the same checkout, so two applies never read the same original. */
async function inCheckoutQueue<T>(root: string, task: () => Promise<T>): Promise<T> {
  const run = (checkoutQueues.get(root) ?? Promise.resolve()).then(task);
  const settled = run.catch(() => {});
  checkoutQueues.set(root, settled);
  try {
    return await run;
  } finally {
    if (checkoutQueues.get(root) === settled) checkoutQueues.delete(root);
  }
}

/**
 * Applies suggestions to the files of a checkout, uncommitted. Every file is read and checked before any is written,
 * so a batch with one stale item changes nothing; each file is checked again just before it is replaced, and when a
 * later one fails those already written are put back. Applies to the same checkout run one at a time.
 */
export async function applySuggestionsInCheckout(dir: string, items: readonly SuggestionItem[]): Promise<SuggestionsApplied> {
  // Queued by the path as given, so applies run in the order they were asked for.
  return inCheckoutQueue(resolve(dir), async () => {
    const root = await realpath(resolve(dir));
    const writes: Array<{ path: string; file: string; original: Buffer; mode: number; next: Uint8Array }> = [];
    for (const [path, fileItems] of suggestionsByPath(items)) {
      const file = await checkoutFile(root, path);
      const [original, stats] = await Promise.all([readFile(file), stat(file)]);
      const text = applySuggestionsToText(suggestionFileText(original, path), fileItems);
      writes.push({ path, file, original, mode: stats.mode & 0o7777, next: new TextEncoder().encode(text) });
    }
    const written: typeof writes = [];
    try {
      for (const write of writes) {
        const now = await readFile(write.file).catch(() => null);
        if (now === null || !now.equals(write.original)) throw new SuggestionConflictError(`Not applied: ${write.path} changed while the suggestions were being applied. Refresh and try again.`);
        await replaceFile(write.file, write.next, write.mode).catch((cause: unknown) => {
          throw new Error(`Not applied: ${write.path} could not be written (${cause instanceof Error ? cause.message : String(cause)})`);
        });
        written.push(write);
      }
    } catch (error) {
      const unrestored: string[] = [];
      for (const write of written.reverse()) await replaceFile(write.file, write.original, write.mode).catch(() => unrestored.push(write.path));
      if (unrestored.length > 0) throw new Error(`${error instanceof Error ? error.message : String(error)}; putting back ${unrestored.join(", ")} failed too, so the suggestions are in those`);
      throw error;
    }
    return { applied: items.length, commitUrl: null };
  });
}

/** Throws unless both ends are shas (or `to` is the working tree), so nothing else reaches git or a GitHub URL. */
export function checkedRange(range: CommitRange): CommitRange {
  if (!COMMIT_SHA_PATTERN.test(range.from) || (range.to !== WORKTREE_SHA && !COMMIT_SHA_PATTERN.test(range.to))) throw new Error("Invalid commit range");
  return range;
}

const LOG_FORMAT = "%H%x1f%an%x1f%aI%x1f%s";

/** `git log --format=<LOG_FORMAT>` output as commits, in the order given. */
export function parseGitLog(output: string): DiffCommit[] {
  return output
    .split("\n")
    .map((line) => line.split("\x1f"))
    .filter((fields) => fields.length >= 4 && COMMIT_SHA_PATTERN.test(fields[0]!))
    .map(([sha, author, date, ...summary]) => ({ sha: sha!, author: author!, date: date!, summary: summary.join("\x1f") }));
}

/** The commits on a checkout's HEAD since `base`, oldest first, and uncommitted changes as a last pseudo-commit. */
export async function localCommits(dir: string, base: string): Promise<DiffCommit[]> {
  const options = localGitOptions(dir);
  const [{ stdout: log }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["log", "--reverse", `--format=${LOG_FORMAT}`, `${base}..HEAD`, "--"], options),
    execFileAsync("git", ["status", "--porcelain"], options),
  ]);
  const commits = parseGitLog(log);
  if (status.trim() !== "") commits.push({ sha: WORKTREE_SHA, summary: "Uncommitted changes", author: "", date: new Date().toISOString() });
  return commits;
}

/**
 * An environment's commits since `base` (its diff's merge base; null for a diff of uncommitted changes alone); none
 * without a local checkout. Left out, `base` is found the way bb's diff finds it, `git merge-base <mergeBaseBranch>
 * HEAD` in the checkout, so the commits match the diff without reading it.
 */
export async function environmentCommits(sdk: Sdk, environmentId: string, base?: string | null): Promise<DiffCommits> {
  const dir = await localEnvironmentPath(sdk, environmentId);
  if (dir === null) return noCommits();
  try {
    const known = base !== undefined ? base : await checkoutMergeBase(dir, (await sdk.environments.get({ environmentId })).mergeBaseBranch);
    // Resolved to a full sha, since a range's ends must be shas.
    const from = (await execFileAsync("git", ["rev-parse", "--verify", "--end-of-options", `${known ?? "HEAD"}^{commit}`], { cwd: dir, timeout: GIT_QUICK_TIMEOUT_MS })).stdout.trim();
    return { commits: await localCommits(dir, from), marks: [], base: from };
  } catch {
    return noCommits();
  }
}

/** Where a checkout's HEAD left `branch`; null, a diff of uncommitted changes alone, without a branch. */
async function checkoutMergeBase(dir: string, branch: string | null): Promise<string | null> {
  if (branch === null) return null;
  return (await execFileAsync("git", ["merge-base", branch, "HEAD"], { cwd: dir, timeout: GIT_QUICK_TIMEOUT_MS })).stdout.trim();
}

/** One file at a commit of a checkout; null when it is not there. */
async function gitShow(dir: string, rev: string, path: string): Promise<string | null> {
  try {
    return (await execFileAsync("git", ["show", `${rev}:${path}`], localGitOptions(dir))).stdout;
  } catch {
    return null;
  }
}

/** Both sides of one file of a range of a checkout's history: at `from`, and at `to` (the working tree for `WORKTREE`). */
export async function localRangeFileSides(dir: string, range: CommitRange, file: DiffFile): Promise<FileSides> {
  const { from, to } = checkedRange(range);
  const readNew = async () => {
    if (to !== WORKTREE_SHA) return gitShow(dir, to, file.path);
    try {
      checkedRelativePath(file.path);
      // Resolved first, so a symlink in the checkout can't read a file outside it.
      const [root, real] = await Promise.all([realpath(dir), realpath(join(dir, file.path))]);
      return real.startsWith(root + sep) ? await readFile(real, "utf8") : null;
    } catch {
      return null;
    }
  };
  return {
    old: file.status === "added" ? null : await gitShow(dir, from, file.previousPath ?? file.path),
    new: file.status === "removed" ? null : await readNew(),
  };
}

const NO_CHECKOUT_FOR_RANGE = "Reading one commit or a range needs a local checkout of this environment.";

/** The changes of part of an environment's history, read from its local checkout. */
export async function environmentRangeDiff(sdk: Sdk, environmentId: string, range: CommitRange): Promise<DiffResult> {
  const dir = await localEnvironmentPath(sdk, environmentId);
  if (dir === null) return { ...emptyDiff("environment", NO_CHECKOUT_FOR_RANGE), environmentId };
  const { from, to } = checkedRange(range);
  return {
    source: "environment",
    files: await checkoutDiff(dir, from, to === WORKTREE_SHA ? null : to),
    baseRef: from,
    baseSha: from,
    headSha: to === WORKTREE_SHA ? null : to,
    truncated: false,
    message: null,
    fetchedAt: Date.now(),
    hiddenVendored: null,
    repo: await checkoutGithubRepo(dir),
    environmentId,
  };
}

export async function environmentRangeFileSides(sdk: Sdk, environmentId: string, range: CommitRange, file: DiffFile): Promise<FileSides> {
  const dir = await localEnvironmentPath(sdk, environmentId);
  if (dir === null) throw new Error(NO_CHECKOUT_FOR_RANGE);
  return localRangeFileSides(dir, range, file);
}

/**
 * Values that are costly to make (a diff read through git or GitHub) kept for a short while, so the calls one view makes
 * at once (a structural diff per file, the viewed marks) share one read. Pending loads are shared too; a failed one is
 * dropped so the next call retries.
 */
export function createExpiringCache<T>(ttlMs: number, limit = 50) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return {
    get(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
      const hit = entries.get(key);
      if (!fresh && hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value;
      const value = load();
      entries.delete(key);
      if (entries.size >= limit) entries.delete(entries.keys().next().value!);
      const entry = { at: Date.now(), value };
      entries.set(key, entry);
      value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return value;
    },
    clear: () => entries.clear(),
  };
}
