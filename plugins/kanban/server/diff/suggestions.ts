import { applySuggestionsInCheckout, localEnvironmentPath } from "bb-diff-view/server";
import { SuggestionConflictError, applySuggestionsToText, defaultSuggestionMessage, suggestionFileText, suggestionsByPath } from "bb-diff-view/suggestions";
import type { SuggestionItem, SuggestionsApplied } from "bb-diff-view/types";
import type { Ticket } from "../../shared/board";
import type { PrComments } from "../comments/pr-comments";
import type { KanbanContext } from "../context";
import { github, githubPost, githubRequest, resolveToken } from "../github";

interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

const refPath = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

/** A file's entry at a tree, found one directory at a time so a big repository's tree is never read whole. */
async function treeEntry(repo: string, treeSha: string, path: string, token: string): Promise<GitTreeEntry> {
  const parts = path.split("/");
  let sha = treeSha;
  for (const [index, part] of parts.entries()) {
    const { tree } = await github<{ tree: GitTreeEntry[] }>(`/repos/${repo}/git/trees/${sha}`, token);
    const entry = tree.find((candidate) => candidate.path === part);
    const last = index === parts.length - 1;
    if (entry === undefined || entry.type !== (last ? "blob" : "tree")) throw new Error(`Not applied: ${path} is not on the pull request's branch`);
    // A symlink's blob is its target path, not the file's text.
    if (entry.mode === "120000") throw new Error(`Not applied: ${path} is a symlink`);
    if (last) return entry;
    sha = entry.sha;
  }
  throw new Error(`Not applied: ${path} is not a file`);
}

/**
 * Applies suggestions as one commit on a pull request's head branch through GitHub's git data API: every file is read
 * at the branch's tip and checked before anything is written, then blobs, a tree, the commit, and the branch moved
 * to it (never forced, so a push in between fails rather than being overwritten). Items read at another head than
 * the tip are refused, since their line numbers belong to that head. A null or blank message is GitHub's default.
 */
export async function commitSuggestionsToPr(repo: string, number: number, items: readonly SuggestionItem[], message: string | null, token: string): Promise<SuggestionsApplied> {
  const pull = await github<{ head: { ref: string; repo: { full_name: string } | null } }>(`/repos/${repo}/pulls/${number}`, token);
  if (pull.head.repo === null) throw new Error("The pull request's head repository no longer exists");
  const headRepo = pull.head.repo.full_name;
  const tip = await github<{ object: { sha: string } }>(`/repos/${headRepo}/git/ref/heads/${refPath(pull.head.ref)}`, token);
  if (items.some((item) => item.headSha != null && item.headSha !== tip.object.sha)) {
    throw new SuggestionConflictError(`Not applied: the pull request's branch moved on (to ${tip.object.sha.slice(0, 7)}) since these suggestions were read. Refresh and try again.`);
  }
  const parent = await github<{ tree: { sha: string } }>(`/repos/${headRepo}/git/commits/${tip.object.sha}`, token);
  const files: Array<{ path: string; mode: string; text: string }> = [];
  for (const [path, fileItems] of suggestionsByPath(items)) {
    const entry = await treeEntry(headRepo, parent.tree.sha, path, token);
    const blob = await github<{ content: string; encoding: string }>(`/repos/${headRepo}/git/blobs/${entry.sha}`, token);
    const text = blob.encoding === "base64" ? suggestionFileText(Buffer.from(blob.content, "base64"), path) : blob.content;
    files.push({ path, mode: entry.mode, text: applySuggestionsToText(text, fileItems) });
  }
  const written = message?.trim() ?? "";
  const tree: Array<{ path: string; mode: string; type: "blob"; sha: string }> = [];
  for (const file of files) {
    const blob = await githubPost<{ sha: string }>(`/repos/${headRepo}/git/blobs`, token, { content: file.text, encoding: "utf-8" });
    tree.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha });
  }
  const newTree = await githubPost<{ sha: string }>(`/repos/${headRepo}/git/trees`, token, { base_tree: parent.tree.sha, tree });
  const commit = await githubPost<{ sha: string; html_url?: string }>(`/repos/${headRepo}/git/commits`, token, {
    message: written === "" ? defaultSuggestionMessage(items.length) : written,
    tree: newTree.sha,
    parents: [tip.object.sha],
  });
  await githubRequest("PATCH", `/repos/${headRepo}/git/refs/heads/${refPath(pull.head.ref)}`, token, { sha: commit.sha, force: false });
  return { applied: items.length, commitUrl: commit.html_url ?? `https://github.com/${headRepo}/commit/${commit.sha}` };
}

/** Suggested changes on a card's diff: committed to its PR, or written into its thread's checkout. */
export function createSuggestions(ctx: KanbanContext, { prComments }: { prComments: PrComments }) {
  const { bb, settings, stmts } = ctx;

  async function applySuggestions(ticket: Ticket, items: SuggestionItem[], message: string | null): Promise<SuggestionsApplied> {
    if (ticket.pr !== null) {
      const auth = await resolveToken(settings);
      if (auth === null) throw new Error("No GitHub token configured.");
      const result = await commitSuggestionsToPr(ticket.pr.repo, ticket.pr.number, items, message, auth.token);
      // The commit landed; a thread that fails to resolve is only a stale mark, not a failed apply.
      for (const item of items) {
        if (!item.id.startsWith("review-comment:")) continue;
        await prComments.setResolved(item.id, true).catch((error: unknown) => bb.log.warn(`could not resolve ${item.id} after applying its suggestion: ${String(error)}`));
      }
      const row = stmts.byId.get(ticket.id);
      if (row !== undefined) await prComments.syncPrComments(row, auth.token).catch((error: unknown) => bb.log.warn(`could not refresh comments after applying suggestions: ${String(error)}`));
      return result;
    }
    if (ticket.threadId === null) throw new Error("This card has no pull request or thread to apply suggestions to.");
    const thread = await bb.sdk.threads.get({ threadId: ticket.threadId });
    const dir = thread.environmentId === null ? null : await localEnvironmentPath(bb.sdk, thread.environmentId);
    if (dir === null) throw new Error("Applying suggestions needs a local checkout of the card's thread.");
    return applySuggestionsInCheckout(dir, items);
  }

  return { applySuggestions };
}

export type Suggestions = ReturnType<typeof createSuggestions>;
