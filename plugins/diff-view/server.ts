// bb-plugin-diff-view — backend entry.
//
// Serves the diff view for a thread: its environment's changes, difftastic's structural diff of each file, symbol
// lookups in the checkout, viewed marks, and line comments that get sent to the thread's own agent.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DIFF_CHANGED } from "./events";
import { checkedLineRange, locationLabel } from "./lib/line-range";
import { applySuggestionsInCheckout, emptyDiff, environmentDiff, environmentFileSides, gitBlame, grepDefinitions, grepUsages, hideVendoredFiles, localEnvironmentPath, patchFromSides, runDifftastic } from "./lib/server";
import { SUGGESTION_NOTE, mentionsSuggestion } from "./lib/suggestions";
import type { BlameLine, DiffComment, DiffFile, DiffResult, FileSlice, StructuralDiff, SuggestionItem, SymbolLookup, SymbolUsages } from "./lib/types";
import { COMMIT_SHA_PATTERN, blameRev, commitRangeKey, createExpiringCache, environmentCommits, environmentRangeDiff, environmentRangeFileSides } from "./lib/server";
import { WORKTREE_SHA, type CommitRange, type DiffCommits } from "./lib/types";

const threadIdSchema = z.string().min(1);
const commentBodySchema = z.string().trim().min(1).max(10_000);
const sideSchema = z.enum(["LEFT", "RIGHT"]);
const symbolOpenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("environment"), environmentId: z.string() }),
  z.object({ kind: z.literal("github"), repo: z.string(), sha: z.string() }),
  z.object({ kind: z.literal("none") }),
]);

const diffFileSchema: z.ZodType<DiffFile> = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  patch: z.string().nullable(),
  vendored: z.boolean(),
  binary: z.boolean().optional(),
});
const diffResultSchema: z.ZodType<DiffResult> = z.object({
  source: z.enum(["pr", "environment", "none"]),
  files: z.array(diffFileSchema),
  baseRef: z.string().nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  truncated: z.boolean(),
  message: z.string().nullable(),
  fetchedAt: z.number(),
  hiddenVendored: z.object({ files: z.number().int(), additions: z.number().int(), deletions: z.number().int() }).nullable(),
  truncatedNote: z.string().nullable().optional(),
  repo: z.string().nullable(),
  environmentId: z.string().nullable(),
});
const structuralLineSchema = z.object({ line: z.number().int(), changes: z.array(z.object({ start: z.number().int(), end: z.number().int(), highlight: z.string() })) });
const structuralDiffSchema: z.ZodType<StructuralDiff> = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  language: z.string().nullable(),
  status: z.enum(["unchanged", "changed", "created", "deleted"]).nullable(),
  oldText: z.string(),
  newText: z.string(),
  aligned: z.array(z.tuple([z.number().int().nullable(), z.number().int().nullable()])),
  oldChanges: z.array(structuralLineSchema),
  newChanges: z.array(structuralLineSchema),
});
const symbolLookupSchema: z.ZodType<SymbolLookup> = z.object({
  symbol: z.string(),
  definitions: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().nullable(),
      snippet: z.string(),
      context: z.object({ startLine: z.number().int(), lines: z.array(z.string()) }).nullable(),
    }),
  ),
  open: symbolOpenSchema,
  searched: z.enum(["workspace", "github", "none"]),
});
const symbolUsagesSchema: z.ZodType<SymbolUsages> = z.object({
  symbol: z.string(),
  usages: z.array(z.object({ path: z.string(), line: z.number().int(), snippet: z.string() })),
  open: symbolOpenSchema,
  searched: z.enum(["workspace", "none"]),
  truncated: z.boolean(),
});
const fileSliceSchema: z.ZodType<FileSlice> = z.object({ startLine: z.number().int(), lines: z.array(z.string()), totalLines: z.number().int() });
const diffCommentSchema: z.ZodType<DiffComment> = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  side: sideSchema,
  startLine: z.number().int().nullable(),
  startSide: sideSchema.nullable(),
  body: z.string(),
  target: z.enum(["local", "github"]),
  inReplyTo: z.string().nullable(),
  author: z.string().nullable(),
  authorThreadId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  postedAt: z.number().nullable(),
  postedUrl: z.string().nullable(),
  githubCommentId: z.string().nullable(),
  addressedAt: z.number().nullable(),
  applyId: z.string().nullable(),
});

const blameLineSchema: z.ZodType<BlameLine> = z.object({ line: z.number().int(), sha: z.string(), author: z.string(), time: z.number(), summary: z.string() });
const suggestionItemSchema: z.ZodType<SuggestionItem> = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  expected: z.array(z.string()),
  replacement: z.array(z.string()),
  before: z.array(z.string()).max(10).optional(),
  after: z.array(z.string()).max(10).optional(),
  headSha: z.string().nullable().optional(),
});

const commitRangeSchema: z.ZodType<CommitRange> = z
  .object({ from: z.string().regex(COMMIT_SHA_PATTERN), to: z.union([z.string().regex(COMMIT_SHA_PATTERN), z.literal(WORKTREE_SHA)]) })
  .strict();
const diffCommitsSchema: z.ZodType<DiffCommits> = z.object({
  commits: z.array(z.object({ sha: z.string(), summary: z.string(), author: z.string(), date: z.string() })),
  marks: z.array(z.object({ sha: z.string(), label: z.string() })),
  base: z.string().nullable(),
});

const threadInput = z.object({ threadId: threadIdSchema }).strict();
const symbolInput = z.object({ threadId: threadIdSchema, symbol: z.string().trim().min(1).max(200) }).strict();

export const rpcContract = defineRpcContract({
  diff_get: { input: z.object({ threadId: threadIdSchema, refresh: z.boolean().default(false), range: commitRangeSchema.nullable().default(null) }).strict(), output: diffResultSchema },
  diff_structural: { input: z.object({ threadId: threadIdSchema, path: z.string().min(1), range: commitRangeSchema.nullable().default(null) }).strict(), output: structuralDiffSchema },
  symbol_definitions: { input: symbolInput, output: symbolLookupSchema },
  symbol_usages: { input: symbolInput, output: symbolUsagesSchema },
  /** A slice of a file in the thread's checkout, for widening an inline peek. */
  symbol_peek_file: {
    input: z.object({ threadId: threadIdSchema, path: z.string().min(1), startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).strict(),
    output: fileSliceSchema,
  },
  /** Files ticked as viewed whose changes are still the ones that were viewed. */
  diff_viewed_list: { input: threadInput, output: z.object({ paths: z.array(z.string()) }) },
  diff_viewed_set: { input: z.object({ threadId: threadIdSchema, path: z.string().min(1), viewed: z.boolean() }).strict(), output: z.object({ paths: z.array(z.string()) }) },
  diff_comments_list: { input: threadInput, output: z.object({ comments: z.array(diffCommentSchema) }) },
  diff_comment_add: {
    input: z
      .object({
        threadId: threadIdSchema,
        path: z.string().min(1),
        line: z.number().int().min(1).nullable().default(null),
        side: sideSchema.default("RIGHT"),
        /** First line of a multi-line comment, which ends at `line`. */
        startLine: z.number().int().min(1).nullable().default(null),
        startSide: sideSchema.nullable().default(null),
        body: commentBodySchema,
        /** Reply in this comment's thread; path and lines then come from its root. */
        inReplyTo: z.string().min(1).nullable().default(null),
      })
      .strict(),
    output: diffCommentSchema,
  },
  diff_comment_update: { input: z.object({ id: z.string(), body: commentBodySchema }).strict(), output: diffCommentSchema },
  diff_comment_delete: { input: z.object({ id: z.string() }).strict(), output: z.object({ deleted: z.boolean() }) },
  /** Send every unsent comment to the thread's agent as one message. */
  diff_comments_send: { input: threadInput, output: z.object({ sent: z.number().int() }) },
  /** The text patch of a file the diff came without one for, made from its two sides. */
  diff_load_patch: { input: z.object({ threadId: threadIdSchema, path: z.string().min(1), range: commitRangeSchema.nullable().default(null) }).strict(), output: z.object({ patch: z.string().nullable() }) },
  /** Who last changed lines of a file in the thread's checkout: the working tree for the new side, the merge base for the old. */
  diff_blame: {
    input: z.object({ threadId: threadIdSchema, path: z.string().min(1), side: sideSchema, startLine: z.number().int().min(1), endLine: z.number().int().min(1), range: commitRangeSchema.nullable().default(null) }).strict(),
    output: z.object({ lines: z.array(blameLineSchema) }),
  },
  /** Writes suggested changes into the thread's checkout (uncommitted, so no message), refusing them all if any item's lines moved. */
  diff_suggestions_apply: {
    input: z.object({ threadId: threadIdSchema, items: z.array(suggestionItemSchema).min(1).max(200) }).strict(),
    output: z.object({ applied: z.number().int(), commitUrl: z.string().nullable() }),
  },
  /** The commits of the thread's changes in its local checkout, oldest first, uncommitted changes last. */
  diff_commits: { input: threadInput, output: diffCommitsSchema },
});

interface CommentRow {
  id: string;
  thread_id: string;
  path: string;
  line: number | null;
  side: string;
  start_line: number | null;
  start_side: string | null;
  body: string;
  in_reply_to: string | null;
  created_at: number;
  updated_at: number;
  send_id: string | null;
}

function rowToComment(row: CommentRow): DiffComment {
  return {
    id: row.id,
    path: row.path,
    line: row.line,
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    startLine: row.start_line,
    startSide: row.start_line === null ? null : row.start_side === "LEFT" ? "LEFT" : "RIGHT",
    body: row.body,
    target: "local",
    inReplyTo: row.in_reply_to,
    author: null,
    authorThreadId: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    postedAt: null,
    postedUrl: null,
    githubCommentId: null,
    addressedAt: null,
    applyId: row.send_id,
  };
}

/** What a viewed mark remembers about a file; the mark lapses once the file's changes differ. */
function fileFingerprint(file: DiffFile): string {
  return createHash("sha1").update(file.patch ?? `${file.status}:${file.additions}:${file.deletions}`).digest("hex");
}

function where(row: CommentRow): string {
  const { path, line, side, startLine, startSide } = rowToComment(row);
  return locationLabel(path, { line, side, startLine, startSide });
}

/** One message with every unsent comment, replies under the comment they answer. */
export function commentsMessage(unsent: readonly CommentRow[], roots: ReadonlyMap<string, CommentRow>): string {
  const lines = ["Review comments on your changes. Address each one, then summarize what you changed.", ...(mentionsSuggestion(unsent.map((row) => row.body)) ? [SUGGESTION_NOTE] : []), ""];
  for (const comment of unsent) {
    const root = comment.in_reply_to === null ? null : (roots.get(comment.in_reply_to) ?? null);
    const body = comment.body.trim().replace(/\n/gu, "\n  ");
    if (root === null) lines.push(`- \`${where(comment)}\`: ${body}`);
    else lines.push(`- \`${where(root)}\`, replying to "${root.body.trim().split("\n")[0]!.slice(0, 120)}": ${body}`);
  }
  return lines.join("\n");
}

const STRUCTURAL_CACHE_LIMIT = 200;
const DIFF_CACHE_TTL_MS = 15_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hideVendored: {
      type: "boolean",
      label: "Hide vendored files",
      description: "Leave files under vendor/, node_modules/, third_party/ and similar out of the diff. Shown or not, they never get a structural diff.",
      default: true,
    },
    difftPath: {
      type: "string",
      label: "difftastic binary",
      description: "Path to `difft` for the structural diff. Install with `brew install difftastic`.",
      default: "difft",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS viewed (
      thread_id TEXT NOT NULL,
      path TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      viewed_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, path)
    )`,
    `CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      path TEXT NOT NULL,
      line INTEGER,
      side TEXT NOT NULL,
      body TEXT NOT NULL,
      in_reply_to TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      send_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS comments_thread ON comments (thread_id, created_at)`,
    `ALTER TABLE comments ADD COLUMN start_line INTEGER`,
    `ALTER TABLE comments ADD COLUMN start_side TEXT`,
  ]);
  const stmts = {
    viewedForThread: db.prepare<[string], { path: string; fingerprint: string }>(`SELECT path, fingerprint FROM viewed WHERE thread_id = ?`),
    upsertViewed: db.prepare<[string, string, string, number]>(
      `INSERT INTO viewed (thread_id, path, fingerprint, viewed_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, path) DO UPDATE SET fingerprint = excluded.fingerprint, viewed_at = excluded.viewed_at`,
    ),
    deleteViewed: db.prepare<[string, string]>(`DELETE FROM viewed WHERE thread_id = ? AND path = ?`),
    deleteViewedForThread: db.prepare<[string]>(`DELETE FROM viewed WHERE thread_id = ?`),
    commentsForThread: db.prepare<[string], CommentRow>(`SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at`),
    commentById: db.prepare<[string], CommentRow>(`SELECT * FROM comments WHERE id = ?`),
    insertComment: db.prepare(
      `INSERT INTO comments (id, thread_id, path, line, side, start_line, start_side, body, in_reply_to, created_at, updated_at)
       VALUES (@id, @thread_id, @path, @line, @side, @start_line, @start_side, @body, @in_reply_to, @created_at, @updated_at)`,
    ),
    updateCommentBody: db.prepare<[string, number, string]>(`UPDATE comments SET body = ?, updated_at = ? WHERE id = ?`),
    deleteComment: db.prepare<[string, string]>(`DELETE FROM comments WHERE id = ? OR in_reply_to = ?`),
    markSent: db.prepare<[string, string]>(`UPDATE comments SET send_id = ? WHERE id = ? AND send_id IS NULL`),
    deleteCommentsForThread: db.prepare<[string]>(`DELETE FROM comments WHERE thread_id = ?`),
  };

  function publish(threadId: string): void {
    bb.realtime.publish(DIFF_CHANGED, { threadId });
  }

  async function threadEnvironment(threadId: string): Promise<string | null> {
    return (await bb.sdk.threads.get({ threadId })).environmentId;
  }

  // Every file's structural diff and load reads the diff again; within a few seconds they share one read.
  const diffCache = createExpiringCache<DiffResult>(DIFF_CACHE_TTL_MS);
  /** The thread's changes, or a range of its history; `fresh` reads them again rather than from the cache. */
  async function fullDiff(threadId: string, range: CommitRange | null = null, fresh = false): Promise<DiffResult> {
    const environmentId = await threadEnvironment(threadId);
    if (environmentId === null) return emptyDiff("none", "This thread has no environment yet.");
    // A range ending at the working tree changes with every edit, so it is never served from the cache.
    return diffCache.get(`${environmentId}:${commitRangeKey(range)}`, () => (range === null ? environmentDiff(bb.sdk, environmentId) : environmentRangeDiff(bb.sdk, environmentId, range)), fresh || range?.to === WORKTREE_SHA);
  }

  async function threadDiff(threadId: string, refresh: boolean, range: CommitRange | null): Promise<DiffResult> {
    // The whole diff is read afresh on every ask, as it always was; a range of commits only changes on a refresh.
    const diff = await fullDiff(threadId, range, refresh || range === null);
    return (await settings.get()).hideVendored ? hideVendoredFiles(diff) : diff;
  }

  function fileInDiff(diff: DiffResult, path: string): DiffFile {
    const file = diff.files.find((entry) => entry.path === path || entry.previousPath === path);
    if (file === undefined) throw new Error(`${path} is not in this thread's changes`);
    return file;
  }

  /** One file of the thread's changes (or a range of them) and its two sides as text. */
  async function fileWithSides(threadId: string, path: string, range: CommitRange | null): Promise<{ file: DiffFile; sides: { old: string | null; new: string | null } }> {
    const environmentId = await threadEnvironment(threadId);
    if (environmentId === null) throw new Error("This thread has no environment yet.");
    const diff = await fullDiff(threadId, range);
    const file = fileInDiff(diff, path);
    const sides = range === null ? await environmentFileSides(bb.sdk, environmentId, file, diff.baseRef) : await environmentRangeFileSides(bb.sdk, environmentId, range, file);
    return { file, sides };
  }

  const structuralCache = new Map<string, StructuralDiff>();
  async function structuralDiff(threadId: string, path: string, range: CommitRange | null): Promise<StructuralDiff> {
    const { sides } = await fileWithSides(threadId, path, range);
    const key = createHash("sha1").update(path).update("\0").update(sides.old ?? "\u0001").update("\0").update(sides.new ?? "\u0001").digest("hex");
    const cached = structuralCache.get(key);
    if (cached !== undefined) return cached;
    const result = await runDifftastic((await settings.get()).difftPath, path, sides);
    if (result.available) {
      if (structuralCache.size >= STRUCTURAL_CACHE_LIMIT) structuralCache.delete(structuralCache.keys().next().value!);
      structuralCache.set(key, result);
    }
    return result;
  }

  async function loadPatch(threadId: string, path: string, range: CommitRange | null): Promise<string | null> {
    const { file, sides } = await fileWithSides(threadId, path, range);
    return patchFromSides(file.path, file.previousPath, sides.old, sides.new);
  }

  async function checkout(threadId: string): Promise<{ path: string; environmentId: string } | null> {
    const environmentId = await threadEnvironment(threadId);
    if (environmentId === null) return null;
    const path = await localEnvironmentPath(bb.sdk, environmentId);
    return path === null ? null : { path, environmentId };
  }

  /** The paths marked viewed whose file in `diff` is as it was when marked; callers read it afresh, so a mark lapses the moment its file changes again. */
  function viewedPaths(threadId: string, diff: DiffResult): string[] {
    const current = new Map(diff.files.map((file) => [file.path, fileFingerprint(file)]));
    return stmts.viewedForThread
      .all(threadId)
      .filter((row) => current.get(row.path) === row.fingerprint)
      .map((row) => row.path)
      .sort();
  }

  /** The comment a reply attaches to: replies to replies go to the root, as on GitHub. */
  function threadRoot(threadId: string, id: string): CommentRow {
    const comment = stmts.commentById.get(id);
    if (comment === undefined || comment.thread_id !== threadId) throw new Error(`No comment ${id} on this thread`);
    return comment.in_reply_to === null ? comment : threadRoot(threadId, comment.in_reply_to);
  }

  function updatable(id: string): CommentRow {
    const row = stmts.commentById.get(id);
    if (row === undefined) throw new Error(`No comment ${id}`);
    if (row.send_id !== null) throw new Error("This comment was already sent to the thread");
    return row;
  }

  bb.rpc.register(rpcContract, {
    diff_get: ({ threadId, refresh, range }) => threadDiff(threadId, refresh, range),
    diff_structural: ({ threadId, path, range }) => structuralDiff(threadId, path, range),
    symbol_definitions: async ({ threadId, symbol }) => {
      const local = await checkout(threadId);
      if (local === null) return { symbol, definitions: [], open: { kind: "none" }, searched: "none" };
      return { symbol, definitions: (await grepDefinitions(local.path, symbol)) ?? [], open: { kind: "environment", environmentId: local.environmentId }, searched: "workspace" };
    },
    symbol_usages: async ({ threadId, symbol }) => {
      const local = await checkout(threadId);
      if (local === null) return { symbol, usages: [], open: { kind: "none" }, searched: "none", truncated: false };
      return { symbol, ...(await grepUsages(local.path, symbol)), open: { kind: "environment", environmentId: local.environmentId }, searched: "workspace" };
    },
    symbol_peek_file: async ({ threadId, path, startLine, endLine }) => {
      const local = await checkout(threadId);
      if (local === null) throw new Error("No local checkout to read from.");
      const root = resolve(local.path);
      const file = resolve(root, path);
      if (!file.startsWith(root + sep)) throw new Error("Invalid path");
      const all = (await readFile(file, "utf8")).split("\n");
      const start = Math.max(1, Math.min(startLine, endLine));
      const end = Math.min(all.length, Math.max(startLine, endLine));
      return { startLine: start, lines: all.slice(start - 1, end), totalLines: all.length };
    },
    diff_viewed_list: async ({ threadId }) => ({ paths: viewedPaths(threadId, await fullDiff(threadId, null, true)) }),
    diff_viewed_set: async ({ threadId, path, viewed }) => {
      // One fresh read for the mark and the list, so the fingerprint written is the one the list compares against.
      const diff = await fullDiff(threadId, null, true);
      if (viewed) stmts.upsertViewed.run(threadId, path, fileFingerprint(fileInDiff(diff, path)), Date.now());
      else stmts.deleteViewed.run(threadId, path);
      return { paths: viewedPaths(threadId, diff) };
    },
    diff_comments_list: ({ threadId }) => ({ comments: stmts.commentsForThread.all(threadId).map(rowToComment) }),
    diff_comment_add: ({ threadId, path, line, side, startLine, startSide, body, inReplyTo }) => {
      const root = inReplyTo === null ? null : threadRoot(threadId, inReplyTo);
      const anchor = root === null ? checkedLineRange({ line, side, startLine, startSide }) : rowToComment(root);
      const now = Date.now();
      const row: Omit<CommentRow, "send_id"> = {
        id: randomUUID(),
        thread_id: threadId,
        path: root?.path ?? path,
        line: anchor.line,
        side: anchor.side,
        start_line: anchor.startLine,
        start_side: anchor.startSide,
        body,
        in_reply_to: root?.id ?? null,
        created_at: now,
        updated_at: now,
      };
      stmts.insertComment.run(row);
      publish(threadId);
      return rowToComment({ ...row, send_id: null });
    },
    diff_comment_update: ({ id, body }) => {
      const row = updatable(id);
      stmts.updateCommentBody.run(body, Date.now(), id);
      publish(row.thread_id);
      return rowToComment(stmts.commentById.get(id)!);
    },
    diff_comment_delete: ({ id }) => {
      const row = updatable(id);
      const deleted = stmts.deleteComment.run(id, id).changes > 0;
      publish(row.thread_id);
      return { deleted };
    },
    diff_comments_send: async ({ threadId }) => {
      const all = stmts.commentsForThread.all(threadId);
      const unsent = all.filter((row) => row.send_id === null);
      if (unsent.length === 0) return { sent: 0 };
      const text = commentsMessage(unsent, new Map(all.map((row) => [row.id, row])));
      await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
      const sendId = randomUUID();
      for (const row of unsent) stmts.markSent.run(sendId, row.id);
      publish(threadId);
      return { sent: unsent.length };
    },
    diff_load_patch: async ({ threadId, path, range }) => ({ patch: await loadPatch(threadId, path, range) }),
    diff_blame: async ({ threadId, path, side, startLine, endLine, range }) => {
      const local = await checkout(threadId);
      if (local === null) throw new Error("Blame needs a local checkout of this thread's environment.");
      const diff = await fullDiff(threadId, range);
      const file = fileInDiff(diff, path);
      const rev = blameRev(side, range, diff.baseSha ?? diff.baseRef, diff.headSha);
      return { lines: await gitBlame(local.path, rev, side === "LEFT" ? (file.previousPath ?? file.path) : file.path, startLine, endLine) };
    },
    diff_suggestions_apply: async ({ threadId, items }) => {
      const local = await checkout(threadId);
      if (local === null) throw new Error("Applying suggestions needs a local checkout of this thread's environment.");
      const result = await applySuggestionsInCheckout(local.path, items);
      publish(threadId);
      return result;
    },
    diff_commits: async ({ threadId }) => {
      const environmentId = await threadEnvironment(threadId);
      if (environmentId === null) return { commits: [], marks: [], base: null };
      return environmentCommits(bb.sdk, environmentId);
    },
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    stmts.deleteViewedForThread.run(thread.id);
    stmts.deleteCommentsForThread.run(thread.id);
  });
}
