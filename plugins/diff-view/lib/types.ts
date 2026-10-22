// Data the diff view renders. Plain TypeScript rather than zod schemas so every plugin that bundles this library keeps
// its own zod copy; each plugin's RPC schemas must produce values assignable to these.
import type { NarrativePatchFile, NarrativeRef } from "./narrative";

export type DiffSide = "LEFT" | "RIGHT";

/**
 * Where a line comment sits, in GitHub's shape: `line`/`side` is the last line, and a multi-line comment starts at
 * `startLine`/`startSide`. A null `line` is the whole file; a null `startLine` is a single line.
 */
export interface LineRange {
  line: number | null;
  side: DiffSide;
  startLine: number | null;
  startSide: DiffSide | null;
}

export interface DiffFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** Unified patch for this one file; null for binary or oversized files. */
  patch: string | null;
  /** Under a vendored tree (vendor/, node_modules/, third_party/, …): never given a structural diff. */
  vendored: boolean;
  /** Known to be binary (git's "Binary files" line; a GitHub file with no patch and no line counts); absent when unknown. */
  binary?: boolean;
}

export interface DiffResult {
  source: "pr" | "environment" | "none";
  files: DiffFile[];
  /** What the diff was taken against: the PR base branch or the environment's merge base. */
  baseRef: string | null;
  baseSha: string | null;
  headSha: string | null;
  truncated: boolean;
  message: string | null;
  fetchedAt: number;
  /** Vendored files left out of `files`; null when nothing was hidden. */
  hiddenVendored: { files: number; additions: number; deletions: number } | null;
  /** What a truncated diff is missing, for the banner above it; absent or null leaves a generic one. */
  truncatedNote?: string | null;
  /** The GitHub repository (`owner/name`) the code lives in, for links at `headSha` and `baseSha`; null when unknown. */
  repo: string | null;
  /** The bb environment holding the changes, whose files open in bb's file preview; null for a PR's diff. */
  environmentId: string | null;
}

export interface StructuralLineChanges {
  line: number;
  changes: Array<{ start: number; end: number; highlight: string }>;
}

/** difftastic's JSON output, trimmed to what the viewer renders. Line numbers are 1-based. */
export interface StructuralDiff {
  available: boolean;
  /** Why the structural diff is unavailable: difftastic missing, binary file, parse failure. */
  reason: string | null;
  language: string | null;
  status: "unchanged" | "changed" | "created" | "deleted" | null;
  oldText: string;
  newText: string;
  /** Every row of the side-by-side view, old and new line numbers; a null side is a blank cell. Covers the whole file. */
  aligned: Array<[number | null, number | null]>;
  /** Changed spans per side, keyed by line; lines absent here are unchanged. */
  oldChanges: StructuralLineChanges[];
  newChanges: StructuralLineChanges[];
}

/** How to open a symbol result: a bb environment (file preview at the line) or a GitHub blob URL base. */
export type SymbolOpenTarget = { kind: "environment"; environmentId: string } | { kind: "github"; repo: string; sha: string } | { kind: "none" };

export interface SymbolDefinition {
  path: string;
  line: number | null;
  snippet: string;
  /** Source around the definition for an inline peek: `lines[0]` is line `startLine`. Null when only GitHub search was available. */
  context: { startLine: number; lines: string[] } | null;
}

export interface SymbolLookup {
  symbol: string;
  definitions: SymbolDefinition[];
  open: SymbolOpenTarget;
  searched: "workspace" | "github" | "none";
}

export interface SymbolUsages {
  symbol: string;
  usages: Array<{ path: string; line: number; snippet: string }>;
  open: SymbolOpenTarget;
  searched: "workspace" | "none";
  truncated: boolean;
}

export interface FileSlice {
  startLine: number;
  lines: string[];
  totalLines: number;
}

/** `local` comments go to an agent; `github` ones are drafts posted to the PR. */
export type DiffCommentTarget = "local" | "github";

/** A comment left on the diff: by the user (`author` null), or an agent's reply. */
export interface DiffComment {
  id: string;
  path: string;
  line: number | null;
  /** Which side of the diff the line number refers to: RIGHT = new file (default), LEFT = removed line. */
  side: DiffSide;
  startLine: number | null;
  startSide: DiffSide | null;
  body: string;
  target: DiffCommentTarget;
  /** Thread root: another diff comment's id, or a synced GitHub comment id (`review-comment:<n>`). */
  inReplyTo: string | null;
  author: string | null;
  authorThreadId: string | null;
  createdAt: number;
  updatedAt: number;
  postedAt: number | null;
  postedUrl: string | null;
  /** The synced comment this became once posted (`review-comment:<n>`, or `review:<n>` when it went in a review body). */
  githubCommentId: string | null;
  addressedAt: number | null;
  /** Set once the comment was handed to an agent. */
  applyId: string | null;
}

/** A comment synced from the pull request on GitHub. */
export interface GithubComment {
  id: string;
  kind: "review-comment" | "review" | "issue-comment";
  author: string;
  /** True when `author` is the signed-in user. */
  mine: boolean;
  body: string;
  path: string | null;
  line: number | null;
  /** Root of the review thread this replies to. */
  inReplyTo: string | null;
  side: DiffSide;
  startLine: number | null;
  startSide: DiffSide | null;
  /** The line it was left on no longer exists in the PR head; `line` is then the original line. */
  outdated: boolean;
  resolved: boolean | null;
  url: string;
  createdAt: string;
  addressedAt: number | null;
  /** GitHub's `diff_hunk`: the hunk the comment was left on, ending at its line; absent where the host has none. */
  diffHunk?: string | null;
  /** The line (and a range's first line) the comment was left on, which an outdated comment keeps. */
  originalLine?: number | null;
  originalStartLine?: number | null;
}

export type FindingSeverity = "critical" | "important" | "minor";

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  fix: string | null;
  locations: Array<{ file: string; startLine: number | null; endLine: number | null }>;
  importance: number | null;
  scopeFit: number | null;
  /** `<reviewId>/<findingId>` of the earlier finding a re-review found still open. */
  carriedFrom?: string | null;
  /** 0–100: how sure the review's verifier is that the problem is real; absent before verification. */
  confidence?: number | null;
  /** Already in the code before the change, so it is listed apart from the diff and never applied. */
  preExisting?: boolean;
  /** The verifier's reason for its confidence. */
  verification?: string | null;
  /** The kind of mistake, so one fix covers it everywhere; `locations` lists every instance. */
  class?: string | null;
  /** The fix as an exact edit, when it is one contiguous run of new-side lines; absent before report version 6. */
  suggestion?: FindingSuggestion | null;
}

/** Inclusive 1-based new-side lines of `file` and their new text joined by `\n` (no trailing newline; "" deletes them). */
export interface FindingSuggestion {
  file: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface FindingEdit {
  title: string;
  description: string;
  fix: string | null;
}

export interface Review {
  id: string;
  status: "running" | "completed" | "failed";
  /** Commit the previous review ended at, when this was an incremental review. */
  sinceCommitSha: string | null;
  /**
   * `carriesForward`: a re-review whose findings include every earlier one still open, superseding older reviews.
   * `filtered`: findings the verifier did not believe, kept for a look.
   */
  report: { findings: Finding[]; filtered?: Finding[]; carriesForward?: boolean } | null;
  /** Effective per-finding selection for the apply round. */
  selection: Record<string, boolean>;
  /** Only the findings the user explicitly toggled. */
  selectionOverrides: Record<string, boolean>;
  /** Findings the user reworded; `report` already carries the new wording. */
  findingEdits: Record<string, unknown>;
  /** Findings an apply round already fixed; the diff leaves them out. */
  appliedFindingIds?: string[];
  createdAt: number;
}

/** What changed between the head the reviewer last looked at and the current one. */
export interface DiffDelta {
  fromSha: string;
  toSha: string;
  files: Array<{ path: string; status: string; additions: number; deletions: number; ranges: Array<[number, number]> }>;
}

/** A semantic label for a block of the diff that would otherwise read as a wall of red and green. */
export interface SemanticChange {
  kind: "rename" | "move" | "signature" | "reorder" | "reformat" | "extract" | "inline" | "logic";
  label: string;
  oldLines: [number, number] | null;
  newLines: [number, number] | null;
}

/** One stop of a narrative review: an explanation (Markdown, mermaid fences allowed) of the lines its refs point at. */
export interface NarrativeStep {
  id: string;
  title: string;
  body: string;
  refs: NarrativeRef[];
  /** In a revision chapter: ids of the new narrative's steps the change shows up in. */
  affects: string[];
}

export interface Narrative {
  id: string;
  threadId: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
  report: {
    summary: string;
    readingOrder: Array<{ path: string; role: "key" | "supporting" | "mechanical"; note: string; lines: number[]; risk: number | null; changes: SemanticChange[] }>;
    watchOut: string[];
    steps: NarrativeStep[];
    /** Walks from the previous narrative to this one; its refs point into `NarrativeRevision.delta`. */
    revision: { summary: string; steps: NarrativeStep[] } | null;
  } | null;
}

/** A narrative with the diff it was written against, so it still reads after the head moves. */
export interface NarrativeRevision {
  narrative: Narrative;
  head: string | null;
  /** Written over uncommitted changes. */
  dirty: boolean;
  previousId: string | null;
  files: NarrativePatchFile[];
  /** What changed since the previous narrative's head, in the files the change touches. */
  delta: { fromHead: string | null; toHead: string | null; files: NarrativePatchFile[]; note: string | null } | null;
}

/** Every narrative of the subject, oldest first, and whether the code moved past the newest. */
export interface NarrativeStory {
  revisions: NarrativeRevision[];
  running: Narrative | null;
  stale: boolean;
}

export interface TourState {
  narrative: Narrative | null;
  /** The diff head moved since the tour was written. */
  stale: boolean;
}

/** An agent's explanation of one hunk, keyed by the lines it covers on one side of the diff. */
export interface HunkExplanation {
  id: string;
  path: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  threadId: string;
  status: "running" | "completed" | "failed";
  body: string | null;
}

/** Who last changed one line, from `git blame` or GitHub's. A line not yet committed has an all-zero `sha`. */
export interface BlameLine {
  line: number;
  sha: string;
  author: string;
  /** When the commit was authored, in epoch milliseconds. */
  time: number;
  summary: string;
}

/**
 * One suggested change to apply: new-side lines `startLine`–`endLine` of `path`, which read `expected` when it was
 * made, become `replacement` (empty deletes them). `id` names where it came from: the comment (`review-comment:<n>`
 * for a synced GitHub one) or a finding.
 */
export interface SuggestionItem {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  expected: string[];
  replacement: string[];
  /** The lines just before and after the range as the diff showed them, checked with `expected`; absent where it showed none. */
  before?: string[];
  after?: string[];
  /** The pull request head the diff was read at; a commit to its branch is refused once the branch has moved on. */
  headSha?: string | null;
}

/** What applying suggestions did: how many, and the commit they went into where the host commits them. */
export interface SuggestionsApplied {
  applied: number;
  commitUrl: string | null;
}

/** The pseudo-commit standing for a checkout's uncommitted changes, last in an environment's commit list. */
export const WORKTREE_SHA = "WORKTREE";

/** Part of a diff's history: the changes after `from` (exclusive) up to and including `to`. */
export interface CommitRange {
  from: string;
  to: string;
}

export interface DiffCommit {
  sha: string;
  /** The commit message's first line. */
  summary: string;
  author: string;
  /** ISO 8601. */
  date: string;
}

/** A diff's commits, oldest first, and named points to read on from: a mark's range runs from its sha to the head. */
export interface DiffCommits {
  commits: DiffCommit[];
  marks: Array<{ sha: string; label: string }>;
  /** Where the first commit's range starts (the merge base); null when unknown. */
  base: string | null;
}
