// A card's commits for the diff view's commit picker, and the review marks it offers to read on from.
import type { DiffCommits } from "../../shared/diff";
import { UNKNOWN_AUTHOR, type GithubPullCommit, type GithubReview } from "../github";

type DiffCommit = DiffCommits["commits"][number];

/** What a mark reads of a review `/pulls/{n}/reviews` lists. */
export type GithubReviewAtCommit = Pick<GithubReview, "user" | "state" | "commit_id" | "submitted_at">;

/** GitHub lists a pull request's commits oldest first. */
export function commitsFromGithub(list: readonly GithubPullCommit[]): DiffCommit[] {
  return list.map((entry) => ({
    sha: entry.sha,
    summary: entry.commit.message.split("\n")[0] ?? "",
    author: entry.author?.login ?? entry.commit.author?.name ?? UNKNOWN_AUTHOR,
    date: entry.commit.author?.date ?? "",
  }));
}

/** The commit of the list a (possibly abbreviated) sha names; undefined when it is not one of the diff's. */
function inList(commits: readonly DiffCommit[], sha: string | null | undefined): DiffCommit | undefined {
  if (sha === null || sha === undefined || sha.length < 7) return undefined;
  return commits.find((commit) => commit.sha === sha || commit.sha.startsWith(sha));
}

/**
 * "Since last review": the commit the card's latest completed review read up to. "Since your last GitHub review": the
 * commit the signed-in user's latest submitted review on the PR was left on. Each only when that commit is in the diff
 * and is not its head, which would leave nothing to read since.
 */
export function reviewMarks(
  commits: readonly DiffCommit[],
  lastReviewSha: string | null,
  githubReviews: readonly GithubReviewAtCommit[] | null,
  login: string | null,
): DiffCommits["marks"] {
  const before = commits.slice(0, -1);
  const marks: DiffCommits["marks"] = [];
  const reviewed = inList(before, lastReviewSha);
  if (reviewed !== undefined) marks.push({ sha: reviewed.sha, label: "Since last review" });
  if (githubReviews !== null && login !== null) {
    const commit = inList(before, lastGithubReviewSha(githubReviews, login));
    if (commit !== undefined) marks.push({ sha: commit.sha, label: "Since your last GitHub review" });
  }
  return marks;
}

/** The commit the signed-in user's latest submitted review on the PR was left on; null when they have submitted none. */
export function lastGithubReviewSha(githubReviews: readonly GithubReviewAtCommit[], login: string): string | null {
  const mine = githubReviews
    .filter((review) => review.user?.login.toLowerCase() === login.toLowerCase() && review.state !== "PENDING" && review.submitted_at != null)
    .sort((a, b) => Date.parse(a.submitted_at!) - Date.parse(b.submitted_at!))
    .at(-1);
  return mine?.commit_id ?? null;
}
