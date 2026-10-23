import { COMMIT_SHA_PATTERN, WORKTREE_SHA } from "bb-diff-view/types";
import { z } from "zod";

export const diffSideSchema = z.enum(["LEFT", "RIGHT"]);

/** What changed since a point in the change's history: the last review, by default, and the current code. */
export const diffDeltaSchema = z.object({
  fromSha: z.string(),
  toSha: z.string(),
  /** What `fromSha` is: a review's commit (with the review), your last GitHub review's, the head you last marked files viewed on, or a commit asked for by sha. */
  since: z.object({ kind: z.enum(["review", "githubReview", "viewed", "commit"]), reviewId: z.string().nullable() }),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      additions: z.number().int(),
      deletions: z.number().int(),
      /** New-side line ranges touched since `fromSha`. */
      ranges: z.array(z.tuple([z.number().int(), z.number().int()])),
    }),
  ),
});
export type DiffDelta = z.infer<typeof diffDeltaSchema>;

export const diffFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** Unified patch for this one file; null for binary or oversized files. */
  patch: z.string().nullable(),
  /** Under a vendored tree (vendor/, node_modules/, third_party/, …): never given a structural diff. */
  vendored: z.boolean(),
  /** Known to be binary (git's "Binary files" line; a GitHub file with no patch and no line counts); absent when unknown. */
  binary: z.boolean().optional(),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const ticketDiffSchema = z.object({
  source: z.enum(["pr", "environment", "none"]),
  files: z.array(diffFileSchema),
  /** What the diff was taken against: the PR base branch or the environment's merge base. */
  baseRef: z.string().nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  truncated: z.boolean(),
  message: z.string().nullable(),
  fetchedAt: z.number(),
  /** Vendored files left out of `files` by the "Hide vendored files" setting; null when nothing was hidden. */
  hiddenVendored: z.object({ files: z.number().int(), additions: z.number().int(), deletions: z.number().int() }).nullable(),
  /** What a truncated diff is missing, for the banner above it. */
  truncatedNote: z.string().nullable().optional(),
  /** The GitHub repository (`owner/name`): the PR's, or the checkout's `origin`; null when unknown. */
  repo: z.string().nullable(),
  /** The environment the changes are in, whose files open in bb's file preview; null for a PR's diff. */
  environmentId: z.string().nullable(),
});
export type TicketDiff = z.infer<typeof ticketDiffSchema>;

/** difftastic's JSON output, trimmed to what the viewer renders. Line numbers are 1-based here. */
export const structuralChangeSchema = z.object({
  start: z.number().int(),
  end: z.number().int(),
  highlight: z.string(),
});
export const structuralLineSchema = z.object({
  line: z.number().int(),
  changes: z.array(structuralChangeSchema),
});
export const structuralDiffSchema = z.object({
  available: z.boolean(),
  /** Why the structural diff is unavailable: difftastic missing, binary file, parse failure. */
  reason: z.string().nullable(),
  language: z.string().nullable(),
  status: z.enum(["unchanged", "changed", "created", "deleted"]).nullable(),
  oldText: z.string(),
  newText: z.string(),
  /** Every row of the side-by-side view, old and new line numbers; a null side is a blank cell. Covers the whole file. */
  aligned: z.array(z.tuple([z.number().int().nullable(), z.number().int().nullable()])),
  /** Changed spans per side, keyed by line; lines absent here are unchanged. */
  oldChanges: z.array(structuralLineSchema),
  newChanges: z.array(structuralLineSchema),
});
export type StructuralDiff = z.infer<typeof structuralDiffSchema>;

export const symbolDefinitionSchema = z.object({
  path: z.string(),
  line: z.number().int().nullable(),
  snippet: z.string(),
  /** Source around the definition for an inline peek: `lines[0]` is line `startLine`. Null when only GitHub search was available. */
  context: z.object({ startLine: z.number().int(), lines: z.array(z.string()) }).nullable().default(null),
});
export const symbolLookupSchema = z.object({
  symbol: z.string(),
  definitions: z.array(symbolDefinitionSchema),
  /** How to open a result: a bb environment (file preview at the line) or a GitHub blob URL base. */
  open: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("environment"), environmentId: z.string() }),
    z.object({ kind: z.literal("github"), repo: z.string(), sha: z.string() }),
    z.object({ kind: z.literal("none") }),
  ]),
  searched: z.enum(["workspace", "github", "none"]),
});
export type SymbolLookup = z.infer<typeof symbolLookupSchema>;
export const symbolUsagesSchema = z.object({
  symbol: z.string(),
  usages: z.array(z.object({ path: z.string(), line: z.number().int(), snippet: z.string() })),
  open: symbolLookupSchema.shape.open,
  searched: z.enum(["workspace", "none"]),
  truncated: z.boolean(),
});
export type SymbolUsages = z.infer<typeof symbolUsagesSchema>;

/** Who last changed one line; an all-zero `sha` is a line not committed yet. `time` is epoch milliseconds. */
export const blameLineSchema = z.object({ line: z.number().int(), sha: z.string(), author: z.string(), time: z.number(), summary: z.string() });
export type BlameLine = z.infer<typeof blameLineSchema>;

/** A suggested change to apply: new-side lines that read `expected` become `replacement`. */
export const suggestionItemSchema = z.object({
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
export type SuggestionItem = z.infer<typeof suggestionItemSchema>;
/** Part of the diff's history: after `from` (exclusive) up to `to`, which may be `WORKTREE` (uncommitted changes). */
export const commitRangeSchema = z.object({ from: z.string().regex(COMMIT_SHA_PATTERN), to: z.union([z.string().regex(COMMIT_SHA_PATTERN), z.literal(WORKTREE_SHA)]) }).strict();
export type CommitRange = z.infer<typeof commitRangeSchema>;

/** The diff's commits oldest first, the review marks to read on from, and where the first commit starts. */
export const diffCommitsSchema = z.object({
  commits: z.array(z.object({ sha: z.string(), summary: z.string(), author: z.string(), date: z.string() })),
  marks: z.array(z.object({ sha: z.string(), label: z.string() })),
  base: z.string().nullable(),
});
export type DiffCommits = z.infer<typeof diffCommitsSchema>;
