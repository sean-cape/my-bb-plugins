import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { DiffResult, SuggestionItem } from "../../types";
import { linesFromMap, newSideLineMap } from "../../suggestions";
import type { DiffThread } from "../comments/threads";
import type { InlineFinding } from "../findings/findings";
import { errorMessage, plural } from "../format";
import { openInNewTab } from "../links";
import type { DiffSource } from "../source";
import { requestReload } from "../state";
import type { SuggestionActions } from "./actions";
import { threadSuggestion, type LinesAt } from "./thread-suggestion";
import { findingSuggestion, findingSuggestionBody, findingSuggestionRange, parseFindingSuggestionId, type FindingSuggestionState } from "./finding-suggestion";

/**
 * The view's suggested changes: the diff's new-side lines they replace, the batch `B` builds, and applying through the
 * source, which refreshes the diff and the comments after.
 */
export function useSuggestions({
  source,
  diff,
  patches,
  threadById,
  instanceKey,
  onApplied,
  refusal,
  onFindingsApplied,
  onPosted,
}: {
  source: DiffSource;
  diff: DiffResult | null;
  /** Each file's patch as the diff has it, or as Load diff fetched it; whitespace changes not hidden. */
  patches: ReadonlyMap<string, string>;
  /** Threads as they are, for views that draw a copy placed elsewhere (the comments view's sections). */
  threadById: ReadonlyMap<string, DiffThread>;
  instanceKey: string;
  onApplied: () => void;
  /** Why nothing may be applied right now (a range of commits that stops short of the head); null when it may. */
  refusal: string | null;
  /** Findings whose suggestions were just applied, to mark them applied with the host. */
  onFindingsApplied: (findings: Array<{ reviewId: string; findingId: string }>) => void;
  /** A finding's suggestion went to the pull request as a draft comment. */
  onPosted: () => void;
}): SuggestionActions {
  const [batch, setBatch] = useState<SuggestionItem[]>([]);
  const [applied, setApplied] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<ReadonlySet<string>>(() => new Set());
  // Parsed once per file per diff, the first time a suggestion asks for its lines.
  const lineMapOf = useMemo(() => {
    const parsed = new Map<string, Map<number, string>>();
    return (path: string): Map<number, string> | null => {
      const patch = patches.get(path);
      if (patch === undefined) return null;
      let map = parsed.get(path);
      if (map === undefined) {
        map = newSideLineMap(patch);
        parsed.set(path, map);
      }
      return map;
    };
  }, [patches]);
  const linesAt = useCallback<LinesAt>((path, startLine, endLine) => {
    const map = lineMapOf(path);
    return map === null ? null : linesFromMap(map, startLine, endLine);
  }, [lineMapOf]);
  // What the host checks besides `expected` before writing: the lines just around the range as the diff shows them,
  // and the pull request head it was read at, so an item made against an older text is refused instead of misplaced.
  const headSha = diff?.source === "pr" ? diff.headSha : null;
  const guarded = useCallback(
    <T extends { item: SuggestionItem | null }>(state: T | null): T | null => {
      if (state === null || state.item === null) return state;
      const map = lineMapOf(state.item.path);
      const before = map?.get(state.item.startLine - 1);
      const after = map?.get(state.item.endLine + 1);
      return { ...state, item: { ...state.item, before: before === undefined ? [] : [before], after: after === undefined ? [] : [after], headSha } };
    },
    [lineMapOf, headSha],
  );
  const forThread = useCallback((thread: DiffThread) => guarded(threadSuggestion(threadById.get(thread.id) ?? thread, linesAt, applied)), [threadById, linesAt, applied, guarded]);
  const forFinding = useCallback((item: InlineFinding) => guarded(findingSuggestion(item, linesAt, applied)), [linesAt, applied, guarded]);
  const toggleBatch = (item: SuggestionItem): boolean => {
    const has = batch.some((entry) => entry.id === item.id);
    setBatch((current) => (has ? current.filter((entry) => entry.id !== item.id) : [...current.filter((entry) => entry.id !== item.id), item]));
    return !has;
  };
  const host = source.suggestions;
  const apply =
    host === undefined
      ? null
      : async (items: SuggestionItem[]) => {
          if (items.length === 0) return;
          if (refusal !== null) {
            toast.message(refusal);
            return;
          }
          setBusy(true);
          try {
            const result = await host.apply(items, null);
            const ids = new Set(items.map((item) => item.id));
            setApplied((current) => new Set([...current, ...ids]));
            setBatch((current) => current.filter((item) => !ids.has(item.id)));
            const what = plural(result.applied, "suggestion");
            if (result.commitUrl === null) toast.success(`Applied ${what} to the checkout`);
            else {
              const url = result.commitUrl;
              toast.success(`Committed ${what}`, { action: { label: "Open commit", onClick: () => openInNewTab(url) } });
            }
            const findings = items.flatMap((item) => parseFindingSuggestionId(item.id) ?? []);
            if (findings.length > 0) onFindingsApplied(findings);
            requestReload(instanceKey);
            onApplied();
          } catch (cause) {
            toast.error(errorMessage(cause));
          } finally {
            setBusy(false);
          }
        };
  const post =
    source.canPostToGithub !== true
      ? null
      : async (item: InlineFinding, state: FindingSuggestionState) => {
          if (refusal !== null) {
            toast.message(refusal);
            return;
          }
          try {
            await source.addComment({ path: state.suggestion.file, body: findingSuggestionBody(item.finding, state.suggestion), target: "github", inReplyTo: null, ...findingSuggestionRange(state.suggestion) });
            setPosted((current) => new Set([...current, state.id]));
            toast.success("Posted as a draft suggestion on the pull request; s submits the review");
            onPosted();
          } catch (cause) {
            toast.error(errorMessage(cause));
          }
        };
  return { linesAt, forThread, apply, toggleBatch, batch, busy, forFinding, post, posted };
}
