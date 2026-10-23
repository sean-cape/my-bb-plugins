import type { Landed } from "./contract.js";

export interface LandedLabel {
  text: string;
  title: string;
  /** `landed` reads as done, `unpushed` as one step left, `conflicts` as blocked; `pending` is ordinary work in progress. */
  tone: "landed" | "unpushed" | "pending" | "conflicts";
}

const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`;
const BY_CONTENT = "Checked by content, so work landed by cherry-picking counts too.";

/** What the badge beside bb's changes bar says; null when there is nothing to add to it. */
export function landedLabel(landed: Landed): LandedLabel | null {
  if (landed.state === "none") return null;
  const { base } = landed;
  if (landed.state === "landed") {
    if (landed.pushed === false) {
      return { text: `on ${base} · not pushed`, title: `Every commit on this branch is in ${base}, but ${base} isn't pushed yet. ${BY_CONTENT}`, tone: "unpushed" };
    }
    const where = landed.pushed ? `${base} and its upstream` : base;
    return { text: `on ${base}`, title: `Every commit on this branch is in ${where}. ${BY_CONTENT}`, tone: "landed" };
  }
  if (landed.conflicts) {
    return {
      text: landed.files === 0 ? `conflicts with ${base}` : `${files(landed.files)} not on ${base} · conflicts`,
      title: `This branch's commits haven't landed in ${base}, and merging them would conflict. ${BY_CONTENT}`,
      tone: "conflicts",
    };
  }
  return {
    text: `${files(landed.files)} not on ${base}`,
    title: `Merging this branch into ${base} would still change ${files(landed.files)}: its commits haven't landed. ${BY_CONTENT}`,
    tone: "pending",
  };
}
