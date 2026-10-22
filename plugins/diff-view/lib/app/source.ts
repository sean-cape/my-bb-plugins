import { createContext, useContext } from "react";
import type {
  BlameLine,
  CommitRange,
  DiffCommits,
  DiffComment,
  DiffCommentTarget,
  DiffDelta,
  DiffResult,
  DiffSide,
  FileSlice,
  FindingEdit,
  GithubComment,
  HunkExplanation,
  LineRange,
  Narrative,
  NarrativeStory,
  Review,
  StructuralDiff,
  SuggestionItem,
  SuggestionsApplied,
  SymbolLookup,
  SymbolUsages,
  TourState,
} from "../types";

/**
 * Where the view's data comes from. The core methods cover any diff; the optional groups light up GitHub threads,
 * review findings, the tour and hunk explanations. Keep the object stable (memoize it): the view refetches when it changes.
 */
export interface DiffSource {
  /** `range` limits the diff to part of its history (see `commits`); null or absent is all the changes. */
  getDiff(refresh: boolean, range?: CommitRange | null): Promise<DiffResult>;
  getStructural(path: string, range?: CommitRange | null): Promise<StructuralDiff>;
  symbolDefinitions(symbol: string): Promise<SymbolLookup>;
  symbolUsages(symbol: string): Promise<SymbolUsages>;
  peekFile(path: string, startLine: number, endLine: number): Promise<FileSlice>;
  listViewed(): Promise<string[]>;
  /** Returns the viewed paths after the change. */
  setViewed(path: string, viewed: boolean): Promise<string[]>;
  listComments(): Promise<DiffComment[]>;
  addComment(comment: { path: string; body: string; target: DiffCommentTarget; inReplyTo: string | null } & LineRange): Promise<void>;
  updateComment(id: string, patch: { body?: string; target?: DiffCommentTarget }): Promise<void>;
  deleteComment(id: string): Promise<void>;
  /** Comments can also be GitHub drafts; off unless set. */
  canPostToGithub?: boolean;
  defaultCommentTarget?: DiffCommentTarget;
  listGithubComments?(): Promise<GithubComment[]>;
  /** Resolves or reopens the GitHub review thread rooted at a synced inline comment (`review-comment:<n>`). */
  setThreadResolved?(rootId: string, resolved: boolean): Promise<void>;
  reviews?: {
    list(): Promise<Review[]>;
    setSelection(reviewId: string, findingId: string, selected: boolean): Promise<Review>;
    editFinding(reviewId: string, findingId: string, edit: FindingEdit | null): Promise<Review>;
    /** Files a pre-existing finding as separate work; `created` is false when an earlier press already did. */
    makeCard?(reviewId: string, findingId: string): Promise<{ cardId: string; title: string; created: boolean }>;
    /** Shows a card `makeCard` returned. */
    openCard?(cardId: string): void;
    /** Marks a finding fixed (or not), so the diff leaves it out; applying a finding's suggestion marks it. */
    setApplied?(reviewId: string, findingId: string, applied: boolean): Promise<Review>;
  };
  /** What changed since the head the reviewer last looked at. */
  delta?(): Promise<DiffDelta | null>;
  /** `story` lights up the narrative review: every narrative with the diff it was written against, for stepping through. */
  tour?: { get(): Promise<TourState>; generate(): Promise<Narrative>; story?(): Promise<NarrativeStory> };
  explanations?: {
    list(): Promise<HunkExplanation[]>;
    explain(path: string, side: "old" | "new", startLine: number, endLine: number): Promise<HunkExplanation>;
  };
  /** The text patch of a file the diff came without one for (too large), made from its two sides; null when there is none. */
  loadPatch?(path: string, range?: CommitRange | null): Promise<string | null>;
  /** Who last changed lines `startLine`–`endLine` of one side of a file in the diff; lights up `gb`. */
  blame?(path: string, side: DiffSide, startLine: number, endLine: number, range?: CommitRange | null): Promise<BlameLine[]>;
  /**
   * Applies suggested changes, one or a batch, refusing them all when any item's `expected` lines moved; `message` is
   * for a host that commits them, null for its default. Lights up `A`, `B` and `gB`, for comments' and findings' suggestions.
   */
  suggestions?: { apply(items: SuggestionItem[], message: string | null): Promise<SuggestionsApplied> };
  /** The diff's commits and review marks, for reading one commit or a range of them; lights up `gr`. */
  commits?(): Promise<DiffCommits>;
}

/** Copy that names where comments live, so each host can speak in its own terms. */
export interface DiffViewLabels {
  /** Local target toggle tooltip. */
  localTarget: string;
  /** A GitHub reply is impossible in this thread. */
  localOnlyThread: string;
  /** Hint under a local comment's editor. */
  localHint: string;
  /** "Make local" button tooltip on a GitHub draft. */
  makeLocal: string;
  /** No checkout to open or search a file in. */
  noCheckout: string;
  /** Tooltip on the filtered findings' count: what kept them out. */
  filteredFindings: string;
}

export const DEFAULT_LABELS: DiffViewLabels = {
  localTarget: "Kept here for an agent to address; never posted",
  localOnlyThread: "This thread is local; GitHub replies need an inline GitHub thread",
  localHint: "Stays here until you send it to an agent",
  makeLocal: "Keep this for an agent instead of posting it",
  noCheckout: "No local checkout of these changes.",
  filteredFindings: "Findings the review's verifier did not believe were real; never applied",
};

export const DiffSourceContext = createContext<{ source: DiffSource; labels: DiffViewLabels } | null>(null);

export function useDiffSource(): { source: DiffSource; labels: DiffViewLabels } {
  const value = useContext(DiffSourceContext);
  if (value === null) throw new Error("useDiffSource outside a DiffView");
  return value;
}
