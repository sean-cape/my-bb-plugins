// Runs on the machine that holds the vault. Owns all filesystem access, an
// in-memory link/search index, and the native file watcher that keeps both the
// index and every open editor current when notes change outside bb.
import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk";
import { hostContract, hostSignals, type FileEntry } from "./contract.js";
import {
  basename,
  createResolver,
  dirname,
  isNotePath,
  joinPath,
  normalizePath,
  parseLinks,
  rewriteLinks,
  type LinkResolver,
  type ParsedLink,
} from "./shared/obsidian.js";

const IGNORED_DIRS = [".obsidian", ".git", ".trash", "node_modules"];
const MAX_INDEXED_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES_PER_FILE = 5;
const MAX_LINE_LENGTH = 300;

interface NoteRecord {
  content: string;
  sha256: string;
  links: ParsedLink[];
}

interface VaultIndex {
  root: string;
  realRoot: string;
  files: Map<string, FileEntry>;
  folders: Set<string>;
  notes: Map<string, NoteRecord>;
  resolver: LinkResolver | null;
  /** Serializes mutations so compare-and-swap checks and index updates don't interleave. */
  queue: Promise<unknown>;
}

const indexes = new Map<string, Promise<VaultIndex>>();

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isHiddenPath(relative: string): boolean {
  return relative.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules");
}

function excerpt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_LINE_LENGTH ? `${trimmed.slice(0, MAX_LINE_LENGTH)}…` : trimmed;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function serialize<T>(index: VaultIndex, work: () => Promise<T>): Promise<T> {
  const next = index.queue.then(work, work);
  index.queue = next.catch(() => undefined);
  return next;
}

function resolverFor(index: VaultIndex): LinkResolver {
  index.resolver ??= createResolver(index.files.keys());
  return index.resolver;
}

function isInsideRoot(index: VaultIndex, real: string): boolean {
  const prefix = index.realRoot.endsWith(nodePath.sep) ? index.realRoot : index.realRoot + nodePath.sep;
  return real === index.realRoot || real.startsWith(prefix);
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isSymbolicLink();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * Maps a vault-relative path to an absolute one, refusing anything outside the
 * vault. Call it inside `serialize` right before the filesystem operation so
 * the check is as close to the use as Node allows.
 */
async function absolutePath(index: VaultIndex, relative: string): Promise<{ relative: string; absolute: string }> {
  const normalized = normalizePath(relative);
  const outside = () => new Error(`Path is outside the vault: ${relative}`);
  if (normalized === null || normalized === "") throw outside();
  const absolute = nodePath.join(index.root, ...normalized.split("/"));
  // Resolve symlinks on the deepest existing ancestor so a link can't escape the vault.
  let probe = absolute;
  for (;;) {
    let real: string;
    try {
      real = await fs.realpath(probe);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      // realpath reports a dangling symlink as missing, but writing through it creates its target.
      if (await isSymlink(probe)) throw outside();
      const parent = nodePath.dirname(probe);
      if (parent === probe) break;
      probe = parent;
      continue;
    }
    if (!isInsideRoot(index, real)) throw outside();
    break;
  }
  return { relative: normalized, absolute };
}

/** Writes without following a symlink at the final path component. */
async function writeNoFollow(absolute: string, content: string): Promise<void> {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fsConstants;
  const handle = await fs.open(absolute, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

/** Creates `relative`'s parent folders, then re-validates the chain they now resolve through. */
async function ensureParent(index: VaultIndex, relative: string): Promise<string> {
  const { absolute } = await absolutePath(index, relative);
  await fs.mkdir(nodePath.dirname(absolute), { recursive: true });
  return (await absolutePath(index, relative)).absolute;
}

async function indexNote(index: VaultIndex, relative: string, absolute: string, size: number): Promise<void> {
  if (size > MAX_INDEXED_NOTE_BYTES) {
    index.notes.delete(relative);
    return;
  }
  const bytes = await fs.readFile(absolute);
  const content = bytes.toString("utf8");
  index.notes.set(relative, { content, sha256: sha256(bytes), links: parseLinks(content) });
}

function addFolderChain(index: VaultIndex, folder: string): void {
  let current = folder;
  while (current !== "" && !index.folders.has(current)) {
    index.folders.add(current);
    current = dirname(current);
  }
}

const WALK_CONCURRENCY = 32;

async function mapLimit<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Lists visible folders and files under a folder one directory at a time to keep descriptor use flat. */
async function listTree(root: string, relativeDir: string): Promise<{ folders: string[]; files: string[] }> {
  const folders: string[] = [];
  const files: string[] = [];
  const pending = [relativeDir];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir === "" ? root : nodePath.join(root, ...dir.split("/")), { withFileTypes: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(errorCode(error) ?? "")) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relative = joinPath(dir, entry.name);
      if (entry.isDirectory()) {
        folders.push(relative);
        pending.push(relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  return { folders, files };
}

async function walk(index: VaultIndex, relativeDir: string): Promise<void> {
  const { folders, files } = await listTree(index.root, relativeDir);
  for (const folder of folders) index.folders.add(folder);
  await mapLimit(files, WALK_CONCURRENCY, async (file) => {
    try {
      await refreshFile(index, file);
    } catch {
      // One unreadable file shouldn't take the rest of the vault down with it.
      forget(index, file);
    }
  });
}

/** Re-reads one file into the index. Returns false when it is gone or not indexable. */
async function refreshFile(index: VaultIndex, relative: string): Promise<boolean> {
  if (isHiddenPath(relative)) return false;
  const absolute = nodePath.join(index.root, ...relative.split("/"));
  let stat;
  try {
    stat = await fs.lstat(absolute);
    if (!stat.isFile()) return false;
    if (isNotePath(relative)) await indexNote(index, relative, absolute, stat.size);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    forget(index, relative);
    return false;
  }
  if (!index.files.has(relative)) index.resolver = null;
  index.files.set(relative, { path: relative, mtimeMs: stat.mtimeMs, size: stat.size });
  addFolderChain(index, dirname(relative));
  return true;
}

function forget(index: VaultIndex, relative: string): boolean {
  let removed = false;
  const prefix = relative + "/";
  for (const path of [...index.files.keys()]) {
    if (path === relative || path.startsWith(prefix)) {
      index.files.delete(path);
      index.notes.delete(path);
      removed = true;
    }
  }
  for (const folder of [...index.folders]) {
    if (folder === relative || folder.startsWith(prefix)) {
      index.folders.delete(folder);
      removed = true;
    }
  }
  if (removed) index.resolver = null;
  return removed;
}

/** Applies one watcher change. Returns whether the tree's shape changed. */
async function refreshPath(index: VaultIndex, relative: string): Promise<boolean> {
  const absolute = nodePath.join(index.root, ...relative.split("/"));
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return forget(index, relative);
  }
  if (stat.isDirectory()) {
    if (index.folders.has(relative)) return false;
    addFolderChain(index, relative);
    await walk(index, relative);
    index.resolver = null;
    return true;
  }
  if (!stat.isFile()) return forget(index, relative);
  const existed = index.files.has(relative);
  const present = await refreshFile(index, relative);
  return existed !== present;
}

function emptyIndex(root: string, realRoot: string): VaultIndex {
  return { root, realRoot, files: new Map(), folders: new Set(), notes: new Map(), resolver: null, queue: Promise.resolve() };
}

/** Rescans into fresh maps and swaps them in, so readers never see a half-built index. */
async function rebuild(index: VaultIndex): Promise<void> {
  const fresh = emptyIndex(index.root, index.realRoot);
  await walk(fresh, "");
  index.files = fresh.files;
  index.folders = fresh.folders;
  index.notes = fresh.notes;
  index.resolver = null;
}

async function buildIndex(vaultPath: string): Promise<VaultIndex> {
  const root = nodePath.resolve(vaultPath);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${vaultPath}`);
  const index = emptyIndex(root, await fs.realpath(root));
  await walk(index, "");
  return index;
}

function getIndex(vaultPath: string): Promise<VaultIndex> {
  let pending = indexes.get(vaultPath);
  if (pending === undefined) {
    pending = buildIndex(vaultPath);
    indexes.set(vaultPath, pending);
    pending.catch(() => indexes.delete(vaultPath));
  }
  return pending;
}

function toRelative(index: VaultIndex, changedPath: string): string | null {
  if (!nodePath.isAbsolute(changedPath)) return normalizePath(changedPath.split(nodePath.sep).join("/"));
  for (const root of [index.root, index.realRoot]) {
    if (changedPath.startsWith(root + nodePath.sep)) {
      return normalizePath(changedPath.slice(root.length + 1).split(nodePath.sep).join("/"));
    }
  }
  return null;
}

interface WatchState {
  vaultPath: string;
  ready: Promise<ExperimentalHostWatchSubscription>;
}

let watchState: WatchState | null = null;

/**
 * Starts (or joins) the watch for `vaultPath`. Resolves true when this call
 * created a new watch, which means changes may have been missed before it.
 */
async function startWatch(
  vaultPath: string,
  context: ExperimentalHostRpcContext<typeof hostSignals>,
): Promise<boolean> {
  if (watchState?.vaultPath === vaultPath) {
    await watchState.ready;
    return false;
  }
  const previous = watchState;
  const state: WatchState = { vaultPath, ready: Promise.resolve(null as never) };
  const emit = (paths: string[], structural: boolean) =>
    context.experimental_emitSignal("changed", { vaultPath, paths, structural }).catch(() => undefined);

  state.ready = (async () => {
    if (previous !== null) {
      indexes.delete(previous.vaultPath);
      await (await previous.ready.catch(() => null))?.dispose();
    }
    const root = nodePath.resolve(vaultPath);
    // Subscribe before indexing so nothing changes unobserved between the scan and the watch.
    const hadIndex = indexes.has(vaultPath);
    const subscription = await context.experimental_watch(
      { rootPath: root, ignoredPaths: IGNORED_DIRS, debounceMs: 150, maxWaitMs: 1000 },
      async (event) => {
        if (watchState !== state) return;
        const index = await getIndex(vaultPath);
        if (event.kind === "watch-error") {
          // Drop the watch so the server's reconcile loop starts a fresh one with a rescan.
          watchState = null;
          void subscription.dispose();
          return;
        }
        if (event.kind === "rescan-required") {
          await serialize(index, () => rebuild(index)).catch(() => undefined);
          await emit([], true);
          return;
        }
        const paths = new Set<string>();
        for (const change of event.changes) {
          const relative = toRelative(index, change.path);
          if (relative !== null && relative !== "" && !isHiddenPath(relative)) paths.add(relative);
        }
        if (paths.size === 0) return;
        const structural = await serialize(index, async () => {
          let changedShape = false;
          for (const path of paths) {
            try {
              if (await refreshPath(index, path)) changedShape = true;
            } catch {
              changedShape = forget(index, path) || changedShape;
            }
          }
          return changedShape;
        });
        await emit([...paths], structural);
      },
    );
    const index = await getIndex(vaultPath);
    if (hadIndex) await serialize(index, () => rebuild(index));
    return subscription;
  })();
  watchState = state;
  state.ready.catch(() => {
    if (watchState === state) watchState = null;
  });
  await state.ready;
  return true;
}

/** The vault's .trash folder, refused when it is a symlink or resolves outside the vault. */
async function trashFolder(index: VaultIndex): Promise<string> {
  const trashDir = nodePath.join(index.root, ".trash");
  try {
    const stat = await fs.lstat(trashDir);
    if (!stat.isDirectory()) throw new Error("The vault's .trash is not a real folder; refusing to move files into it.");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await fs.mkdir(trashDir);
  }
  const real = await fs.realpath(trashDir);
  if (real !== nodePath.join(index.realRoot, ".trash")) throw new Error("The vault's .trash resolves outside the vault.");
  return real;
}

function collectMoves(index: VaultIndex, from: string, to: string): Map<string, string> {
  const moves = new Map<string, string>();
  if (index.files.has(from)) {
    moves.set(from, to);
    return moves;
  }
  const prefix = from + "/";
  for (const path of index.files.keys()) {
    if (path.startsWith(prefix)) moves.set(path, to + "/" + path.slice(prefix.length));
  }
  return moves;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async checkVault({ vaultPath }) {
      if (!nodePath.isAbsolute(vaultPath)) {
        return { ok: false, message: "Use an absolute path to the vault folder." };
      }
      let real: string;
      try {
        const stat = await fs.stat(vaultPath);
        if (!stat.isDirectory()) return { ok: false, message: "That path is not a folder." };
        real = await fs.realpath(vaultPath);
      } catch {
        return { ok: false, message: "That folder does not exist on this machine." };
      }
      const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
      if (real === nodePath.parse(real).root || real === home) {
        return { ok: false, message: "Choose the vault folder itself, not the whole disk or home folder." };
      }
      const hasConfig = await exists(nodePath.join(vaultPath, ".obsidian"));
      const hidden = real.split(nodePath.sep).some((segment) => segment.startsWith("."));
      if (hidden && !hasConfig) {
        return { ok: false, message: "That is a hidden folder and has no .obsidian folder, so it doesn't look like a vault." };
      }
      return {
        ok: true,
        message: hasConfig ? null : "No .obsidian folder found; the folder will still open as a vault.",
      };
    },

    async watch({ vaultPath }, context) {
      return { started: await startWatch(vaultPath, context) };
    },

    async tree({ vaultPath }) {
      const index = await getIndex(vaultPath);
      return {
        files: [...index.files.values()].sort((a, b) => a.path.localeCompare(b.path)),
        folders: [...index.folders].sort(),
      };
    },

    async read({ vaultPath, path }) {
      const index = await getIndex(vaultPath);
      const { absolute } = await absolutePath(index, path);
      const handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const [bytes, stat] = await Promise.all([handle.readFile(), handle.stat()]).finally(() => handle.close());
      return { content: bytes.toString("utf8"), sha256: sha256(bytes), mtimeMs: stat.mtimeMs };
    },

    async write({ vaultPath, path, content, expectedSha256 }) {
      const index = await getIndex(vaultPath);
      return serialize(index, async () => {
        const { relative, absolute } = await absolutePath(index, path);
        let currentSha: string | null = null;
        try {
          currentSha = sha256(await fs.readFile(absolute));
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        if (expectedSha256 !== undefined && expectedSha256 !== currentSha) {
          return { outcome: "conflict" as const, currentSha256: currentSha };
        }
        // Written in place rather than via rename so the file keeps its
        // creation time, which Obsidian and its plugins surface as "created".
        await writeNoFollow(await ensureParent(index, relative), content);
        await refreshFile(index, relative);
        return { outcome: "written" as const, sha256: sha256(Buffer.from(content, "utf8")) };
      });
    },

    async mkdir({ vaultPath, path }) {
      const index = await getIndex(vaultPath);
      return serialize(index, async () => {
        const { relative, absolute } = await absolutePath(index, path);
        await fs.mkdir(absolute, { recursive: true });
        await absolutePath(index, path);
        addFolderChain(index, relative);
        return { path: relative };
      });
    },

    async move({ vaultPath, from, to, updateLinks }) {
      const index = await getIndex(vaultPath);
      return serialize(index, async () => {
        const source = await absolutePath(index, from);
        const destination = await absolutePath(index, to);
        let sourceStat;
        try {
          sourceStat = await fs.lstat(source.absolute);
        } catch (error) {
          if (errorCode(error) === "ENOENT") throw new Error(`${from} does not exist`);
          throw error;
        }
        const destinationStat = await fs.lstat(destination.absolute).catch((error) => {
          if (errorCode(error) === "ENOENT") return null;
          throw error;
        });
        // A case-only rename on a case-insensitive disk sees the source as the destination;
        // anything else already there is a different file that rename would replace.
        const sameEntry = destinationStat !== null && destinationStat.ino === sourceStat.ino && destinationStat.dev === sourceStat.dev;
        if (destinationStat !== null && !sameEntry) throw new Error(`${to} already exists`);
        const isFile = !sourceStat.isDirectory();
        const moves = collectMoves(index, source.relative, destination.relative);
        const oldResolver = resolverFor(index);
        const newResolver = createResolver(
          [...index.files.keys()].map((path) => moves.get(path) ?? path),
        );

        await fs.rename(source.absolute, await ensureParent(index, destination.relative));
        forget(index, source.relative);
        if (isFile) {
          await refreshFile(index, destination.relative);
        } else {
          addFolderChain(index, destination.relative);
          await walk(index, destination.relative);
        }

        const updatedNotes: string[] = [];
        const skippedNotes: string[] = [];
        if (updateLinks) {
          const reverse = new Map([...moves].map(([oldPath, newPath]) => [newPath, oldPath]));
          const rewrite = (notePath: string, content: string) =>
            rewriteLinks({
              content,
              oldSourcePath: reverse.get(notePath) ?? notePath,
              newSourcePath: notePath,
              oldResolver,
              newResolver,
              remap: moves,
            });
          for (const notePath of [...index.files.keys()].filter(isNotePath)) {
            const cached = index.notes.get(notePath);
            // Large notes aren't cached in memory, so they're read only here.
            if (cached !== undefined && rewrite(notePath, cached.content) === null) continue;
            try {
              const { absolute } = await absolutePath(index, notePath);
              const onDisk = await fs.readFile(absolute);
              // Skip notes edited since they were indexed rather than clobber them.
              if (cached !== undefined && sha256(onDisk) !== cached.sha256) {
                skippedNotes.push(notePath);
                continue;
              }
              const rewritten = rewrite(notePath, onDisk.toString("utf8"));
              if (rewritten === null) continue;
              await writeNoFollow(absolute, rewritten);
              await refreshFile(index, notePath);
              updatedNotes.push(notePath);
            } catch {
              skippedNotes.push(notePath);
            }
          }
        }
        return { path: destination.relative, updatedNotes, skippedNotes };
      });
    },

    async trash({ vaultPath, path }) {
      const index = await getIndex(vaultPath);
      return serialize(index, async () => {
        const source = await absolutePath(index, path);
        const trashDir = await trashFolder(index);
        const name = basename(source.relative);
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        let target = nodePath.join(trashDir, name);
        for (let attempt = 1; await exists(target); attempt += 1) {
          target = nodePath.join(trashDir, `${stem} ${attempt}${ext}`);
        }
        await fs.rename(source.absolute, target);
        forget(index, source.relative);
        return { trashedTo: joinPath(".trash", nodePath.basename(target)) };
      });
    },

    async backlinks({ vaultPath, path }) {
      const index = await getIndex(vaultPath);
      const resolver = resolverFor(index);
      const backlinks: { path: string; matches: { line: number; text: string }[] }[] = [];
      for (const [notePath, note] of index.notes) {
        if (notePath === path) continue;
        const lines = new Set<number>();
        for (const link of note.links) {
          if (link.target !== "" && resolver.resolve(link.target, notePath, link.kind) === path) {
            lines.add(link.line);
          }
        }
        if (lines.size === 0) continue;
        const text = note.content.split("\n");
        backlinks.push({
          path: notePath,
          matches: [...lines].slice(0, MAX_MATCHES_PER_FILE).map((line) => ({ line, text: excerpt(text[line] ?? "") })),
        });
      }
      backlinks.sort((a, b) => a.path.localeCompare(b.path));
      return { backlinks };
    },

    async search({ vaultPath, query, limit }) {
      const index = await getIndex(vaultPath);
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const results: { path: string; nameMatch: boolean; matches: { line: number; text: string }[]; score: number }[] = [];
      for (const file of index.files.values()) {
        const lowerPath = file.path.toLowerCase();
        const nameMatch = terms.every((term) => lowerPath.includes(term));
        const note = index.notes.get(file.path);
        const lowerContent = note?.content.toLowerCase() ?? "";
        const contentMatch = note !== undefined && terms.every((term) => lowerContent.includes(term) || lowerPath.includes(term));
        if (!nameMatch && !contentMatch) continue;
        const matches: { line: number; text: string }[] = [];
        let hits = 0;
        if (note !== undefined) {
          note.content.split("\n").forEach((line, lineNumber) => {
            const lower = line.toLowerCase();
            if (!terms.some((term) => lower.includes(term))) return;
            hits += 1;
            if (matches.length < MAX_MATCHES_PER_FILE) matches.push({ line: lineNumber, text: excerpt(line) });
          });
        }
        results.push({ path: file.path, nameMatch, matches, score: (nameMatch ? 1000 : 0) + hits });
      }
      results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return {
        results: results.slice(0, limit).map(({ score: _score, ...result }) => result),
        truncated: results.length > limit,
      };
    },
  },
  dispose: async () => {
    const state = watchState;
    watchState = null;
    await (await state?.ready.catch(() => null))?.dispose();
  },
});
