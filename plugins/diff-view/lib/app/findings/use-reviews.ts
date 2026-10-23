import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { FindingEdit, Review } from "../../types";
import { errorMessage } from "../format";
import type { DiffSource } from "../source";
import type { InlineFinding } from "./findings";

/** The source's reviews, if it has any, and the selection and rewording of their findings. */
export function useReviews(source: DiffSource, refreshSignal: unknown) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const loadReviews = useCallback(() => {
    if (source.reviews === undefined) setReviews([]);
    else source.reviews.list().then(setReviews, () => setReviews([]));
  }, [source]);
  useEffect(loadReviews, [loadReviews, refreshSignal]);
  const replaceReview = (updated: Review) => setReviews((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
  const toggleFinding = (item: InlineFinding, selected: boolean) => {
    source.reviews?.setSelection(item.reviewId, item.finding.id, selected).then(replaceReview, (cause: unknown) => toast.error(errorMessage(cause)));
  };
  const editFinding = async (item: InlineFinding, edit: FindingEdit | null) => {
    if (source.reviews === undefined) return;
    try {
      replaceReview(await source.reviews.editFinding(item.reviewId, item.finding.id, edit));
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    }
  };
  /** Marks findings fixed, once their suggestion is applied; the diff then leaves them out. */
  const markApplied = async (findings: ReadonlyArray<{ reviewId: string; findingId: string }>) => {
    const setApplied = source.reviews?.setApplied;
    if (setApplied === undefined) return;
    for (const { reviewId, findingId } of findings) {
      try {
        replaceReview(await setApplied(reviewId, findingId, true));
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    }
  };
  /** Resolves a finding, or reopens one resolved by hand or crossed off as applied. */
  const setResolved = async (reviewId: string, findingId: string, resolved: boolean, by: "you" | "applied" = "you") => {
    const set = by === "applied" ? source.reviews?.setApplied : source.reviews?.setResolved;
    if (set === undefined) return;
    try {
      replaceReview(await set(reviewId, findingId, resolved));
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  return { reviews, toggleFinding, editFinding, markApplied, setResolved };
}
